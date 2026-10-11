# Syncing your Mac and iPhone

**⚙ Settings → Sync → Turn on sync** on the Mac; it shows a QR code. On the iPhone: Settings → Sync → **Join…** →
scan it (or paste the code — copy it on the Mac; with the same Apple ID it's on the iPhone's clipboard). Joining
replaces the iPhone's own data with your synced calendar.

- **Every device keeps a full copy** and works offline; changes merge when they reach each other. Two devices
  editing different things always merge, and so do different fields of one item (a title on the phone, a time on the
  Mac); the same field edited on both keeps the later edit.
- **End-to-end encrypted**, through the same public Nostr relays as [scheduling links](scheduling-links.md) (kept
  current weekly). Relays see random-looking tags and ciphertext. The pairing code is the key — share it only with
  your own devices.
- Changes go out a moment after you stop typing (kept by relays for 30 days); each device also republishes a snapshot
  of everything (after starting, and every 6 hours if anything changed), so a device that was off for months catches
  up. Undo never takes back what another device did.
- What syncs: calendars, events, tasks, habits and their history, projects, scheduling links, your name and home
  zone, and the settings about you (week start, time format, defaults). Each device keeps its own theme, view and
  window settings.
- Code: [`web/src/lib/sync/`](../web/src/lib/sync/) (the document model, the wire format) and
  [`web/src/data/syncEngine.ts`](../web/src/data/syncEngine.ts); tests run the engine end to end against a simulated
  second device.

## How sync stays correct

- **Catching up.** After a restart a device asks the relays only for what's new since it last caught up, less a day
  in case device clocks disagree. It does a full catch-up when it joins, after 25 days away, once a week, and when
  something arrives that depends on an update it never saw.
- **Sending before it stops.** Changes are sent at once when the app goes to the background, because an iPhone stops
  running a hidden app within seconds. It reconnects when it comes back.
- **Saving in the right order.** The sync copy on a device is only saved once the app's own data is saved at least as
  far. So a crash can't make another device's changes look like deletions.
- **Newer versions.** A device that sees data or messages from a newer Worldline pauses syncing and says to update. It
  doesn't write old-format records over new ones.
- **Older devices.** Macs and iPhones without the browser's built-in compression use a small library (fflate) that
  produces the same format.

## What the relays can learn

- Random-looking tags and ciphertext.
- Each device's random public key.
- When each device sends something, and roughly how big it is.
- Like any internet service, the IP address each device connects from.

So a relay operator could tell that two IP addresses belong to the same sync group, and when you use it. Not what's in
it.

## Known limits

- A note edited on two devices while both are offline keeps the later edit of the whole note.
- The iPhone version syncs only while it's open.
- Relays keep updates for 30 days. Snapshots, republished every 6 hours by running devices, cover longer gaps.
