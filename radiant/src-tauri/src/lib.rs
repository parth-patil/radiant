//! Radiant host. Module ownership:
//!   codex     – Codex app-server client and AI commands (ai_*)
//!   store     – document files, autosave, crash recovery, asset store (doc_*, asset_*)
//!   platform  – window setup, 120 Hz WebKit setting, platform_info
//! The command names and payloads are fixed by src/lib/host/types.ts. Only the coordinator edits this file.

mod agent_access;
mod codex;
mod capture;
mod diagnostics;
mod menu;
mod open_files;
mod native_interop;
mod platform;
mod presenter;
mod reminders;
mod store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(codex::CodexState::default())
        .manage(capture::CaptureState::default())
        .manage(presenter::Presenter::default())
        .manage(agent_access::AgentAccess::default())
        .manage(open_files::OpenFiles::default())
        .manage(store::StoreState::default())
        .manage(reminders::ReminderLinks::default())
        .setup(|app| {
            if app.config().plugins.0.contains_key("updater") {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            open_files::setup(app.handle());
            agent_access::setup(app.handle());
            menu::setup(app)?;
            if let Err(error) = capture::setup(app) { log::warn!("Quick Capture menu unavailable: {error}"); }
            platform::setup(app)?;
            store::setup(app)?;
            codex::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            codex::ai_status,
            codex::ai_queue,
            capture::capture_recent,
            capture::capture_submit,
            capture::capture_complete,
            capture::capture_history,
            presenter::presenter_open,
            presenter::presenter_close,
            presenter::presenter_publish,
            presenter::presenter_command,
            codex::ai_start_turn,
            codex::ai_resolve_map_round,
            codex::ai_cancel,
            agent_access::agent_grant,
            agent_access::agent_revoke,
            agent_access::agent_take,
            agent_access::agent_finish,
            agent_access::agent_consent,
            open_files::take_open_files,
            open_files::open_document_window,
            open_files::map_link::route_open_map_link,
            open_files::map_link::finish_map_link,
            open_files::claim_document_path,
            open_files::release_document_path,
            open_files::note_document,
            open_files::offer_desktop_session,
            open_files::finish_desktop_session,
            open_files::respond_desktop_quit,
            open_files::open_node_file,
            menu::set_menu_keys,
            menu::palette_items,
            menu::run_palette_item,
            store::doc_save,
            store::doc_load,
            store::doc_open,
            store::doc_create,
            store::browser::list_map_folder,
            store::browser::preview_map_json,
            store::doc_exists,
            store::doc_autosave,
            store::doc_commit,
            store::expect_recovery_revision,
            store::doc_recover,
            store::doc_discard_recovery,
            store::asset_put,
            store::asset_record,
            store::asset_path,
            store::asset_image_info,
            store::asset_foreground_mask,
            store::text_read,
            store::binary_read,
            store::mindnode::rasterize_imported_pdf,
            store::text_write,
            store::export_write,
            store::bundle::bundle_read_directory,
            store::bundle::bundle_write_directory,
            platform::platform_info,
            reminders::reminders_links,
            reminders::reminders_connect,
            reminders::reminders_disconnect,
            reminders::reminders_sync,
            reminders::reminders_ack,
            diagnostics::diagnostic_record,
            diagnostics::diagnostic_recent,
            native_interop::prepare_drag_file,
            native_interop::open_pdf_for_print,
            native_interop::start_drag_file,
            native_interop::write_image_clipboard,
            native_interop::write_vector_clipboard,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Radiant")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                codex::shutdown(app);
            }
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
                codex::cancel_window(app, label);
                presenter::window_destroyed(app, label);
            }
            open_files::on_event(app, event);
        });
}
