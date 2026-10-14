// Safety tools: export decrypted copies, check for damage, login history.

import { useState } from 'react';
import { api, pickFolder, type DamageReport, type ExportRequest, type LoginInfo } from '../api';
import { dismissCheck, dismissExport, startExport, useTasks } from '../tasks';
import { formatBytes } from '../theme';
import { plural } from '../undo';
import { Modal } from './Dialogs';
import { ExportIcon, ShieldIcon, WarnIcon } from './Icons';
import { ShareTaskCards } from './ShareDialog';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Asks where to export, after a clear warning that the copies are not encrypted. */
export function ExportDialog(props: { request: Omit<ExportRequest, 'dest'>; what: string; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setErr(null);
    const dest = await pickFolder('Export decrypted copies to…');
    if (!dest) return;
    setBusy(true);
    try {
      await startExport({ ...props.request, dest });
      props.onClose();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Export ${props.what}`} onClose={props.onClose}>
      <div className="notice row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <WarnIcon size={18} />
        <span>
          The exported copies are <b>ordinary, unencrypted files</b>. Anyone who can open that folder can see them.
          Your vault itself stays as it is.
        </span>
      </div>
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
        A new folder is made inside the folder you choose, with the original file names
        {props.request.ids?.length ? '' : ' and the same folders as in the vault'}. Items in the trash are not exported.
      </p>
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={go}><ExportIcon /> Choose folder and export</button>
      </div>
    </Modal>
  );
}

export function DamageReportView(props: { report: DamageReport; onTrashed?: () => void }) {
  const r = props.report;
  const [moved, setMoved] = useState(false);
  const live = r.damaged.filter((d) => !d.inTrash);
  return (
    <div className="damage">
      {r.cancelled && <p className="faint">Stopped early — only part of the vault was checked.</p>}
      {r.damaged.length === 0 && r.backupsBad.length === 0 ? (
        <p className="row" style={{ gap: 8 }}><ShieldIcon size={18} /> <b>Everything is fine.</b></p>
      ) : (
        <p className="row" style={{ gap: 8, color: 'var(--danger)' }}><WarnIcon size={18} /> <b>Some damage was found.</b></p>
      )}
      <p className="muted" style={{ fontSize: 13 }}>
        Checked {plural(r.itemsChecked, 'item')} ({formatBytes(r.bytesChecked)}) in {Math.max(1, Math.round(r.seconds))} s.
        {' '}{plural(r.backupsOk, 'library backup')} OK{r.backupsBad.length ? `, ${r.backupsBad.length} damaged` : ''}.
        {r.thumbsRedone > 0 && ` ${plural(r.thumbsRedone, 'damaged thumbnail')} will be made again.`}
      </p>
      {r.damaged.length > 0 && (
        <>
          <div className="damage-list">
            {r.damaged.map((d) => (
              <div key={d.id} className="row-between">
                <span className="ellipsis"><b>{d.name}</b> <span className="faint">in {d.location}{d.inTrash ? ' (in the trash)' : ''}</span></span>
                <span className="faint" style={{ fontSize: 12 }}>{d.problem}</span>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            These can't be opened any more. If you still have the original files, import them again.
            A copy of the vault folder on another drive (a backup) would also have them.
          </p>
          {live.length > 0 && (
            <button type="button" className="btn btn-sm" disabled={moved} onClick={async () => {
              await api.deleteItems(live.map((d) => d.id));
              setMoved(true);
              props.onTrashed?.();
            }}>{moved ? 'Moved to the trash' : `Move ${plural(live.length, 'damaged item')} to the trash`}</button>
          )}
        </>
      )}
      {r.backupsBad.length > 0 && (
        <p className="muted" style={{ fontSize: 13 }}>Damaged library backups: {r.backupsBad.join(', ')}. A fresh backup is made every time the library is saved.</p>
      )}
    </div>
  );
}

/** Progress cards for the corner of the library. */
export function TaskCards() {
  const t = useTasks();
  const [showReport, setShowReport] = useState(false);
  return (
    <>
      {t.checkResult && (
        <div className="icard">
          <div className="row-between">
            <b>{'error' in t.checkResult ? 'Check stopped' : t.checkResult.report.damaged.length ? 'Damage found' : 'No damage found'}</b>
            <span className="row" style={{ gap: 10 }}>
              {'report' in t.checkResult && <button type="button" className="link" onClick={() => setShowReport(true)}>Details</button>}
              <button type="button" className="link" onClick={dismissCheck}>Dismiss</button>
            </span>
          </div>
          {'error' in t.checkResult && <span style={{ fontSize: 13 }}>{t.checkResult.error}</span>}
        </div>
      )}
      {t.exportDone && (
        <div className="icard">
          <div className="row-between">
            <b>{t.exportDone.error ? 'Export failed' : t.exportDone.cancelled ? 'Export stopped' : 'Export finished'}</b>
            <button type="button" className="link" onClick={dismissExport}>Dismiss</button>
          </div>
          <span style={{ fontSize: 13 }}>
            {t.exportDone.error ?? `${plural(t.exportDone.exported, 'file')} (${formatBytes(t.exportDone.bytes)}) written to ${t.exportDone.folder}`}
            {t.exportDone.failed.length > 0 && ` · ${t.exportDone.failed.length} couldn't be exported (${t.exportDone.failed.slice(0, 3).map((f) => f[0]).join(', ')}${t.exportDone.failed.length > 3 ? '…' : ''})`}
          </span>
        </div>
      )}
      {!t.shareWatched && <ShareTaskCards />}
      {showReport && t.checkResult && 'report' in t.checkResult && (
        <Modal title="Check for damage" wide onClose={() => setShowReport(false)}>
          <DamageReportView report={t.checkResult.report} />
        </Modal>
      )}
    </>
  );
}

export function hasTaskCards(t: ReturnType<typeof useTasks>) {
  // Progress shows in the background-jobs ring (ActivityRing); only results get a card.
  return !!(t.checkResult || t.exportDone || (!t.shareWatched && t.shareDone));
}

function when(sec: number) {
  return new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Shown once after unlocking: when the vault was last opened, and wrong passwords since. */
export function LoginBanner(props: { login: LoginInfo; onClose: () => void }) {
  const { last, failed } = props.login;
  if (!last && !failed.length) return null;
  const bad = failed.length > 0;
  return (
    <div className={`${bad ? 'notice' : 'info'} row-between`} role="status">
      <span>
        {last ? <>Last opened {when(last.at)} on <b>{last.computer}</b>.</> : 'First time this vault is opened here.'}
        {bad && (
          <> {' '}<b>{plural(failed.length, 'wrong password')}</b> {failed.length > 1 ? 'were' : 'was'} tried since then
            (latest {when(failed[failed.length - 1])}).</>
        )}
      </span>
      <button type="button" className="link" onClick={props.onClose}>Dismiss</button>
    </div>
  );
}
