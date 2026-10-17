// "Separate pictures without faces…" (folder / person folder right-click):
// the folder's pictures (subfolders too, by default; GIFs and videos if
// ticked) sorted by what the face scan found, a preview of the ones that
// would go (click one to leave it out), then moved or free-copied into a new
// folder inside this one or any folder. Pictures not scanned yet are never
// counted as faceless ("Scan them now" scans them; the counts follow).
// The other way round too: move the ones with faces. One Ctrl+Z undoes it.

import { useEffect, useMemo, useState } from 'react';
import { api, thumbUrl, type FaceSplit, type FolderCard, type Item } from '../api';
import { plural } from '../undo';
import { ErrorBox } from './Chrome';
import { Modal } from './Dialogs';

export type SeparateTarget = { newName: string } | { id: number | null };

export function SeparateFaces(props: {
  folder: { id: number; name: string };
  folders: FolderCard[];
  onScan: (ids: number[]) => Promise<void>;
  onApply: (items: Item[], target: SeparateTarget, copy: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [subfolders, setSubfolders] = useState(true);
  const [moving, setMoving] = useState(false);
  const [poorAsNone, setPoorAsNone] = useState(true);
  const [which, setWhich] = useState<'without' | 'with'>('without');
  const [dest, setDest] = useState<'new' | 'pick'>('new');
  const [newName, setNewName] = useState('No faces');
  const [picked, setPicked] = useState<number | null | undefined>(undefined);
  const [copy, setCopy] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [split, setSplit] = useState<FaceSplit | null>(null);
  const [left, setLeft] = useState<Set<number>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The items, and how the face scan sorted them.
  useEffect(() => {
    let live = true;
    setItems(null);
    setSplit(null);
    void (async () => {
      try {
        const list = await api.queryItems({ folder: props.folder.id, recursive: subfolders, kinds: moving ? ['image', 'gif', 'video'] : ['image'] });
        const sp = list.length ? await api.facesSplit(list.map((i) => i.id)) : { withFaces: [], noFaces: [], onlyPoor: [], unscanned: [] };
        if (!live) return;
        setItems(list);
        setSplit(sp);
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [subfolders, moving, props.folder.id]);

  // While scanning: the counts follow.
  useEffect(() => {
    if (!scanning || !items) return;
    const t = setInterval(() => {
      void api.facesSplit(items.map((i) => i.id)).then((sp) => {
        setSplit(sp);
        if (!sp.unscanned.length) setScanning(false);
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [scanning, items]);

  useEffect(() => {
    setNewName((n) => (n === 'No faces' || n === 'With faces' ? (which === 'without' ? 'No faces' : 'With faces') : n));
  }, [which]);

  const chosen = useMemo(() => {
    if (!items || !split) return [];
    const ids = new Set(which === 'without' ? [...split.noFaces, ...(poorAsNone ? split.onlyPoor : [])] : [...split.withFaces, ...(poorAsNone ? [] : split.onlyPoor)]);
    return items.filter((i) => ids.has(i.id));
  }, [items, split, which, poorAsNone]);
  const going = chosen.filter((i) => !left.has(i.id));
  const toggle = (id: number) => setLeft((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const destOk = dest === 'new' ? newName.trim().length > 0 : picked !== undefined;
  const destName = dest === 'new' ? `“${newName.trim()}” (new, inside “${props.folder.name}”)` : picked === null ? 'Top level' : `“${props.folders.find((f) => f.id === picked)?.name ?? 'folder'}”`;

  return (
    <Modal title={`Separate pictures · “${props.folder.name}”`} onClose={props.onClose} wide>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        <label className="check"><input type="checkbox" checked={subfolders} onChange={(e) => setSubfolders(e.target.checked)} /> Include subfolders</label>
        <label className="check"><input type="checkbox" checked={moving} onChange={(e) => setMoving(e.target.checked)} /> Include GIFs and videos</label>
        <label className="check"><input type="checkbox" checked={poorAsNone} onChange={(e) => setPoorAsNone(e.target.checked)} /> Count only poor faces as no faces</label>
      </div>
      {split && items && (
        <div className="faint" style={{ fontSize: 13 }}>
          {plural(split.withFaces.length, 'with faces', 'with faces')} · {plural(split.noFaces.length, 'without faces', 'without faces')} · {plural(split.onlyPoor.length, 'with only poor faces', 'with only poor faces')}
          {split.unscanned.length > 0 && <> · {plural(split.unscanned.length, 'not scanned yet', 'not scanned yet')} (left where they are) </>}
          {split.unscanned.length > 0 && (
            <button type="button" className="link" disabled={scanning} onClick={async () => { setScanning(true); await props.onScan(split.unscanned); }}>
              {scanning ? 'Scanning…' : 'Scan them now'}
            </button>
          )}
        </div>
      )}
      <div role="radiogroup" aria-label="Which ones" className="row" style={{ gap: 18 }}>
        <label className="check"><input type="radio" name="sep-which" checked={which === 'without'} onChange={() => { setWhich('without'); setLeft(new Set()); }} /> Move the ones without faces</label>
        <label className="check"><input type="radio" name="sep-which" checked={which === 'with'} onChange={() => { setWhich('with'); setLeft(new Set()); }} /> Move the ones with faces</label>
      </div>
      {!items || !split ? (
        <div className="faint">Looking at the faces found…</div>
      ) : chosen.length === 0 ? (
        <div className="faint">None here.</div>
      ) : (
        <>
          <div className="faint" style={{ fontSize: 12 }}>Click a picture to leave it where it is.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 6, maxHeight: 280, overflow: 'auto' }}>
            {chosen.map((i) => (
              <button key={i.id} type="button" title={left.has(i.id) ? `${i.name} (stays)` : i.name} onClick={() => toggle(i.id)}
                style={{ padding: 0, border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden', aspectRatio: '1', background: 'var(--panel)', cursor: 'pointer', opacity: left.has(i.id) ? 0.3 : 1, position: 'relative' }}>
                <img src={thumbUrl(i.id)} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              </button>
            ))}
          </div>
        </>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label className="check">
          <input type="radio" name="sep-dest" checked={dest === 'new'} onChange={() => setDest('new')} /> Into a new folder inside “{props.folder.name}”:
          <input className="input" style={{ width: 220, flex: "none", marginLeft: 8 }} value={newName} onChange={(e) => { setNewName(e.target.value); setDest('new'); }} aria-label="New folder name" />
        </label>
        <label className="check">
          <input type="radio" name="sep-dest" checked={dest === 'pick'} onChange={() => setDest('pick')} /> Into
          <select className="input" style={{ width: 280, flex: "none", marginLeft: 8 }} value={picked === undefined ? '' : picked === null ? 'top' : String(picked)}
            onChange={(e) => { setPicked(e.target.value === '' ? undefined : e.target.value === 'top' ? null : Number(e.target.value)); setDest('pick'); }} aria-label="Folder">
            <option value="">Choose a folder…</option>
            <option value="top">Top level</option>
            {props.folders.map((f) => <option key={f.id} value={f.id}>{'  '.repeat(f.depth)}{f.name}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} /> Free copies instead of moving (they stay here too, no extra space)</label>
      </div>
      <ErrorBox error={err} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !going.length || !destOk} title={going.length ? `To ${destName}` : undefined}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await props.onApply(going, dest === 'new' ? { newName: newName.trim() } : { id: picked ?? null }, copy);
              props.onClose();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}>
          {copy ? `Free-copy ${plural(going.length, 'item')}` : `Move ${plural(going.length, 'item')}`}
        </button>
      </div>
    </Modal>
  );
}
