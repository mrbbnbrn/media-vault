// Browser preview only (no Tauri): a small sample library with folders,
// people, faces and tags, so the sidebar, folder sorting, the slot machine
// and "Why is this here?" can be tried and screenshotted. Turned on by
// opening the page with ?demo. Nothing here runs in the real app.

import type { Explanation, FolderCard, Item, ItemFilter, Kind, SlotData } from './api';

export const NOT_DEMO = Symbol('not demo');

export const demoOn = () => typeof location !== 'undefined' && /[?&]demo\b/.test(location.search);

interface DFolder { id: number; name: string; parentId: number | null; order: number; createdAt: number; pinned: boolean; person: boolean; tags: string[] }
interface DItem extends Item { tags: string[]; faces: number[] }

const DAY = 86_400;
const T0 = 1_700_000_000;

const folders: DFolder[] = [
  { id: 1, name: 'People', parentId: null, order: 0, createdAt: T0, pinned: false, person: false, tags: [] },
  { id: 2, name: 'Bahar', parentId: 1, order: 0, createdAt: T0 + 2 * DAY, pinned: false, person: true, tags: [] },
  { id: 3, name: 'Deniz', parentId: 1, order: 0, createdAt: T0 + 3 * DAY, pinned: false, person: true, tags: [] },
  { id: 4, name: 'Holidays', parentId: null, order: 0, createdAt: T0 + 10 * DAY, pinned: false, person: false, tags: ['travel'] },
  { id: 5, name: 'Antalya 2023', parentId: 4, order: 0, createdAt: T0 + 40 * DAY, pinned: true, person: false, tags: [] },
  { id: 6, name: 'Kapadokya', parentId: 4, order: 0, createdAt: T0 + 20 * DAY, pinned: false, person: false, tags: [] },
  { id: 7, name: 'Pets', parentId: null, order: 0, createdAt: T0 + 5 * DAY, pinned: true, person: false, tags: [] },
  { id: 8, name: 'Ödev 10', parentId: null, order: 0, createdAt: T0 + 60 * DAY, pinned: false, person: false, tags: [] },
  { id: 9, name: 'ödev 2', parentId: null, order: 0, createdAt: T0 + 50 * DAY, pinned: false, person: false, tags: [] },
  { id: 10, name: 'Screenshots', parentId: null, order: 0, createdAt: T0 + 70 * DAY, pinned: false, person: false, tags: [] },
  { id: 11, name: 'zeynep’s wedding', parentId: null, order: 0, createdAt: T0 + 30 * DAY, pinned: false, person: false, tags: [] },
];

const WORDS = ['sunset', 'beach', 'balloon', 'cave', 'boat', 'dinner', 'cat', 'dog', 'portrait', 'market', 'İstanbul', 'köprü'];
const items: DItem[] = [];
{
  // [folder, how many, tags, faces]
  const plan: [number | null, number, string[], number[]][] = [
    [2, 6, [], [2]], [3, 5, [], [3]], [5, 16, ['sea'], []], [6, 10, ['balloon'], []], [7, 9, ['cat'], []],
    [8, 3, [], []], [9, 2, [], []], [10, 12, [], []], [11, 8, ['wedding'], []], [null, 4, [], []],
  ];
  let id = 1;
  for (const [folder, n, tags, faces] of plan) {
    for (let k = 0; k < n; k++) {
      const w = WORDS[(id * 7) % WORDS.length];
      const kind: Kind = id % 9 === 0 ? 'video' : id % 11 === 0 ? 'gif' : 'image';
      // People turn up in the holiday and wedding pictures too.
      const f = [...faces, ...(folder === 5 && k % 3 === 0 ? [2] : []), ...(folder === 11 && k % 2 === 0 ? [2] : []), ...(folder === 6 && k % 4 === 1 ? [3] : [])];
      items.push({
        id, kind, name: `${w} ${String(id).padStart(3, '0')}.${kind === 'video' ? 'mp4' : kind === 'gif' ? 'gif' : 'jpg'}`, ext: kind === 'video' ? 'mp4' : 'jpg',
        size: 200_000 + ((id * 7919) % 50) * 90_000, width: 1600, height: id % 3 ? 1200 : 2000, durationMs: kind === 'video' ? 42_000 : null,
        favourite: id % 5 === 0, weight: 1, thumb: 'ok', importedAt: T0 + id * DAY, folderId: folder, takenAt: T0 + id * DAY, views: id % 4,
        deletedAt: null, preview: false, copyOf: null, linked: false, note: id % 13 === 0 ? 'the sunset boat trip' : null, resumeMs: null,
        tags: [...tags, ...(id % 6 === 0 ? ['sunset'] : [])], faces: f,
      });
      id++;
    }
  }
}
const ui = new Map<string, string>();
let nextFolder = 100;

const kidsOf = (id: number | null) => folders.filter((f) => f.parentId === id);
function below(id: number): number[] {
  return [id, ...kidsOf(id).flatMap((k) => below(k.id))];
}
function chain(id: number | null): DFolder[] {
  const out: DFolder[] = [];
  let cur = folders.find((f) => f.id === id);
  while (cur) {
    out.unshift(cur);
    cur = folders.find((f) => f.id === cur!.parentId);
  }
  return out;
}
const effTags = (it: DItem) => [...it.tags, ...chain(it.folderId).flatMap((f) => f.tags)].map((t) => t.toLowerCase());
const isPerson = (it: DItem, p: number) => (it.folderId != null && below(p).includes(it.folderId)) || it.faces.includes(p);
const fold = (x: string) => x.toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/̇/g, '');

function cards(): FolderCard[] {
  const out: FolderCard[] = [];
  const walk = (parent: number | null, path: { id: number; name: string }[]) => {
    const kids = kidsOf(parent).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    for (const f of kids) {
      const inside = items.filter((i) => i.folderId != null && below(f.id).includes(i.folderId));
      const cover = (f.person ? items.filter((i) => isPerson(i, f.id)) : inside)[0]?.id ?? null;
      out.push({
        id: f.id, name: f.name, parentId: f.parentId, path, depth: path.length, items: inside.length,
        directItems: items.filter((i) => i.folderId === f.id).length, subfolders: kidsOf(f.id).length,
        cover, coverKind: cover ? 'image' : null, tags: f.tags, pinned: f.pinned, color: null, emoji: null, person: f.person,
        samples: inside.slice(1, 3).map((i) => i.id), note: null, createdAt: f.createdAt, bytes: inside.reduce((a, i) => a + i.size, 0),
      });
      walk(f.id, [...path, { id: f.id, name: f.name }]);
    }
  };
  walk(null, []);
  return out;
}

function query(f: ItemFilter): DItem[] {
  let list = items.filter((i) => (f.trash ? i.deletedAt != null : i.deletedAt == null));
  if (f.folder !== undefined || f.folders?.length) {
    const ids = new Set<number>();
    const add = (id: number) => (f.recursive ? below(id) : [id]).forEach((x) => ids.add(x));
    if (f.folder != null) add(f.folder);
    f.folders?.forEach(add);
    const top = f.folder === null;
    if (!(top && f.recursive)) list = list.filter((i) => (top && i.folderId == null) || (i.folderId != null && ids.has(i.folderId)));
  }
  if (f.favouritesOnly) list = list.filter((i) => i.favourite);
  if (f.kinds?.length) list = list.filter((i) => f.kinds!.includes(i.kind));
  for (const t of f.tags ?? []) list = list.filter((i) => effTags(i).includes(t.toLowerCase()));
  for (const p of f.people ?? []) list = list.filter((i) => isPerson(i, p));
  for (const n of (f.names ?? []).map((x) => fold(x.trim())).filter(Boolean)) list = list.filter((i) => fold(`${i.name} ${i.note ?? ''}`).includes(n));
  return [...list].sort((a, b) => b.importedAt - a.importedAt);
}

function ranges(text: string, word: string): [number, number][] {
  const chars = Array.from(text);
  const w = Array.from(fold(word));
  const low = chars.map((c) => fold(c));
  const out: [number, number][] = [];
  for (let i = 0; i + w.length <= low.length; i++) {
    if (w.every((c, k) => low[i + k] === c)) {
      out.push([i, i + w.length]);
      i += w.length - 1;
    }
  }
  return out;
}

function explain(id: number, f: ItemFilter): Explanation {
  const it = items.find((i) => i.id === id)!;
  const path = chain(it.folderId).map((x) => x.name);
  const names = (f.names ?? []).filter((n) => fold(n.trim())).map((n) => ({
    word: n.trim(), found: fold(`${it.name} ${it.note ?? ''}`).includes(fold(n.trim())),
    inName: ranges(it.name, n.trim()), inNote: it.note ? ranges(it.note, n.trim()) : [], inFolderPath: fold(path.join(' ')).includes(fold(n.trim())),
  }));
  const tags = (f.tags ?? []).map((t) => ({
    tag: t, found: effTags(it).includes(t.toLowerCase()), own: it.tags.some((x) => x.toLowerCase() === t.toLowerCase()),
    fromFolders: chain(it.folderId).filter((c) => c.tags.some((x) => x.toLowerCase() === t.toLowerCase())).map((c) => c.name),
  }));
  const people = (f.people ?? []).map((p) => {
    const inFolder = it.folderId != null && below(p).includes(it.folderId);
    const faces = it.faces.filter((x) => x === p).length;
    return { id: p, name: folders.find((x) => x.id === p)?.name ?? 'someone', found: inFolder || faces > 0, inFolder, faces };
  });
  const filters: Explanation['filters'] = [{ filter: 'trash', passed: true, wants: 'not in the trash', has: 'not in the trash' }];
  if (f.kinds?.length) filters.push({ filter: 'kind', passed: f.kinds.includes(it.kind), wants: f.kinds.map((k) => `${k}s`).join(' or '), has: `a ${it.kind}` });
  const matched = query({ ...f, folder: undefined }).some((x) => x.id === id);
  return { item: it, matched, folderPath: path, names, tags, people, filters, smart: null };
}

function slotData(folder: number | null): SlotData {
  const pool = query({ folder, recursive: true }).filter((i) => i.kind !== 'text' && i.kind !== 'pdf');
  const groups: SlotData['groups'] = [];
  for (const p of folders.filter((x) => x.person)) {
    const ids = pool.filter((i) => isPerson(i, p.id)).map((i) => i.id);
    if (ids.length >= 2) groups.push({ kind: 'person', key: String(p.id), label: p.name, items: ids });
  }
  const tags = new Set(pool.flatMap(effTags));
  for (const t of tags) {
    const ids = pool.filter((i) => effTags(i).includes(t)).map((i) => i.id);
    if (ids.length >= 2) groups.push({ kind: 'tag', key: t, label: t, items: ids });
  }
  return { items: pool, groups };
}

/** Answer a command from the sample library, or NOT_DEMO to fall through. */
export function demoCall(cmd: string, a: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'library_folders':
      return cards();
    case 'folder_view': {
      const id = a.folder as number | null;
      const all = cards();
      return { folder: all.find((f) => f.id === id) ?? null, subfolders: all.filter((f) => f.parentId === id), items: query({ folder: id }) };
    }
    case 'query_items':
      return query(a.filter as ItemFilter);
    case 'get_item':
      return items.find((i) => i.id === a.id);
    case 'all_tags': {
      const names = [...new Set(items.flatMap((i) => i.tags).concat(folders.flatMap((f) => f.tags)))];
      return names.map((n) => ({ name: n, items: items.filter((i) => i.tags.includes(n)).length, folders: folders.filter((f) => f.tags.includes(n)).length }));
    }
    case 'item_tags': {
      const it = items.find((i) => i.id === a.id)!;
      return { own: it.tags, inherited: chain(it.folderId).flatMap((c) => c.tags.map((t) => [t, c.name])) };
    }
    case 'folder_samples':
      return query({ folder: a.folder as number, recursive: true }).slice(0, a.n as number).map((i) => i.id);
    case 'faces_of_many':
    case 'similar_needed':
      return [];
    case 'set_folder_order': {
      const ids = a.ids as number[];
      const before = ids.map((id) => [id, folders.find((f) => f.id === id)?.order ?? 0]);
      ids.forEach((id, k) => { const f = folders.find((x) => x.id === id); if (f) f.order = k + 1; });
      return before;
    }
    case 'restore_folder_order':
      for (const [id, o] of a.before as [number, number][]) { const f = folders.find((x) => x.id === id); if (f) f.order = o; }
      return;
    case 'create_folder': {
      const parent = a.parent as number | null;
      const last = Math.max(0, ...kidsOf(parent).map((f) => f.order));
      const id = nextFolder++;
      folders.push({ id, name: String(a.name).trim(), parentId: parent, order: last + 1, createdAt: Math.floor(Date.now() / 1000), pinned: false, person: false, tags: [] });
      return id;
    }
    case 'move_folder': {
      const f = folders.find((x) => x.id === a.id);
      if (f) f.parentId = a.parent as number | null;
      return;
    }
    case 'set_pinned': {
      const f = folders.find((x) => x.id === a.id);
      if (f) f.pinned = !!a.on;
      return;
    }
    case 'set_favourite':
      for (const it of items) if ((a.ids as number[]).includes(it.id)) it.favourite = !!a.on;
      return;
    case 'ui_get':
      return ui.get(a.key as string) ?? null;
    case 'ui_set':
      ui.set(a.key as string, a.value as string);
      return;
    case 'explain_match':
      return explain(a.id as number, a.filter as ItemFilter);
    case 'slot_machine_data':
      return slotData(a.folder as number | null);
    default:
      return NOT_DEMO;
  }
}
