//! Standalone SQLite filesystem-flush fixture. SQLite uses RAM-backed files
//! with separate volatile and durable views. Every selected VFS edge captures
//! the exact bytes that would survive losing the volatile view.
mod journal;

use rusqlite::{Connection, OpenFlags, ffi};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    ffi::{CStr, c_char, c_int, c_void},
    fs,
    path::Path,
    ptr,
};

const APP_ID: i64 = 0x52444e54;
const FORMAT: i64 = 1;
const MAIN: &str = "/map.radiant";
const ROLLBACK: &str = "/map.radiant-journal";

#[derive(Default)]
struct Disk {
    live: HashMap<String, Vec<u8>>,
    durable: HashMap<String, Vec<u8>>,
    aiming: bool,
    cuts: Vec<Cut>,
    temporary: usize,
}

struct Cut {
    boundary: &'static str,
    main: Vec<u8>,
    rollback: Option<Vec<u8>>,
}

impl Disk {
    fn capture(&mut self, boundary: &'static str) {
        if self.aiming {
            self.cuts.push(Cut {
                boundary,
                main: self.durable[MAIN].clone(),
                rollback: self.durable.get(ROLLBACK).cloned(),
            });
        }
    }
}

thread_local! { static DISK: RefCell<Disk> = RefCell::new(Disk::default()); }

#[repr(C)]
struct Handle {
    file: ffi::sqlite3_file,
    name: *mut String,
}

unsafe fn name(file: *mut ffi::sqlite3_file) -> &'static str {
    // The VFS owns this allocation from open until close. SQLite only calls
    // these methods while the same file handle is open.
    unsafe { &*(*file.cast::<Handle>()).name }
}

unsafe extern "C" fn open(
    _: *mut ffi::sqlite3_vfs,
    path: *const c_char,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    output_flags: *mut c_int,
) -> c_int {
    DISK.with_borrow_mut(|disk| {
        let key = if path.is_null() {
            disk.temporary += 1;
            format!("/temporary-{}", disk.temporary)
        } else {
            unsafe { CStr::from_ptr(path) }
                .to_string_lossy()
                .into_owned()
        };
        if !disk.live.contains_key(&key) && flags & ffi::SQLITE_OPEN_CREATE == 0 {
            return ffi::SQLITE_CANTOPEN;
        }
        disk.live.entry(key.clone()).or_default();
        unsafe {
            file.cast::<Handle>().write(Handle {
                file: ffi::sqlite3_file { pMethods: &METHODS },
                name: Box::into_raw(Box::new(key)),
            });
            if !output_flags.is_null() {
                *output_flags = flags;
            }
        }
        ffi::SQLITE_OK
    })
}

unsafe extern "C" fn close(file: *mut ffi::sqlite3_file) -> c_int {
    unsafe {
        drop(Box::from_raw((*file.cast::<Handle>()).name));
        (*file).pMethods = ptr::null();
    }
    ffi::SQLITE_OK
}

unsafe extern "C" fn read(
    file: *mut ffi::sqlite3_file,
    output: *mut c_void,
    amount: c_int,
    offset: i64,
) -> c_int {
    DISK.with_borrow(|disk| {
        let bytes = &disk.live[unsafe { name(file) }];
        let output =
            unsafe { std::slice::from_raw_parts_mut(output.cast::<u8>(), amount as usize) };
        let start = offset as usize;
        let available = output.len().min(bytes.len().saturating_sub(start));
        if available > 0 {
            output[..available].copy_from_slice(&bytes[start..start + available]);
        }
        output[available..].fill(0);
        if available < output.len() {
            ffi::SQLITE_IOERR_SHORT_READ
        } else {
            ffi::SQLITE_OK
        }
    })
}

unsafe extern "C" fn write(
    file: *mut ffi::sqlite3_file,
    input: *const c_void,
    amount: c_int,
    offset: i64,
) -> c_int {
    DISK.with_borrow_mut(|disk| {
        let path = unsafe { name(file) };
        let bytes = disk.live.get_mut(path).unwrap();
        let first = offset as usize;
        let last = first + amount as usize;
        if last > bytes.len() {
            bytes.resize(last, 0);
        }
        bytes[first..last].copy_from_slice(unsafe {
            std::slice::from_raw_parts(input.cast::<u8>(), amount as usize)
        });
        match path {
            MAIN => disk.capture("main write unflushed"),
            ROLLBACK => disk.capture("rollback journal write unflushed"),
            _ => {}
        }
        ffi::SQLITE_OK
    })
}

unsafe extern "C" fn truncate(file: *mut ffi::sqlite3_file, size: i64) -> c_int {
    DISK.with_borrow_mut(|disk| {
        let path = unsafe { name(file) };
        disk.live.get_mut(path).unwrap().resize(size as usize, 0);
        match path {
            MAIN => disk.capture("main truncate unflushed"),
            ROLLBACK => disk.capture("rollback journal truncate unflushed"),
            _ => {}
        }
    });
    ffi::SQLITE_OK
}

unsafe extern "C" fn sync(file: *mut ffi::sqlite3_file, _: c_int) -> c_int {
    DISK.with_borrow_mut(|disk| {
        let path = unsafe { name(file) };
        let boundaries = match path {
            MAIN => Some(("before main file sync", "after main file sync")),
            ROLLBACK => Some((
                "before rollback journal sync",
                "after rollback journal sync",
            )),
            _ => None,
        };
        if let Some((before, _)) = boundaries {
            disk.capture(before);
        }
        // A full successful file flush publishes current bytes. For a newly
        // created journal this includes its directory entry, as the Unix VFS
        // flushes the journal's directory on its first sync.
        disk.durable.insert(path.into(), disk.live[path].clone());
        if let Some((_, after)) = boundaries {
            disk.capture(after);
        }
    });
    ffi::SQLITE_OK
}

unsafe extern "C" fn size(file: *mut ffi::sqlite3_file, length: *mut i64) -> c_int {
    unsafe {
        *length = DISK.with_borrow(|disk| disk.live[name(file)].len() as i64);
    }
    ffi::SQLITE_OK
}

unsafe extern "C" fn lock(_: *mut ffi::sqlite3_file, _: c_int) -> c_int {
    ffi::SQLITE_OK
}

unsafe extern "C" fn reserved(_: *mut ffi::sqlite3_file, value: *mut c_int) -> c_int {
    unsafe {
        *value = 0;
    }
    ffi::SQLITE_OK
}

unsafe extern "C" fn control(_: *mut ffi::sqlite3_file, _: c_int, _: *mut c_void) -> c_int {
    ffi::SQLITE_NOTFOUND
}

unsafe extern "C" fn sector(_: *mut ffi::sqlite3_file) -> c_int {
    4096
}
unsafe extern "C" fn device(_: *mut ffi::sqlite3_file) -> c_int {
    0
}

unsafe extern "C" fn delete(
    _: *mut ffi::sqlite3_vfs,
    path: *const c_char,
    sync_dir: c_int,
) -> c_int {
    let path = unsafe { CStr::from_ptr(path) }.to_string_lossy();
    DISK.with_borrow_mut(|disk| {
        if path == ROLLBACK {
            disk.capture("before rollback journal unlink");
        }
        disk.live.remove(path.as_ref());
        if path == ROLLBACK {
            disk.capture("after unlink before directory sync");
        }
        if sync_dir != 0 {
            disk.durable.remove(path.as_ref());
            if path == ROLLBACK {
                disk.capture("after journal directory sync");
            }
        }
    });
    ffi::SQLITE_OK
}

unsafe extern "C" fn access(
    _: *mut ffi::sqlite3_vfs,
    path: *const c_char,
    _: c_int,
    found: *mut c_int,
) -> c_int {
    let path = unsafe { CStr::from_ptr(path) }.to_string_lossy();
    unsafe {
        *found = i32::from(DISK.with_borrow(|disk| disk.live.contains_key(path.as_ref())));
    }
    ffi::SQLITE_OK
}

unsafe extern "C" fn full_path(
    _: *mut ffi::sqlite3_vfs,
    path: *const c_char,
    size: c_int,
    output: *mut c_char,
) -> c_int {
    let path = unsafe { CStr::from_ptr(path) }.to_bytes_with_nul();
    let prefix = usize::from(path.first() != Some(&b'/'));
    if path.len() + prefix > size as usize {
        return ffi::SQLITE_CANTOPEN;
    }
    unsafe {
        if prefix != 0 {
            output.write(b'/' as c_char);
        }
        ptr::copy_nonoverlapping(path.as_ptr(), output.add(prefix).cast::<u8>(), path.len());
    }
    ffi::SQLITE_OK
}

static METHODS: ffi::sqlite3_io_methods = ffi::sqlite3_io_methods {
    iVersion: 1,
    xClose: Some(close),
    xRead: Some(read),
    xWrite: Some(write),
    xTruncate: Some(truncate),
    xSync: Some(sync),
    xFileSize: Some(size),
    xLock: Some(lock),
    xUnlock: Some(lock),
    xCheckReservedLock: Some(reserved),
    xFileControl: Some(control),
    xSectorSize: Some(sector),
    xDeviceCharacteristics: Some(device),
    xShmMap: None,
    xShmLock: None,
    xShmBarrier: None,
    xShmUnmap: None,
    xFetch: None,
    xUnfetch: None,
};

fn register() -> Box<ffi::sqlite3_vfs> {
    // SQLite supplies the utility callbacks. The experiment owns all file and
    // directory operations and uses a single connection with DELETE journaling.
    let mut vfs: Box<ffi::sqlite3_vfs> = Box::new(unsafe { std::mem::zeroed() });
    let system = unsafe { &*ffi::sqlite3_vfs_find(ptr::null()) };
    vfs.iVersion = 1;
    vfs.szOsFile = std::mem::size_of::<Handle>() as c_int;
    vfs.mxPathname = 512;
    vfs.zName = c"radiant-fsync-fixture".as_ptr();
    vfs.pAppData = system.pAppData;
    vfs.xOpen = Some(open);
    vfs.xDelete = Some(delete);
    vfs.xFullPathname = Some(full_path);
    vfs.xAccess = Some(access);
    vfs.xRandomness = system.xRandomness;
    vfs.xSleep = system.xSleep;
    vfs.xCurrentTime = system.xCurrentTime;
    assert_eq!(
        unsafe { ffi::sqlite3_vfs_register(&mut *vfs, 0) },
        ffi::SQLITE_OK
    );
    vfs
}

fn payload(edit: i64, width: usize) -> String {
    serde_json::json!({ "version": 1, "marker": edit, "text": "Journal fixture content. ".repeat(width) }).to_string()
}

fn digest(text: &str) -> String {
    hex::encode(Sha256::digest(text))
}

fn transact(connection: &mut Connection, revision: i64, width: usize) {
    let value = payload(revision, width);
    let tx = journal::begin(connection).unwrap();
    journal::materialize(
        &tx,
        &value,
        &format!(r#"{{"marker":{revision}}}"#),
        &digest(&value),
    )
    .unwrap();
    tx.commit().unwrap();
}

fn simulate(previous_width: usize, next_width: usize) -> Vec<Cut> {
    DISK.with_borrow_mut(|disk| *disk = Disk::default());
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE;
    let mut connection =
        Connection::open_with_flags_and_vfs(MAIN, flags, "radiant-fsync-fixture").unwrap();
    journal::configure(&connection).unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA synchronous", [], |r| r.get::<_, i32>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        connection
            .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
    connection
        .pragma_update(None, "application_id", APP_ID)
        .unwrap();
    connection
        .pragma_update(None, "user_version", FORMAT)
        .unwrap();
    connection
        .execute_batch("CREATE TABLE doc(id INTEGER PRIMARY KEY,json TEXT NOT NULL);")
        .unwrap();
    connection
        .execute("INSERT INTO doc VALUES(1,?1)", [payload(0, previous_width)])
        .unwrap();
    transact(&mut connection, 1, previous_width);
    DISK.with_borrow_mut(|disk| {
        disk.aiming = true;
        disk.capture("previous transaction acknowledged");
    });
    transact(&mut connection, 2, next_width);
    DISK.with_borrow_mut(|disk| {
        disk.capture("new transaction acknowledged");
        disk.aiming = false;
        std::mem::take(&mut disk.cuts)
    })
}

fn recover(
    folder: &Path,
    trial: usize,
    index: usize,
    cut: Cut,
    previous_width: usize,
    next_width: usize,
) -> i64 {
    let path = folder.join(format!("{trial}-{index}.radiant"));
    let rollback = folder.join(format!("{trial}-{index}.radiant-journal"));
    fs::write(&path, cut.main).unwrap();
    if let Some(bytes) = cut.rollback {
        fs::write(&rollback, bytes).unwrap();
    }
    let db = journal::open_for_recovery(&path, APP_ID, FORMAT).unwrap();
    let integrity = db
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .unwrap();
    assert_eq!(integrity, "ok", "{}", cut.boundary);
    let document: String = db
        .query_row("SELECT json FROM doc", [], |row| row.get(0))
        .unwrap();
    let expected = if cut.boundary == "new transaction acknowledged"
        || cut.boundary == "after journal directory sync"
    {
        2
    } else {
        1
    };
    let original = payload(
        expected,
        if expected == 1 {
            previous_width
        } else {
            next_width
        },
    );
    assert_eq!(
        document, original,
        "{} did not restore the expected acknowledged state",
        cut.boundary
    );
    let entries: Vec<(i64, String, String)> = db.prepare(
        "SELECT sequence, operation_json, result_json_hash FROM operation_log ORDER BY sequence"
    ).unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
      .unwrap().map(Result::unwrap).collect();
    assert_eq!(entries.len(), expected as usize, "{}", cut.boundary);
    assert_eq!(
        entries[0],
        (
            1,
            r#"{"marker":1}"#.into(),
            digest(&payload(1, previous_width))
        )
    );
    assert_eq!(
        entries.last(),
        Some(&(
            expected,
            format!(r#"{{"marker":{expected}}}"#),
            digest(&document)
        ))
    );
    drop(db);
    if rollback.exists() {
        fs::remove_file(rollback).unwrap();
    }
    fs::remove_file(path).unwrap();
    expected
}

fn main() {
    let mut vfs = register();
    let fixture_folder = std::env::args().nth(1).expect("scratch directory");
    let folder = Path::new(&fixture_folder);
    let mut boundaries: BTreeMap<_, [usize; 2]> = BTreeMap::new();
    let widths = [
        (32, 64),
        (72, 144),
        (160, 320),
        (315, 630),
        (768, 1536),
        (1400, 2800),
        (2500, 5000),
        (3900, 7800),
        (2500, 32),
        (3900, 72),
    ];
    for (trial, (previous_width, next_width)) in widths.into_iter().enumerate() {
        for (index, cut) in simulate(previous_width, next_width).into_iter().enumerate() {
            let boundary = cut.boundary;
            let observed = recover(folder, trial, index, cut, previous_width, next_width);
            boundaries.entry(boundary).or_default()[observed as usize - 1] += 1;
        }
    }
    for edge in [
        "before rollback journal sync",
        "after rollback journal sync",
        "before main file sync",
        "after main file sync",
        "after unlink before directory sync",
        "after journal directory sync",
        "new transaction acknowledged",
    ] {
        assert!(
            boundaries.contains_key(edge),
            "missing interruption edge: {edge}"
        );
    }
    let preserved: usize = boundaries.values().map(|counts| counts[0]).sum();
    let durable: usize = boundaries.values().map(|counts| counts[1]).sum();
    for (edge, [before, after]) in boundaries {
        println!("{edge}: previous {before}, new {after}");
    }
    println!(
        "{} simulated cuts across {} transactions: previous {preserved}, new {durable}, all integrity checks and journal digest checks passed.",
        preserved + durable,
        widths.len()
    );
    unsafe {
        ffi::sqlite3_vfs_unregister(&mut *vfs);
    }
}
