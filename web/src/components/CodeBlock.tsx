// Code in Projects pages and notes: a block typed as ``` (or ```python) or pasted from an editor or a terminal, shown
// in a monospaced box with syntax colours (highlight.js through lowlight), the language (picked by itself unless you
// choose one) and a Copy button. Tab inside it indents (four spaces) instead of nesting a to-do.
import type { NodeViewRenderer } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import diff from 'highlight.js/lib/languages/diff';
import fortran from 'highlight.js/lib/languages/fortran';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import julia from 'highlight.js/lib/languages/julia';
import latex from 'highlight.js/lib/languages/latex';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';

/** The languages offered (and recognised when none is chosen): [highlight.js name, label]. */
export const LANGUAGES: [string, string][] = [
  ['python', 'Python'], ['bash', 'Shell script'], ['shell', 'Terminal'], ['c', 'C'], ['cpp', 'C++'], ['fortran', 'Fortran'],
  ['julia', 'Julia'], ['r', 'R'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['rust', 'Rust'], ['sql', 'SQL'],
  ['json', 'JSON'], ['yaml', 'YAML'], ['ini', 'INI / TOML'], ['makefile', 'Makefile'], ['latex', 'LaTeX'], ['markdown', 'Markdown'],
  ['diff', 'Diff'], ['plaintext', 'Plain text'],
];

export const lowlight = createLowlight({ bash, c, cpp, diff, fortran, ini, javascript, json, julia, latex, makefile, markdown, plaintext, python, r, rust, shell, sql, typescript, yaml });
lowlight.registerAlias({ bash: ['sh', 'zsh'], python: ['py', 'python3'], shell: ['console', 'terminal'], cpp: ['c++'], ini: ['toml'], javascript: ['js'], typescript: ['ts'], yaml: ['yml'] });

/** What "Auto" chooses between: real languages and terminal sessions. (Loose formats — INI, Markdown, plain text,
 *  diff, LaTeX — match nearly anything, so a Python snippet came out as "INI": those are picked by hand.) */
const AUTO = ['python', 'bash', 'shell', 'c', 'cpp', 'fortran', 'julia', 'r', 'javascript', 'typescript', 'rust', 'sql', 'json', 'yaml', 'makefile'];
/** lowlight for the editor: its own "Auto" uses the same short list. */
const editorLowlight = { ...lowlight, highlightAuto: (value: string, options?: { subset?: string[] }) => lowlight.highlightAuto(value, { ...options, subset: AUTO }) };

/** The language lowlight would pick for this text (none chosen). */
export function guessLanguage(text: string): string | null {
  const r = lowlight.highlightAuto(text, { subset: AUTO });
  return (r.data as { language?: string } | undefined)?.language ?? null;
}

/** A code block on screen: a bar (language, Copy) above the code. Drawn directly, not with React: it must exist the
 *  moment the block does — typing ``` makes one mid-keystroke, and a view drawn a moment later reads to the editor as
 *  a change to undo. */
const codeView: NodeViewRenderer = ({ node: first, editor, getPos }) => {
  let node = first;
  const dom = document.createElement('div');
  dom.className = 'pj-code';
  const bar = document.createElement('div');
  bar.className = 'pj-code-bar';
  bar.contentEditable = 'false';
  const select = document.createElement('select');
  select.className = 'pj-code-lang';
  select.setAttribute('aria-label', 'Language');
  const auto = document.createElement('option');
  auto.value = '';
  select.append(auto, ...LANGUAGES.map(([l, label]) => Object.assign(document.createElement('option'), { value: l, textContent: label })));
  select.addEventListener('change', () => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos === undefined) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: select.value || null }));
  });
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'pj-code-copy';
  copy.title = 'Copy the code';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(node.textContent).then(() => {
      copy.textContent = '✓ Copied';
      copy.classList.add('ok');
      setTimeout(() => ((copy.textContent = 'Copy'), copy.classList.remove('ok')), 1400);
    });
  });
  bar.append(select, copy);
  const pre = document.createElement('pre');
  pre.spellcheck = false;
  const code = document.createElement('code');
  pre.append(code);
  dom.append(bar, pre);
  let guessed = '';
  const show = () => {
    const language = (node.attrs.language as string | null) ?? '';
    select.value = language;
    select.disabled = !editor.isEditable;
    code.className = `hljs${language ? ` language-${language}` : ''}`;
    if (!language) {
      const g = node.textContent.trim() ? guessLanguage(node.textContent) : null;
      const label = g ? `${LANGUAGES.find(([l]) => l === g)?.[1] ?? g} (auto)` : 'Auto';
      if (label !== guessed) auto.textContent = guessed = label;
    }
  };
  show();
  return {
    dom,
    contentDOM: code,
    update: (n) => {
      if (n.type !== node.type) return false;
      node = n;
      show();
      return true;
    },
    stopEvent: (e) => bar.contains(e.target as Node), // the bar's own clicks and picks
    ignoreMutation: (m) => bar.contains(m.target), // (its label changing isn't an edit)
  };
};

/** The code block for the Projects editor. */
export const ProjectCode = CodeBlockLowlight.extend({
  addNodeView() {
    return codeView;
  },
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      // ⌘↩ (or three Enters) leaves the block
      'Mod-Enter': () => this.editor.isActive('codeBlock') && this.editor.commands.exitCode(),
    };
  },
}).configure({ lowlight: editorLowlight, defaultLanguage: null, enableTabIndentation: true, tabSize: 4 }); // Tab / ⇧Tab indent the line(s)

/**
 * Does pasted text look like code (from a terminal or an editor) rather than notes? Two or more lines, and most of them
 * look like code: indented, a shell prompt or command, Python/C-like syntax. Markdown notes ("- ", "1. ", "[] ", "**")
 * never do.
 */
export function looksLikeCode(text: string): boolean {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;
  if (lines.some((l) => /^\s*([-*+] |\d+\. |\[[ x]?\] |\*\*)/.test(l) && !/^\s*\*\*\w+\*\*\s*=/.test(l))) return false;
  const code = /^(\s{2,}|\t)\S|^(\$|>>>|\.\.\.|%|In \[\d+\]:) |^(def|class|import|from \S+ import|return|for|while|if|elif|else|try|except|with|print|lambda|async|await|const|let|var|function|#include|#!|int|void|double|float|module|subroutine|program|end|use|fn|pub|struct|impl|SELECT|INSERT|UPDATE)\b|^(cd|ls|git|conda|pip|python3?|sbatch|squeue|scancel|srun|ssh|scp|rsync|mkdir|rm|cp|mv|cat|grep|export|source|module|make|cmake|npm|brew|tar|chmod|echo|sudo|tmux|nvidia-smi|mpirun|module) |[;{}]\s*$|\)\s*:\s*$|^\s*[\w.[\]]+\s*[+\-*/%]?=\s*\S|^\s*#\s*\w/;
  return lines.filter((l) => code.test(l)).length / lines.length >= 0.6;
}
