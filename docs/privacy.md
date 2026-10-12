# Privacy

## Where your data lives

- **Mac:** one SQLite database file, `worldline.db`, in
  `~/Library/Application Support/io.github.bradenseefeldt.worldline/`, with a snapshot of each of the last 14 days
  kept inside it.
- **iPhone (and any browser):** the browser's own storage (IndexedDB). The app asks the browser to keep it persistent,
  so it isn't cleared to save space.

Nothing is kept on any server of this project's. There are no accounts and no analytics.

## What other people's computers see

Sync and scheduling links travel through public Nostr relays, end-to-end encrypted. What a relay can and can't learn
is spelled out in [Syncing: What the relays can learn](sync.md#what-the-relays-can-learn) and
[Scheduling links: How links work between people](scheduling-links.md#how-links-work-between-people).

## How the app protects itself

- The Mac app's web view runs under a strict Content-Security-Policy: it runs only its own code, and its only network
  connections are to the relays and the relay list.
- Backups and exports are written by the native side of the app, to the file you pick in the Save panel. The page
  can't write files on its own.
- Updates are signed, and the app refuses unsigned ones (see [Automatic updates](development.md#automatic-updates)).
- The web version runs in one tab at a time, so two tabs can't save over each other.

## Calendars on this Mac

If you connect them (Settings → Calendars), Worldline reads and writes the Mac's calendars through macOS's own
calendar access, on the Mac. Nothing goes to any server of Worldline's; the events reach your other devices only
through Worldline's end-to-end-encrypted sync, like everything else.

