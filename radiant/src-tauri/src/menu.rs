//! Native application menu. Custom items emit a "menu" event whose payload is the item id (see MenuId in
//! src/lib/host/types.ts). Cut, copy, paste and select-all are predefined so text fields keep working.
//! Owner: coordinator.
use std::collections::HashMap;
use tauri::menu::{
    Menu, MenuItem, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Manager, Runtime, WebviewWindow};

fn item<R: Runtime>(
    app: &App<R>,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, label);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

#[derive(Clone, Copy)]
struct Role {
    action: &'static str,
    shortcut: &'static str,
}

struct NativeRoles(HashMap<String, Role>);

#[derive(serde::Serialize)]
pub struct PaletteItem {
    id: String,
    label: String,
    group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
    shortcut: String,
    native: bool,
}

pub fn setup<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let about = PredefinedMenuItem::about(app, Some("About Radiant"), None)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    app.manage(NativeRoles(
        [
            (&about, "native:about", ""),
            (&hide, "native:hide", "Mod+H"),
            (&hide_others, "native:hide-others", "Mod+Alt+H"),
            (&cut, "native:cut", "Mod+X"),
            (&copy, "native:copy", "Mod+C"),
            (&paste, "native:paste", "Mod+V"),
            (&select_all, "native:select-all", "Mod+A"),
            (&minimize, "native:minimize", "Mod+M"),
            (&fullscreen, "native:fullscreen", "Ctrl+Meta+F"),
        ]
        .into_iter()
        .map(|(item, action, shortcut)| (item.id().0.to_string(), Role { action, shortcut }))
        .collect(),
    ));

    let app_menu = SubmenuBuilder::new(app, "Radiant")
        .item(&about)
        .separator()
        .item(&hide)
        .item(&hide_others)
        .separator()
        .item(&item(app, "quit", "Quit Radiant", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let recent = SubmenuBuilder::with_id(app, "open-recent", "Open Recent").build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "browse-maps", "Browse Map Folder…", None)?)
        .item(&item(app, "new", "New Map", Some("CmdOrCtrl+N"))?)
        .item(&item(app, "open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&recent)
        .item(&item(
            app,
            "close-document",
            "Close Window",
            Some("CmdOrCtrl+W"),
        )?)
        .separator()
        .item(&item(app, "save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item(
            app,
            "save-as",
            "Save As…",
            Some("CmdOrCtrl+Shift+S"),
        )?)
        .separator()
        .item(&item(
            app,
            "import-markdown",
            "Import Map or Outline…",
            None,
        )?)
        .item(&item(app, "import-folder", "Import Portable Map Folder…", None)?)
        .item(&item(app, "export", "Export Map…", None)?)
        .item(&item(app, "copy-markdown", "Copy Map as Markdown", None)?)
        .separator()
        .item(&item(app, "print", "Print…", Some("CmdOrCtrl+P"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item(app, "find-replace", "Find and Replace…", Some("CmdOrCtrl+Alt+F"))?)
        .item(&item(app, "find", "Find in Map…", Some("CmdOrCtrl+F"))?)
        .item(&item(
            app,
            "edit-link",
            "Edit Node Link…",
            Some("CmdOrCtrl+K"),
        )?)
        .item(&item(
            app,
            "edit-note",
            "Edit Node Note…",
            Some("CmdOrCtrl+Shift+K"),
        )?)
        .item(&item(
            app,
            "commands",
            "Command Palette…",
            Some("CmdOrCtrl+Shift+P"),
        )?)
        .separator()
        .item(&item(app, "undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item(app, "redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&select_all)
        .build()?;
    let map = SubmenuBuilder::new(app, "Map")
        .item(&item(app, "arrange", "Arrange", Some("CmdOrCtrl+Alt+L"))?)
        .item(&item(app, "balance", "Balance Main Node", Some("CmdOrCtrl+Alt+B"))?)
        .item(&item(app, "new-variation", "New Organic Variation", None)?)
        .item(&item(app, "node-menu", "Node Actions and Artwork…", None)?)
        .item(&item(
            app,
            "generate",
            "Generate with AI…",
            Some("CmdOrCtrl+G"),
        )?)
        .item(&item(
            app,
            "expand",
            "Expand Selected Node with AI",
            Some("CmdOrCtrl+Shift+E"),
        )?)
        .separator()
        .item(&item(
            app,
            "detach",
            "Detach Branch as Main Node",
            Some("CmdOrCtrl+Shift+D"),
        )?)
        .item(&item(
            app,
            "fold-siblings",
            "Fold with Siblings",
            Some(if cfg!(target_os = "macos") {
                "CmdOrCtrl+Alt+."
            } else {
                "CmdOrCtrl+Shift+."
            }),
        )?)
        .item(&item(
            app,
            "unfold-one",
            "Unfold One Level",
            Some("Ctrl+Alt+."),
        )?)
        .item(&item(
            app,
            "unfold-all",
            "Unfold All Descendants",
            Some("Ctrl+Alt+Shift+."),
        )?)
        .item(&item(
            app,
            "fold-level",
            "Fold to Level…",
            Some(if cfg!(target_os = "macos") {
                "CmdOrCtrl+Alt+Shift+."
            } else {
                "CmdOrCtrl+Alt+Shift+F"
            }),
        )?)
        .item(&item(
            app,
            "collapse-toggle",
            "Fold or Unfold",
            Some("CmdOrCtrl+."),
        )?)
        .item(&item(
            app,
            "connect",
            "Connect to Node…",
            Some("CmdOrCtrl+L"),
        )?)
        .item(&item(
            app,
            "task",
            "Toggle Task",
            Some("CmdOrCtrl+Shift+T"),
        )?)
        .item(&item(app, "add-child", "Add Child", None)?)
        .item(&item(app, "add-parent", "Insert Parent", None)?)
        .item(&item(app, "sort-children", "Sort Children Alphabetically", None)?)
        .item(&item(app, "sort-tasks", "Sort Children by Task State", None)?)
        .item(&item(
            app,
            "duplicate",
            "Duplicate Branch",
            Some("CmdOrCtrl+D"),
        )?)
        .item(&item(app, "create-alias", "Create Alias", None)?)
        .item(&item(app, "tidy-layout", "Tidy Selected Branches…", None)?)
        .item(&item(app, "tidy-map", "Tidy Whole Map…", None)?)
        .item(&item(app, "reset-offset", "Reset Selected Node Positions", Some("Control+Super+R"))?)
        .item(&item(app, "reset-branch-offsets", "Reset Positions in Selected Branches", None)?)
        .item(&item(app, "reset-map-offsets", "Reset Positions in Whole Map", None)?)
        .item(&item(app, "pin-position", "Toggle Absolute Position Pin", None)?)
        .item(&item(app, "next-layout", "Change Layout", None)?)
        .item(&item(app, "next-theme", "Next Theme", Some("CmdOrCtrl+T"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "map-view", "Map Only", Some("CmdOrCtrl+1"))?)
        .item(&item(app, "outline-view", "Map with Outline", Some("CmdOrCtrl+2"))?)
        .item(&item(app, "zoom-actual", "Actual Size", Some("CmdOrCtrl+0"))?)
        .item(&item(app, "zoom-in", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item(app, "zoom-out", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .item(&item(app, "zoom-fit", "Zoom to Fit", Some("CmdOrCtrl+NumpadMultiply"))?)
        .item(&item(app, "centre-selection", "Centre Selection", Some("CmdOrCtrl+Shift+8"))?)
        .item(&item(app, "select-level", "Select Nodes at the Same Level", None)?)
        .item(&item(
            app,
            "zoom-selection",
            "Zoom to Selection",
            Some("CmdOrCtrl+Shift+1"),
        )?)
        .separator()
        .item(&item(
            app,
            "toggle-outline",
            "Show or Hide Outline",
            Some("CmdOrCtrl+Alt+O"),
        )?)
        .item(&item(
            app,
            "toggle-inspector",
            "Show or Hide Inspector",
            Some("CmdOrCtrl+Alt+I"),
        )?)
        .item(&item(app, "toggle-minimap", "Show or Hide Minimap", None)?)
        .item(&item(app, "filter-map", "Filter Map…", None)?)
        .item(&item(
            app,
            "focus-branch",
            "Focus on Branch",
            Some("CmdOrCtrl+Shift+F"),
        )?)
        .item(&item(app, "present-branches", "Present", Some("CmdOrCtrl+Alt+P"))?)
        .item(&item(app, "present-from-here", "Present from Here", None)?)
        .item(&item(app, "presentations", "Presentations…", None)?)
        .item(&item(
            app,
            "toggle-stats",
            "Show or Hide Performance Stats",
            None,
        )?)
        .build()?;
    let window = SubmenuBuilder::with_id(app, tauri::menu::WINDOW_SUBMENU_ID, "Window")
        .item(&minimize)
        .item(&fullscreen)
        .build()?;
    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &map, &view, &window])?;
    app.set_menu(menu)?;
    update_recent(app.handle());
    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        let mut window = crate::open_files::focused_window(app);
        // The presenter console has no menu commands of its own: they act on the map it presents.
        if window.as_ref().is_some_and(|window| window.label() == crate::presenter::WINDOW) {
            window = crate::presenter::owner_window(app);
        }
        match dispatch_shell(app, window.as_ref(), id) {
            Ok(true) => {}
            Ok(false) => {
                if let Some(window) = window {
                    let _ = window.emit_to(window.label(), "menu", id);
                }
            }
            Err(error) => log::warn!("{error}"),
        }
    });
    Ok(())
}

fn shell_action(id: &str) -> bool {
    matches!(id, "quit" | "new" | "open" | "close-document") || id.starts_with("recent:")
}

fn dispatch_shell<R: Runtime>(
    app: &AppHandle<R>,
    window: Option<&WebviewWindow<R>>,
    id: &str,
) -> Result<bool, String> {
    match id {
        "quit" => crate::open_files::begin_quit(app),
        "new" => crate::open_files::open_window(app, None)?,
        "open" => {
            // A document window shows the picker itself, so that it can also take a portable bundle
            // (name.radiant.zip), which is imported rather than opened as a document.
            if let Some(window) = window {
                window
                    .emit_to(window.label(), "menu", "open")
                    .map_err(|error| error.to_string())?;
                return Ok(true);
            }
            use tauri_plugin_dialog::DialogExt;
            let app = app.clone();
            let picker = app.dialog().file().add_filter("Radiant map", &["radiant"]);
            picker.pick_file(move |path| {
                let Some(path) = path.and_then(|path| path.into_path().ok()) else {
                    return;
                };
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Err(error) = crate::open_files::open_window(
                        &handle,
                        Some(path.to_string_lossy().into_owned()),
                    ) {
                        log::warn!("{error}");
                    }
                });
            });
        }
        "close-document" => {
            let window = window.ok_or("No document window to close.")?;
            window.close().map_err(|e| e.to_string())?;
        }
        _ if id.starts_with("recent:") => {
            let path = crate::open_files::recent(app)
                .into_iter()
                .find(|path| recent_id(path) == id)
                .ok_or("This recent document is no longer listed.")?;
            crate::open_files::open_window(app, Some(path))?;
        }
        _ => return Ok(false),
    }
    Ok(true)
}

#[tauri::command]
pub async fn palette_items(app: AppHandle) -> Result<Vec<PaletteItem>, String> {
    fn collect(
        items: Vec<MenuItemKind<tauri::Wry>>,
        roles: &NativeRoles,
        recent: &HashMap<String, String>,
        group: &str,
        result: &mut Vec<PaletteItem>,
    ) -> tauri::Result<()> {
        for item in items {
            match item {
                MenuItemKind::Submenu(menu) => {
                    let title = menu.text()?;
                    let section = if group.is_empty() {
                        title
                    } else {
                        format!("{group} › {title}")
                    };
                    collect(menu.items()?, roles, recent, &section, result)?;
                }
                MenuItemKind::MenuItem(item) if item.is_enabled()? => {
                    let id = item.id().0.to_string();
                    let path_label = id.starts_with("recent:");
                    let shortcut = match id.as_str() {
                        "quit" => "Mod+Q",
                        "close-document" => "Mod+W",
                        _ => "",
                    };
                    result.push(PaletteItem {
                        label: if path_label {
                            format!("Open Recent: {}", item.text()?)
                        } else {
                            item.text()?
                        },
                        native: shell_action(&id),
                        hint: recent.get(&id).cloned(),
                        id,
                        group: group.to_owned(),
                        shortcut: shortcut.to_owned(),
                    });
                }
                MenuItemKind::Predefined(item) => {
                    if let Some(role) = roles.0.get(item.id().as_ref()) {
                        result.push(PaletteItem {
                            id: role.action.into(),
                            label: item.text()?.replace('&', ""),
                            group: group.to_owned(),
                            shortcut: role.shortcut.into(),
                            hint: None,
                            native: true,
                        });
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    let mut result = Vec::new();
    let menu = app.menu().ok_or("Application menu unavailable")?;
    let roles = app.state::<NativeRoles>();
    let recent = crate::open_files::recent(&app)
        .into_iter()
        .map(|path| (recent_id(&path), path))
        .collect();
    collect(
        menu.items().map_err(|e| e.to_string())?,
        &roles,
        &recent,
        "",
        &mut result,
    )
    .map_err(|e| e.to_string())?;
    let mut windows: Vec<_> = app
        .webview_windows()
        .into_values()
        .filter(|window| window.label() != crate::capture::WINDOW && window.label() != crate::presenter::WINDOW)
        .collect();
    windows.sort_by_cached_key(|window| window.label().to_owned());
    for window in windows {
        result.push(PaletteItem {
            id: format!("window:{}", window.label()),
            label: format!("Switch to {}", window.title().map_err(|e| e.to_string())?),
            group: "Window".into(),
            shortcut: String::new(),
            hint: None,
            native: true,
        });
    }
    Ok(result)
}

#[tauri::command]
pub async fn run_palette_item(window: WebviewWindow, id: String) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let app = target.app_handle();
            let result = (|| {
                if dispatch_shell(app, Some(&target), &id)? {
                    return Ok(());
                }
                if let Some(label) = id.strip_prefix("window:") {
                    if label == crate::capture::WINDOW || label == crate::presenter::WINDOW {
                        return Err("This window is unavailable.".to_owned());
                    }
                    let selected = app
                        .get_webview_window(label)
                        .ok_or("This window is no longer open.")?;
                    selected
                        .show()
                        .and_then(|_| selected.unminimize())
                        .and_then(|_| selected.set_focus())
                        .map_err(|e| e.to_string())?;
                    return Ok(());
                }
                if !app
                    .state::<NativeRoles>()
                    .0
                    .values()
                    .any(|role| role.action == id)
                {
                    return Err("This command is not in the native menu.".to_owned());
                }
                run_role(&target, &id)
            })();
            let _ = send.send(result);
        })
        .map_err(|e| e.to_string())?;
    receive
        .await
        .map_err(|_| "The menu action was interrupted.".to_string())?
}

#[cfg(target_os = "macos")]
fn run_role(window: &WebviewWindow, id: &str) -> Result<(), String> {
    use objc2::{
        class, msg_send,
        runtime::{AnyObject, Bool},
        sel,
    };
    // Native menu items target Cocoa's current first responder. Only the invoking window may dispatch one.
    if !window.is_focused().map_err(|e| e.to_string())? {
        return Err("Focus this map window before running the command.".into());
    }
    let action = match id {
        "native:about" => sel!(orderFrontStandardAboutPanel:),
        "native:hide" => sel!(hide:),
        "native:hide-others" => sel!(hideOtherApplications:),
        "native:cut" => sel!(cut:),
        "native:copy" => sel!(copy:),
        "native:paste" => sel!(paste:),
        "native:select-all" => sel!(selectAll:),
        "native:minimize" => sel!(performMiniaturize:),
        "native:fullscreen" => sel!(toggleFullScreen:),
        _ => return Err("This native command is unavailable.".into()),
    };
    // This function is called on the AppKit main thread. Nil target selects the native responder chain.
    let sent: Bool = unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let nil = std::ptr::null_mut::<AnyObject>();
        msg_send![app, sendAction: action, to: nil, from: nil]
    };
    if sent.as_bool() {
        Ok(())
    } else {
        Err("The focused control does not support this command.".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn run_role(window: &WebviewWindow, id: &str) -> Result<(), String> {
    if id == "native:about" {
        use tauri_plugin_dialog::DialogExt;
        let version = &window.app_handle().package_info().version;
        window
            .app_handle()
            .dialog()
            .message(format!("Radiant {version}"))
            .title("About Radiant")
            .show(|_| {});
        return Ok(());
    }
    match id {
        "native:minimize" => window.minimize(),
        "native:fullscreen" => window
            .is_fullscreen()
            .and_then(|state| window.set_fullscreen(!state)),
        _ => return Err("This native command is unavailable.".into()),
    }
    .map_err(|e| e.to_string())
}

fn recent_id(path: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("recent:{}", hex::encode(Sha256::digest(path.as_bytes())))
}

pub fn update_recent<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(menu) = app.menu() else { return };
    let sections = menu.items().unwrap_or_default();
    let Some(recent) = sections.iter().find_map(|section| {
        let MenuItemKind::Submenu(section) = section else {
            return None;
        };
        section.items().ok()?.into_iter().find_map(|item| {
            let MenuItemKind::Submenu(submenu) = item else {
                return None;
            };
            (submenu.id().as_ref() == "open-recent").then_some(submenu)
        })
    }) else {
        return;
    };
    while recent.remove_at(0).ok().flatten().is_some() {}
    let paths = crate::open_files::recent(app);
    if paths.is_empty() {
        if let Ok(entry) =
            MenuItem::with_id(app, "recent-empty", "No Recent Maps", false, None::<&str>)
        {
            let _ = recent.append(&entry);
        }
    }
    for path in paths {
        let title = std::path::Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path);
        if let Ok(entry) = MenuItem::with_id(app, recent_id(&path), title, true, None::<&str>) {
            let _ = recent.append(&entry);
        }
    }
}

// Only modified chords belong in the native menu. Plain keys must stay local to the canvas
// so arrows, Return, and letters continue to work in text fields.
#[tauri::command]
pub fn set_menu_keys(
    app: tauri::AppHandle,
    bindings: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    use tauri::menu::MenuItemKind;
    let menu = app.menu().ok_or("Application menu unavailable")?;
    for section in menu.items().map_err(|e| e.to_string())? {
        if let MenuItemKind::Submenu(section) = section {
            for entry in section.items().map_err(|e| e.to_string())? {
                if let MenuItemKind::MenuItem(item) = entry {
                    let Some(binding) = bindings.get(item.id().as_ref()) else {
                        continue;
                    };
                    let accelerator = binding
                        .strip_prefix("Mod+")
                        .map(|key| format!("CmdOrCtrl+{key}"))
                        .or_else(|| binding.strip_prefix("Ctrl+Meta+").map(|key| format!("Control+Super+{key}")));
                    item.set_accelerator(accelerator)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}
