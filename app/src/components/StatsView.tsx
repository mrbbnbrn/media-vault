// Library statistics: totals, what takes the space, growth per month, and
// what you watch most. The tiles and rows open what they count.

import { useEffect, useState } from 'react';
import { api, thumbUrl, type Item, type Stats } from '../api';
import { formatBytes } from '../theme';
import { GrowthChart } from './VaultGrowth';

const KIND_NAMES: Record<string, string> = { image: 'Pictures', gif: 'GIFs', video: 'Videos', text: 'Text files', pdf: 'PDFs' };

/** Where a tile or row leads. */
export type StatsGo = 'items' | 'largest' | 'folders' | 'tags' | 'favourites' | 'trash' | 'recent' | { kind: string };

export function StatsView(props: { onOpenFolder: (id: number | null) => void; onOpenItem: (it: Item, list: Item[]) => void; onGo: (to: StatsGo) => void }) {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.stats().then(setS).catch((e) => setErr(String(e)));
  }, []);
  if (err) return <div className="error">{err}</div>;
  if (!s) return <div className="faint">Counting…</div>;
  const maxFolder = Math.max(1, ...s.byFolder.map((f) => f.bytes));
  return (
    <div className="stats">
      <div className="stat-tiles">
        <Tile label="Items" value={s.items.toLocaleString()} title="Show everything" onClick={() => props.onGo('items')} />
        <Tile label="Size" value={formatBytes(s.bytes)} title="Everything, largest first" onClick={() => props.onGo('largest')} />
        <Tile label="Folders" value={s.folders.toLocaleString()} title="All folders" onClick={() => props.onGo('folders')} />
        <Tile label="Tags" value={s.tags.toLocaleString()} title="Rename, merge, colour or delete tags" onClick={() => props.onGo('tags')} />
        <Tile label="Favourites" value={s.favourites.toLocaleString()} title="Show your favourites" onClick={() => props.onGo('favourites')} />
        <Tile label="Never opened" value={s.neverViewed.toLocaleString()} />
        <Tile label="Times viewed" value={s.totalViews.toLocaleString()} title="Recently viewed" onClick={() => props.onGo('recent')} />
        <Tile label="In the trash" value={s.trashItems ? `${s.trashItems.toLocaleString()} · ${formatBytes(s.trashBytes)}` : '0'} title="Open the trash" onClick={() => props.onGo('trash')} />
      </div>

      <div className="stats-cols">
        <section className="spanel">
          <h2>By type</h2>
          <table className="stat-table">
            <tbody>
              {s.byKind.map((k) => (
                <tr key={k.kind} className="clickable" title={`Show the ${(KIND_NAMES[k.kind] ?? k.kind).toLowerCase()}`} onClick={() => props.onGo({ kind: k.kind })}>
                  <td>{KIND_NAMES[k.kind] ?? k.kind}</td>
                  <td className="num">{k.items.toLocaleString()}</td>
                  <td className="num">{formatBytes(k.bytes)}</td>
                  <td className="bar-cell"><div className="hbar" style={{ width: `${(k.bytes / Math.max(1, s.bytes)) * 100}%` }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="spanel">
          <h2>Biggest folders</h2>
          <table className="stat-table">
            <tbody>
              {s.byFolder.slice(0, 12).map((f) => (
                <tr key={f.id ?? 'top'} className="clickable" onClick={() => props.onOpenFolder(f.id)}>
                  <td className="ellipsis" style={{ maxWidth: 200 }}>{f.name}</td>
                  <td className="num">{f.items.toLocaleString()}</td>
                  <td className="num">{formatBytes(f.bytes)}</td>
                  <td className="bar-cell"><div className="hbar" style={{ width: `${(f.bytes / maxFolder) * 100}%` }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <GrowthChart />

      <section className="spanel">
        <h2>Most viewed</h2>
        {s.mostViewed.length ? (
          <div className="most-viewed">
            {s.mostViewed.map((it) => (
              <button key={it.id} type="button" className="mv-tile" title={it.name} onClick={() => props.onOpenItem(it, s.mostViewed)}>
                {it.thumb === 'ok' && <img src={thumbUrl(it.id)} alt="" loading="lazy" />}
                <span className="badge">{it.views}×</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="faint" style={{ margin: 0 }}>Nothing opened yet. Items count as viewed once they've been on screen for a couple of seconds.</p>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, title, onClick }: { label: string; value: string; title?: string; onClick?: () => void }) {
  if (!onClick) {
    return (
      <div className="stat-tile">
        <span className="faint">{label}</span>
        <b>{value}</b>
      </div>
    );
  }
  return (
    <button type="button" className="stat-tile clickable" title={title} onClick={onClick}>
      <span className="faint">{label}</span>
      <b>{value}</b>
    </button>
  );
}
