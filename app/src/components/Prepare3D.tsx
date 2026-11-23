// Prepared 3D for videos and GIFs (video3d.ts): the Prepare 3D window (each
// effect ticked with its model, the estimate; the video then plays with only
// what was ticked for it) and Settings → AI & 3D → Videos and GIFs (what's
// being prepared, the space it takes, "Delete all 3D data for videos and GIFs").

import { useEffect, useState, type ReactNode } from 'react';
import { api, type DepthModel, type DerivedStats, type InpaintModel, type SubjectModel } from '../api';
import { onSavedChange, savedChanged } from '../derived';
import { formatBytes } from '../theme';
import { plural } from '../undo';
import { errText } from '../text';
import { needsOutline, type Video3dChoices } from '../track3d';
import { cleanChoices, estimate3d, existing3d, lastChoices, prepare3d, rememberChoices, setupFor, stopPrepare3d, trackChanged, usePrep3d, VIDEO3D_SIZES, type Setup, type Want3d } from '../video3d';
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
  if (s.plate) parts.push(`fill: ${s.fill || 'Simple'}${s.fillEvery > 1 ? ` on every ${s.fillEvery === 2 ? '2nd' : '3rd'} frame` : ''}`);
  if (s.edges > 0) parts.push('sharper edges');
  parts.push(`${s.size} px`, s.every === 2 ? 'every 2nd frame' : 'every frame');
  return parts.join(' · ');
}

const usable = (m: { installed: boolean; problem: string | null }) => m.installed && !m.problem;
const modelLabel = (m: { name: string; installed: boolean; problem: string | null }) => `${m.name}${usable(m) ? '' : m.installed ? ' (can’t be used here)' : ' (not installed)'}`;

/** A model choice: '' = the one the pictures use. */
function ModelSelect(props: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select id={props.id} aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {props.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

/** A percentage slider (amounts). */
function Amount(props: { id: string; label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <span className="row" style={{ gap: 6, alignItems: 'center' }}>
      <label htmlFor={props.id} className="faint" style={{ fontSize: 12 }}>{props.label}</label>
      <input id={props.id} type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))} style={{ width: 110 }} />
      <span className="faint" style={{ minWidth: 40, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{Math.round(props.value * 100)}%</span>
    </span>
  );
}

/** One effect: its tick box, what goes with it (model, amount) and its explanation under it. */
function Effect(props: { id: string; label: string; checked: boolean; disabled?: boolean; onChange?: (on: boolean) => void; extra?: ReactNode; help: string }) {
  return (
    <div style={{ padding: '6px 0', borderTop: '1px solid var(--line, rgba(127,127,127,.2))' }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <label className="check" style={{ minWidth: 190 }}>
          <input id={props.id} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange?.(e.target.checked)} /> {props.label}
        </label>
        {props.checked && props.extra}
      </div>
      <span className="faint" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>{props.help}</span>
    </div>
  );
}

/** The models that can be chosen (asked once per window). */
function useModels() {
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
  return { dm, sm, im };
}

/**
 * The Prepare 3D window for some videos and GIFs: each effect ticked with its model, the estimate, then
 * prepared in the background. They play with only what's ticked here (the pictures' 3D switches never
 * apply to them). `initial`: the video's own choices (changing them); else what the window was last set to.
 */
export function Prepare3DDialog(props: { what: string; items: Want3d[]; initial?: Video3dChoices | null; onClose: () => void; onStarted?: (text: string) => void }) {
  const [c, setC] = useState<Video3dChoices>(() => cleanChoices(props.initial ?? lastChoices()));
  const set = (patch: Partial<Video3dChoices>) => setC((x) => ({ ...x, ...patch }));
  const { dm, sm, im } = useModels();
  const [setup, setSetup] = useState<Setup | null | undefined>(undefined);
  const [there, setThere] = useState<{ looked: number; has: number; same: Set<number> } | null>(null);
  const n = props.items.length;
  // The setup (and what these videos have already) follows the choices.
  useEffect(() => {
    let live = true;
    void setupFor(c).then(async (s) => {
      if (!live) return;
      setSetup(s);
      if (!s) return;
      const e = await existing3d(props.items, s.tag).catch(() => null);
      if (live) setThere(e);
    }, () => live && setSetup(null));
    return () => {
      live = false;
    };
  }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!n) {
    return (
      <Modal title="Prepare 3D" onClose={props.onClose}>
        <div className="muted" style={{ lineHeight: 1.6 }}>There are no videos or GIFs in {props.what}.</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={props.onClose}>OK</button>
        </div>
      </Modal>
    );
  }
  if (setup === null) {
    return (
      <Modal title="Prepare 3D" onClose={props.onClose}>
        <div className="muted" style={{ lineHeight: 1.6 }}>3D needs a depth pack: see Settings → AI & 3D.</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={props.onClose}>OK</button>
        </div>
      </Modal>
    );
  }
  const outline = needsOutline(c);
  // Only those not already made with this setup are prepared (the others just take how they play).
  const todo = setup && there ? props.items.filter((it) => !there.same.has(it.id)) : props.items;
  const e = setup ? estimate3d(todo, setup) : null;
  const nothing = !!setup && !!there && there.looked === n && todo.length === 0;
  const thing = plural(n, 'video or GIF', 'videos and GIFs');
  const go = () => {
    rememberChoices(c);
    prepare3d(props.items, c);
    props.onStarted?.(nothing ? `3D: the new choices are saved for ${thing}` : `Preparing 3D for ${thing} in the background (see the activity ring).`);
    props.onClose();
  };
  const depthOptions: [string, string][] = [['', 'Same as pictures'], ...dm.map((m): [string, string] => [m.id, `${modelLabel(m)}${m.video ? ' · made for video' : ''}`])];
  const subjectOptions: [string, string][] = [['', 'Same as pictures'], ...sm.map((m): [string, string] => [m.id, modelLabel(m)])];
  const fillOptions: [string, string][] = [['', 'Same as pictures'], ['simple', 'Simple (no download, quickest)'], ...im.map((m): [string, string] => [m.id, modelLabel(m)])];
  return (
    <Modal title={`Prepare 3D · ${props.what}`} onClose={props.onClose} wide>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 6 }}>
        Tick what {n === 1 ? 'it' : 'they'} should have. Every frame's 3D is worked out once and saved in the vault (encrypted); then
        {n === 1 ? ' it plays' : ' they play'} in 3D with <b>only what's ticked here</b>. The 3D switches for pictures don't apply to videos and GIFs.
      </div>
      <Effect id="p3-depth" label="Depth (always)" checked disabled
        extra={<ModelSelect id="p3-depth-model" label="Depth model" value={c.depthModel} onChange={(v) => set({ depthModel: v })} options={depthOptions} />}
        help="The 3D itself: the gentle motion, the 3D mouse and 3D to the beat. Video (steady) is made for video (no flicker, about as fast as Fast; download MediaVault-depth-vda-small-windows.zip). Best has finer depth and is slower." />
      <Effect id="p3-lift" label="Lift-off" checked={c.lift} onChange={(on) => set({ lift: on })}
        extra={<Amount id="p3-lift-amount" label="Amount" min={0.3} max={3} step={0.1} value={c.liftAmount} onChange={(v) => set({ liftAmount: v })} />}
        help="The subject comes forward out of the video. Needs the outline. The amount can be changed later without preparing again." />
      <Effect id="p3-only" label="3D only on the subject" checked={c.subjectOnly} onChange={(on) => set({ subjectOnly: on })}
        help="The background stays still and only the subject moves in 3D. Needs the outline. Can be switched later without preparing again." />
      <Effect id="p3-edges" label="Sharper depth edges" checked={c.edges} onChange={(on) => set({ edges: on })}
        extra={<Amount id="p3-edges-amount" label="Strength" min={0.2} max={1} step={0.05} value={c.edgesAmount} onChange={(v) => set({ edgesAmount: v })} />}
        help="The depth follows the subject's outline, so it doesn't smear into the background. Needs the outline; saved in the 3D (changing it means preparing again)." />
      <Effect id="p3-layered" label="Layered 3D" checked={c.layered} onChange={(on) => set({ layered: on })}
        extra={<>
          <ModelSelect id="p3-fill-model" label="Fill model" value={c.fillModel} onChange={(v) => set({ fillModel: v })} options={fillOptions} />
          <ModelSelect id="p3-fill-every" label="Fill on which frames" value={String(c.fillEvery)} onChange={(v) => set({ fillEvery: Number(v) })}
            options={[['1', 'Fill every frame'], ['2', 'Fill every 2nd frame'], ['3', 'Fill every 3rd frame']]} />
        </>}
        help="The background is filled in behind the subject, so nothing stretches when the camera moves. Simple is quickest, MI-GAN quick and good, LaMa the most convincing and slowest. Every 2nd or 3rd frame: the frames between reuse the fill (a new scene always gets its own); much quicker. Needs the outline." />
      {outline && (
        <div style={{ padding: '6px 0', borderTop: '1px solid var(--line, rgba(127,127,127,.2))' }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <label htmlFor="p3-subject-model" style={{ minWidth: 190, fontSize: 13 }}>Outline model</label>
            <ModelSelect id="p3-subject-model" label="Outline model" value={c.subjectModel} onChange={(v) => set({ subjectModel: v })} options={subjectOptions} />
          </div>
          <span className="faint" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>Finds the subject in each frame, once, for every ticked effect that needs it. A lighter one is quicker.</span>
        </div>
      )}
      <div style={{ padding: '6px 0', borderTop: '1px solid var(--line, rgba(127,127,127,.2))' }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <label htmlFor="p3-size" style={{ minWidth: 190, fontSize: 13 }}>3D detail</label>
          <ModelSelect id="p3-size" label="3D detail" value={String(c.size)} onChange={(v) => set({ size: Number(v) })}
            options={VIDEO3D_SIZES.map((s): [string, string] => [String(s), `${s} px${s === 768 ? ' (suggested)' : ''}`])} />
        </div>
        <span className="faint" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>The size the 3D is made at (long side). Bigger: finer edges, more space, a little slower.</span>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 6 }}>
          <label htmlFor="p3-every" style={{ minWidth: 190, fontSize: 13 }}>Frames</label>
          <ModelSelect id="p3-every" label="Frames" value={String(c.every)} onChange={(v) => set({ every: Number(v) })}
            options={[['1', 'Every frame (suggested)'], ['2', 'Every second frame']]} />
        </div>
        <span className="faint" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>Every second frame takes half the time and space; on fast movement the 3D can lag a frame behind.</span>
        <label className="check" style={{ marginTop: 6 }}>
          <input id="p3-calm" type="checkbox" checked={c.calm} onChange={(e) => set({ calm: e.target.checked })} /> Calmer 3D camera
        </label>
        <span className="faint" style={{ fontSize: 12, display: 'block' }}>The 3D camera moves slower and less, and less still in fast scenes, so it doesn't fight the video's own movement. Can be switched later without preparing again.</span>
      </div>
      <div className="info" style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
        {!setup || !there ? 'Working out the estimate…' : nothing ? (
          <>Already prepared with these models: only how {n === 1 ? 'it plays' : 'they play'} changes (Lift-off, 3D only on the subject, the camera). Nothing to prepare.</>
        ) : (
          <>
            <div>{plural(todo.length, 'video or GIF', 'videos and GIFs')} to prepare · {aboutTime(e!.seconds)} · up to {formatBytes(e!.bytes)}.</div>
            {there.has > 0 && <div>{n === 1 ? 'Its 3D from before is replaced by this.' : `${there.has} of them have 3D from before: it's replaced by this.`}</div>}
            <div className="faint" style={{ fontSize: 12 }}>Made with: {setupWords(setup)}. Runs in the background; Stop keeps what's done, and it carries on from there next time. The time is a guess from the models' speed tests.</div>
          </>
        )}
        {setup && setup.missing.map((m) => <div key={m} className="faint" style={{ fontSize: 12 }}>Note: {m}.</div>)}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!setup || !there} onClick={go}>{nothing ? 'Save' : 'Prepare'}</button>
      </div>
    </Modal>
  );
}

/** Settings → AI & 3D → Videos and GIFs. */
export function Video3DSection() {
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
  return (
    <>
      <h3 style={{ margin: '18px 0 4px', fontSize: 14 }}>Videos and GIFs</h3>
      <p className="muted" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
        Videos and GIFs get 3D once they are <b>prepared</b>: right-click one (or a folder, or a selection), or the viewer's <b>3D ▾</b> menu →
        Prepare 3D. A window opens where you tick what each should have (depth, Lift-off, 3D only on the subject, sharper edges, Layered 3D)
        and with which models; they play with only that. Preparing one again replaces what it had. Turn on <b>3D for GIFs and videos</b> in
        the viewer's 3D settings to see it.
      </p>
      <div className="info" style={{ marginTop: 8 }}>
        {prep.running && prep.current
          ? `Preparing “${prep.current.name}”: ${Math.round(prep.current.fraction * 100)} %${prep.queue.length ? ` · ${plural(prep.queue.length, 'more')} waiting` : ''}.`
          : 'Nothing is being prepared.'}
        {' '}Saved: {stats ? `${plural(count, 'video or GIF', 'videos and GIFs')} with 3D, ${formatBytes(bytes)}` : '…'}.
        {prep.lastError && (
          <div className="muted" style={{ marginTop: 4 }}>
            Last time it failed: {prep.lastError}. What was made is kept; preparing it again carries on from there.
          </div>
        )}
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
