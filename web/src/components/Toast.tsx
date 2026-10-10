import { useEffect } from 'react';
import { useStore } from '../data/store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  const { hideToast, undo, select } = useStore.getState();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(hideToast, 5000);
    return () => clearTimeout(t);
  }, [toast, hideToast]);

  if (!toast) return null;
  return (
    <div className="toast" key={toast.id} role="status">
      <span>{toast.text}</span>
      {toast.editId && (
        <button onClick={() => { select(toast.editId!); hideToast(); }}>Edit</button>
      )}
      {toast.undo && <button onClick={undo}>Undo</button>}
    </div>
  );
}
