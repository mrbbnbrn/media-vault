// The depth model chooser for 3D photos (Settings → 3D photos, and the
// viewer's View ▾ → "3D photo settings…"): which model works out the depth
// (Fast, Best; the ones not installed are greyed with the download
// they come in), how much detail, and in Settings a speed test per model so
// you can see what your PC manages.

import { useEffect, useState } from 'react';
import { api, type DepthDetail, type DepthInfo, type DepthModel, type ViewerSettings } from '../api';
import { DEPTH_ZIPS, depthChoice, depthPack, lastSpeed, speedText, testSpeed, type SpeedResult } from '../depth';
import { saveViewerPrefs, useViewerPrefs } from '../prefs';

/** "99 MB". */
function sizeText(b: number): string {
  if (!b) return '';
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
}

/** One line on what each known model is good for. */
const ABOUT: Record<string, string> = {
  'v2-small': 'quickest, fine on most PCs',
  'v2-small-fp16': 'quickest on the graphics card; falls back to Fast on the processor',
  'da3-mono-large': 'the most accurate depth, needs a good graphics card',
};

/**
 * `value` / `onChange`: the settings to show and change (Settings passes its own copy, the
 * viewer's window the shared one); `speedTests` adds a "Test speed" button per installed model.
 */
export function DepthModelChoice(props: { value?: ViewerSettings; onChange?: (patch: Partial<ViewerSettings>) => void; speedTests?: boolean }) {
  const shared = useViewerPrefs();
  const choice = depthChoice(props.value ?? shared);
  const save = props.onChange ?? ((p: Partial<ViewerSettings>) => void saveViewerPrefs(p));
  const speedTests = !!props.speedTests;
  const [models, setModels] = useState<DepthModel[] | null>(null);
  const [inUse, setInUse] = useState<DepthInfo | null>(null);
  // Speed tests: which one is running, and the results (kept for this session in depth.ts).
  const [testing, setTesting] = useState<string | null>(null);
  const [speedErr, setSpeedErr] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    // Looked at afresh each time: a pack unzipped meanwhile shows up without a restart.
    api.depthModels().then((m) => alive && setModels(m)).catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    depthPack(true, choice).then((i) => alive && setInUse(i));
    return () => {
      alive = false;
    };
  }, [choice.model, choice.detail]);

  if (!models) return null;
  const ready = (m: DepthModel) => m.installed && !m.problem;
  const current = models.find((m) => m.id === inUse?.model);
  const detailFor = (m: DepthModel): DepthDetail => (m.dynamic ? choice.detail : 'standard');

  const runTest = async (m: DepthModel) => {
    setTesting(m.id);
    setSpeedErr((e) => ({ ...e, [m.id]: '' }));
    try {
      await testSpeed(m.id, detailFor(m));
    } catch (e) {
      setSpeedErr((x) => ({ ...x, [m.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setTesting(null);
      setTick((t) => t + 1);
      // The test may have found the graphics card doesn't work: show where it really runs.
      depthPack(true, choice).then(setInUse);
    }
  };

  return (
    <div className="depth-models">
      <div role="radiogroup" aria-label="Depth model" className="depth-model-list">
        <label className={`depth-model${choice.model === '' ? ' on' : ''}`}>
          <input type="radio" name="depth-model" checked={choice.model === ''} onChange={() => save({ depthModel: '' })} />
          <span className="depth-model-text">
            <b>Automatic</b>
            <span className="faint">The best one installed{choice.model === '' && current ? ` (now ${current.name})` : ''}</span>
          </span>
        </label>
        {models.map((m) => {
          const ok = ready(m);
          const speed: SpeedResult | undefined = lastSpeed(m.id, detailFor(m));
          const zip = m.zip ?? DEPTH_ZIPS[m.id];
          const fellBack = choice.model === m.id && inUse?.model && inUse.model !== m.id;
          return (
            <label key={m.id} className={`depth-model${choice.model === m.id ? ' on' : ''}${ok ? '' : ' off'}`}
              title={m.folder ? `Folder: ${m.folder}` : undefined}>
              <input type="radio" name="depth-model" disabled={!ok} checked={choice.model === m.id} onChange={() => save({ depthModel: m.id })} />
              <span className="depth-model-text">
                <b>{m.name}</b>
                <span className="faint">
                  {m.model}{ABOUT[m.id] ? ` · ${ABOUT[m.id]}` : ''}{ok && m.sizeBytes ? ` · ${sizeText(m.sizeBytes)}` : ''}
                </span>
                {!m.installed ? (
                  <span className="faint">Not installed{zip ? `: get ${zip} from the Releases page and unzip it next to the app.` : '.'}</span>
                ) : m.problem ? (
                  <span className="depth-model-problem">{m.problem}</span>
                ) : null}
                {fellBack && <span className="depth-model-problem">Can't be used right now, so {current?.name ?? 'another model'} is used instead.</span>}
                {speedTests && ok && (speed || speedErr[m.id]) && (
                  <span className={speedErr[m.id] ? 'depth-model-problem' : 'depth-model-speed'}>
                    {speedErr[m.id] || (speed && `${speedText(speed)}${m.dynamic ? ` (${detailFor(m) === 'high' ? 'high detail' : 'standard detail'})` : ''}`)}
                  </span>
                )}
              </span>
              {speedTests && ok && (
                <button type="button" className="btn btn-sm" disabled={!!testing}
                  title="Runs the model a few times on a made-up picture to see how fast it is on this PC"
                  onClick={(e) => {
                    e.preventDefault(); // inside the label: don't pick the model too
                    void runTest(m);
                  }}>
                  {testing === m.id ? 'Testing…' : 'Test speed'}
                </button>
              )}
            </label>
          );
        })}
      </div>

      <div className="depth-detail">
        <span>Detail</span>
        <div role="radiogroup" aria-label="Detail" className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          {(['standard', 'high'] as const).map((d) => (
            <label key={d} className="check" style={{ minHeight: 32 }}>
              <input type="radio" name="depth-detail" checked={choice.detail === d} disabled={!inUse?.dynamic}
                onChange={() => save({ depthDetail: d })} />
              {d === 'standard' ? 'Standard' : 'High (more detail, about twice as slow)'}
            </label>
          ))}
        </div>
        {inUse && !inUse.available && <span className="faint" style={{ fontSize: 12 }}>Needs a depth model installed first.</span>}
        {inUse?.available && !inUse.dynamic && (
          <span className="faint" style={{ fontSize: 12 }}>{inUse.modelName ?? 'This model'} always works at one size ({inUse.inputSide ?? 518} px), so there's no detail choice.</span>
        )}
      </div>
    </div>
  );
}
