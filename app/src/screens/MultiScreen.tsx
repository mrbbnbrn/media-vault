// Multi-screen: 1, 2, 4, 6 or 8 players side by side, each with its own
// source, order, repeat, speed and sound. Also the "Open player" screen,
// which plays files and folders dropped from Windows without any vault.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api, inTauri, type FolderCard, type Named, type TagCount } from '../api';
import type { Nav } from '../App';
import { Dropdown, FolderPicker, Modal, PromptDialog } from '../components/Dialogs';
import { CloseIcon, FullscreenIcon, ImportIcon, MuteIcon, PauseIcon, PlayIcon, SoundIcon } from '../components/Icons';
import { Player, type PlayerHandle } from '../components/Player';
import { setDropHandler } from '../drop';
import { setCleanFullscreen } from '../fullscreen';
import { fromItem, fromLocal, type PlayItem } from '../media';
import { DEFAULT_PLAYBACK, normalize, type PlaybackSettings } from '../presets';
import { SettingsMenu } from './Viewer';

export type Source =
  | { t: 'folder'; id: number; name: string; recursive: boolean }
  | { t: 'tags'; tags: string[] }
  | { t: 'favourites' }
  | { t: 'all' }
  | { t: 'local'; paths: string[]; title: string };

interface Panel {
  id: number;
  source: Source | null;
  settings: PlaybackSettings;
  items: PlayItem[];
  startKey?: string;
  error?: string;
}

interface LayoutSettings {
  n: number;
  master: number;
  panels: { source: Source | null; settings: PlaybackSettings }[];
}

const LAYOUTS = [1, 2, 4, 6, 8];
const COLS: Record<number, number> = { 1: 1, 2: 2, 4: 2, 6: 3, 8: 4 };

function sourceLabel(s: Source | null): string {
  if (!s) return 'Empty';
  switch (s.t) {
    case 'folder': return s.name + (s.recursive ? '' : ' (this folder only)');
    case 'tags': return `Tag: ${s.tags.join(' + ')}`;
    case 'favourites': return 'Favourites';
    case 'all': return 'Everything';
    case 'local': return s.title;
  }
}

async function resolve(s: Source): Promise<{ items: PlayItem[]; startKey?: string; title?: string }> {
  switch (s.t) {
    case 'folder': return { items: (await api.queryItems({ folder: s.id, recursive: s.recursive })).map(fromItem) };
    case 'tags': return { items: (await api.queryItems({ tags: s.tags })).map(fromItem) };
    case 'favourites': return { items: (await api.queryItems({ favouritesOnly: true })).map(fromItem) };
    case 'all': return { items: (await api.queryItems({})).map(fromItem) };
    case 'local': {
      const set = await api.scanLocal(s.paths);
      const items = set.items.map(fromLocal);
      return { items, startKey: items[set.start]?.key, title: set.title };
    }
  }
}

let nextId = 1;
const blank = (settings = DEFAULT_PLAYBACK): Panel => ({ id: nextId++, source: null, settings, items: [] });

/** Panels survive leaving and coming back during this session (not saved to disk). */
let remembered: { n: number; panels: Panel[]; master: number } | null = null;

export function MultiScreen({ nav, onBack, vault }: { nav: Nav; onBack: () => void; vault: boolean }) {
  const [n, setN] = useState(remembered?.n ?? (vault ? 4 : 1));
  const [panels, setPanels] = useState<Panel[]>(() => remembered?.panels ?? Array.from({ length: 8 }, () => blank()));
  const [master, setMaster] = useState(remembered?.master ?? 0.8);
  const [masterMuted, setMasterMuted] = useState(false);
  const [allPaused, setAllPaused] = useState(false);
  const [focus, setFocus] = useState(0);
  const [clean, setClean] = useState(false);
  const [mouse, setMouse] = useState(true);
  const [picking, setPicking] = useState<{ panel: number; kind: 'menu' | 'folder' | 'tags' } | null>(null);
  const [folders, setFolders] = useState<FolderCard[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [layouts, setLayouts] = useState<Named<LayoutSettings>[]>([]);
  const [saving, setSaving] = useState(false);
  const handles = useRef<(PlayerHandle | null)[]>([]);
  const mouseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    remembered = { n, panels, master };
  }, [n, panels, master]);

  useEffect(() => {
    if (!vault) return;
    api.folders().then(setFolders).catch(() => {});
    api.allTags().then(setTags).catch(() => {});
    api.listNamed<LayoutSettings>('layout').then(setLayouts).catch(() => {});
  }, [vault]);

  const update = (idx: number, patch: Partial<Panel>) => setPanels((ps) => ps.map((p, i) => (i === idx ? { ...p, ...patch } : p)));

  const assign = useCallback(async (idx: number, source: Source) => {
    try {
      const r = await resolve(source);
      const src = source.t === 'local' && r.title ? { ...source, title: r.title } : source;
      setPanels((ps) => ps.map((p, i) => (i === idx ? { ...p, source: src, items: r.items, startKey: r.startKey, error: r.items.length ? undefined : 'Nothing to play there.' } : p)));
    } catch (e) {
      update(idx, { error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // Files dropped from Windows play in the panel they land on (never imported).
  useEffect(() => {
    setDropHandler((paths, target) => {
      let idx = target?.startsWith('player:') ? Number(target.slice(7)) : -1;
      if (idx < 0 || idx >= n) {
        const empty = panels.slice(0, n).findIndex((p) => !p.source);
        idx = empty >= 0 ? empty : focus;
      }
      assign(idx, { t: 'local', paths, title: 'Dropped files' });
    });
    return () => setDropHandler(null);
  });

  const toggleClean = useCallback(async () => {
    const next = !clean;
    setClean(next);
    await setCleanFullscreen(next);
  }, [clean]);
  useEffect(() => () => void setCleanFullscreen(false), []);

  const pauseAll = (p: boolean) => {
    setAllPaused(p);
    handles.current.slice(0, n).forEach((h) => h?.setPaused(p));
  };

  // Keyboard: Space pause all, 1–8 choose a panel, ←/→ and M act on it, F clean full screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role=dialog]')) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); pauseAll(!allPaused); }
      else if (/^[1-8]$/.test(k) && Number(k) <= n) setFocus(Number(k) - 1);
      else if (k === 'arrowright') handles.current[focus]?.next();
      else if (k === 'arrowleft') handles.current[focus]?.prev();
      else if (k === 'm') handles.current[focus]?.toggleMute();
      else if (k === 'f') toggleClean();
      else if (k === 'escape') { if (clean) toggleClean(); else onBack(); }
      else return;
      pokeMouse();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pokeMouse = () => {
    setMouse(true);
    if (mouseTimer.current) clearTimeout(mouseTimer.current);
    mouseTimer.current = setTimeout(() => setMouse(false), 2500);
  };

  const controlsOnMouse = nav.app.config.fullscreenControlsOnMouse;
  const showBar = !clean || (controlsOnMouse && mouse);

  const saveLayout = async (name: string) => {
    const settings: LayoutSettings = { n, master, panels: panels.slice(0, n).map((p) => ({ source: p.source, settings: p.settings })) };
    await api.saveNamed('layout', { id: null, name, settings });
    setLayouts(await api.listNamed<LayoutSettings>('layout'));
  };
  const loadLayout = async (l: Named<LayoutSettings>) => {
    const s = l.settings;
    const count = LAYOUTS.includes(s.n) ? s.n : 4;
    const fresh = Array.from({ length: 8 }, (_, i) => blank(normalize(s.panels[i]?.settings)));
    setPanels(fresh);
    setN(count);
    setMaster(typeof s.master === 'number' ? s.master : 0.8);
    s.panels.slice(0, count).forEach((p, i) => p.source && assign(i, p.source));
  };

  const cols = COLS[n];
  const rows = Math.ceil(n / cols);
  const shown = panels.slice(0, n);
  const layoutItems = useMemo(() => [
    ...layouts.map((l) => ({ label: l.name, onSelect: () => loadLayout(l) })),
    { label: 'Save this layout…', onSelect: () => setSaving(true), disabled: !vault },
    ...layouts.map((l) => ({ label: `Delete “${l.name}”`, danger: true, onSelect: async () => {
      if (l.id != null) await api.deleteNamed('layout', l.id);
      setLayouts(await api.listNamed<LayoutSettings>('layout'));
    } })),
  ], [layouts, vault]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickMenu = (idx: number) => [
    ...(vault ? [
      { label: 'A folder…', onSelect: () => setPicking({ panel: idx, kind: 'folder' }) },
      { label: 'Tags…', onSelect: () => setPicking({ panel: idx, kind: 'tags' }) },
      { label: 'Favourites', onSelect: () => assign(idx, { t: 'favourites' }) },
      { label: 'Everything in the vault', onSelect: () => assign(idx, { t: 'all' }) },
    ] : []),
    { label: 'Files on this PC…', onSelect: () => pickLocal(idx, false) },
    { label: 'A folder on this PC…', onSelect: () => pickLocal(idx, true) },
    ...(shown[idx]?.source ? [{ label: 'Clear this panel', danger: true, onSelect: () => update(idx, { source: null, items: [], error: undefined }) }] : []),
  ];

  const pickLocal = async (idx: number, directory: boolean) => {
    if (!inTauri) return;
    const r = await open({ directory, multiple: true, title: directory ? 'Play a folder' : 'Play files',
      filters: directory ? undefined : [{ name: 'Media', extensions: ['mp4', 'm4v', 'webm', 'gif', 'webp', 'png', 'jpg', 'jpeg'] }] });
    const paths = Array.isArray(r) ? r : r ? [r] : [];
    if (paths.length) assign(idx, { t: 'local', paths, title: 'Files' });
  };

  return (
    <div className={`multi${clean ? ' clean' : ''}${clean && !mouse ? ' no-cursor' : ''}`} onMouseMove={pokeMouse}>
      {showBar && (
        <div className={`mbar${clean ? ' floating' : ''}`}>
          {!vault && <span className="brand-sm">Player</span>}
          <div role="group" aria-label="Layout" className="seg">
            {LAYOUTS.map((k) => (
              <button key={k} type="button" className={k === n ? 'on' : ''} aria-label={`${k} panel${k > 1 ? 's' : ''}`}
                onClick={() => { setN(k); setFocus((f) => Math.min(f, k - 1)); }}>{k}</button>
            ))}
          </div>
          <label className="row faint" style={{ gap: 8, fontSize: 13 }}>
            Master
            <input type="range" min={0} max={1} step={0.01} value={master} onChange={(e) => setMaster(Number(e.target.value))} aria-label="Master volume" />
          </label>
          <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => pauseAll(!allPaused)}>
              {allPaused ? <><PlayIcon size={13} /> Play all</> : <><PauseIcon size={13} /> Pause all</>}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setMasterMuted((m) => !m)} aria-pressed={masterMuted}>
              {masterMuted ? <><SoundIcon size={15} /> Unmute all</> : <><MuteIcon size={15} /> Mute all</>}
            </button>
            {vault && <Dropdown label="Layouts ▾" items={layoutItems} />}
            <button type="button" className="btn btn-sm btn-primary" onClick={toggleClean}>
              <FullscreenIcon size={15} /> {clean ? 'Leave full screen' : 'Clean full screen'} <span className="kbd-sm">F</span>
            </button>
            <button type="button" className="btn btn-sm" onClick={() => (clean ? toggleClean() : onBack())}>
              {clean ? 'Exit full screen' : vault ? 'Back to library' : 'Close player'} <span className="kbd-sm">Esc</span>
            </button>
          </div>
        </div>
      )}

      <div className="mgrid-panels" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
        {shown.map((p, i) => (
          <div key={p.id} className={`panel${i === focus && n > 1 && !clean ? ' focus' : ''}`} data-drop={`player:${i}`} onMouseDown={() => setFocus(i)}>
            {p.source && p.items.length ? (
              <Player
                ref={(h) => { handles.current[i] = h; }}
                items={p.items}
                startKey={p.startKey}
                settings={p.settings}
                onSettings={(s) => update(i, { settings: s })}
                autoSlideshow
                masterVolume={master}
                masterMuted={masterMuted}
                compact
                clean={clean}
                controlsOnMouse={controlsOnMouse}
                activityId={`panel-${p.id}`}
                title={<span className="chip-dark ellipsis">{n > 1 ? `${i + 1} · ` : ''}{sourceLabel(p.source)}</span>}
                panelExtra={
                  <>
                    <SettingsMenu compact s={p.settings} set={(x) => update(i, { settings: { ...p.settings, ...x } })} />
                    <Dropdown up className="pbtn wide" label="Source…" items={pickMenu(i)} />
                  </>
                }
              />
            ) : (
              <div className="panel-empty">
                {p.error && <span className="error-text">{p.error}</span>}
                <ImportIcon size={26} />
                <b>{n > 1 ? `Panel ${i + 1}` : 'Nothing playing'}</b>
                <span className="muted">Drop files or a folder from Windows here{vault ? ', or choose from the vault' : ''}.</span>
                <Dropdown className="btn btn-sm" label="Choose what to play ▾" items={pickMenu(i)} />
              </div>
            )}
          </div>
        ))}
      </div>

      {picking?.kind === 'folder' && (
        <FolderPicker title="Play a folder" folders={folders} confirm="Play" topLabel="Everything in the vault" onClose={() => setPicking(null)}
          onPick={async (f) => {
            if (f == null) await assign(picking.panel, { t: 'all' });
            else await assign(picking.panel, { t: 'folder', id: f, name: folders.find((x) => x.id === f)?.name ?? 'Folder', recursive: true });
          }} />
      )}
      {picking?.kind === 'tags' && (
        <TagPicker tags={tags} onClose={() => setPicking(null)} onPick={(t) => assign(picking.panel, { t: 'tags', tags: t })} />
      )}
      {saving && (
        <PromptDialog title="Save layout" label="Name" confirm="Save" onClose={() => setSaving(false)}
          hint="Saves the number of panels and each panel's source and settings." onSubmit={saveLayout} />
      )}
    </div>
  );
}

function TagPicker({ tags, onPick, onClose }: { tags: TagCount[]; onPick: (t: string[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState<string[]>([]);
  return (
    <Modal title="Play by tag" onClose={onClose}>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>Pick one or more tags. Items need all of them (folder tags count too).</p>
      <div className="row" style={{ gap: 6, maxHeight: 280, overflow: 'auto' }}>
        {tags.length ? tags.map((t) => {
          const on = sel.includes(t.name);
          return (
            <button key={t.name} type="button" className={`chip${on ? ' accent' : ''}`} aria-pressed={on}
              onClick={() => setSel((s) => (on ? s.filter((x) => x !== t.name) : [...s, t.name]))}>
              {t.name}{on && <CloseIcon size={11} />}
            </button>
          );
        }) : <span className="faint">No tags yet.</span>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!sel.length} onClick={() => { onPick(sel); onClose(); }}>Play</button>
      </div>
    </Modal>
  );
}
