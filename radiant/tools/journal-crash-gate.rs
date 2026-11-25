mod journal;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const ID: i64 = 0x52444e54;
fn digest(json: &str) -> String {
    hex::encode(Sha256::digest(json))
}
fn say(line: &str) {
    println!("{line}");
    std::io::stdout().flush().unwrap();
}
fn idle() {
    loop {
        thread::park();
    }
}
fn payload(edit: usize) -> String {
    serde_json::json!({"version":1,"marker":edit,"sample":"Native journal crash gate ".repeat(1600)}).to_string()
}
fn worker(path: &Path, warm: usize, cut: usize) {
    let mut conn = Connection::open(path).unwrap();
    journal::configure(&conn).unwrap();
    for edit in 1..=warm + 1 {
        let tx = journal::begin(&mut conn).unwrap();
        if edit == warm + 1 && cut == 0 {
            say("cut");
            idle();
        }
        let doc = payload(edit);
        journal::materialize(&tx, &doc, &format!(r#"{{"edit":{edit}}}"#), &digest(&doc)).unwrap();
        if edit == warm + 1 {
            match cut {
                1 => {
                    say("cut");
                    idle();
                }
                3 => say("cut"),
                _ => {}
            }
        }
        tx.commit().unwrap();
        if edit == warm + 1 && cut == 2 {
            say("cut");
            idle();
        }
        say(&format!("ack {edit}"));
    }
    idle();
}
fn random(seed: &mut u64) -> usize {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    (*seed >> 32) as usize
}
fn main() {
    let args = env::args().collect::<Vec<_>>();
    if args.get(1).is_some_and(|a| a == "worker") {
        worker(
            Path::new(&args[2]),
            args[3].parse().unwrap(),
            args[4].parse().unwrap(),
        );
        return;
    }
    let folder = Path::new(&args[1]);
    let trials = args[2].parse::<usize>().expect("trial count");
    let started = Instant::now();
    let mut seed = 0x20261118u64;
    let mut phases = [0usize; 4];
    let mut acked = 0;
    let mut ahead = 0;
    for trial in 0..trials {
        let path = folder.join(format!("trial-{trial}.radiant"));
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "application_id", ID).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute_batch("CREATE TABLE doc(id INTEGER PRIMARY KEY,json TEXT NOT NULL);")
                .unwrap();
            conn.execute("INSERT INTO doc VALUES(1,?1)", [payload(0)])
                .unwrap();
        }
        let warm = random(&mut seed) % 5;
        let cut = random(&mut seed) % 4;
        phases[cut] += 1;
        let mut child = Command::new(env::current_exe().unwrap())
            .args([
                "worker",
                path.to_str().unwrap(),
                &warm.to_string(),
                &cut.to_string(),
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stream = BufReader::new(child.stdout.take().unwrap());
        let mut last = 0;
        loop {
            let mut line = String::new();
            assert!(
                stream.read_line(&mut line).unwrap() > 0,
                "worker died before cut {trial}"
            );
            if line.trim() == "cut" {
                break;
            }
            if let Some(n) = line.trim().strip_prefix("ack ") {
                last = n.parse::<usize>().unwrap();
            }
        }
        if cut == 3 {
            thread::sleep(Duration::from_micros((random(&mut seed) % 1500) as u64));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let mut trailing = String::new();
        stream.read_to_string(&mut trailing).unwrap();
        for line in trailing.lines() {
            if let Some(value) = line.strip_prefix("ack ") {
                last = value.parse().unwrap();
            }
        }
        let conn = journal::open_for_recovery(&path, ID, 1).unwrap();
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(check, "ok", "trial {trial}");
        let observed: String = conn
            .query_row("SELECT json FROM doc", [], |r| r.get(0))
            .unwrap();
        let marker = serde_json::from_str::<serde_json::Value>(&observed).unwrap()["marker"]
            .as_u64()
            .unwrap() as usize;
        assert!(
            (last..=last + 1).contains(&marker),
            "trial {trial}: observed {marker} after ack {last}"
        );
        if marker > 0 {
            let row: (i64, String) = conn
                .query_row(
                    "SELECT sequence, result_json_hash FROM operation_log ORDER BY sequence DESC LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(row, (i64::try_from(marker).unwrap(), digest(&observed)), "trial {trial}");
        }
        if marker == last {
            acked += 1;
        } else {
            ahead += 1;
        }
        drop(conn);
        fs::remove_file(path).unwrap();
    }
    println!(
        "{trials} forced process cuts: phase counts {phases:?}, exactly acknowledged {acked}, one durable unacknowledged edit {ahead}, zero missing acknowledged edits. Elapsed {:.1}s.",
        started.elapsed().as_secs_f64()
    );
}
