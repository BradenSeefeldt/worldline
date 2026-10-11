// If something in the interface throws while drawing, show what happened and a Reload button instead of a blank
// window. Your data is saved as you go, so reloading loses nothing.
import { Component, type ReactNode } from 'react';

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
    return (
      <div className="rc">
        <div className="rc-card">
          <h1>Something went wrong</h1>
          <p>Worldline hit a problem drawing this screen. Everything you’d done is saved — reloading is safe.</p>
          <pre className="rc-err">{String(e.message || e)}</pre>
          <div className="rc-actions">
            <button className="ce-btn primary" onClick={() => window.location.reload()}>Reload</button>
            <button className="ce-btn" onClick={() => void navigator.clipboard?.writeText(`${e.message}\n${e.stack ?? ''}`)}>Copy details</button>
          </div>
        </div>
      </div>
    );
  }
}
