// Dialogs for organising: merging folders, deleting originals that have free
// copies, and notes.

import { useState } from 'react';
import { api, thumbUrl, type FolderCard, type Item, type Merged } from '../api';
import { formatBytes } from '../theme';
import { plural } from '../undo';
import { Modal } from './Dialogs';
import { FolderIcon } from './Icons';

/** Merge several folders into one of them; asks about identical files first. */
export function MergeDialog(props: { folders: FolderCard[]; onClose: () => void; onDone: (m: Merged, target: FolderCard, sources: FolderCard[]) => void }) {
  const [target, setTarget] = useState(props.folders[0]?.id);
  const [groups, setGroups] = useState<Item[][] | null>(null);
  const [mode, setMode] = useState<'all' | 'one' | 'choose'>('one');
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tgt = props.folders.find((f) => f.id === target)!;
  const sources = props.folders.filter((f) => f.id !== target);

  const next = async () => {
    setBusy(true);
    setErr(null);
    try {
      const g = await api.mergePlan(target, sources.map((f) => f.id));
      if (!g.length) return await run([]);
      setGroups(g);
      setMarked(new Set(g.flatMap((x) => x.slice(1).map((i) => i.id))));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const run = async (trash: number[]) => {
    setBusy(true);
    try {
      const m = await api.mergeFolders(target, sources.map((f) => f.id), trash);
      props.onDone(m, tgt, sources);
      props.onClose();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };
  const finish = () => {
    if (!groups) return;
    const trash = mode === 'all' ? [] : mode === 'one' ? groups.flatMap((g) => g.slice(1).map((i) => i.id)) : [...marked];
    run(trash);
  };

  if (!groups) {
    return (
      <Modal title={`Merge ${plural(props.folders.length, 'folder')}`} onClose={props.onClose}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>Which folder should the others go into? Folders with the same name inside are merged too.</p>
        <div className="picker" role="radiogroup" aria-label="Merge into">
          {props.folders.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={f.id === target} className={`picker-row${f.id === target ? ' on' : ''}`} onClick={() => setTarget(f.id)}>
              <FolderIcon size={15} /> {f.name}<span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{plural(f.items, 'item')}</span>
            </button>
          ))}
        </div>
        {err && <div className="error" role="alert">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={next}>{busy ? 'Checking…' : `Merge into “${tgt?.name}”`}</button>
        </div>
      </Modal>
    );
  }
  const n = groups.reduce((a, g) => a + g.length - 1, 0);
  return (
    <Modal title="Identical files" onClose={props.onClose} wide>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        {plural(groups.length, 'file')} would end up twice (or more) in the same folder after merging. What should happen to the extra {plural(n, 'copy', 'copies')}?
      </p>
      <div className="stack" style={{ gap: 6 }} role="radiogroup">
        <label className="check"><input type="radio" checked={mode === 'one'} onChange={() => setMode('one')} /> Keep one, move the rest to the trash <span className="faint">(the best one stays)</span></label>
        <label className="check"><input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} /> Keep all of them</label>
        <label className="check"><input type="radio" checked={mode === 'choose'} onChange={() => setMode('choose')} /> Let me choose</label>
      </div>
      {mode === 'choose' && (
        <div className="stack" style={{ gap: 8, maxHeight: '44vh', overflow: 'auto' }}>
          {groups.map((g) => (
            <div key={g[0].id} className="look-row">
              {g.map((it) => {
                const on = marked.has(it.id);
                return (
                  <button key={it.id} type="button" className={`look-tile small${on ? ' marked' : ''}`} aria-pressed={on} title={it.name}
                    onClick={() => setMarked((m) => { const x = new Set(m); if (x.has(it.id)) x.delete(it.id); else x.add(it.id); return x; })}>
                    {it.thumb === 'ok' ? <img src={thumbUrl(it.id)} alt="" /> : <span className="tile-msg">{it.name}</span>}
                    {on && <span className="look-mark">Trash</span>}
                    <span className="look-meta">{it.name} · {formatBytes(it.size)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {err && <div className="error" role="alert">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={busy} onClick={finish}>Merge</button>
      </div>
    </Modal>
  );
}

/** Deleting originals that have free copies: delete them too, or make one the new original. */
export function DeleteOriginalDialog(props: {
  groups: [Item, Item[]][];
  folderName?: (id: number | null) => string;
  onCancel: () => void;
  onChoice: (choice: { mode: 'all' } | { mode: 'promote'; picks: Map<number, number> }) => void;
}) {
  const [mode, setMode] = useState<'all' | 'promote'>('promote');
  const [picks, setPicks] = useState(() => new Map(props.groups.map(([o, c]) => [o.id, c[0].id])));
  const copies = props.groups.reduce((a, [, c]) => a + c.length, 0);
  const one = props.groups.length === 1;
  return (
    <Modal title={one ? `“${props.groups[0][0].name}” has ${plural(copies, 'free copy', 'free copies')}` : `${plural(props.groups.length, 'item')} you're deleting have free copies`} onClose={props.onCancel}>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>Free copies use the original's stored file. What should happen to them?</p>
      <div className="stack" style={{ gap: 6 }}>
        <label className="check"><input type="radio" checked={mode === 'promote'} onChange={() => setMode('promote')} /> Make a free copy the new original <span className="faint">(the other copies link to it)</span></label>
        {mode === 'promote' && props.groups.map(([o, cs]) => (
          <div key={o.id} className="row" style={{ gap: 8, paddingLeft: 30 }}>
            {!one && <span className="ellipsis faint" style={{ maxWidth: 180, fontSize: 13 }}>{o.name}:</span>}
            <select className="input" style={{ minHeight: 34 }} value={picks.get(o.id)} aria-label={`New original for ${o.name}`}
              onChange={(e) => setPicks((p) => new Map(p).set(o.id, Number(e.target.value)))}>
              {cs.map((c) => <option key={c.id} value={c.id}>{c.name} — in {props.folderName ? props.folderName(c.folderId) : c.folderId == null ? 'Top level' : 'a folder'}</option>)}
            </select>
          </div>
        ))}
        <label className="check"><input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} /> Delete the free copies too</label>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger-solid" data-autofocus
          onClick={() => props.onChoice(mode === 'all' ? { mode: 'all' } : { mode: 'promote', picks })}>Delete</button>
      </div>
    </Modal>
  );
}

/** A note on an item or folder. */
export function NoteDialog(props: { name: string; note: string | null; onClose: () => void; onSave: (note: string | null) => Promise<void> }) {
  const [v, setV] = useState(props.note ?? '');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await props.onSave(v.trim() || null);
      props.onClose();
    } catch (e) {
      setErr(String(e));
    }
  };
  return (
    <Modal title={`Note · ${props.name}`} onClose={props.onClose}>
      <textarea className="input" style={{ minHeight: 140, padding: 10, resize: 'vertical', fontFamily: 'inherit' }} value={v} autoFocus
        aria-label="Note" placeholder="Anything you want to remember about it. Notes are found by search."
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) save(); }} />
      {err && <div className="error" role="alert">{err}</div>}
      <div className="row-between">
        <span className="faint" style={{ fontSize: 12 }}>Ctrl+Enter saves</span>
        <span className="row" style={{ gap: 8 }}>
          {props.note && <button type="button" className="btn" onClick={() => { setV(''); props.onSave(null).then(props.onClose); }}>Remove note</button>}
          <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save}>Save</button>
        </span>
      </div>
    </Modal>
  );
}
