// The writing surface for Projects pages and notes: a real document editor (TipTap / ProseMirror), not a text box.
// Markdown as you type: "# " title, "## " subtitle, "### ", "- " / "1. " lists, "> " quote, **bold**, *italic*, `code`,
// ``` a code block (components/CodeBlock.tsx), "---" a rule; pasted markdown arrives formatted, pasted code as a code block. Links (paste or type a URL), and checkbox to-dos: "[] " starts one,
// Tab to put one under another ("once that's done, then…"). Two things are highlighted as you type, read straight
// from the text: "@Name" (someone else's to-do) and "Idea:" / "Decided:" / "Q:" at the start of a paragraph —
// click a "Q:" once it's settled. Equations: $…$ inline, a paragraph of $$…$$ displayed (KaTeX); click one to edit it.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension, InputRule } from '@tiptap/core';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { looksLikeMarkdown, normalizeTodos, protectDollars, restoreDollars, type DocNode } from '../lib/projects';
import { cls } from '../lib/format';
import { LANGUAGES, ProjectCode, looksLikeCode } from './CodeBlock';

const MARK = /^(Idea|Decided|Q):/;

/** Highlights @Name and Idea:/Decided:/Q:, keeps a paragraph's "settled" flag, and settles a Q: when clicked. */
const Marks = Extension.create({
  name: 'projectMarks',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        resolved: {
          default: false,
          parseHTML: (el) => el.hasAttribute('data-resolved'),
          renderHTML: (a) => (a.resolved ? { 'data-resolved': '' } : {}),
        },
      },
    }];
  },
  addProseMirrorPlugins() {
    const build = (doc: PMNode) => {
      const out: Decoration[] = [];
      doc.descendants((node, pos, parent) => {
        if (node.type.name === 'codeBlock') return false; // (code: "@decorator" isn't a person)
        if (node.isText && node.text && !node.marks.some((m) => m.type.name === 'code')) {
          for (const m of node.text.matchAll(/@\w+/g)) out.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: 'pj-who' }));
        }
        if (node.type.name === 'paragraph' && parent?.type.name !== 'taskItem') {
          const m = node.textContent.match(MARK);
          if (m) out.push(Decoration.inline(pos + 1, pos + 1 + m[0].length, { class: `pj-mk pj-mk-${m[1].toLowerCase()}`, title: m[1] === 'Q' ? 'Click when it’s settled' : '' }));
        }
        return true;
      });
      return DecorationSet.create(doc, out);
    };
    return [
      new Plugin({
        props: {
          decorations: (state) => build(state.doc),
          handleClick: (view, pos, event) => {
            if (!(event.target as HTMLElement).closest?.('.pj-mk-q')) return false;
            const $p = view.state.doc.resolve(pos);
            for (let d = $p.depth; d > 0; d--) {
              const n = $p.node(d);
              if (n.type.name === 'paragraph') {
                view.dispatch(view.state.tr.setNodeMarkup($p.before(d), undefined, { ...n.attrs, resolved: !n.attrs.resolved }));
                return true;
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});

// Equations the way LaTeX writes them: $…$ inline (no space just inside the dollars, so "$5 and $10" stays text),
// and a paragraph that is just $$…$$ becomes a displayed equation.
const KATEX = { throwOnError: false };
const InlineEq = InlineMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /(^|[^$\\\w])\$([^\s$](?:[^$]*[^\s$\\])?)\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from + match[1].length, range.to, this.type.create({ latex: match[2] }));
        },
      }),
    ];
  },
});
const BlockEq = BlockMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          state.tr.replaceWith($from.before(), $from.after(), this.type.create({ latex: match[1].trim() }));
        },
      }),
    ];
  },
});

type MathEdit = { pos: number; latex: string; block: boolean; left: number; top: number };

/** Editing an equation: the LaTeX, a live preview; Enter saves, Esc cancels, empty removes it. */
function MathBox({ m, onDone }: { m: MathEdit; onDone: (latex: string | null) => void }) {
  const [v, setV] = useState(m.latex);
  const ref = useRef<HTMLTextAreaElement>(null);
  // take the focus from the editor, cursor at the end
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);
  const html = (() => {
    try {
      return katex.renderToString(v || '\\;', { ...KATEX, displayMode: m.block });
    } catch {
      return '';
    }
  })();
  return (
    <div className="pj-mathbox" style={{ left: m.left, top: m.top }} onMouseDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref} rows={Math.min(6, v.split('\n').length)} value={v} spellCheck={false} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onDone(v);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone(null);
          }
        }}
        onBlur={() => onDone(v)}
      />
      <div className="pj-mathbox-preview" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="pj-mathbox-hint">↵ save · Esc cancel · empty removes it</div>
    </div>
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function DocEditor({ doc, onChange, placeholder, className, autoFocus, onBlur }: {
  doc: DocNode | undefined;
  onChange: (doc: DocNode) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
}) {
  // the latest callbacks, so an editor made once always reports to the right place
  const cb = useRef({ onChange, onBlur });
  cb.current = { onChange, onBlur };
  const editorRef = useRef<Editor | null>(null);
  const [math, setMath] = useState<MathEdit | null>(null);
  const editMath = (block: boolean) => (node: { attrs: Record<string, unknown> }, pos: number) => {
    const el = editorRef.current?.view.nodeDOM(pos) as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(12, Math.min(r.left, window.innerWidth - 392));
    setMath({ pos, latex: String(node.attrs.latex ?? ''), block, left, top: Math.min(r.bottom + 6, window.innerHeight - 180) });
  };
  const doneMath = (latex: string | null) => {
    const ed = editorRef.current, m = math;
    setMath(null);
    if (!ed || !m || latex === null || latex === m.latex) return;
    const node = ed.state.doc.nodeAt(m.pos);
    if (!node) return;
    if (!latex.trim()) ed.chain().focus().deleteRange({ from: m.pos, to: m.pos + node.nodeSize }).run();
    else if (m.block) ed.chain().focus().updateBlockMath({ latex, pos: m.pos }).run();
    else ed.chain().focus().updateInlineMath({ latex, pos: m.pos }).run();
  };
  const editMathRef = useRef(editMath);
  editMathRef.current = editMath;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] }, // "# " title, "## " subtitle, "### " sub-subtitle
        codeBlock: false, // (ProjectCode below: the same, with colours and a Copy button)
        link: { openOnClick: true, autolink: true, linkOnPaste: true, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      ProjectCode,
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      Marks,
      Markdown, // reads pasted markdown (see handlePaste); the typed shortcuts are the editor's own
      InlineEq.configure({ katexOptions: KATEX, onClick: (node, pos) => editMathRef.current(false)(node, pos) }),
      BlockEq.configure({ katexOptions: { ...KATEX, displayMode: true }, onClick: (node, pos) => editMathRef.current(true)(node, pos) }),
    ],
    content: doc ?? '',
    autofocus: autoFocus ? 'end' : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: cls('pj-doc', className) },
      // Pasted markdown (notes from another app, action items from an email: "# …", "- …", "[] …", "**…**", "$…$")
      // arrives formatted; anything else pastes as usual.
      handlePaste: (_view, event) => {
        const ed = editorRef.current;
        if (!ed || ed.isActive('codeBlock')) return false; // inside code: pasted as it is
        // code from an editor (VS Code says which language) or a terminal: a code block, not mangled into headings
        const raw = (event.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
        let vscode: string | null = null;
        try {
          vscode = (JSON.parse(event.clipboardData?.getData('vscode-editor-data') || 'null') as { mode?: string } | null)?.mode ?? null;
        } catch {
          /* not from VS Code */
        }
        if ((vscode && raw.includes('\n')) || (!raw.trimStart().startsWith('```') && looksLikeCode(raw))) {
          const language = vscode && LANGUAGES.some(([l]) => l === vscode) ? vscode : vscode === 'shellscript' ? 'bash' : null;
          // (with a line after it, where the cursor lands: the next thing pasted or typed goes below, not into it)
          ed.chain().focus().insertContent([{ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: raw.replace(/\n+$/, '') }] }, { type: 'paragraph' }]).run();
          return true;
        }
        const text = normalizeTodos(event.clipboardData?.getData('text/plain') ?? '');
        if (!ed.markdown || !text.trim() || !looksLikeMarkdown(text)) return false;
        const parsed = restoreDollars(ed.markdown.parse(protectDollars(text)) as DocNode);
        if (!parsed.content?.length) return false;
        ed.chain().focus().insertContent(parsed.content).run();
        return true;
      },
    },
    onUpdate: ({ editor }) => cb.current.onChange(editor.getJSON() as DocNode),
    onBlur: () => cb.current.onBlur?.(),
  });
  editorRef.current = editor;
  // Changed from outside (ticked on the board, undone, ⌘Z): show it, unless it's what we just typed.
  useEffect(() => {
    if (!editor || editor.isDestroyed || !doc) return;
    if (!same(editor.getJSON(), doc)) editor.commands.setContent(doc, { emitUpdate: false });
  }, [editor, doc]);
  return (
    <>
      <EditorContent editor={editor} />
      {/* drawn at the top level: the pane is a size container, which would trap a fixed box inside it */}
      {math && createPortal(<MathBox m={math} onDone={doneMath} />, document.body)}
    </>
  );
}
