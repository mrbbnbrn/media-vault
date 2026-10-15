// "47 of these are Baran — put them in his folder?" after an import
// (facesort.ts). Move them, or make free copies (no extra space), or not.

import { useCallback, useEffect, useState } from 'react';
import { api, thumbUrl, type Item } from '../api';
import { dismissOffer, openSortAll, useSortAllOpen, useSortOffers, useSortScope, watchImports, type Offer, type SortScope } from '../facesort';
import { kickFaceScanner, onFaceProgress } from '../ml/facescan';
import { Modal } from './Dialogs';
import { plural } from '../undo';
import { CloseIcon, FaceIcon } from './Icons';
import './people.css';

export function FaceSortOffer(props: {
  /** Record an undoable change (Library's toast + Ctrl+Z). */
  did: (label: string, undo: () => Promise<unknown>) => void;
  onChanged: () => void;
}) {
  useEffect(() => watchImports(), []);
  const offers = useSortOffers();
  const sortAll = useSortAllOpen();
  const scope = useSortScope();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const o = offers[0];
  const dialog = sortAll && <SortAllDialog key={scope ? `${scope.folder ?? ''}:${scope.ids?.join(',') ?? ''}` : 'all'} scope={scope} did={props.did} onChanged={props.onChanged} onClose={() => openSortAll(false)} />;
  if (!o) return dialog || null;
  const ids = o.items.map((i) => i.id);
  const n = ids.length;
  const run = async (how: 'move' | 'copy') => {
    setBusy(true);
    setErr(null);
    try {
      await placeInFolder(o.items, o.folder, o.name, how, props.did);
      dismissOffer(o.folder);
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    {dialog}
    <div className="sort-offer" role="dialog" aria-label={`Sort photos of ${o.name}`}>
      <div className="row-between">
        <b><FaceIcon size={13} /> {n.toLocaleString()} of the new {n === 1 ? 'item shows' : 'items show'} {o.name}</b>
        <button type="button" className="link" aria-label="Not now" onClick={() => dismissOffer(o.folder)}><CloseIcon size={12} /></button>
      </div>
      <div className="faces">
        {o.items.slice(0, 6).map((it) => <img key={it.id} src={thumbUrl(it.id)} alt="" loading="lazy" />)}
      </div>
      <span className="faint">Put them in {o.name}'s folder? They're already on {o.name}'s page either way.</span>
      {err && <span className="error" style={{ margin: 0 }}>{err}</span>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run('move')}>Move them</button>
        <button type="button" className="btn btn-sm" disabled={busy} title="A copy in their folder that takes no extra space" onClick={() => run('copy')}>Free copies</button>
        <button type="button" className="btn btn-sm ghost" disabled={busy} onClick={() => dismissOffer(o.folder)}>Not now</button>
      </div>
      <button type="button" className="link" style={{ alignSelf: 'flex-start', fontSize: 12 }}
        onClick={() => { for (const x of offers) dismissOffer(x.folder); openSortAll(); }}>
        {offers.length > 1 ? `Go through all ${offers.length} people…` : 'Sort everyone into their folders…'}
      </button>
    </div>
    </>
  );
}

/** Moves (or free-copies) items into a person's folder, undoably. */
async function placeInFolder(items: Item[], folder: number, name: string, how: 'move' | 'copy', did: (label: string, undo: () => Promise<unknown>) => void) {
  const ids = items.map((i) => i.id);
  if (how === 'move') {
    const before = new Map<number | null, number[]>();
    for (const it of items) before.set(it.folderId, [...(before.get(it.folderId) ?? []), it.id]);
    await api.moveItems(ids, folder);
    did(`Moved ${plural(ids.length, 'item')} to “${name}”`, async () => {
      for (const [f, g] of before) await api.moveItems(g, f);
    });
  } else {
    const made = await api.freeCopy(ids, folder);
    did(`Made ${plural(made.length, 'free copy', 'free copies')} in “${name}”`, async () => {
      await api.deleteItems(made);
      await api.deleteForever(made);
    });
  }
}

/** "Sort people into their folders": every recognised person, one at a time,
 *  with the photos of them that aren't in their folder yet. Nothing moves
 *  unless you say so. */
export function SortAllDialog(props: { scope?: SortScope | null; did: (label: string, undo: () => Promise<unknown>) => void; onChanged: () => void; onClose: () => void }) {
  const scope = props.scope ?? null;
  const [notScanned, setNotScanned] = useState({ waiting: 0, unscanned: 0 });
  const [list, setList] = useState<Offer[] | null>(null);
  const [skipped, setSkipped] = useState<Set<number>>(() => new Set());
  const [unticked, setUnticked] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const load = useCallback(async () => {
    try {
      const r = await api.facesSortAll(scope ? { ids: scope.ids, folder: scope.folder } : undefined);
      setList(r?.offers ?? []);
      setNotScanned({ waiting: r?.waiting ?? 0, unscanned: r?.unscanned ?? 0 });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setList([]);
    }
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
  }, [load]);
  // While some of them are still being scanned: look again as the scan moves on.
  useEffect(() => {
    if (!scope || notScanned.waiting === 0) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onFaceProgress(() => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        load();
      }, 1500);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [scope, notScanned.waiting, load]);
  const scanFirst = async () => {
    if (!scope) return;
    try {
      await api.facesQueue(scope.folder != null ? { folder: scope.folder } : { ids: scope.ids ?? [] });
      kickFaceScanner();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const scanLine = scope && (notScanned.waiting > 0 || notScanned.unscanned > 0) && (
    <p className="faint" style={{ margin: 0, fontSize: 12 }}>
      {notScanned.waiting > 0 && <>{plural(notScanned.waiting, 'item is', 'items are')} still being scanned for faces (this updates by itself). </>}
      {notScanned.unscanned > 0 && <>
        {plural(notScanned.unscanned, "item hasn't", "items haven't")} been scanned for faces yet.{' '}
        <button type="button" className="link" onClick={scanFirst}>Scan {notScanned.unscanned === 1 ? 'it' : 'them'} now</button>
      </>}
    </p>
  );
  const left = (list ?? []).filter((o) => !skipped.has(o.folder));
  const o = left[0];
  const total = list ? list.length : 0;
  const ticked = o ? o.items.filter((i) => !unticked.has(i.id)) : [];
  const act = async (how: 'move' | 'copy') => {
    if (!o || !ticked.length) return;
    setBusy(true);
    setErr(null);
    try {
      await placeInFolder(ticked, o.folder, o.name, how, props.did);
      setDone((d) => d + 1);
      setSkipped((s) => new Set(s).add(o.folder));
      setUnticked(new Set());
      props.onChanged();
      await load(); // a group photo may have moved out of someone else's list
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const skip = () => {
    if (!o) return;
    setSkipped((s) => new Set(s).add(o.folder));
    setUnticked(new Set());
  };
  return (
    <Modal title={scope ? `Sort into person folders: ${scope.label}` : 'Sort people into their folders'} onClose={props.onClose} wide>
      {list === null && <span className="faint">Looking at who is where…</span>}
      {scanLine}
      {list !== null && !o && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {total === 0 ? (scope ? 'Nobody recognised in these is outside their folder.' : 'Everyone recognised is already in their folder.') : done ? `Done: ${plural(done, 'person', 'people')} sorted.` : 'Nothing left to sort.'}
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={props.onClose}>Close</button>
          </div>
        </>
      )}
      {o && (
        <>
          <div className="row-between">
            <b><FaceIcon size={14} /> {o.name}</b>
            <span className="faint" style={{ fontSize: 12 }}>Person {total - left.length + 1} of {total}</span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {plural(o.items.length, 'photo shows', 'photos show')} {o.name} but {o.items.length === 1 ? "isn't" : "aren't"} in {o.name}'s folder.
            Untick any you want to leave where they are. Photos with several people: free copies keep them in both places.
          </p>
          <div className="sortall-grid">
            {o.items.map((it) => {
              const on = !unticked.has(it.id);
              return (
                <button key={it.id} type="button" className={`sortall-tile${on ? ' on' : ''}`} aria-pressed={on} title={it.name}
                  onClick={() => setUnticked((u) => { const n = new Set(u); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); return n; })}>
                  <img src={thumbUrl(it.id)} alt="" loading="lazy" draggable={false} />
                  {on && <span className="tick" aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
          {err && <div className="error" role="alert">{err}</div>}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className="faint" style={{ marginRight: 'auto', fontSize: 12 }}>{ticked.length} of {o.items.length} ticked · Ctrl+Z undoes</span>
            <button type="button" className="btn ghost" disabled={busy} onClick={skip}>Skip {o.name}</button>
            <button type="button" className="btn" disabled={busy || !ticked.length} title="A copy in their folder that takes no extra space" onClick={() => act('copy')}>Free copies</button>
            <button type="button" className="btn btn-primary" disabled={busy || !ticked.length} onClick={() => act('move')}>Move {plural(ticked.length, 'photo')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
