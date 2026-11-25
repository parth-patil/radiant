//! Document windows, path ownership, File > Open Recent and restoration of the last desktop session.
pub mod map_link;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use uuid::Uuid;

const RECENT_LIMIT: usize = 12;

#[derive(Default, Serialize, Deserialize)]
struct SessionFile {
    recent: Vec<String>,
    windows: Vec<String>,
}

struct Quit {
    id: String,
    queue: Vec<String>,
    discard: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discard {
    doc_id: String,
    path: Option<String>,
}

#[derive(Default)]
struct Desktop {
    owned: HashMap<String, String>,
    reserved: HashMap<String, String>,
    pending: HashMap<String, String>,
    link_requests: HashMap<String, map_link::PendingLink>,
    saved: SessionFile,
    offer: Vec<String>,
    quit: Option<Quit>,
    ready: HashSet<String>,
    exiting: bool,
    focused: Option<String>,
}

#[derive(Default)]
pub struct OpenFiles(Mutex<Desktop>);

pub enum CaptureTarget {
    Open(String),
    Closed,
}

impl OpenFiles {
    pub fn capture_target(&self, path: &str) -> Result<CaptureTarget, String> {
        let mut state = self.lock();
        if state.quit.is_some() || state.exiting || state.reserved.contains_key(path) {
            return Err("The map is busy. Try again when saving or quitting has finished.".into());
        }
        if let Some(owner) = state.owned.get(path) {
            return Ok(CaptureTarget::Open(owner.clone()));
        }
        state.reserved.insert(path.to_string(), crate::capture::WINDOW.into());
        Ok(CaptureTarget::Closed)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Desktop> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn owns(&self, label: &str, path: &str) -> bool {
        self.lock().owned.get(path).is_some_and(|owner| owner == label)
    }

    pub fn reserve(&self, label: &str, path: &str) -> Result<String, String> {
        let path = canonical_path(Path::new(path))?;
        let mut state = self.lock();
        if state
            .owned
            .get(&path)
            .is_some_and(|existing| existing != label)
            || state.reserved.contains_key(&path)
        {
            return Err("This map is already open or is being saved in another window.".into());
        }
        state.reserved.insert(path.clone(), label.to_owned());
        Ok(path)
    }

    pub fn finish_save<R: Runtime>(&self, app: &AppHandle<R>, label: &str, path: &str, succeeded: bool) {
        let mut state = self.lock();
        if state.reserved.get(path).is_some_and(|owner| owner == label) {
            state.reserved.remove(path);
        }
        if succeeded {
            state.owned.retain(|_, owner| owner != label);
            state.owned.insert(path.to_owned(), label.to_owned());
            update_session(app, &mut state);
        }
    }
}

pub fn canonical_path(path: &Path) -> Result<String, String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("radiant"))
    {
        return Err("Choose a Radiant map.".into());
    }
    match path.canonicalize() {
        Ok(path) => path
            .into_os_string()
            .into_string()
            .map_err(|_| "The file path is not valid Unicode.".into()),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && !path.symlink_metadata().is_ok() =>
        {
            let folder = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .ok_or("Choose an absolute file path.")?;
            let result = folder
                .canonicalize()
                .map_err(|e| e.to_string())?
                .join(path.file_name().ok_or("Missing file name.")?);
            result
                .into_os_string()
                .into_string()
                .map_err(|_| "The file path is not valid Unicode.".into())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn session_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("desktop-session.json"))
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let Some(path) = session_path(app) else {
        return;
    };
    let Ok(bytes) = fs::read(path) else { return };
    let Ok(mut file) = serde_json::from_slice::<SessionFile>(&bytes) else {
        return;
    };
    file.recent.retain(|name| Path::new(name).is_file());
    file.recent.truncate(RECENT_LIMIT);
    file.windows.retain(|name| Path::new(name).is_file());
    file.windows.truncate(RECENT_LIMIT);
    let state = app.state::<OpenFiles>();
    let mut state = state.lock();
    state.offer = file.windows;
    state.saved.recent = file.recent;
}

fn persist<R: Runtime>(app: &AppHandle<R>, file: &SessionFile) -> std::io::Result<()> {
    let path = session_path(app).ok_or(std::io::Error::other("App data folder unavailable"))?;
    let parent = path
        .parent()
        .ok_or(std::io::Error::other("Missing app data folder"))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!("desktop-session-{}.tmp", Uuid::new_v4().simple()));
    let ret = fs::write(&tmp, serde_json::to_vec(file)?).and_then(|_| fs::rename(&tmp, path));
    if ret.is_err() {
        let _ = fs::remove_file(tmp);
    }
    ret
}

fn update_session<R: Runtime>(app: &AppHandle<R>, state: &mut Desktop) {
    if !state.exiting {
        let mut windows: Vec<_> = state.owned.keys().cloned().collect();
        windows.sort();
        windows.truncate(RECENT_LIMIT);
        // Opening and closing blank windows must not erase a pending startup offer.
        state.saved.windows = if windows.is_empty() && !state.offer.is_empty() {
            state.offer.clone()
        } else {
            windows
        };
    }
    if let Err(error) = persist(app, &state.saved) {
        log::warn!("desktop session could not be saved: {error}");
    }
}

fn build_window<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<WebviewWindow<R>, String> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Radiant")
        .inner_size(1400.0, 900.0)
        .min_inner_size(720.0, 480.0);
    #[cfg(target_os = "macos")]
    let builder = builder.tabbing_identifier("radiant-documents");
    builder.build().map_err(|error| error.to_string())
}

pub fn open_window<R: Runtime>(app: &AppHandle<R>, path: Option<String>) -> Result<(), String> {
    let state = app.state::<OpenFiles>();
    let path = path
        .map(|path| canonical_path(Path::new(&path)))
        .transpose()?;
    let label = format!("doc-{}", Uuid::new_v4().simple());
    {
        let mut state = state.lock();
        if state.quit.is_some() {
            return Err("Finish quitting before opening another window.".into());
        }
        if let Some(path) = &path {
            if !Path::new(path).is_file() {
                return Err("The map could not be found.".into());
            }
            if let Some(label) = state.owned.get(path) {
                let label = label.clone();
                drop(state);
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                return Ok(());
            }
            if state.reserved.contains_key(path) {
                return Err("This map is being saved in another window.".into());
            }
            state.owned.insert(path.clone(), label.clone());
            state.pending.insert(label.clone(), path.clone());
        }
    }
    match build_window(app, &label) {
        Ok(window) => {
            crate::platform::configure(&window);
            let _ = window.set_focus();
            Ok(())
        }
        Err(error) => {
            let mut state = state.lock();
            state.pending.remove(&label);
            state.owned.retain(|_, owner| owner != &label);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn take_open_files(window: WebviewWindow, state: tauri::State<'_, OpenFiles>) -> Vec<String> {
    let mut state = state.lock();
    state.ready.insert(window.label().to_owned());
    let path = state.pending.remove(window.label()).or_else(|| {
        state.owned.iter().find_map(|(path, owner)| (owner == window.label()).then(|| path.clone()))
    });
    path.into_iter().collect()
}

#[tauri::command]
pub async fn open_document_window(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let copy = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(open_window(&copy, path));
    })
    .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|_| "Window creation stopped.".to_owned())?
}

#[tauri::command]
pub async fn claim_document_path(
    window: WebviewWindow,
    state: tauri::State<'_, OpenFiles>,
    path: String,
) -> Result<String, String> {
    let canonical = state.reserve(window.label(), &path)?;
    state.finish_save(window.app_handle(), window.label(), &canonical, true);
    Ok(canonical)
}

#[tauri::command]
pub fn release_document_path(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, OpenFiles>,
    path: String,
) {
    if let Ok(path) = canonical_path(Path::new(&path)) {
        let mut state = state.lock();
        if state
            .owned
            .get(&path)
            .is_some_and(|label| label == window.label())
        {
            state.owned.remove(&path);
            update_session(&app, &mut state);
        }
    }
}

#[cfg(target_os = "macos")]
fn system_recent(path: &str) {
    use objc2::{
        msg_send,
        runtime::{AnyClass, AnyObject},
    };
    use objc2_foundation::{NSString, NSURL};
    let Some(class) = AnyClass::get(c"NSDocumentController") else {
        return;
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    unsafe {
        let controller: *mut AnyObject = msg_send![class, sharedDocumentController];
        if !controller.is_null() {
            let _: () = msg_send![controller, noteNewRecentDocumentURL: &*url];
        }
    }
}

#[tauri::command]
pub async fn note_document(app: AppHandle, path: String) -> Result<(), String> {
    let path = canonical_path(Path::new(&path))?;
    if !Path::new(&path).is_file() {
        return Ok(());
    }
    {
        let files = app.state::<OpenFiles>();
        let mut state = files.lock();
        state.saved.recent.retain(|recent| recent != &path);
        state.saved.recent.insert(0, path.clone());
        state.saved.recent.truncate(RECENT_LIMIT);
        update_session(&app, &mut state);
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        system_recent(&path);
        crate::menu::update_recent(&handle);
    })
    .map_err(|e| e.to_string())
}

pub fn recent<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let files = app.state::<OpenFiles>();
    files.lock().saved.recent.clone()
}

#[tauri::command]
pub fn offer_desktop_session(
    window: WebviewWindow,
    state: tauri::State<'_, OpenFiles>,
) -> Vec<String> {
    if window.label() != "main" {
        return vec![];
    }
    state.lock().offer.clone()
}

#[tauri::command]
pub async fn finish_desktop_session(app: AppHandle, reopen: bool) -> Result<(), String> {
    let paths = {
        let files = app.state::<OpenFiles>();
        let mut state = files.lock();
        let paths = std::mem::take(&mut state.offer);
        update_session(&app, &mut state);
        paths
    };
    if reopen {
        app.run_on_main_thread({
            let app = app.clone();
            move || {
                for path in paths {
                    if let Err(error) = open_window(&app, Some(path)) {
                        log::warn!("Restoring window: {error}");
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn focused_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| {
            let files = app.state::<OpenFiles>();
            let label = files.lock().focused.clone()?;
            windows.get(&label).cloned()
        })
}

/// Approve one window at a time. A cancelled quit leaves every window open.
pub fn begin_quit<R: Runtime>(app: &AppHandle<R>) {
    let focused = focused_window(app).map(|window| window.label().to_owned());
    let mut windows: Vec<_> = app.webview_windows().into_keys().collect();
    windows.sort_by_key(|label| (Some(label) != focused.as_ref(), label.clone()));
    let files = app.state::<OpenFiles>();
    let mut state = files.lock();
    if state.quit.is_some() || state.exiting || state.reserved.values().any(|owner| owner == crate::capture::WINDOW) {
        return;
    }
    windows.retain(|label| state.ready.contains(label));
    if windows.is_empty() {
        update_session(app, &mut state);
        state.exiting = true;
        drop(state);
        app.exit(0);
        return;
    }
    let first = windows[0].clone();
    let id = Uuid::new_v4().simple().to_string();
    state.quit = Some(Quit {
        id: id.clone(),
        queue: windows,
        discard: Vec::new(),
    });
    drop(state);
    ask_quit(app, &first, &id);
}

fn ask_quit<R: Runtime>(app: &AppHandle<R>, label: &str, id: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if window
            .emit_to(window.label(), "desktop-quit-check", id)
            .is_ok()
        {
            return;
        }
    }
    let files = app.state::<OpenFiles>();
    let mut state = files.lock();
    if state.quit.as_ref().is_some_and(|quit| quit.id == id) {
        state.quit = None;
        drop(state);
        publish_quit_cancelled(app);
    }
}

fn publish_quit_cancelled<R: Runtime>(app: &AppHandle<R>) {
    for label in app.webview_windows().into_keys() {
        let _ = app.emit_to(label, "desktop-quit-cancelled", ());
    }
}

#[tauri::command]
pub fn respond_desktop_quit(
    app: AppHandle,
    window: WebviewWindow,
    request_id: String,
    approved: bool,
    discard: Option<Discard>,
) -> bool {
    let files = app.state::<OpenFiles>();
    let mut state = files.lock();
    let Some(quit) = &mut state.quit else {
        return false;
    };
    if quit.id != request_id || quit.queue.first().map(String::as_str) != Some(window.label()) {
        return false;
    }
    if !approved {
        state.quit = None;
        drop(state);
        publish_quit_cancelled(&app);
        return true;
    }
    if let Some(discard) = discard {
        quit.discard.push(crate::store::recovery_file_id(
            &discard.doc_id,
            discard.path.as_deref(),
        ));
    }
    quit.queue.remove(0);
    if let Some(next) = quit.queue.first().cloned() {
        drop(state);
        ask_quit(&app, &next, &request_id);
    } else {
        let discarded = state.quit.take().unwrap().discard;
        update_session(&app, &mut state);
        state.exiting = true;
        drop(state);
        for key in discarded {
            crate::store::discard_closed_window_recovery(&key);
        }
        app.exit(0);
    }
    true
}

pub fn on_event(app: &AppHandle, event: tauri::RunEvent) {
    match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            for path in urls.into_iter().filter_map(|url| url.to_file_path().ok()) {
                if let (true, Some(path)) = (
                    path.extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("radiant")),
                    path.to_str(),
                ) {
                    if let Err(error) = open_window(app, Some(path.to_owned())) {
                        log::warn!("Opening Finder map: {error}");
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            let document = app.webview_windows().into_values()
                .find(|window| window.label() != crate::capture::WINDOW && window.label() != crate::presenter::WINDOW);
            if let Some(window) = document {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                let _ = open_window(app, None);
            }
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Focused(true),
            ..
        } => {
            if label != crate::capture::WINDOW && label != crate::presenter::WINDOW {
                app.state::<OpenFiles>().lock().focused = Some(label);
            }
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            if label == crate::capture::WINDOW || label == crate::presenter::WINDOW { return; }
            let files = app.state::<OpenFiles>();
            let mut state = files.lock();
            state.owned.retain(|_, owner| owner != &label);
            state.reserved.retain(|_, owner| owner != &label);
            state.pending.remove(&label);
            state.ready.remove(&label);
            state.link_requests.retain(|_, pending| pending.owner != label);
            if state.focused.as_ref() == Some(&label) {
                state.focused = None;
            }
            let cancelled = state.quit.take().is_some();
            if !state.exiting {
                update_session(app, &mut state);
            }
            drop(state);
            if cancelled {
                publish_quit_cancelled(app);
            }
            app.state::<crate::store::StoreState>().forget(&label);
            crate::platform::forget(&label);
        }
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if app.state::<OpenFiles>().lock().exiting {
                return;
            }
            // Tauri cannot intercept its explicit restart code. Regular OS and application exits
            // must go through the same window checks.
            if code == Some(tauri::RESTART_EXIT_CODE) {
                return;
            }
            if !app.webview_windows().is_empty() {
                api.prevent_exit();
                begin_quit(app);
            } else {
                #[cfg(target_os = "macos")]
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        }
        _ => {}
    }
}

// Open common documents with the system viewer. Reveal other file types in Finder.
#[tauri::command]
pub fn open_node_file(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    if url.scheme() != "file" || url.host_str().is_some() {
        return Err("Expected a local file link".into());
    }
    let path = url.to_file_path().map_err(|_| "Invalid local file link")?;
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let document = matches!(
        extension.as_str(),
        "pdf" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "txt" | "md" | "csv" | "radiant"
    );
    let result = if path.is_file() && document {
        app.opener().open_path(path.to_string_lossy(), None::<&str>)
    } else {
        app.opener().reveal_item_in_dir(path)
    };
    result.map_err(|error| error.to_string())
}
