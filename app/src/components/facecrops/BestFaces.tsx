// Best faces: a person's biggest, sharpest faces that look most straight at
// the camera. Faces are measured on demand (the original picture is decoded
// in memory, looked at and forgotten) and remembered for this session, so
// opening it again, or changing the slider, is quick. Each result can become
// the person's cover, and opens its photo on click.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FaceMeasure, type PersonFace } from '../../api';
import { bigEnough } from '../../facecrops';
import { saveViewerPrefs, useViewerPrefs } from '../../prefs';
import { FaceTile } from './FaceTile';
import { MinFaceSlider, PicturesOnly } from './MinFace';
import { measureFaces, measureOf } from './render';
import { useLayer } from '../../keylayers';

/** Only this many of the biggest faces are measured: size counts, so tiny ones rarely win and measuring takes time. */
export const MEASURE_AT_MOST = 400;
const COUNTS = [12, 24, 48, 96];

export default function BestFaces(props: {
  person: number;
  name: string;
  covered: boolean;
  onClose: () => void;
  onOpenPhoto: (mediaId: number) => void;
  onChanged: () => void;
}) {
  const prefs = useViewerPrefs();
  const count = prefs.bestFacesCount ?? 24;
  const [all, setAll] = useState<PersonFace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [min, setMin] = useState(prefs.bestFacesMin ?? 80);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [tick, setTick] = useState(0);
  const [cover, setCover] = useState<number | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    let alive = true;
    api.faceCropsList(props.person).then((l) => alive && setAll(l)).catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      stopped.current = true;
    };
  }, [props.person]);

  // The candidates: big enough, the biggest first.
  const pool = useMemo(() => [...bigEnough(all ?? [], min)].sort((a, b) => b.facePx - a.facePx).slice(0, MEASURE_AT_MOST), [all, min]);
  const eligible = useMemo(() => bigEnough(all ?? [], min).length, [all, min]);

  // Measure what isn't measured yet.
  useEffect(() => {
    if (!pool.length) return;
    const need = pool.filter((f) => !measureOf(f.id)).map((f) => f.id);
    if (!need.length) return;
    let alive = true;
    stopped.current = false;
    measureFaces(need, { stopped: () => !alive || stopped.current, progress: (done, total) => alive && setProgress({ done, total }) })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (alive) {
          setProgress(null);
          setTick((t) => t + 1);
        }
      });
    return () => {
      alive = false;
    };
  }, [pool]);

  const best = useMemo(() => {
    const scored: { face: PersonFace; m: FaceMeasure }[] = [];
    for (const f of pool) {
      const m = measureOf(f.id);
      if (m && !m.failed) scored.push({ face: f, m });
    }
    scored.sort((a, b) => b.m.score - a.m.score);
    return scored.slice(0, count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, count, tick, progress == null]);

  // A layer (keylayers.ts): the library underneath gets no keys; back closes it.
  const layer = useLayer(true, { name: 'best faces', onBack: () => props.onClose() });
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (props.covered || !layer.mine() || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [props.covered, props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const setAsCover = async (media: number) => {
    try {
      await api.setCover(props.person, media);
      setCover(media);
      props.onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const pct = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
  const sharpPart = (s: number) => s / (s + 120);

  return (
    <div className="modal-back fc-best-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal wide fc-best" role="dialog" aria-modal="true" aria-label={`${props.name}: best faces`}>
        <div className="fc-best-head">
          <h2>Best faces of {props.name}</h2>
          <PicturesOnly />
          <button type="button" className="btn btn-icon btn-sm" style={{ marginLeft: 'auto' }} aria-label="Close (Esc)" onClick={props.onClose}>✕</button>
        </div>
        <p className="faint fc-best-intro">The biggest, sharpest faces that look most straight at the camera.</p>
        <div className="fc-best-controls">
          <MinFaceSlider faces={all ?? []} value={min} onChange={setMin} onCommit={(v) => { saveViewerPrefs({ bestFacesMin: v }).catch(() => {}); }} />
          <div className="fc-set">
            <span>Show</span>
            <div role="group" aria-label="How many to show" className="seg">
              {COUNTS.map((c) => (
                <button key={c} type="button" className={c === count ? 'on' : ''} onClick={() => { saveViewerPrefs({ bestFacesCount: c }).catch(() => {}); }}>{c}</button>
              ))}
            </div>
          </div>
        </div>
        {progress && (
          <div className="fc-progress" role="status">
            <span>Looking at faces… {progress.done.toLocaleString('en-GB')} of {progress.total.toLocaleString('en-GB')}</span>
            <progress max={progress.total} value={progress.done} />
            <button type="button" className="btn btn-sm" onClick={() => { stopped.current = true; }}>Stop</button>
          </div>
        )}
        {eligible > MEASURE_AT_MOST && (
          <p className="faint fc-hint">Looking at the {MEASURE_AT_MOST} biggest of {eligible.toLocaleString('en-GB')} faces.</p>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="fc-best-grid">
          {all == null ? <p className="faint">Finding faces…</p>
            : !all.length ? <p className="faint">No named faces of {props.name} in pictures yet.</p>
            : !pool.length ? <p className="faint">No faces are this big. Lower “Smallest face”.</p>
            : !best.length && progress ? null
            : best.map(({ face, m }, k) => (
              <div key={face.id} className="fc-best-item">
                <FaceTile face={face} size={150} title="Open the photo" onOpen={() => props.onOpenPhoto(face.mediaId)}>
                  <span className="fc-rank">{k + 1}</span>
                </FaceTile>
                <div className="fc-best-meta faint">
                  {Math.round(face.facePx)} px · sharp {pct(sharpPart(m.sharp))}{m.front != null ? ` · straight ${pct(m.front)}` : ''}
                </div>
                <button type="button" className={`btn btn-sm${cover === face.mediaId ? ' accent-soft' : ''}`} onClick={() => setAsCover(face.mediaId)}>
                  {cover === face.mediaId ? 'Cover ✓' : 'Use as cover'}
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
