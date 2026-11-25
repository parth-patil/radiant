//! Presenter console (implementation spec 6.3, PRS-40 to 42). A second, DOM-only window that shows the speaker's
//! view of a talk while the document window stays the audience view. Built like Quick Capture: the window is
//! created here, it loads the `?presenter=1` route and it has its own capability file (capabilities/presenter.json).
//!
//! The two windows never talk directly. The document window that opened the console is its owner. The owner
//! publishes the talk's state when the step changes ("presenter-state", owner to console) and the console sends
//! next, previous and jump ("presenter-command", console to owner). Only step changes cross, never frame data.
use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const WINDOW: &str = "presenter";
const STATE_EVENT: &str = "presenter-state";
const COMMAND_EVENT: &str = "presenter-command";
/// Upper bound for one message; a talk's state with long notes and a long step list stays far below it.
const MAX_MESSAGE: usize = 1 << 20;

/// Label of the document window that owns the console, if one is open.
#[derive(Default)]
pub struct Presenter(Mutex<Option<String>>);

impl Presenter {
    fn owner(&self) -> Option<String> {
        self.0.lock().ok().and_then(|owner| owner.clone())
    }

    fn set_owner(&self, label: Option<String>) {
        if let Ok(mut owner) = self.0.lock() {
            *owner = label;
        }
    }
}

/// The document window that owns the console. Menu commands chosen while the console is focused go there.
pub fn owner_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    let label = app.state::<Presenter>().owner()?;
    app.get_webview_window(&label)
}

fn check_size(value: &Value) -> Result<(), String> {
    match serde_json::to_vec(value) {
        Ok(bytes) if bytes.len() <= MAX_MESSAGE => Ok(()),
        _ => Err("The presenter message is too large.".into()),
    }
}

/// Open the console for the calling document window, or bring it forward and hand it to this window.
#[tauri::command]
pub fn presenter_open(
    window: WebviewWindow,
    presenter: State<'_, Presenter>,
) -> Result<(), String> {
    let label = window.label();
    if label == WINDOW || label == crate::capture::WINDOW {
        return Err("Open the presenter console from a map window.".into());
    }
    let app = window.app_handle();
    let previous = presenter.owner();
    presenter.set_owner(Some(label.to_owned()));
    if let Some(console) = app.get_webview_window(WINDOW) {
        if let Some(previous) = previous.filter(|previous| previous != label) {
            let _ = app.emit_to(
                previous.as_str(),
                COMMAND_EVENT,
                json!({ "kind": "closed" }),
            );
        }
        // The new owner answers with its state, which replaces what the console shows.
        let _ = app.emit_to(label, COMMAND_EVENT, json!({ "kind": "hello" }));
        return console
            .show()
            .and_then(|_| console.unminimize())
            .and_then(|_| console.set_focus())
            .map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("?presenter=1".into()))
        .title("Radiant Presenter")
        .inner_size(980.0, 680.0)
        .min_inner_size(560.0, 420.0)
        // The speaker's notes stay out of screen shares and recordings (PRS-42).
        .content_protected(true)
        // The console's clocks keep running while the audience window has focus.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build()
        .map(|_| ())
        .map_err(|e| {
            presenter.set_owner(previous);
            e.to_string()
        })
}

/// Close the console. Allowed from its owner and from the console itself.
#[tauri::command]
pub fn presenter_close(
    window: WebviewWindow,
    presenter: State<'_, Presenter>,
) -> Result<(), String> {
    let label = window.label();
    if label != WINDOW && presenter.owner().as_deref() != Some(label) {
        return Ok(());
    }
    match window.app_handle().get_webview_window(WINDOW) {
        Some(console) => console.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Owner to console: the state of the talk after a step change. Other windows are refused.
#[tauri::command]
pub fn presenter_publish(
    window: WebviewWindow,
    presenter: State<'_, Presenter>,
    state: Value,
) -> Result<(), String> {
    if presenter.owner().as_deref() != Some(window.label()) {
        return Err("This window does not own the presenter console.".into());
    }
    check_size(&state)?;
    let app = window.app_handle();
    if app.get_webview_window(WINDOW).is_none() {
        return Ok(());
    }
    app.emit_to(WINDOW, STATE_EVENT, state)
        .map_err(|e| e.to_string())
}

/// Console to owner: next, previous, jump and the other commands. Only the console may send them.
#[tauri::command]
pub fn presenter_command(
    window: WebviewWindow,
    presenter: State<'_, Presenter>,
    command: Value,
) -> Result<(), String> {
    if window.label() != WINDOW {
        return Err("Only the presenter console sends presenter commands.".into());
    }
    check_size(&command)?;
    if !command.get("kind").is_some_and(Value::is_string) {
        return Err("Invalid presenter command.".into());
    }
    let Some(owner) = presenter.owner() else {
        return Err("The presentation window is closed.".into());
    };
    window
        .app_handle()
        .emit_to(owner.as_str(), COMMAND_EVENT, command)
        .map_err(|e| e.to_string())
}

/// Window bookkeeping: the console closing tells its owner; the owner closing closes the console.
pub fn window_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let presenter = app.state::<Presenter>();
    if label == WINDOW {
        if let Some(owner) = presenter.owner() {
            let _ = app.emit_to(owner.as_str(), COMMAND_EVENT, json!({ "kind": "closed" }));
        }
        presenter.set_owner(None);
    } else if presenter.owner().as_deref() == Some(label) {
        presenter.set_owner(None);
        if let Some(console) = app.get_webview_window(WINDOW) {
            let _ = console.close();
        }
    }
}
