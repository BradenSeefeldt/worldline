# Worldline

A calendar, habits and research-projects app for the Mac. Everything is stored on your computer; it can subscribe
to any calendar link (a department's, a team's, a Google calendar's iCal address). Free; no account, no server.

**Status:** a Mac app (Tauri) you can build and install; scheduling links work between anyone. iPhone app and syncing between devices: later.

## The Mac app

**Install** (from a built `.dmg`): open it, drag **Worldline** onto **Applications**, open it from Applications or
Spotlight, and keep it in the Dock (right-click its Dock icon → *Options → Keep in Dock*). Closing the window keeps
it running in the background (so your scheduling links stay live); click the Dock icon to bring it back, ⌘Q to quit.

The app isn't signed with a paid Apple Developer ID, so the first time a *downloaded* copy is opened macOS refuses
("Apple could not verify…"). Once: **System Settings → Privacy & Security**, scroll down, **Open Anyway**. (A copy
you built yourself on this Mac opens normally.)

**Where your data lives:** one SQLite database file, `worldline.db`, in
`~/Library/Application Support/io.github.bradenseefeldt.worldline/` (⚙ Settings → Data → **Show in Finder**). SQLite is a small,
reliable database kept in a single file — no server; the app reads and writes it directly, and each change is
saved atomically (all or nothing), so a crash can't leave it half-written. A snapshot of each of the last 14 days is
kept inside it as a safety net. A new install starts empty.

**Download it:** the latest `.dmg` is on the [Releases](../../releases) page.

**Build it yourself** (needs [Node.js](https://nodejs.org) 22+ and [Rust](https://rustup.rs), and Apple's command-line
tools: `xcode-select --install`):

```bash
cd web
npm install
npm run app:package
```

That builds the app and makes `web/release/Worldline-<version>.dmg` (the app itself is in
`web/src-tauri/target/release/bundle/macos/`). `npm run app` runs it in development mode (live reload).

### Subscribing to calendars

Sidebar → **Calendars → +** → **Subscribe to a link**, and paste the calendar's link: a department or seminar
calendar's "subscribe"/iCal link, a team's schedule (`webcal://…`), a Google calendar's *Secret address in iCal
format* (Google Calendar → the calendar's ⋮ → Settings and sharing → Integrate calendar), an Outlook "publish" link.
It's read-only here (its events change at their source), refreshed when the app opens and every 30 minutes
(⋯ → **Refresh now**), and named from the feed unless you name it. Repeating events, moved and cancelled
occurrences, and time zones (including Outlook's Windows zone names) are handled. **Import a file** copies an
`.ics` file in as a calendar of your own (editable): drop the file onto the big area, or click it to choose one.

## Run it in a browser (development)

```bash
cd web
npm run dev
```

Open http://localhost:5173. In a browser the data is kept in the browser's storage instead of the database.

## Using it

| Action | How |
|---|---|
| **Quick add** | **Add** button at the top, `⌘K` (works anywhere, even while typing in a box) or `N` (when you're not in a text box), then type/dictate: “lunch with Sam tomorrow 12:30 at Fran’s #social for 90 min” → Enter |
| Change view | The **Week ▾** menu between the ‹ › arrows (Day / 3 Day / Week / Month), or keys `D` `3` `W` `M` |
| Move through time | **‹ ›** either side of the view menu, **Today** at the right end of the toolbar; scroll/swipe sideways (day views) or up/down (month); `←` `→`; `T` = today |
| Zoom hours | Pinch on trackpad/phone, or `⌘`+scroll |
| New event by hand | Drag on empty time, or double-click a slot. It's a draft until you press **Enter** or **Add event** on its card; click anywhere else (or Esc / Discard) and it disappears. Keeping it is one ⌘Z step |
| Edit | Click an event — the card saves as you type. Click it again (or `Esc`) to close |
| Move / resize | Drag the event / drag its bottom edge (on touch: long-press first) |
| Delete | `Delete` key or the card’s button |
| Undo / redo | `⌘Z` / `⇧⌘Z`, or “Undo” on the pop-up (quick-add's pop-up also has “Edit”) |

Quick-add rules. Tested three ways in `web/src/lib/`: hand-written phrases
(`quickparse.test.ts`), a blind set written without seeing the code (`quickparse.blind.json`),
and a stress test that assembles ~12,700 phrases from parts in different orders and
dictation styles (`quickparse.combo.test.ts`).
- A date with no time → all-day; "oct 20-23" or "this weekend" → multi-day.
- A bare 1–7 ("at 7", "sat 7", "3-4") means PM unless it's morning/breakfast; 8–11 means AM.
- "morning" 9 AM · "afternoon" 2 PM · "evening" 6 PM · "tonight" 7 PM · "eod" 5 PM;
  breakfast/lunch/dinner with no time get 8:30 / 12 / 6:30.
- Ranges: "11-1", "2 to 4", "between 2 and 3", "10pm-2am". Spoken times: "three pm",
  "half past 3", "quarter to 5", "3 o'clock", "at 1530".
- `for 2h`, `for 90 min`, `for half an hour`, `1h30` set the length.
- Calendar: the ★ one in the sidebar by default; `#name` in the text, or press Tab / tap the
  calendar pill in the preview to switch.
- Place: "at/in <Capitalized place or room>", "@ anything", or at home/work/the gym/the office/the lab.
- Dictation is cleaned up: trailing period, "Schedule a…", "Remind me to…", "p.m.".
- Month names with no day number beside them (June, May, Jan…) are treated as names.
- No date at all → the next full hour (the preview says so).

Suggestions in the box (for the week ahead, or as you type) show what each would do, in three colours:
green = adds or completes (+ event, ☐+ task, ⚑ deadline, ✓ done), blue = changes the time (⇄ move,
→ push/shift, ↕ lengthen/shorten), red = removes (✕ skip/cancel/delete). The command preview badge uses the same colours.

### Changing events from the same box

| Say / type | Does |
|---|---|
| “skip plasma meeting this week”, “cancel Alex’s meeting” | delete it |
| “skip **all** lunch talks this week” | delete every upcoming match |
| “move Alex’s meeting to tues at 3pm”, “reschedule dentist to monday” | move it (date only keeps the time; time only keeps the day) |
| “push gym back 30 min”, “shift Suresh meeting by half hour early”, “delay telecon an hour” | shift it |
| “extend thesis writing by 30 min”, “shorten … by an hour” | change its length |

The event is found by forgiving name matching (possessives, plurals, typos); “tomorrow”, “this
week” or “the 3pm meeting” narrow it down. The preview shows exactly what will change; Tab steps
through other matches; Enter applies; ⌘Z undoes. If nothing matches, nothing happens
(⇧Enter adds the text as a new event instead). Tests: `web/src/lib/commands.test.ts`.

### Tasks

Small actions you tick off — deliberately simple: a title, an optional date, done or not.

- **One box decides:** the quick-add preview shows whether a sentence is an **Event**, **Task** or
  **Deadline**; Tab switches. No date or time → task (“email Jordan the plots”); an action plus a date →
  task due that day (“pay rent friday”); a time → event; “due …” → deadline. “todo:”, “- ” or “[] ” force a task.
- **Sidebar → Tasks:** “Add a task…” line; **Today** (overdue first, in red), **Upcoming**, **Anytime**;
  tick the circle → struck through, then it slides away (Undo in the pop-up); “✓ N done today” opens the
  finished ones. Click a task to edit it (title, date, which deadline it's a step of, done, delete).
- **Calendar:** dated tasks are light dashed ☐ items in the all-day row (tick them there); “on calendar”
  hides them.
- **Commands:** “done email Jordan”, “move pay rent to monday”, “drop buy coffee filters”.
- **Block out time:** drag a task (or a deadline) from the sidebar onto the hour grid. A floating card
  follows the pointer; over the grid it becomes a 1-hour block snapped to the quarter hour (the grid
  scrolls near its edges). Drop → a linked block (“Go grocery shopping”, or “Work on NSERC proposal”);
  one ⌘Z undoes it. Dropped anywhere else, the card
  glides back. A block's card shows what it's for (“☐ For task: … · Mark done”). Blocking time doesn't
  change the task: it stays in its list with a 🕑 chip (“🕑 Tomorrow 12 PM”, click to jump to the block),
  and on the block's day it also shows under Today.
- **Progress:** the Tasks card ends with “✓ 3 today · 9 this week” and a Mon–Sun mini bar chart.
  Things you just added or scheduled are never folded away behind “N later”.
- **Deadline checklists:** a deadline's card has a Checklist (“Add a step…”, dates allowed); progress shows
  as “✓ 1/4” in the sidebar and on its runway track.
- **Nudges:** a task overdue 3+ days gets one suggestion (“Move Call the bank to tomorrow” — or done / drop).
- **Reorder the sidebar:** drag a card by its title (Tasks, Deadlines, Habits, Scheduling, Calendars) to where you want
  it — the others slide out of the way; or focus a title and press Alt+↑ / Alt+↓. The mini month stays on top.
  Remembered. (`web/src/lib/reorder.ts`, `reorder.test.ts`.)
- Sidebar: Tasks, Deadlines, Calendars — each a card with a subtle cyan border, an icon, a count badge, a
  calendar switch, a fold chevron, and a fading divider under the title; the mini month stays pinned.
  The Deadlines flag and count take the most urgent deadline's colour (red if anything is overdue),
  so it alerts you even when folded.

### Habits

Small things you want to do regularly: “Gym 3× a week”, “Read 20 pages a day”, “Meditate every day”.

- **Sidebar → Habits:** the **strength bar** on top — overall strength (the average of every habit's), filled
  through the habits' colours; it grows as you keep them, with a quick shine once everything's done today. Then a row per habit with a bar that fills in its colour —
  segments for “3× a week” or this week's days, a smooth bar for amounts — and one button:
  a **checkbox** = “kept it today” (for an avoid habit it starts ticked; untick it if you slipped), or **+** for amount
  habits, which opens a small box: type how much (“12” pages), Enter adds exactly that.
- **Habits page:** the **Calendar | Habits** switch at the top left (or `H`). A card per habit: strength ring, streak,
  this week (tap a day: done → rest day → empty; amount habits pick the day and use − / + or type), and the last six
  months. **+ New habit** (or the sidebar's +) has one-tap starters; ⋯ edits (name, colour, goal, calendar word).
- **History (click a habit's name or “History →”)** — for tracking over years:
  - Strength now (vs a month ago), current and **best** streak, all-time total, **this year so far vs the same point last year**.
  - **Strength over time** across the habit's whole life (hover for any day).
  - **Totals per week / month / year** (days done, or pages / km / min).
  - **Every day**: a full Jan–Dec grid for every year, each with its total.
  - **By day of the week**: which days you do it most and least.
  - **Archive** a habit you've finished with: it leaves the sidebar and the main list, its history stays (Archived at
    the bottom of the Habits page).
- **Rest days** (sick, travelling): on daily habits, a rest day neither helps nor hurts — strength holds and streaks
  pass through it. (Weekly goals already leave room, so they don't have them.)
- **Strength, not just streaks:** an exponential moving average of how well you met the goal each day,
  s ← s + α(x − s) with a ~2-week memory (α = 1 − e^(−1/14)). One missed day costs at most ~7% (α), a dent that fades;
  two weeks off drain ~⅔ (e⁻¹ ≈ 0.37 left). A weekly goal is judged on the 7 days ending each day, so rest days on a
  3×/week habit aren't misses. Today/this week only counts once it's met.
- **Your calendar counts:** a habit can list a calendar word (Gym → “gym”). Events with that word that have happened
  tick a done/not-done habit (a lighter dot on the week strip), or — for an amount measured in min or hours
  (“Write 30 min a day” + “writing”) — add their **length**. What you log yourself for a day wins over the calendar.
- **Avoid habits** (“No phone in bed”, “At most 2 takeaways a week”): every day counts as clean until you tap that you
  slipped; strength, streaks and the history count clean days.
- **Notes and fixing old days:** on a habit's history, click any day (years back too) to change what happened or add
  a note; noted days get a dot, and the hover shows the note.
- **Export CSV** (⚙ Settings → Data): every habit, every recorded day — date, habit, amount, status (logged / calendar /
  rest), note.
- **Nudge:** from Wednesday, a weekly habit that's short (counting sessions already booked) gets one suggestion in the
  quick-add box at your usual time on the first free day: “Gym tomorrow at 7:30am · Gym: 1 of 3 this week · 2 to go”.
- **Log from quick add:** “did gym”, “gym done”, “meditated”, “read 20 pages”, “ran 5k yesterday”, “wrote for 45 min”.
  The preview says **Log habit**; Tab → Event → Task → Deadline. This reader is strict and separate from the event
  parser: it only claims a sentence when *every* word is accounted for (a log verb, one habit's name, one amount + unit,
  today / yesterday), never a bare name (“gym” stays an event title), and a command that finds something still wins.
  `habitlog.test.ts` runs ~4,000 sentences from the existing parser, command and stress tests through it and requires
  it to claim none of them — so quick add's existing behaviour can't change.
- ⌘Z undoes habit changes. Logic and tests: `web/src/lib/habits.ts`, `habits.test.ts`.

### Projects

Long-running work — "get the simulation running", "look into a collaborator's archival data", a student's project — not
milk and rubbish (that's Tasks). Third tab: **Calendar | Habits | Projects** (or `P`).

**Everything is writing.** Each thread (a months-long piece of work) and each project is a page you write in: its
main text (what it is, the plan, an outline, a paper draft) and dated **Notes** (meetings, results, decisions). A few
things you type are read back out of the text and gathered for you, so nothing needs keeping up to date by hand:

- `[]` then space: a to-do (checkbox). **Tab** puts a to-do under the one above: it *waits* on it (dashed box) and
  doesn't count as "next" until that one's ticked ("once Alex sends the data, then I can…").
- `@Name` in a to-do: it's on someone else. The thread shows **Waiting on Alex** (a thread is "waiting" when nothing
  is ready for you and someone owes you something), and it's listed under **Waiting on others**.
- A paragraph starting `Idea:`, `Decided:` or `Q:` is collected: ideas go to the project's Ideas, decisions and open
  questions to its page. Click a `Q:` (or **Settled**) once it's answered.
- **Equations**, as in LaTeX: `$\phi_{BH} < 40$` renders inline (KaTeX); a paragraph that is just `$$ … $$` becomes a
  displayed equation. Click one to edit it (live preview; Enter saves, Esc cancels, empty removes it). Dollar amounts
  ("$5 and $10") stay text: there's no space just inside a real equation's dollars.
- **Markdown as you type:** `# ` a title, `## ` a subtitle, `### ` a smaller heading; `- ` or `1. ` a list; `> ` a
  quote; `**bold**`, `*italic*`, `` `code` ``; `---` a rule. Links (paste or type a URL) become clickable.
- **Pasted markdown arrives formatted** (notes from Obsidian or VS Code, action items from an email): headings, lists,
  bold, equations, and checklists — `- [ ] …`, `[] …` and `[x] …` lines become to-dos, nested by indentation. Dollar
  amounts stay text there too.

**The board** (home): one column per project, each a softly tinted band with a big name, its one-line About, pinned
links, then what needs doing: **To do** (loose to-dos written on the project itself) and every active **thread** with
its next one or two to-dos — tick them right there; it ticks them where they were written — or who it's waiting on
("Reduced 2018 data @Alex · then 3 more"). Quiet threads (3 weeks untouched) fade and sink; waiting ones sink below
the busy ones. **Action items from a meeting** go straight in, with no deciding: **Add a to-do…** at the top of a column's **To do**
(Enter adds; the box stays ready for the next). Each lands in today's note on that project, so the meeting is still a
dated record. Filing one into a thread is optional and later: **drag it onto a thread's tile**, or hover it and use
**→** — the likeliest thread (most words shared with its title) is first, marked *likely*. It moves with anything
waiting under it into that thread's notes for today, and shows on the tile as its next step (a tile shows its newest
action items first, then its plan). One undo step either way; a project note left empty goes away.

Each list has its add-box at the top: **Add a thread…** above the threads, **Jot an idea…** above the **Ideas**
(open by default, the first five shown; Enter saves and the box stays ready for the next; **Start →** turns an idea
into a thread). **Done** threads fold away. Click anywhere on a tile to open it; click empty board space (or Esc) to
close the page and get back to the board. **Drag a column by its name** to reorder the board. **+ New project** and
archived projects at the end. The calendar's sidebar tucks away on this tab (more room for columns) and comes back
when you leave.

**One page at a time**: click a thread, a project's name or **Waiting on others** (in the toolbar) and its page opens in a wide pane
*beside* the board, which stays put (that project's column is outlined and scrolled into view). Links inside the pane
replace the page — they never stack — with **← →** (⌘[ ⌘]) like a browser, **Esc** to close, and **⤢** (⌘.) to go
full width for long writing.
- *Thread page:* title, **Active / Done**, "Waiting on …", the main text, and **Notes**: a roomy **Today** box (start
  typing and it becomes today's note) above earlier notes, newest first, each with a quiet date. A margin gathers
  to-dos from the notes, who you're waiting on and open questions. Move it to another project or delete it at the
  bottom.
- *Project page:* name, one-line About, **pins** (+ Pin a link or folder: web links open, folder paths are copied —
  a browser can't open folders), a catch-up (**waiting on others** with what each unblocks, **still to settle**,
  **decided**), its **Overview** (plan, outline, loose to-dos), and its own **Notes** (e.g. a meeting with a
  supervisor or student, written as a note starting "**Meeting with Alex.**"). Colour, archive, delete at the bottom.
- **Search** (in the toolbar, or `/`) finds a word in every page, note, idea and pin — in all projects, or pick one
  from the chip at the left of the box. On this tab the toolbar's middle is the search and **Waiting on others** (Add
  is still ⌘K from anywhere), so the board starts right under it. Its count turns a green **0** when nobody owes you
anything.

Projects aren't linked to calendar events: anything worth writing is written here. Steps stay in the project (they
don't go to the Tasks list). ⌘Z undoes everything (ticks, deletes, a burst of typing); inside the editor ⌘Z undoes
your typing. Pages are stored as editor documents (TipTap / ProseMirror JSON); data saved by the older Projects
(store v1) is converted on first load without losing anything. Logic and tests: `web/src/lib/projects.ts`,
`projects.test.ts`, `data/store.test.ts`; the editor is `components/ProjectEditor.tsx`.

### Scheduling links (book a time / find a time together)

Sidebar → **Scheduling** → **+ Booking link** or **+ Group poll**. In the editor you set the event name,
**drag across a two-month calendar to pick the days offered** — a new link starts with none — (or “Next 5 weekdays” /
“Next 2 weeks”),
the hours, length (default 1 h), a location and a note, which calendars count as busy, and where the
meeting goes; **Copy link** to share it. Your name comes from **⚙ Settings**. Links work for anyone, on any
phone or computer: the address opens a page on this project's GitHub Pages, and bookings come back to your Worldline
on their own (see *How links work between people* below).

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

#### How links work between people

No server of mine, no accounts. Messages go through **Nostr relays** — public message boards run independently by
different people, where anyone can post a signed message without signing up. Worldline uses seven of them and
sends everything to all of them; any one that keeps a message is enough.

**The relay list keeps itself current.** It's a file, `web/public/relays.json`, served beside the guest page. Every
Monday a GitHub Action (`.github/workflows/relays.yml`) tests each relay in use and each candidate: post a message,
read it back, and check it still keeps messages over 180 days old. A relay that fails three tries 20 minutes apart is
swapped for the fastest working candidate in a **pull request**; merge it and that's all. The guest page uses the
new list within minutes; running apps check the list every 6 hours and move over by themselves (no new release).
A removed relay is *retired*, not forgotten: the guest page keeps using retired relays for a year, so an app still on
the old list (offline, or an older version) keeps reaching guests. If the list can't fix itself (no working
candidates left), the Action opens an issue instead. Run it by hand from the Actions tab, or locally:
`node scripts/check-relays.ts` (from `web/`). Logic and tests: `web/src/lib/relaylist.ts`, `relaylist.test.ts`.

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

**Where it can fail, and what happens:**

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

Logic and tests: `web/src/lib/schedwire.ts` (keys, address, encryption, who gets a slot — `schedwire.test.ts`),
`web/src/data/schedSync.ts` (Worldline's side), `web/src/guest/` (the guest page), and `schedSync.test.ts`, which runs
your app and several guests end to end over in-memory relays (one of them down): a booking race, the app closed while
someone books, poll answers, a deleted link. The guest page is built with `npm run build:guest` and deployed by
`.github/workflows/pages.yml` on every push.

### Settings

**⚙ Settings** (bottom of the sidebar): **Appearance** (theme), your name (used on scheduling links), home time
zone, default calendar for new events, **Export habits (CSV)**, where your data lives (**Show in Finder**), and **Erase everything**.

**Themes** (Settings → Appearance, in two groups):
- *Light:* **System** (follows the computer), **Light**, **Paper** (off-white + ink cobalt), **Gilt** (white + antique gold), **Ice** (steel grey +
  crimson), **Sand** (beige + red), **Peach** (apricot + deep teal), **Rosé** (blush + plum), **Butter** (pale yellow +
  royal blue), **Sage** (green-grey + forest), **Mint** (seafoam + tomato red), **Sky** (powder blue + terracotta),
  **Lavender** (pale lilac + jade).
- *Dark:* **Dark** (graphite grey), **Midnight** (black + cyan), **Obsidian** (black + hot magenta), **Bumblebee** (black + gold), **Graphite**
  (charcoal + electric lime), **Navy** (navy + gold), **Abyss** (blue-black + lemon), **Cobalt** (electric blue +
  tangerine), **Fjord** (Nordic slate + ice blue), **Lagoon** (teal + coral), **Evergreen** (forest + copper),
  **Espresso** (coffee + sky blue), **Bordeaux** (wine + mint), **Aubergine** (plum + lilac).

**Why every theme feels equally crisp:** what makes a colour pop is a *lightness* difference, not a different hue —
saffron on lilac is a lovely pair but measured only 2.3:1, so it read as a wash; and greys tinted with the background's
hue make the whole app one colour, like a filter. So every theme meets the same rules (contrast ratios, WCAG): main text
≥ 15:1, secondary text ≥ 6:1 and nearly neutral, faint text ≈ 3:1, the accent ≥ 5:1 against background *and* cards,
and text on the accent ≥ 4.5:1. `theme.test.ts` checks all of them; `web/scripts/tune-themes.py` fixes a theme that
falls short by moving only lightness (so each keeps its hues).

Each is one block of colour variables in `styles.css`
(`:root[data-theme='…']`): surfaces, text, lines, the accent (today, Add) and the text drawn on it, the focus/selection
colour, danger (delete) and ok (done). Calendar and deadline colours are your data, so they stay the same in every
theme. The saved theme is applied before the first paint (`index.html`), so there's no flash of the wrong colours.
To add a theme: copy a block in `styles.css`, add it to `THEMES` in `src/lib/theme.ts` (and, if it's dark, to the
list in `index.html`). `theme.test.ts` fails if a theme misses a colour or the two dark lists disagree.

### Deadlines

A deadline is a **moment** something is due (5 PM unless you give a time) with a **runway** of
work before it (2 weeks unless you say otherwise) — not an all-day event.

- **Quick add:** “NSERC proposal due nov 18”, “abstract due fri 3pm”, “finish slides by thursday”,
  “grant report due dec 1 needs 3 weeks”. Tick off: “done NSERC proposal”, “mark abstract done”,
  “submitted grant report”. Move: “push NSERC deadline to nov 20”.
- **Not in a calendar.** A deadline's colour is how much of its runway is left: **green** > 60%,
  **yellow** 25–60%, **orange** < 25%, **red** overdue. The Deadlines section has its own
  “on calendar” toggle.
- **Day/week view:** each open deadline is a *runway track* under the day names — coloured text on a
  thin line that fades in toward a ⚑ pennant at the due moment — so it never looks like an event.
  All-day and multi-day events are *solid chips* (arrow-cut ends when they continue, “3 days” label).
  A ⚑ flag also marks the due moment in the hour grid. Done deadlines leave the tracks.
- **Month view:** ⚑ on the due date. **Sidebar:** “Deadlines” (replaces Up next) — overdue first,
  a countdown pill in the deadline's colour, ○ to mark done.
- **Event card:** a Deadline switch (turns any event into one), Due, Work starts, Done.
- **Suggestions:** a deadline inside its runway with nothing scheduled for it gets a focus-block
  offer (“Work on NSERC proposal tomorrow at 9am for 3h”) in a free slot.

### Time zones (travelling)

- The calendar is always drawn in **this computer's current time zone**, and switches by itself
  when the laptop's zone changes (checked every 30 s and when you return to the app).
- At home the zone is printed above the hour column (the toolbar stays uncluttered). Away from your **home zone** a
  pill appears in the toolbar, amber (“✈ Paris · CEST”),
  a second column shows home-time hours, and the event card shows the time back home.
- Click the pill to see both zones and the offset, change your home zone, or turn the home column off (your home zone
  is also in ⚙ Settings).
  The home zone is **searchable**: type a city (“calgary” → Mountain time, via Edmonton's zone), a
  province/state or country (“alberta”, “ontario”), or a zone name (“mountain”, “MST”). Each match shows
  the zone and the time there right now. City data: `city-timezones` (~7,300 cities, MIT), loaded only
  when the picker opens. Tests: `zoneSearch.test.ts`.
- Under the hood (same model as Google Calendar): one-off timed events are absolute instants;
  **all-day events are dates** (they never slide to the neighbouring day when you fly); a **repeating
  series keeps the zone it was created in**, so a weekly 3 PM Toronto meeting stays 3 PM Toronto
  from anywhere — even in the weeks when two places change daylight-saving time on different dates.
  Tests: `zone.test.ts` (runs with the clock set to Tokyo).

### Calendars

Each calendar has a slim show/hide switch (clicking anywhere on the row works too); ★ after the name
marks the default calendar for new events (hover another calendar to move it). The Calendars and
Deadlines sections fold away by clicking their heading — the chevron turns and the section slides
closed; a folded section shows a summary (calendar dots, deadline count). Remembered.

Sidebar → hover a calendar → **⋯** to rename it, pick a colour (12 presets or custom), make it the
default for new events, or delete it (its events either move to another calendar or are deleted
with it). The **+** next to “Calendars” adds one. All of it can be undone with ⌘Z.

### Repeating events

Stored like Google Calendar: one rule per series (`recurrence` on a "master" event); the
occurrences are generated for whatever is on screen (`web/src/lib/recurrence.ts`).

| Say / type | Does |
|---|---|
| “weekly meeting on friday with Alex 3pm”, “Alex meeting fridays at 3” | weekly |
| “Alex 1:1 every other friday at 3”, “seminar biweekly wed 2pm” | every 2 weeks |
| “standup every weekday 9:30”, “gym every mon and wed 7am” | chosen weekdays |
| “daily standup at 10am”, “rent monthly on the 1st”, “Mom’s birthday every year oct 20” | daily / monthly / yearly |
| “… until dec 14”, “… for 10 weeks”, “… for 6 sessions” | end date |
| “skip Alex meeting this week”, dragging one occurrence | that occurrence only (an exception) |
| “cancel all recurring events with Alex on Fridays at 3”, “cancel all Alex meetings” | stop the series from today (past ones stay) |
| “move weekly Alex meeting to thursdays at 4”, “push all Alex meetings back 30 min” | change the whole series |

The event card has a **Repeat** setting, a **This event / All events** switch for occurrences,
and **Delete this event / Delete all events**. Tests: `recurrence.test.ts`, `series.test.ts`.

### Suggest as you type

While typing, complete sentences built from your own events appear under the preview
(“skip al” → “Skip Meeting with Alex friday”, “lunch with s” → “Lunch with Sam #social”).
They are never filled in automatically: ↓ highlights one, Enter puts it in the box, Enter again
applies. Tests: `typeahead.test.ts`.

### Suggestions (empty quick-add box)

Learned from the last ~10 weeks of your calendar, looking one week ahead:

- **Missing regular meeting** — a weekly / every-other-week series that's still active (3+ recent
  occurrences, last one within two cycles) but isn't on the calendar this week → “Meeting with
  Alex friday at 2pm #research”. A meeting moved to another day counts as present; one you
  deleted or skipped isn't suggested back; series that went quiet months ago are ignored.
- **Clash** — two upcoming events overlap → move the one-off one to the nearest free slot.
- **Starting soon** (≤ 90 min) → “Push X back 15 min”.
- **Next regular meeting** in the coming 3 days → “Skip X tomorrow”.

Each suggestion is a normal quick-add sentence, checked against the real parser before it is
shown. ↑/↓ choose, Enter fills it in (Enter again applies), × dismisses it for good.
Tests: `web/src/lib/suggest.test.ts`.

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

Tests: `npm test` · Type-check: `npm run typecheck` · Production build: `npm run build` (all from `web/`).

**Releasing a version:** bump `version` in `web/src-tauri/tauri.conf.json`, commit, then
`git tag v0.2.0 && git push origin v0.2.0`. GitHub builds the app (Apple Silicon + Intel) and attaches the `.dmg` to a
draft release; review it and press **Publish**.

## Roadmap

1. ~~Calendar UI~~ · ~~to-dos, habits, projects~~ · ~~Mac app with local storage, calendar subscriptions~~
2. Your own accounts' calendars, two-way (Google, iCloud, a university Exchange account) through macOS's calendar access (EventKit)
3. iPhone app, and syncing between devices (local-first, end-to-end encrypted, no paid server)
4. Voice capture → AI-parsed events/to-dos (local model on the laptop)
