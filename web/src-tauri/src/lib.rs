// The native side of the app: a window showing the web app, plus plugins — sql (the SQLite database the app saves
// to), http (fetching calendar links), opener (links → browser, folders → Finder), dialog (the Save panel for backups
// and exports), autostart (Settings → Open at login), updater + process (download a signed new version, restart into it).
// Closing the window: the web app decides (Settings → General → Keep running): by default it hides the window and the
// app keeps running (like Calendar or Mail), so scheduling links stay live; ⌘Q quits; the Dock icon brings it back.
use tauri::Manager;

/// Write a backup / export to the file the person just chose in the Save panel.
#[tauri::command]
fn save_text(path: String, contents: String) -> Result<(), String> {
  std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Settings → Data & Backups → Uninstall: quit, then (once this process has exited, so nothing writes the files back)
/// move the app and everything it ever created into one folder in the Trash — recoverable until the Trash is emptied.
/// Files the person saved themselves (backups, exports) are not touched.
#[tauri::command]
fn uninstall(app: tauri::AppHandle) -> Result<(), String> {
  let home = std::env::var("HOME").map_err(|e| e.to_string())?;
  let id = app.config().identifier.clone();
  let lib = format!("{home}/Library");
  // the running app bundle (…/Worldline.app), found from the executable's path
  let exe = std::env::current_exe().map_err(|e| e.to_string())?;
  let bundle = exe.ancestors().find(|p| p.extension().map_or(false, |x| x == "app")).map(|p| p.to_string_lossy().into_owned());
  let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
  // (source, folder inside the Trash folder it goes to)
  let mut items: Vec<(String, &str)> = vec![
    (format!("{lib}/Application Support/{id}"), "Application Support"),
    (format!("{lib}/Caches/{id}"), "Caches"),
    (format!("{lib}/WebKit/{id}"), "WebKit"),
    (format!("{lib}/HTTPStorages/{id}"), "HTTPStorages"),
    (format!("{lib}/HTTPStorages/{id}.binarycookies"), "HTTPStorages"),
    (format!("{lib}/Saved Application State/{id}.savedState"), "Saved Application State"),
    (format!("{lib}/Logs/{id}"), "Logs"),
    (format!("{lib}/Preferences/{id}.plist"), "Preferences"),
    (format!("{lib}/LaunchAgents/Worldline.plist"), "LaunchAgents"),
  ];
  if let Some(b) = &bundle {
    items.push((b.clone(), "."));
  }
  let pid = std::process::id();
  let stamp = std::process::Command::new("date").arg("+%Y-%m-%d %H.%M").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
  let trash = format!("{home}/.Trash/Worldline (removed {stamp})");
  let mut script = format!("while kill -0 {pid} 2>/dev/null; do sleep 0.2; done\nT={}\nmkdir -p \"$T\"\n", q(&trash));
  script.push_str(&format!("defaults delete {} 2>/dev/null\n", q(&id)));
  for (src, dest) in &items {
    script.push_str(&format!("if [ -e {s} ]; then mkdir -p \"$T/{d}\" && mv {s} \"$T/{d}/\"; fi\n", s = q(src), d = dest));
  }
  // the per-user temporary and cache folders macOS keeps for the app (and any downloaded update)
  for dir in ["DARWIN_USER_TEMP_DIR", "DARWIN_USER_CACHE_DIR"] {
    script.push_str(&format!("D=\"$(getconf {dir})\"; if [ -e \"${{D}}{id}\" ]; then mkdir -p \"$T/{dir}\" && mv \"${{D}}{id}\" \"$T/{dir}/\"; fi\n", id = id)); // ${D}, not $D: "$Dio…" would read as a variable named Dio
  }
  std::process::Command::new("/bin/sh")
    .arg("-c")
    .arg(script)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map_err(|e| e.to_string())?;
  app.exit(0);
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::default().build())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![save_text, uninstall])
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
