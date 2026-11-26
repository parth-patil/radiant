//! Local application diagnostics. Records carry only a fixed event category and a timestamp.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_LOG_BYTES: u64 = 64 * 1024;
const GENERATIONS: usize = 3;
const RECENT_LIMIT: usize = 40;
static LOG: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    Started,
    UiError,
    WindowError,
    UnhandledRejection,
    LayoutWorkerFallback,
    WebkitRefreshFallback,
    UpdateFailed,
    ArtworkUnavailable,
    SettingsUnavailable,
    CodexNotInstalled,
    CodexNotLoggedIn,
    CodexRateLimit,
    CodexProtocol,
    CodexTimeout,
    CodexInterrupted,
    CodexError,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Level {
    Info,
    Warning,
    Error,
}

impl Event {
    fn level(self) -> Level {
        match self {
            Self::Started => Level::Info,
            Self::LayoutWorkerFallback
            | Self::WebkitRefreshFallback
            | Self::SettingsUnavailable
            | Self::CodexNotInstalled
            | Self::CodexNotLoggedIn
            | Self::CodexRateLimit => Level::Warning,
            _ => Level::Error,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    time_ms: u64,
    level: Level,
    event: Event,
}

fn log_file(dir: &Path, generation: usize) -> PathBuf {
    dir.join(format!("radiant-{generation}.jsonl"))
}

fn rotate(dir: &Path) -> io::Result<()> {
    let oldest = log_file(dir, GENERATIONS - 1);
    match fs::remove_file(oldest) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    for generation in (0..GENERATIONS - 1).rev() {
        let previous = log_file(dir, generation);
        match fs::rename(previous, log_file(dir, generation + 1)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

fn append(dir: &Path, event: Event) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = log_file(dir, 0);
    let time_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut row = serde_json::to_vec(&Entry {
        event,
        time_ms,
        level: event.level(),
    })?;
    row.push(b'\n');
    if let Ok(metadata) = fs::metadata(&path)
        && metadata.len() + row.len() as u64 > MAX_LOG_BYTES
    {
        rotate(dir)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(&row)
}

fn recent(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut rows = Vec::new();
    for generation in 0..GENERATIONS {
        let file = match fs::File::open(log_file(dir, generation)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(MAX_LOG_BYTES).read_to_end(&mut bytes)?;
        for line in bytes.rsplit(|byte| *byte == b'\n') {
            if let Ok(mut row) = serde_json::from_slice::<Entry>(line) {
                row.level = row.event.level();
                rows.push(row);
                if rows.len() == RECENT_LIMIT {
                    return Ok(rows);
                }
            }
        }
    }
    Ok(rows)
}

#[tauri::command]
pub async fn diagnostic_record(app: AppHandle, event: Event) -> Result<(), &'static str> {
    record(&app, event)
}

pub fn record<R: tauri::Runtime>(app: &AppHandle<R>, event: Event) -> Result<(), &'static str> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|_| "Diagnostics folder unavailable")?
        .join("diagnostics");
    let _lock = LOG.lock().map_err(|_| "Diagnostics log unavailable")?;
    append(&dir, event).map_err(|_| "Could not append diagnostics")
}

#[tauri::command]
pub async fn diagnostic_recent(app: AppHandle) -> Result<Vec<Entry>, &'static str> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|_| "Diagnostics folder unavailable")?
        .join("diagnostics");
    let _lock = LOG.lock().map_err(|_| "Diagnostics log unavailable")?;
    recent(&dir).map_err(|_| "Could not read diagnostics")
}
