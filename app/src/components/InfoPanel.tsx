// The viewer's info panel (I, or the ⓘ button): what is known about the item
// on screen — name, size, shape, length, dates, folder, tags, its note,
// favourite and weight. Read only; everything comes from the vault as it is.

import { useEffect, useState, type ReactNode } from 'react';
import { api, type Item } from '../api';
import { formatTime, type PlayItem } from '../media';
import { formatBytes } from '../theme';
import { CloseIcon, HeartIcon } from './Icons';

const KIND: Record<string, string> = { image: 'Picture', gif: 'GIF', video: 'Video', text: 'Text', pdf: 'PDF' };

const when = (seconds: number | null | undefined) =>
  seconds ? new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

/** Remembered between viewers (a small viewer choice, nothing about the files). */
const OPEN_KEY = 'viewerInfoOpen';
export function infoPanelWasOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
export function rememberInfoPanel(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* not remembered: fine */
  }
}

export function InfoPanel(props: {
  item: PlayItem;
  /** The picture's or video's size as drawn (when the item doesn't know it). */
  natural: { w: number; h: number } | null;
  /** Videos: their length as the player found it (seconds). */
  playedSeconds: number;
  /** Where it is (e.g. its folder, as a link). */
  folder?: ReactNode;
  /** Bumped after an undo or another change, so the panel reads the item again. */
  reload: number;
  onClose: () => void;
}) {
  const { item } = props;
  const [full, setFull] = useState<Item | null>(null);
  const [tags, setTags] = useState<{ own: string[]; inherited: [string, string][] } | null>(null);
  useEffect(() => {
    setFull(null);
    setTags(null);
    if (item.itemId == null) return;
    const id = item.itemId;
    let live = true;
    api.getItem(id).then((it) => live && it && setFull(it)).catch(() => {});
    api.itemTags(id).then((t) => live && setTags(t)).catch(() => {});
    return () => {
      live = false;
    };
  }, [item.itemId, props.reload]);

  const w = item.width ?? full?.width ?? props.natural?.w ?? null;
  const h = item.height ?? full?.height ?? props.natural?.h ?? null;
  const ms = item.durationMs ?? full?.durationMs ?? (props.playedSeconds > 0 ? props.playedSeconds * 1000 : null);
  const taken = full?.takenAt ?? item.date ?? null;
  const added = full?.importedAt ?? (item.itemId != null ? item.added : null);
  const inVault = item.itemId != null;
  // The viewer's own copy is newer (a click on the heart shows at once).
  const fav = item.favourite;
  const weight = item.weight ?? full?.weight ?? 1;
  const rows: [string, ReactNode][] = [
    ['Type', [KIND[item.kind] ?? item.kind, full?.ext ? full.ext.toUpperCase() : ''].filter(Boolean).join(' · ')],
    ['Size', formatBytes(full?.size ?? item.size ?? null)],
    ['Dimensions', w && h ? `${w} × ${h}` : ''],
    ['Length', (item.kind === 'video' || item.kind === 'gif') && ms ? formatTime(ms) : ''],
    ['Taken', when(taken)],
    ['Added', inVault ? when(added) : ''],
    ['Folder', inVault ? props.folder ?? null : null],
    ['Viewed', full ? (full.views === 1 ? 'once' : `${full.views} times`) : ''],
  ];

  return (
    <aside className="info-panel" aria-label="Info" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="info-head">
        <h3 className="ellipsis" title={item.name}>{item.name}</h3>
        <button type="button" className="btn btn-icon btn-sm glass" aria-label="Close info (I)" title="Close info (I)" onClick={props.onClose}><CloseIcon size={12} /></button>
      </div>
      <dl className="info-list">
        {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {inVault && (
          <>
            <div>
              <dt>Favourite</dt>
              <dd className={fav ? 'accent' : 'faint'}>{fav ? <><HeartIcon filled size={13} /> Yes</> : 'No'}</dd>
            </div>
            <div>
              <dt>Weight</dt>
              <dd>{weight}{weight === 1 ? <span className="faint"> · normal</span> : weight === 0 ? <span className="faint"> · never in Weighted random</span> : null}</dd>
            </div>
          </>
        )}
      </dl>
      {inVault && (
        <section>
          <h4>Tags</h4>
          {!tags ? <p className="faint">…</p> : tags.own.length + tags.inherited.length === 0 ? <p className="faint">No tags</p> : (
            <div className="info-tags">
              {tags.own.map((t) => <span key={t} className="chip">{t}</span>)}
              {tags.inherited.map(([t, from]) => <span key={`${t}@${from}`} className="chip faint" title={`From the folder “${from}”`}>{t} <small>· {from}</small></span>)}
            </div>
          )}
        </section>
      )}
      {inVault && full && (
        <section>
          <h4>Note</h4>
          {full.note ? <p className="info-note">{full.note}</p> : <p className="faint">No note</p>}
        </section>
      )}
    </aside>
  );
}
