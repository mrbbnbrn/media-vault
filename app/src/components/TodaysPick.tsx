// Today's pick: one weighted-random item shown after unlocking, once a day.
// The same item all day (it comes from the date), so nothing needs saving
// except "already shown today" in this browser profile.

import { useEffect, useState } from 'react';
import { api, thumbUrl, type Item } from '../api';
import { HeartIcon, PlayIcon } from './Icons';

/** Local day number (changes at local midnight). */
export function localDay(d = new Date()): number {
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000);
}

function shownKey(vault: string) {
  return `mv.todaysPick.${vault}`;
}

export function useTodaysPick(vault: string): [Item | null, () => void] {
  const [item, setItem] = useState<Item | null>(null);
  useEffect(() => {
    const day = localDay();
    let shown = '';
    try {
      shown = localStorage.getItem(shownKey(vault)) ?? '';
    } catch {
      /* storage unavailable: show it */
    }
    if (shown === String(day)) return;
    const t = setTimeout(() => {
      api.todaysPick(day).then((it) => it && setItem(it)).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [vault]);
  const dismiss = () => {
    try {
      localStorage.setItem(shownKey(vault), String(localDay()));
    } catch {
      /* fine */
    }
    setItem(null);
  };
  return [item, dismiss];
}

export function TodaysPickCard(props: { item: Item; onOpen: () => void; onClose: () => void }) {
  const it = props.item;
  return (
    <div className="pick-card" role="dialog" aria-label="Today's pick">
      <button type="button" className="pick-img" onClick={props.onOpen} aria-label={`Open ${it.name}`}>
        {it.thumb === 'ok' && <img src={thumbUrl(it.id)} alt="" />}
        <span className="pick-play"><PlayIcon size={20} /></span>
      </button>
      <div className="pick-meta">
        <span className="faint" style={{ fontSize: 12 }}>Today's pick</span>
        <b className="ellipsis">{it.name}</b>
        <span className="faint" style={{ fontSize: 12 }}>
          {it.favourite && <><HeartIcon filled size={11} /> </>}
          {new Date(it.takenAt * 1000).toLocaleDateString()}
        </span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={props.onOpen}>Open</button>
        <button type="button" className="btn btn-sm" onClick={props.onClose}>Later</button>
      </div>
    </div>
  );
}
