// Settings → Vault & password → Encryption: turn the vault's encryption off
// (asks for the current password when it has one) or on (a new password, or
// none; then the new recovery key is shown once). The change runs in the
// background with progress and Pause (encryptionjob.ts); while it runs, or
// if it was paused, the vault reads normally.

import { useState } from 'react';
import { api } from '../api';
import type { Nav } from '../App';
import { encryptionStarted, useEncryption } from '../encryptionjob';
import { Busy, ErrorBox, PasswordPair, passwordsOk } from './Chrome';
import { ConfirmDialog, Modal } from './Dialogs';
import { WarnIcon } from './Icons';

export function EncryptionSection({ nav }: { nav: Nav }) {
  const min = nav.app.minPasswordChars;
  const s = nav.app.session;
  const job = useEncryption();
  const encrypted = s?.encrypted !== false;
  const converting = s?.converting ?? null;
  const running = job.to != null;
  const [ask, setAsk] = useState<'off' | 'on' | null>(null);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [noPassword, setNoPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const close = () => {
    setAsk(null);
    setCurrent('');
    setPassword('');
    setConfirm('');
    setErr(null);
    setBusy(false);
  };

  async function turnOn() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.encryptionOn(noPassword ? null : password);
      encryptionStarted('encrypted');
      close();
      await nav.refresh();
      nav.go({ name: 'words', words: r.words, context: 'encrypt' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const progress = running && job.total > 0 ? Math.round((job.done / job.total) * 100) : null;
  return (
    <section className="section" style={{ maxWidth: 560 }}>
      <h2>Encryption</h2>
      {converting || running ? (
        <>
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            {(job.to ?? converting) === 'plain'
              ? 'Removing the encryption: your files become ordinary files in the vault’s Files folder.'
              : 'Encrypting the vault: your files are moved back into the encrypted storage.'}{' '}
            You can keep using the vault meanwhile. If it's paused or the app is closed, it carries on next time.
          </p>
          {running ? (
            <div className="row" style={{ gap: 12, alignItems: 'center' }} role="status">
              <div className="bar" style={{ flex: 1 }}><div style={{ width: `${progress ?? 0}%` }} /></div>
              <span className="faint mono" style={{ fontSize: 12 }}>{job.total ? `${job.done.toLocaleString()} of ${job.total.toLocaleString()}` : 'Starting…'}</span>
              <button type="button" className="btn btn-sm" onClick={() => void api.encryptionStop()}>Pause</button>
            </div>
          ) : (
            <div className="row" style={{ gap: 12 }}>
              <button type="button" className="btn btn-primary" onClick={async () => {
                if (await api.encryptionContinue().catch(() => false)) encryptionStarted(converting!);
              }}>Continue</button>
            </div>
          )}
        </>
      ) : encrypted ? (
        <>
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            This vault is <b>encrypted</b>: without {s?.hasPassword === false ? 'the vault folder’s key' : 'the password'} nobody can see what's in it.
          </p>
          <div>
            <button type="button" className="btn" onClick={() => setAsk('off')}>Turn encryption off…</button>
          </div>
        </>
      ) : (
        <>
          <div className="notice" role="note">
            <WarnIcon />
            <span>This vault is <b>not encrypted</b>. Anyone who can open its folder can see your files, folders, tags and faces.</span>
          </div>
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            Your files are ordinary files in the vault’s <b>Files</b> folder, in folders named like yours (items in the
            trash are in Files\.trash). Don't move or rename them there: do it in the app and they follow.
          </p>
          <div className="row" style={{ gap: 10 }}>
            <button type="button" className="btn btn-primary" onClick={() => setAsk('on')}>Encrypt this vault…</button>
            <button type="button" className="btn" onClick={() => void api.openFilesFolder().catch(() => {})}>Open the Files folder</button>
          </div>
        </>
      )}
      {job.result && !running && (
        <div className={job.result.ok ? 'info' : 'error'} role="status">{job.result.message}</div>
      )}

      {ask === 'off' && (
        <ConfirmDialog title="Turn encryption off?" confirm="Turn encryption off" danger onClose={close}
          onConfirm={async () => {
            await api.encryptionOff(s?.hasPassword === false ? null : current);
            encryptionStarted('plain');
            close();
            await nav.refresh();
          }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span>
              Every file in the vault is decrypted and kept as an ordinary file in its <b>Files</b> folder, in folders
              named like yours. Thumbnails, faces, tags and everything else stay as they are, just not encrypted.
            </span>
            <span>
              The password and the recovery key are removed: <b>anyone who can open the folder can see everything</b>.
              It runs in the background and takes a while for a big vault (it needs about 1 GB of free space).
            </span>
            {s?.hasPassword !== false && (
              <div className="field">
                <label htmlFor="enc-cur">Current password</label>
                <input id="enc-cur" className="input" type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
              </div>
            )}
          </div>
        </ConfirmDialog>
      )}
      {ask === 'on' && (
        <Modal title="Encrypt this vault" onClose={close}>
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            Every file is moved back into the vault's encrypted storage (the Files folder goes) and everything else is
            encrypted too. It runs in the background. Then you get a new recovery key to write down.
          </p>
          <label className="check">
            <input type="checkbox" checked={noPassword} onChange={(e) => setNoPassword(e.target.checked)} />
            No password (opens without asking; anyone with the folder can still open it)
          </label>
          {!noPassword && <PasswordPair password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} min={min} label="New password" />}
          <ErrorBox error={err} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy || (!noPassword && !passwordsOk(password, confirm, min))} onClick={() => void turnOn()}>
              {busy ? <Busy label="Starting…" /> : 'Encrypt'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
