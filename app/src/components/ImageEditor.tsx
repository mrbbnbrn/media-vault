// The picture editor (still pictures in the vault): crop (free or a fixed
// shape), straighten, turn, flip, and light and colour, with a live preview.
// "Save as copy" makes a new picture next to the original at full size (the
// original never changes; Ctrl+Z takes the copy away again). When only turned,
// the rotation can instead be saved to the original as before (Player.tsx,
// rotatesave.ts). The sums are in imageedit.ts.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  adjustPixels, anySeeThrough, ASPECTS, aspectRatio, clampAngle, dragCrop, editedName, editMatrix, fitAspect, frameSize, FULL, hasAdjust,
  isRotationOnly, isUnchanged, MAX_ANGLE, mul, NO_ADJUST, NO_EDIT, outputSize, savedFormat, turnEdit, type Adjust, type Aspect, type Edit, type Handle, type Matrix,
} from '../imageedit';
import { kickThumbnails, noteItemsChanged, type PlayItem } from '../media';
import { saveWay, type Quarter } from '../rotation';
import { pushUndo } from '../undo';
import { CloseIcon, FlipIcon, RotateIcon } from './Icons';
import { useLayer } from '../keylayers';

/** Biggest picture the window can draw in one piece. */
const MAX_SIDE = 16384;
const MAX_PIXELS = 268_000_000;
/** The preview is drawn from a copy this big on its long side. */
const PREVIEW_SIDE = 1600;

const SLIDERS: { key: keyof Adjust; label: string; min: number }[] = [
  { key: 'brightness', label: 'Brightness', min: -100 },
  { key: 'contrast', label: 'Contrast', min: -100 },
  { key: 'saturation', label: 'Saturation', min: -100 },
  { key: 'warmth', label: 'Warmth', min: -100 },
  { key: 'sharpness', label: 'Sharpness', min: 0 },
];
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function ImageEditor(props: {
  item: PlayItem;
  /** Opened with R / Shift+R: starts turned this way. */
  startQuarter?: Quarter;
  onClose: () => void;
  onMessage: (text: string) => void;
  /** A copy was saved (Ctrl+Z in the viewer can take it away again). */
  onSaved?: () => void;
  /** Keep the rotation in the original file instead (the old "Save rotation"). */
  onSaveRotation: (quarter: Quarter) => void;
}) {
  const { item } = props;
  const [edit, setEdit] = useState<Edit>(NO_EDIT);
  const [pic, setPic] = useState<{ full: ImageBitmap; small: ImageBitmap } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const W = pic?.full.width ?? item.width ?? 1;
  const H = pic?.full.height ?? item.height ?? 1;

  // The picture, upright as the viewer shows it (its own orientation applied), and a smaller copy for the preview.
  useEffect(() => {
    let alive = true;
    let got: { full: ImageBitmap; small: ImageBitmap } | null = null;
    (async () => {
      const r = await fetch(item.src);
      if (!r.ok) throw new Error(`couldn't read it (${r.status})`);
      const blob = await r.blob();
      let full: ImageBitmap;
      try {
        full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch {
        full = await createImageBitmap(blob);
      }
      const k = Math.min(1, PREVIEW_SIDE / Math.max(full.width, full.height));
      const small = k < 1 ? await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * k)), resizeHeight: Math.max(1, Math.round(full.height * k)), resizeQuality: 'high' }) : full;
      got = { full, small };
      if (!alive) return;
      setPic(got);
      if (props.startQuarter) setEdit((e) => turnEdit(e, props.startQuarter!, full.width, full.height));
    })().catch((e) => alive && setLoadErr(`The picture couldn't be opened for editing: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      alive = false;
      if (got) {
        if (got.small !== got.full) got.small.close();
        got.full.close();
      }
    };
  }, [item.src]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // The preview shows the whole frame (turned and straightened); the crop is drawn over it.
  const frame = frameSize(W, H, edit);
  const k = area.w > 0 && area.h > 0 ? Math.min((area.w - 40) / frame.w, (area.h - 40) / frame.h) : 0;
  const cw = Math.max(1, Math.round(frame.w * k));
  const ch = Math.max(1, Math.round(frame.h * k));
  const ratio = aspectRatio(edit.aspect, frame);

  // Drawn on the next frame after a change, so dragging a slider stays smooth.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !pic || k <= 0) return;
    const raf = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(cw * dpr));
      c.height = Math.max(1, Math.round(ch * dpr));
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const s = pic.small;
      const m: Matrix = mul(editMatrix(W, H, { ...edit, crop: FULL }, (c.width / frame.w)), [W / s.width, 0, 0, H / s.height, 0, 0]);
      ctx.setTransform(...m);
      ctx.drawImage(s, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (hasAdjust(edit.adjust)) {
        const d = ctx.getImageData(0, 0, c.width, c.height);
        adjustPixels(d.data, c.width, c.height, edit.adjust);
        ctx.putImageData(d, 0, 0);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [pic, edit.quarter, edit.flipH, edit.flipV, edit.angle, edit.adjust, cw, ch]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- changes ----
  const turn = (by: number) => setEdit((e) => turnEdit(e, by, W, H));
  const setAspect = (a: Aspect) => setEdit((e) => ({ ...e, aspect: a, crop: fitAspect(aspectRatio(a, frameSize(W, H, e)), frameSize(W, H, e)) }));
  const setAngle = (a: number) => setEdit((e) => ({ ...e, angle: clampAngle(a) }));
  const setAdjust = (key: keyof Adjust, v: number) => setEdit((e) => ({ ...e, adjust: { ...e.adjust, [key]: v } }));
  const reset = () => setEdit(NO_EDIT);

  // R / Shift+R turn, Esc cancels (the viewer's own keys wait meanwhile).
  const keys = useRef({ turn, cancel: props.onClose, busy: false });
  keys.current = { turn, cancel: props.onClose, busy: !!busy };
  // A layer over the viewer (keylayers.ts): back cancels the edit.
  const layer = useLayer(true, { name: 'picture editor', onBack: () => keys.current.cancel() });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keys.current.busy || !layer.mine()) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        e.preventDefault();
        e.stopPropagation();
        keys.current.cancel();
      } else if (k === 'r' && !e.ctrlKey && !e.altKey && !e.metaKey && !(e.target instanceof HTMLInputElement && e.target.type !== 'range')) {
        e.preventDefault();
        e.stopPropagation();
        keys.current.turn(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---- dragging the crop ----
  const startDrag = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0 || k <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const from = edit.crop;
    const f = frame;
    const r = ratio;
    const move = (ev: PointerEvent) => {
      const crop = dragCrop(from, handle, (ev.clientX - x0) / k, (ev.clientY - y0) / k, r, f, 24 / k);
      setEdit((x) => ({ ...x, crop }));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  // ---- saving ----
  const way = saveWay(item.kind, item.name);
  const rotationOnly = isRotationOnly(edit) && edit.quarter !== 0;
  const losslessWay = way.way === 'jpeg' || (way.way === 'pixels' && way.mime === 'image/png');
  const canSaveRotation = rotationOnly && item.itemId != null && way.way !== 'no';
  const out = outputSize(W, H, edit);

  const saveCopy = async () => {
    if (!pic || item.itemId == null || busy) return;
    if (out.w > MAX_SIDE || out.h > MAX_SIDE || out.w * out.h > MAX_PIXELS) {
      props.onMessage(`This picture is too big to save edited here (${out.w} × ${out.h}). Try cropping it.`);
      return;
    }
    setBusy('Saving a copy…');
    let c: HTMLCanvasElement | null = document.createElement('canvas');
    try {
      c.width = out.w;
      c.height = out.h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error("the window couldn't draw it");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(...editMatrix(W, H, edit));
      ctx.drawImage(pic.full, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const ext = (item.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
      const jpeg = ext === 'jpg' || ext === 'jpeg';
      let seeThrough = false;
      if (hasAdjust(edit.adjust) || (!jpeg && ext !== 'png')) {
        // Let the window draw first, so "Saving a copy…" shows on big pictures.
        await new Promise((r) => setTimeout(r, 30));
        const d = ctx.getImageData(0, 0, out.w, out.h);
        if (!jpeg && ext !== 'png') seeThrough = anySeeThrough(d.data);
        adjustPixels(d.data, out.w, out.h, edit.adjust);
        ctx.putImageData(d, 0, 0);
      }
      const fmt = savedFormat(item.name, seeThrough);
      const blob = await new Promise<Blob | null>((res) => c!.toBlob(res, fmt.mime, fmt.quality));
      if (!blob) throw new Error("the window couldn't make the picture file");
      const name = editedName(item.name, fmt.ext);
      const saved = await api.addCopyBytes(item.itemId, name, new Uint8Array(await blob.arrayBuffer()), out.w, out.h);
      if (!saved.reused) {
        pushUndo(`Saved “${name}”`, () => api.deleteItems([saved.id]));
        props.onSaved?.();
      }
      kickThumbnails();
      noteItemsChanged();
      props.onMessage(saved.reused ? `“${name}” was already in this folder` : `Saved “${name}” next to the original · Ctrl+Z undoes it`);
      props.onClose();
    } catch (e) {
      props.onMessage(`Couldn't save the copy: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(null);
    } finally {
      c.width = c.height = 0;
      c = null;
    }
  };

  const cropStyle = { left: edit.crop.x * cw, top: edit.crop.y * ch, width: edit.crop.w * cw, height: edit.crop.h * ch };
  const changed = !isUnchanged(edit);

  return (
    <div className="img-editor" role="dialog" aria-modal="true" aria-label="Edit picture"
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="ie-area" ref={areaRef}>
        {loadErr ? <div className="error">{loadErr}</div> : !pic ? <span className="faint">Opening the picture…</span> : (
          <div className="ie-pic" style={{ width: cw, height: ch }}>
            <canvas ref={canvasRef} style={{ width: cw, height: ch }} aria-label={`${item.name}, edited`} role="img" />
            <div className="ie-clip" aria-hidden="true"><div className="ie-shade" style={cropStyle} /></div>
            <div className="ie-crop" style={cropStyle} onPointerDown={startDrag('move')}>
              <span className="ie-third v1" /><span className="ie-third v2" /><span className="ie-third h1" /><span className="ie-third h2" />
              {HANDLES.map((h) => <span key={h} className={`ie-handle ${h}`} onPointerDown={startDrag(h)} />)}
            </div>
          </div>
        )}
        {busy && <div className="ie-busy" role="status">{busy}</div>}
      </div>
      <aside className="ie-panel">
        <div className="row-between">
          <h2 className="ie-title">Edit picture</h2>
          <button type="button" className="btn btn-icon btn-sm ghost" aria-label="Cancel (Esc)" title="Cancel (Esc)" onClick={props.onClose}><CloseIcon size={12} /></button>
        </div>
        <p className="faint ie-note">Saved as a new picture next to the original, at full size. The original doesn't change.</p>

        <section>
          <h3>Crop</h3>
          <div role="group" aria-label="Crop shape" className="seg ie-seg">
            {ASPECTS.map((a) => (
              <button key={a.id} type="button" className={edit.aspect === a.id ? 'on' : ''} onClick={() => setAspect(a.id)}>{a.label}</button>
            ))}
          </div>
          <span className="faint ie-small">Drag the corners or edges of the box; drag inside it to move it. {out.w} × {out.h}</span>
        </section>

        <section>
          <div className="row-between">
            <h3><label htmlFor="ie-angle">Straighten</label></h3>
            <span className="faint ie-val">{edit.angle > 0 ? '+' : ''}{edit.angle.toFixed(1)}°</span>
          </div>
          <input id="ie-angle" type="range" min={-MAX_ANGLE} max={MAX_ANGLE} step={0.1} value={edit.angle}
            onChange={(e) => setAngle(Number(e.target.value))} onDoubleClick={() => setAngle(0)} />
        </section>

        <section>
          <h3>Rotate and flip</h3>
          <div className="row ie-tools">
            <button type="button" className="btn btn-sm" title="Rotate left (Shift+R)" onClick={() => turn(-1)}><RotateIcon size={16} dir="left" /> Left</button>
            <button type="button" className="btn btn-sm" title="Rotate right (R)" onClick={() => turn(1)}><RotateIcon size={16} /> Right</button>
            <button type="button" className={`btn btn-sm${edit.flipH ? ' accent-soft' : ''}`} aria-pressed={edit.flipH} title="Flip left to right" onClick={() => setEdit((e) => ({ ...e, flipH: !e.flipH }))}><FlipIcon size={16} /> Flip</button>
            <button type="button" className={`btn btn-sm${edit.flipV ? ' accent-soft' : ''}`} aria-pressed={edit.flipV} title="Flip upside down" onClick={() => setEdit((e) => ({ ...e, flipV: !e.flipV }))}><FlipIcon size={16} dir="v" /> Flip</button>
          </div>
        </section>

        <section>
          <h3>Light and colour</h3>
          {SLIDERS.map((sl) => (
            <div key={sl.key} className="ie-slider">
              <label htmlFor={`ie-${sl.key}`}>{sl.label}</label>
              <input id={`ie-${sl.key}`} type="range" min={sl.min} max={100} step={1} value={edit.adjust[sl.key]}
                onChange={(e) => setAdjust(sl.key, Number(e.target.value))} onDoubleClick={() => setAdjust(sl.key, 0)} />
              <span className="faint ie-val">{edit.adjust[sl.key] > 0 && sl.min < 0 ? '+' : ''}{edit.adjust[sl.key]}</span>
            </div>
          ))}
          {hasAdjust(edit.adjust) && <button type="button" className="link ie-small" onClick={() => setEdit((e) => ({ ...e, adjust: NO_ADJUST }))}>Reset light and colour</button>}
        </section>

        <div className="ie-foot">
          {canSaveRotation && (
            <button type="button" className="btn btn-sm ie-wide" disabled={!!busy}
              title={losslessWay ? 'Keep the original turned this way, without changing its pixels (Ctrl+Z undoes it)' : 'Keep the original turned this way (Ctrl+Z undoes it)'}
              onClick={() => { props.onSaveRotation(edit.quarter); props.onClose(); }}>
              {losslessWay ? 'Save rotation to the original (lossless)' : 'Save rotation to the original'}
            </button>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-sm" disabled={!changed || !!busy} onClick={reset}>Reset</button>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={props.onClose}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!changed || !pic || !!busy || item.itemId == null} onClick={saveCopy}
              title={changed ? 'Save the edited picture as a new picture next to the original' : 'Change something first'}>
              {busy ? 'Saving…' : 'Save as copy'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
