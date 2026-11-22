// Prepared 3D for videos and GIFs (video3d.ts): the "Prepare 3D" question
// (how many, about how long, about how much space, with which models) and
// Settings → AI & 3D → Videos and GIFs (the settings, what's saved and its
// size, "Delete all 3D data for videos and GIFs", what's being prepared).

import { useEffect, useState } from 'react';
import { api, type DepthModel, type DerivedStats, type InpaintModel, type SubjectModel, type ViewerSettings } from '../api';
import { onSavedChange, savedChanged } from '../derived';
import { formatBytes } from '../theme';
import { plural } from '../undo';
import { errText } from '../text';
import { currentSetup, estimate3d, forget3d, prepare3d, stopPrepare3d, trackChanged, usePrep3d, VIDEO3D_SIZES, videoPrefs, type Setup, type Want3d } from '../video3d';
import { ConfirmDialog, Modal } from './Dialogs';

/** "about 4 minutes", "about 2 hours". */
export function aboutTime(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds / 10) * 10)} seconds`;
  if (seconds < 90 * 60) return `about ${Math.round(seconds / 60)} minutes`;
  const h = seconds / 3600;
  return `about ${h < 10 ? h.toFixed(1) : Math.round(h)} hours`;
}

/** What it will be made with, in words. */
function setupWords(s: Setup): string {
  const parts = [`depth: ${s.depth.model}${s.clip ? ` (video model, ${s.clip} frames at a time)` : ''}`];
  if (s.subject) parts.push(`outline: ${s.subject.model}`);
  else parts.push('depth only (no Lift-off or Layered 3D)');
  if (s.plate) parts.push(`fill: ${s.fill || 'Simple'}${s.fillEvery > 1 ? ` on every ${s.fillEvery === 2 ? '2nd' : '3rd'} frame` : ''}`);
  else if (s.subject) parts.push('no Layered 3D');
  if (s.edges > 0) parts.push('sharper edges');
  parts.push(`${s.size} px`, s.every === 2 ? 'every 2nd frame' : 'every frame');
  return parts.join(' · ');
}

/** One setting row: label, choice, and its explanation under it. */
function Row(props: { id: string; label: string; value: string | number; onChange: (v: string) => void; options: [string | number, string][]; help: string }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <label htmlFor={props.id} style={{ fontSize: 13, minWidth: 150 }}>{props.label}</label>
        <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          {props.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <span className="faint" style={{ fontSize: 12, display: 'block' }}>{props.help}</span>
    </div>
  );
}

const usable = (m: { installed: boolean; problem: string | null }) => m.installed && !m.problem;
const modelLabel = (m: { name: string; installed: boolean; problem: string | null }) => `${m.name}${usable(m) ? '' : m.installed ? ' (can’t be used here)' : ' (not installed)'}`;

/** "Prepare 3D" for some videos and GIFs: asks first, with the estimate. `again`: its prepared 3D under this tag is deleted first. */
export function Prepare3DDialog(props: { what: string; items: Want3d[]; again?: string | null; onClose: () => void; onStarted?: (text: string) => void }) {
  const [setup, setSetup] = useState<Setup | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void currentSetup().then((s) => live && setSetup(s), () => live && setSetup(null));
    return () => {
      live = false;
    };
  }, []);
  const n = props.items.length;
  if (setup === undefined) {
    return (
      <Modal title="Prepare 3D" onClose={props.onClose}>
        <div className="faint">Looking at the 3D models…</div>
      </Modal>
    );
  }
  if (!setup || !n) {
    return (
      <Modal title="Prepare 3D" onClose={props.onClose}>
        <div className="muted" style={{ lineHeight: 1.6 }}>
          {!n ? `There are no videos or GIFs in ${props.what}.` : '3D needs a depth pack: see Settings → AI & 3D.'}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={props.onClose}>OK</button>
        </div>
      </Modal>
    );
  }
  const e = estimate3d(props.items, setup);
  return (
    <ConfirmDialog title={`Prepare 3D · ${props.what}`} confirm="Prepare" onClose={props.onClose}
      onConfirm={async () => {
        if (props.again) for (const it of props.items) await forget3d(it.id, props.again);
        prepare3d(props.items);
        props.onStarted?.(`Preparing 3D for ${plural(n, 'video or GIF', 'videos and GIFs')} in the background (see the activity ring).`);
        props.onClose();
      }}>
      <div style={{ lineHeight: 1.6 }}>
        {plural(n, 'video or GIF', 'videos and GIFs')}: every frame's 3D is worked out once and saved in the vault (encrypted), then
        {n === 1 ? ' it plays' : ' they play'} with 3D smoothly.
        <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
          <li>Time: {aboutTime(e.seconds)} (runs in the background; Stop keeps what's done, and it carries on from there next time).</li>
          <li>Space: up to {formatBytes(e.bytes)}.</li>
          <li className="faint">Made with: {setupWords(setup)}.</li>
        </ul>
        {props.again && <div>What was prepared before is deleted first.</div>}
        <span className="faint" style={{ fontSize: 12 }}>The time is a guess from the models' speed tests (Settings → AI & 3D); a first run tells.</span>
      </div>
    </ConfirmDialog>
  );
}

/** Settings → AI & 3D → Videos and GIFs. */
export function Video3DSection(props: { viewer: ViewerSettings; setViewer: (patch: Partial<ViewerSettings>) => void }) {
  const v = videoPrefs(props.viewer);
  const prep = usePrep3d();
  const [stats, setStats] = useState<DerivedStats | null>(null);
  const [ask, setAsk] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = () => void api.derivedStats().then(setStats).catch(() => setStats(null));
  useEffect(load, []);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onSavedChange(() => {
      if (!t) t = setTimeout(() => { t = null; load(); }, 500);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, []);
  const count = stats?.trackCount ?? 0;
  const bytes = stats?.trackBytes ?? 0;
  // The models that can be chosen for videos.
  const [dm, setDm] = useState<DepthModel[]>([]);
  const [sm, setSm] = useState<SubjectModel[]>([]);
  const [im, setIm] = useState<InpaintModel[]>([]);
  useEffect(() => {
    let live = true;
    void api.depthModels().then((m) => live && setDm(m), () => {});
    void api.subjectModels().then((m) => live && setSm(m), () => {});
    void api.inpaintModels().then((m) => live && setIm(m), () => {});
    return () => {
      live = false;
    };
  }, []);
  const set = props.setViewer;
  return (
    <>
      <h3 style={{ margin: '18px 0 4px', fontSize: 14 }}>Videos and GIFs</h3>
      <p className="muted" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
        Videos and GIFs get 3D once they are <b>prepared</b>: every frame's depth, outline and background fill is worked out once
        (with the models above) and saved in the vault, so they play with 3D smoothly. Prepare one from the viewer's <b>3D ▾</b> menu,
        or many from a folder's or a selection's right-click menu. Until then they play without 3D. Turn on <b>3D for GIFs and videos</b> in
        the viewer's 3D settings to see it.
      </p>
      <Row id="v3d-parts" label="What to prepare" value={v.parts} onChange={(x) => set({ video3dParts: x })}
        options={[['depth', 'Depth only (fastest)'], ['outline', 'Depth + subject outline'], ['all', 'Everything (+ Layered 3D fill)']]}
        help="Depth only: the 3D motion and the 3D mouse. + subject outline: also Lift-off and 3D only on the subject. Everything: also Layered 3D (the background filled in behind the subject). Each step adds a model per frame, so less is faster." />
      {v.parts === 'all' && (
        <Row id="v3d-fill-every" label="Fill the background" value={v.fillEvery} onChange={(x) => set({ video3dFillEvery: Number(x) })}
          options={[[1, 'On every frame'], [2, 'On every 2nd frame'], [3, 'On every 3rd frame']]}
          help="Layered 3D's fill model is often the slowest step. On every 2nd or 3rd frame, the frames between reuse its fill (a new scene always gets its own). Try both on one video to see if you can tell." />
      )}
      <Row id="v3d-depth-model" label="Depth model for videos" value={v.depthModel} onChange={(x) => set({ video3dDepthModel: x })}
        options={[['', 'Same as pictures'], ...dm.map((m): [string, string] => [m.id, `${modelLabel(m)}${m.video ? ' · made for video' : ''}`])]}
        help="Video (steady) is made for video: it looks at 32 frames together, so depth doesn't flicker or breathe; about as fast as Fast. Its download: MediaVault-depth-vda-small-windows.zip (Releases page). Fast is quicker than Best; Best has finer depth." />
      {v.parts !== 'depth' && (
        <Row id="v3d-subject-model" label="Outline model for videos" value={v.subjectModel} onChange={(x) => set({ video3dSubjectModel: x })}
          options={[['', 'Same as pictures'], ...sm.map((m): [string, string] => [m.id, modelLabel(m)])]}
          help="The model that finds the subject in each frame (Lift-off, 3D only on the subject, Layered 3D). A lighter one is quicker." />
      )}
      {v.parts === 'all' && (
        <Row id="v3d-fill-model" label="Fill model for videos" value={v.fillModel} onChange={(x) => set({ video3dFillModel: x })}
          options={[['', 'Same as pictures'], ['simple', 'Simple (no download, quickest)'], ...im.map((m): [string, string] => [m.id, modelLabel(m)])]}
          help="What fills the background behind the subject for Layered 3D. Simple is quickest; MI-GAN is quick and good; LaMa is the most convincing and the slowest." />
      )}
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <label htmlFor="v3d-size" style={{ fontSize: 13 }}>3D detail</label>
        <select id="v3d-size" value={v.size} onChange={(e) => props.setViewer({ video3dSize: Number(e.target.value) })}>
          {VIDEO3D_SIZES.map((s) => <option key={s} value={s}>{s} px{s === 768 ? ' (suggested)' : ''}</option>)}
        </select>
        <span className="faint" style={{ fontSize: 12 }}>The size the 3D data is made at (long side). Bigger: finer edges, more space and a little slower.</span>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <label htmlFor="v3d-every" style={{ fontSize: 13 }}>Frames</label>
        <select id="v3d-every" value={v.every} onChange={(e) => props.setViewer({ video3dEvery: Number(e.target.value) })}>
          <option value={1}>Every frame (suggested)</option>
          <option value={2}>Every second frame</option>
        </select>
        <span className="faint" style={{ fontSize: 12 }}>Every second frame takes half the time and space; on fast movement the 3D can lag a frame behind.</span>
      </div>
      <label className="check" style={{ marginTop: 6 }}>
        <input type="checkbox" checked={v.calm} onChange={(e) => props.setViewer({ video3dCalm: e.target.checked })} /> Calmer 3D camera on videos
      </label>
      <span className="faint" style={{ fontSize: 12, display: 'block' }}>
        The 3D camera moves slower and less on videos and GIFs, and less still in fast scenes, so it doesn't fight the video's own movement.
      </span>
      <p className="faint" style={{ fontSize: 12, margin: '6px 0 0' }}>
        Changing a model or these settings: videos keep playing with what they were prepared with until you prepare them again.
      </p>
      <div className="info" style={{ marginTop: 8 }}>
        {prep.running && prep.current
          ? `Preparing “${prep.current.name}”: ${Math.round(prep.current.fraction * 100)} %${prep.queue.length ? ` · ${plural(prep.queue.length, 'more')} waiting` : ''}.`
          : 'Nothing is being prepared.'}
        {' '}Saved: {stats ? `${plural(count, 'video or GIF', 'videos and GIFs')} with 3D, ${formatBytes(bytes)}` : '…'}.
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {prep.running && <button type="button" className="btn btn-sm" onClick={stopPrepare3d}>Stop preparing</button>}
        <button type="button" className="btn btn-sm btn-danger" disabled={!stats || bytes === 0} onClick={() => setAsk(true)}>
          Delete all 3D data for videos and GIFs{bytes ? ` (${formatBytes(bytes)})` : ''}…
        </button>
        <span className="faint" style={{ fontSize: 12 }}>Only the videos' and GIFs' prepared 3D; the pictures' 3D data stays. Your videos and GIFs don't change.</span>
      </div>
      {note && <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{note}</div>}
      {ask && (
        <ConfirmDialog title="Delete all 3D data for videos and GIFs?" confirm="Delete" danger onClose={() => setAsk(false)}
          onConfirm={async () => {
            try {
              stopPrepare3d();
              const n = await api.derivedClear('track');
              trackChanged();
              savedChanged();
              setNote(`Deleted the prepared 3D (${plural(n, 'saved piece')}, ${formatBytes(bytes)}).`);
              load();
            } catch (e) {
              setNote(errText(e));
            }
            setAsk(false);
          }}>
          The prepared 3D of {plural(count, 'video or GIF', 'videos and GIFs')} ({formatBytes(bytes)}) will be deleted. This can't be undone:
          they play without 3D until you prepare them again (which takes as long as the first time). Your videos and GIFs don't change,
          and the pictures' 3D data stays.
        </ConfirmDialog>
      )}
    </>
  );
}
