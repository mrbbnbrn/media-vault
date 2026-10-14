// The offline AI upscaler in the viewer: an Upscale button (U) with a small
// Real-ESRGAN / GFPGAN switch next to it. The result is shown in place of the
// picture (zoom and pan still work), with a badge, "hold O" to compare with
// the original, and "Save upscaled" to keep it as a new item next to the
// original. Nothing is saved until asked; results are kept in memory while
// the viewer is open (per item and model) and forgotten when it closes.
//
// The window decodes the picture exactly as it shows it and, for GFPGAN,
// finds the faces (face-api, offline); the upscaling itself runs in Rust
// (upscale.rs) on the graphics card or the processor.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api, inTauri, onUpscale, upscaledUrl,
  type UpscaleDone, type UpscaleModel, type UpscaleProgress, type UpscalerInfo,
} from '../api';
import { kickThumbnails, type PlayItem } from '../media';
import { facePoints } from '../ml/facescan';
import { pushUndo } from '../undo';
import { factorText, fivePoints, MODELS, modelLabel, NO_PACK, savedModel, saveModel, upscaleFactor } from '../upscale';
import { CloseIcon, SparkleIcon } from './Icons';

interface Result {
  token: number;
  factor: number;
  faces: number;
  device: 'gpu' | 'cpu' | null;
  saved?: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; model: UpscaleModel; stage: 'reading' | 'faces' | UpscaleProgress['stage']; fraction: number }
  | { kind: 'done'; model: UpscaleModel; result: Result; shown: boolean }
  | { kind: 'note'; text: string };

export interface UpscaleView {
  /** The upscaled picture to draw over the original, or null. */
  src: string | null;
  /** Comparing: the original shows instead. */
  hidden: boolean;
  /** Call when the upscaled picture is on screen / couldn't be shown. */
  onShown: () => void;
  onFailed: () => void;
  /** The Upscale button and the model switch (for the controls bar). */
  button: ReactNode;
  /** Progress, or the "Upscaled ×4" badge with Original / Save. */
  bar: ReactNode;
}

let infoOnce: Promise<UpscalerInfo | null> | null = null;

export function useUpscale(o: {
  item: PlayItem | null;
  /** A still picture in the vault, in the full viewer. */
  enabled: boolean;
  /** Listen to U and O. */
  keys: boolean;
  /** Short messages ("Saved …"). */
  onMessage: (text: string) => void;
  /** Called when an upscale starts (the slideshow waits). */
  onStart?: () => void;
}): UpscaleView {
  const { item, enabled } = o;
  const [info, setInfo] = useState<UpscalerInfo | null>(null);
  const [model, setModel] = useState<UpscaleModel>(savedModel);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [holding, setHolding] = useState(false);
  const [compare, setCompare] = useState(false);
  const cache = useRef(new Map<string, Result>());
  const job = useRef<number | null>(null);
  const early = useRef(new Map<number, UpscaleDone>());
  const run = useRef(0); // bumps on every start / reset
  const current = useRef<{ key: string; model: UpscaleModel } | null>(null);
  const oRef = useRef(o);
  oRef.current = o;

  useEffect(() => {
    let alive = true;
    infoOnce ??= api.upscaleInfo().catch(() => null);
    infoOnce.then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);

  // Leaving the viewer frees everything.
  useEffect(() => () => {
    infoOnce = null; // asked again next time (the pack may have been added)
    if (job.current != null) api.upscaleCancel().catch(() => {});
    api.upscaleForget().catch(() => {});
  }, []);

  const finish = (d: UpscaleDone) => {
    if (d.job !== job.current) return;
    job.current = null;
    const c = current.current;
    if (!c) return;
    if (d.cancelled) return setPhase({ kind: 'idle' });
    if (d.error || d.token == null) return setPhase({ kind: 'note', text: d.error ?? "Couldn't upscale this picture." });
    const result: Result = { token: d.token, factor: d.factor, faces: d.faces, device: d.device };
    cache.current.set(`${c.key}:${c.model}`, result);
    setPhase({ kind: 'done', model: c.model, result, shown: false });
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(
    () =>
      onUpscale({
        progress: (p) => {
          if (p.job !== job.current) return;
          setPhase((ph) => (ph.kind === 'busy' ? { ...ph, stage: p.stage, fraction: p.fraction } : ph));
        },
        done: (d) => {
          if (job.current == null) early.current.set(d.job, d);
          else finishRef.current(d);
        },
      }),
    [],
  );

  const stop = () => {
    run.current += 1;
    if (job.current != null) api.upscaleCancel().catch(() => {});
    job.current = null;
  };

  // Another item: back to normal (results stay cached).
  useEffect(() => {
    stop();
    current.current = null;
    setPhase({ kind: 'idle' });
    setCompare(false);
    setHolding(false);
  }, [item?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (m: UpscaleModel) => {
    const it = oRef.current.item;
    if (!it || it.itemId == null || !oRef.current.enabled) return;
    stop();
    const mine = run.current;
    setCompare(false);
    current.current = { key: it.key, model: m };
    const hit = cache.current.get(`${it.key}:${m}`);
    if (hit) return setPhase({ kind: 'done', model: m, result: hit, shown: false });
    const pack = info ?? (await (infoOnce ?? Promise.resolve(null)));
    if (!pack?.available) return setPhase({ kind: 'note', text: pack?.problem && pack.problem !== "The upscaler pack isn't installed." ? `${pack.problem} ${NO_PACK}` : NO_PACK });
    oRef.current.onStart?.();
    setPhase({ kind: 'busy', model: m, stage: 'reading', fraction: 0 });
    try {
      // The picture as the viewer shows it (turned the right way up).
      const blob = await (await fetch(it.src)).blob();
      let bmp: ImageBitmap;
      try {
        bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch {
        bmp = await createImageBitmap(blob);
      }
      try {
        const f = upscaleFactor(bmp.width, bmp.height);
        if ('error' in f) throw new Error(f.error);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        const rgba = new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer);
        c.width = c.height = 0;
        if (mine !== run.current) return;
        let faces: [number, number][][] = [];
        if (m === 'gfpgan') {
          setPhase({ kind: 'busy', model: m, stage: 'faces', fraction: 0 });
          const pts = await facePoints(bmp, bmp.width, bmp.height).catch(() => [] as [number, number][][]);
          faces = pts.map(fivePoints).filter((p): p is [number, number][] => p != null);
          if (mine !== run.current) return;
        }
        setPhase({ kind: 'busy', model: m, stage: 'loading', fraction: 0 });
        const id = await api.upscaleStart({ itemId: it.itemId, width: bmp.width, height: bmp.height, model: m, faces }, rgba);
        if (mine !== run.current) {
          api.upscaleCancel().catch(() => {});
          return;
        }
        job.current = id;
        const d = early.current.get(id);
        early.current.clear();
        if (d) finish(d);
      } finally {
        bmp.close();
      }
    } catch (e) {
      if (mine === run.current) setPhase({ kind: 'note', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const off = () => {
    stop();
    current.current = null;
    setPhase({ kind: 'idle' });
    setCompare(false);
  };

  const toggle = () => {
    if (!oRef.current.enabled) return;
    if (phase.kind === 'busy' || phase.kind === 'done') off();
    else start(model);
  };

  const pick = (m: UpscaleModel) => {
    setModel(m);
    saveModel(m);
    // Already upscaling or upscaled: show it with this model instead.
    if (phase.kind === 'busy' || phase.kind === 'done') start(m);
  };

  const save = async () => {
    if (phase.kind !== 'done' || phase.result.saved) return;
    const r = phase.result;
    try {
      const s = await api.upscaleSave(r.token);
      r.saved = s.name;
      setPhase({ ...phase });
      kickThumbnails();
      pushUndo(`Saved “${s.name}”`, () => api.deleteItems([s.id]));
      oRef.current.onMessage(`Saved “${s.name}” next to the original (Ctrl+Z undoes it)`);
    } catch (e) {
      oRef.current.onMessage(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // U: upscale / back to normal / stop. Hold O: the original.
  useEffect(() => {
    if (!o.keys || !enabled) return;
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement).closest('input, textarea, select, [role=dialog]');
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'u' && !e.repeat) toggle();
      else if (k === 'o' && phase.kind === 'done') setHolding(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'o') setHolding(false);
    };
    const blur = () => setHolding(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  });

  const done = phase.kind === 'done' ? phase : null;
  const busy = phase.kind === 'busy' ? phase : null;
  const src = done && item ? (inTauri ? upscaledUrl(done.result.token) : item.src) : null;
  const hidden = holding || compare;

  if (!enabled) {
    return { src: null, hidden: false, onShown: () => {}, onFailed: () => {}, button: null, bar: null };
  }

  const missing = info != null && !info.available;
  const button = (
    <div className="upscale-ctl" role="group" aria-label="AI upscaler">
      <button type="button" className={`pbtn lg wide${done || busy ? ' on' : ''}${missing ? ' dim' : ''}`} aria-pressed={!!(done || busy)}
        title={missing ? NO_PACK : done ? 'Back to the normal picture (U)' : busy ? 'Stop upscaling (U)' : 'Upscale ×4 with AI, offline (U)'}
        onClick={toggle}>
        <SparkleIcon size={16} /> {busy ? 'Upscaling…' : 'Upscale'}
      </button>
      <div className="seg up-models" role="radiogroup" aria-label="Upscaler model">
        {MODELS.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={model === m.id} className={model === m.id ? 'on' : ''} title={m.hint}
            onClick={() => pick(m.id)}>{m.label}</button>
        ))}
      </div>
    </div>
  );

  let bar: ReactNode = null;
  const fx = item?.width && item?.height ? upscaleFactor(item.width, item.height) : null;
  const factor = done ? factorText(done.result.factor) : fx && 'factor' in fx ? factorText(fx.factor) : '×4';
  if (busy) {
    const what =
      busy.stage === 'reading' ? 'Getting the picture ready…'
        : busy.stage === 'faces' && busy.fraction === 0 ? 'Finding faces…'
          : busy.stage === 'loading' ? 'Starting the upscaler…'
            : busy.stage === 'finishing' ? 'Almost done…'
              : `${busy.stage === 'faces' ? 'Rebuilding faces' : 'Upscaling'} ${factor} · ${Math.round(busy.fraction * 100)}%`;
    bar = (
      <div className="upscale-bar" role="status">
        <SparkleIcon size={14} />
        <span>{what}</span>
        <span className="faint">{modelLabel(busy.model)}</span>
        <span className="up-progress" aria-hidden="true"><span style={{ width: `${Math.round(busy.fraction * 100)}%` }} /></span>
        <button type="button" className="btn btn-sm glass" onClick={off}>Cancel</button>
      </div>
    );
  } else if (done) {
    const r = done.result;
    const extra = done.model === 'gfpgan' ? (r.faces ? `${r.faces === 1 ? '1 face' : `${r.faces} faces`} rebuilt` : 'no faces found') : '';
    bar = (
      <div className={`upscale-bar done${hidden ? ' original' : ''}`} role="status">
        <SparkleIcon size={14} />
        <b>{hidden ? 'Showing the original' : `Upscaled ${factorText(r.factor)} · ${modelLabel(done.model)}`}</b>
        {!hidden && extra && <span className="faint">{extra}</span>}
        {!done.shown && <span className="faint">Opening…</span>}
        <button type="button" className={`btn btn-sm glass${compare ? ' accent-soft' : ''}`} aria-pressed={compare} title="Show the original (or hold O)"
          onClick={() => setCompare((c) => !c)}>Original</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!!r.saved} onClick={save}
          title="Keep it as a new item next to the original">{r.saved ? 'Saved' : 'Save upscaled'}</button>
        <button type="button" className="btn btn-icon btn-sm glass" aria-label="Back to the normal picture" title="Back to the normal picture (U)" onClick={off}><CloseIcon size={12} /></button>
      </div>
    );
  } else if (phase.kind === 'note') {
    bar = (
      <div className="upscale-bar note" role="status">
        <SparkleIcon size={14} />
        <span>{phase.text}</span>
        <button type="button" className="btn btn-icon btn-sm glass" aria-label="Close" onClick={off}><CloseIcon size={12} /></button>
      </div>
    );
  }

  return {
    src,
    hidden,
    onShown: () => setPhase((p) => (p.kind === 'done' && !p.shown ? { ...p, shown: true } : p)),
    onFailed: () => {
      // No longer in memory (only the last few are kept): forget it.
      const c = current.current;
      if (c) cache.current.delete(`${c.key}:${c.model}`);
      setPhase({ kind: 'note', text: 'That upscaled picture is no longer in memory. Press U to upscale it again.' });
    },
    button,
    bar,
  };
}

/** Settings: is the upscaler there, and graphics card or processor. */
export function UpscalerSection() {
  const [info, setInfo] = useState<UpscalerInfo | null>(null);
  useEffect(() => {
    api.upscaleInfo().then(setInfo).catch(() => {});
  }, []);
  return (
    <section className="section">
      <h2>AI upscaler</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        In the viewer, <b>Upscale</b> (U) makes a picture 4 times bigger, fully offline. <b>Real-ESRGAN</b> keeps the picture
        faithful; <b>GFPGAN</b> also rebuilds faces, for the sharpest faces. Nothing is saved unless you press <b>Save upscaled</b>.
      </p>
      {info && (info.available ? (
        <div className="info">
          Upscaler found · runs on the {info.device === 'gpu' ? 'graphics card' : 'processor'}{info.deviceKnown ? '' : info.device === 'gpu' ? ' (when it can)' : ''}.
          GFPGAN is for personal use only (its licence doesn't allow commercial use).
        </div>
      ) : (
        <div className="notice">{info.problem && info.problem !== "The upscaler pack isn't installed." ? `${info.problem} ` : ''}{NO_PACK}</div>
      ))}
    </section>
  );
}
