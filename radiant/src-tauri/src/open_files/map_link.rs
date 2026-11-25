use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::{OpenFiles, canonical_path};

#[derive(Clone, Deserialize, Serialize)]
pub struct LinkOrigin {
    path: String,
    node: Option<String>,
    title: String,
}

#[derive(Clone, Serialize)]
struct Navigation {
    id: String,
    path: String,
    node: Option<String>,
    origin: Option<LinkOrigin>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkResult {
    Opened,
    MissingNode,
    Unavailable,
}

pub(super) struct PendingLink {
    pub owner: String,
    reply: oneshot::Sender<LinkResult>,
}

/// Let the window that owns this path reveal the node in its live document.
#[tauri::command]
pub async fn route_open_map_link(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, OpenFiles>,
    path: String,
    node: Option<String>,
    origin: Option<LinkOrigin>,
) -> Result<&'static str, String> {
    let path = canonical_path(Path::new(&path))?;
    let id = Uuid::new_v4().to_string();
    let (reply, result) = oneshot::channel();
    let (owner, origin) = {
        let mut desktop = state.lock();
        let Some(owner) = desktop.owned.get(&path).cloned() else {
            return Ok("closed");
        };
        if owner == window.label() {
            return Ok("local");
        }
        let origin = origin.filter(|origin| {
            desktop
                .owned
                .get(&origin.path)
                .is_some_and(|label| label == window.label())
        });
        desktop.link_requests.insert(
            id.clone(),
            PendingLink {
                owner: owner.clone(),
                reply,
            },
        );
        (owner, origin)
    };
    let navigation = Navigation {
        id: id.clone(),
        path,
        node,
        origin,
    };
    if let Err(error) = app.emit_to(owner.as_str(), "map-link-navigation", navigation) {
        state.lock().link_requests.remove(&id);
        return Err(error.to_string());
    }
    let response = tokio::time::timeout(Duration::from_secs(5), result).await;
    state.lock().link_requests.remove(&id);
    match response {
        Ok(Ok(LinkResult::Opened)) => {
            if let Some(target) = app.get_webview_window(&owner) {
                let _ = target.unminimize();
                let _ = target.show();
                let _ = target.set_focus();
            }
            Ok("opened")
        }
        Ok(Ok(LinkResult::MissingNode)) => Ok("missingNode"),
        _ => Err("The linked window changed or is still opening. Try the link again.".into()),
    }
}

#[tauri::command]
pub fn finish_map_link(
    window: WebviewWindow,
    state: State<'_, OpenFiles>,
    id: String,
    result: LinkResult,
) {
    let mut desktop = state.lock();
    if desktop
        .link_requests
        .get(&id)
        .is_some_and(|pending| pending.owner == window.label())
        && let Some(pending) = desktop.link_requests.remove(&id)
    {
        let _ = pending.reply.send(result);
    }
}
