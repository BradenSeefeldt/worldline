# Development

Needs [Node.js](https://nodejs.org) 22+. Building the Mac app also needs [Rust](https://rustup.rs) and Apple's
command-line tools (`xcode-select --install`); see [Build it yourself](install.md#the-mac-app).

## Run it in a browser (development)

```bash
cd web
npm run dev
```

Open http://localhost:5173. In a browser the data is kept in the browser's storage instead of the database.
`npm run app` runs the Mac app in development mode (live reload).

## Layout

```
web/                 the front end (React + TypeScript, built with Vite)
  src/data/          store.ts (app state + actions), types.ts, mock.ts (sample data for development and the tests)
  src/lib/           dates.ts (day-index maths), layout.ts (overlap/lane layout),
                     quickparse.ts (sentence → event); *.test.ts are the unit tests
  src/views/         TimeGrid.tsx (day/3-day/week), MonthView.tsx
  src/components/    Toolbar, Sidebar, EventPanel, QuickAdd, Toast
  src/guest/         the page people open from a scheduling link (book.html → GitHub Pages)
```

Each feature's doc names its own logic and test files.

## Tests, type-check, build

All from `web/`:

```bash
npm test             # unit tests (CI runs them in six time zones: TZ=Asia/Tokyo npm test, …)
npm run typecheck    # type-check
npm run build        # production build
```

## Releasing a version

Bump `version` in [`web/package.json`](../web/package.json), [`web/src-tauri/tauri.conf.json`](../web/src-tauri/tauri.conf.json)
and `web/src-tauri/Cargo.toml`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. GitHub builds the universal
app (Apple Silicon + Intel) and attaches 4 assets to a draft release: `Worldline.dmg`,
`Worldline_universal.app.tar.gz` + `.sig` (the signed update), and `latest.json`. Review the draft and press
**Publish** to ship — installed apps pick the update up within a day.

## Automatic updates

The app checks the newest published release a minute after launch and then daily, downloads a newer version in the
background, and shows **Update ready · Restart** in the sidebar (Settings → About to check now or turn it off).
Updates are signed: the private key is in `~/.tauri/worldline.key` (password beside it) on the maintainer's Mac and in
the repo's `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` secrets; the app only accepts updates signed with it (public key
in `tauri.conf.json`). **Keep a copy of that key** — without it, installed apps can't be updated (they'd need a manual
reinstall).

## Roadmap

1. ~~Calendar UI~~ · ~~to-dos, habits, projects~~ · ~~Mac app with local storage, calendar subscriptions~~
2. Your own accounts' calendars, two-way (Google, iCloud, an Exchange account) through macOS's calendar access (EventKit)
3. ~~iPhone version, and syncing between devices (local-first, end-to-end encrypted, no paid server)~~
4. Voice capture → AI-parsed events/to-dos (local model on the laptop)
