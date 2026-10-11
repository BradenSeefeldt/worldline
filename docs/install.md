# Installing Worldline

Worldline runs as a Mac app (macOS 11 Big Sur or later, Apple silicon and Intel) and on the iPhone as a web app
(iOS 16.4 or later). Both keep their data on the device, and they can be [synced](sync.md) with each other.

## The Mac app

**Download it:** the latest `Worldline.dmg` is always at
https://github.com/BradenSeefeldt/worldline/releases/latest/download/Worldline.dmg (older versions are on the
[Releases](https://github.com/BradenSeefeldt/worldline/releases) page).

**Install:** open the `.dmg`, drag **Worldline** onto **Applications**, open it from Applications or Spotlight, and
keep it in the Dock (right-click its Dock icon → *Options → Keep in Dock*). Closing the window keeps it running in the
background (so your scheduling links stay live); click the Dock icon to bring it back, ⌘Q to quit.

**Open Anyway (once):** the app isn't signed with a paid Apple Developer ID, so the first time a *downloaded* copy is
opened macOS refuses ("Apple could not verify…"). Once: **System Settings → Privacy & Security**, scroll down,
**Open Anyway**. (A copy you built yourself on this Mac, or one installed from Terminal as below, opens normally.)

**Where your data lives:** one SQLite database file, `worldline.db`, in
`~/Library/Application Support/io.github.bradenseefeldt.worldline/` (⚙ Settings → Data → **Show in Finder**). SQLite is
a small, reliable database kept in a single file — no server; the app reads and writes it directly, and each change is
saved atomically (all or nothing), so a crash can't leave it half-written. A snapshot of each of the last 14 days is
kept inside it as a safety net. A new install starts empty.

**Build it yourself** (needs [Node.js](https://nodejs.org) 22+ and [Rust](https://rustup.rs), and Apple's command-line
tools: `xcode-select --install`):

```bash
cd web
npm install
npm run app:package
```

That builds the app and makes `web/release/Worldline-<version>.dmg` (the app itself is in
`web/src-tauri/target/release/bundle/macos/`). `npm run app` runs it in development mode (live reload).

## Install from Terminal

```bash
curl -fsSL https://bradenseefeldt.github.io/worldline/install.sh | sh
```

This downloads the latest release, copies Worldline into `/Applications` and opens it. Files downloaded by Terminal
aren't flagged by macOS, so there's no "Open Anyway" step. The script is
[`web/scripts/install.sh`](../web/scripts/install.sh) in this repo — read it first if you like.

## Uninstalling

**⚙ Settings → Data & Backups → Uninstall Worldline…** Worldline quits, then the app and everything it stored go to
one folder in the Trash, `Worldline (removed <date>)` — recoverable until you empty the Trash. Open scheduling links
close first (guests see "closed"), and the login item is removed. Backups and exports you saved yourself are left alone.

If you already deleted the app by dragging it to the Trash, these are the leftovers to remove (all named after the
app's id, `io.github.bradenseefeldt.worldline`): in `~/Library/` — `Application Support/…` (your data), `Caches/…`,
`WebKit/…`, `Preferences/….plist`, and `LaunchAgents/Worldline.plist` if you turned on Open at login.

## On your iPhone (free, works offline)

Needs iOS 16.4 or later. Open **https://bradenseefeldt.github.io/worldline/app/** in Safari → Share → **Add to Home
Screen**. It opens like an app, works with no internet (the whole app is kept on the phone), and keeps its data on the
phone. Then [pair it with your Mac](sync.md) so both have the same calendar. No App Store, no Apple account, nothing
to pay.

On the phone the top bar shows where you are: ☰ (the sidebar — or drag it out from the left edge of the screen), the
month (tap it to open the whole month), the view, and today; under it, the week (swipe it sideways; tap a day to go
there). The tabs at the bottom go to Calendar, Habits, Projects and Settings, and the big **+** in the bottom-right
corner adds an event, task or deadline.

What it can't do that the Mac app does: read calendar subscriptions itself (a browser can't read other sites'
feeds — your Mac does, and sync brings the events), answer scheduling links (your Mac does), or show notifications.
