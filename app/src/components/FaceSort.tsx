// "47 of these are Baran — put them in his folder?" after an import
// (facesort.ts). Move them, or make free copies (no extra space), or not.

import { useEffect, useState } from 'react';
import { api, thumbUrl } from '../api';
import { dismissOffer, useSortOffers, watchImports } from '../facesort';
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const o = offers[0];
  if (!o) return null;
  const ids = o.items.map((i) => i.id);
  const n = ids.length;
  const run = async (how: 'move' | 'copy') => {
    setBusy(true);
    setErr(null);
    try {
      if (how === 'move') {
        const before = new Map<number | null, number[]>();
        for (const it of o.items) before.set(it.folderId, [...(before.get(it.folderId) ?? []), it.id]);
        await api.moveItems(ids, o.folder);
        props.did(`Moved ${plural(n, 'item')} to “${o.name}”`, async () => {
          for (const [f, g] of before) await api.moveItems(g, f);
        });
      } else {
        const made = await api.freeCopy(ids, o.folder);
        props.did(`Made ${plural(made.length, 'free copy', 'free copies')} in “${o.name}”`, async () => {
          await api.deleteItems(made);
          await api.deleteForever(made);
        });
      }
      dismissOffer(o.folder);
      props.onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
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
    </div>
  );
}
