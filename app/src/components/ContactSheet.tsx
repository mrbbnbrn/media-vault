// A folder at a glance: every item as a small thumbnail with its name, on
// one light sheet like a photographer's contact print.

import { useState } from 'react';
import { thumbUrl, type Item } from '../api';
import { formatTime } from '../media';
import { formatBytes } from '../theme';

export function ContactSheet(props: { title: string; items: Item[]; onClose: () => void; onOpen: (it: Item) => void }) {
  const [cols, setCols] = useState(8);
  const [names, setNames] = useState(true);
  const bytes = props.items.reduce((a, i) => a + i.size, 0);
  return (
    <div className="sheet-back" role="dialog" aria-modal="true" aria-label={`Contact sheet: ${props.title}`}
      onKeyDown={(e) => e.key === 'Escape' && props.onClose()} tabIndex={-1}>
      <div className="sheet-bar">
        <b>Contact sheet</b>
        <label className="faint" htmlFor="sheet-cols" style={{ fontSize: 12 }}>Columns</label>
        <input id="sheet-cols" type="range" min={4} max={16} value={cols} onChange={(e) => setCols(Number(e.target.value))} />
        <label className="check" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} /> Names
        </label>
        <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={props.onClose} autoFocus>Close</button>
      </div>
      <div className="sheet-scroll">
        <article className="sheet">
          <header>
            <h1>{props.title}</h1>
            <span>{props.items.length.toLocaleString()} items · {formatBytes(bytes)}</span>
          </header>
          <div className="sheet-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {props.items.map((it, i) => (
              <figure key={it.id} onDoubleClick={() => props.onOpen(it)} title={it.name}>
                <div className={`sheet-thumb${it.kind === 'pdf' || it.kind === 'text' ? ' doc' : ''}`}>
                  {it.thumb === 'ok' ? <img src={thumbUrl(it.id)} alt="" loading="lazy" draggable={false} /> : <span>{it.ext.toUpperCase()}</span>}
                  {it.kind === 'video' && <i>{formatTime(it.durationMs)}</i>}
                  {it.kind === 'gif' && <i>GIF</i>}
                </div>
                {names && <figcaption><span>{i + 1}</span> {it.name}</figcaption>}
              </figure>
            ))}
          </div>
        </article>
      </div>
    </div>
  );
}
