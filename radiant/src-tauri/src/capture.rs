use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    App, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tokio::sync::oneshot;

use crate::open_files::{CaptureTarget, OpenFiles};

pub const WINDOW: &str = "quick-capture";
pub const ACTION: &str = "show-quick-capture";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    path: String,
    text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OwnerResult {
    Saved,
    Recovery,
    Rejected { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ResultOfCapture {
    Saved,
    Recovery,
    Closed {
        receipt: crate::store::capture::Receipt,
    },
}

struct Pending {
    owner: String,
    tx: oneshot::Sender<OwnerResult>,
}

#[derive(Default)]
pub struct CaptureState(Mutex<HashMap<String, Pending>>);

impl CaptureState {
    fn remove(&self, id: &str) {
        if let Ok(mut pending) = self.0.lock() {
            pending.remove(id);
        }
    }
}

pub fn show(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.show()?;
        window.set_focus()?;
    } else {
        WebviewWindowBuilder::new(
            app,
            WINDOW,
            WebviewUrl::App("?quick-capture=1".into()),
        )
        .title("Radiant Quick Capture")
        .center()
        .inner_size(460.0, 340.0)
        .min_inner_size(370.0, 300.0)
        .always_on_top(true)
        .maximizable(false)
        .minimizable(false)
        .build()?;
    }
    Ok(())
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let capture = MenuItem::with_id(app, ACTION, "Quick Capture…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "capture-quit", "Quit Radiant", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture, &quit])?;
    let mut builder = TrayIconBuilder::with_id("radiant-quick-capture")
        .tooltip("Radiant Quick Capture")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            if event.id() == ACTION
                && let Err(error) = show(app)
            {
                log::warn!("Could not show Quick Capture: {error}");
            }
            if event.id() == "capture-quit" {
                crate::open_files::begin_quit(app);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[tauri::command]
pub fn capture_recent(window: WebviewWindow) -> Result<Vec<String>, String> {
    if window.label() != WINDOW {
        return Err("Open Quick Capture from the menu bar.".into());
    }
    Ok(crate::open_files::recent(window.app_handle())
        .into_iter()
        .filter(|name| Path::new(name).is_file())
        .collect())
}

#[tauri::command]
pub async fn capture_submit(
    window: WebviewWindow,
    state: State<'_, CaptureState>,
    desktop: State<'_, OpenFiles>,
    path: String,
    id: String,
    text: String,
) -> Result<ResultOfCapture, String> {
    if window.label() != WINDOW {
        return Err("Open Quick Capture from the menu bar.".into());
    }
    let uuid = uuid::Uuid::parse_str(&id).map_err(|_| "Invalid capture identifier.")?;
    let id = format!("capture-{}", uuid.simple());
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 4000 {
        return Err("Enter between 1 and 4,000 characters.".into());
    }
    let path = crate::open_files::canonical_path(Path::new(&path))?;
    if !Path::new(&path).is_file() {
        return Err("Choose an existing Radiant map.".into());
    }
    let CaptureTarget::Open(owner) = desktop.capture_target(&path)? else {
        let app = window.app_handle().clone();
        let result =
            crate::store::capture::save_reserved(app.clone(), path.clone(), id, text.to_owned())
                .await;
        if result.is_ok() {
            let _ = crate::open_files::note_document(app, path).await;
        }
        return result.map(|receipt| {
            receipt.map_or(ResultOfCapture::Saved, |receipt| ResultOfCapture::Closed {
                receipt,
            })
        });
    };

    let (tx, rx) = oneshot::channel();
    {
        let mut waiting = state
            .0
            .lock()
            .map_err(|_| "Quick Capture is unavailable.")?;
        if waiting.contains_key(&id) {
            return Err("This capture is already being saved.".into());
        }
        waiting.insert(
            id.clone(),
            Pending {
                owner: owner.clone(),
                tx,
            },
        );
    }
    let request = Request {
        id: id.clone(),
        path,
        text: text.to_owned(),
    };
    let result = match window
        .app_handle()
        .emit_to(&owner, "quick-capture-request", request)
    {
        Ok(()) => match tokio::time::timeout(Duration::from_secs(20), rx).await {
            Ok(Ok(OwnerResult::Saved)) => Ok(ResultOfCapture::Saved),
            Ok(Ok(OwnerResult::Recovery)) => Ok(ResultOfCapture::Recovery),
            Ok(Ok(OwnerResult::Rejected { message })) => Err(message),
            _ => Err(
                "The map window did not confirm the save. Retry this capture to check it.".into(),
            ),
        },
        Err(error) => Err(error.to_string()),
    };
    state.remove(&id);
    result
}

#[tauri::command]
pub fn capture_complete(
    window: WebviewWindow,
    state: State<'_, CaptureState>,
    id: String,
    result: OwnerResult,
) {
    if let Ok(mut waiting) = state.0.lock()
        && waiting
            .get(&id)
            .is_some_and(|pending| pending.owner == window.label())
        && let Some(pending) = waiting.remove(&id)
    {
        let _ = pending.tx.send(result);
    }
}

#[tauri::command]
pub async fn capture_history(
    path: String,
    revision: String,
) -> Result<Vec<crate::store::capture::Entry>, String> {
    crate::store::capture::load_history(path, revision).await
}
