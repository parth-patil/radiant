//! Window setup and the 120 Hz WebKit setting (decision D-02). Owner: host agent.
//!
//! On macOS the WKWebView caps requestAnimationFrame at 60 fps unless the private WebKit feature
//! `PreferPageRenderingUpdatesNear60FPSEnabled` is switched off through `WKPreferences._features` and
//! `_setEnabled:forFeature:`. Every private selector is checked with `respondsToSelector:` first, so a missing
//! API leaves `highRefreshEnabled` false instead of crashing.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde_json::Value;
use tauri::{App, Manager, Runtime, WebviewWindow};

static HIGH_REFRESH: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(Default::default);

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window("main") {
        configure(&window);
    }
    Ok(())
}

pub fn configure<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(all(target_os = "macos", not(feature = "public-webkit")))]
    {
        let label = window.label().to_owned();
        let app = window.app_handle().clone();
        if window
            .with_webview(move |wv| {
                // SAFETY: with_webview runs this closure on the main thread and inner is the WKWebView.
                let enabled = unsafe { macos::disable_60fps_cap(wv.inner()) };
                if !enabled {
                    report_refresh_fallback(&app);
                }
                HIGH_REFRESH.lock().unwrap().insert(label, enabled);
            })
            .is_err()
        {
            report_refresh_fallback(window.app_handle());
        }
    }
    #[cfg(any(not(target_os = "macos"), feature = "public-webkit"))]
    let _ = window;
}

#[cfg(all(target_os = "macos", not(feature = "public-webkit")))]
fn report_refresh_fallback<R: Runtime>(app: &tauri::AppHandle<R>) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ =
                crate::diagnostics::record(&app, crate::diagnostics::Event::WebkitRefreshFallback);
        });
    });
}

pub fn forget(label: &str) {
    HIGH_REFRESH.lock().unwrap().remove(label);
}

#[tauri::command]
pub async fn platform_info(window: WebviewWindow) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    let display_hz = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                // SAFETY: with_webview runs on the main thread while the native WebView is alive.
                let _ = tx.send(unsafe { macos::display_refresh_rate(webview.inner()) });
            })
            .map_err(|error| error.to_string())?;
        rx.await.ok().flatten()
    };
    #[cfg(not(target_os = "macos"))]
    let display_hz: Option<u32> = None;
    Ok(serde_json::json!({
        "os": std::env::consts::OS,
        "updateChannel": window.app_handle().config().plugins.0.contains_key("updater"),
        "highRefreshEnabled": HIGH_REFRESH.lock().unwrap().get(window.label()).copied().unwrap_or(false),
        "highRefreshBuild": cfg!(all(target_os = "macos", not(feature = "public-webkit"))),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "displayHz": display_hz,
    }))
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::msg_send;
    use objc2::runtime::{AnyObject, Bool, Sel};
    use objc2::sel;

    unsafe fn responds(obj: *const AnyObject, sel: Sel) -> bool {
        let r: Bool = unsafe { msg_send![obj, respondsToSelector: sel] };
        r.as_bool()
    }

    pub unsafe fn display_refresh_rate(webview: *mut std::ffi::c_void) -> Option<u32> {
        unsafe {
            if webview.is_null() {
                return None;
            }
            let window: *mut AnyObject = msg_send![webview as *mut AnyObject, window];
            if window.is_null() {
                return None;
            }
            let screen: *mut AnyObject = msg_send![window, screen];
            let selector = sel!(maximumFramesPerSecond);
            if screen.is_null() || !responds(screen, selector) {
                return None;
            }
            let rate: isize = msg_send![screen, maximumFramesPerSecond];
            u32::try_from(rate).ok().filter(|rate| *rate > 0)
        }
    }

    /// Returns true if the feature was found and is now reported disabled.
    #[cfg(not(feature = "public-webkit"))]
    pub unsafe fn disable_60fps_cap(webview: *mut std::ffi::c_void) -> bool {
        use objc2::{rc::Retained, runtime::AnyClass};
        use objc2_foundation::NSString;
        const FEATURE_KEY: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";
        unsafe {
            if webview.is_null() {
                return false;
            }
            let wk = webview as *mut AnyObject;
            let Some(cls) = AnyClass::get(c"WKPreferences") else {
                return false;
            };
            let cls_obj = cls as *const AnyClass as *const AnyObject;
            let features_sel = sel!(_features);
            let set_sel = sel!(_setEnabled:forFeature:);
            let get_sel = sel!(_isEnabledForFeature:);
            if !responds(cls_obj, features_sel) {
                return false;
            }
            let config: *mut AnyObject = msg_send![wk, configuration];
            if config.is_null() {
                return false;
            }
            let prefs: *mut AnyObject = msg_send![config, preferences];
            if prefs.is_null() || !responds(prefs, set_sel) || !responds(prefs, get_sel) {
                return false;
            }
            let features: *mut AnyObject = msg_send![cls_obj, _features];
            if features.is_null() {
                return false;
            }
            let count: usize = msg_send![features, count];
            for i in 0..count {
                let f: *mut AnyObject = msg_send![features, objectAtIndex: i];
                if f.is_null() || !responds(f, sel!(key)) {
                    continue;
                }
                let key: Option<Retained<NSString>> = msg_send![f, key];
                if key.is_some_and(|k| k.to_string() == FEATURE_KEY) {
                    let _: () = msg_send![prefs, _setEnabled: false, forFeature: f];
                    let after: Bool = msg_send![prefs, _isEnabledForFeature: f];
                    return !after.as_bool();
                }
            }
            false
        }
    }
}
