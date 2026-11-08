// Full viewer / slideshow for a list of items. Also shown as the small mini
// player in a corner of the library, and as the speed round.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type Named } from '../api';
import type { Nav } from '../App';
import { BeatStatusLine } from '../components/BeatStatus';
import { Dropdown, PromptDialog } from '../components/Dialogs';
import { BackIcon } from '../components/Icons';
import { Player, type PlayerHandle } from '../components/Player';
import { lazyPart } from '../lazypart';
import { drawnRect, type Box } from '../flip';
import { animOn, copyImage, growGhost, OPEN_MS, snapshotViewer, sourceElement, viewerMediaReady } from '../viewerflip';
import { noteItemsChanged, type PlayItem } from '../media';
import { pushUndo } from '../undo';
import { sorted, type Order } from '../playlist';
import { loadShows, peekShows, resumeAt, updateShow, type FolderShow } from '../slideshowmemory';
import { DEFAULT_PLAYBACK, depthToCarryOver, normalize, type PlaybackSettings } from '../presets';
import { TRANSITIONS } from '../transitions';
import { saveViewerPrefs, useViewerPrefs, viewerPrefs, withSound } from '../prefs';
import { setCleanFullscreen } from '../fullscreen';
import { useLayer } from '../keylayers';

/** The timing settings last used: this run's, else the ones saved last time (every change is saved). */
let lastSettings: PlaybackSettings | null = null;
function lastPlayback(): PlaybackSettings {
  if (lastSettings) return lastSettings;
  const saved = viewerPrefs().lastPlayback;
  return saved && typeof saved === 'object' ? normalize(saved as Partial<PlaybackSettings>) : DEFAULT_PLAYBACK;
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const RANDOM_ORDERS: Order[] = ['shuffle', 'random', 'weighted'];
/** The settings without the sound (it has its own memory). */
function withoutSound(s: PlaybackSettings): Partial<PlaybackSettings> {
  const { muted: _m, volume: _v, ...keep } = s;
  return keep;
}
const sameKeep = (s: PlaybackSettings) => JSON.stringify(withoutSound(s));

/** A folder's slideshow: its own settings and where you stopped are remembered (slideshowmemory.ts). */
export interface ShowPlace {
  /** e.g. "f12", "top". */
  key: string;
  name: string;
}

/** A big title over a dark backdrop before the first item (e.g. a memory). */
export interface TitleCard {
  title: string;
  subtitle?: string;
}

const TITLE_CARD_MS = 2500;

const SpeedRound = lazyPart(() => import('../components/SpeedRound').then((m) => m.SpeedRound));

/** What the viewer showed when it was closed, for the shrink back into the grid (viewerflip.ts). */
export interface ViewerClose {
  snap: HTMLCanvasElement | null;
  from: Box | null;
}

export function Viewer(props: {
  nav: Nav; items: PlayItem[]; startKey?: string; title: string; auto: boolean; order?: Order;
  /** Back to the library; `last` = the item that was showing; `close`: what to shrink back into its tile (null: no animation). */
  onBack: (last: PlayItem | null, close: ViewerClose | null) => void;
  onShowFolder?: (item: PlayItem) => void;
  /** Everything of a person (their person folder id), from a face box. */
  onShowPerson?: (folderId: number) => void;
  onOpenPerson?: (folderId: number) => void;
  /** Shown as the small mini player over the library. */
  mini?: boolean;
  /** Shrink into the mini player (button and M). */
  onMinimize?: (last: PlayItem | null) => void;
  /** Mini player: back to the full view / close it. */
  onExpand?: () => void;
  onCloseMini?: () => void;
  /** The grid tile it was opened from (the picture grows from there). */
  fromRect?: Box | null;
  /** Pictures slowly pan and zoom (Memories). */
  kenBurns?: boolean;
  titleCard?: TitleCard;
  /** Speed round: pictures and GIFs flash by; F to favourite. */
  speedRound?: boolean;
  /** The slideshow is about this person (folder id): "Line up faces" uses their face. */
  person?: number | null;
  /** The folder being shown: its own slideshow settings and where you stopped are remembered. */
  place?: ShowPlace | null;
}) {
  const current = useRef<PlayItem | null>(null);
  const player = useRef<PlayerHandle>(null);
  const mini = !!props.mini;
  const [folderNames, setFolderNames] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    if (props.nav.app.session) api.folders().then((f) => setFolderNames(new Map(f.map((x) => [x.id, x.name])))).catch(() => {});
  }, [props.nav.app.session]);
  const rootRef = useRef<HTMLDivElement>(null);
  const back = () => {
    const last = current.current;
    // A copy of what is on screen shrinks back into its tile (or fades) over the library.
    let close: ViewerClose | null = null;
    if (!mini && animOn()) {
      const from = player.current?.mediaRect() ?? null;
      close = { from, snap: snapshotViewer(rootRef.current, from) };
    }
    props.onBack(last, close);
  };
  // A layer while full screen (keylayers.ts): what is underneath gets no keys, and
  // "back" (the mouse's back button, from App) leaves the viewer.
  const backRef = useRef(back);
  backRef.current = back;
  const viewerLayer = useLayer(!mini, { name: 'viewer', onBack: () => backRef.current() });
  const vault = !!props.nav.app.session;
  const vaultKey = props.nav.app.session?.path ?? '';
  const place = vault && !props.speedRound && props.place ? props.place : null;
  // The library's sort order is followed, unless a random order was chosen.
  const followSort = (s: PlaybackSettings) => (props.order && !RANDOM_ORDERS.includes(s.order) ? { ...s, order: props.order } : s);
  /** The usual settings (folders without their own, and everywhere else). */
  const usual = () => followSort(withSound(lastPlayback()));
  const fromFolder = (own: Partial<PlaybackSettings>) => followSort(withSound(normalize(own)));
  // ---- this folder's memory (begin) ----
  const [store0] = useState(() => (place ? peekShows(vaultKey) : null));
  const entry0 = place && store0 ? store0[place.key] : undefined;
  const [settings, setSettings] = useState<PlaybackSettings>(() => (entry0?.settings ? fromFolder(entry0.settings) : usual()));
  /** This folder has its own settings. */
  const [own, setOwn] = useState(!!entry0?.settings);
  /** Starting a folder's slideshow again: carry on where you stopped. */
  const resumeFor = (e: FolderShow | undefined, order: Order) => (props.auto && !props.startKey ? resumeAt(e, sorted(props.items, order).map((x) => x.key), order) : null);
  const [resumeKey, setResumeKey] = useState<string | null>(() => resumeFor(entry0, settings.order));
  const [resumeChip, setResumeChip] = useState(resumeKey != null);
  // A folder's slideshow waits (a moment) for its memory, so it can start where you stopped.
  const [memReady, setMemReady] = useState(!place || store0 != null || !props.auto);
  /** The settings as last saved or loaded (only real changes are saved). */
  const savedKeep = useRef(sameKeep(settings));
  const settingsNow = useRef(settings);
  settingsNow.current = settings;
  useEffect(() => {
    if (!place || store0) return;
    let live = true;
    loadShows(vaultKey).then((st) => {
      if (!live) return;
      const e = st[place.key];
      let s = settingsNow.current;
      // (Unless you changed something meanwhile.)
      if (e?.settings && sameKeep(s) === savedKeep.current) {
        s = fromFolder(e.settings);
        savedKeep.current = sameKeep(s);
        setSettings(s);
        setOwn(true);
      }
      const at = resumeFor(e, s.order);
      setResumeKey(at);
      setResumeChip(at != null);
      setMemReady(true);
    });
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!resumeChip) return;
    const t = setTimeout(() => setResumeChip(false), 9000);
    return () => clearTimeout(t);
  }, [resumeChip]);
  /** The slideshow moved on: remembered as where you stopped (forgotten at the end). */
  const noteAt = (it: PlayItem | null) => {
    if (!place) return;
    if (!it) updateShow(vaultKey, place.key, { at: undefined });
    else if (!RANDOM_ORDERS.includes(settingsNow.current.order)) updateShow(vaultKey, place.key, { at: it.key });
  };
  /** Back to the usual settings here (the folder's own are forgotten). */
  const toUsual = () => {
    if (!place) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    updateShow(vaultKey, place.key, { settings: undefined });
    const s = { ...usual(), muted: settings.muted, volume: settings.volume };
    savedKeep.current = sameKeep(s);
    setSettings(s);
    setOwn(false);
    setPresetName(null);
  };
  /** This folder's settings become the usual ones too. */
  const makeUsual = () => {
    lastSettings = settings;
    void saveViewerPrefs({ lastPlayback: withoutSound(settings) });
  };
  // ---- this folder's memory (end) ----
  const [presets, setPresets] = useState<Named<PlaybackSettings>[]>([]);
  const [presetName, setPresetName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clean, setClean] = useState(false);

  useEffect(() => {
    if (vault) api.listNamed<PlaybackSettings>('preset').then((list) => {
      setPresets(list);
      // 3D photos used to be a slideshow setting: if it was on anywhere, turn the new View ▾ setting on (once).
      const old = list.map((p) => p.settings);
      if (depthToCarryOver(viewerPrefs(), [lastPlayback(), ...old])) saveViewerPrefs({ depthAuto: true, depthAutoMigrated: true });
    }).catch(() => {});
  }, [vault]);
  useEffect(() => {
    // Remembered for next time once the changes settle: for this folder (a folder's
    // slideshow), else as the usual settings. Sound has its own setting.
    const k = sameKeep(settings);
    if (k === savedKeep.current) return;
    savedKeep.current = k;
    const keep = withoutSound(settings);
    if (!place) lastSettings = settings;
    else setOwn(true);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (place) updateShow(vaultKey, place.key, { settings: keep });
      else void saveViewerPrefs({ lastPlayback: keep });
    }, 500);
  }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void setCleanFullscreen(false), []);

  const toggleClean = async () => {
    const next = !clean;
    setClean(next);
    await setCleanFullscreen(next);
  };
  const minimize = () => {
    if (clean) {
      setClean(false);
      setCleanFullscreen(false).catch(() => {});
    }
    props.onMinimize?.(current.current);
  };

  // ---- title card --------------------------------------------------------------------------
  const [card, setCard] = useState(!!props.titleCard && !props.speedRound);
  useEffect(() => {
    if (!card) return;
    const t = setTimeout(() => setCard(false), TITLE_CARD_MS);
    return () => clearTimeout(t);
  }, [card]);

  // ---- the picture grows out of its grid tile (viewerflip.ts) ------------------------------------
  // The library stays underneath, so the tile is still there: its thumbnail
  // (already decoded) grows to where the picture will be, then crossfades to it.
  const [flip] = useState(() => {
    const it = props.items.find((i) => i.key === props.startKey);
    if (!props.fromRect || !it || !it.width || !it.height || card || props.speedRound || mini || !animOn()) return null;
    if (it.kind === 'text' || it.kind === 'pdf') return null;
    const copy = copyImage(sourceElement(it.itemId)?.querySelector('img') ?? null);
    return copy ? { copy, w: it.width, h: it.height, from: props.fromRect } : null;
  });
  const [opening, setOpening] = useState(!!flip);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || mini) return;
    if (!flip) {
      // No tile to grow from (slideshows, memories): a quick fade in.
      if (animOn() && !props.speedRound) root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
      return;
    }
    const stage = (root.querySelector('.stage') ?? root).getBoundingClientRect();
    const d = drawnRect(stage.width, stage.height, flip.w, flip.h, settings.fit);
    const to: Box = { left: stage.left + d.left, top: stage.top + d.top, width: d.width, height: d.height };
    const r = root.getBoundingClientRect();
    const ghost = flip.copy;
    ghost.className = 'flip-in-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, { left: `${to.left - r.left}px`, top: `${to.top - r.top}px`, width: `${to.width}px`, height: `${to.height}px`, opacity: '1' });
    root.appendChild(ghost);
    root.animate([{ backgroundColor: 'rgba(0, 0, 0, 0)' }, { backgroundColor: 'rgba(0, 0, 0, 1)' }], { duration: OPEN_MS, easing: 'ease-out' });
    let live = true;
    let frame = 0;
    growGhost(ghost, flip.from, to).then(() => {
      // Hold the thumbnail until the full picture (or the video's first frame) is there, then crossfade.
      const t0 = performance.now();
      const wait = () => {
        if (!live) return;
        if (!viewerMediaReady(root, !!player.current?.mediaRect()) && performance.now() - t0 < 2500) {
          frame = requestAnimationFrame(wait);
          return;
        }
        setOpening(false);
        const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
        fade.finished.then(() => ghost.remove(), () => ghost.remove());
      };
      wait();
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      ghost.remove();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const presetItems = [
    ...presets.map((p) => ({
      label: p.name,
      checked: p.name === presetName,
      onSelect: () => {
        setSettings(withSound(normalize(p.settings)));
        setPresetName(p.name);
      },
    })),
    { label: 'Save current settings as preset…', onSelect: () => setSaving(true) },
    ...(presetName ? [{ label: `Delete “${presetName}”`, danger: true, onSelect: async () => {
      const p = presets.find((x) => x.name === presetName);
      if (p?.id != null) await api.deleteNamed('preset', p.id);
      setPresetName(null);
      setPresets(await api.listNamed<PlaybackSettings>('preset'));
    } }] : []),
  ];

  if (props.speedRound) {
    return (
      <div className={`viewer${mini ? ' mini' : ''}`}>
        <SpeedRound items={props.items} title={props.title} onClose={back} />
      </div>
    );
  }

  // Favourite and weight from the viewer: saved, undoable with Ctrl+Z (here and in the
  // library), and the library shows them when the viewer closes (noteItemsChanged).
  const setFavourite = async (it: PlayItem, on: boolean) => {
    if (it.itemId == null) return;
    const id = it.itemId;
    await api.setFavourite([id], on);
    noteItemsChanged();
    pushUndo(on ? `Added “${it.name}” to favourites` : `Removed “${it.name}” from favourites`, async () => {
      await api.setFavourite([id], !on);
      noteItemsChanged();
    });
  };
  const setWeight = async (it: PlayItem, w: number, was: number) => {
    if (it.itemId == null) return;
    const id = it.itemId;
    await api.setWeight([id], w);
    noteItemsChanged();
    pushUndo(`Weight of “${it.name}” set to ${w}`, async () => {
      await api.setWeight([id], was);
      noteItemsChanged();
    });
  };

  return (
    <div ref={rootRef} className={`viewer${clean ? ' clean' : ''}${mini ? ' mini' : ''}${opening ? ' opening' : ''}`}>
      {memReady && <Player
        ref={player}
        items={props.items}
        startKey={props.startKey ?? resumeKey ?? undefined}
        onSlideshowAt={place ? noteAt : undefined}
        settings={settings}
        onSettings={(s) => { setSettings(s); setPresetName(null); }}
        autoSlideshow={props.auto}
        clean={clean}
        controlsOnMouse={props.nav.app.config.fullscreenControlsOnMouse}
        keys={!mini}
        keysMine={viewerLayer.mine}
        hold={card}
        kenBurns={props.kenBurns}
        mini={mini ? { onExpand: () => props.onExpand?.(), onClose: () => props.onCloseMini?.() } : undefined}
        onMinimize={props.onMinimize && vault ? minimize : undefined}
        onShowPerson={props.onShowPerson}
        onOpenPerson={props.onOpenPerson}
        person={props.person}
        onCurrent={(it) => { current.current = it; }}
        onClose={() => (clean ? toggleClean() : back())}
        subtitle={(it) => it.itemId != null && props.onShowFolder ? (
          <button type="button" className="link p-folder" title="Show this item in its folder" onClick={() => props.onShowFolder?.(it)}>
            in {it.folderId == null ? 'Top level' : folderNames.get(it.folderId) ?? 'its folder'}
          </button>
        ) : null}
        folderOf={(it) => it.itemId != null && props.onShowFolder ? (
          <button type="button" className="link" title="Show this item in its folder" onClick={() => props.onShowFolder?.(it)}>
            {it.folderId == null ? 'Top level' : folderNames.get(it.folderId) ?? 'its folder'}
          </button>
        ) : it.itemId != null ? (it.folderId == null ? 'Top level' : folderNames.get(it.folderId) ?? '') : null}
        activityId="viewer"
        title={
          <button type="button" className="btn btn-icon btn-sm glass" aria-label="Back" onClick={() => (clean ? toggleClean() : back())}>
            <BackIcon />
          </button>
        }
        topRight={
          <>
            {vault && <Dropdown className="btn btn-sm glass" label={`Preset: ${presetName ?? 'custom'} ▾`} items={presetItems} />}
            <SettingsMenu s={settings} set={(p) => { setSettings({ ...settings, ...p }); setPresetName(null); }}
              place={place ? { name: place.name, own, onUsual: toUsual, onMakeUsual: makeUsual } : undefined} />
          </>
        }
        onFavourite={vault ? (it, on) => setFavourite(it, on) : undefined}
        onWeight={vault ? (it, w, was) => setWeight(it, w, was) : undefined}
        onFullscreen={toggleClean}
        undoAll={vault && !mini}
      />}
      {resumeChip && resumeKey && !mini && !card && (
        <div className="resume-chip" role="status">
          Carried on where you stopped ·{' '}
          <button type="button" className="link" onClick={() => { player.current?.restart(); setResumeChip(false); }}>Start from the beginning</button>
        </div>
      )}
      {card && props.titleCard && !mini && (
        <div className="title-card" style={{ animationDuration: `${TITLE_CARD_MS}ms` }} role="status">
          <h1>{props.titleCard.title}</h1>
          {props.titleCard.subtitle && <p>{props.titleCard.subtitle}</p>}
        </div>
      )}
      {saving && (
        <PromptDialog title="Save preset" label="Name" confirm="Save" onClose={() => setSaving(false)}
          hint="Saves picture duration, video and GIF timing, order, repeat, speed, sound, beat sync and slow pan and zoom."
          onSubmit={async (name) => {
            await api.saveNamed('preset', { id: null, name, settings });
            setPresets(await api.listNamed<PlaybackSettings>('preset'));
            setPresetName(name.trim());
          }} />
      )}
    </div>
  );
}

/** A folder's slideshow: whether it has its own settings, and ways to change that. */
export interface PlaceSettings {
  name: string;
  own: boolean;
  /** Forget this folder's own settings (the usual ones apply again). */
  onUsual: () => void;
  /** Make this folder's settings the usual ones too. */
  onMakeUsual: () => void;
}

/** Timing and display settings for the slideshow. */
export function SettingsMenu({ s, set, compact, place }: { s: PlaybackSettings; set: (p: Partial<PlaybackSettings>) => void; compact?: boolean; place?: PlaceSettings }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={compact ? 'pbtn' : 'btn btn-sm glass'} onClick={() => setOpen(true)} aria-label="Slideshow settings" title="Slideshow settings">
        {compact ? '⚙' : 'Timing ▾'}
      </button>
      {open && <PlaybackDialog s={s} set={set} place={place} onClose={() => setOpen(false)} />}
    </>
  );
}

// Whether this computer can listen for beats (asked once).
let beatsOk: Promise<boolean> | null = null;

function PlaybackDialog({ s, set, onClose, place }: { s: PlaybackSettings; set: (p: Partial<PlaybackSettings>) => void; onClose: () => void; place?: PlaceSettings }) {
  const [madeUsual, setMadeUsual] = useState(false);
  const num = (v: string) => (v === '' ? 0 : Number(v));
  // A dialog (keylayers.ts): Esc closes it, keys here don't reach the viewer behind.
  const boxRef = useRef<HTMLDivElement>(null);
  useLayer(true, { name: 'dialog: Slideshow settings', modal: true, el: () => boxRef.current, onClose });
  useEffect(() => boxRef.current?.focus(), []);
  const [beats, setBeats] = useState(false);
  const prefs = useViewerPrefs();
  useEffect(() => {
    let alive = true;
    beatsOk ??= api.beatsSupported().catch(() => false);
    beatsOk.then((ok) => alive && setBeats(ok));
    return () => {
      alive = false;
    };
  }, []);
  // On the page itself (a portal), like every other dialog: inside the viewer's top bar it
  // faded away with the bar when the mouse stood still.
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Slideshow settings" ref={boxRef} tabIndex={-1}>
        <h2>Slideshow settings</h2>
        {place && (
          <div className="place-note">
            {place.own ? (
              <>
                <span>These settings are kept for <b>{place.name}</b>.</span>
                <span className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-sm" onClick={place.onUsual} title="Forget this folder's own settings">Use the usual settings here</button>
                  <button type="button" className="btn btn-sm" disabled={madeUsual} title="Other folders without their own settings use these too"
                    onClick={() => { place.onMakeUsual(); setMadeUsual(true); }}>{madeUsual ? 'Now the usual settings ✓' : 'Make them the usual settings'}</button>
                </span>
              </>
            ) : (
              <span className="faint">Using the usual settings. Anything you change here is kept for <b>{place.name}</b> only.</span>
            )}
          </div>
        )}
        <div className="form-grid">
          <label htmlFor="ps-img">Pictures stay for</label>
          <span className="row"><input id="ps-img" className="input small" type="number" min={0.1} step="any" value={s.imageSeconds}
            onChange={(e) => set({ imageSeconds: Math.max(0.1, num(e.target.value)) })} /> seconds <span className="faint">(as little as 0.1)</span></span>

          {/* time to next slide (begin) */}
          <span />
          <span className="row">
            <label className="check" title="A small ring around the Slideshow button runs down to the next item (with beat sync: the beats left)">
              <input type="checkbox" checked={prefs.slideRing !== false} onChange={(e) => saveViewerPrefs({ slideRing: e.target.checked })} /> Show time to next slide
            </label>
          </span>
          {/* time to next slide (end) */}

          <span>Pictures</span>
          <span className="row">
            <label className="check"><input type="checkbox" checked={s.kenBurns} onChange={(e) => set({ kenBurns: e.target.checked })} /> Slow pan and zoom</label>
          </span>

          {/* 3D photos moved to View ▾ → 3D photos (a viewer setting, also when not in a slideshow). */}
          <span />
          <span className="faint" style={{ fontSize: 12 }}>3D photos: under <b>View ▾</b> (they move in slideshows and while just viewing).</span>

          <span>Faces</span>
          <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            <label className="check"><input type="checkbox" checked={!!prefs.alignFaces} onChange={(e) => saveViewerPrefs({ alignFaces: e.target.checked })} /> Line up faces</label>
            <span className="faint" style={{ fontSize: 12 }}>
              Each picture is moved so the main face stays at the same place and size, with a crossfade{s.kenBurns ? ' and a gentle zoom' : ''}.
              Pictures without a found face show as usual.
            </span>
          </span>

          <label htmlFor="ps-vmax">Videos play for at most</label>
          <span className="row"><input id="ps-vmax" className="input small" type="number" min={0} step="any" value={s.videoMaxSeconds}
            onChange={(e) => set({ videoMaxSeconds: Math.max(0, num(e.target.value)) })} /> seconds <span className="faint">(0 = to the end)</span></span>

          <span>Videos start</span>
          <span className="row">
            <label className="check"><input type="checkbox" checked={s.videoRandomStart} onChange={(e) => set({ videoRandomStart: e.target.checked })} /> at a random point</label>
          </span>

          <span>Video speed</span>
          <span className="row">
            <label className="check" title="Videos speed up and slow down in waves, like an edit (slow-mo to fast). With Change on the beat: slow-mo right on strong beats">
              <input type="checkbox" checked={!!s.speedRamp} onChange={(e) => set({ speedRamp: e.target.checked })} /> Speed ramp: slow-mo and fast in waves
            </label>
          </span>

          <label htmlFor="ps-loops">GIFs play</label>
          <span className="row"><input id="ps-loops" className="input small" type="number" min={0} value={s.gifLoops}
            onChange={(e) => set({ gifLoops: Math.max(0, Math.round(num(e.target.value))) })} /> loops, at most
            <input aria-label="GIF maximum seconds" className="input small" type="number" min={0} step="any" value={s.gifMaxSeconds}
              onChange={(e) => set({ gifMaxSeconds: Math.max(0, num(e.target.value)) })} /> seconds</span>

          {beats && (
            <>
              <span>Music</span>
              <span className="row">
                <label className="check"><input type="checkbox" checked={s.beatSync} onChange={(e) => set({ beatSync: e.target.checked })} /> Change on the beat</label>
              </span>
              {s.beatSync && (
                <>
                  <span />
                  <BeatStatusLine on={s.beatSync} />
                </>
              )}
              {s.beatSync && (
                <>
                  <span>Change every</span>
                  <div role="group" className="seg" aria-label="Change every">
                    {([1, 2, 4] as const).map((n) => (
                      <button key={n} type="button" className={s.beatEvery === n && !s.beatMontage ? 'on' : ''} onClick={() => set({ beatEvery: n, beatMontage: false })}>{n === 1 ? '1 beat' : `${n} beats`}</button>
                    ))}
                    <button type="button" className={s.beatMontage ? 'on' : ''} onClick={() => set({ beatMontage: true })}
                      title="Montage: quick cuts on busy parts (every beat), long holds on calm parts (4 to 8 beats)">Montage</button>
                  </div>
                  {s.beatMontage && (
                    <>
                      <span />
                      <span className="faint" style={{ fontSize: 12 }}>Montage: quick cuts on busy parts, long holds on calm parts.</span>
                    </>
                  )}
                  <label htmlFor="ps-beatmin">At least</label>
                  <span className="row"><input id="ps-beatmin" className="input small" type="number" min={0.1} max={60} step={0.1} value={s.beatMinSeconds}
                    onChange={(e) => set({ beatMinSeconds: Math.min(60, Math.max(0.1, num(e.target.value))) })} /> seconds per item</span>
                  <span>Big hits</span>
                  <span className="row">
                    <label className="check" title="On a drop or a big hit in the music, move on at once with a white flash and a quick zoom">
                      <input type="checkbox" checked={!!s.beatDrop} onChange={(e) => set({ beatDrop: e.target.checked })} /> Beat drop: move on with a flash and a zoom
                    </label>
                  </span>
                  <span />
                  <span className="faint" style={{ fontSize: 12 }}>
                    Listens to the music playing on your computer (nothing is recorded). When it's quiet, the normal timing above is used.
                    Slideshow videos stay muted meanwhile.
                  </span>
                </>
              )}
            </>
          )}

          <span>Picture fit</span>
          <div role="group" className="seg">
            <button type="button" className={s.fit === 'contain' ? 'on' : ''} onClick={() => set({ fit: 'contain' })}>Fit (whole picture)</button>
            <button type="button" className={s.fit === 'cover' ? 'on' : ''} onClick={() => set({ fit: 'cover' })}>Fill (crop edges)</button>
            <button type="button" className={s.fit === 'original' ? 'on' : ''} onClick={() => set({ fit: 'original' })}
              title="Never made bigger than its own size; only shrinks when it doesn't fit">Original size</button>
          </div>
          <span />
          <span className="row">
            <label className="check" title="With Fit or Original size, the empty space shows a blurred copy of the picture instead of black">
              <input type="checkbox" checked={!!s.blurBg} disabled={s.fit === 'cover'} onChange={(e) => set({ blurBg: e.target.checked })} /> Blurred background
            </label>
          </span>

          <span>Transition</span>
          <div role="group" className="seg tx-pick" aria-label="Transition">
            {TRANSITIONS.map((t) => (
              <button key={t.id} type="button" className={s.transition === t.id ? 'on' : ''} title={t.hint} onClick={() => set({ transition: t.id })}>{t.label}</button>
            ))}
          </div>
          {s.transition !== 'none' && (
            <>
              <label htmlFor="ps-fade">Transition speed</label>
              <span className="row" style={{ gap: 10 }}>
                <input id="ps-fade" type="range" min={50} max={2000} step={50} value={s.fadeMs} style={{ flex: 1 }}
                  onChange={(e) => set({ fadeMs: Number(e.target.value) })} />
                <span className="faint" style={{ minWidth: 52, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{(s.fadeMs / 1000).toFixed(2)} s</span>
              </span>
            </>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
