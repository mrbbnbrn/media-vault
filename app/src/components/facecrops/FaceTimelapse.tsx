// Face time-lapse: every face of a person, oldest first, lined up by the
// eyes and played fast. "Cut" switches faces instantly (no fading); "Morph"
// bends one face into the next along the five face points while blending.
// Faces are measured (for their points) and lined up a little ahead of
// where you are; the playback simply waits when it catches up.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type PersonFace } from '../../api';
import { bigEnough, lapseAt, lapseLength, slotMs, type LapseTiming } from '../../facecrops';
import { saveViewerPrefs, useViewerPrefs } from '../../prefs';
import { recordLapse } from './lapsevideo';
import { AlignedCache, drawLapse, FRAME, measureFaces, measureOf } from './render';
import { MinFaceSlider, PicturesOnly } from './MinFace';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const longDate = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

export default function FaceTimelapse(props: {
  person: number;
  name: string;
  /** The viewer is open over it: the keyboard belongs to the viewer and playback pauses. */
  covered: boolean;
  onClose: () => void;
  onOpenPhoto: (mediaId: number) => void;
  onSaved: () => void;
}) {
  const prefs = useViewerPrefs();
  const timing: LapseTiming = { fps: prefs.timelapseFps ?? 8, morph: !!prefs.timelapseMorph, morphShare: prefs.timelapseMorphShare ?? 0.5 };
  const [all, setAll] = useState<PersonFace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [min, setMin] = useState(prefs.timelapseMin ?? 120);
  const faces = useMemo(() => bigEnough(all ?? [], min), [all, min]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [pack, setPack] = useState(true);
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const cache = useMemo(() => new AlignedCache(40), []);
  const clock = useRef(0);
  const live = useRef({ faces, timing, playing, pack, covered: props.covered });
  live.current = { faces, timing, playing, pack, covered: props.covered };
  const failed = useRef(new Set<number>());
  const stopSave = useRef(false);

  useEffect(() => {
    let alive = true;
    api.faceCropsList(props.person).then((l) => alive && setAll(l)).catch((e) => alive && setError(String(e instanceof Error ? e.message : e)));
    // Without the faces pack there are no face points: faces are lined up by their boxes.
    api.facesEngine().then((e) => alive && setPack(!!e.native?.available)).catch(() => {});
    return () => {
      alive = false;
      cache.clear();
    };
  }, [props.person]); // eslint-disable-line react-hooks/exhaustive-deps

  // A different "smallest face": stay on the same face if it is still in.
  const lastFace = useRef<number | null>(null);
  useEffect(() => {
    const at = lastFace.current != null ? faces.findIndex((f) => f.id === lastFace.current) : -1;
    const i = at >= 0 ? at : Math.min(index, Math.max(0, faces.length - 1));
    clock.current = i * slotMs(timing.fps);
    setIndex(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faces]);
  // A different speed: stay on the same face.
  useEffect(() => {
    clock.current = index * slotMs(timing.fps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timing.fps]);

  // Get faces ready a little ahead: measure them (their points), then line them up.
  const at = useRef(0);
  at.current = index;
  useEffect(() => {
    let alive = true;
    (async () => {
      while (alive) {
        const { faces: list, timing: t, pack: withPoints } = live.current;
        const ahead = Math.round(Math.min(30, Math.max(6, t.fps * 2)));
        const next = list.slice(at.current, at.current + ahead).filter((f) => !failed.current.has(f.id));
        if (withPoints) {
          const need = next.filter((f) => !measureOf(f.id)).slice(0, 8);
          if (need.length) {
            await measureFaces(need.map((f) => f.id), { chunk: 8, stopped: () => !alive }).catch(() => {
              // Measuring failed (the vault locked?): line them up by their boxes.
              live.current.pack = false;
              setPack(false);
            });
            continue;
          }
        }
        const missing = next.filter((f) => !cache.has(f.id)).slice(0, 3);
        if (missing.length) {
          const got = await Promise.all(missing.map((f) => cache.load(f)));
          got.forEach((g, k) => {
            if (!g) failed.current.add(missing[k].id);
          });
          continue;
        }
        await sleep(100);
      }
    })();
    return () => {
      alive = false;
    };
  }, [cache]);

  // Playing: the clock moves on only when the next picture is ready.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let drawn = '';
    const ready = (ms: number) => {
      const { faces: list, timing: t } = live.current;
      const { index: i, mix } = lapseAt(ms, list.length, t);
      const a = list[i] && cache.get(list[i].id);
      const b = mix > 0 && list[i + 1] ? cache.get(list[i + 1].id) : null;
      return { i, mix, a, b, ok: !!a && (mix === 0 || !!b || failed.current.has(list[i + 1]?.id)) };
    };
    const tick = (now: number) => {
      const dt = Math.min(250, now - last);
      last = now;
      const { faces: list, timing: t, playing: on, covered } = live.current;
      const n = list.length;
      if (n) {
        // Faces whose picture couldn't be shown are jumped over.
        let cur = lapseAt(clock.current, n, t);
        while (failed.current.has(list[cur.index]?.id) && cur.index < n - 1) {
          clock.current = (cur.index + 1) * slotMs(t.fps);
          cur = lapseAt(clock.current, n, t);
        }
        if (on && !covered) {
          const end = lapseLength(n, t.fps);
          const want = clock.current + dt;
          if (want >= end) {
            clock.current = (n - 1) * slotMs(t.fps);
            setPlaying(false);
          } else if (ready(want).ok) {
            clock.current = want;
            setWaiting(false);
          } else setWaiting(true);
        } else setWaiting(false);
        const r = ready(clock.current);
        lastFace.current = list[r.i]?.id ?? null;
        setIndex(r.i);
        const key = `${r.a?.id}:${r.b?.id ?? ''}:${r.mix.toFixed(3)}`;
        const ctx = canvas.current?.getContext('2d');
        if (ctx && r.a && key !== drawn) {
          drawLapse(ctx, r.a, r.b ?? null, r.b ? r.mix : 0);
          drawn = key;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cache]);

  const goTo = (i: number) => {
    const n = live.current.faces.length;
    const k = Math.max(0, Math.min(n - 1, i));
    clock.current = k * slotMs(timing.fps);
    setIndex(k);
  };
  const toggle = () => {
    const n = faces.length;
    if (!playing && index >= n - 1) goTo(0);
    setPlaying(!playing);
  };

  // Keys (not while the viewer is open over it, or while saving).
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (props.covered) return;
    if ((e.target as HTMLElement | null)?.closest?.('input[type=text], textarea')) return;
    if (e.key === 'Escape') {
      if (saving) stopSave.current = true;
      else props.onClose();
    } else if (saving) return;
    else if (e.key === ' ') toggle();
    else if (e.key === 'ArrowLeft') {
      setPlaying(false);
      goTo(index - 1);
    } else if (e.key === 'ArrowRight') {
      setPlaying(false);
      goTo(index + 1);
    } else {
      // Other keys stay with the time-lapse (its own buttons and sliders still
      // get them): nothing reaches the library underneath, e.g. Enter opening a tile.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, []);

  const saveVideo = async () => {
    if (!faces.length || saving) return;
    setPlaying(false);
    stopSave.current = false;
    setSaving({ done: 0, total: 1 });
    setNote(null);
    // Its own small cache, so the one on screen keeps its faces.
    const rec = new AlignedCache(12);
    try {
      const bytes = await recordLapse(faces, timing, rec, async (f) => {
        if (pack && !measureOf(f.id)) await measureFaces([f.id]).catch(() => {});
        await rec.load(f);
      }, { progress: (done, total) => setSaving({ done, total }), stopped: () => stopSave.current });
      const name = `${props.name} face time-lapse.webm`;
      await api.addFileBytes(props.person, name, bytes);
      setNote(`Saved “${name}” in ${props.name}.`);
      props.onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNote(stopSave.current ? 'Stopped. Nothing was saved.' : `Couldn't save the video: ${msg}`);
    } finally {
      rec.clear();
      setSaving(null);
    }
  };

  const save = (patch: Parameters<typeof saveViewerPrefs>[0]) => { saveViewerPrefs(patch).catch(() => {}); };
  const n = faces.length;
  const cur = faces[index];

  return (
    <div className="fc-backdrop fc-lapse" role="dialog" aria-modal="true" aria-label={`${props.name}: face time-lapse`}>
      <div className="fc-lapse-top">
        <div className="fc-title">
          <b>{props.name}</b> · face time-lapse
          <PicturesOnly />
        </div>
        <button type="button" className="btn btn-sm" onClick={saveVideo} disabled={!n || !!saving} title="Record the time-lapse (same settings) and keep it in the person's folder">
          Save as video
        </button>
        <button type="button" className="btn btn-icon btn-sm" aria-label="Close (Esc)" title="Close (Esc)" onClick={props.onClose}>✕</button>
      </div>

      <div className="fc-stage">
        {error ? <p className="fc-msg">{error}</p>
          : all == null ? <p className="fc-msg">Finding faces…</p>
          : !n ? <p className="fc-msg">{all.length ? 'No faces are this big. Lower “Smallest face” below.' : `No named faces of ${props.name} in pictures yet.`}</p>
          : (
            <button type="button" className="fc-frame" title="Open this photo" onClick={() => cur && (setPlaying(false), props.onOpenPhoto(cur.mediaId))}>
              <canvas ref={canvas} width={FRAME} height={FRAME} />
              {waiting && <span className="fc-wait">Getting faces ready…</span>}
            </button>
          )}
      </div>

      {n > 0 && (
        <div className="fc-scrub">
          <button type="button" className="btn btn-sm fc-play" onClick={toggle} aria-label={playing ? 'Pause (Space)' : 'Play (Space)'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <input type="range" min={0} max={Math.max(0, n - 1)} step={1} value={index} aria-label="Where in the time-lapse"
            onChange={(e) => { setPlaying(false); goTo(Number(e.target.value)); }} />
          <span className="fc-date">{cur ? longDate(cur.date) : ''}</span>
          <span className="faint fc-num">{index + 1} / {n.toLocaleString('en-GB')}</span>
        </div>
      )}

      <div className="fc-settings">
        <label className="fc-set">
          <span>Speed · {timing.fps} {timing.fps === 1 ? 'face' : 'faces'} a second</span>
          <input type="range" min={1} max={30} step={1} value={timing.fps} onChange={(e) => save({ timelapseFps: Number(e.target.value) })} />
        </label>
        <div className="fc-set">
          <span>Change</span>
          <div role="group" aria-label="How faces change" className="seg">
            <button type="button" className={!timing.morph ? 'on' : ''} title="Switch instantly, no fading" onClick={() => save({ timelapseMorph: false })}>Cut</button>
            <button type="button" className={timing.morph ? 'on' : ''} title="Bend each face into the next one" onClick={() => save({ timelapseMorph: true })}>Morph</button>
          </div>
        </div>
        {timing.morph && (
          <label className="fc-set">
            <span>Morph · {Math.round(timing.morphShare * 100)}% of each face's time</span>
            <input type="range" min={0.1} max={0.9} step={0.05} value={timing.morphShare} onChange={(e) => save({ timelapseMorphShare: Number(e.target.value) })} />
          </label>
        )}
        <MinFaceSlider faces={all ?? []} value={min} onChange={setMin} onCommit={(v) => save({ timelapseMin: v })} />
        {!pack && <span className="faint fc-hint">Without the faces pack, faces are lined up by their boxes (less exact).</span>}
      </div>

      {saving && (
        <div className="fc-saving" role="status">
          <span>Making the video… {Math.round((saving.done / Math.max(1, saving.total)) * 100)}%</span>
          <progress max={saving.total} value={saving.done} />
          <button type="button" className="btn btn-sm" onClick={() => { stopSave.current = true; }}>Stop</button>
        </div>
      )}
      {note && !saving && (
        <div className="fc-note" role="status">
          <span>{note}</span>
          <button type="button" className="link" onClick={() => setNote(null)}>OK</button>
        </div>
      )}
    </div>
  );
}
