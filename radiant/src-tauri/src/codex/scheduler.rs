//! FIFO admission order for all turns in the app-server process.

use serde_json::{Value, json};
use std::collections::VecDeque;
use tokio::sync::oneshot;

struct Entry {
    id: String,
    owner: Option<String>,
    activity: &'static str,
    admission: Option<oneshot::Sender<()>>,
}

pub(super) struct Scheduler {
    limit: usize,
    running: usize,
    revision: u64,
    entries: VecDeque<Entry>,
}

impl Scheduler {
    pub(super) fn new(limit: usize) -> Self {
        Self { limit, running: 0, revision: 0, entries: VecDeque::new() }
    }

    pub(super) fn submit(&mut self, id: String, owner: Option<String>, activity: &'static str) -> oneshot::Receiver<()> {
        let (admission, ready) = oneshot::channel();
        self.entries.push_back(Entry { id, owner, activity, admission: Some(admission) });
        self.promote();
        self.revision += 1;
        ready
    }

    pub(super) fn complete(&mut self, id: &str, stopping: bool) {
        if let Some(index) = self.entries.iter().position(|entry| entry.id == id)
            && let Some(entry) = self.entries.remove(index)
        {
            if entry.admission.is_none() {
                self.running -= 1;
            }
            if !stopping {
                self.promote();
            }
            self.revision += 1;
        }
    }

    fn promote(&mut self) {
        for entry in &mut self.entries {
            if self.running == self.limit { break; }
            if let Some(admission) = entry.admission.take() {
                self.running += 1;
                let _ = admission.send(());
            }
        }
    }

    pub(super) fn snapshot(&self) -> Value {
        let jobs: Vec<_> = self.entries.iter().map(|entry| json!({
            "id": entry.id,
            "owner": entry.owner,
            "activity": entry.activity,
            "state": if entry.admission.is_some() { "queued" } else { "running" }
        })).collect();
        json!({"revision": self.revision, "limit": self.limit, "jobs": jobs})
    }
}
