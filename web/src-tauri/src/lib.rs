// The native side of the app: a window showing the web app, plus plugins — sql (the SQLite database the app saves
// to), http (fetching calendar links), opener (links → browser, folders → Finder), dialog (the Save panel for backups
// and exports), autostart (Settings → Open at login), updater + process (download a signed new version, restart into it).
// Reminders: the web app sends the alerts due in the next day (set_alerts, again whenever something changes); a thread
// here shows each one at its time as a Mac notification — native, so they arrive on time even while the window is
// hidden and its web page is throttled. Each alert shows once; one more than 5 minutes late (the Mac was asleep) is
// skipped rather than shown late.
// Quitting (⌘Q, or Worldline → Quit): the web app is asked to save first (the built-in Quit would end the app before
// the last keystrokes reached the database), then it quits; if it doesn't answer within 3 s it quits anyway.
// Closing the window: the web app decides (Settings → General → Keep running): by default it hides the window and the
// app keeps running (like Calendar or Mail), so scheduling links stay live; ⌘Q quits; the Dock icon brings it back.
#[cfg(target_os = "macos")]
mod eventkit;

use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

#[derive(serde::Deserialize, Clone)]
struct Alert {
  key: String,
  at: i64, // epoch ms
  title: String,
  body: String,
}
#[derive(Default)]
struct Alerts {
  list: Vec<Alert>,
  fired: HashSet<String>,
}
#[derive(Clone, Default)]
struct AlertState(Arc<(Mutex<Alerts>, Condvar)>);

const LATE_MS: i64 = 5 * 60_000;
fn now_ms() -> i64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The alerts due soon (replaces the previous list).
#[tauri::command]
fn set_alerts(state: tauri::State<AlertState>, alerts: Vec<Alert>) {
  let (m, c) = &*state.0;
  let mut a = m.lock().unwrap_or_else(|e| e.into_inner());
  a.list = alerts;
  c.notify_all();
}

// ---- Calendars on this Mac (src/eventkit.rs). Each runs on a worker thread: asking for access waits for the person.
#[cfg(target_os = "macos")]
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}
#[cfg(target_os = "macos")]
#[tauri::command]
async fn ek_status() -> Result<String, String> {
  blocking(eventkit::status).await
}
#[cfg(target_os = "macos")]
#[tauri::command]
async fn ek_request() -> Result<String, String> {
  blocking(eventkit::request).await?
}
#[cfg(target_os = "macos")]
#[tauri::command]
async fn ek_calendars() -> Result<Vec<eventkit::EkCal>, String> {
  blocking(eventkit::calendars).await
}
#[cfg(target_os = "macos")]
#[tauri::command]
async fn ek_events(from: f64, to: f64, calendars: Vec<String>) -> Result<Vec<eventkit::EkEvent>, String> {
  blocking(move || eventkit::events(from, to, calendars)).await
}
#[cfg(target_os = "macos")]
#[tauri::command]
async fn ek_save(event: eventkit::EkSave) -> Result<String, String> {
  blocking(move || eventkit::save(event)).await?
}
#[cfg(target_os = "macos")]
#[tauri::command]
async fn ek_delete(ext: String, occ: f64, calendar: String) -> Result<(), String> {
  blocking(move || eventkit::delete(ext, occ, calendar)).await?
}

/// Settings → Alerts → Send a test alert.
#[tauri::command]
fn test_alert(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
  app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

fn run_alerts(app: tauri::AppHandle, state: AlertState) {
  std::thread::spawn(move || {
    let (m, c) = &*state.0;
    let mut a = m.lock().unwrap_or_else(|e| e.into_inner());
    loop {
      let now = now_ms();
      let due: Vec<Alert> = a.list.iter().filter(|x| x.at <= now && x.at > now - LATE_MS && !a.fired.contains(&x.key)).cloned().collect();
      for d in due {
        let _ = app.notification().builder().title(&d.title).body(&d.body).show();
        let _ = app.emit("alert", (&d.title, &d.body)); // shown inside the app too (in case notifications are off)
        a.fired.insert(d.key);
      }
      // forget alerts no longer listed (and long past), so the set stays small
      let keep: HashSet<String> = a.list.iter().filter(|x| x.at > now - 2 * LATE_MS).map(|x| x.key.clone()).collect();
      a.fired.retain(|k| keep.contains(k));
      let next = a.list.iter().filter(|x| x.at > now).map(|x| x.at).min();
      let wait = next.map_or(60_000, |t| (t - now).clamp(50, 60_000)) as u64;
      a = c.wait_timeout(a, Duration::from_millis(wait)).unwrap_or_else(|e| e.into_inner()).0;
    }
  });
}

/// Save a backup / export: show the Save panel and write to the file the person chooses there. The panel lives here,
/// not in the web page, so the page can only ever write a file the person picked (never a path of its own choosing).
/// Ok(false): they cancelled.
#[tauri::command]
async fn save_file(app: tauri::AppHandle, name: String, contents: String) -> Result<bool, String> {
  let Some(picked) = app.dialog().file().set_file_name(name).blocking_save_file() else { return Ok(false) };
  let path = picked.into_path().map_err(|e| e.to_string())?;
  std::fs::write(&path, contents).map_err(|e| e.to_string())?;
  Ok(true)
}

/// The web app has saved everything (after "quit-requested"): quit now.
#[tauri::command]
fn quit_now(app: tauri::AppHandle) {
  app.exit(0);
}

fn request_quit(app: &tauri::AppHandle) {
  if app.emit("quit-requested", ()).is_err() {
    app.exit(0);
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(std::time::Duration::from_secs(3));
    app.exit(0);
  });
}

/// The standard Mac menu, with its Quit swapped for one that saves first.
fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
  let menu = Menu::default(app)?;
  if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
    for item in app_menu.items()? {
      if let MenuItemKind::Predefined(p) = &item {
        if p.text()?.starts_with("Quit") {
          app_menu.remove(p)?;
        }
      }
    }
    let name = app.config().product_name.clone().unwrap_or_else(|| "Worldline".into());
    app_menu.append(&MenuItem::with_id(app, "quit", format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?)?;
  }
  Ok(menu)
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
    .plugin(tauri_plugin_notification::init())
    .manage(AlertState::default())
    .invoke_handler(tauri::generate_handler![
      save_file, quit_now, uninstall, set_alerts, test_alert,
      #[cfg(target_os = "macos")] ek_status,
      #[cfg(target_os = "macos")] ek_request,
      #[cfg(target_os = "macos")] ek_calendars,
      #[cfg(target_os = "macos")] ek_events,
      #[cfg(target_os = "macos")] ek_save,
      #[cfg(target_os = "macos")] ek_delete
    ])
    .on_menu_event(|app, ev| {
      if ev.id() == "quit" {
        request_quit(app);
      }
    })
    .setup(|app| {
      app.set_menu(menu(app.handle())?)?;
      run_alerts(app.handle().clone(), app.state::<AlertState>().inner().clone());
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
