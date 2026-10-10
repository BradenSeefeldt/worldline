// Projects: long-running research work. One column per project on the board; each thread (a months-long piece of
// work: "get the simulation running", "look into James's turbulence data") and each project is a page you write in.
//
// Everything is writing. A page has a body (what it is, the plan, an outline, a draft) and dated notes (meetings,
// results, decisions). Structure comes from a few things you type, and is read back out of the text — never typed
// twice, so it can't go stale:
//   [] …            a to-do (a checkbox). Tab under another to-do = it waits on that one ("once that's done, then…").
//   @Name in a to-do it's on someone else: you're waiting on them.
//   Idea: / Decided: / Q:   at the start of a paragraph — collected on the board / the project page.
// Pages are stored as editor documents (ProseMirror JSON, written by the TipTap editor in components/Projects).

export type ThreadStatus = 'active' | 'done';

/** An editor document node (ProseMirror JSON). */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface Pin {
  id: string;
  label: string;
  href: string; // a web address (opens) or a path (copied: a browser can't open folders)
}

export interface Idea {
  id: string;
  text: string;
  at: number;
}

export interface Project {
  id: string;
  title: string;
  color: string;
  about?: string; // one line, under the name
  doc?: DocNode; // the project's own page: plan, outline, loose to-dos
  pins?: Pin[];
  ideas?: Idea[]; // jotted straight onto the column ("Idea:" lines written anywhere are added to these)
  archived?: boolean;
  createdAt: number;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  status: ThreadStatus;
  body?: DocNode; // what it is, the plan, the draft…
  createdAt: number;
  updatedAt: number; // last edited (any change to it or its notes)
  doneAt?: number;
}

/** A dated note on a thread or a project (parentId). */
export interface LogEntry {
  id: string;
  parentId: string;
  doc: DocNode;
  at: number;
}

export interface World {
  projects: Project[];
  threads: Thread[];
  projectLog: LogEntry[];
}

const DAY = 86_400_000;
export const STALE_DAYS = 21;

// ---------------------------------------------------------------- documents
export const emptyDoc = (): DocNode => ({ type: 'doc', content: [{ type: 'paragraph' }] });
const paraOf = (line: string): DocNode => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' });
/** Plain text → a document: a paragraph per line. */
export const textToDoc = (text: string): DocNode => ({ type: 'doc', content: (text.trim() ? text.trim().split('\n') : ['']).map((l) => paraOf(l.trimEnd())) });

/** The text of a node (inline text only, no separators). */
export const inlineText = (n: DocNode | undefined): string =>
  !n ? '' : n.type === 'inlineMath' ? `$${n.attrs?.latex ?? ''}$` : n.text ?? (n.content ?? []).map(inlineText).join('');
/** Readable one-line text of a document: blocks joined by spaces. */
export function docText(n: DocNode | undefined): string {
  if (!n) return '';
  if (n.text !== undefined) return n.text;
  if (n.type === 'inlineMath' || n.type === 'blockMath') return n.type === 'inlineMath' ? `$${n.attrs?.latex ?? ''}$` : `$$${n.attrs?.latex ?? ''}$$`;
  const inner = (n.content ?? []).map(docText);
  return ['paragraph', 'heading'].includes(n.type) ? inner.join('') : inner.filter(Boolean).join(' ');
}
export const isEmptyDoc = (d: DocNode | undefined) => !docText(d).trim();

/** A to-do's own words (not the to-dos nested under it). */
const ownText = (item: DocNode) => (item.content ?? []).filter((c) => c.type !== 'taskList').map(inlineText).join(' ').trim();

export interface Item {
  text: string; // without the @Name
  raw: string;
  done: boolean;
  who?: string; // @Name: on someone else
  blockedBy?: string; // waits on this (unticked) to-do above it
  path: number[]; // where it is in its document
}
/** Every to-do in a document, in order. */
export function itemsIn(doc: DocNode | undefined): Item[] {
  const out: Item[] = [];
  const walk = (n: DocNode, path: number[], open: string | undefined) => {
    (n.content ?? []).forEach((c, i) => {
      const p = [...path, i];
      if (c.type === 'taskItem') {
        const raw = ownText(c);
        const done = !!c.attrs?.checked;
        out.push({ text: raw.replace(/@\w+/g, '').replace(/\s+/g, ' ').trim(), raw, done, who: raw.match(/@(\w+)/)?.[1], blockedBy: open, path: p });
        walk(c, p, done ? open : raw.replace(/@\w+/g, '').trim());
      } else walk(c, p, open);
    });
  };
  if (doc) walk(doc, [], undefined);
  return out;
}

export type MarkKind = 'idea' | 'decided' | 'q';
export interface Mark {
  kind: MarkKind;
  text: string;
  resolved: boolean; // a settled question / an idea that's been started
  path: number[];
}
const MARK = /^(Idea|Decided|Q):\s*/;
/** "Idea: …", "Decided: …", "Q: …" paragraphs (not inside to-dos). */
export function marksIn(doc: DocNode | undefined): Mark[] {
  const out: Mark[] = [];
  const walk = (n: DocNode, path: number[]) =>
    (n.content ?? []).forEach((c, i) => {
      const p = [...path, i];
      if (c.type === 'paragraph') {
        const t = inlineText(c), m = t.match(MARK);
        if (m) out.push({ kind: m[1].toLowerCase() as MarkKind, text: t.slice(m[0].length).trim(), resolved: !!c.attrs?.resolved, path: p });
      } else if (c.type !== 'taskItem') walk(c, p);
    });
  if (doc) walk(doc, []);
  return out;
}

/** A copy of `doc` with the node at `path` given new attributes. */
export function setAttrsAt(doc: DocNode, path: number[], attrs: Record<string, unknown>): DocNode {
  if (!path.length) return { ...doc, attrs: { ...doc.attrs, ...attrs } };
  const [i, ...rest] = path;
  return { ...doc, content: (doc.content ?? []).map((c, k) => (k === i ? setAttrsAt(c, rest, attrs) : c)) };
}
/** The node at `path`, if it's still there. */
export const nodeAt = (doc: DocNode | undefined, path: number[]): DocNode | undefined => path.reduce<DocNode | undefined>((n, i) => n?.content?.[i], doc);

/** Pasted plain text written in markdown (headings, lists, checklists, quotes, bold…) — worth formatting. */
export function looksLikeMarkdown(text: string) {
  return /^(\s{0,3}#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>\s?|\s*\[[ xX]?\]\s|```|\$\$)/m.test(text) || /\*\*[^*\n]+\*\*|__[^_\n]+__/.test(text);
}
/** "[] x" / "[x] x" lines → the markdown form "- [ ] x" (so one parser reads every checklist). */
export const normalizeTodos = (text: string) => text.replace(/^([ \t]*)\[([ xX]?)\][ \t]+/gm, (_m, ind: string, c: string) => `${ind}- [${c.trim() ? 'x' : ' '}] `);
// Dollar amounts in pasted text ("costs $5 and $10") must not become equations. A real one is $…$ with no space just
// inside the dollars and no digit right after the closing one (or $$…$$); every other "$" is swapped for a stand-in
// before the markdown is read, and swapped back after.
const STANDIN = '\uE024';
const MATH = /\$\$[^$]+?\$\$|\$(?=[^\s$])[^$\n]*?[^\s$\\]\$(?!\d)|\$[^\s$\\]\$(?!\d)/g;
export function protectDollars(text: string) {
  let out = '', at = 0;
  for (const m of text.matchAll(MATH)) {
    out += text.slice(at, m.index).replaceAll('$', STANDIN) + m[0];
    at = m.index! + m[0].length;
  }
  return out + text.slice(at).replaceAll('$', STANDIN);
}
export function restoreDollars(n: DocNode): DocNode {
  const fix = (t: string) => t.replaceAll(STANDIN, '$');
  return {
    ...n,
    ...(n.text !== undefined ? { text: fix(n.text) } : {}),
    ...(n.attrs?.latex !== undefined ? { attrs: { ...n.attrs, latex: fix(String(n.attrs.latex)) } } : {}),
    ...(n.content ? { content: n.content.map(restoreDollars) } : {}),
  };
}

// ---------------------------------------------------------------- action items: capture now, file later
/** A new, unticked to-do. */
export const todoNode = (text: string): DocNode => ({ type: 'taskItem', attrs: { checked: false }, content: [paraOf(text.trim())] });
/** `doc` with a to-do added at the end: into its last checklist if it ends with one, else as a new checklist. */
export function appendItem(doc: DocNode | undefined, item: DocNode): DocNode {
  const blocks = (doc?.content ?? []).filter((b, _i, all) => !(all.length === 1 && b.type === 'paragraph' && !inlineText(b)));
  const last = blocks[blocks.length - 1];
  if (last?.type === 'taskList') return { type: 'doc', content: [...blocks.slice(0, -1), { ...last, content: [...(last.content ?? []), item] }] };
  return { type: 'doc', content: [...blocks, { type: 'taskList', content: [item] }] };
}
/** `doc` without the node at `path` (a checklist left empty goes too), and the node that was taken out. */
export function removeAt(doc: DocNode, path: number[]): { doc: DocNode; node?: DocNode } {
  const [i, ...rest] = path;
  const kids = doc.content ?? [];
  if (!kids[i]) return { doc };
  if (!rest.length) return { doc: { ...doc, content: kids.filter((_, k) => k !== i) }, node: kids[i] };
  const inner = removeAt(kids[i], rest);
  const emptied = inner.doc.type === 'taskList' && !inner.doc.content?.length;
  return { doc: { ...doc, content: emptied ? kids.filter((_, k) => k !== i) : kids.map((c, k) => (k === i ? inner.doc : c)) }, node: inner.node };
}

const STOPWORDS = new Set('the and for with from that this into onto then than our your their its are was were has have had not but all any can will about after before over under via per'.split(' '));
const wordsOf = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9= ]+/g, ' ').split(/\s+/).filter((x) => x.length > 2 && !STOPWORDS.has(x)).map((x) => x.replace(/s$/, '')));
/** A project's active threads for filing a to-do into: the likeliest first (most words shared with its title),
 *  then most recently edited. `score` 0 = no shared words. */
export function bestThreads(w: World, projectId: string, text: string): { t: Thread; score: number }[] {
  const mine = wordsOf(text);
  return w.threads
    .filter((t) => t.projectId === projectId && t.status === 'active')
    .map((t) => ({ t, score: [...wordsOf(t.title)].filter((x) => mine.has(x)).length }))
    .sort((a, b) => b.score - a.score || b.t.updatedAt - a.t.updatedAt);
}
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
/** Today's note on a page, if there is one. */
export const todaysNote = (log: LogEntry[], parentId: string, now = Date.now()) => log.find((e) => e.parentId === parentId && sameDay(e.at, now));

// ---------------------------------------------------------------- reading a project's pages
/** Where something was written: a page's body, or one of its dated notes. */
export interface Source {
  owner: string; // thread or project id
  entry?: string; // log entry id (absent = the page body)
  at?: number; // a note's date (bodies have none)
}
export const sourceKey = (s: Source) => `${s.owner}:${s.entry ?? 'body'}`;

const bodyOf = (w: World, id: string) => w.threads.find((t) => t.id === id)?.body ?? w.projects.find((p) => p.id === id)?.doc;
/** A page's notes, newest first. */
export const logOf = (log: LogEntry[], parentId: string) => log.filter((e) => e.parentId === parentId).sort((a, b) => b.at - a.at);
export function sources(w: World, id: string): { s: Source; doc: DocNode | undefined }[] {
  return [{ s: { owner: id }, doc: bodyOf(w, id) }, ...logOf(w.projectLog, id).map((e) => ({ s: { owner: id, entry: e.id, at: e.at }, doc: e.doc }))];
}
export const docOf = (w: World, s: Source) => (s.entry ? w.projectLog.find((e) => e.id === s.entry)?.doc : bodyOf(w, s.owner));

export type OpenItem = Item & { s: Source };
export const openItems = (w: World, id: string): OpenItem[] => sources(w, id).flatMap(({ s, doc }) => itemsIn(doc).filter((x) => !x.done).map((x) => ({ ...x, s })));
export type FoundMark = Mark & { s: Source };
export const marksOf = (w: World, id: string): FoundMark[] => sources(w, id).flatMap(({ s, doc }) => marksIn(doc).map((x) => ({ ...x, s })));
/** A project and its threads. */
export const familyOf = (w: World, pid: string) => [pid, ...w.threads.filter((t) => t.projectId === pid).map((t) => t.id)];

/** Ready to do now: yours, and not waiting behind another to-do. */
export const isReady = (x: Item) => !x.who && !x.blockedBy;

export type Status = { kind: 'active' | 'waiting' | 'done'; who?: string };
/** Read from what's written: "waiting" when nothing is ready for you and someone else owes you something. */
export function statusOf(w: World, t: Thread): Status {
  if (t.status === 'done') return { kind: 'done' };
  const open = openItems(w, t.id);
  const theirs = open.filter((x) => x.who);
  if (theirs.length && !open.some(isReady)) return { kind: 'waiting', who: [...new Set(theirs.map((x) => x.who!))].join(', ') };
  return { kind: 'active' };
}

/** Active, but untouched for three weeks: it's gone quiet. */
export const isStale = (t: Thread, now = Date.now()) => t.status === 'active' && now - t.updatedAt >= STALE_DAYS * DAY;

/** A column's threads: active ones (quiet and waiting ones sink; otherwise most recently edited first), and done. */
export function columnOf(w: World, projectId: string, now = Date.now()) {
  const mine = w.threads.filter((t) => t.projectId === projectId);
  const waiting = (t: Thread) => statusOf(w, t).kind === 'waiting';
  return {
    live: mine.filter((t) => t.status === 'active').sort((a, b) => +isStale(a, now) - +isStale(b, now) || +waiting(a) - +waiting(b) || b.updatedAt - a.updatedAt),
    done: mine.filter((t) => t.status === 'done').sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt)),
  };
}

export type IdeaRow = { text: string; idea?: Idea; mark?: FoundMark };
/** A project's ideas: jotted ones, then every unstarted "Idea:" line in it or its threads. */
export function ideasOf(w: World, pid: string): IdeaRow[] {
  const p = w.projects.find((x) => x.id === pid);
  return [
    ...(p?.ideas ?? []).map((idea) => ({ text: idea.text, idea })),
    ...familyOf(w, pid).flatMap((id) => marksOf(w, id)).filter((m) => m.kind === 'idea' && !m.resolved).map((mark) => ({ text: mark.text, mark })),
  ];
}

/** The newest written sentence on a thread (for a tile with nothing to do). */
export function latestLine(w: World, id: string) {
  for (const e of logOf(w.projectLog, id)) {
    const t = (e.doc.content ?? []).filter((c) => c.type === 'paragraph').map(inlineText).join(' ').trim();
    if (t) return t;
  }
  return '';
}

/** "today", "yesterday", "3d ago", "2w ago", "4mo ago" */
export function ago(t: number, now = Date.now()) {
  const d = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / DAY);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}y ago`;
}
/** How long something's been waiting: "today", "3d", "2w". */
export function span(t: number, now = Date.now()) {
  const a = ago(t, now);
  return a === 'today' ? 'today' : a === 'yesterday' ? '1d' : a.replace(' ago', '');
}

/** Where to find a word: every page, note, idea and pin that contains it. */
export interface Hit {
  owner: string; // thread or project id
  label: string;
  snippet: string;
  at?: number;
}
/** Search everything, or one project (its own page, notes, ideas and pins, and its threads'). */
export function search(w: World, q: string, projectId?: string): Hit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  if (projectId) {
    const mine = new Set(familyOf(w, projectId));
    return search({ ...w, projects: w.projects.filter((p) => p.id === projectId), threads: w.threads.filter((t) => mine.has(t.id)), projectLog: w.projectLog.filter((e) => mine.has(e.parentId)) }, q);
  }
  const hits: Hit[] = [];
  const add = (owner: string, label: string, text: string, at?: number) => {
    const k = text.toLowerCase().indexOf(needle);
    if (k >= 0) hits.push({ owner, label, snippet: (k > 50 ? '…' : '') + text.slice(Math.max(0, k - 50), k + 90).trim() + (k + 90 < text.length ? '…' : ''), at });
  };
  for (const t of w.threads) add(t.id, t.title, `${t.title} ${docText(t.body)}`);
  for (const p of w.projects) {
    add(p.id, p.title, `${p.title} ${p.about ?? ''} ${docText(p.doc)}`);
    for (const i of p.ideas ?? []) add(p.id, `Idea · ${p.title}`, i.text);
    for (const x of p.pins ?? []) add(p.id, `Pin · ${p.title}`, `${x.label} — ${x.href}`);
  }
  for (const e of w.projectLog) {
    const owner = w.threads.find((t) => t.id === e.parentId) ?? w.projects.find((p) => p.id === e.parentId);
    if (owner) add(e.parentId, owner.title, docText(e.doc), e.at);
  }
  return hits;
}

// ---------------------------------------------------------------- the old format (store v1) → this one
interface V1Thread { id: string; projectId: string; title: string; status: string; about?: string; next?: string; waitingOn?: string; steps?: { title: string; done: boolean }[]; createdAt: number; updatedAt: number; doneAt?: number }
interface V1Log { id: string; parentId: string; text?: string; at: number }
interface V1Project { id: string; title: string; color: string; about?: string; archived?: boolean; meetings?: string[]; createdAt: number }

/** Store v1 kept About, a next step, waiting-on and steps as separate fields; v2 writes them into the thread's page.
 *  Ideas (a v1 thread status) become ideas on the project, unless they already had notes or steps. Nothing is lost. */
export function migrateV1(v1: { projects?: V1Project[]; threads?: V1Thread[]; projectLog?: V1Log[] }): World {
  const now = Date.now();
  const log = v1.projectLog ?? [];
  const projects: Project[] = (v1.projects ?? []).map(({ meetings: _m, ...p }) => ({ ...p, pins: [], ideas: [] }));
  const threads: Thread[] = [];
  for (const t of v1.threads ?? []) {
    const hasMore = (t.steps?.length ?? 0) > 0 || log.some((e) => e.parentId === t.id) || !!t.next;
    const p = projects.find((x) => x.id === t.projectId);
    if (t.status === 'idea' && !hasMore && p) {
      p.ideas!.push({ id: t.id, text: t.about ? `${t.title} — ${t.about}` : t.title, at: t.createdAt });
      continue;
    }
    const blocks: DocNode[] = (t.about ?? '').split('\n').filter((l) => l.trim()).map(paraOf);
    const items: DocNode[] = (t.steps ?? []).map((s) => ({ type: 'taskItem', attrs: { checked: s.done }, content: [paraOf(s.title)] }));
    if (t.next) items.push({ type: 'taskItem', attrs: { checked: false }, content: [paraOf(t.next)] });
    if (t.status === 'waiting' && t.waitingOn) {
      const who = t.waitingOn.match(/^\s*([A-Z][\w]*)/)?.[1];
      items.push({ type: 'taskItem', attrs: { checked: false }, content: [paraOf(who ? `${t.waitingOn.replace(/^\s*[A-Z][\w]*\s*[—–:-]?\s*/, '') || 'Waiting'} @${who}` : `Waiting on ${t.waitingOn}`)] });
    }
    if (items.length) blocks.push({ type: 'taskList', content: items });
    threads.push({
      id: t.id, projectId: t.projectId, title: t.title, status: t.status === 'done' ? 'done' : 'active',
      body: { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] },
      createdAt: t.createdAt ?? now, updatedAt: t.updatedAt ?? now, ...(t.doneAt ? { doneAt: t.doneAt } : {}),
    });
  }
  const kept = new Set([...threads.map((t) => t.id), ...projects.map((p) => p.id)]);
  const projectLog: LogEntry[] = log.filter((e) => kept.has(e.parentId)).map((e) => ({ id: e.id, parentId: e.parentId, at: e.at, doc: textToDoc(e.text ?? '') }));
  return { projects, threads, projectLog };
}
