// Beat-synced slideshows: listen to the computer's own sound (Windows) and
// move on with the music. Nothing is recorded; the app only hears beats.
//
//   const beat = useBeatSync({ enabled, everyBeats: 4, minSeconds: 2, onAdvance: next });
//   // when beat.silent is true, keep using the normal slideshow timer

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, inTauri, onEvent, type BeatEvent, type BeatLevelEvent, type BeatStatus } from './api';

/** No beat for this long counts as "no music". */
export const SILENT_AFTER_MS = 4000;

export interface BeatSyncOptions {
  enabled: boolean;
  /** Advance on every 1st, 2nd or 4th beat. */
  everyBeats: 1 | 2 | 4;
  /** Never advance sooner than this after the previous advance. */
  minSeconds: number;
  onAdvance: () => void;
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

  useEffect(() => {
    if (!opts.enabled) return;
    let alive = true;
    let acquired = false;
    let lastBeat = -Infinity;
    const offs: (() => void)[] = [];
    counter.current.reset(performance.now());

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
        if (counter.current.beat(now, o.everyBeats, o.minSeconds)) o.onAdvance();
      };
      const offBeat = await onEvent<BeatEvent>('beat', onBeat);
      if (!alive) return offBeat();
      offs.push(offBeat);
      const offLevel = await onEvent<BeatLevelEvent>('beat-level', (l) => alive && setLevel(l.level));
      if (!alive) return offLevel();
      offs.push(offLevel);
      const offStatus = await onEvent<BeatStatus>('beat-status', (st) => alive && setStatus(st));
      if (!alive) return offStatus();
      offs.push(offStatus);
      if (!inTauri) offs.push(previewBeats(onBeat, setLevel));
      acquired = true;
      await acquire();
      if (alive) {
        setListening(true);
        setError(null);
      }
      const st = await api.beatsStatus().catch(() => null);
      if (alive && st) setStatus((cur) => cur ?? st);
    })().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
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
  return { listening, silent: silent || !listening, bpm, level, markAdvanced, status, error, pulse };
}

/** Browser preview only (?beatdemo): pretend music at 120 BPM is playing. */
function previewBeats(onBeat: (b: BeatEvent) => void, setLevel: (l: number) => void): () => void {
  const start = performance.now();
  const beat = window.setInterval(() => onBeat({ t_ms: Math.round(performance.now() - start), strength: 0.8, bpm: 120 }), 500);
  const level = window.setInterval(() => setLevel(0.55 + 0.25 * Math.abs(Math.sin((performance.now() - start) / 300))), 100);
  return () => {
    window.clearInterval(beat);
    window.clearInterval(level);
  };
}

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
