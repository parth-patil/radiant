//! Scratch-build control plane. Opening does not depend on a hidden WebView's timers.
use serde::Deserialize;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
struct Request {
    run: String,
    cycle: usize,
    path: PathBuf,
    #[serde(default)]
    visible: bool,
}

pub fn start(app: AppHandle) {
    let Some(profile) = std::env::var_os("RADIANT_GATE_PROFILE").map(PathBuf::from) else {
        return;
    };
    let Ok(run) = std::env::var("RADIANT_GATE_TRIAL") else {
        return;
    };
    std::thread::spawn(move || {
        let request = profile.join("memory-open.json");
        let status = profile.join("memory-open-status.json");
        let mut last = None;
        loop {
            std::thread::sleep(Duration::from_millis(50));
            let Ok(bytes) = fs::read(&request) else {
                continue;
            };
            let Ok(next) = serde_json::from_slice::<Request>(&bytes) else {
                continue;
            };
            if next.run != run
                || last == Some(next.cycle)
                || next.path.parent() != Some(profile.as_path())
            {
                continue;
            }
            last = Some(next.cycle);
            let reply = status.clone();
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if next.visible {
                    let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
                let started = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|value| value.as_secs_f64() * 1000.0);
                let result = next
                    .path
                    .to_str()
                    .ok_or_else(|| "Fixture path was not UTF-8".to_owned())
                    .and_then(|path| {
                        crate::open_files::open_window(&handle, Some(path.to_owned()))
                    });
                if result.is_ok() && next.visible {
                    // The isolated host has only its launcher and one benchmark document.
                    for (label, window) in handle.webview_windows() {
                        if label.starts_with("doc-") {
                            let _ = window.show();
                        }
                    }
                }
                let body = serde_json::json!({
                    "cycle": next.cycle, "error": result.err(), "startedMs": started,
                });
                let tmp = reply.with_extension("tmp");
                if fs::write(&tmp, body.to_string()).is_ok() {
                    let _ = fs::rename(&tmp, reply);
                }
            });
        }
    });
}

#[tauri::command]
pub async fn snapshot(window: tauri::WebviewWindow) -> Result<f64, String> {
    use block2::RcBlock;
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_foundation::{NSData, NSError};
    use std::cell::RefCell;

    let profile =
        PathBuf::from(std::env::var_os("RADIANT_GATE_PROFILE").ok_or("Missing scratch profile")?);
    let path = profile.join(format!("{}.tiff", window.label()));
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.with_webview(move |webview| {
        let tx = RefCell::new(Some(tx));
        let done = RcBlock::new(move |image: *mut AnyObject, error: *mut NSError| {
            let result = (|| {
                let end = SystemTime::now().duration_since(UNIX_EPOCH)
                    .map_err(|error| error.to_string())?.as_secs_f64() * 1000.0;
                if !error.is_null() || image.is_null() {
                    return Err("WKWebView could not capture the document frame".to_owned());
                }
                let data: *const NSData = unsafe { msg_send![image, TIFFRepresentation] };
                let data = unsafe { data.as_ref() }.ok_or("Missing snapshot bitmap")?;
                fs::write(&path, data.to_vec()).map_err(|error| error.to_string())?;
                Ok(end)
            })();
            if let Some(tx) = tx.borrow_mut().take() {
                let _ = tx.send(result);
            }
        });
        unsafe {
            let view = webview.inner().cast::<AnyObject>();
            let no_configuration: *const AnyObject = std::ptr::null();
            let _: () = msg_send![view, takeSnapshotWithConfiguration: no_configuration, completionHandler: &*done];
        }
    }).map_err(|error| error.to_string())?;
    rx.await.map_err(|error| error.to_string())?
}
