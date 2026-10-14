// "Share as encrypted .7z…": put the chosen items and folders into a
// password-protected 7z archive that 7-Zip (and most archive tools) can open.

import { useEffect, useState } from 'react';
import { api, pickSave7z, type ShareDone } from '../api';
import { dismissShare, startShare, useTasks, watchShare } from '../tasks';
import { formatBytes } from '../theme';
import { plural } from '../undo';
import { Modal } from './Dialogs';
import { LockIcon } from './Icons';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MiB = 1024 * 1024;

type Split = 'none' | '700' | '1024' | '4092' | 'custom';
const SPLITS: { value: Split; label: string }[] = [
  { value: 'none', label: 'No — one file' },
  { value: '700', label: '700 MB parts' },
  { value: '1024', label: '1 GB parts' },
  // 4092 MB (like 7-Zip) so each part still fits on a FAT32 USB stick.
  { value: '4092', label: '4 GB parts' },
  { value: 'custom', label: 'Custom size…' },
];

const LEVELS: { value: number; label: string }[] = [
  { value: 0, label: 'Store — fastest' },
  { value: 3, label: 'Fast' },
  { value: 5, label: 'Normal' },
  { value: 7, label: 'Maximum' },
];

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function doneText(d: ShareDone) {
  return `${plural(d.files, 'file')}, ${formatBytes(d.archiveBytes)}`;
}

/** Asks for a place, a password and a few options, then makes the archive. */
export function ShareDialog(props: { ids: number[]; folders: number[]; what: string; onClose: () => void }) {
  const t = useTasks();
  const [dest, setDest] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [encryptNames, setEncryptNames] = useState(true);
  const [level, setLevel] = useState(0);
  const [split, setSplit] = useState<Split>('none');
  const [customMb, setCustomMb] = useState('100');
  const [keepStructure, setKeepStructure] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  // While this window is open it shows the progress, so the corner card stays hidden.
  useEffect(() => {
    watchShare(true);
    return () => watchShare(false);
  }, []);

  const running = started && (t.shareStarting || !!t.sharing);
  const done = started && !running ? t.shareDone : null;

  // A problem (wrong folder, name taken, …): back to the form so it can be fixed.
  useEffect(() => {
    if (done?.error) {
      setErr(done.error);
      setStarted(false);
      dismissShare();
    }
  }, [done]);

  const close = () => {
    if (done) dismissShare();
    props.onClose();
  };

  const choose = async () => {
    const p = await pickSave7z('Save the archive as…', dest ? fileName(dest) : 'Shared.7z');
    if (p) setDest(p);
  };

  const splitBytes = (): number | null | 'bad' => {
    if (split === 'none') return null;
    if (split === 'custom') {
      const mb = Number(customMb);
      return Number.isFinite(mb) && mb >= 1 ? Math.round(mb * MiB) : 'bad';
    }
    return Number(split) * MiB;
  };

  const go = async () => {
    setErr(null);
    if (!dest.trim()) return setErr('Please choose where to save the archive.');
    if (!pw) return setErr('Please choose a password.');
    if (pw !== pw2) return setErr("The two passwords don't match.");
    const sb = splitBytes();
    if (sb === 'bad') return setErr('Please enter a part size of at least 1 MB.');
    try {
      setStarted(true);
      await startShare({ ids: props.ids, folders: props.folders, dest: dest.trim(), password: pw, encryptNames, level, splitBytes: sb, keepStructure });
    } catch (e) {
      setStarted(false);
      setErr(errText(e));
    }
  };

  const title = `Share ${props.what} as an encrypted .7z`;

  if (running) {
    const p = t.sharing;
    return (
      <Modal title={title} onClose={close}>
        <div className="stack">
          <span>Making the archive…</span>
          <div className="bar"><div style={{ width: `${p?.totalBytes ? (p.bytes / p.totalBytes) * 100 : 0}%` }} /></div>
          <span className="mono faint ellipsis" style={{ fontSize: 12 }}>
            {p ? `${p.done.toLocaleString()} / ${p.total.toLocaleString()}${p.name ? ` · ${p.name}` : ''}` : 'starting…'}
          </span>
          <p className="faint" style={{ fontSize: 13, margin: 0 }}>You can close this window — it keeps going in the corner.</p>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn" onClick={() => api.cancelTask('share')}>Cancel</button>
          </div>
        </div>
      </Modal>
    );
  }

  if (done) {
    return (
      <Modal title={title} onClose={close}>
        <div className="stack">
          {done.cancelled ? (
            <span>Cancelled. Nothing was saved.</span>
          ) : (
            <>
              <span><b>Done</b> — {doneText(done)}</span>
              <span className="muted" style={{ fontSize: 13, wordBreak: 'break-all' }}>
                {done.parts.length === 1 ? `Saved as ${done.parts[0]}` : `Saved in ${done.parts.length} parts: ${fileName(done.parts[0])} … ${fileName(done.parts[done.parts.length - 1])}. Keep all the parts together; open the .001 file to unpack.`}
              </span>
              {done.failed.length > 0 && (
                <span className="faint" style={{ fontSize: 13 }}>
                  {plural(done.failed.length, 'item')} couldn't be read and {done.failed.length === 1 ? 'was' : 'were'} left out:{' '}
                  {done.failed.slice(0, 3).map((f) => f[0]).join(', ')}{done.failed.length > 3 ? '…' : ''}
                </span>
              )}
              <span className="faint" style={{ fontSize: 13 }}>Send the password separately — not in the same message as the archive.</span>
            </>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-primary" onClick={close}>Close</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={close}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <div className="field">
          <label htmlFor="sh-dest">Save as</label>
          <div className="row" style={{ gap: 8 }}>
            <input id="sh-dest" className="input" style={{ flex: 1, minWidth: 0 }} placeholder="Choose a place and a name…"
              value={dest} onChange={(e) => setDest(e.target.value)} />
            <button type="button" className="btn" onClick={choose}>Choose…</button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="sh-pw">Password</label>
          <input id="sh-pw" className="input" type={showPw ? 'text' : 'password'} autoComplete="new-password" autoFocus
            value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sh-pw2">Type it again</label>
          <input id="sh-pw2" className="input" type={showPw ? 'text' : 'password'} autoComplete="new-password"
            value={pw2} onChange={(e) => setPw2(e.target.value)} />
          {pw2 && pw !== pw2 && <span style={{ fontSize: 12, color: 'var(--warn)' }}>The two passwords don't match yet.</span>}
        </div>
        <label className="check">
          <input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} /> Show password
        </label>

        <div className="row faint" style={{ gap: 8, fontSize: 13 }}>
          <LockIcon size={14} /> Encryption: AES-256
        </div>
        <label className="check">
          <input type="checkbox" checked={encryptNames} onChange={(e) => setEncryptNames(e.target.checked)} />
          <span>Encrypt file names <span className="faint" style={{ fontSize: 12 }}>— nobody can see what's inside without the password</span></span>
        </label>
        <label className="check">
          <input type="checkbox" checked={keepStructure} onChange={(e) => setKeepStructure(e.target.checked)} />
          <span>Keep folder structure <span className="faint" style={{ fontSize: 12 }}>— otherwise everything goes side by side</span></span>
        </label>

        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="sh-level">Compression</label>
            <select id="sh-level" className="input" value={level} onChange={(e) => setLevel(Number(e.target.value))}>
              {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
            <span className="faint" style={{ fontSize: 12 }}>Pictures and videos are already compressed, so more compression is slower but barely smaller.</span>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="sh-split">Split into parts</label>
            <select id="sh-split" className="input" value={split} onChange={(e) => setSplit(e.target.value as Split)}>
              {SPLITS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            {split === 'custom' && (
              <div className="row" style={{ gap: 8 }}>
                <input className="input" type="number" min={1} aria-label="Part size in MB" style={{ width: 120 }}
                  value={customMb} onChange={(e) => setCustomMb(e.target.value)} />
                <span className="faint">MB each</span>
              </div>
            )}
          </div>
        </div>

        {err && <div className="error">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn-primary">Make archive</button>
        </div>
      </form>
    </Modal>
  );
}

/** Corner cards for a share that runs while its window is closed. */
export function ShareTaskCards() {
  const t = useTasks();
  return (
    <>
      {(t.sharing || t.shareStarting) && (
        <div className="icard">
          <div className="row-between">
            <b>Making encrypted archive</b>
            <button type="button" className="link" onClick={() => api.cancelTask('share')}>Stop</button>
          </div>
          <div className="bar"><div style={{ width: `${t.sharing?.totalBytes ? (t.sharing.bytes / t.sharing.totalBytes) * 100 : 0}%` }} /></div>
          <span className="mono faint ellipsis" style={{ fontSize: 12 }}>
            {t.sharing ? `${t.sharing.done.toLocaleString()} / ${t.sharing.total.toLocaleString()} · ${t.sharing.name}` : 'starting…'}
          </span>
        </div>
      )}
      {t.shareDone && (
        <div className="icard">
          <div className="row-between">
            <b>{t.shareDone.error ? 'Archive not made' : t.shareDone.cancelled ? 'Archive cancelled' : 'Archive ready'}</b>
            <button type="button" className="link" onClick={dismissShare}>Dismiss</button>
          </div>
          <span style={{ fontSize: 13 }}>
            {t.shareDone.error ?? (t.shareDone.cancelled ? 'Nothing was saved.' : `${doneText(t.shareDone)} · ${fileName(t.shareDone.parts[0] ?? '')}${t.shareDone.parts.length > 1 ? ` (+${t.shareDone.parts.length - 1} more parts)` : ''}`)}
          </span>
        </div>
      )}
    </>
  );
}
