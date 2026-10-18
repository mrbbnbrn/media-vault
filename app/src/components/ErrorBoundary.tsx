// A part of the window that fails while drawing used to take the whole window
// with it (an empty black page that no key could leave). Now the failing part
// is replaced (the viewer closes, back to the library), and what failed goes
// into diagnostics.log (diaglog.rs) so it can be fixed.

import { Component, type ReactNode } from 'react';
import { api } from '../api';

export function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message || '(no message)'} | ${(e.stack ?? '').split('\n').slice(0, 6).join(' / ')}`;
  try {
    return `thrown ${typeof e}: ${JSON.stringify(e)?.slice(0, 200) ?? String(e)}`;
  } catch {
    return `thrown ${typeof e}: ${String(e)}`;
  }
}

export class ErrorBoundary extends Component<{ name: string; onError?: (e: unknown) => void; fallback?: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(e: unknown, info: { componentStack?: string | null }) {
    const where = (info.componentStack ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).join(' < ');
    void api.diagNote(`${this.props.name} failed: ${errorText(e)} | in ${where}`);
    this.props.onError?.(e);
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/** For the whole window: a way back instead of an empty page. */
export function WindowFailed() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--bg, #0b0d10)', color: 'var(--text, #e6e6e6)' }}>
      <div style={{ textAlign: 'center', maxWidth: 460, padding: 16 }}>
        <p style={{ marginBottom: 12 }}>Something in the window went wrong. Your library is safe; the details went into diagnostics.log.</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>Load the window again</button>
      </div>
    </div>
  );
}
