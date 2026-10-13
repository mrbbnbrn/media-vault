import { useState } from 'react';
import type { Nav } from '../App';
import { TopBar } from '../components/Chrome';
import { WarnIcon } from '../components/Icons';

/** Shows the 24 recovery words exactly once. */
export function RecoveryWords({ nav, words, context }: { nav: Nav; words: string[]; context: 'create' | 'reset' }) {
  const [confirmed, setConfirmed] = useState(false);
  const vaultName = nav.app.session?.name ?? '';

  return (
    <>
      <TopBar title={context === 'create' ? 'Create vault · step 2 of 2' : 'New recovery key'} />
      <div className="page">
        <div className="page-inner">
          <div className="field" style={{ gap: 10 }}>
            <h1>Write down your recovery key</h1>
            <p className="lead">
              If you forget your password, these 24 words are the only way back in. This is the only time they are shown.
              They are not saved anywhere on this PC.
              {context === 'reset' && ' Your old recovery words no longer work.'}
            </p>
          </div>

          <div className="words" aria-label="Recovery words">
            {words.map((w, i) => (
              <div className="word" key={i}>
                <span className="n">{i + 1}</span>
                <span className="w">{w}</span>
              </div>
            ))}
          </div>

          <div className="notice">
            <WarnIcon />
            <span>
              Keep it on paper, somewhere safe and away from this PC. Anyone with these words can open the vault. Don’t
              photograph it or store it in a cloud note.
            </span>
          </div>

          <div className="row-between">
            <label className="check">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              I’ve written down all 24 words
            </label>
            <div className="row">
              <button type="button" className="btn" onClick={() => window.print()}>Print</button>
              <button type="button" className="btn btn-primary" disabled={!confirmed}
                onClick={() => nav.go(context === 'create' ? { name: 'library' } : { name: 'settings' })}>
                {context === 'create' ? 'Continue to library' : 'Done'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="print-only">
        <h1>Media Vault recovery key{vaultName ? ` — ${vaultName}` : ''}</h1>
        <p>Keep this paper safe. Anyone with these words can open the vault.</p>
        <ol>
          {words.map((w, i) => <li key={i}>{w}</li>)}
        </ol>
      </div>
    </>
  );
}
