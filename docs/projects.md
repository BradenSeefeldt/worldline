# Projects

Long-running work — "get the simulation running", "look into a collaborator's archival data", a student's project — not
milk and rubbish (that's Tasks). Third tab: **Calendar | Habits | Projects** (or `P`).

## Everything is writing

Each thread (a months-long piece of work) and each project is a page you write in: its
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
- **Code:** type ```` ``` ```` and a space (or ```` ```python ````, ```` ```bash ````…) for a code block: monospaced, with
  syntax colours, the language (picked by itself — Python, a terminal session, shell, C/C++, Fortran, Julia, R, Rust,
  SQL, JSON, YAML… — or chosen from the label) and a **Copy** button. Tab / ⇧Tab indent; ⌘↩ or three Enters leave it.
  **Pasting code** — from VS Code, a terminal, a Jupyter session — makes a code block by itself (Python's `# comments`
  don't turn into headings); so does a ```` ``` ```` fence in pasted markdown. Inside code, `@name` and `[]` are just
  text. One command in a sentence: `` `module load hdf5` ``. (`web/src/components/CodeBlock.tsx`, `CodeBlock.test.ts`)

## The board

The board (home): one column per project, each a softly tinted band with a big name, its one-line About, pinned
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

## One page at a time

Click a thread, a project's name or **Waiting on others** (in the toolbar) and its page opens in a wide pane
*beside* the board, which stays put (that project's column is outlined and scrolled into view). Links inside the pane
replace the page — they never stack — with **← →** (⌘[ ⌘]) like a browser, **Esc** to close, and **⤢** (⌘.) to go
full width for long writing.
- *Thread page:* title, **Active / Done**, "Waiting on …", the main text, and **Notes**: a roomy **Today** box (start
  typing and it becomes today's note) above earlier notes, newest first, each with a quiet date. A margin gathers
  to-dos from the notes, who you're waiting on and open questions. Move it to another project or delete it at the
  bottom.
- *Project page:* name, one-line About, **pins** (+ Pin a link or folder: web links open; in the Mac app a folder opens in
  Finder and a file is shown there — never opened; a browser copies the path), a catch-up (**waiting on others** with what each unblocks, **still to settle**,
  **decided**), its **Overview** (plan, outline, loose to-dos), and its own **Notes** (e.g. a meeting with a
  supervisor or student, written as a note starting "**Meeting with Alex.**"). Colour, archive, delete at the bottom.
- **Search** (in the toolbar, or `/`) finds a word in every page, note, idea and pin — in all projects, or pick one
  from the chip at the left of the box. On this tab the toolbar's middle is the search and **Waiting on others** (Add
  is still ⌘K from anywhere), so the board starts right under it. Its count turns a green **0** when nobody owes you
  anything.

## Notes

Projects aren't linked to calendar events: anything worth writing is written here. Steps stay in the project (they
don't go to the Tasks list). ⌘Z undoes everything (ticks, deletes, a burst of typing); inside the editor ⌘Z undoes
your typing. Pages are stored as editor documents (TipTap / ProseMirror JSON); data saved by the older Projects
(store v1) is converted on first load without losing anything. Logic and tests:
[`web/src/lib/projects.ts`](../web/src/lib/projects.ts), `projects.test.ts`, `data/store.test.ts`; the editor is
[`web/src/components/ProjectEditor.tsx`](../web/src/components/ProjectEditor.tsx).
