// Make an animation (GIF or MP4 video) from pictures with the video tool,
// with a live preview of the order, speed and fit.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, onEvent, thumbUrl, type AnimationDone, type AnimationRequest, type Item, type VideoToolInfo, type VideoToolProgress } from '../api';
import { kickThumbnails } from '../media';
import { plural } from '../undo';
import { Modal } from './Dialogs';

type Order = 'selected' | 'name' | 'date';
const WIDTHS: { w: number; label: string }[] = [
  { w: 480, label: '480' },
  { w: 720, label: '720' },
  { w: 1080, label: '1080' },
  { w: 0, label: 'Original' },
];
const PREVIEW_W = 360;
const PREVIEW_H = 220;
const MAX_PICTURES = 300;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

export function orderPictures(items: Item[], order: Order): Item[] {
  const list = [...items];
  if (order === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  if (order === 'date') list.sort((a, b) => (a.takenAt || a.importedAt) - (b.takenAt || b.importedAt) || a.id - b.id);
  return list;
}

export function AnimationDialog(props: { items: Item[]; onClose: () => void; onDone?: (newId: number | null) => void }) {
  const pictures = useMemo(() => props.items.filter((i) => i.kind === 'image' || i.kind === 'gif'), [props.items]);
  const left = props.items.length - pictures.length;
  const [format, setFormat] = useState<AnimationRequest['format']>('gif');
  const [spp, setSpp] = useState(1);
  const [width, setWidth] = useState(720);
  const [quality, setQuality] = useState<AnimationRequest['quality']>('medium');
  const [loop, setLoop] = useState(true);
  const [order, setOrder] = useState<Order>('selected');
  const [fit, setFit] = useState<AnimationRequest['fit']>('bars');
  const [tool, setTool] = useState<VideoToolInfo | null | 'loading'>('loading');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<VideoToolProgress | null>(null);
  const [done, setDone] = useState<AnimationDone | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const unlisten = useRef<(() => void)[]>([]);

  const ordered = useMemo(() => orderPictures(pictures, order), [pictures, order]);
  const first = ordered[0];
  const aspect = first?.width && first?.height ? first.height / first.width : 3 / 4;
  const outW = even(width || first?.width || 720);
  const outH = even(outW * aspect);

  useEffect(() => {
    api.videoToolInfo().then((i) => setTool(i ?? null)).catch(() => setTool(null));
    return () => unlisten.current.forEach((u) => u());
  }, []);

  // Live preview: cycle the pictures at the chosen speed.
  useEffect(() => {
    if (ordered.length < 2) return;
    const t = window.setInterval(() => setFrame((f) => (f + 1) % ordered.length), Math.max(100, spp * 1000));
    return () => window.clearInterval(t);
  }, [ordered.length, spp]);
  const shown = ordered[frame % Math.max(1, ordered.length)];

  // The frame of the result, as big as fits in the preview box.
  const scale = Math.min(PREVIEW_W / outW, PREVIEW_H / outH);
  const boxW = Math.round(outW * scale);
  const boxH = Math.round(outH * scale);

  const create = async () => {
    setErr(null);
    setDone(null);
    setProgress(null);
    setRunning(true);
    unlisten.current.forEach((u) => u());
    unlisten.current = await Promise.all([
      onEvent<VideoToolProgress>('animation-progress', setProgress),
      onEvent<AnimationDone>('animation-done', (d) => {
        setRunning(false);
        setDone(d);
        if (d.id != null) {
          kickThumbnails();
          props.onDone?.(d.id);
        }
      }),
    ]);
    try {
      await api.animationStart({
        ids: ordered.map((i) => i.id),
        format,
        secondsPerImage: spp,
        width,
        quality,
        loopForever: loop,
        fit,
      });
    } catch (e) {
      setRunning(false);
      setErr(errText(e));
    }
  };

  if (tool === null || (tool !== 'loading' && !tool.available)) {
    return (
      <Modal title="Make an animation" onClose={props.onClose}>
        <div className="notice">
          <span>
            Making animations needs the video tool, which isn't installed. It comes with the full Media Vault package:
            unzip the full download so that the <b>tools</b> folder (with ffmpeg.exe inside) sits next to MediaVault.exe,
            then try again.
          </span>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={props.onClose}>OK</button>
        </div>
      </Modal>
    );
  }

  if (done && !done.cancelled) {
    return (
      <Modal title={done.error ? 'The animation wasn’t made' : 'Animation made'} onClose={props.onClose}>
        <div className="stack" style={{ gap: 10 }}>
          {done.error
            ? <div className="error">{done.error}</div>
            : <span>“{done.name}” is saved in the same folder as the first picture.</span>}
          {done.skipped.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 13 }}>{plural(done.skipped.length, 'item')} left out:</span>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, maxHeight: 140, overflow: 'auto' }}>
                {done.skipped.map(([name, why], i) => <li key={i}><b>{name}</b>: {why}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={props.onClose}>Done</button>
        </div>
      </Modal>
    );
  }

  const seg = <T extends string | number>(label: string, value: T, set: (v: T) => void, opts: { v: T; label: string }[]) => (
    <div role="group" aria-label={label} className="seg">
      {opts.map((o) => (
        <button key={String(o.v)} type="button" className={value === o.v ? 'on' : ''} disabled={running} onClick={() => set(o.v)}>{o.label}</button>
      ))}
    </div>
  );
  const total = ordered.length * spp;

  return (
    <Modal title="Make an animation" wide onClose={() => (running ? undefined : props.onClose())}>
      {ordered.length < 2 ? (
        <p className="muted" style={{ margin: 0 }}>Select at least two pictures to make an animation.</p>
      ) : ordered.length > MAX_PICTURES ? (
        <p className="muted" style={{ margin: 0 }}>That's {ordered.length} pictures; an animation can have up to {MAX_PICTURES}. Select fewer and try again.</p>
      ) : (
        <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
          <div className="stack" style={{ gap: 8 }}>
            <div aria-label="Preview" style={{ width: PREVIEW_W, height: PREVIEW_H, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b0c0e', borderRadius: 10, border: '1px solid #23262c' }}>
              <div style={{ width: boxW, height: boxH, background: '#000', overflow: 'hidden' }}>
                {shown && (
                  <img key={shown.id} src={thumbUrl(shown.id)} alt={shown.name} draggable={false}
                    style={{ width: '100%', height: '100%', objectFit: fit === 'crop' ? 'cover' : 'contain', display: 'block' }} />
                )}
              </div>
            </div>
            <span className="faint mono" style={{ fontSize: 12 }}>
              {frame % ordered.length + 1} / {ordered.length} · {total.toFixed(1)} s in all · {outW}×{outH}
            </span>
            {left > 0 && <span className="faint" style={{ fontSize: 12 }}>{plural(left, 'item')} that {left === 1 ? 'isn’t a picture is' : 'aren’t pictures are'} left out.</span>}
          </div>
          <div className="form-grid" style={{ flex: 1, minWidth: 280 }}>
            <span>Make</span>
            {seg('Make', format, setFormat, [{ v: 'gif', label: 'GIF' }, { v: 'mp4', label: 'MP4 video' }])}
            <label htmlFor="anim-spp">Each picture</label>
            <span className="row">
              <input id="anim-spp" type="range" min={0.1} max={5} step={0.1} value={spp} disabled={running}
                onChange={(e) => setSpp(Math.round(Number(e.target.value) * 10) / 10)} style={{ flex: 1, minWidth: 120 }} />
              <span className="mono" style={{ minWidth: 48 }}>{spp.toFixed(1)} s</span>
            </span>
            <span>Width</span>
            {seg('Width', width, setWidth, WIDTHS.map((o) => ({ v: o.w, label: o.label })))}
            <span>Quality</span>
            {seg('Quality', quality, setQuality, [{ v: 'low', label: 'Low' }, { v: 'medium', label: 'Medium' }, { v: 'high', label: 'High' }])}
            <span>Order</span>
            {seg('Order', order, setOrder, [{ v: 'selected', label: 'As selected' }, { v: 'name', label: 'By name' }, { v: 'date', label: 'By date' }])}
            <span>Fit</span>
            {seg('Fit', fit, setFit, [{ v: 'bars', label: 'Black bars' }, { v: 'crop', label: 'Crop to fill' }])}
            <span>Repeat</span>
            {format === 'gif' ? (
              <label className="check" style={{ minHeight: 32 }}>
                <input type="checkbox" checked={loop} disabled={running} onChange={(e) => setLoop(e.target.checked)} />
                <span>Loop forever</span>
              </label>
            ) : (
              <span className="faint" style={{ fontSize: 13 }}>A video plays once; the player can repeat it.</span>
            )}
          </div>
        </div>
      )}
      <span className="faint" style={{ fontSize: 12 }}>
        The size comes from the first picture’s shape. The result is saved in the first picture’s folder, encrypted like everything else.
      </span>
      {running && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="bar"><div style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} /></div>
          <span className="faint mono" style={{ fontSize: 12 }}>{progress ? `${Math.round(progress.fraction * 100)}% · ${progress.name}` : 'starting…'}</span>
        </div>
      )}
      {done?.cancelled && !running && <span className="faint" style={{ fontSize: 13 }}>Stopped. Nothing was saved.</span>}
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {running
          ? <button type="button" className="btn" onClick={() => api.cancelVideoTask('animation').catch(() => {})}>Stop</button>
          : <button type="button" className="btn" onClick={props.onClose}>Cancel</button>}
        <button type="button" className="btn btn-primary" disabled={running || ordered.length < 2 || ordered.length > MAX_PICTURES || tool === 'loading'} onClick={create}>
          {running ? 'Making…' : format === 'gif' ? 'Make GIF' : 'Make video'}
        </button>
      </div>
    </Modal>
  );
}
