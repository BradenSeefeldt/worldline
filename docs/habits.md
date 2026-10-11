# Habits

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
- ⌘Z undoes habit changes. Logic and tests: [`web/src/lib/habits.ts`](../web/src/lib/habits.ts), `habits.test.ts`.
