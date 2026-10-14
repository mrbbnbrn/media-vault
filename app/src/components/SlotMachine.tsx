// The slot machine: three reels of random pictures from a folder (and its
// subfolders). Pull the lever or press Space; the reels stop one after
// another. All three the same person or tag = jackpot, with a slideshow of
// everything in that group. Thumbnails only. Esc leaves.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, thumbUrl, type Item, type SlotData } from '../api';
import { evaluate, planSpin, reelStrip, usefulGroups, type SlotGroup, type SpinResult } from '../slots';
import { CloseIcon, FaceIcon, MuteIcon, PlayIcon, SoundIcon, TagIcon } from './Icons';

const REDUCED = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** How long each reel spins (ms); they stop one after another. */
const DURATIONS = REDUCED ? [350, 500, 650] : [1150, 1600, 2050];
const LENGTHS = [16, 21, 26];

// ---- soft clicks (WebAudio, nothing loaded) ------------------------------------------------

let audio: AudioContext | null = null;
function tone(freq: number, ms: number, gain = 0.05, type: OscillatorType = 'triangle', delay = 0) {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime + delay / 1000;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + ms / 1000 + 0.02);
  } catch {
    /* no sound */
  }
}

// ---- confetti (canvas, no assets) --------------------------------------------------------------

function burst(canvas: HTMLCanvasElement) {
  const g = canvas.getContext('2d');
  if (!g) return () => {};
  const dpr = window.devicePixelRatio || 1;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const h = (canvas.height = canvas.clientHeight * dpr);
  const colours = ['#f5c95b', '#ffe29a', '#d9a531', '#2ec4b6', '#9de2da', '#ffffff'];
  const bits = Array.from({ length: 170 }, () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
    const v = (7 + Math.random() * 11) * dpr;
    return {
      x: w / 2, y: h * 0.42, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      s: (5 + Math.random() * 6) * dpr, c: colours[Math.floor(Math.random() * colours.length)],
    };
  });
  let raf = 0;
  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    g.clearRect(0, 0, w, h);
    for (const b of bits) {
      b.vy += 0.32 * dpr;
      b.vx *= 0.99;
      b.x += b.vx;
      b.y += b.vy;
      b.r += b.vr;
      g.save();
      g.globalAlpha = Math.max(0, 1 - t / 2600);
      g.translate(b.x, b.y);
      g.rotate(b.r);
      g.fillStyle = b.c;
      g.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
      g.restore();
    }
    if (t < 2700) raf = requestAnimationFrame(frame);
    else g.clearRect(0, 0, w, h);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

type Phase = 'idle' | 'armed' | 'spinning';

export function SlotMachine({ folder, onClose, onPlay }: {
  folder: { id: number; name: string } | null;
  onClose: () => void;
  /** "Play them": a slideshow of these items. */
  onPlay: (items: Item[], title: string) => void;
}) {
  const [data, setData] = useState<SlotData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [strips, setStrips] = useState<number[][]>([[], [], []]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stopped, setStopped] = useState(3);
  const [result, setResult] = useState<SpinResult | null>(null);
  const [spins, setSpins] = useState(0);
  const [jackpots, setJackpots] = useState(0);
  const [muted, setMuted] = useState(true);
  const [pulled, setPulled] = useState(0);
  const confetti = useRef<HTMLCanvasElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.slotData(folder?.id ?? null).then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [folder?.id]);
  const pool = useMemo(() => data?.items.map((i) => i.id) ?? [], [data]);
  const groups = useMemo(() => (data ? usefulGroups(data.groups as SlotGroup[], pool) : []), [data, pool]);
  const byId = useMemo(() => new Map(data?.items.map((i) => [i.id, i]) ?? []), [data]);

  // Three pictures waiting before the first spin.
  useEffect(() => {
    if (!pool.length) return;
    const first = planSpin(pool, [], Math.random);
    setStrips(first.map((id) => [id, id]));
  }, [pool]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  };
  useEffect(() => clearTimers, []);

  const finish = useCallback((reels: number[]) => {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
    const r = evaluate(reels, groups);
    setResult(r);
    if (r.kind === 'jackpot') {
      setJackpots((n) => n + 1);
      if (!muted) [523, 659, 784, 1047].forEach((f, k) => tone(f, 260, 0.06, 'triangle', k * 110));
      if (confetti.current && !REDUCED) burst(confetti.current);
    } else if (r.kind === 'pair' && !muted) {
      tone(440, 160, 0.05);
      tone(392, 220, 0.05, 'triangle', 140);
    }
  }, [groups, muted]);

  const spin = useCallback(() => {
    if (phase !== 'idle' || !pool.length) return;
    clearTimers();
    const reels = planSpin(pool, groups, Math.random);
    setStrips((old) => reels.map((id, k) => {
      const from = old[k][old[k].length - 2] ?? id;
      // One picture after the result, so the little bounce past it shows a picture.
      return [from, ...reelStrip(pool, id, LENGTHS[k] - 1, Math.random), pool[Math.floor(Math.random() * pool.length)]];
    }));
    setResult(null);
    setStopped(0);
    setPhase('armed');
    setSpins((n) => n + 1);
    setPulled((n) => n + 1);
    if (!muted) {
      tone(180, 120, 0.06, 'square');
      ticker.current = setInterval(() => tone(900 + Math.random() * 200, 25, 0.015, 'square'), 70);
    }
    // Each reel sharpens and clunks as it comes to rest; the result once the last one has settled.
    DURATIONS.forEach((d, k) => {
      timers.current.push(setTimeout(() => {
        setStopped((n) => Math.max(n, k + 1));
        if (!muted) tone(220 - k * 30, 90, 0.07, 'sine');
      }, d * 0.78));
    });
    timers.current.push(setTimeout(() => {
      setPhase('idle');
      finish(reels);
    }, DURATIONS[2] + 80));
  }, [phase, pool, groups, muted, finish]);

  // Armed: the strips are at their start; on the next frame they run to the end.
  useEffect(() => {
    if (phase !== 'armed') return;
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('spinning')));
    return () => cancelAnimationFrame(r);
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === ' ' || e.key === 'Enter') {
        if ((e.target as HTMLElement).closest('button') && e.key === 'Enter') return;
        spin();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [spin, onClose]);

  const playGroup = (g: SlotGroup) => {
    const set = new Set(g.items);
    const list = (data?.items ?? []).filter((i) => set.has(i.id));
    onPlay(list, `${g.label} · ${folder?.name ?? 'Top level'}`);
  };

  const spinning = phase !== 'idle';
  const reel = (k: number) => {
    const strip = strips[k];
    const n = Math.max(strip.length, 1);
    const end = Math.max(0, n - 2);
    const at = phase === 'armed' ? 0 : end;
    const blur = phase === 'spinning' && stopped <= k;
    const hit = result?.kind === 'jackpot' || (result?.kind === 'pair' && result.reels.includes(k));
    return (
      <div key={k} className={`slot-window${hit ? ' hit' : ''}`}>
        <div className={`slot-strip${blur ? ' blur' : ''}`}
          style={{
            height: `${n * 100}%`,
            transform: `translateY(-${(at / n) * 100}%)`,
            transition: phase === 'armed' ? 'none' : `transform ${DURATIONS[k]}ms cubic-bezier(0.12, 0.72, 0.22, 1.06)`,
          }}>
          {strip.map((id, i) => (
            <div key={i} className="slot-cell" style={{ height: `${100 / n}%` }}>
              {byId.get(id) && <img src={thumbUrl(id)} alt={i === end ? byId.get(id)!.name : ''} draggable={false} />}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const empty = data && !pool.length;
  return (
    <div className="slots" role="dialog" aria-modal="true" aria-label="Slot machine">
      <canvas ref={confetti} className="slots-confetti" aria-hidden="true" />
      <div className="slots-top">
        <div className="slots-score mono">
          <span>Spins <b>{spins}</b></span>
          <span>Jackpots <b className="gold">{jackpots}</b></span>
          {groups.length > 0 && <span className="faint">{groups.length} {groups.length === 1 ? 'group' : 'groups'} in play</span>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-icon btn-sm glass" aria-pressed={!muted} aria-label={muted ? 'Sound on' : 'Sound off'}
            title={muted ? 'Sound is off — click for soft clicks' : 'Sound is on'} onClick={() => setMuted(!muted)}>
            {muted ? <MuteIcon size={15} /> : <SoundIcon size={15} />}
          </button>
          <button type="button" className="btn btn-icon btn-sm glass" aria-label="Close" title="Close (Esc)" onClick={onClose}><CloseIcon /></button>
        </div>
      </div>

      <div className="slots-stage">
        <div className={`slot-cabinet${result?.kind === 'jackpot' ? ' won' : ''}`}>
          <div className="slot-marquee">
            <span className="slot-lights" aria-hidden="true" />
            <b>{folder?.name ?? 'Top level'}</b>
            <span className="slot-lights" aria-hidden="true" />
          </div>
          {error ? <div className="error">{error}</div>
            : empty ? <p className="muted slot-empty">No pictures in here to spin. Import a few and come back.</p>
            : (
              <div className="slot-reels">
                {[0, 1, 2].map(reel)}
                <span className="slot-payline" aria-hidden="true" />
              </div>
            )}
          <div className="slot-message" role="status" aria-live="polite">
            {result?.kind === 'jackpot' ? (
              <div className="slot-jackpot">
                <div className="slot-jackpot-title">Jackpot!</div>
                <div className="slot-jackpot-what">
                  {result.group.kind === 'person' ? <FaceIcon size={16} /> : <TagIcon size={15} />} {result.group.label} × 3
                </div>
                <button type="button" className="btn btn-sm slot-play" onClick={() => playGroup(result.group)}>
                  <PlayIcon size={13} /> Play them <span className="faint">· {result.group.items.length}</span>
                </button>
              </div>
            ) : result?.kind === 'pair' ? (
              <span className="slot-close">So close! Two of <b>{result.group.label}</b></span>
            ) : result ? (
              <span className="faint">No match — spin again</span>
            ) : spinning ? (
              <span className="faint">Spinning…</span>
            ) : (
              <span className="faint">{groups.length ? 'Three of the same person or tag wins' : 'Tag pictures or add person folders for jackpots'}</span>
            )}
          </div>
          <button type="button" className="btn btn-primary slot-spin" disabled={spinning || !pool.length} onClick={spin}>
            {spinning ? 'Spinning…' : 'Spin'} <kbd>Space</kbd>
          </button>
        </div>
        <button type="button" key={pulled} className={`slot-lever${pulled ? ' pulled' : ''}`} aria-label="Pull the lever" title="Pull the lever (Space)"
          disabled={spinning || !pool.length} onClick={spin}>
          <span className="slot-lever-stick" />
          <span className="slot-lever-knob" />
          <span className="slot-lever-base" />
        </button>
      </div>
      <div className="slots-help faint">
        <kbd>Space</kbd> spin · <kbd>Esc</kbd> leave
      </div>
    </div>
  );
}
