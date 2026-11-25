//! Materialized document and reversible operation log share one SQLite commit.
use std::fs::File;
use std::io::Read;
use std::path::Path;

use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior, params};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS operation_log(
    sequence INTEGER PRIMARY KEY,
    operation_json TEXT NOT NULL,
    result_json_hash TEXT NOT NULL
);";

/// Only a known Radiant file may be reopened read/write for SQLite's crash recovery.
pub(super) fn open_for_recovery(
    path: &Path,
    application_id: i64,
    format: i64,
) -> rusqlite::Result<Connection> {
    let mut journal = path.as_os_str().to_os_string();
    journal.push("-journal");
    if Path::new(&journal).is_file() {
        let mut header = [0; 100];
        if File::open(path)
            .and_then(|mut file| file.read_exact(&mut header))
            .is_ok()
            && header[..16] == *b"SQLite format 3\0"
            && i64::from(u32::from_be_bytes(header[68..72].try_into().unwrap())) == application_id
            && i64::from(u32::from_be_bytes(header[60..64].try_into().unwrap())) == format
        {
            return Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE);
        }
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

pub(super) fn configure(connection: &Connection) -> rusqlite::Result<()> {
    connection.pragma_update(None, "trusted_schema", false)?;
    connection.pragma_update(None, "synchronous", "EXTRA")?;
    #[cfg(target_os = "macos")]
    connection.pragma_update(None, "fullfsync", true)?;
    Ok(())
}

pub(super) fn begin(connection: &mut Connection) -> rusqlite::Result<Transaction<'_>> {
    connection.transaction_with_behavior(TransactionBehavior::Immediate)
}

pub(super) fn materialize(
    tx: &Transaction<'_>,
    document: &str,
    operation: &str,
    digest: &str,
) -> rusqlite::Result<()> {
    tx.execute_batch(SCHEMA)?;
    tx.execute("UPDATE doc SET json = ?1 WHERE id = 1", [document])?;
    tx.execute(
        "INSERT INTO operation_log(operation_json, result_json_hash) VALUES(?1, ?2)",
        params![operation, digest],
    )?;
    tx.execute(
        "DELETE FROM operation_log WHERE sequence <= last_insert_rowid() - 1000",
        [],
    )?;
    Ok(())
}
