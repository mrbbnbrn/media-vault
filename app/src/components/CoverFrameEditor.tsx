// "Adjust cover…": choose which part of a folder's cover shows on its card.
// Drag the picture, zoom with the mouse wheel or the slider. The preview is
// the real card shape (round for person folders) with the real cover, and a
// video or GIF cover plays in it. Nothing is changed until Save.

import { useEffect, useRef, useState } from 'react';
import { mediaUrl, thumbUrl, type FolderCard } from '../api';
import { clampPos, dragBy, fromPlacement, samePos, zoomAround, ZOOM_MAX, ZOOM_MIN, type CoverPos } from '../coverframe';
import { coverFit } from '../facealign';
import { Modal } from './Dialogs';
import { Framed } from './FramedCover';
import { RoundCover } from './RoundCover';
import { CoverVideo } from './VideoPreview';

const BOX = 280;
const CENTRED: CoverPos = { x: 0.5, y: 0.5, zoom: 1 };

export function CoverFrameEditor(props: { folder: FolderCard; onClose: () => void; onSave: (pos: CoverPos | null) => Promise<void> }) {
  const f = props.folder;
  const cover = f.cover!;
  const round = f.person;
  const doc = f.coverKind === 'pdf' || f.coverKind === 'text';
  const face = round && f.coverFace ? { x: f.coverFace[0], y: f.coverFace[1], w: f.coverFace[2], h: f.coverFace[3] } : null;
  const [pos, setPos] = useState<CoverPos | null>(f.coverPos ?? null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  // The picture's shape, from the thumbnail the cards already load (no extra decoding).
  useEffect(() => {
    const im = new Image();
    im.onload = () => {
      if (im.naturalWidth && im.naturalHeight) setAspect(im.naturalWidth / im.naturalHeight);
    };
    im.src = thumbUrl(cover);
  }, [cover]);

  // How the cover is framed now, also when it is automatic (where a drag or zoom starts from).
  const auto = (): CoverPos => {
    if (aspect && face) return fromPlacement(aspect, 1, coverFit(aspect, face, true));
    return doc ? { x: 0.5, y: 0, zoom: 1 } : CENTRED;
  };
  const now = (): CoverPos => pos ?? auto();
  const nowRef = useRef(now);
  nowRef.current = now;
  const a = aspect ?? 1;

  // Mouse wheel zooms around the mouse (a real listener, so the page doesn't scroll).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const p = nowRef.current();
      const z = p.zoom * Math.exp(-e.deltaY * 0.0015);
      setPos(zoomAround(p, z, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, a, 1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [a]);

  const drag = useRef<{ x: number; y: number; from: CoverPos; id: number } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, from: now(), id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPos(dragBy(d.from, (e.clientX - d.x) / r.width, (e.clientY - d.y) / r.height, a, 1));
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      setPos(dragBy(now(), m[0], m[1], a, 1));
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      const p = now();
      setPos(zoomAround(p, p.zoom * (e.key === '-' ? 1 / 1.1 : 1.1), 0.5, 0.5, a, 1));
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await props.onSave(pos ? clampPos(pos) : null);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const shown = now();
  const playKind = f.coverKind === 'video' || f.coverKind === 'gif' ? f.coverKind : null;
  return (
    <Modal title={`Adjust cover of “${f.name}”`} onClose={props.onClose}>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        Drag the picture to choose what shows on the card. Zoom with the mouse wheel or the slider.
        {round && ' Hovering the card still shows the other pictures of this person.'}
      </p>
      {err && <div className="error">{err}</div>}
      <div className="cfe-wrap">
        <div ref={stage} className={`cfe-stage${round ? ' round' : ''}`} style={{ width: BOX, height: BOX }} tabIndex={0}
          role="application" aria-label="Cover preview: drag to move the picture, arrow keys to nudge, plus and minus to zoom"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
          {round ? (
            <RoundCover folder={{ ...f, coverPos: pos }} size={BOX} play />
          ) : (
            <Framed pos={pos ?? (doc ? shown : null)} className="cfe-rect">
              <img src={thumbUrl(cover)} alt="" draggable={false} />
              {playKind === 'video' && <CoverVideo id={cover} />}
              {playKind === 'gif' && <img src={mediaUrl(cover)} alt="" draggable={false} />}
            </Framed>
          )}
        </div>
      </div>
      <label className="row cfe-zoom">
        <span className="faint" style={{ fontSize: 13 }}>Zoom</span>
        <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.01} value={shown.zoom} style={{ flex: 1 }}
          onChange={(e) => setPos(zoomAround(now(), Number(e.target.value), 0.5, 0.5, a, 1))} />
        <span className="faint" style={{ fontSize: 12, minWidth: 40, textAlign: 'right' }}>{Math.round(shown.zoom * 100)}%</span>
      </label>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          {/* Reset: the whole picture, centred. For a person that is a hand-set framing too. */}
          <button type="button" className="btn" disabled={round && face ? samePos(pos, CENTRED) : pos == null}
            onClick={() => setPos(round && face ? CENTRED : null)}>Reset</button>
          {round && face && (
            <button type="button" className="btn" disabled={pos == null} title="Forget the hand-set framing and centre on the face again"
              onClick={() => setPos(null)}>Centre on face</button>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || samePos(pos, f.coverPos)} onClick={save}>Save</button>
        </div>
      </div>
    </Modal>
  );
}
