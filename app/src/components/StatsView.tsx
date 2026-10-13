// Library statistics: totals, what takes the space, growth per month, and
// what you watch most.

import { useEffect, useState } from 'react';
import { api, thumbUrl, type Item, type Stats } from '../api';
import { formatBytes } from '../theme';

const KIND_NAMES: Record<string, string> = { image: 'Pictures', gif: 'GIFs', video: 'Videos', text: 'Text files', pdf: 'PDFs' };

export function StatsView(props: { onOpenFolder: (id: number | null) => void; onOpenItem: (it: Item, list: Item[]) => void }) {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.stats().then(setS).catch((e) => setErr(String(e)));
  }, []);
  if (err) return <div className="error">{err}</div>;
  if (!s) return <div className="faint">Counting…</div>;
  const maxFolder = Math.max(1, ...s.byFolder.map((f) => f.bytes));
  const months = s.byMonth.slice(-24);
  const maxMonth = Math.max(1, ...months.map((m) => m.items));
  const fmtMonth = (m: string) => {
    const [y, mo] = m.split('-').map(Number);
    return new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(new Date(y, mo - 1, 1));
  };
  return (
    <div className="stats">
      <div className="stat-tiles">
        <Tile label="Items" value={s.items.toLocaleString()} />
        <Tile label="Size" value={formatBytes(s.bytes)} />
        <Tile label="Folders" value={s.folders.toLocaleString()} />
        <Tile label="Tags" value={s.tags.toLocaleString()} />
        <Tile label="Favourites" value={s.favourites.toLocaleString()} />
        <Tile label="Never opened" value={s.neverViewed.toLocaleString()} />
        <Tile label="Times viewed" value={s.totalViews.toLocaleString()} />
        <Tile label="In the trash" value={s.trashItems ? `${s.trashItems.toLocaleString()} · ${formatBytes(s.trashBytes)}` : '0'} />
      </div>

      <div className="stats-cols">
        <section className="spanel">
          <h2>By type</h2>
          <table className="stat-table">
            <tbody>
              {s.byKind.map((k) => (
                <tr key={k.kind}>
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

      {months.length > 0 && (
        <section className="spanel">
          <h2>Added per month</h2>
          <div className="month-bars" role="img" aria-label="Items added per month">
            {months.map((m) => (
              <div key={m.month} className="mb" title={`${fmtMonth(m.month)}: ${m.items.toLocaleString()} items, ${formatBytes(m.bytes)}`}>
                <span className="mb-n">{m.items.toLocaleString()}</span>
                <div className="mb-bar" style={{ height: `${Math.max(2, (m.items / maxMonth) * 100)}%` }} />
                <span className="mb-label">{fmtMonth(m.month)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-tile">
      <span className="faint">{label}</span>
      <b>{value}</b>
    </div>
  );
}
