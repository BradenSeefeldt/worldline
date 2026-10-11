# Scheduling links (book a time / find a time together)

Sidebar → **Scheduling** → **+ Booking link** or **+ Group poll**. In the editor you set the event name,
**drag across a two-month calendar to pick the days offered** — a new link starts with none — (or “Next 5 weekdays” /
“Next 2 weeks”),
the hours, length (default 1 h), a location and a note, which calendars count as busy, and where the
meeting goes; **Copy link** to share it. Your name comes from **⚙ Settings**. Links work for anyone, on any
phone or computer: the address opens a page on this project's GitHub Pages, and bookings come back to your Worldline
on their own (see [How links work between people](#how-links-work-between-people) below). Links are answered by the
Mac app.

- **Booking link** (like Calendly): the guest sees open times in their own time zone, picks one and
  clicks **Confirm** — a name is optional, no email, no account. The time is held for them at once (nobody else can
  take it), and your Worldline adds the meeting as soon as it's running (a toast says who booked); their page then
  says **Confirmed**. Two people clicking the same time: the earlier one gets it, the other is told right away. Defaults: no buffer, bookable any time, **single use** — after one booking
  the link closes itself (switch it off for a reusable link like office hours).
- **Group poll** (like when2meet): people enter a name and paint when they're free (one answer per name; they can
  come back and change it). Answers arrive in your results window by themselves.
  Each day is one continuous column like the week view; every half-hour row is labelled beside its box
  ("9 AM", "9:30"), with solid lines on the hour. Your busy time is one dark hatched **Unavailable**
  block per stretch. The guest's picks are solid green with a ✓; other people's answers are a faint
  green tint. Hovering highlights the row, its time and its day, and a tooltip at the pointer gives the
  exact slot and who's free. The page header just says "Times in EDT" (the guest's own zone).
  Your results window: a heat map with the count in each slot (★ = everyone) and a panel beside it with
  everyone's names in **Available** / **Unavailable** columns. It starts on the best time (outlined on the grid); as
  you move over the grid, the outline covers the whole meeting starting there (two rows for 1 h) and the names
  move to the right column (red if you're busy for part of it). Click a time to pick it, then **Schedule**.
- **After:** a booked or scheduled link shows the meeting time as a green line under it in the sidebar
  (“✓ Mon Oct 12 · 2 – 3 PM”; click it to jump to the meeting) and stays in the list until the meeting has
  happened. Reusable links list their next three bookings. Opening a used-up link shows the guest the time
  they booked. Then links move to a folded **Finished** group; **Clear finished**
  removes them. Deleting a link also removes its upcoming meetings from your calendar (past ones stay); anyone who booked sees on
  the link's page that their meeting was cancelled. Deleting a single booked meeting tells that guest the same.
- **Privacy:** guests only ever receive `publicView` (open times + what you chose to share). Tested.
- The link editor shows whether it's live (“Live · on 6 of 7 relays · updated just now”). **New address** replaces a
  link that was shared more widely than you meant: the old address shows “closed”; booked meetings stay.

## How links work between people

No server of mine, no accounts. Messages go through **Nostr relays** — public message boards run independently by
different people, where anyone can post a signed message without signing up. Worldline uses seven of them and
sends everything to all of them; any one that keeps a message is enough.

**The relay list keeps itself current.** It's a file, [`web/public/relays.json`](../web/public/relays.json), served
beside the guest page. Every Monday a GitHub Action ([`.github/workflows/relays.yml`](../.github/workflows/relays.yml))
tests each relay in use and each candidate: post a message,
read it back, and check it still keeps messages over 180 days old. A relay that fails three tries 20 minutes apart is
swapped for the fastest working candidate in a **pull request**; merge it and that's all. The guest page uses the
new list within minutes; running apps check the list every 6 hours and move over by themselves (no new release).
A removed relay is *retired*, not forgotten: the guest page keeps using retired relays for a year, so an app still on
the old list (offline, or an older version) keeps reaching guests. If the list can't fix itself (no working
candidates left), the Action opens an issue instead. Run it by hand from the Actions tab, or locally:
`node scripts/check-relays.ts` (from `web/`). Logic and tests: [`web/src/lib/relaylist.ts`](../web/src/lib/relaylist.ts),
`relaylist.test.ts`.

- **The address** is `https://bradenseefeldt.github.io/worldline/#…`. The page there is code only. Everything after
  `#` — the link's public key and a 32-byte secret — stays in the guest's browser: browsers never send it to the
  server, and the page sends it nowhere.
- **Your free/busy** (`publicView`, nothing else) is published by Worldline as one message signed with the link's own
  key and encrypted (NIP-44: ChaCha20 + HMAC) with a key derived from the secret. It's republished whenever your
  calendar changes and every 3 hours while Worldline runs, so guests see current times.
- **A booking or poll answer** is a message signed by a throwaway key made in the guest's browser, encrypted with the
  link's key. That's what lets other guests see a time is held. A booking's name is sealed a second time, to your
  link key only, so other guests see *that* a time is taken, not by whom. Worldline answers each request
  (confirmed / taken / you're busy then) in its next published free/busy, which is how the guest's page knows.
- **What relays see:** random-looking keys and tags, ciphertext, timestamps. Not who you are, not who booked, not
  when. Each link has its own keys, so your links can't be tied to each other.
- **Forgeries:** only your app can change a link's availability (it's signed); only someone with the link can book
  (anything else fails to decrypt); a request for a time the link never offered is refused; each request is answered
  once (restarting can't book it twice).

## Where it can fail, and what happens

| If… | Then |
|---|---|
| A relay is down, refuses, or goes away for good | The others carry it. Every message goes to all seven; reads ask all seven and merge. The weekly check replaces it (pull request); links hold no relay addresses, so old links keep working. |
| A relay deletes old messages | Worldline re-sends your availability every 3 h while it runs; a guest's page re-sends that guest's own booking each time they open it. All seven would have to drop the same booking before your Worldline next runs for it to be lost. |
| Worldline is closed for days or weeks | Bookings wait on the relays and are collected the next time it opens (a meeting already past is still added, “while you were away”). Guests see the last published times, with “Times last updated 5 days ago” after a day; held times stay held for other guests in the meantime. On the Mac, closing the window keeps Worldline running (⌘Q quits), so this mostly doesn't arise. |
| You became busy at a held time before Worldline saw the booking (a subscribed calendar changed) | Worldline refuses it and tells you (toast); the guest's page says the time is no longer free and offers others. Their only way to hear is that page — there's no email, by design. |
| Two guests click the same time | Earliest request wins (ties: smaller message id), the same rule on every page and in Worldline. The second sees “someone else booked it first” within seconds. |
| A clock is wrong | Times are absolute instants, so time zones and the guest's clock don't affect what's shown. Worldline's published versions always count up even if this Mac's clock was set back. A guest whose clock runs fast is treated as asking now (can't dodge “not sooner than 4 h”). |
| A guest has an old link | Deleted or replaced: the page says “This link is closed”. Mangled (cut short when pasted): the page says the address is incomplete instead of guessing. |
| Someone who has the link misbehaves | Like any Calendly link, they can book; a flood of fake holds would block times until you look. Delete the link or give it a **New address**. People who don't have the link can do nothing. |

Logic and tests: [`web/src/lib/schedwire.ts`](../web/src/lib/schedwire.ts) (keys, address, encryption, who gets a
slot — `schedwire.test.ts`), [`web/src/data/schedSync.ts`](../web/src/data/schedSync.ts) (Worldline's side),
[`web/src/guest/`](../web/src/guest/) (the guest page), and `schedSync.test.ts`, which runs
your app and several guests end to end over in-memory relays (one of them down): a booking race, the app closed while
someone books, poll answers, a deleted link. The guest page is built with `npm run build:guest` and deployed by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push.
