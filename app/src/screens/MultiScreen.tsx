// Multi-screen: several players at once, each with its own source, order,
// repeat, speed and sound. Layouts: 1–8 panels in a grid, shaped layouts
// (circles, diamonds, bubbles… every area is a panel), and a wall of many
// small tiles that swap at random. Double-click a panel to watch it alone;
// the others pause and continue where they were when you come back.
// Also the "Open player" screen, which plays files and folders dropped from
// Windows without any vault.

import { errText } from '../text';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api, inTauri, type FolderCard, type Named, type TagCount } from '../api';
import type { Nav } from '../App';
import { Dropdown, FolderPicker, Modal, PromptDialog } from '../components/Dialogs';
import {
  CloseIcon, FullscreenIcon, GridIcon, ImportIcon, LoopIcon, MuteIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, SoundIcon,
} from '../components/Icons';
import { lookMenuItems } from '../components/MediaLooks';
import { Player, type PlayerHandle } from '../components/Player';
import { Wall, WALL_SIZES, WALL_SPEEDS } from '../components/Wall';
import { MosaicWall } from '../components/MosaicWall';
import { DEFAULT_MOSAIC, MOSAIC_SIZES, MOSAIC_SPEEDS, normalizeMosaic, type MosaicSettings } from '../mosaic';
import { setDropHandler } from '../drop';
import { setCleanFullscreen } from '../fullscreen';
import { fromItem, fromLocal, type PlayItem } from '../media';
import { DEFAULT_PLAYBACK, normalize, type PlaybackSettings } from '../presets';
import { rememberSound, unmuteVolume, withSound } from '../prefs';
import { buildShapes, type ShapePanel, GRID_LAYOUTS, layoutDef, MAX_PANELS, SHAPE_GROUPS, SHAPE_LAYOUTS } from '../shapes';
import { fitRectInShape } from '../shapefit';
import { SettingsMenu } from './Viewer';
import { useLayer } from '../keylayers';
import { freeEntry, freeSnapshot, restoreFree, type FreeSnapshot } from '../customLayouts';
import { LayoutEditor, MyLayoutsMenu, useFreeLayouts, type EditTarget } from '../components/LayoutEditor';

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

interface WallState {
  source: Source | null;
  items: PlayItem[];
  count: number;
  speed: 'calm' | 'normal' | 'fast';
  error?: string;
}

interface LayoutSettings {
  /** Older saved layouts only have the panel count. */
  n?: number;
  layout?: string;
  master: number;
  panels: { source: Source | null; settings: PlaybackSettings }[];
  wall?: { source: Source | null; count: number; speed: WallState['speed'] };
  /** Mosaic mode (shares the wall's source). Older saves do not have it. */
  mosaic?: MosaicSettings;
  /** The free-form layout's boxes, when it uses one. */
  free?: FreeSnapshot;
}

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

// ---- fit, "Repeat this one" and "Apply to every window…" (begin) ----
/** For Fit: a tilted panel's shape as seen by its turned media. */
function turnedShape(sp: ShapePanel): Pick<ShapePanel, 'box' | 'd' | 'outline'> {
  if (!sp.turn) return sp;
  return { box: { x: 0, y: 0, w: sp.turn.w, h: sp.turn.h }, d: '', outline: { kind: 'poly', pts: sp.turn.outline } };
}

const FIT_NAMES = { contain: 'Fit', cover: 'Fill', original: 'Original' } as const;

/** What "Apply to every window…" can copy, and the settings each part covers. */
type ApplyPart = 'playback' | 'sound' | 'fit' | 'source';
const APPLY_PARTS: { id: ApplyPart; label: string }[] = [
  { id: 'playback', label: 'Playback (speed, order, repeat, timing, transitions)' },
  { id: 'sound', label: 'Sound (volume, mute)' },
  { id: 'fit', label: 'Fit and looks (mirror world, echo trail)' },
  { id: 'source', label: 'What it shows (source)' },
];
const PART_KEYS: Record<Exclude<ApplyPart, 'source'>, (keyof PlaybackSettings)[]> = {
  playback: ['imageSeconds', 'videoMaxSeconds', 'videoRandomStart', 'gifLoops', 'gifMaxSeconds', 'order', 'repeat', 'repeatThis', 'speed',
    'transition', 'fadeMs', 'beatSync', 'beatEvery', 'beatMinSeconds', 'kenBurns'],
  sound: ['volume', 'muted'],
  fit: ['fit', 'blurBg', 'mirror', 'echo'],
};
const APPLY_KEY = 'multiscreen.applyToAll';
function lastApplyParts(): ApplyPart[] {
  try {
    const v = JSON.parse(localStorage.getItem(APPLY_KEY) ?? 'null');
    if (Array.isArray(v)) return v.filter((x): x is ApplyPart => APPLY_PARTS.some((p) => p.id === x));
  } catch { /* not available */ }
  return ['playback', 'sound', 'fit'];
}
function rememberApplyParts(parts: ApplyPart[]) {
  try {
    localStorage.setItem(APPLY_KEY, JSON.stringify(parts));
  } catch { /* not available */ }
}
/** The chosen parts of `from`'s settings, to lay over another panel's. */
function pickSettings(from: PlaybackSettings, parts: ApplyPart[]): Partial<PlaybackSettings> {
  const out: Partial<PlaybackSettings> = {};
  for (const part of parts) {
    if (part === 'source') continue;
    for (const k of PART_KEYS[part]) (out as Record<string, unknown>)[k] = from[k];
  }
  return out;
}
// ---- fit, "Repeat this one" and "Apply to every window…" (end) ----

let nextId = 1;
const blank = (settings?: PlaybackSettings): Panel => ({ id: nextId++, source: null, settings: settings ?? withSound(DEFAULT_PLAYBACK), items: [] });
const blankWall = (): WallState => ({ source: null, items: [], count: 20, speed: 'normal' });

/** Panels survive leaving and coming back during this session (not saved to disk). */
let remembered: { layout: string; panels: Panel[]; master: number; wall: WallState } | null = null;
let rememberedMosaic: MosaicSettings = DEFAULT_MOSAIC;

/** Small picture of a layout for the layout menu. */
function LayoutThumb({ id }: { id: string }) {
  const W = 96;
  const H = 54;
  const shapes = useMemo(() => buildShapes(id, W, H), [id]);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="lthumb">
      <rect width={W} height={H} rx="3" fill="#0b0c0e" />
      {[...shapes].map((p, i) => ({ p, i })).sort((a, b) => a.p.z - b.p.z).map(({ p, i }) => (
        <path key={i} d={p.d} transform={`translate(${p.box.x} ${p.box.y})`} fill={i === 0 ? 'var(--accent)' : i % 2 ? '#2d6f69' : '#22514d'}
          stroke="#0b0c0e" strokeWidth="1.4" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export function MultiScreen({ nav, onBack, vault }: { nav: Nav; onBack: () => void; vault: boolean }) {
  const [layout, setLayout] = useState(remembered?.layout ?? (vault ? '4' : '1'));
  const [panels, setPanels] = useState<Panel[]>(() => {
    const p = remembered?.panels ?? [];
    return [...p, ...Array.from({ length: Math.max(0, MAX_PANELS - p.length) }, () => blank())];
  });
  const [wall, setWall] = useState<WallState>(remembered?.wall ?? blankWall());
  const [mosaic, setMosaicState] = useState<MosaicSettings>(rememberedMosaic);
  const setMosaic = (patch: Partial<MosaicSettings>) => setMosaicState((m) => (rememberedMosaic = { ...m, ...patch }));
  const [master, setMaster] = useState(remembered?.master ?? 0.8);
  const [masterMuted, setMasterMuted] = useState(false);
  const [allPaused, setAllPaused] = useState(false);
  const [focus, setFocus] = useState(0);
  const [clean, setClean] = useState(false);
  const [mouse, setMouse] = useState(true);
  const [picking, setPicking] = useState<{ panel: number | 'wall'; kind: 'folder' | 'tags' } | null>(null);
  const [folders, setFolders] = useState<FolderCard[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [layouts, setLayouts] = useState<Named<LayoutSettings>[]>([]);
  const [saving, setSaving] = useState(false);
  const [shapeMenu, setShapeMenu] = useState(false);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const free = useFreeLayouts(vault, layout, (id) => changeLayout(id));
  const [solo, setSolo] = useState<number | null>(null);
  const [wallSolo, setWallSolo] = useState<PlayItem | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [applyFrom, setApplyFrom] = useState<number | null>(null);
  const [, bump] = useState(0);
  const [stage, setStage] = useState({ w: 1280, h: 720 });
  const handles = useRef<(PlayerHandle | null)[]>([]);
  const mouseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soloResume = useRef<number[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);

  // Mosaic is a kind of wall: same source, same "watch it alone".
  const isMosaic = layout === 'mosaic';
  const isWall = layout === 'wall' || isMosaic;
  const def = layoutDef(isWall ? '4' : layout);
  const n = isWall ? 0 : def.count;

  useEffect(() => {
    remembered = { layout, panels, master, wall };
  }, [layout, panels, master, wall]);

  useEffect(() => {
    if (!vault) return;
    api.folders().then(setFolders).catch(() => {});
    api.allTags().then(setTags).catch(() => {});
    api.listNamed<LayoutSettings>('layout').then(setLayouts).catch(() => {});
  }, [vault]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [isWall, def.kind, !!editing]);

  const update = (idx: number, patch: Partial<Panel>) => setPanels((ps) => ps.map((p, i) => (i === idx ? { ...p, ...patch } : p)));

  const assign = useCallback(async (idx: number | 'wall', source: Source) => {
    try {
      const r = await resolve(source);
      const src = source.t === 'local' && r.title ? { ...source, title: r.title } : source;
      if (idx === 'wall') {
        const items = r.items.filter((i) => i.kind === 'image' || i.kind === 'gif' || i.kind === 'video');
        setWall((w) => ({ ...w, source: src, items, error: items.length ? undefined : 'No pictures, GIFs or videos there.' }));
        return;
      }
      setPanels((ps) => ps.map((p, i) => (i === idx ? { ...p, source: src, items: r.items, startKey: r.startKey, error: r.items.length ? undefined : 'Nothing to play there.' } : p)));
    } catch (e) {
      if (idx === 'wall') setWall((w) => ({ ...w, error: errText(e) }));
      else update(idx, { error: errText(e) });
    }
  }, []);

  // Files dropped from Windows play in the panel they land on (never imported).
  useEffect(() => {
    setDropHandler((paths, target) => {
      if (isWall) return void assign('wall', { t: 'local', paths, title: 'Dropped files' });
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

  // ---- solo: one panel full size, the others wait ---------------------------------------

  const enterSolo = (i: number) => {
    const resume: number[] = [];
    handles.current.slice(0, n).forEach((h, j) => {
      if (j !== i && h && !h.isPaused()) {
        resume.push(j);
        h.setPaused(true);
      }
    });
    soloResume.current = resume;
    setSolo(i);
    setHover(null);
  };
  const exitSolo = () => {
    soloResume.current.forEach((j) => handles.current[j]?.setPaused(false));
    soloResume.current = [];
    setSolo(null);
  };
  const toggleSolo = (i: number) => (solo === i ? exitSolo() : solo == null ? enterSolo(i) : undefined);

  const changeLayout = (id: string) => {
    if (solo != null) exitSolo();
    setWallSolo(null);
    setLayout(id);
    const d = id === 'wall' || id === 'mosaic' ? null : layoutDef(id);
    if (d) setFocus((f) => Math.min(f, d.count - 1));
  };

  // Keyboard: Space pause all, 1–9 choose a panel, ←/→ and M act on it, F clean full screen, Esc.
  // Backspace, Alt+← and the mouse's back button go back, like everywhere.
  const backNow = () => {
    if (wallSolo) setWallSolo(null);
    else if (solo != null) exitSolo();
    else if (clean) toggleClean();
    else onBack();
  };
  const backRef = useRef(backNow);
  backRef.current = backNow;
  const layer = useLayer(true, { name: 'multi-screen', onBack: () => backRef.current() });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role=dialog]')) return;
      if (wallSolo) return; // the player on top has the keyboard
      if (!layer.mine()) return; // a menu or dialog on top has it
      const k = e.key.toLowerCase();
      if (k === 'backspace' || (e.altKey && k === 'arrowleft')) {
        e.preventDefault();
        backNow();
        return;
      }
      if (k === ' ') { e.preventDefault(); pauseAll(!allPaused); }
      else if (/^[1-9]$/.test(k) && Number(k) <= n) setFocus(Number(k) - 1);
      else if (k === 'arrowright') handles.current[focus]?.next();
      else if (k === 'arrowleft') handles.current[focus]?.prev();
      else if (k === 'm') handles.current[focus]?.toggleMute();
      else if (k === 'f') toggleClean();
      else if (k === 'escape') {
        if (solo != null) exitSolo();
        else if (clean) toggleClean();
        else onBack();
      } else return;
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

  // ---- saved layouts ---------------------------------------------------------------------

  const saveLayout = async (name: string) => {
    const settings: LayoutSettings = {
      n: isWall ? 4 : n,
      layout,
      master,
      panels: panels.slice(0, Math.max(n, 1)).map((p) => ({ source: p.source, settings: p.settings })),
      wall: { source: wall.source, count: wall.count, speed: wall.speed },
      mosaic,
      free: freeSnapshot(layout),
    };
    await api.saveNamed('layout', { id: null, name, settings });
    setLayouts(await api.listNamed<LayoutSettings>('layout'));
  };
  const loadLayout = async (l: Named<LayoutSettings>) => {
    const s = l.settings;
    const id = restoreFree(s.layout ?? String(s.n ?? 4), s.free, l.id ?? l.name);
    const count = id === 'wall' || id === 'mosaic' ? 0 : layoutDef(id).count;
    const fresh = Array.from({ length: MAX_PANELS }, (_, i) => blank(normalize(s.panels?.[i]?.settings)));
    setPanels(fresh);
    changeLayout(id);
    setMaster(typeof s.master === 'number' ? s.master : 0.8);
    (s.panels ?? []).slice(0, count).forEach((p, i) => p.source && assign(i, p.source));
    if (s.wall) {
      setWall({ ...blankWall(), count: WALL_SIZES.includes(s.wall.count) ? s.wall.count : 20, speed: s.wall.speed ?? 'normal' });
      if (s.wall.source) assign('wall', s.wall.source);
    }
    if (s.mosaic) setMosaic(normalizeMosaic(s.mosaic));
  };

  const layoutItems = useMemo(() => [
    ...layouts.map((l) => ({ label: l.name, onSelect: () => loadLayout(l) })),
    ...free.list.map((l, i) => ({ label: l.name, hint: 'my layout', sepBefore: i === 0 && layouts.length > 0, onSelect: () => changeLayout(l.id) })),
    { label: 'Edit layout…', sepBefore: true, onSelect: () => openEditor() },
    { label: 'Save this layout…', onSelect: () => setSaving(true), disabled: !vault },
    ...layouts.map((l) => ({ label: `Delete “${l.name}”`, danger: true, onSelect: async () => {
      if (l.id != null) await api.deleteNamed('layout', l.id);
      setLayouts(await api.listNamed<LayoutSettings>('layout'));
    } })),
  ], [layouts, vault, free.list, layout, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickMenu = (idx: number | 'wall') => [
    ...(vault ? [
      { label: 'A folder…', onSelect: () => setPicking({ panel: idx, kind: 'folder' }) },
      { label: 'Tags…', onSelect: () => setPicking({ panel: idx, kind: 'tags' }) },
      { label: 'Favourites', onSelect: () => assign(idx, { t: 'favourites' }) },
      { label: 'Everything in the vault', onSelect: () => assign(idx, { t: 'all' }) },
    ] : []),
    { label: 'Files on this PC…', onSelect: () => pickLocal(idx, false) },
    { label: 'A folder on this PC…', onSelect: () => pickLocal(idx, true) },
    ...(idx !== 'wall' && panels[idx]?.source
      ? [{ label: 'Clear this panel', danger: true, onSelect: () => update(idx, { source: null, items: [], error: undefined }) }] : []),
  ];

  const pickLocal = async (idx: number | 'wall', directory: boolean) => {
    if (!inTauri) return;
    const r = await open({ directory, multiple: true, title: directory ? 'Play a folder' : 'Play files',
      filters: directory ? undefined : [{ name: 'Media', extensions: ['mp4', 'm4v', 'webm', 'gif', 'webp', 'png', 'jpg', 'jpeg', 'pdf', 'txt'] }] });
    const paths = Array.isArray(r) ? r : r ? [r] : [];
    if (paths.length) assign(idx, { t: 'local', paths, title: 'Files' });
  };

  // ---- one panel ---------------------------------------------------------------------------

  /** "Repeat this one" and the fit menu (with "Apply to every window…"), in each panel's controls. */
  const panelTools = (i: number) => {
    const ps = panels[i].settings;
    const set = (x: Partial<PlaybackSettings>) => setPanels((all) => all.map((p, j) => (j === i ? { ...p, settings: { ...p.settings, ...x } } : p)));
    return (
      <>
        <button type="button" className={`pbtn${ps.repeatThis ? ' on' : ''}`} aria-pressed={!!ps.repeatThis}
          aria-label="Repeat this one" title={ps.repeatThis ? 'Repeating this one — click to go on with the slideshow' : 'Repeat this one: keep playing it over and over'}
          onClick={() => set({ repeatThis: !ps.repeatThis })}><LoopIcon size={14} /><small>1</small></button>
        <Dropdown up className="pbtn wide" label={FIT_NAMES[ps.fit] ?? 'Fit'} title="How it fits, and copying to every window" ariaLabel="Fit"
          items={() => [
            { label: 'Fit', hint: 'the whole picture', checked: ps.fit === 'contain', onSelect: () => set({ fit: 'contain' }) },
            { label: 'Fill', hint: 'crops the edges', checked: ps.fit === 'cover', onSelect: () => set({ fit: 'cover' }) },
            { label: 'Original size', hint: 'never made bigger', checked: ps.fit === 'original', onSelect: () => set({ fit: 'original' }) },
            { label: 'Blurred background', hint: 'instead of black', checked: !!ps.blurBg, disabled: ps.fit === 'cover', sepBefore: true, onSelect: () => set({ blurBg: !ps.blurBg }) },
            ...lookMenuItems(ps, set),
            ...(n > 1 ? [{ label: 'Apply to every window…', sepBefore: true, onSelect: () => setApplyFrom(i) }] : []),
          ]} />
      </>
    );
  };

  const applyToAll = (from: number, parts: ApplyPart[]) => {
    const src = panels[from];
    const patch = pickSettings(src.settings, parts);
    setPanels((all) => all.map((p, j) => (j < n && j !== from ? { ...p, settings: { ...p.settings, ...patch } } : p)));
    if (parts.includes('source') && src.source) {
      for (let j = 0; j < n; j++) if (j !== from) assign(j, src.source);
    }
  };

  const shapes = useMemo(() => (def.kind === 'shape' && !isWall ? buildShapes(def.id, stage.w, stage.h) : []), [def, isWall, stage.w, stage.h]);
  const shaped = shapes.length > 0;

  const panelBody = (p: Panel, i: number) => {
    const alone = solo === i;
    if (p.source && p.items.length)
      return (
        // A panel that fails while drawing shows a note instead of taking the whole window down.
        <ErrorBoundary key={`${p.startKey}`} name="a multi-screen panel" fallback={<div className="muted" style={{ padding: 16 }}>This panel ran into a problem. Choose what to show again.</div>}>
        <Player
          ref={(h) => { handles.current[i] = h; }}
          items={p.items}
          startKey={p.startKey}
          settings={p.settings}
          onSettings={(s) => update(i, { settings: s })}
          // Fit / Original size in a shape: the whole media inside the shape's outline.
          fitArea={shaped && !alone && shapes[i] ? (a) => fitRectInShape(turnedShape(shapes[i]), a) : undefined}
          autoSlideshow
          masterVolume={master}
          masterMuted={masterMuted}
          compact
          bare={shaped && !alone}
          clean={clean}
          controlsOnMouse={controlsOnMouse}
          activityId={`panel-${p.id}`}
          title={<span className="chip-dark ellipsis">{n > 1 ? `${i + 1} · ` : ''}{sourceLabel(p.source)}</span>}
          panelExtra={
            <>
              {panelTools(i)}
              <SettingsMenu compact s={p.settings} set={(x) => update(i, { settings: { ...p.settings, ...x } })} />
              <Dropdown up className="pbtn wide" label="Source…" items={pickMenu(i)} />
              {n > 1 && (
                <button type="button" className="pbtn" title={alone ? 'Back to all panels (double-click or Esc)' : 'Watch this one alone (double-click)'}
                  aria-label={alone ? 'Back to all panels' : 'Watch this one alone'} onClick={() => toggleSolo(i)}>
                  {alone ? <GridIcon size={14} /> : <FullscreenIcon size={14} />}
                </button>
              )}
            </>
          }
        />
        </ErrorBoundary>
      );
    if (shaped && !alone)
      return (
        <div className="panel-empty mini">
          {p.error && <span className="error-text">{p.error}</span>}
          <b>{i + 1}</b>
        </div>
      );
    return (
      <div className="panel-empty">
        {p.error && <span className="error-text">{p.error}</span>}
        <ImportIcon size={26} />
        <b>{n > 1 ? `Panel ${i + 1}` : 'Nothing playing'}</b>
        <span className="muted">Drop files or a folder from Windows here{vault ? ', or choose from the vault' : ''}.</span>
        <Dropdown className="btn btn-sm" label="Choose what to play ▾" items={pickMenu(i)} />
      </div>
    );
  };

  // Controls for a shaped panel float at its centre, outside its clipped shape.
  const setHoverSoon = (i: number | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (i == null) hoverTimer.current = setTimeout(() => setHover(null), 350);
    else setHover(i);
  };
  const hoverBar = (i: number) => {
    const sp = shapes[i];
    const p = panels[i];
    const h = handles.current[i];
    if (!sp) return null;
    const muted = p.settings.muted || masterMuted;
    return (
      <div className="shape-bar" style={{ left: Math.max(150, Math.min(stage.w - 150, sp.anchor.x)), top: Math.max(40, Math.min(stage.h - 40, sp.anchor.y)) }}
        onPointerEnter={() => setHoverSoon(i)} onPointerLeave={() => setHoverSoon(null)}>
        <span className="chip-dark ellipsis">{i + 1} · {sourceLabel(p.source)}</span>
        {p.items.length > 0 && h && (
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="pbtn" aria-label="Previous" onClick={() => h.prev()}><PrevIcon size={14} /></button>
            <button type="button" className="pbtn main" aria-label={h.isPaused() ? 'Play' : 'Pause'}
              onClick={() => { h.setPaused(!h.isPaused()); bump((x) => x + 1); }}>
              {h.isPaused() ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
            </button>
            <button type="button" className="pbtn" aria-label="Next" onClick={() => h.next()}><NextIcon size={14} /></button>
            <button type="button" className={`pbtn${muted ? '' : ' on'}`} aria-label={muted ? 'Sound off — turn on' : 'Sound on — mute'}
              onClick={() => {
                const muted = !p.settings.muted;
                const volume = muted ? p.settings.volume : unmuteVolume(p.settings.volume);
                rememberSound(muted, volume);
                update(i, { settings: { ...p.settings, muted, volume } });
              }}>{muted ? <MuteIcon size={14} /> : <SoundIcon size={14} />}</button>
            <input type="range" min={0} max={1} step={0.01} value={p.settings.volume} aria-label="Volume" className="vol"
              onChange={(e) => {
                rememberSound(false, Number(e.target.value));
                update(i, { settings: { ...p.settings, volume: Number(e.target.value), muted: false } });
              }} />
            {panelTools(i)}
            <SettingsMenu compact s={p.settings} set={(x) => update(i, { settings: { ...p.settings, ...x } })} />
            <button type="button" className="pbtn" title="Watch this one alone (double-click)" aria-label="Watch this one alone" onClick={() => enterSolo(i)}>
              <FullscreenIcon size={14} />
            </button>
          </div>
        )}
        <Dropdown up className="btn btn-sm glass" label={p.source ? 'Source…' : 'Choose what to play ▾'} items={pickMenu(i)} />
      </div>
    );
  };

  // ---- render --------------------------------------------------------------------------------

  const cols = def.cols ?? 2;
  const rows = Math.ceil(n / cols);
  const shown = panels.slice(0, n);
  const currentShape = SHAPE_LAYOUTS.find((l) => l.id === layout) ?? (freeEntry(layout) ? def : undefined);
  const openEditor = (from = layout, empty = false) => {
    if (solo != null) exitSolo();
    setShapeMenu(false);
    setEditing(empty ? { boxes: [], dbId: null, name: null } : free.startEdit(from, stage.w, stage.h));
  };
  const endEdit = async (boxes: Parameters<typeof free.commit>[0], asName?: string) => {
    if (!editing) return;
    const id = await free.commit(boxes, editing, asName);
    setEditing(null);
    changeLayout(id);
  };
  return (
    <div className={`multi${clean ? ' clean' : ''}${clean && !mouse ? ' no-cursor' : ''}`} onMouseMove={pokeMouse}>
      {showBar && !editing && (
        <div className={`mbar${clean ? ' floating' : ''}`}>
          {!vault && <span className="brand-sm">Player</span>}
          <div role="group" aria-label="Layout" className="seg">
            {GRID_LAYOUTS.map((g) => (
              <button key={g.id} type="button" className={g.id === layout ? 'on' : ''} aria-label={g.name} onClick={() => changeLayout(g.id)}>{g.count}</button>
            ))}
          </div>
          <div className="dropdown">
            <button type="button" className={`btn btn-sm${currentShape ? ' accent-soft' : ''}`} aria-expanded={shapeMenu} onClick={() => setShapeMenu((o) => !o)}>
              {currentShape ? currentShape.name : 'Shapes'} ▾
            </button>
            {shapeMenu && (
              <div className="menu shape-menu" role="menu" onMouseLeave={() => setShapeMenu(false)}>
                {SHAPE_GROUPS.map((g) => [
                  <div key={`h-${g.name}`} className="shape-group" role="presentation">{g.name}</div>,
                  ...g.layouts.map((l) => (
                    <button key={l.id} type="button" role="menuitemradio" aria-checked={l.id === layout} className={`shape-pick${l.id === layout ? ' on' : ''}`}
                      onClick={() => { changeLayout(l.id); setShapeMenu(false); }}>
                      <LayoutThumb id={l.id} />
                      <span>{l.name}</span>
                      <span className="faint">{l.count} panels</span>
                    </button>
                  )),
                ])}
                <MyLayoutsMenu free={free} current={layout} thumb={(id) => <LayoutThumb id={id} />} onPick={(id) => { changeLayout(id); setShapeMenu(false); }}
                  onEdit={(id) => openEditor(id)} onNew={() => openEditor(layout, true)} />
              </div>
            )}
          </div>
          {vault && (
            <button type="button" className={`btn btn-sm${isWall && !isMosaic ? ' accent-soft' : ''}`} onClick={() => changeLayout('wall')}
              title="Many small tiles that swap at random">Wall</button>
          )}
          {vault && (
            <button type="button" className={`btn btn-sm${isMosaic ? ' accent-soft' : ''}`} onClick={() => changeLayout('mosaic')}
              title="The whole screen filled edge to edge, every picture and video in its own shape">Mosaic</button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => openEditor()} title="Draw your own layout from boxes">Edit layout</button>
          {isMosaic ? (
            <>
              <Dropdown label={`${MOSAIC_SIZES.find((x) => x.id === mosaic.size)?.label} ▾`} title="How big the pieces are"
                items={MOSAIC_SIZES.map((x) => ({ label: x.label, checked: x.id === mosaic.size, onSelect: () => setMosaic({ size: x.id }) }))} />
              <Dropdown label={`${MOSAIC_SPEEDS.find((x) => x.id === mosaic.speed)?.label} ▾`} title="How often a piece changes"
                items={MOSAIC_SPEEDS.map((x) => ({ label: x.label, hint: `each stays about ${x.stay} s`, checked: x.id === mosaic.speed, onSelect: () => setMosaic({ speed: x.id }) }))} />
              <button type="button" className={`btn btn-sm${mosaic.sound ? ' accent-soft' : ''}`} aria-pressed={mosaic.sound} onClick={() => setMosaic({ sound: !mosaic.sound })}
                title={mosaic.sound ? 'Sound plays for the video under the mouse — click to turn it off' : 'No sound — click to hear the video under the mouse'}>
                {mosaic.sound ? <><SoundIcon size={15} /> Sound under the mouse</> : <><MuteIcon size={15} /> Sound off</>}
              </button>
              <Dropdown label={`Source: ${sourceLabel(wall.source)} ▾`} items={pickMenu('wall')} />
            </>
          ) : isWall ? (
            <>
              <Dropdown label={`${wall.count} tiles ▾`} items={WALL_SIZES.map((c) => ({ label: `${c} tiles`, checked: c === wall.count, onSelect: () => setWall((w) => ({ ...w, count: c })) }))} />
              <Dropdown label={`${WALL_SPEEDS.find((x) => x.id === wall.speed)?.label} ▾`} title="How often tiles change"
                items={WALL_SPEEDS.map((x) => ({ label: x.label, checked: x.id === wall.speed, onSelect: () => setWall((w) => ({ ...w, speed: x.id })) }))} />
              <Dropdown label={`Source: ${sourceLabel(wall.source)} ▾`} items={pickMenu('wall')} />
            </>
          ) : (
            <label className="row faint" style={{ gap: 8, fontSize: 13 }}>
              Master
              <input type="range" min={0} max={1} step={0.01} value={master} onChange={(e) => setMaster(Number(e.target.value))} aria-label="Master volume" />
            </label>
          )}
          <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => pauseAll(!allPaused)}>
              {allPaused ? <><PlayIcon size={13} /> Play all</> : <><PauseIcon size={13} /> Pause all</>}
            </button>
            {!isWall && (
              <button type="button" className="btn btn-sm" onClick={() => setMasterMuted((m) => !m)} aria-pressed={masterMuted}>
                {masterMuted ? <><SoundIcon size={15} /> Unmute all</> : <><MuteIcon size={15} /> Mute all</>}
              </button>
            )}
            {vault && <Dropdown label="Layouts ▾" items={layoutItems} />}
            <button type="button" className="btn btn-sm btn-primary" onClick={toggleClean}>
              <FullscreenIcon size={15} /> {clean ? 'Leave full screen' : 'Clean full screen'} <span className="kbd-sm">F</span>
            </button>
            <button type="button" className="btn btn-sm" onClick={() => (solo != null ? exitSolo() : clean ? toggleClean() : onBack())}>
              {solo != null ? 'All panels' : clean ? 'Exit full screen' : vault ? 'Back to library' : 'Close player'} <span className="kbd-sm">Esc</span>
            </button>
          </div>
        </div>
      )}

      {editing ? (
        <LayoutEditor start={editing.boxes} name={editing.name} canSave={vault} onCancel={() => setEditing(null)}
          onDone={(boxes) => endEdit(boxes)} onSave={(name, boxes) => endEdit(boxes, name)} />
      ) : isWall ? (
        <div className="mstage" ref={stageRef}>
          {wall.items.length && isMosaic ? (
            <MosaicWall items={wall.items} settings={mosaic} volume={master} paused={allPaused || !!wallSolo} onOpen={setWallSolo} />
          ) : isMosaic ? (
            <div className="panel-empty">
              {wall.error && <span className="error-text">{wall.error}</span>}
              <GridIcon size={26} />
              <b>Mosaic</b>
              <span className="muted">The whole screen filled edge to edge with pictures, GIFs and videos, each in its own shape. Every few seconds one changes and the rest glide to make room.</span>
              <Dropdown className="btn btn-sm" label="Choose what to show ▾" items={pickMenu('wall')} />
            </div>
          ) : wall.items.length ? (
            <Wall items={wall.items} count={wall.count} speed={wall.speed} paused={allPaused || !!wallSolo} onOpen={setWallSolo} />
          ) : (
            <div className="panel-empty">
              {wall.error && <span className="error-text">{wall.error}</span>}
              <GridIcon size={26} />
              <b>Wall</b>
              <span className="muted">{wall.count} tiles that each change to a new picture, GIF or video at random times. Weights count; videos are muted.</span>
              <Dropdown className="btn btn-sm" label="Choose what to show ▾" items={pickMenu('wall')} />
            </div>
          )}
          {wallSolo && (
            <div className="wall-solo">
              <ErrorBoundary name="the wall's viewer" onError={() => setWallSolo(null)}>
              <Player items={wall.items} startKey={wallSolo.key} settings={panels[0].settings} onSettings={(s) => update(0, { settings: s })}
                keys activityId="wall-solo" onClose={() => setWallSolo(null)}
                title={<button type="button" className="btn btn-sm glass" onClick={() => setWallSolo(null)}><CloseIcon size={12} /> Back to the {isMosaic ? 'mosaic' : 'wall'}</button>} />
              </ErrorBoundary>
            </div>
          )}
        </div>
      ) : shaped ? (
        <div className="mstage shaped" ref={stageRef} onPointerLeave={() => setHoverSoon(null)}>
          {shown.map((p, i) => {
            const sp = shapes[i];
            if (!sp) return null;
            const alone = solo === i;
            return (
              <div key={p.id} className={`spanel${hover === i ? ' hover' : ''}${alone ? ' solo' : ''}${focus === i && !clean ? ' focus' : ''}`}
                data-drop={`player:${i}`}
                style={alone ? { zIndex: 50 } : { left: sp.box.x, top: sp.box.y, width: sp.box.w, height: sp.box.h, clipPath: `path('${sp.d}')`, zIndex: sp.z + 1 }}
                onPointerEnter={() => solo == null && setHoverSoon(i)} onPointerLeave={() => setHoverSoon(null)}
                onMouseDown={() => setFocus(i)} onDoubleClick={() => toggleSolo(i)}>
                {sp.turn && !alone ? (
                  // Tilted panels: the media is turned to line up with the shape.
                  <div className="sturn" style={{ left: sp.turn.cx - sp.turn.w / 2, top: sp.turn.cy - sp.turn.h / 2, width: sp.turn.w, height: sp.turn.h, transform: `rotate(${sp.turn.deg}deg)` }}>
                    {panelBody(p, i)}
                  </div>
                ) : panelBody(p, i)}
                {!alone && (
                  <svg className="sborder" width={sp.box.w} height={sp.box.h} aria-hidden="true">
                    <path d={sp.d} />
                  </svg>
                )}
              </div>
            );
          })}
          {hover != null && solo == null && (!clean || mouse) && hoverBar(hover)}
        </div>
      ) : (
        <div className="mgrid-panels" ref={stageRef} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
          {shown.map((p, i) => (
            <div key={p.id} className={`panel${i === focus && n > 1 && !clean ? ' focus' : ''}${solo === i ? ' solo' : ''}`} data-drop={`player:${i}`}
              onMouseDown={() => setFocus(i)} onDoubleClick={() => n > 1 && toggleSolo(i)}>
              {panelBody(p, i)}
            </div>
          ))}
        </div>
      )}

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
      {applyFrom != null && (
        <ApplyDialog panel={applyFrom} onClose={() => setApplyFrom(null)} onApply={(parts) => applyToAll(applyFrom, parts)} />
      )}
      {saving && (
        <PromptDialog title="Save layout" label="Name" confirm="Save" onClose={() => setSaving(false)}
          hint="Saves the layout and each panel's source and settings (and the wall's)." onSubmit={saveLayout} />
      )}
      {free.dialogs}
    </div>
  );
}

/** "Apply to every window…": which parts of this panel to copy to the others (the last choice is remembered). */
function ApplyDialog({ panel, onApply, onClose }: { panel: number; onApply: (parts: ApplyPart[]) => void; onClose: () => void }) {
  const [parts, setParts] = useState<ApplyPart[]>(lastApplyParts);
  return (
    <Modal title="Apply to every window" onClose={onClose}>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>Copies what you tick from window {panel + 1} to all the other windows in this layout.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {APPLY_PARTS.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={parts.includes(p.id)}
              onChange={(e) => setParts((s) => (e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id)))} /> {p.label}
          </label>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!parts.length}
          onClick={() => { rememberApplyParts(parts); onApply(parts); onClose(); }}>Apply</button>
      </div>
    </Modal>
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
