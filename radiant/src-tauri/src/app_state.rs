//! App-wide state owned by the host: settings and History snapshots in one SQLite file,
//! \`<app data>/state.sqlite\` (application_id 0x52445354 "RDST", schema version in user_version).
//!
//! The file replaces the WebView's localStorage (settings) and IndexedDB "snapshots" store, which WebKit
//! may evict and which the host can neither read nor back up. A file that is not ours is refused and never
//! deleted or recreated; the front end then keeps using the WebView's data for that session.
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{App, Emitter, Manager, State};

/// SQLite application_id for the state file ("RDST").
pub const APPLICATION_ID: i64 = 0x5244_5354;
/// Current schema version (user_version).
const SCHEMA_VERSION: i64 = 1;
const FILE_NAME: &str = "state.sqlite";
/// Sent to every other window after \`state_set\`, with the same entries.
const CHANGED_EVENT: &str = "state-changed";
const MAX_KEY_BYTES: usize = 512;
const MAX_SETTING_BYTES: usize = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;
const KEY_PREFIXES: [&str; 2] = ["radiant.", "radiant:"];
const OUR_TABLES: [&str; 4] = ["settings", "snapshots", "meta", "snapshots_doc_at"];

const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS settings(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots(
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    name TEXT NOT NULL,
    at INTEGER NOT NULL,
    automatic INTEGER NOT NULL,
    change TEXT,
    json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_doc_at ON snapshots(doc_id, at);
CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);";

type Shared = Arc<Mutex<Connection>>;

/// Managed state: the open connection, or why the state file could not be used.
pub struct AppState(Result<Shared, String>);

/// A History snapshot as the front end sends it (\`at\` is a JavaScript number).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInput {
    pub id: String,
    pub doc_id: String,
    pub name: String,
    pub at: f64,
    pub json: String,
    pub automatic: bool,
    #[serde(default)]
    pub change: Option<Value>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRow {
    pub id: String,
    pub doc_id: String,
    pub name: String,
    pub at: i64,
    pub json: String,
    pub automatic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<Value>,
}

/// A History snapshot without its map JSON: what lists return, so listing never ships whole maps.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub doc_id: String,
    pub name: String,
    pub at: i64,
    pub automatic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<Value>,
}

#[derive(Serialize)]
pub struct Loaded {
    settings: HashMap<String, String>,
    imported: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Imported {
    settings: usize,
    snapshots: usize,
}

pub type Entry = (String, Option<String>);

fn db_error(error: rusqlite::Error) -> String {
    format!("Settings database error: {error}")
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ------------------------------------------------------------------ opening

pub fn setup(app: &mut App) {
    #[cfg(debug_assertions)]
    if std::env::args().any(|a| a == "--state-selftest") {
        let base = std::env::temp_dir().join(format!("radiant-state-selftest-{}", uuid::Uuid::new_v4().simple()));
        let ok = fs::create_dir_all(&base).is_ok() && selftest(&base);
        let _ = fs::remove_dir_all(&base);
        std::process::exit(if ok { 0 } else { 1 });
    }
    let opened = app.path().app_data_dir()
        .map_err(|error| format!("The app data folder is unavailable: {error}"))
        .and_then(|dir| open(&dir.join(FILE_NAME)));
    if let Err(error) = &opened {
        log::warn!("Settings and History will use the WebView's storage for this session: {error}");
    }
    app.manage(AppState(opened.map(|c| Arc::new(Mutex::new(c)))));
}

/// Open (or create) the state file. Never deletes, truncates or recreates an existing file.
pub fn open(path: &Path) -> Result<Connection, String> {
    let shown = path.display();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let mut c = Connection::open(path).map_err(|e| format!("Could not open {shown}: {e}"))?;
    c.busy_timeout(Duration::from_millis(5000)).map_err(db_error)?;
    let refused = |why: &str| format!("{shown} {why}; it was left untouched.");
    // Reading the header fails for a file that is not a SQLite database.
    let app_id: i64 = c.pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(|e| refused(&format!("could not be read ({e})")))?;
    if app_id != 0 && app_id != APPLICATION_ID {
        return Err(refused(&format!("belongs to another application (application_id {app_id:#x})")));
    }
    let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(db_error)?;
    if version > SCHEMA_VERSION {
        return Err(refused(&format!("was written by a newer Radiant (schema {version}, this build reads {SCHEMA_VERSION})")));
    }
    if app_id == 0 && has_foreign_tables(&c).map_err(db_error)? {
        return Err(refused("is a SQLite database that Radiant did not create"));
    }
    c.pragma_update(None, "trusted_schema", false).map_err(db_error)?;
    let mode: String = c.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0)).map_err(db_error)?;
    if !mode.eq_ignore_ascii_case("wal") {
        log::warn!("{shown} uses journal mode {mode} instead of WAL");
    }
    c.pragma_update(None, "synchronous", "FULL").map_err(db_error)?;
    migrate(&mut c)?;
    Ok(c)
}

fn has_foreign_tables(c: &Connection) -> rusqlite::Result<bool> {
    let mut statement = c.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")?;
    let names = statement.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names.iter().any(|name| !OUR_TABLES.contains(&name.as_str())))
}

/// Forward-only migrations, each step in the same transaction as the version bump.
fn migrate(c: &mut Connection) -> Result<(), String> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
    // Re-read inside the write lock: another Radiant process may have migrated in the meantime.
    let app_id: i64 = tx.pragma_query_value(None, "application_id", |r| r.get(0)).map_err(db_error)?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(db_error)?;
    if app_id != 0 && app_id != APPLICATION_ID {
        return Err(format!("The state file belongs to another application (application_id {app_id:#x})."));
    }
    if version > SCHEMA_VERSION {
        return Err(format!("The state file was written by a newer Radiant (schema {version})."));
    }
    if version < 1 {
        tx.execute_batch(SCHEMA_V1).map_err(db_error)?;
    }
    // Future steps: if version < 2 { ... }
    if app_id == 0 {
        tx.pragma_update(None, "application_id", APPLICATION_ID).map_err(db_error)?;
    }
    if version < SCHEMA_VERSION {
        tx.pragma_update(None, "user_version", SCHEMA_VERSION).map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

// ------------------------------------------------------------------ validation

fn check_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return Err(format!("A setting key must be 1 to {MAX_KEY_BYTES} bytes long."));
    }
    if !KEY_PREFIXES.iter().any(|prefix| key.starts_with(prefix)) {
        return Err("A setting key must start with \"radiant.\" or \"radiant:\".".into());
    }
    Ok(())
}

fn check_setting(key: &str, value: &str) -> Result<(), String> {
    check_key(key)?;
    if value.len() > MAX_SETTING_BYTES {
        return Err(format!("The setting {key} is too large ({} bytes; the limit is 4 MB).", value.len()));
    }
    Ok(())
}

fn check_text(what: &str, value: &str, limit: usize) -> Result<(), String> {
    if value.is_empty() || value.len() > limit {
        return Err(format!("The {what} must be 1 to {limit} bytes long."));
    }
    Ok(())
}

fn check_origin(origin: &str) -> Result<(), String> {
    check_text("WebView origin", origin, MAX_KEY_BYTES)
}

/// Returns the row's time as an integer and its change summary as JSON text.
fn check_snapshot(row: &SnapshotInput) -> Result<(i64, Option<String>), String> {
    check_text("snapshot id", &row.id, MAX_KEY_BYTES)?;
    check_text("snapshot document id", &row.doc_id, MAX_KEY_BYTES)?;
    if row.name.len() > MAX_SETTING_BYTES {
        return Err("The snapshot name is too long.".into());
    }
    if !row.at.is_finite() || row.at.abs() > 9_007_199_254_740_991.0 {
        return Err("The snapshot time must be a finite number.".into());
    }
    if row.json.is_empty() || row.json.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!("The snapshot is too large ({} bytes; the limit is 256 MB).", row.json.len()));
    }
    let change = match &row.change {
        None | Some(Value::Null) => None,
        Some(value) => {
            let text = value.to_string();
            if text.len() > MAX_SETTING_BYTES {
                return Err("The snapshot's change summary is too large.".into());
            }
            Some(text)
        }
    };
    Ok((row.at.round() as i64, change))
}

// ------------------------------------------------------------------ operations (shared with the self-test)

fn imported_marker(origin: &str) -> String {
    format!("imported:{origin}")
}

pub fn load(c: &Connection, origin: &str) -> Result<Loaded, String> {
    check_origin(origin)?;
    let mut statement = c.prepare_cached("SELECT key, value FROM settings").map_err(db_error)?;
    let settings = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .and_then(|rows| rows.collect::<rusqlite::Result<HashMap<_, _>>>())
        .map_err(db_error)?;
    let imported = c.query_row("SELECT 1 FROM meta WHERE key = ?1", [imported_marker(origin)], |_| Ok(()))
        .optional().map_err(db_error)?.is_some();
    Ok(Loaded { settings, imported })
}

pub fn set(c: &mut Connection, entries: &[Entry]) -> Result<(), String> {
    for (key, value) in entries {
        match value {
            Some(value) => check_setting(key, value)?,
            None => check_key(key)?,
        }
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
    let now = now_ms();
    for (key, value) in entries {
        match value {
            Some(value) => tx.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES(?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value, now],
            ),
            None => tx.execute("DELETE FROM settings WHERE key = ?1", [key]),
        }
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SnapshotRow> {
    let change: Option<String> = r.get(5)?;
    Ok(SnapshotRow {
        id: r.get(0)?,
        doc_id: r.get(1)?,
        name: r.get(2)?,
        at: r.get(3)?,
        automatic: r.get::<_, i64>(4)? != 0,
        change: change.and_then(|text| serde_json::from_str(&text).ok()),
        json: r.get(6)?,
    })
}

const ROW_COLUMNS: &str = "id, doc_id, name, at, automatic, change, json";
/// Newest first; the same order decides which automatic snapshots are kept.
const NEWEST_FIRST: &str = "ORDER BY at DESC, rowid DESC";
const MAX_KEEP_AUTOMATIC: i64 = 100;

/// Metadata only (no map JSON), newest first.
pub fn snapshot_list(c: &Connection, doc_id: &str) -> Result<Vec<SnapshotInfo>, String> {
    check_text("snapshot document id", doc_id, MAX_KEY_BYTES)?;
    let mut statement = c
        .prepare_cached(&format!("SELECT id, doc_id, name, at, automatic, change FROM snapshots WHERE doc_id = ?1 {NEWEST_FIRST}"))
        .map_err(db_error)?;
    statement.query_map([doc_id], |r| {
        let change: Option<String> = r.get(5)?;
        Ok(SnapshotInfo {
            id: r.get(0)?,
            doc_id: r.get(1)?,
            name: r.get(2)?,
            at: r.get(3)?,
            automatic: r.get::<_, i64>(4)? != 0,
            change: change.and_then(|text| serde_json::from_str(&text).ok()),
        })
    })
    .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
    .map_err(db_error)
}

pub fn snapshot_get(c: &Connection, id: &str) -> Result<Option<SnapshotRow>, String> {
    check_text("snapshot id", id, MAX_KEY_BYTES)?;
    c.query_row(&format!("SELECT {ROW_COLUMNS} FROM snapshots WHERE id = ?1"), [id], read_row)
        .optional().map_err(db_error)
}

fn insert_snapshot(c: &Connection, row: &SnapshotInput, replace: bool) -> Result<usize, String> {
    let (at, change) = check_snapshot(row)?;
    let conflict = if replace {
        "ON CONFLICT(id) DO UPDATE SET doc_id = excluded.doc_id, name = excluded.name, at = excluded.at,
         automatic = excluded.automatic, change = excluded.change, json = excluded.json"
    } else {
        "ON CONFLICT(id) DO NOTHING"
    };
    c.execute(
        &format!("INSERT INTO snapshots(id, doc_id, name, at, automatic, change, json) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7) {conflict}"),
        params![row.id, row.doc_id, row.name, at, row.automatic as i64, change, row.json],
    ).map_err(db_error)
}

/// Insert or replace a snapshot. For an automatic row with keep_automatic set, also delete that document's
/// automatic snapshots beyond the newest keep_automatic, in the same transaction. Manual snapshots are never pruned.
pub fn snapshot_put(c: &mut Connection, row: &SnapshotInput, keep_automatic: Option<i64>) -> Result<(), String> {
    if let Some(keep) = keep_automatic
        && !(1..=MAX_KEEP_AUTOMATIC).contains(&keep)
    {
        return Err(format!("The number of automatic snapshots to keep must be 1 to {MAX_KEEP_AUTOMATIC}."));
    }
    check_snapshot(row)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
    insert_snapshot(&tx, row, true)?;
    if let (true, Some(keep)) = (row.automatic, keep_automatic) {
        tx.execute(
            &format!("DELETE FROM snapshots WHERE doc_id = ?1 AND automatic = 1 AND id NOT IN (
                 SELECT id FROM snapshots WHERE doc_id = ?1 AND automatic = 1 {NEWEST_FIRST} LIMIT ?2)"),
            params![row.doc_id, keep],
        ).map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

pub fn snapshot_delete(c: &Connection, id: &str) -> Result<(), String> {
    check_text("snapshot id", id, MAX_KEY_BYTES)?;
    c.execute("DELETE FROM snapshots WHERE id = ?1", [id]).map(|_| ()).map_err(db_error)
}

/// Insert only what is missing: values already in the state file always win. Safe to repeat.
pub fn import(c: &mut Connection, origin: &str, settings: &HashMap<String, String>, snapshots: &[SnapshotInput]) -> Result<Imported, String> {
    check_origin(origin)?;
    for (key, value) in settings {
        check_setting(key, value)?;
    }
    for row in snapshots {
        check_snapshot(row)?;
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
    let now = now_ms();
    let mut count = Imported { settings: 0, snapshots: 0 };
    for (key, value) in settings {
        count.settings += tx.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES(?1, ?2, ?3) ON CONFLICT(key) DO NOTHING",
            params![key, value, now],
        ).map_err(db_error)?;
    }
    for row in snapshots {
        count.snapshots += insert_snapshot(&tx, row, false)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(count)
}

pub fn import_done(c: &Connection, origin: &str) -> Result<(), String> {
    check_origin(origin)?;
    c.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![imported_marker(origin), now_ms().to_string()],
    ).map(|_| ()).map_err(db_error)
}

// ------------------------------------------------------------------ commands

/// Run one database step off the async runtime thread (as store/mod.rs does).
async fn blocking<T: Send + 'static>(
    state: &AppState,
    f: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let db = state.0.clone()?;
    match tokio::task::spawn_blocking(move || {
        let mut c = db.lock().map_err(|_| "The settings store is unavailable.".to_string())?;
        f(&mut c)
    }).await {
        Ok(result) => result,
        Err(error) => Err(format!("Internal error: {error}")),
    }
}

#[tauri::command]
pub async fn state_load(origin: String, state: State<'_, AppState>) -> Result<Loaded, String> {
    blocking(&state, move |c| load(c, &origin)).await
}

#[tauri::command]
pub async fn state_set(window: tauri::WebviewWindow, entries: Vec<Entry>, state: State<'_, AppState>) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let written = entries.clone();
    blocking(&state, move |c| set(c, &written)).await?;
    let app = window.app_handle();
    for label in app.webview_windows().into_keys().filter(|label| label != window.label()) {
        if let Err(error) = app.emit_to(label.as_str(), CHANGED_EVENT, &entries) {
            log::warn!("Could not send changed settings to {label}: {error}");
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn state_snapshot_list(doc_id: String, state: State<'_, AppState>) -> Result<Vec<SnapshotInfo>, String> {
    blocking(&state, move |c| snapshot_list(c, &doc_id)).await
}

#[tauri::command]
pub async fn state_snapshot_get(id: String, state: State<'_, AppState>) -> Result<Option<SnapshotRow>, String> {
    blocking(&state, move |c| snapshot_get(c, &id)).await
}

#[tauri::command]
pub async fn state_snapshot_put(row: SnapshotInput, keep_automatic: Option<i64>, state: State<'_, AppState>) -> Result<(), String> {
    blocking(&state, move |c| snapshot_put(c, &row, keep_automatic)).await
}

#[tauri::command]
pub async fn state_snapshot_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    blocking(&state, move |c| snapshot_delete(c, &id)).await
}

#[tauri::command]
pub async fn state_import(
    origin: String,
    settings: HashMap<String, String>,
    snapshots: Vec<SnapshotInput>,
    state: State<'_, AppState>,
) -> Result<Imported, String> {
    blocking(&state, move |c| import(c, &origin, &settings, &snapshots)).await
}

#[tauri::command]
pub async fn state_import_done(origin: String, state: State<'_, AppState>) -> Result<(), String> {
    blocking(&state, move |c| import_done(c, &origin)).await
}

// ------------------------------------------------------------------ self-test

/// Debug-only self-test: \`radiant --state-selftest\`. Uses a temporary directory; prints to stderr.
#[cfg(debug_assertions)]
fn selftest(base: &Path) -> bool {
    let mut failed = 0;
    let mut check = |name: &str, ok: bool, detail: String| {
        eprintln!("[state-selftest] {} {name}{}", if ok { "PASS" } else { "FAIL" }, if ok { String::new() } else { format!(": {detail}") });
        if !ok {
            failed += 1;
        }
    };
    let path = base.join(FILE_NAME);
    let origin = "tauri://localhost";
    let row = |id: &str, at: f64, json: &str| SnapshotInput {
        id: id.into(), doc_id: "doc-1".into(), name: format!("Snapshot {id}"), at, json: json.into(),
        automatic: true, change: Some(serde_json::json!({"applied": [{"label": "Edit", "source": "user"}]})),
    };

    // create
    match open(&path) {
        Ok(mut c) => {
            let app_id: i64 = c.pragma_query_value(None, "application_id", |r| r.get(0)).unwrap_or(-1);
            let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap_or(-1);
            let mode: String = c.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap_or_default();
            let sync: i64 = c.pragma_query_value(None, "synchronous", |r| r.get(0)).unwrap_or(-1);
            check("new file has application_id RDST", app_id == APPLICATION_ID, format!("{app_id:#x}"));
            check("new file has schema version 1", version == SCHEMA_VERSION, version.to_string());
            check("journal_mode is WAL", mode.eq_ignore_ascii_case("wal"), mode);
            check("synchronous is FULL", sync == 2, sync.to_string());
            let fresh = load(&c, origin);
            check("empty load", fresh.as_ref().is_ok_and(|l| l.settings.is_empty() && !l.imported), String::new());
            // write
            let written = set(&mut c, &[
                ("radiant.interfaceScale".into(), Some("1.25".into())),
                ("radiant:reviews:v1".into(), Some("{\"history\":[],\"schedules\":[]}".into())),
                ("radiant.gone".into(), Some("x".into())),
            ]).and_then(|_| set(&mut c, &[("radiant.gone".into(), None)]));
            check("set and delete settings", written.is_ok(), format!("{written:?}"));
            let puts = snapshot_put(&mut c, &row("a", 1000.0, "{\"v\":1}"), None)
                .and_then(|_| snapshot_put(&mut c, &row("b", 3000.0, "{\"v\":2}"), None))
                .and_then(|_| snapshot_put(&mut c, &row("c", 2000.0, "{\"v\":3}"), None))
                .and_then(|_| snapshot_put(&mut c, &row("d", 4000.0, "{\"v\":4}"), None))
                .and_then(|_| snapshot_delete(&c, "d"));
            check("put and delete snapshots", puts.is_ok(), format!("{puts:?}"));
        }
        Err(error) => check("create state file", false, error),
    }

    // reopen
    match open(&path) {
        Ok(mut c) => {
            let loaded = load(&c, origin).map(|l| l.settings).unwrap_or_default();
            check("settings survive reopen", loaded.len() == 2 && loaded.get("radiant.interfaceScale").map(String::as_str) == Some("1.25"),
                  format!("{loaded:?}"));
            let list = snapshot_list(&c, "doc-1").unwrap_or_default();
            let order: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
            check("snapshots newest first", order == ["b", "c", "a"], format!("{order:?}"));
            let listed = serde_json::to_value(&list).unwrap_or_default();
            check("list carries no json", listed.as_array().is_some_and(|rows| rows.len() == 3
                && rows.iter().all(|r| r.get("json").is_none() && r.get("name").is_some() && r.get("change").is_some())), listed.to_string());
            let got = snapshot_get(&c, "a").ok().flatten();
            check("snapshot round trip", got.as_ref().is_some_and(|r| r.at == 1000 && r.automatic && r.json == "{\"v\":1}"
                && r.change.as_ref().is_some_and(|v| v["applied"][0]["label"] == "Edit")), format!("{got:?}"));
            check("missing snapshot is None", matches!(snapshot_get(&c, "zzz"), Ok(None)), String::new());

            // import: insert only where missing, marker per origin
            let settings = HashMap::from([
                ("radiant.interfaceScale".to_string(), "1.5".to_string()),
                ("radiant.recent".to_string(), "[\"/a.radiant\"]".to_string()),
            ]);
            let mut older = row("a", 1.0, "{\"old\":true}");
            older.name = "older".into();
            let first = import(&mut c, origin, &settings, &[older.clone(), row("e", 500.0, "{\"v\":5}")]);
            check("import inserts only missing rows", first == Ok(Imported { settings: 1, snapshots: 1 }), format!("{first:?}"));
            let again = import(&mut c, origin, &settings, &[older, row("e", 500.0, "{\"v\":5}")]);
            check("import is safe to repeat", again == Ok(Imported { settings: 0, snapshots: 0 }), format!("{again:?}"));
            let kept = load(&c, origin).map(|l| l.settings).unwrap_or_default();
            check("existing setting wins over import", kept.get("radiant.interfaceScale").map(String::as_str) == Some("1.25"), format!("{kept:?}"));
            check("missing setting imported", kept.get("radiant.recent").is_some(), String::new());
            check("existing snapshot wins over import", snapshot_get(&c, "a").ok().flatten().is_some_and(|r| r.json == "{\"v\":1}"), String::new());
            check("not marked before import_done", load(&c, origin).is_ok_and(|l| !l.imported), String::new());
            check("import_done", import_done(&c, origin).is_ok(), String::new());
            check("marked after import_done", load(&c, origin).is_ok_and(|l| l.imported), String::new());
            check("marker is per origin", load(&c, "http://localhost:1420").is_ok_and(|l| !l.imported), String::new());

            // validation
            let long_key = format!("radiant.{}", "k".repeat(MAX_KEY_BYTES));
            check("key over 512 bytes refused", set(&mut c, &[(long_key, Some("1".into()))]).is_err(), String::new());
            check("key without prefix refused", set(&mut c, &[("theme".into(), Some("1".into()))]).is_err(), String::new());
            check("empty key refused", set(&mut c, &[(String::new(), None)]).is_err(), String::new());
            let big = "x".repeat(MAX_SETTING_BYTES + 1);
            check("setting over 4 MB refused", set(&mut c, &[("radiant.big".into(), Some(big.clone()))]).is_err(), String::new());
            check("4 MB setting accepted", set(&mut c, &[("radiant.big".into(), Some(big[1..].to_string()))]).is_ok(), String::new());
            let partial = set(&mut c, &[("radiant.ok".into(), Some("1".into())), ("bad".into(), Some("1".into()))]);
            check("a batch with one bad key writes nothing", partial.is_err() && load(&c, origin).is_ok_and(|l| !l.settings.contains_key("radiant.ok")), String::new());
            check("NaN time refused", snapshot_put(&mut c, &row("n", f64::NAN, "{}"), None).is_err(), String::new());
            check("infinite time refused", snapshot_put(&mut c, &row("n", f64::INFINITY, "{}"), None).is_err(), String::new());
            let huge = row("h", 1.0, &"x".repeat(MAX_SNAPSHOT_BYTES + 1));
            check("snapshot over 256 MB refused", snapshot_put(&mut c, &huge, None).is_err(), String::new());
            drop(huge);
            check("import with an invalid row writes nothing",
                  import(&mut c, origin, &HashMap::from([("radiant.new".to_string(), "1".to_string())]), &[row("n", f64::NAN, "{}")]).is_err()
                  && load(&c, origin).is_ok_and(|l| !l.settings.contains_key("radiant.new")), String::new());
        }
        Err(error) => check("reopen state file", false, error),
    }

    // put with keepAutomatic: prunes only that document's automatic rows, in the same transaction
    match open(&base.join("prune.sqlite")) {
        Ok(mut c) => {
            let snap = |id: &str, doc: &str, at: f64, automatic: bool| SnapshotInput {
                id: id.into(), doc_id: doc.into(), name: id.into(), at, json: format!("{{\"id\":\"{id}\"}}"), automatic, change: None,
            };
            let mut steps = vec![
                snapshot_put(&mut c, &snap("manual-old", "doc-p", 1.0, false), None),
                snapshot_put(&mut c, &snap("other-auto", "doc-q", 2.0, true), None),
            ];
            for (i, at) in [10.0, 20.0, 30.0, 40.0].into_iter().enumerate() {
                steps.push(snapshot_put(&mut c, &snap(&format!("auto-{i}"), "doc-p", at, true), Some(2)));
            }
            steps.push(snapshot_put(&mut c, &snap("manual-new", "doc-p", 50.0, false), Some(1)));
            check("puts with keepAutomatic succeed", steps.iter().all(Result::is_ok), format!("{steps:?}"));
            let ids: Vec<String> = snapshot_list(&c, "doc-p").unwrap_or_default().into_iter().map(|r| r.id).collect();
            check("keeps the newest automatic rows and every manual one", ids == ["manual-new", "auto-3", "auto-2", "manual-old"], format!("{ids:?}"));
            let other: Vec<String> = snapshot_list(&c, "doc-q").unwrap_or_default().into_iter().map(|r| r.id).collect();
            check("other documents are not pruned", other == ["other-auto"], format!("{other:?}"));
            check("get returns the json", snapshot_get(&c, "auto-3").ok().flatten().is_some_and(|r| r.json == "{\"id\":\"auto-3\"}"), String::new());
            check("keepAutomatic out of range refused", snapshot_put(&mut c, &snap("auto-x", "doc-p", 60.0, true), Some(0)).is_err()
                && snapshot_put(&mut c, &snap("auto-y", "doc-p", 60.0, true), Some(101)).is_err()
                && snapshot_get(&c, "auto-x").is_ok_and(|r| r.is_none()), String::new());
        }
        Err(error) => check("open prune test file", false, error),
    }

    // migration marker: a version-0 file made by an older build is upgraded in place, keeping its rows
    let legacy = base.join("legacy.sqlite");
    let made = Connection::open(&legacy).and_then(|c| {
        c.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
                         INSERT INTO settings VALUES('radiant.kept', 'yes', 1);")
    });
    let migrated = made.map_err(|e| e.to_string()).and_then(|_| open(&legacy));
    check("version-0 file migrates and keeps rows", migrated.as_ref().is_ok_and(|c| {
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).ok() == Some(SCHEMA_VERSION)
            && load(c, origin).is_ok_and(|l| l.settings.get("radiant.kept").map(String::as_str) == Some("yes"))
    }), format!("{:?}", migrated.err()));

    // refusals leave the file exactly as it was
    let refused = |name: &str, prepare: &dyn Fn(&Path) -> Result<(), String>| -> (bool, String) {
        let file = base.join(name);
        if let Err(error) = prepare(&file) {
            return (false, error);
        }
        let before = fs::read(&file).unwrap_or_default();
        let result = open(&file);
        let after = fs::read(&file).unwrap_or_default();
        let detail = match &result { Ok(_) => "opened".to_string(), Err(e) => e.clone() };
        (result.is_err() && file.exists() && before == after && !before.is_empty(), detail)
    };
    let (ok, detail) = refused("foreign.sqlite", &|f| Connection::open(f)
        .and_then(|c| c.pragma_update(None, "application_id", 0x5244_4E54_i64).and_then(|_| c.execute_batch("CREATE TABLE doc(id INTEGER);")))
        .map_err(|e| e.to_string()));
    check("wrong application_id refused, file untouched", ok, detail);
    let (ok, detail) = refused("other.sqlite", &|f| Connection::open(f)
        .and_then(|c| c.execute_batch("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('keep');"))
        .map_err(|e| e.to_string()));
    check("foreign SQLite without application_id refused, file untouched", ok, detail);
    let (ok, detail) = refused("garbage.sqlite", &|f| fs::write(f, vec![0x42; 8192]).map_err(|e| e.to_string()));
    check("non-SQLite file refused, file untouched", ok, detail);
    let (ok, detail) = refused("newer.sqlite", &|f| Connection::open(f)
        .and_then(|c| c.pragma_update(None, "application_id", APPLICATION_ID)
            .and_then(|_| c.pragma_update(None, "user_version", SCHEMA_VERSION + 1))
            .and_then(|_| c.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);")))
        .map_err(|e| e.to_string()));
    check("newer schema refused, file untouched", ok, detail);

    eprintln!("[state-selftest] {}", if failed == 0 { "ALL PASSED".to_string() } else { format!("{failed} FAILED") });
    failed == 0
}
