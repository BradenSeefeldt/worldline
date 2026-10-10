// Edit card for a task: title, due date, which deadline it's a step of, done, delete.
import { useMemo, type CSSProperties } from 'react';
import { format } from 'date-fns';
import { useStore } from '../data/store';
import { dueOf } from '../lib/tasks';
import { Close, Trash } from './Icons';

export function TaskPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const tasks = useStore((s) => s.tasks);
  const events = useStore((s) => s.events);
  const task = tasks.find((t) => t.id === selectedId);
  const deadlines = useMemo(() => events.filter((e) => e.kind === 'deadline' && (!e.done || e.id === task?.parentId)), [events, task?.parentId]);
  if (!task) return null;
  const st = useStore.getState();
  const due = dueOf(task);

  return (
    <aside className="panel task-panel" style={{ '--c': '#20b26b' } as CSSProperties}>
      <div className="panel-top">
        <span className="panel-cal panel-cal-static" style={{ color: 'var(--text-2)' }}>☐ Task</span>
        <button className="icon-btn" onClick={() => st.select(null)} aria-label="Close">
          <Close />
        </button>
      </div>
      <input
        autoFocus={!task.title}
        className="panel-title"
        value={task.title}
        placeholder="Task"
        onChange={(e) => st.updateTask(task.id, { title: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <div className="panel-rows">
        <div className="prow">
          <span>Due</span>
          <div className="pinputs">
            <input
              type="date"
              value={due === undefined ? '' : format(due, 'yyyy-MM-dd')}
              onChange={(e) => {
                if (!e.target.value) return st.updateTask(task.id, { due: null });
                const [y, m, d] = e.target.value.split('-').map(Number);
                st.updateTask(task.id, { due: new Date(y, m - 1, d).getTime() });
              }}
            />
            {due !== undefined && (
              <button className="pclear" onClick={() => st.updateTask(task.id, { due: null })} title="No date (Anytime)">×</button>
            )}
          </div>
        </div>
        <div className="prow">
          <span>Step of</span>
          <select className="pselect" value={task.parentId ?? ''} onChange={(e) => st.updateTask(task.id, { parentId: e.target.value || undefined })}>
            <option value="">— no deadline —</option>
            {deadlines.map((d) => (
              <option key={d.id} value={d.id}>⚑ {d.title}</option>
            ))}
          </select>
        </div>
        <label className="prow">
          <span>Done</span>
          <input type="checkbox" className="switch" checked={!!task.done} onChange={(e) => st.setTaskDone(task.id, e.target.checked)} />
        </label>
      </div>
      <button className="delete-btn" onClick={() => st.deleteTask(task.id)}>
        <Trash /> Delete task
      </button>
    </aside>
  );
}
