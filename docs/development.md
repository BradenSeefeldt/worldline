# Development

Needs [Node.js](https://nodejs.org) 22+ (CI uses 24). Building the Mac app also needs [Rust](https://rustup.rs) and
Apple's command-line tools (`xcode-select --install`); see [Build it yourself](install.md#the-mac-app).

## Run it in a browser (development)

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173 (`--host` also shows it to a phone on the same Wi-Fi). In a browser the data is kept in the
browser's storage (IndexedDB) instead of the database, and a development copy starts with demo data (an example
researcher's week, `src/data/mock.ts`); Settings → Data & Backups → **Load the demo data** brings it back. The guest
page for scheduling links is at http://localhost:5173/book.html. A browser can't read other sites' calendar links, so
the dev server fetches them for the page (`/__fetch`, answered only for this Mac itself).

`npm run app` runs the Mac app in development mode (live reload).

**Development stays off the network.** In development, sync and scheduling links don't touch the public relays (a dev
copy full of demo data must never reach a real sync group or a real guest) — unless the browser's localStorage has
`wl-dev-network` set to `1`: `localStorage.setItem('wl-dev-network', '1')` in the console, then reload. (One
exception: the Mac app in development, `npm run app`, keeps sync off the same way but does answer scheduling links.)

## Layout

```
web/                     the app (React + TypeScript, built with Vite)
  index.html             the app's page (the saved theme is painted before the first frame)
  book.html              the GitHub Pages site: the landing page, or the guest page when the address has a link
  src/main.tsx, App.tsx  start-up (load, one tab at a time, sync, reminders, Mac calendars); the app's frame and keys
  src/styles.css         all the styles, and every theme's colours
  src/data/              the app's state and what runs in the background:
                           store.ts (state + actions), types.ts, settings.ts, persist.ts (saving and loading),
                           storeVersion.ts, syncEngine.ts (sync), schedSync.ts (scheduling links), alerts.ts
                           (reminders), macCalendars.ts (calendars on this Mac), useEvents.ts, mock.ts (demo data)
  src/lib/               pure logic, each with its *.test.ts: dates, layout, slots, zone, zoneSearch, recurrence,
                           mutate, quickparse, commands, typeahead, suggest, tasks, deadlines, habits, habitlog,
                           projects, alerts, macCalendars, ics, icsExport, backup, booking, schedwire, relays,
                           relaylist, reorder, theme, updates, platform (Mac app vs browser), a11y, format, prefs
  src/lib/sync/          sync's pure parts: model.ts (the shared Yjs document), wire.ts (what goes over the relays),
                           rebase.ts (undo after another device's changes), status.ts
  src/views/             TimeGrid.tsx (day / 3-day / week), MonthView.tsx
  src/components/        everything else on screen: Toolbar, Sidebar, PhoneBars (the iPhone layout), QuickAdd,
                           EventPanel, TaskPanel, TasksSection, BlockDrag, CalendarEditor, Habits, Projects,
                           ProjectsBar, ProjectEditor, CodeBlock, Scheduling, DayPicker, Settings, SyncSettings,
                           TimeZonePicker, ZonePill, Recovery, CrashScreen, Confirm, Toast, Icons
  src/pages/GuestPage.tsx  what a guest sees (also reused for your poll results)
  src/guest/             the GitHub Pages site's code: entry.ts (landing page or guest page), landing.ts + .css,
                           guest.tsx + RemoteGuest.tsx (the guest page, talking to the relays), linkHash.ts
  public/                icons, the web app's manifest, relays.json (the relay list)
  scripts/               install.sh (the Terminal installer), make-dmg.sh (npm run app:package), check-relays.ts
                           (the weekly relay check), tune-themes.py (theme contrast)
  src-tauri/             the Mac app's native side (Rust, Tauri 2):
    src/lib.rs             the window and menu, saving before quitting, reminders, reading calendar links (public
                           addresses only), showing a folder in Finder, the Save panel, uninstall, updates
    src/db.rs              the database (worldline.db): the few fixed operations the page may use
    src/eventkit.rs        the bridge to the Mac's calendars (EventKit)
    tauri.conf.json, Cargo.toml, capabilities/, Info.plist (the words macOS shows when asking for calendar access)
  vite.config.ts         the app (development, and the Mac app's build)
  vite.web.config.ts     the iPhone web app (dist-web/, served at /app/, with its offline service worker)
  vite.guest.config.ts   the GitHub Pages site (dist-guest/: landing + guest page, install.sh); vite.landing.ts
  prototype/             design prototypes (not built)
```

Each feature's doc names its own logic and test files.

## Tests, type-check, build

All from `web/`:

```bash
npm test             # unit tests (vitest)
npm run test:perf    # performance with ten years of data (src/perf; ~3 min, prints a table; skipped by npm test)
npm run typecheck    # type-check
npm run build        # type-check + the app's production build (dist/, what the Mac app shows)
npm run build:web    # the iPhone web app (dist-web/); npm run preview:web serves it on :4174
npm run build:guest  # the landing + guest page (dist-guest/); npm run preview:site serves it on :4175
npm run app:build    # the Mac app (src-tauri/target/release/bundle/macos/)
npm run app:package  # the Mac app and a disk image, release/Worldline-<version>.dmg
cargo test --lib --manifest-path src-tauri/Cargo.toml   # the native side's tests
```

The tests must pass in every time zone: CI runs the whole suite six times, with `TZ=` America/Toronto, UTC,
Asia/Tokyo, Pacific/Auckland, America/Los_Angeles and Australia/Lord_Howe (e.g. `TZ=Australia/Lord_Howe npm test`).

**CI** (`.github/workflows/`): `pages.yml` runs the tests in those six zones and deploys the site (landing + guest
page, `install.sh`, and the iPhone app at `/app/`) on every push to `main` that touches `web/`; `release.yml` builds a
release (below); `relays.yml` is the weekly relay check ([Scheduling links](scheduling-links.md#how-links-work-between-people)).
`node scripts/check-relays.ts` runs the check locally (Node runs the `.ts` file directly: Node 22.18 or later).

## Releasing a version

1. Bump `version` in [`web/package.json`](../web/package.json), [`web/src-tauri/tauri.conf.json`](../web/src-tauri/tauri.conf.json)
   and [`web/src-tauri/Cargo.toml`](../web/src-tauri/Cargo.toml).
2. Update the lock files: `npm install --package-lock-only` (in `web/`) and `cargo update -p worldline --offline`
   (in `web/src-tauri/`).
3. Commit, then tag and push both: `git tag vX.Y.Z && git push origin main vX.Y.Z`.
4. [`release.yml`](../.github/workflows/release.yml) runs the tests (six time zones, and the Rust tests), builds the
   universal app (Apple silicon + Intel) and attaches 4 assets to a **draft** release: `Worldline.dmg`,
   `Worldline_universal.app.tar.gz` + `.sig` (the signed update), and `latest.json`.
5. Review the draft and press **Publish** to ship — installed apps pick the update up within a day.

## Automatic updates

The Mac app checks the newest published release a minute after launch and then daily, downloads a newer version in
the background, and shows **↻ Update to … · Restart** in the sidebar (Settings → About to check now, or to turn
automatic checks off). The iPhone version compares itself with the site's `version.json` when it opens, when you come
back to it, and daily, and shows **Update to … · Reload**.
Mac updates are signed: the private key is in `~/.tauri/worldline.key` (password beside it) on the maintainer's Mac
and in the repo's `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` secrets; the app only accepts updates signed with it
(public key in `tauri.conf.json`). **Keep a copy of that key** — without it, installed apps can't be updated (they'd
need a manual reinstall).

## Roadmap

1. ~~Calendar UI~~ · ~~to-dos, habits, projects~~ · ~~Mac app with local storage, calendar subscriptions~~
2. ~~Your own accounts' calendars, two-way (Google, iCloud, an Exchange account) through macOS's calendar access (EventKit)~~
3. ~~iPhone version, and syncing between devices (local-first, end-to-end encrypted, no paid server)~~
4. Voice capture → AI-parsed events/to-dos (local model on the laptop)
