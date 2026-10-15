// "Find the best frames…" in the viewer: looks through a video with a hidden
// copy of it (seeking every second or two), scores each moment for sharpness,
// exposure and faces, and offers the best different-looking ones to save as
// pictures next to the video. Pixels stay in memory; each saved frame goes
// straight into the vault, encrypted (add_file_bytes), never to disk.
// The rules are in bestframes.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FaceBox } from '../api';
import {
  clock, exposureOf, exposureScore, faceScore, frameNames, laplacianVariance, pickBest, sampleTimes, scoreSamples, signature, toGray, wanted,
  type Sample, type Scored,
} from '../bestframes';
import { captureVideoFrame } from '../clips';
import { kickThumbnails, type PlayItem } from '../media';
import { turnedSize, turnMatrix, type Quarter } from '../rotation';
import { pushUndo, plural } from '../undo';
import { Modal } from './Dialogs';
import './bestframes.css';

const ANALYSE_W = 256;
const PREVIEW_W = 360;

type Phase =
  | { kind: 'opening' }
  | { kind: 'scanning'; done: number; total: number }
  | { kind: 'ready'; stopped: boolean }
  | { kind: 'saving'; done: number; total: number }
  | { kind: 'failed'; why: string };

function seek(v: HTMLVideoElement, t: number, ms = 5000): Promise<boolean> {
  return new Promise((res) => {
    let timer = 0;
    const end = (ok: boolean) => {
      window.clearTimeout(timer);
      v.removeEventListener('seeked', yes);
      v.removeEventListener('error', no);
      res(ok);
    };
    const yes = () => end(true);
    const no = () => end(false);
    timer = window.setTimeout(() => end(false), ms);
    v.addEventListener('seeked', yes);
    v.addEventListener('error', no);
    v.currentTime = t;
  });
}

function opened(v: HTMLVideoElement): Promise<void> {
  return new Promise((res, rej) => {
    if (v.readyState >= 2) return res();
    const timer = window.setTimeout(() => rej(new Error('The video took too long to open.')), 20000);
    v.onloadeddata = () => {
      window.clearTimeout(timer);
      res();
    };
    v.onerror = () => {
      window.clearTimeout(timer);
      rej(new Error('This video could not be read here.'));
    };
  });
}

export function BestFramesDialog(props: {
  item: PlayItem;
  /** How the viewer shows it turned (frames are saved the same way round). */
  rot: Quarter;
  onClose: () => void;
  onMessage: (text: string) => void;
  /** Saved: Ctrl+Z in the viewer may undo it. */
  onSaved?: () => void;
}) {
  const { item, rot } = props;
  const [phase, setPhaseState] = useState<Phase>({ kind: 'opening' });
  // The dialog's Esc keeps the first close(): it reads the phase from here.
  const phaseRef = useRef<Phase>(phase);
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const [picks, setPicks] = useState<(Scored & { preview: string })[]>([]);
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stop = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    stop.current = false;
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.src = item.src;
    videoRef.current = v;
    (async () => {
      const faces: FaceBox[] = item.itemId != null ? await api.facesOf(item.itemId).catch(() => []) : [];
      await opened(v);
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (item.durationMs ?? 0) / 1000;
      const times = sampleTimes(dur);
      if (!times.length || !v.videoWidth) throw new Error('This video has no pictures to look through.');
      const aw = Math.min(ANALYSE_W, v.videoWidth);
      const ah = Math.max(8, Math.round((aw * v.videoHeight) / v.videoWidth));
      const ac = document.createElement('canvas');
      ac.width = aw;
      ac.height = ah;
      const actx = ac.getContext('2d', { willReadFrequently: true })!;
      const pw = Math.min(PREVIEW_W, v.videoWidth);
      const ph = Math.round((pw * v.videoHeight) / v.videoWidth);
      const pt = turnedSize({ w: pw, h: ph }, rot);
      const pc = document.createElement('canvas');
      pc.width = pt.w;
      pc.height = pt.h;
      const pctx = pc.getContext('2d')!;
      pctx.setTransform(...turnMatrix(rot, 0, 0, pt.w, pt.h));
      const samples: Sample[] = [];
      const previews = new Map<number, string>();
      const want = wanted(dur);
      const hasFaces = faces.length > 0;
      const refresh = () => {
        const best = pickBest(scoreSamples(samples, hasFaces), want, { minGapS: Math.max(1.5, dur / 60) });
        setPicks(best.map((b) => ({ ...b, preview: previews.get(b.t) ?? '' })));
      };
      setPhase({ kind: 'scanning', done: 0, total: times.length });
      for (let i = 0; i < times.length; i++) {
        if (stop.current || !alive.current) break;
        const t = times[i];
        if (!(await seek(v, t))) continue;
        actx.drawImage(v, 0, 0, aw, ah);
        const g = toGray(actx.getImageData(0, 0, aw, ah).data, aw, ah);
        samples.push({ t, sharp: laplacianVariance(g, aw, ah), exposure: exposureScore(exposureOf(g)), face: faceScore(faces, t), sig: signature(g, aw, ah) });
        pctx.drawImage(v, 0, 0, pw, ph);
        previews.set(t, pc.toDataURL('image/jpeg', 0.82));
        if (!alive.current) return;
        setPhase({ kind: 'scanning', done: i + 1, total: times.length });
        if (i % 6 === 5 || i === times.length - 1) refresh();
      }
      if (!alive.current) return;
      if (!samples.length) throw new Error('No frames could be read from this video.');
      refresh();
      setPhase({ kind: 'ready', stopped: stop.current });
    })().catch((e) => alive.current && setPhase({ kind: 'failed', why: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive.current = false;
      v.removeAttribute('src');
      v.load();
      videoRef.current = null;
    };
  }, [item.src]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => picks.filter((p) => !unticked.has(p.t)), [picks, unticked]);
  const busy = phase.kind === 'scanning' || phase.kind === 'saving' || phase.kind === 'opening';

  const toggle = (t: number) => setUnticked((u) => {
    const n = new Set(u);
    if (n.has(t)) n.delete(t);
    else n.add(t);
    return n;
  });

  const save = async () => {
    const v = videoRef.current;
    if (!v || !chosen.length || phase.kind !== 'ready') return;
    const names = frameNames(item.name, chosen.map((c) => c.t));
    const ids: number[] = [];
    setPhase({ kind: 'saving', done: 0, total: chosen.length });
    try {
      for (let i = 0; i < chosen.length; i++) {
        if (!(await seek(v, chosen[i].t, 10000))) throw new Error('The video could not be read at that moment.');
        const blob = await captureVideoFrame(v, rot);
        ids.push(await api.addFileBytes(item.folderId, names[i], new Uint8Array(await blob.arrayBuffer())));
        if (alive.current) setPhase({ kind: 'saving', done: i + 1, total: chosen.length });
      }
    } catch (e) {
      props.onMessage(`Couldn't save ${ids.length ? 'all the frames' : 'the frames'}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (ids.length) {
      kickThumbnails();
      const what = ids.length === 1 ? `“${names[0]}”` : plural(ids.length, 'frame');
      pushUndo(`Saved ${what} from “${item.name}”`, () => api.deleteItems(ids));
      props.onSaved?.();
      props.onMessage(`Saved ${what} next to the video (Ctrl+Z undoes it)`);
    }
    props.onClose();
  };

  const close = () => {
    if (phaseRef.current.kind === 'saving') return;
    stop.current = true;
    props.onClose();
  };

  const pct = phase.kind === 'scanning' || phase.kind === 'saving' ? (phase.done / Math.max(1, phase.total)) * 100 : phase.kind === 'ready' ? 100 : 0;
  return (
    <Modal title="Best frames" onClose={close} wide>
      <p className="faint bf-intro">
        {phase.kind === 'failed' ? phase.why
          : phase.kind === 'opening' ? `Opening “${item.name}”…`
          : phase.kind === 'scanning' ? `Looking through “${item.name}” for sharp, well-lit moments… ${Math.round(pct)}%`
          : phase.kind === 'saving' ? `Saving ${phase.done + 1 > phase.total ? phase.total : phase.done + 1} of ${phase.total}…`
          : picks.length ? `${phase.stopped ? 'Stopped early. ' : ''}The sharpest, best-lit moments that look different from each other. Tick the ones to keep; they're saved as pictures next to the video.`
          : 'No good frames turned up in this video.'}
      </p>
      {(phase.kind === 'scanning' || phase.kind === 'saving' || phase.kind === 'opening') && (
        <div className={`bar${phase.kind === 'opening' ? ' bf-wait' : ''}`}><div style={{ width: `${pct}%` }} /></div>
      )}
      <div className="bf-grid" role="group" aria-label="Frames">
        {picks.map((p, i) => {
          const on = !unticked.has(p.t);
          return (
            <label key={p.t} className={`bf-frame${on ? ' on' : ''}`} style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
              title={`${clock(p.t)} · sharpness and light ${Math.round(p.score * 100)}%`}>
              {p.preview ? <img src={p.preview} alt={`Frame at ${clock(p.t)}`} draggable={false} /> : <span className="bf-blank" />}
              <input type="checkbox" checked={on} disabled={phase.kind === 'saving'} onChange={() => toggle(p.t)} />
              <span className="bf-tick" aria-hidden="true">{on ? '✓' : ''}</span>
              <span className="bf-time mono">{clock(p.t)}</span>
              {p.face > 0 && <span className="bf-face" title="Faces in this frame">face</span>}
            </label>
          );
        })}
        {phase.kind !== 'failed' && !picks.length && busy && Array.from({ length: 8 }, (_, i) => <span key={i} className="bf-frame bf-ghost" />)}
      </div>
      <div className="row bf-actions">
        {picks.length > 1 && phase.kind === 'ready' && (
          <button type="button" className="link" onClick={() => setUnticked(unticked.size ? new Set() : new Set(picks.map((p) => p.t)))}>
            {unticked.size ? 'Tick all' : 'Untick all'}
          </button>
        )}
        <span style={{ marginLeft: 'auto' }} />
        {phase.kind === 'scanning' ? (
          <>
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn" onClick={() => { stop.current = true; }} disabled={!picks.length}
              title="Stop looking and choose from what was found so far">Stop here</button>
          </>
        ) : (
          <button type="button" className="btn" onClick={close} disabled={phase.kind === 'saving'}>{phase.kind === 'ready' ? 'Close' : 'Cancel'}</button>
        )}
        <button type="button" className="btn btn-primary" disabled={phase.kind !== 'ready' || !chosen.length || item.itemId == null} onClick={save}>
          {phase.kind === 'saving' ? 'Saving…' : chosen.length ? `Save selected (${chosen.length})` : 'Save selected'}
        </button>
      </div>
    </Modal>
  );
}

/** A film frame with a little star (the viewer's "best frames" button). */
export const BestFramesIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 5v14M17 5v14" />
    <path d="M12 9.2l.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2L9.1 11.3l2-.3z" strokeWidth={1.4} />
  </svg>
);
