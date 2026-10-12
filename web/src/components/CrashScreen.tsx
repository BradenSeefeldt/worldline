// If something in the interface throws while drawing, show what happened instead of a blank window: Reload (your data
// is saved as you go), and — if it keeps happening — the ways back the recovery screen offers (a daily snapshot, a
// backup file, undoing the last restore).
import { Component, type ReactNode } from 'react';
import { Recovery } from './Recovery';

export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('Worldline crashed while drawing', error);
  }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return <Recovery reason="Worldline hit a problem drawing this screen." crash={e} />;
  }
}
