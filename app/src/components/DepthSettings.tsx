// 3D photos settings, opened from the viewer's View ▾ menu: whether still
// pictures move gently in depth on their own (in slideshows and while just
// open), along which shape, how far and how fast, plus the depth strength
// and the mouse reaction that the 3D button uses too.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ViewerSettings } from '../api';
import { depthPack, MOTION_LABELS, MOTION_SHAPES, motionChoice, NO_DEPTH_PACK, shapeOutline, type MotionChoice } from '../depth';
import { saveViewerPrefs } from '../prefs';
import { Modal } from './Dialogs';

const CHOICES: MotionChoice[] = ['random', ...MOTION_SHAPES];

/** A tiny drawing of the shape, so the choice is easy to see. */
function ShapeIcon({ shape }: { shape: MotionChoice }) {
  const W = 34;
  const H = 22;
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  if (shape === 'random') {
    // Dice: a different shape for each picture.
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <rect x={10} y={4} width={14} height={14} rx={3} {...line} />
        {[[14, 8], [20, 14], [17, 11]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r={1.3} fill="currentColor" />)}
      </svg>
    );
  }
  if (shape === 'zoom') {
    // Nearer and back: a frame growing out of a smaller one.
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <rect x={13} y={8} width={8} height={6} rx={1} {...line} />
        <rect x={6} y={3} width={22} height={16} rx={2} {...line} opacity={0.55} />
      </svg>
    );
  }
  const pts = shapeOutline(shape, W, H);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <path d={d} {...line} />
      {/* Where it starts and ends: the still picture. */}
      <circle cx={pts[0].x} cy={pts[0].y} r={2} fill="currentColor" />
    </svg>
  );
}

function Slider(props: { id: string; label: string; title?: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <>
      <label htmlFor={props.id}>{props.label}</label>
      <span className="row" style={{ gap: 8 }} title={props.title}>
        <input id={props.id} type="range" min={props.min} max={props.max} step={props.step} value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))} style={{ flex: 1 }} />
        <span className="faint" style={{ minWidth: 40, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{Math.round(props.value * 100)}%</span>
      </span>
    </>
  );
}

export function DepthSettingsDialog({ prefs, onClose }: { prefs: ViewerSettings; onClose: () => void }) {
  const on = !!prefs.depthAuto;
  const shape = motionChoice(prefs.depthShape);
  // Whether the depth pack is there (asked anew each time the window opens).
  const [packOk, setPackOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    depthPack(true).then((i) => alive && setPackOk(i ? i.available : null));
    return () => {
      alive = false;
    };
  }, []);
  // Drawn over the whole window: inside the viewer's top bar it would fade away with the controls.
  return createPortal(
    <Modal title="3D photos" onClose={onClose}>
      <div className="form-grid">
        <span />
        <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={on} onChange={(e) => saveViewerPrefs({ depthAuto: e.target.checked })} /> 3D photos (gentle depth motion)
          </label>
          <span className="faint" style={{ fontSize: 12 }}>
            {packOk === false ? NO_DEPTH_PACK
              : 'Still pictures move gently in depth, the near things against the far ones: over and over while a picture is open, and fitted to each picture\'s time in slideshows. The 3D button (picture follows the mouse) takes over while it is on. Pictures without a depth map show as usual.'}
          </span>
        </span>

        <span>Motion shape</span>
        <div role="radiogroup" aria-label="Motion shape" className="shape-pick">
          {CHOICES.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={shape === c} className={shape === c ? 'on' : ''}
              title={c === 'random' ? 'Each picture picks one of the shapes' : c === 'pendulum' ? 'Swings along an arc, slowing at each end' : c === 'spiral' ? 'Round and round while coming closer' : MOTION_LABELS[c]}
              onClick={() => saveViewerPrefs({ depthShape: c })}>
              <ShapeIcon shape={c} />
              <span>{MOTION_LABELS[c]}</span>
            </button>
          ))}
        </div>

        <Slider id="dp-motion" label="Motion amount" title="How far the pictures move" min={0.3} max={4} step={0.1}
          value={prefs.depthMotion ?? 1} onChange={(v) => saveViewerPrefs({ depthMotion: v })} />
        <Slider id="dp-speed" label="Motion speed" title="How fast they move. In slideshows a faster speed means more loops within each picture's time; each picture still starts and ends still."
          min={0.25} max={4} step={0.05} value={prefs.depthSpeed ?? 1} onChange={(v) => saveViewerPrefs({ depthSpeed: v })} />
        {/* For the automatic movement and the 3D button alike. */}
        <Slider id="dp-depth" label="3D depth" title="How strongly near things move against far ones" min={0.3} max={3} step={0.1}
          value={prefs.depthAmount ?? 1} onChange={(v) => saveViewerPrefs({ depthAmount: v })} />
        <Slider id="dp-react" label="3D mouse reaction" title="With the 3D button on: how far you move the mouse for the picture to lean all the way (higher = less mouse movement needed)"
          min={0.3} max={3} step={0.1} value={prefs.depthReact ?? 1} onChange={(v) => saveViewerPrefs({ depthReact: v })} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>,
    document.body,
  );
}
