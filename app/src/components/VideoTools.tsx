// Pieces of the player for videos and GIFs: the position bar with bookmarks
// and the A–B loop, the bookmarks panel, the GIF maker, and the picture
// scaling menu.

import { useEffect, useRef, useState } from 'react';
import { api, onEvent, type Bookmark, type CutDone, type ViewerSettings, type VideoToolProgress } from '../api';
import { derivedName, GIF_MAX_FRAMES, GIF_MAX_SECONDS, makeGif } from '../clips';
import { formatTime } from '../media';
import { saveViewerPrefs } from '../prefs';
import { Dropdown, Modal } from './Dialogs';
import { CloseIcon } from './Icons';
import { DepthSettingsDialog } from './DepthSettings';
import { depthPack } from '../depth';
import { COLS, framePosition, ROWS } from '../previews';
import { nearestFrame } from '../viewerlogic';
import { pushUndo } from '../undo';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Seconds with tenths: 83.46 → "1:23.4" */
export function preciseTime(s: number): string {
  if (!Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

export function PositionBar(props: {
  at: number;
  dur: number;
  onSeek: (t: number) => void;
  bookmarks: Bookmark[];
  loop: { a: number | null; b: number | null };
  suffix?: string;
  /** Show frames instead of time (GIFs). */
  frames?: { index: number; count: number };
  /** Videos: hovering shows the time, and a frame from this preview clip strip when there is one. */
  hover?: { strip: string | null; aspect: number };
}) {
  const { at, dur } = props;
  const [tip, setTip] = useState<{ x: number; t: number } | null>(null);
  const onHover = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!props.hover || !(dur > 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    setTip({ x, t: (x / Math.max(1, r.width)) * dur });
  };
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / Math.max(dur, 0.001)) * 100))}%`;
  const a = props.loop.a;
  const b = props.loop.b;
  return (
    <div className="timeline">
      <span>{props.frames ? `${props.frames.index + 1}` : formatTime(at * 1000)}</span>
      <div className="track-wrap" onMouseMove={onHover} onMouseLeave={() => setTip(null)}>
        {tip && props.hover && (
          <div className="seek-tip" style={{ left: tip.x }} aria-hidden="true">
            {props.hover.strip && (
              <div className="seek-frame" style={{
                width: Math.round(Math.min(180, 110 * Math.max(0.6, props.hover.aspect))),
                aspectRatio: String(props.hover.aspect || 16 / 9),
                backgroundImage: `url("${props.hover.strip}")`,
                backgroundSize: `${COLS * 100}% ${ROWS * 100}%`,
                backgroundPosition: framePosition(nearestFrame(tip.t, dur)),
              }} />
            )}
            <span className="seek-time">{formatTime(tip.t * 1000)}</span>
          </div>
        )}
        {a != null && (
          <div className={`ab-region${b == null ? ' open' : ''}`}
            style={{ left: pct(Math.min(a, b ?? a)), width: b != null ? `calc(${pct(Math.abs(b - a))})` : '2px' }} />
        )}
        <input type="range" min={0} max={dur} step={props.frames ? 1 : 0.05} value={at} aria-label="Position" tabIndex={-1}
          onPointerUp={(e) => e.currentTarget.blur()}
          onChange={(e) => props.onSeek(Number(e.target.value))} />
        {props.bookmarks.map((bm) => (
          <button key={bm.id} type="button" className="bm-mark" style={{ left: pct(bm.positionMs / 1000) }}
            aria-label={`Bookmark at ${formatTime(bm.positionMs)}${bm.note ? `: ${bm.note}` : ''}`}
            onClick={() => props.onSeek(bm.positionMs / 1000)}>
            {bm.note && <span className="bm-label">{bm.note}</span>}
            <span className="bm-tip">{formatTime(bm.positionMs)}{bm.note ? ` — ${bm.note}` : ''}</span>
          </button>
        ))}
      </div>
      <span>{props.frames ? `${props.frames.count} frames` : formatTime(dur * 1000)}{props.suffix ?? ''}</span>
    </div>
  );
}

export function BookmarksPanel(props: {
  list: Bookmark[];
  at: number;
  focusId: number | null;
  onAdd: () => void;
  onJump: (ms: number) => void;
  onChange: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.bm-toggle')) props.onClose();
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (props.focusId != null) ref.current?.querySelector<HTMLInputElement>(`input[data-id="${props.focusId}"]`)?.focus();
  }, [props.focusId, props.list.length]);
  return (
    <div ref={ref} className="bm-panel" role="dialog" aria-label="Bookmarks" onKeyDown={(e) => e.stopPropagation()}>
      <div className="row-between">
        <b>Bookmarks</b>
        <button type="button" className="btn btn-sm btn-primary" onClick={props.onAdd}>Add at {formatTime(props.at * 1000)} <kbd>K</kbd></button>
      </div>
      {props.list.length === 0 && <p className="faint" style={{ margin: 0, fontSize: 13 }}>No bookmarks in this video yet. They show as marks on the position bar.</p>}
      <div className="bm-list">
        {props.list.map((b) => (
          <div key={b.id} className="bm-row">
            <button type="button" className="link mono" onClick={() => props.onJump(b.positionMs)}>{formatTime(b.positionMs)}</button>
            <input className="input small" data-id={b.id} defaultValue={b.note} placeholder="Add a note…" maxLength={500}
              aria-label={`Note for ${formatTime(b.positionMs)}`}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              onBlur={async (e) => {
                if (e.target.value !== b.note) {
                  await api.updateBookmark(b.id, b.positionMs, e.target.value).catch(() => {});
                  props.onChange();
                }
              }} />
            <button type="button" className="btn btn-icon btn-sm ghost" aria-label="Delete bookmark"
              onClick={async () => { await api.deleteBookmark(b.id).catch(() => {}); props.onChange(); }}><CloseIcon size={12} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GifMakerDialog(props: {
  name: string;
  src: string;
  folder: number | null;
  at: number;
  dur: number;
  loop: { a: number | null; b: number | null };
  videoWidth: number;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const fromLoop = props.loop.a != null && props.loop.b != null;
  const [start, setStart] = useState(fromLoop ? Math.min(props.loop.a!, props.loop.b!) : props.at);
  const [end, setEnd] = useState(fromLoop ? Math.max(props.loop.a!, props.loop.b!) : Math.min(props.dur, props.at + 3));
  const [fps, setFps] = useState(15);
  const [width, setWidth] = useState(Math.min(480, props.videoWidth || 480));
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const len = Math.max(0, end - start);
  const frames = Math.min(GIF_MAX_FRAMES, Math.round(Math.min(len, GIF_MAX_SECONDS) * fps));
  const widths = [240, 320, 480, 640, 800].filter((w) => w <= (props.videoWidth || 800));
  useEffect(() => () => abort.current?.abort(), []);

  const make = async () => {
    setErr(null);
    if (len < 0.1) return setErr('The end must be after the start.');
    abort.current = new AbortController();
    setBusy({ done: 0, total: frames });
    try {
      const bytes = await makeGif(props.src, { start, end: Math.min(end, start + GIF_MAX_SECONDS), fps, width }, (done, total) => setBusy({ done, total }), abort.current.signal);
      const name = derivedName(props.name, start, 'gif', 'clip');
      const id = await api.addFileBytes(props.folder, name, bytes);
      // Ctrl+Z takes it away again (to the trash).
      pushUndo(`Saved “${name}”`, () => api.deleteItems([id]));
      props.onSaved(name);
      props.onClose();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };
  const num = (v: string) => Math.max(0, Math.min(props.dur, Number(v.replace(',', '.')) || 0));
  return (
    <Modal title="Make a GIF" onClose={() => (busy ? abort.current?.abort() : props.onClose())}>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        From “{props.name}”. The GIF is saved in the same folder, encrypted like everything else.
        {fromLoop ? ' Starts with your A–B loop.' : ' Tip: set a loop with A and B first.'}
      </p>
      <div className="form-grid">
        <label htmlFor="gif-start">Start (seconds)</label>
        <span className="row"><input id="gif-start" className="input small" type="number" step="0.1" min={0} value={Number(start.toFixed(2))}
          onChange={(e) => setStart(num(e.target.value))} /> <span className="faint">{preciseTime(start)}</span></span>
        <label htmlFor="gif-end">End (seconds)</label>
        <span className="row"><input id="gif-end" className="input small" type="number" step="0.1" min={0} value={Number(end.toFixed(2))}
          onChange={(e) => setEnd(num(e.target.value))} /> <span className="faint">{preciseTime(end)} · {len.toFixed(1)} s{len > GIF_MAX_SECONDS ? ` (max ${GIF_MAX_SECONDS} s)` : ''}</span></span>
        <span>Smoothness</span>
        <div role="group" className="seg">
          {[10, 15, 20, 25].map((f) => <button key={f} type="button" className={fps === f ? 'on' : ''} onClick={() => setFps(f)}>{f} fps</button>)}
        </div>
        <span>Width</span>
        <div role="group" className="seg">
          {widths.map((w) => <button key={w} type="button" className={width === w ? 'on' : ''} onClick={() => setWidth(w)}>{w}px</button>)}
        </div>
      </div>
      <span className="faint" style={{ fontSize: 12 }}>{frames} frames. Bigger and smoother GIFs take longer and are larger files.</span>
      {busy && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="bar"><div style={{ width: `${(busy.done / Math.max(1, busy.total)) * 100}%` }} /></div>
          <span className="faint mono" style={{ fontSize: 12 }}>{busy.done} / {busy.total} frames</span>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={() => (busy ? abort.current?.abort() : props.onClose())}>{busy ? 'Stop' : 'Cancel'}</button>
        <button type="button" className="btn btn-primary" disabled={!!busy} onClick={make}>{busy ? 'Making…' : 'Make GIF'}</button>
      </div>
    </Modal>
  );
}

/**
 * Save the A–B part of a video (or start and end typed in) as a new MP4 with
 * its sound, next to the video. Fast copies it as it is; Exact re-encodes it
 * (videotool.rs run_cut). Ctrl+Z takes the new item away again.
 */
export function Mp4CutDialog(props: {
  itemId: number;
  name: string;
  at: number;
  dur: number;
  loop: { a: number | null; b: number | null };
  onClose: () => void;
  /** `reused`: the very same MP4 was already in the folder. */
  onSaved: (name: string, reused: boolean) => void;
}) {
  const fromLoop = props.loop.a != null && props.loop.b != null;
  const [start, setStart] = useState(fromLoop ? Math.min(props.loop.a!, props.loop.b!) : props.at);
  const [end, setEnd] = useState(fromLoop ? Math.max(props.loop.a!, props.loop.b!) : Math.min(props.dur, props.at + 10));
  const [exact, setExact] = useState(true);
  const [tool, setTool] = useState<'loading' | boolean>('loading');
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const unlisten = useRef<(() => void)[]>([]);
  const len = Math.max(0, end - start);
  useEffect(() => {
    let alive = true;
    api.videoToolInfo().then((t) => alive && setTool(!!t?.available), () => alive && setTool(false));
    return () => {
      alive = false;
      unlisten.current.forEach((u) => u());
    };
  }, []);
  const stop = () => api.cancelVideoTask('cut').catch(() => {});
  const make = async () => {
    setErr(null);
    if (len < 0.1) return setErr('The end must be after the start.');
    const name = derivedName(props.name, start, 'mp4', 'clip');
    setBusy(0);
    unlisten.current.forEach((u) => u());
    unlisten.current = await Promise.all([
      onEvent<VideoToolProgress>('cut-progress', (p) => setBusy(p.fraction)),
      onEvent<CutDone>('cut-done', (d) => {
        setBusy(null);
        if (d.cancelled) return;
        if (d.error || d.id == null) return setErr(d.error ?? "The MP4 wasn't made.");
        const id = d.id;
        if (!d.reused) pushUndo(`Saved “${d.name}”`, () => api.deleteItems([id]));
        props.onSaved(d.name, d.reused);
        props.onClose();
      }),
    ]);
    try {
      await api.cutStart({ item: props.itemId, start, end, exact, name });
    } catch (e) {
      setBusy(null);
      setErr(errText(e));
    }
  };
  const num = (v: string) => Math.max(0, Math.min(props.dur, Number(v.replace(',', '.')) || 0));
  const close = () => (busy != null ? stop() : props.onClose());
  if (tool === false) {
    return (
      <Modal title="Save part as MP4" onClose={props.onClose}>
        <div className="notice">
          <span>
            Saving part of a video needs the video tool, which isn't installed. It comes with the full Media Vault package:
            unzip the full download so that the <b>tools</b> folder (with ffmpeg.exe inside) sits next to MediaVault.exe, then try again.
          </span>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={props.onClose}>OK</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Save part as MP4" onClose={close}>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        From “{props.name}”, with its sound. The MP4 is saved in the same folder, encrypted like everything else; the video itself doesn't change.
        {fromLoop ? ' Starts with your A–B loop.' : ' Tip: set a loop with A and B first.'}
      </p>
      <div className="form-grid">
        <label htmlFor="mp4-start">Start (seconds)</label>
        <span className="row"><input id="mp4-start" className="input small" type="number" step="0.1" min={0} value={Number(start.toFixed(2))}
          onChange={(e) => setStart(num(e.target.value))} /> <span className="faint">{preciseTime(start)}</span></span>
        <label htmlFor="mp4-end">End (seconds)</label>
        <span className="row"><input id="mp4-end" className="input small" type="number" step="0.1" min={0} value={Number(end.toFixed(2))}
          onChange={(e) => setEnd(num(e.target.value))} /> <span className="faint">{preciseTime(end)} · {len.toFixed(1)} s</span></span>
      </div>
      <div className="cut-ways" role="radiogroup" aria-label="How">
        <label className={`cut-way${exact ? ' on' : ''}`}>
          <input type="radio" name="cut-way" checked={exact} onChange={() => setExact(true)} />
          <span><b>Exact</b><span className="faint">Starts and ends on the exact frame, but the video is re-encoded: slower, with a tiny quality change.</span></span>
        </label>
        <label className={`cut-way${!exact ? ' on' : ''}`}>
          <input type="radio" name="cut-way" checked={!exact} onChange={() => setExact(false)} />
          <span><b>Fast</b><span className="faint">No quality loss, takes seconds. The start can move to the nearest keyframe (a point the video can start from cleanly), usually up to 2 seconds earlier.</span></span>
        </label>
      </div>
      {busy != null && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="bar"><div style={{ width: `${Math.round(busy * 100)}%` }} /></div>
          <span className="faint mono" style={{ fontSize: 12 }}>{Math.round(busy * 100)}%</span>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={close}>{busy != null ? 'Stop' : 'Cancel'}</button>
        <button type="button" className="btn btn-primary" disabled={busy != null || tool === 'loading'} onClick={make}>{busy != null ? 'Saving…' : 'Save MP4'}</button>
      </div>
    </Modal>
  );
}

/** Picture scaling, like IrfanView's "Use Resample for fitting / zooming". */
export function ScalingMenu({ prefs }: { prefs: ViewerSettings }) {
  // 3D photos (begin): the switch, and a window with its shape, amount and speed (DepthSettings.tsx).
  const [depth, setDepth] = useState(false);
  // 3D photos (end)
  return (
    <>
      <Dropdown className="btn btn-sm glass" label="View ▾" title="How pictures are shown" items={[
        { label: 'Smooth when shrinking to fit', hint: 'better quality', checked: prefs.smoothFit, onSelect: () => saveViewerPrefs({ smoothFit: !prefs.smoothFit }) },
        { label: 'Smooth when zoomed in', hint: 'off = crisp pixels (P)', checked: prefs.smoothZoom, onSelect: () => saveViewerPrefs({ smoothZoom: !prefs.smoothZoom }) },
        { label: 'Sharpen after smoothing', checked: prefs.sharpen, onSelect: () => saveViewerPrefs({ sharpen: !prefs.sharpen }) },
        { label: 'Swipe and edge clicks', hint: 'drag beside the picture, or click at the far left / right, to move on', checked: prefs.swipeNav !== false, onSelect: () => saveViewerPrefs({ swipeNav: prefs.swipeNav === false }) },
        // 3D photos (begin)
        { label: '3D photos (gentle depth motion)', hint: 'still pictures', checked: !!prefs.depthAuto, sepBefore: true, onSelect: () => {
          saveViewerPrefs({ depthAuto: !prefs.depthAuto });
          // Without the depth pack nothing would move: the settings window says what's missing.
          if (!prefs.depthAuto) void depthPack(true).then((i) => !i?.available && setDepth(true));
        } },
        { label: '3D photo settings…', hint: 'shape, amount, speed', onSelect: () => setDepth(true) },
        // 3D photos (end)
      ]} />
      {depth && <DepthSettingsDialog prefs={prefs} onClose={() => setDepth(false)} />}
    </>
  );
}
