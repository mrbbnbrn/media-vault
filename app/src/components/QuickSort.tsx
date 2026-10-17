// Quick sort: go through a folder one item at a time and send each one to
// another folder. The search box always has the focus: type part of a folder
// name and press Enter. Most-used folders and suggestions (a recognised face,
// folders whose pictures look alike) are one click away. "#tag" tags instead.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, mediaUrl, thumbUrl, type FolderCard, type Item } from '../api';
import { plural } from '../undo';
import { FaceIcon, FolderIcon, SparkleIcon, TagIcon, TrashIcon } from './Icons';
import { useLayer } from '../keylayers';

const fold = (x: string) => x.toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/̇/g, '');

type Done = { kind: 'move' | 'trash' | 'tag'; item: Item; index: number; label: string };

export function QuickSort(props: {
  source: FolderCard | null;
  folders: FolderCard[];
  /** How often each folder was a destination (most-used buttons). */
  moveStats: Record<number, number>;
  onMoved: (folder: number) => void;
  /** Record an undoable action (the library's Ctrl+Z history). */
  did: (label: string, undo: () => Promise<unknown>) => void;
  undo: () => Promise<void>;
  onClose: (changed: boolean) => void;
}) {
  const sourceId = props.source?.id ?? null;
  const [withSub, setWithSub] = useState(false);
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [index, setIndex] = useState(0);
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [sorted, setSorted] = useState(0);
  const [suggest, setSuggest] = useState<{ folder: number; reason: 'face' | 'look' }[]>([]);
  const history = useRef<Done[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const changed = useRef(false);
  const memKey = `quicksort:${sourceId ?? 'top'}`;

  // The most-used folders, fixed for this session so buttons don't jump around.
  const frequent = useMemo(() => {
    const byId = new Map(props.folders.map((f) => [f.id, f]));
    return Object.entries(props.moveStats)
      .map(([id, n]) => [Number(id), n] as const)
      .filter(([id]) => byId.has(id) && id !== sourceId)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => byId.get(id)!);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the queue; start where you stopped last time.
  useEffect(() => {
    let live = true;
    (async () => {
      const list = await api.queryItems({ folder: sourceId, recursive: withSub });
      list.sort((a, b) => a.takenAt - b.takenAt || a.id - b.id);
      if (!live) return;
      setQueue(list);
      const last = Number(await api.uiGet(memKey).catch(() => null));
      const at = last ? list.findIndex((i) => i.id === last) : -1;
      setIndex(at >= 0 ? at : 0);
    })().catch(() => setQueue([]));
    return () => {
      live = false;
    };
  }, [withSub]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = queue?.[index] ?? null;
  useEffect(() => {
    if (cur) api.uiSet(memKey, String(cur.id)).catch(() => {});
    setSuggest([]);
    if (!cur) return;
    let live = true;
    api.suggestFolders(cur.id).then((s) => live && setSuggest(s)).catch(() => {});
    // Load the next one ahead of time.
    const next = queue?.[index + 1];
    if (next && next.kind !== 'video') new Image().src = mediaUrl(next.id);
    return () => {
      live = false;
    };
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A dialog (keylayers.ts): keys typed here never reach the library; back closes it.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayer(true, { name: 'quick sort', modal: true, el: () => rootRef.current, onKey: () => false, onBack: () => props.onClose(changed.current) });
  // The search box keeps the focus.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.activeElement !== input.current && !document.querySelector('[aria-modal="true"]')) input.current?.focus();
    }, 300);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 2500);
    return () => clearTimeout(t);
  }, [note]);

  const pathOf = (f: FolderCard) => (f.path.length ? `${f.path.map((c) => c.name).join(' › ')} › ` : '') + f.name;
  const q = fold(text.trim());
  const tagMode = text.trim().startsWith('#');
  type Opt = { t: 'folder'; f: FolderCard } | { t: 'create'; name: string } | { t: 'tag'; name: string };
  const opts: Opt[] = useMemo(() => {
    if (!q) return [];
    if (tagMode) {
      const name = text.trim().replace(/^#+/, '').trim();
      return name ? [{ t: 'tag', name }] : [];
    }
    const hits = props.folders
      .filter((f) => f.id !== sourceId && fold(pathOf(f)).includes(q))
      .sort((a, b) =>
        Number(!fold(a.name).startsWith(q)) - Number(!fold(b.name).startsWith(q))
        || (props.moveStats[b.id] ?? 0) - (props.moveStats[a.id] ?? 0)
        || a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((f): Opt => ({ t: 'folder', f }));
    const exact = props.folders.some((f) => fold(f.name) === q);
    return exact ? hits : [...hits, { t: 'create', name: text.trim() }];
  }, [q, tagMode, props.folders]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setHi(0), [q]);

  const advanceAfterRemove = useCallback((at: number) => {
    setQueue((qu) => (qu ? qu.filter((_, k) => k !== at) : qu));
    setIndex((i) => i); // the next item slides into this place
  }, []);

  const send = async (folder: number, name: string) => {
    if (!cur) return;
    const item = cur;
    const at = index;
    try {
      await api.moveItems([item.id], folder);
      props.did(`Moved “${item.name}” to “${name}”`, () => api.moveItems([item.id], item.folderId));
      props.onMoved(folder);
      history.current.push({ kind: 'move', item, index: at, label: name });
      changed.current = true;
      setSorted((n) => n + 1);
      setNote(`Sent to “${name}”`);
      setText('');
      advanceAfterRemove(at);
    } catch (e) {
      setNote(String(e));
    }
  };
  const create = async (name: string) => {
    try {
      const id = await api.createFolder(null, name);
      await send(id, name);
    } catch (e) {
      setNote(String(e));
    }
  };
  const tag = async (name: string) => {
    if (!cur) return;
    const item = cur;
    const added = await api.tagItems([item.id], [name]);
    const real = added.filter(([, ids]) => ids.length);
    if (real.length) props.did(`Tagged “${item.name}” #${name}`, () => api.untagItems([item.id], name));
    history.current.push({ kind: 'tag', item, index, label: name });
    changed.current = true;
    setNote(real.length ? `Tagged #${name}` : `Already tagged #${name}`);
    setText('');
  };
  const trash = async () => {
    if (!cur) return;
    const item = cur;
    const at = index;
    await api.deleteItems([item.id]);
    props.did(`Moved “${item.name}” to the trash`, () => api.restoreItems([item.id]));
    history.current.push({ kind: 'trash', item, index: at, label: '' });
    changed.current = true;
    setSorted((n) => n + 1);
    setNote('Moved to the trash');
    advanceAfterRemove(at);
  };
  const undoLast = async () => {
    const h = history.current.pop();
    if (!h) return;
    await props.undo();
    if (h.kind !== 'tag') {
      setQueue((qu) => {
        if (!qu) return qu;
        const n = [...qu];
        n.splice(Math.min(h.index, n.length), 0, h.item);
        return n;
      });
      setSorted((n) => Math.max(0, n - 1));
    }
    setIndex(h.index);
    setNote('Undone');
  };
  const choose = (o: Opt | undefined) => {
    if (!o) return;
    if (o.t === 'folder') send(o.f.id, o.f.name);
    else if (o.t === 'create') create(o.name);
    else tag(o.name);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLast();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(opts[hi]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, Math.max(0, opts.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === 'ArrowRight' && !text) {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, Math.max(0, (queue?.length ?? 1) - 1)));
    } else if (e.key === 'ArrowLeft' && !text) {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Delete' && !text) {
      e.preventDefault();
      trash();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (text) setText('');
      else props.onClose(changed.current);
    }
  };

  const total = queue?.length ?? 0;
  const byId = new Map(props.folders.map((f) => [f.id, f]));
  return (
    <div className="qsort" role="dialog" aria-modal="false" aria-label="Quick sort" ref={rootRef}>
      <div className="qsort-head">
        <b>Quick sort · “{props.source?.name ?? 'Top level'}”</b>
        <label className="check">
          <input type="checkbox" checked={withSub} onChange={(e) => setWithSub(e.target.checked)} /> Also sort what's in subfolders
        </label>
        <span className="faint">{queue ? (total ? `${Math.min(index + 1, total)} of ${total.toLocaleString()}` : 'Nothing left') : 'Loading…'} · {plural(sorted, 'item')} sorted</span>
        <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => props.onClose(changed.current)}>Done</button>
      </div>
      <div className="qsort-chips">
        {suggest.map((s) => byId.get(s.folder) && (
          <button key={`s${s.folder}`} type="button" className="qchip suggest" onClick={() => send(s.folder, byId.get(s.folder)!.name)}
            title={s.reason === 'face' ? 'A face in it looks like this person' : 'Looks like the pictures in this folder'}>
            {s.reason === 'face' ? <FaceIcon size={13} /> : <SparkleIcon size={13} />}
            {s.reason === 'face' ? `Looks like ${byId.get(s.folder)!.name}` : byId.get(s.folder)!.name}
          </button>
        ))}
        {frequent.filter((f) => !suggest.some((s) => s.folder === f.id)).map((f) => (
          <button key={f.id} type="button" className="qchip" title={pathOf(f)} onClick={() => send(f.id, f.name)}>
            <FolderIcon size={13} /> {f.name}
          </button>
        ))}
        {!frequent.length && !suggest.length && <span className="faint">Folders you send things to most will appear here.</span>}
      </div>
      <div className="qsort-search">
        <input ref={input} className="input" value={text} autoFocus aria-label="Folder to send it to" autoComplete="off" spellCheck={false}
          placeholder="Type a folder name and press Enter · #tag to tag it"
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        {opts.length > 0 && (
          <div className="menu qsort-results" role="listbox">
            {opts.map((o, k) => (
              <button key={o.t === 'folder' ? o.f.id : o.t} type="button" role="option" aria-selected={k === hi}
                className={`menu-item${k === hi ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
                {o.t === 'folder' ? <><FolderIcon size={13} /> {o.f.name}<span className="hint">{o.f.path.map((c) => c.name).join(' › ') || 'top level'}{k === hi ? ' · Enter' : ''}</span></>
                  : o.t === 'create' ? <>+ Create folder “{o.name}” and move here</>
                  : <><TagIcon size={13} /> Tag it #{o.name}</>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="qsort-stage">
        {!queue ? <span className="spinner" />
          : !cur ? <div className="dropzone"><b>All sorted</b><span className="muted">Nothing left in this folder.</span></div>
          : cur.kind === 'video' ? <video key={cur.id} src={mediaUrl(cur.id)} autoPlay loop muted playsInline />
          : cur.kind === 'image' || cur.kind === 'gif' ? <img key={cur.id} src={mediaUrl(cur.id)} alt={cur.name} />
          : <img key={cur.id} src={thumbUrl(cur.id)} alt={cur.name} />}
        {cur && <div className="qsort-name ellipsis">{cur.name}</div>}
        {note && <div className="qsort-note" role="status">{note}</div>}
      </div>
      <div className="qsort-keys faint">
        <span>Enter send</span><span>↑ ↓ pick</span><span>← → skip / back</span>
        <button type="button" className="link" onClick={trash}><TrashIcon size={12} /> Delete = trash</button>
        <span>Ctrl+Z undo</span><span>#tag tags it</span><span>Esc close</span>
      </div>
    </div>
  );
}
