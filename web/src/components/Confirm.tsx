// "Are you sure?" inside the app. The browser's own confirm() popup doesn't exist in the Mac app (its web view
// silently answers "no"), so every confirmation goes through ask(): `if (await ask({...})) doIt()`.
import { useEffect, useRef, useState } from 'react';
import { cls } from '../lib/format';

export interface Ask {
  title: string;
  body?: string;
  confirm: string; // the button: "Delete", "Erase everything"
  danger?: boolean;
}

let show: ((a: Ask & { resolve: (ok: boolean) => void }) => void) | null = null;

/** Ask, and resolve true (confirmed) or false (cancelled: the button, Esc, or a click outside). */
export function ask(a: Ask): Promise<boolean> {
  return new Promise((resolve) => (show ? show({ ...a, resolve }) : resolve(false)));
}

/** Mounted once (in App). */
export function ConfirmHost() {
  const [cur, setCur] = useState<(Ask & { resolve: (ok: boolean) => void }) | null>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    show = (a) => setCur(a);
    return () => void (show = null);
  }, []);
  const done = (ok: boolean) => {
    cur?.resolve(ok);
    setCur(null);
  };
  useEffect(() => {
    if (!cur) return;
    okRef.current?.focus();
    // capture phase: Esc closes this dialog only, not the editor underneath
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      done(e.key === 'Enter');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cur) return null;
  return (
    <div className="ce-scrim cf-scrim" onMouseDown={() => done(false)}>
      <div className="ce cf" role="alertdialog" aria-modal="true" aria-labelledby="cf-title" onMouseDown={(e) => e.stopPropagation()}>
        <div id="cf-title" className="cf-title">{cur.title}</div>
        {cur.body && <p className="cf-body">{cur.body}</p>}
        <div className="cf-actions">
          <button className="ce-btn" onClick={() => done(false)}>Cancel</button>
          <button ref={okRef} className={cls('ce-btn', cur.danger ? 'danger' : 'primary')} onClick={() => done(true)}>{cur.confirm}</button>
        </div>
      </div>
    </div>
  );
}
