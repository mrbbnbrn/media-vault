import { useEffect, useMemo, useState } from 'react';
import { api, pickFolder, type VaultEntry } from '../api';
import type { Nav } from '../App';
import { beginStep, dropStep } from '../perf';
import { Busy, ErrorBox, OfflineFooter, TopBar } from '../components/Chrome';
import { PlayIcon } from '../components/Icons';
import { FolderIcon, LockIcon, PlusIcon } from '../components/Icons';
import { formatBytes } from '../theme';
import { pickAction, vaultBadge } from '../vaultpick';

export function Start({ nav, select }: { nav: Nav; select?: string }) {
  const { app } = nav;
  const initial = select ?? app.config.lastVault ?? app.vaults.find((v) => v.status === 'ready')?.path ?? app.vaults[0]?.path;
  const [selected, setSelected] = useState<string | undefined>(initial);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vault = useMemo(() => app.vaults.find((v) => v.path === selected), [app.vaults, selected]);
  useEffect(() => {
    setPassword('');
    setError(null);
  }, [selected]);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (!vault || !password) return;
    setBusy(true);
    setError(null);
    beginStep('Unlock', 'until the first page of the library shows');
    try {
      await api.unlock(vault.path, password);
      setPassword('');
      await nav.refresh();
      nav.go({ name: 'library' });
    } catch (err) {
      dropStep('Unlock');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** A vault without a password: open it right away (only when clicked). */
  async function openNow(v: VaultEntry) {
    setSelected(v.path);
    setBusy(true);
    setError(null);
    beginStep('Unlock', 'until the first page of the library shows');
    try {
      await api.openVault(v.path);
      await nav.refresh();
      nav.go({ name: 'library' });
    } catch (err) {
      dropStep('Unlock');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pick(v: VaultEntry) {
    if (busy) return;
    if (pickAction(v) === 'open') openNow(v);
    else setSelected(v.path);
  }

  async function openExisting() {
    setError(null);
    const path = await pickFolder('Choose a vault folder (the one containing vault.json)');
    if (!path) return;
    try {
      const entry = await api.addVault(path);
      await nav.refresh();
      setSelected(entry.path);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function forget(v: VaultEntry) {
    await api.forgetVault(v.path);
    const s = await nav.refresh();
    setSelected(s.vaults[0]?.path);
  }

  return (
    <>
      <TopBar>
        <button type="button" className="btn btn-sm" onClick={() => nav.go({ name: 'player' })}
          title="Play files and folders from your PC without opening a vault">
          <PlayIcon size={14} /> Open player
        </button>
      </TopBar>
      <div className="center">
        <section className="vaults" aria-label="Your vaults">
          <div className="eyebrow" style={{ marginBottom: 4 }}>Your vaults</div>
          {app.vaults.length === 0 && (
            <p className="muted" style={{ margin: '4px 0 8px', lineHeight: 1.6 }}>
              No vaults yet. Create one, or open a vault folder you already have.
            </p>
          )}
          {app.vaults.map((v) => (
            <button key={v.path} type="button" onClick={() => pick(v)}
              title={pickAction(v) === 'open' ? 'No password: click to open' : undefined}
              className={`vault${v.path === selected ? ' selected' : ''}${v.status !== 'ready' ? ' missing' : ''}`}
              aria-pressed={v.path === selected}>
              <span className="icon"><FolderIcon /></span>
              <span className="meta">
                <span className="name">{v.name}</span>
                <span className="path">{v.path}</span>
              </span>
              <span className="status">
                {v.status === 'ready' ? formatBytes(v.sizeBytes) : v.status === 'missing' ? 'Drive not connected' : 'Not a vault'}
              </span>
              {vaultBadge(v) === 'lock' && (
                <span className="vault-lock" aria-label="Has a password"><LockIcon size={14} /></span>
              )}
              {vaultBadge(v) === 'noPassword' && <span className="vault-nopw">No password</span>}
              {vaultBadge(v) === 'notEncrypted' && <span className="vault-nopw">Not encrypted</span>}
            </button>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn" style={{ flex: '1 1 160px' }} onClick={openExisting}>
              Open vault folder…
            </button>
            <button type="button" className="btn" style={{ flex: '1 1 160px' }} onClick={() => nav.go({ name: 'create' })}>
              <PlusIcon /> Create new vault
            </button>
          </div>
        </section>

        <section className="card unlock" aria-label="Unlock">
          {!vault ? (
            <>
              <div className="field" style={{ gap: 6 }}>
                <span className="muted" style={{ fontSize: 13 }}>Welcome</span>
                <h1 style={{ fontSize: 24 }}>Create your first vault</h1>
              </div>
              <p className="lead" style={{ fontSize: 14 }}>
                A vault is a folder where everything is encrypted. You choose where it lives and, if you like, its password.
              </p>
              <ErrorBox error={error} />
              <button type="button" className="btn btn-primary" onClick={() => nav.go({ name: 'create' })}>Create a vault</button>
            </>
          ) : vault.status !== 'ready' ? (
            <>
              <div className="field" style={{ gap: 6 }}>
                <span className="muted" style={{ fontSize: 13 }}>{vault.status === 'missing' ? 'Not connected' : 'Not a vault'}</span>
                <h1 style={{ fontSize: 24 }}>{vault.name}</h1>
              </div>
              <p className="lead" style={{ fontSize: 14 }}>
                {vault.status === 'missing'
                  ? 'This vault’s folder can’t be found. If it’s on an external drive, plug it in and it will appear here.'
                  : 'This folder no longer contains a Media Vault.'}
              </p>
              <ErrorBox error={error} />
              <div className="row">
                <button type="button" className="btn" onClick={() => nav.refresh()}>Check again</button>
                <button type="button" className="btn" onClick={() => forget(vault)}>Remove from list</button>
              </div>
            </>
          ) : vault.passwordless ? (
            <>
              <div className="field" style={{ gap: 6 }}>
                <span className="muted" style={{ fontSize: 13 }}>No password</span>
                <h1 style={{ fontSize: 26 }}>{vault.name}</h1>
              </div>
              <p className="lead" style={{ fontSize: 14 }}>
                This vault opens without a password. Click it in the list, or here.
              </p>
              <ErrorBox error={error} />
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => openNow(vault)}>
                {busy ? <Busy label="Opening…" /> : 'Open'}
              </button>
              <div className="row-between">
                <span />
                <button type="button" className="link" style={{ color: 'var(--faint)' }} onClick={() => forget(vault)}>
                  Remove from list
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={unlock} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div className="field" style={{ gap: 6 }}>
                <span className="muted" style={{ fontSize: 13 }}>Unlock</span>
                <h1 style={{ fontSize: 26 }}>{vault.name}</h1>
              </div>
              <div className="field">
                <label htmlFor="pw">Password</label>
                <input id="pw" className="input" type="password" autoFocus autoComplete="current-password"
                  value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
              </div>
              <ErrorBox error={error} />
              <button type="submit" className="btn btn-primary" disabled={busy || !password}>
                {busy ? <Busy label="Unlocking…" /> : 'Unlock'}
              </button>
              <div className="row-between">
                <button type="button" className="link" onClick={() => nav.go({ name: 'recover', path: vault.path })}>
                  Use recovery key instead
                </button>
                <button type="button" className="link" style={{ color: 'var(--faint)' }} onClick={() => forget(vault)}>
                  Remove from list
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
      <OfflineFooter />
    </>
  );
}
