//! Bounded diagnostic records. Wire metadata is recorded by default; replay text is opt-in.
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const KEEP: usize = 24;
const MAX_BYTES: usize = 4 * 1024 * 1024;

pub struct Trace {
    output: File,
    size: usize,
    elapsed: Instant,
    previous_event: u128,
    include_text: bool,
}

impl Trace {
    pub fn open(dir: &Path, id: &str, _rotation: MutexGuard<'_, ()>) -> Option<Self> {
        fs::create_dir_all(dir).ok()?;
        let mut old: Vec<_> = fs::read_dir(dir)
            .ok()?
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name();
                let id = name.to_str()?.strip_suffix(".jsonl")?;
                uuid::Uuid::parse_str(id).ok()?;
                Some((entry.metadata().ok()?.modified().ok()?, entry.path()))
            })
            .collect();
        old.sort_unstable();
        let remove = old.len().saturating_sub(KEEP - 1);
        for (_, path) in old.into_iter().take(remove) {
            let _ = fs::remove_file(path);
        }
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        Some(Self {
            output: options.open(dir.join(format!("{id}.jsonl"))).ok()?,
            size: 0,
            elapsed: Instant::now(),
            previous_event: 0,
            include_text: std::env::var("RADIANT_AI_RECORD_REPLAY").as_deref() == Ok("1"),
        })
    }

    pub fn write(&mut self, mut record: Value) {
        record["timeMs"] = json!(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        );
        let mut line = record.to_string();
        line.push('\n');
        if self.size.saturating_add(line.len()) <= MAX_BYTES {
            self.size += line.len();
            let _ = self.output.write_all(line.as_bytes());
        }
    }

    pub fn event(&mut self, event: &Value) {
        let kind = event["kind"].as_str().unwrap_or("");
        let mut safe = match kind {
            "started" => {
                json!({"kind":kind,"route":event["route"],"model":event["model"],"templateVersion":event["templateVersion"]})
            }
            "delta" if self.include_text => json!({"kind":kind,"text":event["text"]}),
            "delta" => {
                self.write(json!({"kind":"output", "bytes":event["text"].as_str().map(str::len)}));
                return;
            }
            "image" => {
                let mut image = json!({"kind":kind,"assetHash":event["assetHash"]});
                if !event["seed"].is_null() {
                    image["seed"] = event["seed"].clone();
                }
                if self.include_text && !event["revisedPrompt"].is_null() {
                    image["revisedPrompt"] = event["revisedPrompt"].clone();
                }
                image
            }
            "error" => {
                json!({"kind":kind,"code":event["code"],"message":"Recorded Codex job failed"})
            }
            "warning" => json!({"kind":kind,"message":event["message"]}),
            "mapRoundDone" | "done" | "cancelled" => json!({"kind":kind}),
            _ => return,
        };
        if event["usage"].is_object() {
            safe["usage"] = event["usage"].clone();
        }
        let now = self.elapsed.elapsed().as_millis();
        let delay = now.saturating_sub(self.previous_event) as u64;
        self.previous_event = now;
        self.write(json!({"delay":delay,"event":safe}));
    }
}

pub fn wire(trace: &Mutex<Option<Trace>>, direction: &str, method: &str) {
    if let Ok(mut entry) = trace.lock()
        && let Some(trace) = entry.as_mut()
    {
        trace.write(json!({"kind":"wire","direction":direction,"method":method}));
    }
}

/// Keep evidence of interrupted empty items without recording any returned item payload.
pub fn terminal_shape(trace: &Mutex<Option<Trace>>, status: Option<super::protocol_types::TurnStatus>, item_count: Option<usize>) {
    if let Ok(mut entry) = trace.lock()
        && let Some(trace) = entry.as_mut()
    {
        use super::protocol_types::TurnStatus;
        let status = match status {
            Some(TurnStatus::Completed) => "completed",
            Some(TurnStatus::Interrupted) => "interrupted",
            Some(TurnStatus::Failed) => "failed",
            _ => "unknown",
        };
        trace.write(json!({"kind":"turnCompleted", "status":status, "itemCount":item_count}));
    }
}
