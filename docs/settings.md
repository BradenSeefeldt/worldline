# Settings and themes

## Settings

**⚙ Settings** (bottom of the sidebar, or **⌘,**) works like the Mac's System Settings: sections on the left (with a
search box), the chosen section's settings beside them.

| Section | What's there |
|---|---|
| **General** | Your name (on scheduling links), home time zone, **week starts on** Monday or Sunday, **12- or 24-hour time** (everywhere a time is shown; typing either works in quick add), what to open on launch, keep running when the window is closed, **open at login** |
| **Appearance** | Every theme as a tile. **Follow the Mac's light / dark setting**: pick one light and one dark theme and Worldline switches with your Mac; off: pick any one theme. Hour height; events **filled** or as a coloured **stripe** |
| **Calendar** | Default view, where a day scrolls to, **show weekends** (off: a Monday–Friday week), **week numbers** (mini month, month view), default calendar, **default event length**, the home-time column, tasks and deadline runways on the calendar |
| **Calendars** | Every calendar and subscription with its status (“Couldn't update: …”), Refresh / Edit, how often subscriptions refresh, + New / Subscribe / Import |
| **Alerts** | Reminders: the default for events (10 minutes before), all-day events (none) and deadlines (1 hour before); whether notifications are allowed; send a test alert |
| **Tasks & Deadlines** | A deadline's time and runway when none is given; each kind of quick-add suggestion on or off |
| **Habits** | Whether calendar events count towards habits; the weekly nudge; export CSV |
| **Scheduling** | What new links start with (length, hours, single-use, buffer, earliest booking); the relays and which are connected |
| **Sync** | Turn on sync, join from another device (see [Syncing your Mac and iPhone](sync.md)) |
| **Data & Backups** | Show in Finder; **restore one of the last 14 daily snapshots**; **back up everything to one .json file** and restore from it; **export a calendar as .ics** (for Apple Calendar, Google, Outlook); habits CSV; erase everything; uninstall |
| **About** | Version, **check for updates**, source code, keyboard shortcuts |

Settings live in one saved object ([`web/src/data/settings.ts`](../web/src/data/settings.ts)); anything missing or
invalid — an older version saved it, or a setting was added since — falls back to its default. Tests:
`settings.test.ts`, `slots.test.ts` (the 5-day week), `icsExport.test.ts` (an exported calendar reads back the same,
repeating events included), `nativeDialogs.test.ts`.

## Themes

Settings → Appearance, in two groups:
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
and text on the accent ≥ 4.5:1. `theme.test.ts` checks all of them; [`web/scripts/tune-themes.py`](../web/scripts/tune-themes.py)
fixes a theme that falls short by moving only lightness (so each keeps its hues).

Each is one block of colour variables in `styles.css`
(`:root[data-theme='…']`): surfaces, text, lines, the accent (today, Add) and the text drawn on it, the focus/selection
colour, danger (delete) and ok (done). Calendar and deadline colours are your data, so they stay the same in every
theme. The saved theme is applied before the first paint (`index.html`), so there's no flash of the wrong colours.
To add a theme: copy a block in `styles.css`, add it to `THEMES` in [`web/src/lib/theme.ts`](../web/src/lib/theme.ts)
(and, if it's dark, to the list in `index.html`). `theme.test.ts` fails if a theme misses a colour or the two dark
lists disagree.
