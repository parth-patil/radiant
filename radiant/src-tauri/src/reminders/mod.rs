//! Per-map task grants are device-local and only address reminders created by Radiant.
#[cfg(target_os = "macos")]
mod eventkit;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Manager, State, WebviewWindow};

#[derive(Clone, Default)]
pub struct ReminderLinks(Arc<Mutex<()>>);

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub path: String,
    pub document_id: String,
}

#[derive(Deserialize, Serialize)]
struct Link {
    scope: Scope,
    node: String,
    reminder: String,
    synchronized: bool,
    #[serde(default)]
    pending: Option<bool>,
}

#[derive(Deserialize, Serialize)]
pub struct Completion {
    pub node: String,
    pub done: bool,
}

fn validate_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

fn scope(window: &WebviewWindow, mut scope: Scope) -> Result<(Scope, PathBuf), String> {
    if !validate_id(&scope.document_id) {
        return Err("Invalid map identifier.".into());
    }
    scope.path = crate::open_files::canonical_path(Path::new(&scope.path))?;
    if !window
        .state::<crate::open_files::OpenFiles>()
        .owns(window.label(), &scope.path)
    {
        return Err("Open the saved map in this window to sync its tasks.".into());
    }
    let storage = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| "Local storage is unavailable.")?;
    Ok((scope, storage.join("reminder-links.json")))
}

fn load(path: &Path) -> Result<Vec<Link>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Could not read the local Reminders links.".into()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("Could not open the local Reminders links.".into()),
    }
}

fn save(path: &Path, links: &[Link]) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let bytes =
        serde_json::to_vec(links).map_err(|_| "Could not encode the local Reminders links.")?;
    let result = fs::write(&tmp, bytes).and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|_| "Could not save the local Reminders links.".into())
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            objc2::rc::autoreleasepool(|_| job())
        }
        #[cfg(not(target_os = "macos"))]
        {
            job()
        }
    })
    .await
    .map_err(|_| "Reminders did not respond.".to_string())?
}

#[tauri::command]
pub async fn reminders_links(
    window: WebviewWindow,
    state: State<'_, ReminderLinks>,
    map: Scope,
) -> Result<Vec<String>, String> {
    let (map, path) = scope(&window, map)?;
    let state = state.inner().clone();
    blocking(move || {
        let _guard = state
            .0
            .lock()
            .map_err(|_| "The link store is unavailable.")?;
        Ok(load(&path)?
            .into_iter()
            .filter(|link| link.scope == map)
            .map(|link| link.node)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn reminders_connect(
    window: WebviewWindow,
    state: State<'_, ReminderLinks>,
    map: Scope,
    node: String,
    title: String,
    done: bool,
) -> Result<(), String> {
    let (map, path) = scope(&window, map)?;
    if !validate_id(&node) || title.len() > 1024 || title.trim().is_empty() {
        return Err("Select a named task to connect it.".into());
    }
    let state = state.inner().clone();
    blocking(move || {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (map, path, state, done);
            Err("Apple Reminders is available on macOS.".into())
        }
        #[cfg(target_os = "macos")]
        {
            let store = eventkit::Store::open(true)?;
            let _guard = state
                .0
                .lock()
                .map_err(|_| "The link store is unavailable.")?;
            let mut links = load(&path)?;
            if links
                .iter()
                .any(|link| link.scope == map && link.node == node)
            {
                return Ok(());
            }
            // Check ownership again after waiting for the system permission UI.
            if !window
                .state::<crate::open_files::OpenFiles>()
                .owns(window.label(), &map.path)
            {
                return Err("The map closed before its task could be connected.".into());
            }
            let reminder = store.create(title.trim(), done)?;
            links.push(Link {
                scope: map,
                node,
                reminder: reminder.clone(),
                synchronized: done,
                pending: None,
            });
            let saved = save(&path, &links);
            if saved.is_err() {
                store.remove_created(&reminder);
            }
            saved
        }
    })
    .await
}

#[tauri::command]
pub async fn reminders_disconnect(
    window: WebviewWindow,
    state: State<'_, ReminderLinks>,
    map: Scope,
    node: String,
) -> Result<(), String> {
    let (map, path) = scope(&window, map)?;
    let state = state.inner().clone();
    blocking(move || {
        let _guard = state
            .0
            .lock()
            .map_err(|_| "The link store is unavailable.")?;
        let mut links = load(&path)?;
        links.retain(|link| link.scope != map || link.node != node);
        save(&path, &links)
    })
    .await
}

#[tauri::command]
pub async fn reminders_sync(
    window: WebviewWindow,
    state: State<'_, ReminderLinks>,
    map: Scope,
    tasks: Vec<Completion>,
) -> Result<Vec<Result<Completion, String>>, String> {
    let (map, path) = scope(&window, map)?;
    if tasks.len() > 1000 || tasks.iter().any(|task| !validate_id(&task.node)) {
        return Err("Invalid Reminders sync scope.".into());
    }
    let state = state.inner().clone();
    blocking(move || {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (map, path, state);
            Err("Apple Reminders is available on macOS.".into())
        }
        #[cfg(target_os = "macos")]
        {
            let _guard = state
                .0
                .lock()
                .map_err(|_| "The link store is unavailable.")?;
            let mut links = load(&path)?;
            let store = eventkit::Store::open(false)?;
            let mut changed = false;
            let result = tasks
                .into_iter()
                .filter_map(|task| {
                    let link = links
                        .iter_mut()
                        .find(|link| link.scope == map && link.node == task.node)?;
                    Some((|| {
                        let remote = store.completion(&link.reminder)?;
                        if task.done != remote && task.done != link.synchronized {
                            store.set_completion(&link.reminder, task.done)?;
                        } else if task.done != remote {
                            // Keep the old baseline until the editor confirms a durable map edit.
                            changed |= link.pending != Some(remote);
                            link.pending = Some(remote);
                            return Ok(Completion {
                                node: task.node,
                                done: remote,
                            });
                        }
                        changed |= link.synchronized != task.done || link.pending.is_some();
                        link.synchronized = task.done;
                        link.pending = None;
                        Ok(task)
                    })())
                })
                .collect();
            if changed {
                save(&path, &links)?;
            }
            Ok(result)
        }
    })
    .await
}

#[tauri::command]
pub async fn reminders_ack(
    window: WebviewWindow,
    state: State<'_, ReminderLinks>,
    map: Scope,
    tasks: Vec<Completion>,
) -> Result<(), String> {
    let (map, path) = scope(&window, map)?;
    if tasks.len() > 1000 || tasks.iter().any(|task| !validate_id(&task.node)) {
        return Err("Invalid Reminders sync acknowledgement.".into());
    }
    let state = state.inner().clone();
    blocking(move || {
        let _guard = state
            .0
            .lock()
            .map_err(|_| "The link store is unavailable.")?;
        let mut links = load(&path)?;
        let mut changed = false;
        for task in tasks {
            if let Some(link) = links.iter_mut().find(|link| {
                link.scope == map && link.node == task.node && link.pending == Some(task.done)
            }) {
                link.synchronized = task.done;
                link.pending = None;
                changed = true;
            }
        }
        if changed {
            save(&path, &links)?;
        }
        Ok(())
    })
    .await
}
