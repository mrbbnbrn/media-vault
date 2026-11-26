// Deleting folders that hold favourites or free copies: keep those (and the
// folders holding them) or delete everything. foldertrash.rs does the work.

import { useState } from 'react';
import type { FoldersProtected } from '../api';
import { protectedText } from '../folderkeep';
import { errText } from '../text';
import { Modal } from './Dialogs';

export function FolderKeepDialog(props: {
  title: string;
  /** How many folders are being deleted (for the wording). */
  folders: number;
  keep: FoldersProtected;
  /** Extra line (e.g. the folders' names). */
  lead?: string;
  onKeep: () => Promise<void> | void;
  onDeleteAll: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (f: () => Promise<void> | void) => {
    setBusy(true);
    try {
      await f();
      props.onClose();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
        {props.lead && <>{props.lead} </>}
        <strong>{protectedText(props.keep, props.folders)}</strong>
        <br />
        Keep them: everything else goes to the trash; they stay where they are, and so do the folders holding them.
        Delete all: everything goes to the trash. Either way you can restore from the trash for 30 days, or press Ctrl+Z right away.
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }} onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const bs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const i = bs.indexOf(document.activeElement as HTMLButtonElement);
        const n = bs[Math.max(0, Math.min(bs.length - 1, (i < 0 ? bs.length - 1 : i) + (e.key === 'ArrowLeft' ? -1 : 1)))];
        if (n) {
          e.preventDefault();
          n.focus();
        }
      }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void run(props.onDeleteAll)}>Delete all</button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={busy} onClick={() => void run(props.onKeep)}>Keep them</button>
      </div>
    </Modal>
  );
}
