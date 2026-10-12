# Using Worldline

## The basics

| Action | How |
|---|---|
| **Quick add** | **Add** button at the top, `⌘K` (works anywhere, even while typing in a box) or `N` (when you're not in a text box), then type/dictate: “lunch with Sam tomorrow 12:30 at Luigi’s #social for 90 min” → Enter |
| Change view | The **Week ▾** menu between the ‹ › arrows (Day / 3 Day / Week / Month), or keys `D` `3` `W` `M` |
| Move through time | **‹ ›** either side of the view menu, **Today** at the right end of the toolbar; scroll/swipe sideways (day views) or up/down (month); `←` `→`; `T` = today |
| Zoom hours | Pinch on trackpad/phone, or `⌘`+scroll |
| New event by hand | Drag on empty time, or double-click a slot. It's a draft until you press **Enter** or **Add event** on its card; click anywhere else (or Esc / Discard) and it disappears. Keeping it is one ⌘Z step |
| Edit | Click an event — the card saves as you type. Click it again (or `Esc`) to close |
| Move / resize | Drag the event / drag its bottom edge (on touch: long-press first) |
| Delete | `Delete` / `⌫` key or the card’s button |
| Undo / redo | `⌘Z` / `⇧⌘Z`, or “Undo” on the pop-up (quick-add's pop-up also has “Edit”) |
| Keyboard only | `Tab` reaches every event (day, week and month views) and every task row; `Enter` or `Space` opens it. Screen readers read each one out by name and time |
| Other pages | `H` Habits, `P` Projects, `⌘,` Settings (all shortcuts: Settings → About) |

Quick-add rules. Tested three ways in [`web/src/lib/`](../web/src/lib/): hand-written phrases
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

## Changing events from the same box

| Say / type | Does |
|---|---|
| “skip plasma meeting this week”, “cancel Alex’s meeting” | delete it |
| “skip **all** lunch talks this week” | delete every upcoming match |
| “move Alex’s meeting to tues at 3pm”, “reschedule dentist to monday” | move it (date only keeps the time; time only keeps the day) |
| “push gym back 30 min”, “shift Kai meeting by half hour early”, “delay telecon an hour” | shift it |
| “extend thesis writing by 30 min”, “shorten … by an hour” | change its length |

The event is found by forgiving name matching (possessives, plurals, typos); “tomorrow”, “this
week” or “the 3pm meeting” narrow it down. The preview shows exactly what will change; Tab steps
through other matches; Enter applies; ⌘Z undoes. If nothing matches, nothing happens
(⇧Enter adds the text as a new event instead). Tests: [`web/src/lib/commands.test.ts`](../web/src/lib/commands.test.ts).

## Tasks

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
  Remembered. ([`web/src/lib/reorder.ts`](../web/src/lib/reorder.ts), `reorder.test.ts`.)
- Sidebar: Tasks, Deadlines, Calendars — each a card with a subtle cyan border, an icon, a count badge, a
  calendar switch, a fold chevron, and a fading divider under the title; the mini month stays pinned.
  The Deadlines flag and count take the most urgent deadline's colour (red if anything is overdue),
  so it alerts you even when folded.

## Deadlines

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

## Reminders

Every event in your calendars reminds you 10 minutes before it starts, and every deadline 1 hour before it's due;
all-day events don't, unless you choose a time (Settings → **Alerts**: "On the day, at 9 AM", "The day before, at
5 PM"…). An event's card has its own **Alert** (Default · None · When it starts · 5, 10, 15, 30 minutes · 1, 2 hours
· 1 day before); for a repeating event it applies to the whole series. Subscribed calendars (and calendars on this Mac) stay quiet unless you
turn on **Alerts for its events** in the calendar's ⋯ card, where you can also turn a calendar's alerts off; an event
with its own Alert still alerts. Events in hidden calendars, and done deadlines, never alert.

- **Mac:** reminders are Mac notifications, on time even while Worldline's window is closed (it keeps running in
  the background); a reminder also shows inside the app. One missed by more than 5 minutes (the Mac was asleep) is
  skipped rather than shown late.
- **iPhone:** only while Worldline is open — a web app can't wake itself up. Your Mac sends them on time.

Logic and tests: `web/src/lib/alerts.ts`, `alerts.test.ts`; delivery `web/src/data/alerts.ts` and
`web/src-tauri/src/lib.rs`.

## Calendars on this Mac (iCloud, Google, Exchange)

**⚙ Settings → Calendars → Calendars on this Mac → Connect…** — macOS asks once whether Worldline may use your
calendars (Full Access). Then switch on the ones to show: every calendar the Mac's Calendar app has, grouped by account
(iCloud, Google, Exchange, On My Mac). They work like Worldline's own, both ways:

- Events in them show here; what you add, change or delete here is saved to the Calendar app (and from there to
  iCloud, Google…); what changes there shows here within two minutes, or as soon as you come back to Worldline.
- Changed on both sides at once: the Calendar app's version wins.
- A repeating event there arrives as its occurrences; changing one here changes that one. A new repeating event made
  here in one of those calendars becomes a real repeating event there.
- Read-only calendars (holidays, ones shared with you to view) stay read-only. Names come from the Calendar app;
  colours you can change here. Reminders for them are off by default (the Calendar app has its own).
- **Your iPhone** sees them through sync and can change them; the changes reach the Calendar app the next time your
  Mac runs Worldline.
- **Stop showing here** (the calendar's ⋯ card) only takes it out of Worldline — nothing is deleted in the Calendar app.
- **Safeguards:** Worldline never deletes more than 5 events there in one go (if its data jumped — an old backup
  restored — they come back instead, and it says so); a calendar that briefly comes back empty (iCloud refreshing) is
  left as it was; events far in the past or future (outside about the last 2 months and next 13) are left alone.
- If macOS ever asks again after an update, or Settings shows **Connect…** again, that's macOS re-checking the app
  (it isn't signed with a paid Apple ID); allow it again and everything carries on.

Logic and tests: `web/src/lib/macCalendars.ts` (what changed where — `macCalendars.test.ts`), `web/src/data/macCalendars.ts`
(running it — `macCalendars.test.ts`, against a fake Calendar app), `web/src-tauri/src/eventkit.rs` (the bridge to macOS).

## Calendars

Each calendar has a slim show/hide switch (clicking anywhere on the row works too); its name gets the rest of the
row (two lines if it needs them). ★ marks the default calendar for new events, and a red ! a subscription that
couldn't update. The Calendars and
Deadlines sections fold away by clicking their heading — the chevron turns and the section slides
closed; a folded section shows a summary (calendar dots, deadline count). Remembered.

Sidebar → hover a calendar → **⋯** to rename it, pick a colour (12 presets or custom), make it the
default for new events, see when a subscription last updated (and refresh it now), or delete it (its events either move to another calendar or are deleted
with it). The **+** next to “Calendars” adds one. All of it can be undone with ⌘Z.

## Repeating events

Stored like Google Calendar: one rule per series (`recurrence` on a "master" event); the
occurrences are generated for whatever is on screen ([`web/src/lib/recurrence.ts`](../web/src/lib/recurrence.ts)).

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

## Subscribing to calendars

Sidebar → **Calendars → +** → **Subscribe to a link**, and paste the calendar's link: a department or seminar
calendar's "subscribe"/iCal link, a team's schedule (`webcal://…`), a Google calendar's *Secret address in iCal
format* (Google Calendar → the calendar's ⋮ → Settings and sharing → Integrate calendar), an Outlook "publish" link.
It's read-only here (its events change at their source), refreshed when the app opens and every 30 minutes
(Settings → Calendars to change it; ⋯ → **Refresh now**), and named from the feed unless you name it. Repeating events, moved and cancelled
occurrences, and time zones (including Outlook's Windows zone names) are handled. **Import a file** copies an
`.ics` file in as a calendar of your own (editable): drop the file onto the big area, or click it to choose one.

Subscriptions are read by the Mac app; the iPhone version gets their events through [sync](sync.md). Only public
addresses are read (never this Mac or the local network), at most 20 MB. A feed is someone else's file, so limits
keep it from stalling the app: events repeating more often than hourly aren't shown, a series shows at most 5,000
occurrences, and a calendar at most 50,000 events.

## Time zones (travelling)

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

## Suggest as you type

While typing, complete sentences built from your own events appear under the preview
(“skip al” → “Skip Meeting with Alex friday”, “lunch with s” → “Lunch with Sam #social”).
They are never filled in automatically: ↓ highlights one, Enter puts it in the box, Enter again
applies. Tests: `typeahead.test.ts`.

## Suggestions (empty quick-add box)

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
Tests: [`web/src/lib/suggest.test.ts`](../web/src/lib/suggest.test.ts).
