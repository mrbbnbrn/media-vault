// Memories: slideshows the app puts together by itself — this week in
// earlier years, a person in a season, a month with many favourites, a folder
// you haven't opened in a while. Played with slow pan-and-zoom and a title card.

import { useEffect, useState } from 'react';
import { api, thumbUrl, type FolderCard, type Item } from '../api';
import { plural } from '../undo';
import { PlayIcon } from './Icons';

export interface Memory {
  key: string;
  title: string;
  subtitle: string;
  items: Item[];
}

const SEASONS = ['winter', 'spring', 'summer', 'autumn'];
const season = (d: Date) => SEASONS[Math.floor(((d.getMonth() + 1) % 12) / 3)];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const visual = (i: Item) => i.kind === 'image' || i.kind === 'gif' || i.kind === 'video';
const byDate = (a: Item, b: Item) => a.takenAt - b.takenAt || a.id - b.id;

export function makeMemories(all: Item[], people: { folder: FolderCard; items: Item[] }[], folders: FolderCard[], now = new Date()): Memory[] {
  const out: Memory[] = [];
  const items = all.filter(visual);
  // This week in earlier years.
  const years = new Map<number, Item[]>();
  for (const it of items) {
    const d = new Date(it.takenAt * 1000);
    if (d.getFullYear() >= now.getFullYear()) continue;
    const same = new Date(now.getFullYear(), d.getMonth(), d.getDate());
    if (Math.abs(same.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) <= 3 * 86400000) {
      years.set(d.getFullYear(), [...(years.get(d.getFullYear()) ?? []), it]);
    }
  }
  for (const [y, list] of [...years].sort((a, b) => b[0] - a[0])) {
    if (list.length < 4) continue;
    const ago = now.getFullYear() - y;
    out.push({ key: `week${y}`, title: ago === 1 ? 'This week, a year ago' : `This week, ${ago} years ago`, subtitle: `${MONTHS[now.getMonth()]} ${y}`, items: list.sort(byDate) });
  }
  // A person in a season.
  for (const { folder, items: list } of people) {
    const groups = new Map<string, Item[]>();
    for (const it of list.filter(visual)) {
      const d = new Date(it.takenAt * 1000);
      const y = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
      const k = `${season(d)} ${y}`;
      groups.set(k, [...(groups.get(k) ?? []), it]);
    }
    const best = [...groups].filter(([, v]) => v.length >= 8).sort((a, b) => b[1].length - a[1].length).slice(0, 2);
    for (const [k, v] of best) out.push({ key: `p${folder.id}${k}`, title: `${folder.name}, ${k}`, subtitle: plural(v.length, 'moment'), items: v.sort(byDate) });
  }
  // The month with the most favourites.
  const favMonths = new Map<string, Item[]>();
  for (const it of items.filter((i) => i.favourite)) {
    const d = new Date(it.takenAt * 1000);
    const k = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    favMonths.set(k, [...(favMonths.get(k) ?? []), it]);
  }
  const fav = [...favMonths].sort((a, b) => b[1].length - a[1].length)[0];
  if (fav && fav[1].length >= 6) out.push({ key: `fav${fav[0]}`, title: `Favourites of ${fav[0]}`, subtitle: plural(fav[1].length, 'favourite'), items: fav[1].sort(byDate) });
  // A folder you haven't looked at in a while (fewest views per item).
  const inFolder = new Map<number, Item[]>();
  for (const it of items) if (it.folderId != null) inFolder.set(it.folderId, [...(inFolder.get(it.folderId) ?? []), it]);
  const quiet = [...inFolder].filter(([, v]) => v.length >= 10).sort((a, b) => a[1].reduce((s, i) => s + i.views, 0) / a[1].length - b[1].reduce((s, i) => s + i.views, 0) / b[1].length)[0];
  const qf = quiet && folders.find((f) => f.id === quiet[0]);
  if (quiet && qf) out.push({ key: `f${qf.id}`, title: `Remember “${qf.name}”?`, subtitle: plural(quiet[1].length, 'item'), items: quiet[1].sort(byDate) });
  return out;
}

export function MemoriesView(props: { folders: FolderCard[]; onPlay: (m: Memory) => void }) {
  const [list, setList] = useState<Memory[] | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const all = await api.queryItems({});
      const persons = props.folders.filter((f) => f.person).slice(0, 8);
      // Who is in what: ids only, in one call (the items themselves are in `all`).
      const byId = new Map(all.map((i) => [i.id, i]));
      const lists = new Map(persons.length ? await api.personItemIds(persons.map((p) => p.id)).catch(() => []) : []);
      const people = persons.map((folder) => ({ folder, items: (lists.get(folder.id) ?? []).flatMap((id) => byId.get(id) ?? []) }));
      if (live) setList(makeMemories(all, people, props.folders));
    })().catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [props.folders.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return <span className="faint">Putting your memories together…</span>;
  if (!list.length) {
    return (
      <div className="dropzone">
        <b>No memories yet</b>
        <span className="muted">Memories appear when there are pictures from this week in earlier years, people with many pictures in a season, or months with many favourites.</span>
      </div>
    );
  }
  return (
    <div className="memories">
      {list.map((m) => {
        const cover = m.items.find((i) => i.thumb === 'ok') ?? m.items[0];
        return (
          <button key={m.key} type="button" className="memory" onClick={() => props.onPlay(m)}>
            <span className="memory-cover">
              {cover && <img src={thumbUrl(cover.id)} alt="" draggable={false} />}
              <span className="memory-play"><PlayIcon size={18} /></span>
            </span>
            <b className="ellipsis">{m.title}</b>
            <span className="faint">{m.subtitle}</span>
          </button>
        );
      })}
    </div>
  );
}
