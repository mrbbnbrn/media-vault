// The library: folder tree, folder cards with covers, the media grid, tag
// search, selection actions, and importing by drag and drop.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  api, inTauri, mediaUrl, onEvent, thumbUrl, type DropSummary, type FolderCard, type ImportProgress, type ImportReport, type Item, type Kind,
  type StorageDone, type StorageInfo, type StorageProgress, type TagCount,
} from '../api';
import type { Nav } from '../App';
import { ConfirmDialog, ContextMenu, Dropdown, FolderPicker, Modal, PromptDialog, type MenuItem } from '../components/Dialogs';
import {
  ChevronIcon, CloseIcon, FolderIcon, GearIcon, GridIcon, HeartIcon, ImportIcon, LockIcon, MoveIcon, PlayIcon, PlusIcon, SearchIcon, TagIcon, TrashIcon, WeightIcon,
} from '../components/Icons';
import { MediaGrid } from '../components/MediaGrid';
import { setDropHandler } from '../drop';
import { fromItem, kickThumbnails, onThumb } from '../media';
import { sorted, type Order } from '../playlist';
import { formatBytes } from '../theme';

export type LibView =
  | { kind: 'folders' }
  | { kind: 'folder'; id: number | null }
  | { kind: 'all' }
  | { kind: 'favourites' }
  | { kind: 'recent' }
  | { kind: 'search'; tags: string[] };

type Dialog =
  | { t: 'newFolder'; parent: number | null }
  | { t: 'rename'; folder: FolderCard }
  | { t: 'moveFolder'; folder: FolderCard }
  | { t: 'deleteFolder'; folder: FolderCard }
  | { t: 'folderTag'; folder: FolderCard }
  | { t: 'moveItems'; ids: number[] }
  | { t: 'deleteItems'; ids: number[] }
  | { t: 'tagItems'; ids: number[] }
  | { t: 'weight'; ids: number[]; current: number }
  | { t: 'archivePassword'; paths: string[]; target: number | null; summary: DropSummary }
  | { t: 'cover'; folder: FolderCard };

const SORTS: { id: Order; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'nameAsc', label: 'Name A–Z' },
  { id: 'nameDesc', label: 'Name Z–A' },
  { id: 'largest', label: 'Largest first' },
];

const KINDS: { id: Kind | 'any'; label: string }[] = [
  { id: 'any', label: 'All types' },
  { id: 'image', label: 'Pictures' },
  { id: 'gif', label: 'GIFs' },
  { id: 'video', label: 'Videos' },
  { id: 'text', label: 'Text files' },
  { id: 'pdf', label: 'PDFs' },
];

const PREVIEWS: { id: 'all' | 'hover' | 'off'; label: string; hint: string }[] = [
  { id: 'all', label: 'Play everything on screen', hint: 'muted' },
  { id: 'hover', label: 'Play what I hover', hint: 'muted' },
  { id: 'off', label: 'No previews', hint: 'still pictures' },
];

function viewTitle(v: LibView, folder: FolderCard | null): string {
  switch (v.kind) {
    case 'folders': return 'All folders';
    case 'folder': return v.id === null ? 'Top level' : folder?.name ?? 'Folder';
    case 'all': return 'All media';
    case 'favourites': return 'Favourites';
    case 'recent': return 'Recently added';
    case 'search': return 'Search';
  }
}

export function Library({ nav, view, setView }: { nav: Nav; view: LibView; setView: (v: LibView) => void }) {
  const s = nav.app.session!;
  const [folders, setFolders] = useState<FolderCard[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [subfolders, setSubfolders] = useState<FolderCard[]>([]);
  const [folder, setFolder] = useState<FolderCard | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [sort, setSort] = useState<Order>('newest');
  const [kind, setKind] = useState<Kind | 'any'>('any');
  const [tile, setTile] = useState(180);
  const [everyFolder, setEveryFolder] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [jobs, setJobs] = useState<Record<number, ImportProgress>>({});
  const [reports, setReports] = useState<ImportReport[]>([]);
  const [coverBump, setCoverBump] = useState(0);
  const [ctx, setCtx] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [storageJob, setStorageJob] = useState<StorageProgress | null>(null);
  const [storageMsg, setStorageMsg] = useState<StorageDone | null>(null);
  const [hoverCard, setHoverCard] = useState<number | null>(null);
  const preview = nav.app.config.preview ?? 'hover';
  const scroller = useRef<HTMLElement>(null);

  useEffect(() => {
    api.storageInfo().then(setStorage).catch(() => {});
    const a = onEvent<StorageProgress>('storage-progress', setStorageJob);
    const b = onEvent<StorageDone>('storage-done', (d) => {
      setStorageJob(null);
      setStorageMsg(d);
      api.storageInfo().then(setStorage).catch(() => {});
    });
    return () => {
      a.then((u) => u());
      b.then((u) => u());
    };
  }, []);

  const setPreview = async (mode: 'all' | 'hover' | 'off') => {
    await api.saveConfig({ ...nav.app.config, preview: mode });
    await nav.refresh();
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [f, t] = await Promise.all([api.folders(), api.allTags()]);
      setFolders(f);
      setTags(t);
      if (view.kind === 'folder') {
        const fv = await api.folderView(view.id);
        setFolder(fv.folder);
        setSubfolders(fv.subfolders);
        setItems(fv.items);
      } else {
        setFolder(null);
        setSubfolders([]);
        if (view.kind === 'folders') setItems([]);
        else if (view.kind === 'all') setItems(await api.queryItems({}));
        else if (view.kind === 'favourites') setItems(await api.queryItems({ favouritesOnly: true }));
        else if (view.kind === 'recent') setItems(await api.queryItems({ recentDays: 14 }));
        else if (view.kind === 'search') setItems(await api.queryItems({ tags: view.tags }));
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    reload();
    setSelected(new Set());
    setAnchor(null);
    scroller.current?.scrollTo({ top: 0 });
  }, [reload]);

  // Folder covers appear as soon as their first thumbnail is made.
  useEffect(() => onThumb(() => setCoverBump((b) => b + 1)), []);
  useEffect(() => {
    if (!coverBump) return;
    const t = setTimeout(() => api.folders().then(setFolders).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [coverBump]);

  // ---- import ----------------------------------------------------------------------

  const currentTarget = (): number | null => (view.kind === 'folder' ? view.id : null);

  const beginImport = useCallback(async (paths: string[], target: number | null) => {
    try {
      const summary = await api.inspectDrop(paths);
      if (summary.archives.some((a) => a.needsPassword)) {
        setDialog({ t: 'archivePassword', paths, target, summary });
        return;
      }
      if (!summary.files && !summary.archives.length) {
        setError('Nothing to import there. Supported: mp4, m4v, webm, gif, webp, png, jpg and .7z archives.');
        return;
      }
      await api.startImport(paths, target, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    setDropHandler((paths, target) => {
      let t: number | null = currentTarget();
      if (target === 'folder:top') t = null;
      else if (target?.startsWith('folder:')) t = Number(target.slice(7));
      beginImport(paths, t);
    });
    return () => setDropHandler(null);
  });

  useEffect(() => {
    const a = onEvent<ImportProgress>('import-progress', (p) => setJobs((j) => ({ ...j, [p.job]: p })));
    const b = onEvent<ImportReport>('import-done', (r) => {
      setJobs((j) => {
        const n = { ...j };
        delete n[r.job];
        return n;
      });
      setReports((rs) => [...rs, r]);
      kickThumbnails();
      reload();
      nav.refresh().catch(() => {});
    });
    return () => {
      a.then((u) => u());
      b.then((u) => u());
    };
  }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickAndImport = async (directory: boolean) => {
    if (!inTauri) return;
    const r = await open({ directory, multiple: true, title: directory ? 'Import folders' : 'Import files or .7z archives',
      filters: directory ? undefined : [{ name: 'Media and archives', extensions: ['mp4', 'm4v', 'webm', 'gif', 'webp', 'png', 'jpg', 'jpeg', '7z', '001'] }] });
    const paths = Array.isArray(r) ? r : r ? [r] : [];
    if (paths.length) beginImport(paths, currentTarget());
  };

  // ---- derived -------------------------------------------------------------------------

  const shown = useMemo(() => {
    const k = kind === 'any' ? items : items.filter((i) => i.kind === kind);
    return sorted(k.map((i) => ({ ...i, key: String(i.id), added: i.importedAt })), sort);
  }, [items, kind, sort]);

  const cards = view.kind === 'folders' ? (everyFolder ? folders : folders.filter((f) => f.parentId === null)) : subfolders;
  const selIds = [...selected];

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const playItems = (auto: boolean, startId?: number, onlySelected = false) => {
    const list = onlySelected && selected.size > 1 ? shown.filter((i) => selected.has(i.id)) : shown;
    if (!list.length) return;
    nav.go({
      name: 'viewer',
      items: list.map(fromItem),
      startKey: startId != null ? `v${startId}` : undefined,
      title: viewTitle(view, folder),
      auto,
      back: view,
      order: sort,
    });
  };

  const openFolder = (id: number | null) => setView({ kind: 'folder', id });
  const folderMenu = (f: FolderCard) => [
    { label: 'Open', onSelect: () => openFolder(f.id) },
    { label: 'Slideshow', onSelect: async () => {
      const list = await api.queryItems({ folder: f.id, recursive: true });
      if (list.length) nav.go({ name: 'viewer', items: list.map(fromItem), title: f.name, auto: true, back: view });
    } },
    { label: 'New folder inside…', onSelect: () => setDialog({ t: 'newFolder', parent: f.id }) },
    { label: 'Rename…', onSelect: () => setDialog({ t: 'rename', folder: f }) },
    { label: 'Add tag…', onSelect: () => setDialog({ t: 'folderTag', folder: f }) },
    { label: 'Choose cover…', onSelect: () => setDialog({ t: 'cover', folder: f }) },
    { label: 'Move to…', onSelect: () => setDialog({ t: 'moveFolder', folder: f }) },
    { label: 'Delete…', danger: true, onSelect: () => setDialog({ t: 'deleteFolder', folder: f }) },
  ];

  const folderContext = (e: React.MouseEvent, f: FolderCard) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, title: f.name, items: folderMenu(f) });
  };

  const itemContext = (e: React.MouseEvent, it: Item) => {
    // Right-clicking outside the selection selects just that item.
    let sel = selected;
    if (!selected.has(it.id)) {
      sel = new Set([it.id]);
      setSelected(sel);
      setAnchor(it.id);
    }
    const ids = [...sel];
    const many = ids.length > 1;
    const allFav = ids.every((id) => items.find((x) => x.id === id)?.favourite);
    const home = it.folderId != null ? folders.find((f) => f.id === it.folderId) : null;
    setCtx({
      x: e.clientX,
      y: e.clientY,
      title: many ? `${ids.length} items` : it.name,
      items: [
        { label: 'Open', onSelect: () => playItems(false, it.id) },
        { label: many ? 'Play these as a slideshow' : 'Slideshow from here', onSelect: () => playItems(true, it.id, many) },
        { label: allFav ? 'Remove from favourites' : 'Add to favourites', onSelect: () => act(() => api.setFavourite(ids, !allFav)) },
        { label: 'Tags…', onSelect: () => setDialog({ t: 'tagItems', ids }) },
        { label: 'Weight…', hint: `now ${it.weight}`, onSelect: () => setDialog({ t: 'weight', ids, current: it.weight }) },
        { label: 'Move to…', onSelect: () => setDialog({ t: 'moveItems', ids }) },
        ...(home && !many ? [{ label: `Use as cover of “${home.name}”`, onSelect: () => act(() => api.setCover(home.id, it.id)) }] : []),
        { label: many ? `Delete ${ids.length} items…` : 'Delete…', danger: true, onSelect: () => setDialog({ t: 'deleteItems', ids }) },
      ],
    });
  };

  const coverView = (f: FolderCard) => {
    if (!f.cover) return <FolderIcon size={40} />;
    const playing = preview === 'all' || (preview === 'hover' && hoverCard === f.id);
    const still = <img src={`${thumbUrl(f.cover)}?c=${coverBump}`} alt="" draggable={false} />;
    if (playing && f.coverKind === 'video')
      return <>{still}<video src={mediaUrl(f.cover)} muted loop autoPlay playsInline preload="auto" /></>;
    if (playing && f.coverKind === 'gif') return <img src={mediaUrl(f.cover)} alt="" draggable={false} />;
    return still;
  };

  // ---- render ---------------------------------------------------------------------------

  const visibleTree = folders.filter((f) => !f.path.some((c) => collapsed.has(c.id)));
  const sideView = (v: LibView, label: string, count?: number) => {
    const on = v.kind === view.kind && (v.kind !== 'folder' || (view.kind === 'folder' && view.id === v.id));
    return (
      <button type="button" className={`side-row${on ? ' on' : ''}`} onClick={() => setView(v)}>
        {label}
        {count != null && <span className="count">{count.toLocaleString()}</span>}
      </button>
    );
  };

  const totalImporting = Object.values(jobs);
  return (
    <div className="library">
      <header className="lib-top">
        <div className="brand">
          <LockIcon size={18} />
          <span>{s.name}</span>
        </div>
        <SearchBar tags={tags} value={view.kind === 'search' ? view.tags : []}
          onChange={(t) => setView(t.length ? { kind: 'search', tags: t } : { kind: 'folders' })} />
        <nav className="row" style={{ gap: 8 }}>
          <Dropdown label={`Preview: ${preview === 'all' ? 'all' : preview === 'hover' ? 'hover' : 'off'} ▾`} title="Play videos and GIFs in the grid (always muted)"
            items={PREVIEWS.map((p) => ({ label: p.label, hint: p.hint, checked: p.id === preview, onSelect: () => setPreview(p.id) }))} />
          <button type="button" className="btn btn-sm" onClick={() => playItems(true)} disabled={!shown.length}
            title="Play everything shown here as a slideshow"><PlayIcon size={14} /> Slideshow</button>
          <button type="button" className="btn btn-sm" onClick={() => nav.go({ name: 'multi', back: view })}><GridIcon /> Multi-screen</button>
          <Dropdown className="btn btn-sm btn-primary" label={<><ImportIcon /> Import</>} items={[
            { label: 'Files or .7z archives…', onSelect: () => pickAndImport(false) },
            { label: 'Folders…', onSelect: () => pickAndImport(true) },
          ]} />
          <button type="button" className="btn btn-icon btn-sm" aria-label="Settings" onClick={() => nav.go({ name: 'settings' })}><GearIcon /></button>
          <button type="button" className="btn btn-icon btn-sm" aria-label="Lock vault" title="Lock (Ctrl+Shift+L)" onClick={() => api.lock()}><LockIcon size={16} /></button>
        </nav>
      </header>

      <div className="lib-body">
        <aside className="side" aria-label="Library">
          {sideView({ kind: 'folders' }, 'All folders', folders.length)}
          {sideView({ kind: 'all' }, 'All media', s.items)}
          {sideView({ kind: 'favourites' }, 'Favourites')}
          {sideView({ kind: 'recent' }, 'Recently added')}
          <div className="side-head">Folders</div>
          <button type="button" data-drop="folder:top" className={`side-row${view.kind === 'folder' && view.id === null ? ' on' : ''}`}
            onClick={() => openFolder(null)}>
            <FolderIcon size={15} /> Top level
          </button>
          {visibleTree.map((f) => (
            <div key={f.id} className={`side-row tree${view.kind === 'folder' && view.id === f.id ? ' on' : ''}`} data-drop={`folder:${f.id}`}
              style={{ paddingLeft: 6 + f.depth * 16 }} onContextMenu={(e) => folderContext(e, f)}>
              {f.subfolders > 0 ? (
                <button type="button" className="twisty" aria-label={collapsed.has(f.id) ? 'Expand' : 'Collapse'} onClick={() => setCollapsed((c) => {
                  const n = new Set(c);
                  if (n.has(f.id)) n.delete(f.id);
                  else n.add(f.id);
                  return n;
                })}><ChevronIcon open={!collapsed.has(f.id)} /></button>
              ) : <span className="twisty" />}
              <button type="button" className="tree-name" onClick={() => openFolder(f.id)}>
                <FolderIcon size={15} /> <span className="ellipsis">{f.name}</span>
              </button>
              <span className="count">{f.items.toLocaleString()}</span>
            </div>
          ))}
          <button type="button" className="side-row faint" onClick={() => setDialog({ t: 'newFolder', parent: view.kind === 'folder' ? view.id : null })}>
            <PlusIcon size={14} /> New folder
          </button>
        </aside>

        <main className="lib-main" ref={scroller} data-drop={view.kind === 'folder' ? `folder:${view.id ?? 'top'}` : 'folder:top'}>
          {s.restoredFromBackup && (
            <div className="notice">The library database was damaged, so the most recent backup was used. Recent changes may be missing.</div>
          )}
          {storage && storage.looseObjects > 0 && !storageJob && (
            <div className="info row-between">
              <span>
                This vault keeps every item and thumbnail as a separate file ({storage.files.toLocaleString()} files).
                Packing them into a few large files makes backups much easier. Your files stay encrypted, and nothing is
                deleted until the packed copies are checked.
              </span>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => api.storageTask('convert').catch((e) => setError(String(e)))}>
                Pack now
              </button>
            </div>
          )}
          <div className="lib-head">
            {view.kind === 'folder' && (
              <span className="crumbs">
                <button type="button" className="link" onClick={() => setView({ kind: 'folders' })}>All folders</button>
                {folder?.path.map((c) => (
                  <span key={c.id}> › <button type="button" className="link" onClick={() => openFolder(c.id)}>{c.name}</button></span>
                ))}
                {' ›'}
              </span>
            )}
            <h1>{view.kind === 'search' ? `Tagged ${view.tags.map((t) => `“${t}”`).join(' + ')}` : viewTitle(view, folder)}</h1>
            <span className="faint">
              {view.kind === 'folders' ? `${cards.length} folders` : `${shown.length.toLocaleString()} items`}
              {loading && ' · loading…'}
            </span>
            {folder && (
              <div className="row" style={{ gap: 6 }}>
                {folder.tags.map((t) => (
                  <span key={t} className="chip">{t}
                    <button type="button" aria-label={`Remove tag ${t}`} onClick={() => act(() => api.untagFolder(folder.id, t))}><CloseIcon size={11} /></button>
                  </span>
                ))}
                <button type="button" className="chip dashed" onClick={() => setDialog({ t: 'folderTag', folder })}>+ tag folder</button>
                <Dropdown className="btn btn-sm" label="Folder ▾" items={folderMenu(folder).slice(1)} />
              </div>
            )}
            <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
              {view.kind === 'folders' ? (
                <div role="group" aria-label="Show" className="seg">
                  <button type="button" className={!everyFolder ? 'on' : ''} onClick={() => setEveryFolder(false)}>Top level</button>
                  <button type="button" className={everyFolder ? 'on' : ''} onClick={() => setEveryFolder(true)}>Every folder</button>
                </div>
              ) : (
                <>
                  <Dropdown label={`${SORTS.find((x) => x.id === sort)?.label} ▾`} items={SORTS.map((o) => ({ label: o.label, checked: o.id === sort, onSelect: () => setSort(o.id) }))} />
                  <Dropdown label={`${KINDS.find((x) => x.id === kind)?.label} ▾`} items={KINDS.map((o) => ({ label: o.label, checked: o.id === kind, onSelect: () => setKind(o.id) }))} />
                </>
              )}
              <label className="faint" htmlFor="tile-size" style={{ fontSize: 12 }}>Size</label>
              <input id="tile-size" type="range" min={120} max={320} step={10} value={tile} onChange={(e) => setTile(Number(e.target.value))} />
            </div>
          </div>

          {error && (
            <div className="error" role="alert">
              <span style={{ flex: 1 }}>{error}</span>
              <button type="button" className="link" onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}

          {cards.length > 0 && (
            <div className="fgrid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(tile * 1.1)}px, 1fr))` }}>
              {cards.map((f) => (
                <div key={f.id} className="fcard" data-drop={`folder:${f.id}`} onContextMenu={(e) => folderContext(e, f)}
                  onPointerEnter={() => setHoverCard(f.id)} onPointerLeave={() => setHoverCard((h) => (h === f.id ? null : h))}>
                  <button type="button" className={`fcover${f.coverKind === 'pdf' || f.coverKind === 'text' ? ' doc' : ''}`} onClick={() => openFolder(f.id)} aria-label={`Open ${f.name}`}>
                    {coverView(f)}
                    <span className="drop-label">Drop here</span>
                  </button>
                  <div className="fmeta">
                    <div style={{ minWidth: 0 }}>
                      <div className="fname ellipsis">{f.name}</div>
                      <div className="faint ellipsis" style={{ fontSize: 12 }}>
                        {view.kind === 'folders' && everyFolder && f.path.length > 0 ? `${f.path.map((c) => c.name).join(' › ')} · ` : ''}
                        {f.items.toLocaleString()} items{f.subfolders ? ` · ${f.subfolders} subfolder${f.subfolders > 1 ? 's' : ''}` : ''}
                      </div>
                    </div>
                    <Dropdown className="btn btn-icon btn-sm ghost" ariaLabel={`${f.name} options`} label="⋯" items={folderMenu(f)} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {view.kind !== 'folders' && (
            shown.length ? (
              <MediaGrid items={shown} tile={tile} selected={selected} anchor={anchor} scroller={scroller}
                onSelect={(sel, a) => { setSelected(sel); setAnchor(a); }}
                onOpen={(it) => playItems(false, it.id)}
                onContext={itemContext}
                preview={preview}
                onDropOnFolder={(ids, target) => act(async () => {
                  await api.moveItems(ids, target === 'folder:top' ? null : Number(target.slice(7)));
                  setSelected(new Set());
                })} />
            ) : !loading && (
              <div className="dropzone">
                <ImportIcon size={28} />
                <b>{view.kind === 'folder' ? 'This folder is empty' : view.kind === 'search' ? 'Nothing has all of these tags' : 'Nothing here yet'}</b>
                <span className="muted">Drag files, folders or .7z archives from Windows onto any folder to import them.</span>
              </div>
            )
          )}
          {view.kind === 'folders' && !folders.length && !loading && (
            <div className="dropzone">
              <ImportIcon size={28} />
              <b>Your vault is empty</b>
              <span className="muted">Drag files, folders or .7z archives here, or use Import. Folders and archives keep their structure.</span>
              <button type="button" className="btn" onClick={() => setDialog({ t: 'newFolder', parent: null })}><PlusIcon /> New folder</button>
            </div>
          )}
        </main>
      </div>

      {selected.size > 0 && (
        <div className="selbar" role="toolbar" aria-label="Selection">
          <b>{selected.size} selected</b>
          <button type="button" className="btn btn-sm" onClick={() => playItems(true, selIds[0], true)}><PlayIcon size={13} /> Play</button>
          <button type="button" className="btn btn-sm" onClick={() => {
            const allFav = selIds.every((id) => items.find((i) => i.id === id)?.favourite);
            act(() => api.setFavourite(selIds, !allFav));
          }}><HeartIcon size={14} /> Favourite</button>
          <button type="button" className="btn btn-sm" onClick={() => setDialog({ t: 'tagItems', ids: selIds })}><TagIcon /> Tag…</button>
          <button type="button" className="btn btn-sm" onClick={() => setDialog({ t: 'weight', ids: selIds, current: items.find((i) => i.id === selIds[0])?.weight ?? 1 })}>
            <WeightIcon /> Weight…</button>
          <button type="button" className="btn btn-sm" onClick={() => setDialog({ t: 'moveItems', ids: selIds })}><MoveIcon /> Move to…</button>
          {folder && selected.size === 1 && (
            <button type="button" className="btn btn-sm" onClick={() => act(() => api.setCover(folder.id, selIds[0]))}>Set as folder cover</button>
          )}
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setDialog({ t: 'deleteItems', ids: selIds })}><TrashIcon /> Delete</button>
          <button type="button" className="link" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {(totalImporting.length > 0 || reports.length > 0 || storageJob || storageMsg) && (
        <section className="imports" aria-label="Import progress">
          {storageJob && (
            <div className="icard">
              <b>{storageJob.task === 'convert' ? 'Packing files' : 'Reclaiming space'}</b>
              <div className="bar"><div style={{ width: `${storageJob.total ? (storageJob.done / storageJob.total) * 100 : 0}%` }} /></div>
              <span className="mono faint" style={{ fontSize: 12 }}>{storageJob.done.toLocaleString()} / {storageJob.total.toLocaleString()}</span>
            </div>
          )}
          {storageMsg && (
            <div className="icard">
              <div className="row-between">
                <b>{storageMsg.ok ? 'Done' : 'Stopped'}</b>
                <button type="button" className="link" onClick={() => setStorageMsg(null)}>Dismiss</button>
              </div>
              <span style={{ fontSize: 13 }}>{storageMsg.message}</span>
            </div>
          )}
          {totalImporting.map((p) => <ImportCard key={p.job} p={p} />)}
          {reports.map((r) => (
            <ImportSummary key={r.job} r={r} onClose={() => setReports((rs) => rs.filter((x) => x.job !== r.job))} />
          ))}
        </section>
      )}

      {dialog?.t === 'newFolder' && (
        <PromptDialog title="New folder" label="Name" confirm="Create" onClose={() => setDialog(null)}
          onSubmit={async (name) => { await api.createFolder(dialog.parent, name); await reload(); }} />
      )}
      {dialog?.t === 'rename' && (
        <PromptDialog title="Rename folder" label="Name" initial={dialog.folder.name} confirm="Rename" onClose={() => setDialog(null)}
          onSubmit={async (name) => { await api.renameFolder(dialog.folder.id, name); await reload(); }} />
      )}
      {dialog?.t === 'folderTag' && (
        <PromptDialog title={`Tag “${dialog.folder.name}”`} label="Tags (separate with commas)" confirm="Add"
          hint="Everything inside this folder, including subfolders, counts as tagged." onClose={() => setDialog(null)}
          onSubmit={async (v) => { await api.tagFolder(dialog.folder.id, v.split(',')); await reload(); }} />
      )}
      {dialog?.t === 'tagItems' && (
        <TagItemsDialog ids={dialog.ids} all={tags} onClose={() => setDialog(null)} onDone={reload} />
      )}
      {dialog?.t === 'weight' && (
        <PromptDialog title={`Weight for ${dialog.ids.length} item${dialog.ids.length > 1 ? 's' : ''}`} label="Weight" type="number"
          initial={String(dialog.current)} confirm="Set weight" onClose={() => setDialog(null)}
          hint="Used by “Weighted random”: weight 5 comes up about five times as often as weight 1. 0 = never. Files without a weight count as 1."
          onSubmit={async (v) => {
            const w = Number(v.replace(',', '.'));
            if (!Number.isFinite(w)) throw new Error('Enter a number, e.g. 1, 2.5 or 10.');
            await api.setWeight(dialog.ids, w);
            await reload();
          }} />
      )}
      {dialog?.t === 'moveItems' && (
        <FolderPicker title={`Move ${dialog.ids.length} item${dialog.ids.length > 1 ? 's' : ''} to…`} folders={folders} confirm="Move"
          onClose={() => setDialog(null)} onPick={async (f) => { await api.moveItems(dialog.ids, f); setSelected(new Set()); await reload(); }} />
      )}
      {dialog?.t === 'moveFolder' && (
        <FolderPicker title={`Move “${dialog.folder.name}” into…`} folders={folders} exclude={[dialog.folder.id]} confirm="Move"
          onClose={() => setDialog(null)} onPick={async (f) => { await api.moveFolder(dialog.folder.id, f); await reload(); }} />
      )}
      {dialog?.t === 'deleteFolder' && (
        <ConfirmDialog title={`Delete “${dialog.folder.name}”?`} confirm="Delete from vault" danger onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteFolder(dialog.folder.id);
            if (view.kind === 'folder' && (view.id === dialog.folder.id || folder?.path.some((c) => c.id === dialog.folder.id))) setView({ kind: 'folders' });
            else await reload();
            nav.refresh().catch(() => {});
          }}>
          This removes the folder, its {dialog.folder.subfolders} subfolder(s) and all {dialog.folder.items.toLocaleString()} item(s) inside from the vault.
          Your original files outside the vault are not touched. This can't be undone.
        </ConfirmDialog>
      )}
      {dialog?.t === 'deleteItems' && (
        <ConfirmDialog title={`Delete ${dialog.ids.length} item${dialog.ids.length > 1 ? 's' : ''}?`} confirm="Delete from vault" danger
          onClose={() => setDialog(null)} onConfirm={async () => { await api.deleteItems(dialog.ids); setSelected(new Set()); await reload(); nav.refresh().catch(() => {}); }}>
          They are removed from the vault for good. Your original files outside the vault are not touched.
        </ConfirmDialog>
      )}
      {dialog?.t === 'cover' && (
        <CoverPicker folder={dialog.folder} onClose={() => setDialog(null)} onPicked={async (id) => {
          await api.setCover(dialog.folder.id, id);
          await reload();
        }} />
      )}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} title={ctx.title} items={ctx.items} onClose={() => setCtx(null)} />}
      {dialog?.t === 'archivePassword' && (
        <ArchivePasswordDialog summary={dialog.summary} onClose={() => setDialog(null)}
          onImport={async (pw) => { await api.startImport(dialog.paths, dialog.target, pw); }} />
      )}
    </div>
  );
}

function SearchBar(props: { tags: TagCount[]; value: string[]; onChange: (t: string[]) => void }) {
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const [hi, setHi] = useState(0);
  const q = text.trim().toLowerCase();
  const suggestions = props.tags
    .filter((t) => !props.value.some((v) => v.toLowerCase() === t.name.toLowerCase()))
    .filter((t) => !q || t.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
    .slice(0, 8);
  const add = (t: string) => {
    if (!t.trim()) return;
    props.onChange([...props.value, t.trim()]);
    setText('');
    setHi(0);
  };
  return (
    <div className="search">
      <SearchIcon />
      {props.value.map((t) => (
        <span key={t} className="chip accent">{t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => props.onChange(props.value.filter((x) => x !== t))}><CloseIcon size={11} /></button>
        </span>
      ))}
      <label htmlFor="tag-search" className="sr-only">Search by tag</label>
      <input id="tag-search" value={text} placeholder={props.value.length ? 'Add another tag…' : 'Search by tag…'} autoComplete="off"
        onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
        onChange={(e) => { setText(e.target.value); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(suggestions[hi]?.name ?? text); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, suggestions.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Backspace' && !text && props.value.length) props.onChange(props.value.slice(0, -1));
          else if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }} />
      {focus && suggestions.length > 0 && (
        <div className="menu suggest" role="listbox">
          {suggestions.map((t, i) => (
            <button key={t.name} type="button" role="option" aria-selected={i === hi} className={`menu-item${i === hi ? ' on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); add(t.name); }}>
              <TagIcon size={13} /> {t.name}
              <span className="hint">{t.items ? `${t.items} items` : ''}{t.items && t.folders ? ' · ' : ''}{t.folders ? `${t.folders} folders` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TagItemsDialog(props: { ids: number[]; all: TagCount[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [own, setOwn] = useState<string[]>([]);
  const [inherited, setInherited] = useState<[string, string][]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const single = props.ids.length === 1;
  const load = useCallback(async () => {
    if (!single) return;
    const t = await api.itemTags(props.ids[0]);
    setOwn(t.own);
    setInherited(t.inherited);
  }, [props.ids, single]);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    const list = text.split(',').map((t) => t.trim()).filter(Boolean);
    if (!list.length) return;
    try {
      await api.tagItems(props.ids, list);
      setText('');
      await load();
      await props.onDone();
    } catch (e) { setErr(String(e)); }
  };
  const remove = async (t: string) => {
    await api.untagItems(props.ids, t);
    await load();
    await props.onDone();
  };
  return (
    <Modal title={single ? 'Tags' : `Tag ${props.ids.length} items`} onClose={props.onClose}>
      {single && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            {own.length ? own.map((t) => (
              <span key={t} className="chip">{t}<button type="button" aria-label={`Remove ${t}`} onClick={() => remove(t)}><CloseIcon size={11} /></button></span>
            )) : <span className="faint">No tags of its own yet.</span>}
          </div>
          {inherited.length > 0 && (
            <div className="faint" style={{ fontSize: 13 }}>
              Also tagged through folders: {inherited.map(([t, f]) => `${t} (from ${f})`).join(', ')}
            </div>
          )}
        </div>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="input" style={{ flex: 1 }} list="known-tags" value={text} autoFocus aria-label="New tags"
          placeholder="Add tags, separated by commas" onChange={(e) => setText(e.target.value)} />
        <datalist id="known-tags">{props.all.map((t) => <option key={t.name} value={t.name} />)}</datalist>
        <button type="submit" className="btn btn-primary">Add</button>
      </form>
      {!single && (
        <form className="row" onSubmit={async (e) => {
          e.preventDefault();
          const t = (new FormData(e.currentTarget).get('rm') as string).trim();
          if (t) { await remove(t); (e.currentTarget as HTMLFormElement).reset(); }
        }}>
          <input name="rm" className="input" style={{ flex: 1 }} list="known-tags" placeholder="Remove a tag from all of them" aria-label="Tag to remove" />
          <button type="submit" className="btn">Remove</button>
        </form>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Done</button>
      </div>
    </Modal>
  );
}

function ArchivePasswordDialog(props: { summary: DropSummary; onClose: () => void; onImport: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = props.summary.archives.filter((a) => a.needsPassword);
  return (
    <Modal title="Archive password" onClose={props.onClose}>
      <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>
        {locked.length === 1 ? `“${locked[0].name}” is` : `${locked.length} archives are`} password-protected.
        Files are decrypted in memory and go straight into the vault — nothing is extracted to disk.
        The password is not saved.
      </p>
      <ul className="faint" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
        {props.summary.archives.map((a) => (
          <li key={a.path}>{a.name}{a.parts > 1 ? ` (${a.parts} parts)` : ''}{a.error ? ` — ${a.error}` : ''}</li>
        ))}
      </ul>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          for (const a of locked) await api.checkArchivePassword(a.path, pw);
          await props.onImport(pw);
          props.onClose();
        } catch (x) {
          setErr(x instanceof Error ? x.message : String(x));
        } finally {
          setBusy(false);
        }
      }}>
        <div className="field">
          <label htmlFor="arch-pw">Password{locked.length > 1 ? ' (tried on all of them)' : ''}</label>
          <input id="arch-pw" className="input" type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} />
        </div>
        {err && <div className="error" role="alert">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!pw || busy}>{busy ? 'Checking…' : 'Import'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportCard({ p }: { p: ImportProgress }) {
  const started = useRef(Date.now());
  const secs = (Date.now() - started.current) / 1000;
  const speed = secs > 1 ? p.bytes / secs : 0;
  const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
  const left = speed > 0 && p.done > 0 && p.total > p.done ? ((secs / p.done) * (p.total - p.done)) : 0;
  return (
    <div className="icard">
      <div className="row-between">
        <b className="ellipsis">Importing {p.source || '…'}</b>
        <button type="button" className="link" onClick={() => api.cancelImport(p.job)}>Cancel</button>
      </div>
      <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      <div className="row-between mono faint" style={{ fontSize: 12 }}>
        <span>{p.done.toLocaleString()} / {p.total.toLocaleString()} files</span>
        <span>{speed ? `${formatBytes(speed)}/s` : ''}{left > 5 ? ` · ~${Math.ceil(left / 60)} min left` : ''}</span>
      </div>
      <div className="faint ellipsis" style={{ fontSize: 12 }}>{p.current}</div>
    </div>
  );
}

function ImportSummary({ r, onClose }: { r: ImportReport; onClose: () => void }) {
  const [more, setMore] = useState(false);
  return (
    <div className="icard">
      <div className="row-between">
        <b>{r.cancelled ? 'Import cancelled' : 'Import finished'}</b>
        <button type="button" className="link" onClick={onClose}>Dismiss</button>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        {r.imported.toLocaleString()} imported ({formatBytes(r.bytes)} in {Math.max(1, Math.round(r.seconds))} s)
        {r.duplicates > 0 && <> · {r.duplicates} already in that folder</>}
        {r.skippedCount > 0 && <> · {r.skippedCount} not media, skipped</>}
      </div>
      {r.failed.length > 0 && (
        <div className="error" style={{ flexDirection: 'column', gap: 4 }}>
          {(more ? r.failed : r.failed.slice(0, 3)).map(([n, why], i) => <span key={i}>{n}: {why}</span>)}
          {r.failed.length > 3 && !more && <button type="button" className="link" onClick={() => setMore(true)}>Show all {r.failed.length}</button>}
        </div>
      )}
    </div>
  );
}

function CoverPicker(props: { folder: FolderCard; onClose: () => void; onPicked: (id: number | null) => Promise<void> }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.queryItems({ folder: props.folder.id, recursive: true }).then((x) => setItems(x.slice(0, 600))).catch((e) => setErr(String(e)));
  }, [props.folder.id]);
  const pick = async (id: number | null) => {
    try {
      await props.onPicked(id);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title={`Cover for “${props.folder.name}”`} onClose={props.onClose} wide>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        Pick any picture, GIF or video inside this folder (or its subfolders). Videos and GIFs play on the card when previews are on.
      </p>
      {err && <div className="error">{err}</div>}
      <div className="cover-grid">
        <button type="button" className={`cover-pick${props.folder.cover == null ? ' on' : ''}`} onClick={() => pick(null)}>
          <span className="tile-msg">Automatic<br />(first picture)</span>
        </button>
        {items?.map((it) => (
          <button key={it.id} type="button" title={it.name} className={`cover-pick${props.folder.cover === it.id ? ' on' : ''}${it.kind === 'pdf' || it.kind === 'text' ? ' doc' : ''}`} onClick={() => pick(it.id)}>
            {it.thumb === 'ok' ? <img src={thumbUrl(it.id)} alt={it.name} loading="lazy" /> : <span className="tile-msg">{it.name}</span>}
            {it.kind !== 'image' && <span className="badge">{it.kind === 'video' ? 'VIDEO' : it.kind.toUpperCase()}</span>}
          </button>
        ))}
        {!items && <span className="faint">Loading…</span>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}
