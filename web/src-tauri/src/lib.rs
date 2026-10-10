// The native side of the app: a window showing the web app, plus three plugins —
// sql (the SQLite database the app saves to), http (fetching calendar links), opener (links → browser, folders → Finder).
// On the Mac, closing the window hides it and the app keeps running (like Calendar or Mail), so your scheduling links
// stay live and bookings keep arriving; ⌘Q quits, clicking the Dock icon brings the window back.
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::default().build())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
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
    .on_window_event(|window, event| {
      #[cfg(target_os = "macos")]
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
      }
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
