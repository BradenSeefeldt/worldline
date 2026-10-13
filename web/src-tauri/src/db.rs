// Where the Mac app keeps your data: one SQLite file, worldline.db, in the app's own folder
// (~/Library/Application Support/<app id>/) — the same file and tables earlier versions wrote through a generic SQL
// plugin, so nothing moves. The page gets only these few fixed operations: read, write or remove one value by key, and
// list or read the daily snapshots. It can't run SQL of its own or open any other file.
//   kv        (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL)
//   snapshots (day TEXT PRIMARY KEY, value TEXT NOT NULL) — the day's first save, the newest 14 days kept; written
//             compressed (gzip, stored as a blob: a tenth of the size), older ones as plain text — both read back
use rusqlite::{params, types::ValueRef, Connection, OptionalExtension};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db {
  path: PathBuf,
  conn: Mutex<Option<Connection>>,
}

const SNAPSHOT_DAYS: i64 = 14;

/// A key the app uses: letters, digits and `-_.:` (e.g. `calendar-v1`, `calendar-v1-unreadable-2026-10-12T14:03:00.000Z`).
pub fn valid_key(k: &str) -> bool {
  !k.is_empty() && k.len() <= 120 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
/// A snapshot's day: YYYY-MM-DD.
pub fn valid_day(d: &str) -> bool {
  let b = d.as_bytes();
  b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

impl Db {
  pub fn new(path: PathBuf) -> Self {
    Db { path, conn: Mutex::new(None) }
  }

  /// Run `f` on the open database (opened, and its tables made, the first time; tried again next time if that fails).
  fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
    let mut g = self.conn.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
      if let Some(dir) = self.path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
      }
      let c = Connection::open(&self.path).map_err(|e| e.to_string())?;
      c.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
      c.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS snapshots (day TEXT PRIMARY KEY, value TEXT NOT NULL);",
      )
      .map_err(|e| e.to_string())?;
      *g = Some(c);
    }
    f(g.as_ref().unwrap()).map_err(|e| e.to_string())
  }

  pub fn get(&self, key: &str) -> Result<Option<String>, String> {
    if !valid_key(key) {
      return Err("bad key".into());
    }
    self.with(|c| c.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional())
  }

  /// Write a value; with `snapshot` (a day), the day's first save is also kept as that day's snapshot — in one
  /// transaction, so a crash never leaves one without the other.
  pub fn set(&self, key: &str, value: &str, now: i64, snapshot: Option<&str>) -> Result<(), String> {
    if !valid_key(key) || snapshot.is_some_and(|d| !valid_day(d)) {
      return Err("bad key".into());
    }
    self.with(|c| {
      let tx = c.unchecked_transaction()?;
      tx.execute(
        "INSERT INTO kv (key, value, updated) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated = ?3",
        params![key, value, now],
      )?;
      // (only the day's first save: checked first, so the other saves don't compress megabytes for nothing)
      let have: bool = match snapshot {
        Some(day) => tx.query_row("SELECT 1 FROM snapshots WHERE day = ?1", [day], |_| Ok(())).optional()?.is_some(),
        None => true,
      };
      if let (Some(day), false) = (snapshot, have) {
        tx.execute("INSERT INTO snapshots (day, value) VALUES (?1, ?2)", params![day, gzip(value)])?;
        tx.execute(
          "DELETE FROM snapshots WHERE day NOT IN (SELECT day FROM snapshots ORDER BY day DESC LIMIT ?1)",
          [SNAPSHOT_DAYS],
        )?;
      }
      tx.commit()
    })
  }

  pub fn del(&self, key: &str) -> Result<(), String> {
    if !valid_key(key) {
      return Err("bad key".into());
    }
    self.with(|c| c.execute("DELETE FROM kv WHERE key = ?1", [key]).map(|_| ()))
  }

  /// The keys starting with `prefix` (the copies kept aside, to tidy them up).
  pub fn keys(&self, prefix: &str) -> Result<Vec<String>, String> {
    if !valid_key(prefix) {
      return Err("bad key".into());
    }
    self.with(|c| {
      let mut s = c.prepare("SELECT key FROM kv WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key")?;
      let rows = s.query_map([prefix], |r| r.get(0))?;
      rows.collect()
    })
  }

  /// The snapshots' days, newest first.
  pub fn snapshot_days(&self) -> Result<Vec<String>, String> {
    self.with(|c| {
      let mut s = c.prepare("SELECT day FROM snapshots ORDER BY day DESC")?;
      let rows = s.query_map([], |r| r.get(0))?;
      rows.collect()
    })
  }

  pub fn snapshot(&self, day: &str) -> Result<Option<String>, String> {
    if !valid_day(day) {
      return Err("bad day".into());
    }
    self.with(|c| {
      c.query_row("SELECT value FROM snapshots WHERE day = ?1", [day], |r| {
        Ok(match r.get_ref(0)? {
          ValueRef::Blob(b) => gunzip(b),
          ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
          _ => None,
        })
      })
      .optional()
      .map(Option::flatten)
    })
  }
}

fn gzip(s: &str) -> Vec<u8> {
  let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
  let _ = e.write_all(s.as_bytes());
  e.finish().unwrap_or_default()
}
fn gunzip(b: &[u8]) -> Option<String> {
  let mut out = String::new();
  flate2::read::GzDecoder::new(b).read_to_string(&mut out).ok().map(|_| out)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tmp() -> PathBuf {
    let p = std::env::temp_dir().join(format!("worldline-db-test-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&p).unwrap();
    p.join("worldline.db")
  }
  /// A folder of its own for each test (tests run in parallel; the clock alone can give two the same name).
  fn rand_suffix() -> String {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("{}-{n}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
  }

  #[test]
  fn keys_and_days() {
    for k in ["calendar-v1", "worldline-sync-doc", "calendar-v1-unreadable-2026-10-12T14:03:00.000Z", "wl-sched-gone"] {
      assert!(valid_key(k), "{k}");
    }
    for k in ["", "a b", "x'; DROP TABLE kv; --", "../x", &"k".repeat(121)] {
      assert!(!valid_key(k), "{k}");
    }
    assert!(valid_day("2026-10-12"));
    for d in ["2026-1-12", "2026/10/12", "x", "2026-10-12 "] {
      assert!(!valid_day(d), "{d}");
    }
  }

  #[test]
  fn values_and_snapshots() {
    let path = tmp();
    let db = Db::new(path.clone());
    assert_eq!(db.get("calendar-v1").unwrap(), None);
    db.set("calendar-v1", "one", 1, Some("2026-10-01")).unwrap();
    db.set("calendar-v1", "two", 2, Some("2026-10-01")).unwrap(); // the day's first save is the snapshot
    assert_eq!(db.get("calendar-v1").unwrap().as_deref(), Some("two"));
    assert_eq!(db.snapshot("2026-10-01").unwrap().as_deref(), Some("one"));
    let big = format!("{{\"state\":{{\"events\":[{}]}}}}", "{\"id\":\"e\",\"title\":\"Group meeting\"},".repeat(20_000));
    db.set("calendar-v1", &big, 2, Some("2026-09-30")).unwrap();
    assert_eq!(db.snapshot("2026-09-30").unwrap().as_deref(), Some(big.as_str())); // compressed, read back the same
    let stored: i64 = db.with(|c| c.query_row("SELECT length(value) FROM snapshots WHERE day = '2026-09-30'", [], |r| r.get(0))).unwrap();
    assert!(stored * 20 < big.len() as i64, "kept compressed ({stored} bytes)");
    for d in 2..=20 {
      db.set("calendar-v1", &format!("v{d}"), d, Some(&format!("2026-10-{d:02}"))).unwrap();
    }
    let days = db.snapshot_days().unwrap();
    assert_eq!(days.len(), 14);
    assert_eq!(days[0], "2026-10-20");
    db.set("calendar-v1-unreadable-a", "x", 3, None).unwrap();
    db.set("calendar-v1-unreadable-b", "y", 3, None).unwrap();
    assert_eq!(db.keys("calendar-v1-unreadable").unwrap(), vec!["calendar-v1-unreadable-a", "calendar-v1-unreadable-b"]);
    db.del("calendar-v1-unreadable-a").unwrap();
    assert_eq!(db.keys("calendar-v1-unreadable").unwrap().len(), 1);
    assert!(db.get("bad key").is_err());
    assert!(db.set("k", "v", 0, Some("not a day")).is_err());
    // the file earlier versions wrote opens as it is
    drop(db);
    let again = Db::new(path.clone());
    assert_eq!(again.get("calendar-v1").unwrap().as_deref(), Some("v20"));
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
  }

  #[test]
  fn reads_a_database_made_the_old_way() {
    let path = tmp();
    {
      let c = Connection::open(&path).unwrap();
      c.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
         CREATE TABLE snapshots (day TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO kv VALUES ('calendar-v1', '{\"state\":{}}', 5);
         INSERT INTO snapshots VALUES ('2026-10-11', 'old');",
      )
      .unwrap();
    }
    let db = Db::new(path.clone());
    assert_eq!(db.get("calendar-v1").unwrap().as_deref(), Some("{\"state\":{}}"));
    assert_eq!(db.snapshot_days().unwrap(), vec!["2026-10-11"]);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
  }
}
