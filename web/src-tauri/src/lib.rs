// The native side of the app: a window showing the web app, plus plugins — sql (the SQLite database the app saves
// to), http (fetching calendar links), opener (links → browser, folders → Finder), dialog (the Save panel for backups
// and exports), autostart (Settings → Open at login).
// Closing the window: the web app decides (Settings → General → Keep running): by default it hides the window and the
// app keeps running (like Calendar or Mail), so scheduling links stay live; ⌘Q quits; the Dock icon brings it back.
use tauri::Manager;

/// Write a backup / export to the file the person just chose in the Save panel.
#[tauri::command]
fn save_text(path: String, contents: String) -> Result<(), String> {
  std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::default().build())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
    .invoke_handler(tauri::generate_handler![save_text])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building the app")
    .run(|app, event| {
      #[cfg(target_os = "macos")]
      if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
        if !has_visible_windows {
          if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
          }
        }
      }
    });
}
