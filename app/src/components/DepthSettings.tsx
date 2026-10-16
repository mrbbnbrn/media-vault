// 3D photos settings, opened from the viewer's View ▾ menu: whether still
// pictures move gently in depth on their own (in slideshows and while just
// open), along which shape, how far and how fast, plus the depth strength
// and the mouse reaction that the 3D button uses too, and which depth model
// (and how much detail) works out the depth.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ViewerSettings } from '../api';
import { autoSoft, depthPack, depthSetup, edgesSetting, MOTION_LABELS, MOTION_SHAPES, motionChoice, NO_DEPTH_PACK, shapeOutline, type MotionChoice } from '../depth';
import { saveViewerPrefs } from '../prefs';
import { DepthModelChoice } from './DepthModels';
import { SubjectModelChoice } from './SubjectModels';
import { NO_SUBJECT_PACK, subjectPack } from '../subject';
import { Modal } from './Dialogs';
import { InpaintModelChoice } from './InpaintModels';
import { edgesStrength, lightAngle, lightStrength, lightWords } from '../layers';

const CHOICES: MotionChoice[] = ['random', ...MOTION_SHAPES];

/** A tiny drawing of the shape, so the choice is easy to see. */
function ShapeIcon({ shape }: { shape: MotionChoice }) {
  const W = 34;
  const H = 22;
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
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
      <path d={d} {...line} strokeWidth={shape === 'random' || shape === 'spiral' ? 1.1 : 1.6} />
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

/** Edges: how much the depth map is softened (sharper shows a good model's detail; softer stretches more smoothly). */
function EdgesSlider({ prefs }: { prefs: ViewerSettings }) {
  const set = edgesSetting(prefs.depthEdges);
  const auto = autoSoft(depthSetup()?.model ?? (prefs.depthModel || 'da3-mono-large'));
  const v = set ?? auto;
  return (
    <>
      <label htmlFor="dp-edges">Edges</label>
      <span className="row" style={{ gap: 8 }} title="Sharp: a good depth model's edges show (people and objects stand out more cleanly, the background stretches a little more at their edges). Soft: smoother stretching, less detail. Automatic: sharper for Best, as designed for Fast. Changing it works the depth out again.">
        <span className="faint" style={{ fontSize: 12 }}>Sharp</span>
        <input id="dp-edges" type="range" min={0.25} max={2} step={0.05} value={v} style={{ flex: 1 }}
          onChange={(e) => saveViewerPrefs({ depthEdges: Number(e.target.value) })} />
        <span className="faint" style={{ fontSize: 12 }}>Soft</span>
        {set == null ? <span className="faint" style={{ minWidth: 64, fontSize: 12 }}>Automatic</span>
          : <button type="button" className="btn btn-sm" style={{ minWidth: 64 }} onClick={() => saveViewerPrefs({ depthEdges: 0 })}>Automatic</button>}
      </span>
    </>
  );
}

export function DepthSettingsDialog({ prefs, onClose }: { prefs: ViewerSettings; onClose: () => void }) {
  const on = !!prefs.depthAuto;
  const shape = motionChoice(prefs.depthShape);
  // Whether the depth pack is there (asked anew each time the window opens).
  const [packOk, setPackOk] = useState<boolean | null>(null);
  const [subjectOk, setSubjectOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    depthPack(true).then((i) => alive && setPackOk(i ? i.available : null));
    subjectPack(true).then((i) => alive && setSubjectOk(i ? i.available : null));
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
              : 'Still pictures move gently in depth, the near things against the far ones. The movement never stops and carries on from one picture to the next (in slideshows and when you go to the next picture), like moving the mouse yourself. The 3D button (picture follows the mouse) takes over while it is on. Pictures without a depth map yet show as usual until it is ready.'}
          </span>
        </span>

        <span>Motion shape</span>
        <div role="radiogroup" aria-label="Motion shape" className="shape-pick">
          {CHOICES.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={shape === c} className={shape === c ? 'on' : ''}
              title={c === 'random' ? 'Wanders about smoothly, like moving the mouse at random' : c === 'pendulum' ? 'Swings along an arc'
                : c === 'spiral' ? 'Round and round, the circle slowly widening (coming closer) and narrowing' : c === 'zoom' ? 'Towards the picture and back, resting at the still picture in between'
                : c === 'drift' ? 'In and out without ever stopping, with a slow sway' : c === 'circle' ? 'Round and round at an even pace (speed: Motion speed)' : MOTION_LABELS[c]}
              onClick={() => saveViewerPrefs({ depthShape: c })}>
              <ShapeIcon shape={c} />
              <span>{MOTION_LABELS[c]}</span>
            </button>
          ))}
        </div>

        <Slider id="dp-motion" label="Motion amount" title="How far the pictures move" min={0.3} max={4} step={0.1}
          value={prefs.depthMotion ?? 1} onChange={(v) => saveViewerPrefs({ depthMotion: v })} />
        <Slider id="dp-speed" label="Motion speed" title="How fast the camera goes round (100% = once round in 9 seconds). It carries on from picture to picture."
          min={0.25} max={4} step={0.05} value={prefs.depthSpeed ?? 1} onChange={(v) => saveViewerPrefs({ depthSpeed: v })} />
        {/* For the automatic movement and the 3D button alike. */}
        <Slider id="dp-depth" label="3D depth" title="How strongly near things move against far ones" min={0.3} max={3} step={0.1}
          value={prefs.depthAmount ?? 1} onChange={(v) => saveViewerPrefs({ depthAmount: v })} />
        <Slider id="dp-react" label="3D mouse reaction" title="With the 3D button on: how far you move the mouse for the picture to lean all the way (higher = less mouse movement needed)"
          min={0.3} max={3} step={0.1} value={prefs.depthReact ?? 1} onChange={(v) => saveViewerPrefs({ depthReact: v })} />

        <EdgesSlider prefs={prefs} />

        {/* Moving pictures: their own switch and amount. */}
        <span />
        <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={!!prefs.depthMoving} onChange={(e) => saveViewerPrefs({ depthMoving: e.target.checked })} /> 3D for GIFs and videos
          </label>
          <span className="faint" style={{ fontSize: 12 }}>
            Lets the gentle 3D motion, the 3D mouse and 3D to the beat work on GIFs and videos too (it turns none of them on by itself). GIFs: every frame's depth is worked out when one opens (flat until then); videos: worked out live while they play.
          </span>
        </span>
        <span />
        <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={!!prefs.depthVideoDelay} onChange={(e) => saveViewerPrefs({ depthVideoDelay: e.target.checked })} /> Delay videos slightly for cleaner 3D edges
          </label>
          <span className="faint" style={{ fontSize: 12 }}>Videos' depth is worked out live, a moment behind the picture. With this on, the picture and its sound are shown a tenth of a second late so every frame meets its own depth.</span>
        </span>
        <Slider id="dp-moving" label="GIF / video 3D depth" title="How strongly GIFs and videos move in depth (separate from pictures)" min={0.2} max={3} step={0.1}
          value={prefs.depthMovingAmount ?? 0.6} onChange={(v) => saveViewerPrefs({ depthMovingAmount: v })} />

        {/* 3D to the beat. */}
        <span />
        <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={!!prefs.depthBeat} onChange={(e) => saveViewerPrefs({ depthBeat: e.target.checked })} /> 3D to the beat
          </label>
          <span className="faint" style={{ fontSize: 12 }}>With music playing on the computer, the 3D picture pulses on each beat (works with the motion and with the mouse).</span>
        </span>
        <span>Each beat</span>
        <div role="radiogroup" aria-label="Each beat" className="seg">
          {(['push', 'bounce'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={(prefs.depthBeatKind ?? 'push') === k} className={(prefs.depthBeatKind ?? 'push') === k ? 'on' : ''}
              onClick={() => saveViewerPrefs({ depthBeatKind: k })}>{k === 'push' ? 'Small push in' : 'Little bounce'}</button>
          ))}
        </div>
        <Slider id="dp-beat" label="Beat strength" title="How strong each beat's push or bounce is" min={0.2} max={3} step={0.1}
          value={prefs.depthBeatAmount ?? 1} onChange={(v) => saveViewerPrefs({ depthBeatAmount: v })} />

        {/* Subject effects (still pictures only): Lift-off. */}
        <span style={{ alignSelf: 'start', paddingTop: 12, fontWeight: 600 }}>Subject effects</span>
        <span className="faint" style={{ fontSize: 12, paddingTop: 12 }}>
          {subjectOk === false ? NO_SUBJECT_PACK
            : 'For still pictures (not GIFs or videos). The subject is found offline; both work with or without the 3D motion and the 3D mouse.'}
        </span>
        <span />
        <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={!!prefs.depthLift} onChange={(e) => saveViewerPrefs({ depthLift: e.target.checked })} /> Lift-off
          </label>
          <span className="faint" style={{ fontSize: 12 }}>The subject comes forward a little, with a soft shadow behind it. The background stays as it is.</span>
        </span>
        <Slider id="dp-lift" label="Lift-off amount" title="How far the subject comes forward (100% = about 3.5% bigger)" min={0.3} max={3} step={0.1}
          value={prefs.depthLiftAmount ?? 1} onChange={(v) => saveViewerPrefs({ depthLiftAmount: v })} />
                {/* Picture layers (still pictures with an outline). */}
        <span style={{ alignSelf: 'start', paddingTop: 12, fontWeight: 600 }}>Picture layers</span>
        <span className="faint" style={{ fontSize: 12, paddingTop: 12 }}>
          {subjectOk === false ? NO_SUBJECT_PACK : 'For still pictures, using the subject outline. Each is also a button next to the 3D buttons.'}
        </span>
        <span />
        <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={!!prefs.depthEdges3d} onChange={(e) => saveViewerPrefs({ depthEdges3d: e.target.checked })} /> Sharper depth edges
          </label>
          <span className="faint" style={{ fontSize: 12 }}>The depth follows the subject's outline, so the subject and the background move apart cleanly instead of smearing at the edge. Works with every 3D mode.</span>
        </span>
        <Slider id="dp-edges3d" label="Edge strength" title="How firmly the depth is made to follow the outline" min={0.2} max={1} step={0.05}
          value={edgesStrength(prefs.depthEdgesStrength)} onChange={(v) => saveViewerPrefs({ depthEdgesStrength: v })} />
        <span />
        <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={!!prefs.depthLight} onChange={(e) => saveViewerPrefs({ depthLight: e.target.checked })} /> A light that stays put
          </label>
          <span className="faint" style={{ fontSize: 12 }}>A soft shadow of the subject on the background and a soft rim of light on its edge. As the camera moves they shift as if the light stayed where it is.</span>
        </span>
        <label htmlFor="dp-langle">Light direction</label>
        <span className="row" style={{ gap: 8 }} title="Where the light comes from">
          <input id="dp-langle" type="range" min={0} max={359} step={1} value={lightAngle(prefs.depthLightAngle)} style={{ flex: 1 }}
            onChange={(e) => saveViewerPrefs({ depthLightAngle: Number(e.target.value) })} />
          <span className="faint" style={{ minWidth: 120, fontSize: 12 }}>{lightWords(lightAngle(prefs.depthLightAngle))}</span>
        </span>
        <Slider id="dp-lstrength" label="Light strength" title="How dark the shadow and how bright the rim" min={0.2} max={2} step={0.1}
          value={lightStrength(prefs.depthLightStrength)} onChange={(v) => saveViewerPrefs({ depthLightStrength: v })} />
        <span />
        <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={!!prefs.depthSubjectOnly} onChange={(e) => saveViewerPrefs({ depthSubjectOnly: e.target.checked })} /> 3D only on the subject
          </label>
          <span className="faint" style={{ fontSize: 12 }}>The background stays completely still; only the subject moves in 3D, with its own depth.</span>
        </span>
        <span />
        <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <label className="check">
            <input type="checkbox" checked={!!prefs.depthLayered} onChange={(e) => saveViewerPrefs({ depthLayered: e.target.checked })} /> Layered 3D
          </label>
          <span className="faint" style={{ fontSize: 12 }}>The picture is drawn as two layers: the background with the subject filled in, and the subject on top. Moving the camera shows background behind the subject instead of stretched edges.</span>
        </span>
        <span style={{ alignSelf: 'start', paddingTop: 12 }}>Background fill</span>
        <InpaintModelChoice />

        <span style={{ alignSelf: 'start', paddingTop: 12 }}>Subject model</span>
        <SubjectModelChoice />

        {/* Which model works out the depth (speed tests are in Settings → 3D photos). */}
        <span style={{ alignSelf: 'start', paddingTop: 12 }}>Depth model</span>
        <DepthModelChoice />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>,
    document.body,
  );
}
