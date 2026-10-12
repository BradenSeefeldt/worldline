// Calendars on this Mac — iCloud, Google, Exchange, whatever the Calendar app has — through macOS's EventKit. The web
// app (data/macCalendars.ts) decides what to read and write; this is only the bridge: ask for access, list the
// calendars, read the events in a time range, save or delete one occurrence. Times cross as epoch milliseconds.
// A repeating event comes as its occurrences (each one: the series' identifier + the occurrence's original start).
#![cfg(target_os = "macos")]

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObjectProtocol};
use objc2::sel;
use objc2::AnyThread;
use objc2_app_kit::NSColorSpace;
use objc2_event_kit::{
  EKAuthorizationStatus, EKCalendar, EKEntityType, EKEvent, EKEventStore, EKRecurrenceDayOfWeek, EKRecurrenceEnd,
  EKRecurrenceFrequency, EKRecurrenceRule, EKSpan, EKWeekday,
};
use objc2_foundation::{NSArray, NSDate, NSError, NSString, NSURL};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct EkCal {
  id: String,
  title: String,
  color: String,
  account: String,
  writable: bool,
}

#[derive(Serialize)]
pub struct EkEvent {
  ext: String, // the event's identifier (the same for every occurrence of a series)
  occ: f64, // the occurrence's original start (ms) — with `ext`, names one occurrence
  calendar: String,
  title: String,
  start: f64,
  end: f64,
  all_day: bool,
  location: Option<String>,
  notes: Option<String>,
  url: Option<String>,
  recurring: bool,
}

#[derive(Deserialize, Clone)]
pub struct EkRule {
  freq: String, // daily | weekly | monthly | yearly
  interval: i64,
  by_day: Vec<i64>, // 0 = Sunday … 6 = Saturday
  until: Option<f64>,
}

#[derive(Deserialize)]
pub struct EkSave {
  ext: Option<String>, // None: a new event
  occ: Option<f64>,
  calendar: String,
  title: String,
  start: f64,
  end: f64,
  all_day: bool,
  location: Option<String>,
  notes: Option<String>,
  url: Option<String>,
  rule: Option<EkRule>, // a new repeating event
}

fn date(ms: f64) -> Retained<NSDate> {
  NSDate::dateWithTimeIntervalSince1970(ms / 1000.0)
}
fn ms(d: &NSDate) -> f64 {
  (d.timeIntervalSince1970() * 1000.0).round()
}
fn ns(s: &str) -> Retained<NSString> {
  NSString::from_str(s)
}
fn err(e: Retained<NSError>) -> String {
  e.localizedDescription().to_string()
}

fn status_name(s: EKAuthorizationStatus) -> &'static str {
  match s {
    EKAuthorizationStatus::FullAccess => "full",
    EKAuthorizationStatus::WriteOnly => "writeOnly",
    EKAuthorizationStatus::Denied => "denied",
    EKAuthorizationStatus::Restricted => "restricted",
    _ => "notDetermined",
  }
}

pub fn status() -> String {
  status_name(unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) }).into()
}

/// Ask for full access (macOS shows its dialog once). Waits for the answer.
pub fn request() -> Result<String, String> {
  let store = unsafe { EKEventStore::new() };
  let (tx, rx) = std::sync::mpsc::channel::<bool>();
  let block = RcBlock::new(move |granted: Bool, _e: *mut NSError| {
    let _ = tx.send(granted.as_bool());
  });
  unsafe {
    if store.respondsToSelector(sel!(requestFullAccessToEventsWithCompletion:)) {
      store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&block));
    } else {
      #[allow(deprecated)]
      store.requestAccessToEntityType_completion(EKEntityType::Event, RcBlock::as_ptr(&block));
    }
  }
  rx.recv_timeout(std::time::Duration::from_secs(600)).map_err(|_| "No answer from macOS".to_string())?;
  Ok(status())
}

fn hex(cal: &EKCalendar) -> String {
  unsafe {
    let c = cal.color();
    match c.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace()) {
      Some(c) => {
        let to = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
        format!("#{:02x}{:02x}{:02x}", to(c.redComponent()), to(c.greenComponent()), to(c.blueComponent()))
      }
      None => "#8e8e93".into(),
    }
  }
}

pub fn calendars() -> Vec<EkCal> {
  unsafe {
    let store = EKEventStore::new();
    store
      .calendarsForEntityType(EKEntityType::Event)
      .to_vec()
      .iter()
      .map(|c| EkCal {
        id: c.calendarIdentifier().to_string(),
        title: c.title().to_string(),
        color: hex(c),
        account: c.source().map(|s| s.title().to_string()).unwrap_or_else(|| "On My Mac".into()),
        writable: c.allowsContentModifications(),
      })
      .collect()
  }
}

fn find_calendars(store: &EKEventStore, ids: &[String]) -> Vec<Retained<EKCalendar>> {
  unsafe { ids.iter().filter_map(|id| store.calendarWithIdentifier(&ns(id))).collect() }
}

fn to_event(e: &EKEvent) -> Option<EkEvent> {
  unsafe {
    let ext = e.eventIdentifier()?.to_string();
    let start = ms(&e.startDate());
    Some(EkEvent {
      ext,
      occ: e.occurrenceDate().map(|d| ms(&d)).unwrap_or(start),
      calendar: e.calendar()?.calendarIdentifier().to_string(),
      title: e.title().to_string(),
      start,
      end: ms(&e.endDate()),
      all_day: e.isAllDay(),
      location: e.location().map(|s| s.to_string()).filter(|s| !s.is_empty()),
      notes: e.notes().map(|s| s.to_string()).filter(|s| !s.is_empty()),
      url: e.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()),
      recurring: e.hasRecurrenceRules() || e.isDetached(),
    })
  }
}

pub fn events(from: f64, to: f64, calendar_ids: Vec<String>) -> Vec<EkEvent> {
  if !sane_time(from) || !sane_time(to) || to < from {
    return vec![];
  }
  unsafe {
    let store = EKEventStore::new();
    let cals = find_calendars(&store, &calendar_ids);
    if cals.is_empty() {
      return vec![];
    }
    let pred = store.predicateForEventsWithStartDate_endDate_calendars(&date(from), &date(to), Some(&NSArray::from_retained_slice(&cals)));
    store.eventsMatchingPredicate(&pred).to_vec().iter().filter_map(|e| to_event(e)).collect()
  }
}

/// The one occurrence `ext` + `occ` (a series' identifier names its first occurrence; the others are found by date).
fn occurrence(store: &EKEventStore, ext: &str, occ: f64, calendar: &str) -> Option<Retained<EKEvent>> {
  unsafe {
    let first = store.eventWithIdentifier(&ns(ext))?;
    // only an event in the calendar it's said to be in
    if first.calendar().map(|c| c.calendarIdentifier().to_string()).as_deref() != Some(calendar) {
      return None;
    }
    if occ == 0.0 || !(first.hasRecurrenceRules() || first.isDetached()) {
      return Some(first); // a one-off event: its identifier alone
    }
    let first_occ = first.occurrenceDate().map(|d| ms(&d)).unwrap_or_else(|| ms(&first.startDate()));
    if (first_occ - occ).abs() < 1000.0 {
      return Some(first);
    }
    let cals = find_calendars(store, &[calendar.to_string()]);
    let pred = store.predicateForEventsWithStartDate_endDate_calendars(&date(occ - 86_400_000.0), &date(occ + 2.0 * 86_400_000.0), Some(&NSArray::from_retained_slice(&cals)));
    store.eventsMatchingPredicate(&pred).to_vec().into_iter().find(|e| {
      e.eventIdentifier().map(|i| i.to_string() == ext).unwrap_or(false) && e.occurrenceDate().map(|d| (ms(&d) - occ).abs() < 1000.0).unwrap_or(false)
    })
  }
}

fn rule(r: &EkRule) -> Retained<EKRecurrenceRule> {
  unsafe {
    let freq = match r.freq.as_str() {
      "daily" => EKRecurrenceFrequency::Daily,
      "monthly" => EKRecurrenceFrequency::Monthly,
      "yearly" => EKRecurrenceFrequency::Yearly,
      _ => EKRecurrenceFrequency::Weekly,
    };
    let end = r.until.map(|u| EKRecurrenceEnd::recurrenceEndWithEndDate(&date(u)));
    // (weekdays 0–6 only: anything else from synced data is dropped, never handed to EventKit)
    let days: Vec<Retained<EKRecurrenceDayOfWeek>> = r.by_day.iter().filter(|d| (0..7).contains(*d)).map(|d| EKRecurrenceDayOfWeek::dayOfWeek(EKWeekday((d + 1) as isize))).collect();
    let alloc = EKRecurrenceRule::alloc();
    if days.is_empty() {
      EKRecurrenceRule::initRecurrenceWithFrequency_interval_end(alloc, freq, r.interval.max(1) as _, end.as_deref())
    } else {
      EKRecurrenceRule::initRecurrenceWithFrequency_interval_daysOfTheWeek_daysOfTheMonth_monthsOfTheYear_weeksOfTheYear_daysOfTheYear_setPositions_end(
        alloc, freq, r.interval.max(1) as _, Some(&NSArray::from_retained_slice(&days)), None, None, None, None, None, end.as_deref(),
      )
    }
  }
}

/// A time the bridge accepts: a real instant between 1900 and 2200 (synced data is checked before EventKit sees it).
fn sane_time(ms: f64) -> bool {
  ms.is_finite() && (-2_208_988_800_000.0..7_258_118_400_000.0).contains(&ms)
}

/// Is this something EventKit can be asked to save? (Checked here too, whatever the page sends.)
pub fn check(s: &EkSave) -> Result<(), String> {
  if !sane_time(s.start) || !sane_time(s.end) || s.end < s.start {
    return Err("That event's times aren't valid".into());
  }
  if s.occ.is_some_and(|o| !sane_time(o) && o != 0.0) || s.rule.as_ref().is_some_and(|r| r.until.is_some_and(|u| !sane_time(u)) || !(1..=1000).contains(&r.interval)) {
    return Err("That event's repeat isn't valid".into());
  }
  if s.title.len() > 10_000 || s.location.as_ref().is_some_and(|x| x.len() > 10_000) || s.notes.as_ref().is_some_and(|x| x.len() > 1_000_000) || s.url.as_ref().is_some_and(|x| x.len() > 10_000) {
    return Err("That event is too big for the Calendar app".into());
  }
  Ok(())
}

/// Save one occurrence (or a new event); returns its identifier.
pub fn save(s: EkSave) -> Result<String, String> {
  check(&s)?;
  unsafe {
    let store = EKEventStore::new();
    let cal = store.calendarWithIdentifier(&ns(&s.calendar)).ok_or("That calendar is gone from this Mac")?;
    if !cal.allowsContentModifications() {
      return Err("That calendar is read-only in the Calendar app".into());
    }
    let ev = match (&s.ext, s.occ) {
      (Some(ext), Some(occ)) => occurrence(&store, ext, occ, &s.calendar).ok_or("That event is gone from the Calendar app")?,
      _ => EKEvent::eventWithEventStore(&store),
    };
    ev.setCalendar(Some(&cal));
    ev.setTitle(Some(&ns(&s.title)));
    ev.setAllDay(s.all_day);
    ev.setStartDate(Some(&date(s.start)));
    ev.setEndDate(Some(&date(if s.all_day { s.end - 1000.0 } else { s.end })));
    ev.setLocation(s.location.as_deref().map(ns).as_deref());
    ev.setNotes(s.notes.as_deref().map(ns).as_deref());
    // (a link EventKit can't read leaves the event's link as it was, rather than clearing it)
    match s.url.as_deref() {
      None => ev.setURL(None),
      Some(u) => {
        if let Some(url) = NSURL::URLWithString(&ns(u)) {
          ev.setURL(Some(&url));
        }
      }
    }
    if s.ext.is_none() {
      if let Some(r) = &s.rule {
        ev.addRecurrenceRule(&rule(r));
      }
    }
    store.saveEvent_span_commit_error(&ev, EKSpan::ThisEvent, true).map_err(err)?;
    ev.eventIdentifier().map(|i| i.to_string()).ok_or_else(|| "Saved, but the Calendar app gave it no identifier".into())
  }
}

/// Delete one occurrence.
pub fn delete(ext: String, occ: f64, calendar: String) -> Result<(), String> {
  if !(occ == 0.0 || sane_time(occ)) {
    return Err("That event's time isn't valid".into());
  }
  unsafe {
    let store = EKEventStore::new();
    if store.calendarWithIdentifier(&ns(&calendar)).is_some_and(|c| !c.allowsContentModifications()) {
      return Err("That calendar is read-only in the Calendar app".into());
    }
    match occurrence(&store, &ext, occ, &calendar) {
      Some(ev) => store.removeEvent_span_commit_error(&ev, EKSpan::ThisEvent, true).map_err(err),
      None => Ok(()), // already gone
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  fn ev(start: f64, end: f64) -> EkSave {
    EkSave { ext: None, occ: None, calendar: "c".into(), title: "t".into(), start, end, all_day: false, location: None, notes: None, url: None, rule: None }
  }
  #[test]
  fn checks_what_it_is_asked_to_save() {
    assert!(check(&ev(1.7e12, 1.7e12 + 3.6e6)).is_ok());
    assert!(check(&ev(1.7e12, 1.6e12)).is_err()); // ends before it starts
    assert!(check(&ev(f64::INFINITY, 1.7e12)).is_err());
    assert!(check(&ev(1e16, 1e16)).is_err());
    let mut r = ev(1.7e12, 1.7e12 + 1.0);
    r.rule = Some(EkRule { freq: "weekly".into(), interval: 0, by_day: vec![9], until: None });
    assert!(check(&r).is_err());
    r.rule = Some(EkRule { freq: "weekly".into(), interval: 2, by_day: vec![1, 9], until: Some(1.8e12) });
    assert!(check(&r).is_ok());
    let mut big = ev(1.7e12, 1.7e12);
    big.title = "x".repeat(20_000);
    assert!(check(&big).is_err());
  }
}
