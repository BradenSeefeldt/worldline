// The native side of the app: a window showing the web app; the database it saves to (src/db.rs: a few fixed
// operations on worldline.db, nothing else); fetch_feed below (reading calendar links: public addresses only);
// show_in_finder (folders open in Finder, files are shown there, nothing is ever launched); plugins — opener (web links
// → the browser), dialog (the Save panel for backups and exports), autostart (Settings → Open at login), updater +
// process (download a signed new version, restart into it).
// Reminders: the web app sends the alerts due in the next day (set_alerts, again whenever something changes); a thread
// here shows each one at its time as a Mac notification — native, so they arrive on time even while the window is
// hidden and its web page is throttled. Each alert shows once; one more than 5 minutes late (the Mac was asleep) is
// skipped rather than shown late.
// Quitting — ⌘Q, Worldline → Quit, the Dock's Quit, logging out, shutting down: the web app is asked to save first
// (otherwise the app would end before the last keystrokes reached the database), then it quits; if it doesn't answer
// within 3 s it quits anyway. (macOS asks the app before it quits — applicationShouldTerminate, see `quit` below — and
// waits for the answer.)
// Closing the window: the web app decides (Settings → General → Keep running): by default it hides the window and the
// app keeps running (like Calendar or Mail), so scheduling links stay live; ⌘Q quits; the Dock icon brings it back.
mod db;
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
  at: f64, // epoch ms
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

/// The alerts due soon (replaces the previous list). At most 500, each with a real time.
#[tauri::command]
fn set_alerts(state: tauri::State<AlertState>, alerts: Vec<Alert>) {
  let (m, c) = &*state.0;
  let mut a = m.lock().unwrap_or_else(|e| e.into_inner());
  a.list = alerts.into_iter().filter(|x| x.at.is_finite()).take(500).collect();
  c.notify_all();
}

// ---- the database (src/db.rs). Each call runs on a worker thread: a big save never holds up the window.
type DbState<'a> = tauri::State<'a, std::sync::Arc<db::Db>>;
async fn on_db<T: Send + 'static>(db: &DbState<'_>, f: impl FnOnce(&db::Db) -> Result<T, String> + Send + 'static) -> Result<T, String> {
  let d = db.inner().clone();
  tauri::async_runtime::spawn_blocking(move || f(&d)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn db_get(db: DbState<'_>, key: String) -> Result<Option<String>, String> {
  on_db(&db, move |d| d.get(&key)).await
}
#[tauri::command]
async fn db_set(db: DbState<'_>, key: String, value: String, snapshot: Option<String>) -> Result<(), String> {
  on_db(&db, move |d| d.set(&key, &value, now_ms(), snapshot.as_deref())).await
}
#[tauri::command]
async fn db_del(db: DbState<'_>, key: String) -> Result<(), String> {
  on_db(&db, move |d| d.del(&key)).await
}
#[tauri::command]
async fn db_keys(db: DbState<'_>, prefix: String) -> Result<Vec<String>, String> {
  on_db(&db, move |d| d.keys(&prefix)).await
}
#[tauri::command]
async fn db_snapshots(db: DbState<'_>) -> Result<Vec<String>, String> {
  on_db(&db, |d| d.snapshot_days()).await
}
#[tauri::command]
async fn db_snapshot(db: DbState<'_>, day: String) -> Result<Option<String>, String> {
  on_db(&db, move |d| d.snapshot(&day)).await
}

/// Show something in Finder: a folder opens there; anything else — a file, an app, any other bundle — is only shown
/// (selected in its folder), never opened, so a path can't launch a program. Only in your home folder or on a
/// connected drive.
#[tauri::command]
fn show_in_finder(path: String) -> Result<(), String> {
  let p = std::fs::canonicalize(&path).map_err(|_| "not found".to_string())?;
  let home = std::env::var("HOME").map_err(|e| e.to_string())?;
  if !(p.starts_with(&home) || p.starts_with("/Volumes")) {
    return Err("only folders in your home folder or on a connected drive".into());
  }
  let plain_folder = p.is_dir() && p.extension().is_none();
  let mut cmd = std::process::Command::new("/usr/bin/open");
  if !plain_folder {
    cmd.arg("-R");
  }
  cmd.arg(&p).spawn().map_err(|e| e.to_string())?;
  Ok(())
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

/// An address on the public internet — not this Mac, the local network, or a reserved range.
fn is_public_ip(ip: std::net::IpAddr) -> bool {
  use std::net::IpAddr;
  match ip {
    IpAddr::V4(v) => {
      let o = v.octets();
      !(v.is_private() || v.is_loopback() || v.is_link_local() || v.is_unspecified() || v.is_broadcast() || v.is_documentation() || (o[0] == 100 && (64..128).contains(&o[1])) || o[0] == 0)
    }
    IpAddr::V6(v) => {
      let s = v.segments()[0];
      if let Some(m) = v.to_ipv4_mapped() {
        return is_public_ip(IpAddr::V4(m));
      }
      !(v.is_loopback() || v.is_unspecified() || (s & 0xfe00) == 0xfc00 || (s & 0xffc0) == 0xfe80)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::is_public_ip;
  #[test]
  fn only_public_addresses() {
    for a in ["8.8.8.8", "142.250.80.46", "2606:4700::1111"] {
      assert!(is_public_ip(a.parse().unwrap()), "{a} is public");
    }
    for a in ["127.0.0.1", "10.0.0.103", "192.168.1.1", "172.16.5.4", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:192.168.1.1"] {
      assert!(!is_public_ip(a.parse().unwrap()), "{a} is not public");
    }
  }
}

/// Names are looked up here, at connect time, and only public addresses are used: a name can't point (or be
/// re-pointed, between the check and the fetch, or after a redirect) at this Mac or the local network.
struct PublicOnly;
impl tauri_plugin_http::reqwest::dns::Resolve for PublicOnly {
  fn resolve(&self, name: tauri_plugin_http::reqwest::dns::Name) -> tauri_plugin_http::reqwest::dns::Resolving {
    use std::net::ToSocketAddrs;
    let host = name.as_str().to_string();
    Box::pin(async move {
      type E = Box<dyn std::error::Error + Send + Sync>;
      let all = tauri::async_runtime::spawn_blocking(move || (host.as_str(), 0).to_socket_addrs().map(|a| a.collect::<Vec<_>>()))
        .await
        .map_err(|e| Box::new(e) as E)?
        .map_err(|e| Box::new(e) as E)?;
      let ok: Vec<std::net::SocketAddr> = all.into_iter().filter(|a| is_public_ip(a.ip())).collect();
      if ok.is_empty() {
        return Err("not a public address".into());
      }
      Ok(Box::new(ok.into_iter()) as tauri_plugin_http::reqwest::dns::Addrs)
    })
  }
}

/// Read a calendar link (.ics) for a subscription. Only public web addresses — never this Mac or the local network
/// (the page can't use this to reach a router, a printer or a dev server), at most 20 MB, 30 s.
#[tauri::command]
async fn fetch_feed(url: String) -> Result<String, String> {
  use std::net::{IpAddr, ToSocketAddrs};
  use tauri_plugin_http::reqwest;
  let u = reqwest::Url::parse(&url).map_err(|_| "that isn't a web address".to_string())?;
  if !matches!(u.scheme(), "http" | "https") {
    return Err("only http(s) calendar links can be read".into());
  }
  let host = u.host_str().ok_or("that link has no server in it")?.to_string();
  let port = u.port_or_known_default().unwrap_or(443);
  let addrs: Vec<IpAddr> = tauri::async_runtime::spawn_blocking(move || (host.as_str(), port).to_socket_addrs().map(|a| a.map(|x| x.ip()).collect()))
    .await
    .map_err(|e| e.to_string())?
    .map_err(|_| "couldn't find that server (check the link, or the internet connection)".to_string())?;
  if addrs.is_empty() || !addrs.into_iter().all(is_public_ip) {
    return Err("that address is on this Mac or the local network — only public calendar links can be read".into());
  }
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(30))
    .dns_resolver(std::sync::Arc::new(PublicOnly))
    // a redirect may not lead somewhere private either (a name is checked again when it's fetched next time)
    .redirect(reqwest::redirect::Policy::custom(|a| {
      let private = match a.url().host() {
        Some(url::Host::Ipv4(v)) => !is_public_ip(IpAddr::V4(v)),
        Some(url::Host::Ipv6(v)) => !is_public_ip(IpAddr::V6(v)),
        Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".local") || d.ends_with(".localhost"),
        None => true,
      };
      if private || a.previous().len() > 5 { a.stop() } else { a.follow() }
    }))
    .build()
    .map_err(|e| e.to_string())?;
  let res = client.get(u).header("Accept", "text/calendar, text/plain, */*").send().await.map_err(|e| format!("couldn't reach it ({})", e.without_url()))?;
  let status = res.status();
  if status.as_u16() == 404 {
    return Err("not found (404) — check the link".into());
  }
  if !status.is_success() {
    return Err(format!("the server said {}", status.as_u16()));
  }
  if res.content_length().unwrap_or(0) > 20_000_000 {
    return Err("that calendar is too big (over 20 MB)".into());
  }
  // read in pieces, stopping at 20 MB (a server needn't say how big it is up front)
  let mut res = res;
  let mut bytes = Vec::new();
  while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
    if bytes.len() + chunk.len() > 20_000_000 {
      return Err("that calendar is too big (over 20 MB)".into());
    }
    bytes.extend_from_slice(&chunk);
  }
  Ok(String::from_utf8_lossy(&bytes).into_owned())
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
      let due: Vec<Alert> = a.list.iter().filter(|x| x.at <= now as f64 && x.at > (now - LATE_MS) as f64 && !a.fired.contains(&x.key)).cloned().collect();
      for d in due {
        let _ = app.notification().builder().title(&d.title).body(&d.body).show();
        let _ = app.emit("alert", (&d.title, &d.body)); // shown inside the app too (in case notifications are off)
        a.fired.insert(d.key);
      }
      // forget alerts no longer listed (and long past), so the set stays small
      let keep: HashSet<String> = a.list.iter().filter(|x| x.at > (now - 2 * LATE_MS) as f64).map(|x| x.key.clone()).collect();
      a.fired.retain(|k| keep.contains(k));
      let next = a.list.iter().filter(|x| x.at > now as f64).map(|x| x.at as i64).min();
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
  quit::finish(&app);
}

/// Ask the web app to save, then quit (it calls quit_now; after 3 s the app quits anyway). Asked once per quit.
fn request_quit(app: &tauri::AppHandle) {
  if quit::ASKED.swap(true, std::sync::atomic::Ordering::SeqCst) {
    return;
  }
  if app.emit("quit-requested", ()).is_err() {
    quit::finish(app);
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(std::time::Duration::from_secs(3));
    quit::finish(&app);
  });
}

/// Quitting however it's asked for. macOS asks the app first (`applicationShouldTerminate:` — the Dock's Quit, logging
/// out, shutting down, an AppleScript `quit`); the answer is "later", the web app saves, then the answer is yes.
mod quit {
  use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
  pub static ASKED: AtomicBool = AtomicBool::new(false); // the web app has been asked to save
  static DONE: AtomicBool = AtomicBool::new(false); // saved (or out of time): quitting goes ahead
  static WAITING: AtomicBool = AtomicBool::new(false); // macOS is waiting for the answer
  static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

  /// Quit now: answer macOS if it's waiting, else quit.
  pub fn finish(app: &tauri::AppHandle) {
    if DONE.swap(true, SeqCst) {
      return;
    }
    #[cfg(target_os = "macos")]
    if WAITING.swap(false, SeqCst) {
      let _ = app.run_on_main_thread(|| unsafe {
        use objc2::runtime::{AnyObject, Bool};
        let ns: *mut AnyObject = objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
        let _: () = objc2::msg_send![ns, replyToApplicationShouldTerminate: Bool::YES];
      });
      return;
    }
    app.exit(0);
  }

  #[cfg(target_os = "macos")]
  extern "C-unwind" fn should_terminate(_this: *mut objc2::runtime::AnyObject, _cmd: objc2::runtime::Sel, _sender: *mut objc2::runtime::AnyObject) -> usize {
    const NOW: usize = 1;
    const LATER: usize = 2;
    match APP.get() {
      Some(app) if !DONE.load(SeqCst) => {
        WAITING.store(true, SeqCst);
        super::request_quit(app);
        LATER
      }
      _ => NOW,
    }
  }

  /// Hear macOS's "may I quit?" (added to the app delegate; tao, under Tauri, doesn't answer it).
  pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "macos")]
    unsafe {
      use objc2::runtime::{AnyObject, Imp};
      let ns: *mut AnyObject = objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
      let delegate: *mut AnyObject = objc2::msg_send![ns, delegate];
      if delegate.is_null() {
        return;
      }
      let sel = objc2::sel!(applicationShouldTerminate:);
      let cls = (*delegate).class() as *const objc2::runtime::AnyClass as *mut objc2::runtime::AnyClass;
      let imp: Imp = std::mem::transmute(should_terminate as extern "C-unwind" fn(_, _, _) -> usize);
      objc2::ffi::class_addMethod(cls, sel, imp, c"Q@:@".as_ptr());
    }
  }
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
static UNINSTALL_OK_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Settings → Uninstall asks here first, natively: only the person can say yes (whatever the page does). A yes is good
/// for two minutes — long enough for the page to close scheduling links and the login item, then call `uninstall`.
#[tauri::command]
async fn confirm_uninstall(app: tauri::AppHandle) -> bool {
  use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
  let sure = app
    .dialog()
    .message("Worldline quits, then the app and everything it saved — calendars, tasks, habits, projects, settings — go to one folder in the Trash (recoverable until you empty it). Backups and exports you saved yourself stay. Open scheduling links close.")
    .title("Uninstall Worldline?")
    .kind(MessageDialogKind::Warning)
    .buttons(MessageDialogButtons::OkCancelCustom("Move to Trash".into(), "Cancel".into()))
    .blocking_show();
  if sure {
    UNINSTALL_OK_AT.store(now_ms() as u64, std::sync::atomic::Ordering::SeqCst);
  }
  sure
}

#[tauri::command]
fn uninstall(app: tauri::AppHandle) -> Result<(), String> {
  let ok_at = UNINSTALL_OK_AT.load(std::sync::atomic::Ordering::SeqCst) as i64;
  if ok_at == 0 || now_ms() - ok_at > 120_000 {
    return Err("Not confirmed".into());
  }
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
  quit::finish(&app);
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_notification::init())
    .manage(AlertState::default())
    .invoke_handler(tauri::generate_handler![
      save_file, quit_now, confirm_uninstall, uninstall, set_alerts, test_alert, fetch_feed, show_in_finder,
      db_get, db_set, db_del, db_keys, db_snapshots, db_snapshot,
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
      // the same file earlier versions used: ~/Library/Application Support/<app id>/worldline.db
      app.manage(std::sync::Arc::new(db::Db::new(app.path().app_config_dir()?.join("worldline.db"))));
      app.set_menu(menu(app.handle())?)?;
      quit::install(app.handle());
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
