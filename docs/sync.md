# Syncing your Mac and iPhone

**⚙ Settings → Sync → Turn on sync** on the Mac; it shows a QR code. On the iPhone: Settings → Sync → **Join…** →
scan it (or paste the code — copy it on the Mac; with the same Apple ID it's on the iPhone's clipboard). Joining
replaces the iPhone's own data with your synced calendar. If the join is cut short (no network, or the app closed
first), it carries on at the next launch; the iPhone's own data never goes out.

- **Every device keeps a full copy** and works offline; changes merge when they reach each other. Two devices
  editing different things always merge, and so do different fields of one item (a title on the phone, a time on the
  Mac). The same field changed on both before either has seen the other's change: both end up with the same one of
  the two, but it's picked by the editing sessions' random ids (how Yjs settles it), not by which edit was later.
  Deleting an item beats a change made to it elsewhere at the same time.
- **End-to-end encrypted**, through the same public Nostr relays as [scheduling links](scheduling-links.md) (kept
  current weekly). Relays see random-looking tags and ciphertext. The pairing code is the key — share it only with
  your own devices.
- Changes go out a moment after you stop typing (kept by relays for 30 days); each device also republishes a snapshot
  of everything (after starting, and every 6 hours if anything changed — at least once a week anyway), so a device that was off for months catches
  up. Undo never takes back what another device did.
- What syncs: calendars, events, tasks, habits and their history, projects, scheduling links, your name and home
  zone, and the settings about you (week start, time format, defaults, reminder times). Calendars on your Mac sync
  too: the iPhone sees and changes them, and the Mac that connected them carries the changes to the Calendar app. Each device keeps its own theme, view and
  window settings.
- Code: [`web/src/lib/sync/`](../web/src/lib/sync/) (the document model, the wire format) and
  [`web/src/data/syncEngine.ts`](../web/src/data/syncEngine.ts); tests run the engine end to end against a simulated
  second device.

## How sync stays correct

- **Writing only what changed.** A device writes into the shared document only the fields it changed itself, so a
  change made just as another device's change arrives can't write an older copy back over it, or bring back
  something deleted elsewhere.
- **Replacing your data.** Restoring a snapshot or backup, starting over, or erasing everything stops sync on that
  device; it then joins again and takes your synced data back from the other devices, which keep theirs. A
  replacement is never sent out as deletions or edits to everyone. (To restore onto one device only, turn sync off
  first.)
- **Catching up.** After a restart a device asks the relays only for what's new since it last caught up, less a day
  in case device clocks disagree. It does a full catch-up when it joins, after 25 days away, once a week, and when
  something arrives that depends on an update it never saw.
- **Sending before it stops.** Changes are sent at once when the app goes to the background, because an iPhone stops
  running a hidden app within seconds. It reconnects when it comes back. Changes that didn't get out (offline, then
  closed) are remembered and go out at the next launch.
- **Big changes.** A big change (an import) goes out in pieces that fit the relays' size limit. A message the relays
  refuse is tried again on its own (waiting longer each time, up to 15 minutes); later changes go out separately. One
  the relays keep refusing is given up on after six tries, and what it carried goes out in a snapshot instead.
- **Order.** Only the order of the Projects board's columns is shared, as a place written when a column is added or
  moved. Nothing else stores a position, so deleting things doesn't grow the shared document.
- **Saving in the right order.** The sync copy on a device is only saved once the app's own data is saved at least as
  far. So a crash can't make another device's changes look like deletions. It's saved as small additions to a log,
  and written whole again only when the log passes 1 MB, so years of data don't make every edit slow.
- **Joining.** While a device is joining, nothing it does goes into the shared data: its own data is about to be
  replaced by the group's.
- **Newer versions.** A device that sees data or messages from a newer Worldline pauses syncing and says to update. It
  doesn't write old-format records over new ones.
- **Development.** A development build doesn't resume sync at launch unless the browser's localStorage has
  `wl-dev-network` set to `1`, so demo data can't reach a real sync group.
- **Older devices.** Macs and iPhones without the browser's built-in compression use a small library (fflate) that
  produces the same format.

## What the relays can learn

- Random-looking tags and ciphertext.
- Each device's random public key.
- When each device sends something, and roughly how big it is (a snapshot's number of pieces shows its size, in
  24 KB steps).
- That messages belong together: the group's tag stays the same for as long as the group exists.
- Like any internet service, the IP address each device connects from.

So a relay operator could tell that two IP addresses belong to the same sync group, when you use it, and roughly how
much data you have. Not what's in it. The pairing code is the group's key for good: to change it, turn sync off on
every device and start a new group.

## Known limits

- A note edited on two devices while both are offline keeps one of the two edits of the whole note (not
  necessarily the later one).
- The iPhone version syncs only while it's open.
- Relays keep updates for 30 days. Snapshots, republished every 6 hours by running devices, cover longer gaps. A
  device that rejoined or was reinstalled leaves its old snapshot on the relays until they drop it; others still
  download it on a full catch-up (harmless, just extra data).
- Unpacked, one message may hold at most 64 MB and a snapshot at most 2,000 pieces (about 48 MB compressed — many
  decades of data). Ten years of heavy use measured about 4 MB compressed.
