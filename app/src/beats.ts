// Beat-synced slideshows: listen to the computer's own sound (Windows) and
// move on with the music. Nothing is recorded; the app only hears beats.
//
//   const beat = useBeatSync({ enabled, everyBeats: 4, minSeconds: 2, onAdvance: next });
//   // when beat.silent is true, keep using the normal slideshow timer

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onEvent, type BeatEvent, type BeatLevelEvent } from './api';

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
      const offBeat = await onEvent<BeatEvent>('beat', (b) => {
        const now = performance.now();
        lastBeat = now;
        setSilent(false);
        setBpm(b.bpm);
        const o = optsRef.current;
        if (counter.current.beat(now, o.everyBeats, o.minSeconds)) o.onAdvance();
      });
      if (!alive) return offBeat();
      offs.push(offBeat);
      const offLevel = await onEvent<BeatLevelEvent>('beat-level', (l) => setLevel(l.level));
      if (!alive) return offLevel();
      offs.push(offLevel);
      acquired = true;
      await acquire();
      if (alive) setListening(true);
    })().catch(() => {
      if (alive) setListening(false);
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
    };
  }, [opts.enabled]);

  const markAdvanced = useCallback(() => counter.current.reset(performance.now()), []);
  return { listening, silent: silent || !listening, bpm, level, markAdvanced };
}
