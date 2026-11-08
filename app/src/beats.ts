// Beat-synced slideshows: listen to the computer's own sound (Windows) and
// move on with the music. Nothing is recorded; the app only hears beats.
//
//   const beat = useBeatSync({ enabled, everyBeats: 4, minSeconds: 2, onAdvance: next });
//   // when beat.silent is true, keep using the normal slideshow timer

import { errText } from './text';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, inTauri, onEvent, type BeatEvent, type BeatLevelEvent, type BeatStatus } from './api';
import { DROP_MIN_GAP_MS, DropDetector, MontagePacer } from './beatdrop';

/** No beat for this long counts as "no music". */
export const SILENT_AFTER_MS = 4000;

export interface BeatSyncOptions {
  enabled: boolean;
  /** Advance on every 1st, 2nd or 4th beat. */
  everyBeats: 1 | 2 | 4;
  /** Never advance sooner than this after the previous advance. */
  minSeconds: number;
  onAdvance: () => void;
  /** "Montage": quick cuts on busy parts, long holds on calm ones (everyBeats is then ignored). */
  montage?: boolean;
  /** "Beat drop": on a big hit, call onDrop (instead of onAdvance) at once, whatever the count. */
  drop?: boolean;
  onDrop?: () => void;
  /** Every beat heard (strength, tempo), when it came and whether it was a big hit. */
  onBeat?: (b: BeatEvent, now: number, isDrop: boolean) => void;
}

export interface BeatSync {
  /** The app is listening to the computer's sound. */
  listening: boolean;
  /** No beat for 4 s (or not listening): use the normal timing instead. */
  silent: boolean;
  /** Tempo estimate, once there is a steady one. */
  bpm: number | null;
  /** Loudness 0..1 for a small meter. */
  level: number;
  /** Call after advancing some other way (arrow key, fallback timer) so the
   *  beat count and the minimum wait start over from now. */
  markAdvanced: () => void;
  /** What the listener reports (device, errors, recent log), for the status line. */
  status: BeatStatus | null;
  /** Listening couldn't even start. */
  error: string | null;
  /** Counts beats heard, so a dot can flash on each. */
  pulse: number;
  /** Beats per item right now (everyBeats, or what Montage picked). */
  every: number;
}

/** The counting rule on its own (no timers, no events), so it can be tested. */
export class BeatCounter {
  private count = 0;
  private lastAdvance: number;

  constructor(now: number) {
    this.lastAdvance = now;
  }

  /** A beat arrived at `now` (ms). True when the slideshow should advance. */
  beat(now: number, everyBeats: number, minSeconds: number): boolean {
    this.count += 1;
    if (this.count % Math.max(1, everyBeats) !== 0) return false;
    if (now - this.lastAdvance < minSeconds * 1000) return false;
    this.reset(now);
    return true;
  }

  /** Ms since the slideshow last moved on. */
  since(now: number): number {
    return now - this.lastAdvance;
  }

  reset(now: number): void {
    this.count = 0;
    this.lastAdvance = now;
  }
}

// Several components may listen at once; the backend listens while anyone does.
let users = 0;
function acquire(): Promise<void> {
  users += 1;
  return users === 1 ? api.beatsStart() : Promise.resolve();
}
function release(): void {
  users = Math.max(0, users - 1);
  if (users === 0) api.beatsStop().catch(() => {});
}

export function useBeatSync(opts: BeatSyncOptions): BeatSync {
  const [listening, setListening] = useState(false);
  const [silent, setSilent] = useState(true);
  const [bpm, setBpm] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState<BeatStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulse, setPulse] = useState(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const counter = useRef(new BeatCounter(performance.now()));
  const [every, setEvery] = useState<number>(opts.everyBeats);

  useEffect(() => {
    if (!opts.enabled) return;
    let alive = true;
    let acquired = false;
    let lastBeat = -Infinity;
    const offs: (() => void)[] = [];
    counter.current.reset(performance.now());
    const drops = new DropDetector();
    const pacer = new MontagePacer();
    const onLevel = (level: number) => {
      const now = performance.now();
      drops.level(now, level);
      pacer.levelAt(now, level);
      setLevel(level);
    };

    const tick = window.setInterval(() => {
      setSilent(performance.now() - lastBeat > SILENT_AFTER_MS);
    }, 250);

    (async () => {
      if (!(await api.beatsSupported())) return;
      const onBeat = (b: BeatEvent) => {
        if (!alive) return;
        const now = performance.now();
        lastBeat = now;
        setSilent(false);
        setBpm(b.bpm);
        setPulse((p) => p + 1);
        const o = optsRef.current;
        const isDrop = drops.beat(now, b.strength);
        const picked = pacer.beat(now, b.strength);
        const n = o.montage ? picked : o.everyBeats;
        setEvery(n);
        o.onBeat?.(b, now, isDrop);
        // A drop moves on at once (ignoring the count, not a tiny minimum gap).
        if (o.drop && isDrop && counter.current.since(now) >= DROP_MIN_GAP_MS) {
          counter.current.reset(now);
          (o.onDrop ?? o.onAdvance)();
          return;
        }
        if (counter.current.beat(now, n, o.minSeconds)) o.onAdvance();
      };
      const offBeat = await onEvent<BeatEvent>('beat', onBeat);
      if (!alive) return offBeat();
      offs.push(offBeat);
      const offLevel = await onEvent<BeatLevelEvent>('beat-level', (l) => alive && onLevel(l.level));
      if (!alive) return offLevel();
      offs.push(offLevel);
      const offStatus = await onEvent<BeatStatus>('beat-status', (st) => alive && setStatus(st));
      if (!alive) return offStatus();
      offs.push(offStatus);
      if (!inTauri) offs.push(previewBeats(onBeat, onLevel));
      acquired = true;
      await acquire();
      if (alive) {
        setListening(true);
        setError(null);
      }
      const st = await api.beatsStatus().catch(() => null);
      if (alive && st) setStatus((cur) => cur ?? st);
    })().catch((e) => {
      const msg = errText(e);
      console.error('Beat sync could not start:', msg);
      if (alive) {
        setListening(false);
        setError(msg);
      }
    });

    return () => {
      alive = false;
      window.clearInterval(tick);
      offs.forEach((off) => off());
      if (acquired) release();
      setListening(false);
      setSilent(true);
      setBpm(null);
      setLevel(0);
      setStatus(null);
    };
  }, [opts.enabled]);

  const markAdvanced = useCallback(() => counter.current.reset(performance.now()), []);
  return { listening, silent: silent || !listening, bpm, level, markAdvanced, status, error, pulse, every: opts.montage ? every : opts.everyBeats };
}

/** Browser preview only (?beatdemo): pretend music at 120 BPM is playing, in a
 *  32-beat loop: 12 calm beats, a build-up, then a drop into 12 loud beats.
 *  `window.__fakeBeat(strength, level)` sends one beat by hand (tests). */
function previewBeats(onBeat: (b: BeatEvent) => void, setLevel: (l: number) => void): () => void {
  const start = performance.now();
  let n = 0;
  const phase = () => n % 32;
  const loud = () => phase() >= 20 || phase() === 0;
  const beat = window.setInterval(() => {
    n += 1;
    const p = phase();
    const strength = p === 20 ? 1 : loud() ? 0.8 : p >= 12 ? 0.55 : 0.4;
    onBeat({ t_ms: Math.round(performance.now() - start), strength, bpm: 120 });
  }, 500);
  const level = window.setInterval(() => {
    const p = phase();
    const base = loud() ? 0.75 : p >= 12 ? 0.3 + (p - 12) * 0.03 : 0.2;
    setLevel(Math.min(1, base + 0.15 * Math.abs(Math.sin((performance.now() - start) / 300))));
  }, 100);
  const fake = (strength: number, lvl?: number) => {
    if (lvl != null) setLevel(lvl);
    onBeat({ t_ms: Math.round(performance.now() - start), strength, bpm: 120 });
  };
  fakeListeners.add(fake);
  (window as unknown as { __fakeBeat?: (strength: number, level?: number) => void }).__fakeBeat = (strength, lvl) =>
    fakeListeners.forEach((f) => f(strength, lvl));
  return () => {
    window.clearInterval(beat);
    window.clearInterval(level);
    fakeListeners.delete(fake);
  };
}
const fakeListeners = new Set<(strength: number, level?: number) => void>();

/** One short line about the listener for the Timing panel: what it hears
 *  or why it can't. */
export function beatStatusText(b: Pick<BeatSync, 'status' | 'error' | 'listening'>): { text: string; problem: boolean } {
  if (b.error) return { text: `Couldn't start listening: ${b.error}`, problem: true };
  const st = b.status;
  if (!st || st.state === 'starting' || (!b.listening && st.state !== 'error')) return { text: 'Starting to listen…', problem: false };
  if (st.state === 'error') return { text: st.error ?? "Couldn't open the sound output.", problem: true };
  if (st.state === 'off') return { text: 'Not listening', problem: false };
  const name = st.device ?? 'the sound output';
  if (st.muted) return { text: `Listening to: ${name} · it's muted in Windows, so beats may not be heard`, problem: false };
  if (!st.receiving) return { text: `Listening to: ${name} · nothing is playing on it`, problem: false };
  return { text: `Listening to: ${name}`, problem: false };
}
