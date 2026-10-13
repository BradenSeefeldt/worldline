# Privacy

## Where your data lives

- **Mac:** one SQLite database file, `worldline.db`, in
  `~/Library/Application Support/io.github.bradenseefeldt.worldline/`, with a compressed snapshot of each of the last 14 days
  kept inside it.
- **iPhone (and any browser):** the browser's own storage (IndexedDB). The app asks the browser to keep it persistent,
  so it isn't cleared to save space. A browser keeps storage per site, and the iPhone app's site
  (`worldline-calendar.github.io`) is also where the landing page and the guest page live — the same project's code — and
  would be shared by any other GitHub Pages site on that account. There are none, and none will be added; that's what
  keeps the sync key on your iPhone to Worldline alone.

Nothing is kept on any server of this project's. There are no accounts and no analytics.

## What other people's computers see

Sync and scheduling links travel through public Nostr relays, end-to-end encrypted. What a relay can and can't learn
is spelled out in [Syncing: What the relays can learn](sync.md#what-the-relays-can-learn) and
[Scheduling links: How links work between people](scheduling-links.md#how-links-work-between-people).

## How the app protects itself

- The Mac app's page (its web view) runs under a strict Content-Security-Policy: only its own code runs, nothing is
  ever turned from data into code, and the page itself connects only to the relays and the relay list.
- What the page may ask the Mac to do is kept narrow, so even a mistake that let foreign script run couldn't do much:
  calendar links are read by the native side, which refuses this Mac and the local network (only public addresses);
  backups and exports are written by the native side to the file you pick in the Save panel; uninstalling needs a
  "yes" in the Mac's own dialog; the database is reached through a few fixed operations on Worldline's own file
  (read, write or remove a value; list or read a daily snapshot) — the page can't run database commands of its own or
  open any other file; a pinned folder opens in Finder, and a pinned file is only shown there, never opened or run.
- Updates are signed, and the app refuses unsigned ones (see [Automatic updates](development.md#automatic-updates)).
- The web version runs in one tab at a time, so two tabs can't save over each other. The iPhone web app has its own
  Content-Security-Policy: it loads only its own files and connects only to its own site and the relays.
- In development, sync and scheduling links stay off the public relays unless you ask for them
  ([Development](development.md#run-it-in-a-browser-development)).

## Calendars on this Mac

If you connect them (Settings → Calendars), Worldline reads and writes the Mac's calendars through macOS's own
calendar access, on the Mac (macOS asks you first, once). Nothing goes to any server of Worldline's; the events reach your other devices only
through Worldline's end-to-end-encrypted sync, like everything else.

