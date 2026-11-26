// 3D photos settings, opened from the viewer's View ▾ menu: whether still
// pictures move gently in depth on their own (in slideshows and while just
// open), along which shape, how far and how fast, plus the depth strength
// and the mouse reaction that the 3D button uses too, the subject effects,
// the picture layers, the 3D looks (Focus, Border fill, Wiggle), and which
// depth model (and how much detail) works out the depth.

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
import { edgesStrength } from '../layers';
import { openSettings } from '../settingslink';

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

function Slider(props: { id: string; label: string; title?: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; fmt?: (v: number) => string; note?: string }) {
  return (
    <>
      <label htmlFor={props.id}>{props.label}</label>
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }} title={props.title}>
        <input id={props.id} type="range" min={props.min} max={props.max} step={props.step} value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))} style={{ flex: 1 }} />
        <span className="faint" style={{ minWidth: 46, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{props.fmt ? props.fmt(props.value) : `${Math.round(props.value * 100)}%`}</span>
        {props.note && <span className="faint" style={{ fontSize: 12, flexBasis: '100%' }}>{props.note}</span>}
      </span>
    </>
  );
}

/** A row of choices (one of them on), with a short explanation under it. */
function Seg<T extends string | number>(props: { label: string; value: T; options: [T, string, string?][]; onChange: (v: T) => void; note?: string }) {
  return (
    <>
      <span>{props.label}</span>
      <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
        <span role="radiogroup" aria-label={props.label} className="seg">
          {props.options.map(([v, text, title]) => (
            <button key={String(v)} type="button" role="radio" aria-checked={props.value === v} className={props.value === v ? 'on' : ''} title={title}
              onClick={() => props.onChange(v)}>{text}</button>
          ))}
        </span>
        {props.note && <span className="faint" style={{ fontSize: 12, flexBasis: '100%' }}>{props.note}</span>}
      </span>
    </>
  );
}

/** A switch with its explanation next to it. */
function Check(props: { checked: boolean; label: string; note: string; onChange: (on: boolean) => void }) {
  return (
    <>
      <span />
      <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
        <label className="check">
          <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} /> {props.label}
        </label>
        <span className="faint" style={{ fontSize: 12 }}>{props.note}</span>
      </span>
    </>
  );
}

const Heading = ({ title, note }: { title: string; note: string }) => (
  <>
    <span style={{ alignSelf: 'start', paddingTop: 12, fontWeight: 600 }}>{title}</span>
    <span className="faint" style={{ fontSize: 12, paddingTop: 12 }}>{note}</span>
  </>
);

/** The 3D looks for still pictures (docs/picture-3d-looks-plan.md): Focus, Border fill, Wiggle. */
function LooksSettings({ prefs }: { prefs: ViewerSettings }) {
  const set = saveViewerPrefs;
  return (
    <>
      <Heading title="Looks" note="For still pictures (not GIFs or videos). Each is also in the viewer’s 3D ▾ menu. Flat pictures (documents, screenshots) are left as they are." />
      <Check checked={!!prefs.depthFocus} label="Focus" onChange={(v) => set({ depthFocus: v })}
        note="Like a camera lens: the parts nearer or farther than the focus go softly out of focus. Works on a still picture too." />
      <Seg label="Focus on" value={prefs.depthFocusOn ?? 'subject'} onChange={(v) => set({ depthFocusOn: v })}
        options={[['subject', 'The subject'], ['mouse', 'Under the mouse'], ['face', 'The biggest face']]}
        note="What stays sharp. The subject needs the outline model (else the middle of the picture); the biggest face needs the picture's face data (else the subject)." />
      <Seg label="Focus pull" value={prefs.depthFocusPull ?? 'off'} onChange={(v) => set({ depthFocusPull: v })}
        options={[['off', 'Off'], ['start', 'Background → subject'], ['swing', 'Back and forth']]}
        note="Moves the sharp part like a film camera: once when the picture comes, or over and over." />
      <Slider id="dp-pull" label="Pull time" title="How long one focus pull takes" min={0.5} max={3} step={0.1}
        value={prefs.depthFocusPullSec ?? 1.5} onChange={(v) => set({ depthFocusPullSec: v })} fmt={(v) => `${v.toFixed(1)} s`} />
      <Slider id="dp-blur" label="Blur strength" title="How soft the out-of-focus parts get" min={0} max={1} step={0.05}
        value={prefs.depthFocusBlur ?? 0.4} onChange={(v) => set({ depthFocusBlur: v })} />
      <Slider id="dp-range" label="Sharp depth range" title="How deep the sharp zone is: narrow = only the focus is sharp, wide = more of the picture" min={0} max={1} step={0.05}
        value={prefs.depthFocusRange ?? 0.3} onChange={(v) => set({ depthFocusRange: v })} />
      <Check checked={!!prefs.depthFocusRound} label="Round lights" onChange={(v) => set({ depthFocusRound: v })}
        note="Bright spots in the blur bloom into soft discs, the lens look. A little slower." />
      <Check checked={!!prefs.depthFocusMini} label="Miniature" onChange={(v) => set({ depthFocusMini: v })}
        note="A sharp band across the middle, top and bottom blurred: things look like toys (the depth isn't used for this one)." />

      <Heading title="Edges" note="For still pictures. Worked out once per picture (in the background) and saved in the vault, encrypted." />
      <Check checked={!!prefs.depthBorder} label="Border fill" onChange={(v) => set({ depthBorder: v })}
        note="A thin border is painted around the picture, so the 3D needs less zoom (or can move further). Plain edges such as black bars are simply carried on." />
      <Slider id="dp-bsize" label="Border size" title="How much is painted around the picture (share of its short side)" min={0.04} max={0.15} step={0.01}
        value={prefs.depthBorderSize ?? 0.08} onChange={(v) => set({ depthBorderSize: v })} />
      <Seg label="Use it for" value={prefs.depthBorderUse === 'moves' ? 'moves' : 'zoom'} onChange={(v) => set({ depthBorderUse: v })}
        options={[['zoom', 'Less zoom'], ['moves', 'Bigger moves']]}
        note="Less zoom: your framing is kept while it moves. Bigger moves: the camera goes up to 3 times as far. Also switchable in 3D ▾." />

      <Heading title="Wiggle" note="For still pictures: the camera jumps between a few viewpoints instead of gliding, the look of old 3D film cameras. 3D ▾ → Save wiggle as GIF saves it next to the picture." />
      <Check checked={!!prefs.depthWiggle} label="Wiggle" onChange={(v) => set({ depthWiggle: v })}
        note="Replaces the gentle motion and the 3D mouse on pictures while it's on. How far it moves follows Motion amount and 3D depth." />
      <Seg label="Views" value={Math.min(4, Math.max(2, prefs.depthWiggleViews ?? 3))} onChange={(v) => set({ depthWiggleViews: v })}
        options={[[2, '2'], [3, '3'], [4, '4']]} note="How many viewpoints it jumps between." />
      <Slider id="dp-wspeed" label="Wiggle speed" title="Jumps per second (at most 8: faster would flash)" min={3} max={8} step={0.5}
        value={prefs.depthWiggleSpeed ?? 5} onChange={(v) => set({ depthWiggleSpeed: v })} fmt={(v) => `${v} / s`}
        note="Capped at 8 per second: faster would flash." />
      <Seg label="Order" value={prefs.depthWiggleOrder === 'round' ? 'round' : 'bounce'} onChange={(v) => set({ depthWiggleOrder: v })}
        options={[['bounce', 'Back and forth'], ['round', 'Round']]} note="Back and forth: 1-2-3-2-1. Round: 1-2-3-1-2-3." />
      <Seg label="Direction" value={prefs.depthWiggleDir ?? 'side'} onChange={(v) => set({ depthWiggleDir: v })}
        options={[['side', 'Sideways'], ['updown', 'Up and down'], ['diagonal', 'Diagonal']]} note="Which way the viewpoint moves." />
      <Check checked={!!prefs.depthWiggleSmooth} label="Smooth step" onChange={(v) => set({ depthWiggleSmooth: v })}
        note="A short glide into each view instead of a hard jump." />
      <Seg label="GIF width" value={prefs.depthWiggleGifWidth === 480 || prefs.depthWiggleGifWidth === 800 ? prefs.depthWiggleGifWidth : 640}
        onChange={(v) => set({ depthWiggleGifWidth: v })} options={[[480, '480 px'], [640, '640 px'], [800, '800 px']]}
        note="The saved GIF's width. Bigger = sharper and a larger file (the 3D ▾ entry shows about how big)." />
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
          min={0.25} max={20} step={0.05} value={prefs.depthSpeed ?? 1} onChange={(v) => saveViewerPrefs({ depthSpeed: v })} />
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
            Lets the gentle 3D motion, the 3D mouse and 3D to the beat work on GIFs and videos too (it turns none of them on by itself). A video or GIF needs to be prepared once first: 3D ▾ → Prepare 3D (or right-click it or a folder). Its effects (Lift-off, Layered 3D…) and the calmer camera are what was ticked in its Prepare 3D window; the switches here and in 3D ▾ are for pictures.
          </span>
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
          {subjectOk === false ? NO_SUBJECT_PACK : 'For still pictures, using the subject outline. Each is also in the viewer’s 3D ▾ menu.'}
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
        <div>
          <InpaintModelChoice />
          <span className="faint" style={{ fontSize: 12 }}>Used by Layered 3D and Border fill.</span>
        </div>

        <LooksSettings prefs={prefs} />

        <span style={{ alignSelf: 'start', paddingTop: 12 }}>Subject model</span>
        <SubjectModelChoice />

        {/* Which model works out the depth (speed tests are in Settings → AI & 3D). */}
        <span style={{ alignSelf: 'start', paddingTop: 12 }}>Depth model</span>
        <DepthModelChoice />
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        {/* Speed tests, saved depth maps and the rest: Settings → AI & 3D, the one page for all 3D settings. */}
        <button type="button" className="link" onClick={() => { onClose(); openSettings('ai', 'settings-3d'); }}>More 3D settings…</button>
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>,
    document.body,
  );
}
