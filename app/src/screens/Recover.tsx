import { useState } from 'react';
import { api } from '../api';
import type { Nav } from '../App';
import { Busy, ErrorBox, TopBar } from '../components/Chrome';
import { BackIcon } from '../components/Icons';

/** Count words the way the backend does: ignores numbering and punctuation. */
export function countWords(text: string): number {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z]/g, ''))
    .filter(Boolean).length;
}

export function Recover({ nav, path }: { nav: Nav; path: string }) {
  const vault = nav.app.vaults.find((v) => v.path === path);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = countWords(text);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.unlockWithRecovery(path, text);
      setText('');
      await nav.refresh();
      nav.go({ name: 'newPassword' });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title="Recover access">
        <button type="button" className="btn btn-sm" onClick={() => nav.go({ name: 'start', select: path })} disabled={busy}>
          <BackIcon /> Back
        </button>
      </TopBar>
      <div className="page">
        <form className="page-inner" style={{ maxWidth: 620 }} onSubmit={submit}>
          <div className="field" style={{ gap: 10 }}>
            <h1>Unlock {vault?.name ?? 'vault'} with your recovery key</h1>
            <p className="lead">Type the 24 words in order. Numbers, line breaks and capital letters don’t matter. Next you’ll set a new password.</p>
          </div>
          <div className="field">
            <label htmlFor="words">Recovery words</label>
            <textarea id="words" className="input" autoFocus spellCheck={false} autoComplete="off"
              value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
              placeholder="1. word  2. word  3. word …" />
            <span className="faint mono" style={{ fontSize: 12, color: n > 24 ? 'var(--warn)' : undefined }}>{n} / 24 words</span>
          </div>
          <ErrorBox error={error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={busy || n !== 24}>
              {busy ? <Busy label="Checking…" /> : 'Unlock'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
