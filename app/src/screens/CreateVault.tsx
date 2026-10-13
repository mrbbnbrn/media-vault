import { useState } from 'react';
import { api, pickFolder } from '../api';
import type { Nav } from '../App';
import { Busy, ErrorBox, PasswordPair, TopBar, passwordsOk } from '../components/Chrome';
import { BackIcon, FolderIcon } from '../components/Icons';

export function CreateVault({ nav }: { nav: Nav }) {
  const min = nav.app.minPasswordChars;
  const [name, setName] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim().length > 0 && !!parent && passwordsOk(password, confirm, min);

  async function choose() {
    const p = await pickFolder('Where should the new vault folder be created?');
    if (p) setParent(p);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || !parent) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createVault(parent, name.trim(), password);
      setPassword('');
      setConfirm('');
      await nav.refresh();
      nav.go({ name: 'words', words: r.words, context: 'create' });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const sep = parent?.includes('\\') ? '\\' : '/';
  return (
    <>
      <TopBar title="Create vault · step 1 of 2">
        <button type="button" className="btn btn-sm" onClick={() => nav.go({ name: 'start' })} disabled={busy}>
          <BackIcon /> Back
        </button>
      </TopBar>
      <div className="page">
        <form className="page-inner" style={{ maxWidth: 560 }} onSubmit={create}>
          <div className="field" style={{ gap: 10 }}>
            <h1>Create a new vault</h1>
            <p className="lead">
              Everything you put in it is encrypted on disk. You can keep several vaults, each with its own password.
            </p>
          </div>

          <div className="field">
            <label htmlFor="vname">Vault name</label>
            <input id="vname" className="input" autoFocus placeholder="e.g. Photos" maxLength={80}
              value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </div>

          <div className="field">
            <span style={{ fontSize: 13, color: '#b9bcc2' }}>Location</span>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <div className="input mono" style={{ display: 'flex', alignItems: 'center', fontSize: 13, color: parent ? 'var(--text)' : '#6f737b', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {parent ? `${parent}${sep}${name.trim() || '…'}` : 'No folder chosen'}
              </div>
              <button type="button" className="btn" onClick={choose} disabled={busy}><FolderIcon size={16} /> Choose…</button>
            </div>
            <span className="faint" style={{ fontSize: 12 }}>A new folder with the vault’s name is created here. Any drive works, including external ones.</span>
          </div>

          <PasswordPair password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} min={min} />

          <ErrorBox error={error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
              {busy ? <Busy label="Creating vault…" /> : 'Create vault'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
