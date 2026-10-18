// Layered 3D's "Background fill" chooser (the viewer's View ▾ → "3D photo
// settings…", and Settings → Faces & smart search): Simple (no download),
// MI-GAN or LaMa (optional downloads; the ones not installed are greyed with
// the download they come in), and in Settings a speed test per model.

import { useEffect, useState } from 'react';
import { FitWarning, useModelFit } from './ModelFit';
import { api, type InpaintModel, type ViewerSettings } from '../api';
import { speedText } from '../depth';
import { INPAINT_ZIPS, inpaintChoice, inpaintPack, lastInpaintSpeed, testInpaintSpeed } from '../inpaint';
import { saveViewerPrefs, useViewerPrefs } from '../prefs';

function sizeText(b: number): string {
  if (!b) return '';
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
}

const ABOUT: Record<string, string> = {
  migan: 'quick, good on most backgrounds',
  lama: 'the most convincing fill (large areas, patterns), slower',
};

/** `value` / `onChange`: the settings to show and change (Settings passes its own copy); `speedTests` adds "Test speed". */
export function InpaintModelChoice(props: { value?: ViewerSettings; onChange?: (patch: Partial<ViewerSettings>) => void; speedTests?: boolean }) {
  const shared = useViewerPrefs();
  const choice = inpaintChoice(props.value ?? shared);
  const save = props.onChange ?? ((p: Partial<ViewerSettings>) => void saveViewerPrefs(p));
  const fit = useModelFit();
  const [models, setModels] = useState<InpaintModel[] | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api.inpaintModels().then((m) => alive && setModels(m)).catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, []);
  if (!models) return null;
  const ready = (m: InpaintModel) => m.installed && !m.problem;
  const runTest = async (m: InpaintModel) => {
    setTesting(m.id);
    setErr((e) => ({ ...e, [m.id]: '' }));
    try {
      await testInpaintSpeed(m.id);
    } catch (e) {
      setErr((x) => ({ ...x, [m.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setTesting(null);
      setTick((t) => t + 1);
      void inpaintPack(m.id, true);
    }
  };
  return (
    <div className="depth-models">
      <div role="radiogroup" aria-label="Background fill" className="depth-model-list">
        <label className={`depth-model${choice === '' ? ' on' : ''}`}>
          <input type="radio" name="inpaint-model" checked={choice === ''} onChange={() => save({ inpaintModel: '' })} />
          <span className="depth-model-text">
            <b>Simple</b>
            <span className="faint">No download · the surrounding colours are pulled in (soft, fine for plain backgrounds)</span>
          </span>
        </label>
        {models.map((m) => {
          const ok = ready(m);
          const zip = m.zip ?? INPAINT_ZIPS[m.id];
          const speed = lastInpaintSpeed(m.id);
          return (
            <label key={m.id} className={`depth-model${choice === m.id ? ' on' : ''}${ok ? '' : ' off'}`} title={m.folder ? `Folder: ${m.folder}` : undefined}>
              <input type="radio" name="inpaint-model" disabled={!ok} checked={choice === m.id} onChange={() => save({ inpaintModel: m.id as 'migan' | 'lama' })} />
              <span className="depth-model-text">
                <b>{m.name}</b>
                <span className="faint">{m.model}{ABOUT[m.id] ? ` · ${ABOUT[m.id]}` : ''}{ok && m.sizeBytes ? ` · ${sizeText(m.sizeBytes)}` : ''}</span>
                {!m.installed ? (
                  <span className="faint">Not installed{zip ? `: get ${zip} from the Releases page and unzip it next to the app.` : '.'}</span>
                ) : m.problem ? (
                  <span className="depth-model-problem">{m.problem}</span>
                ) : null}
                {ok && <FitWarning fit={fit} model={m.id} show={choice === m.id} />}
                {props.speedTests && ok && (speed || err[m.id]) && (
                  <span className={err[m.id] ? 'depth-model-problem' : 'depth-model-speed'}>{err[m.id] || (speed && speedText(speed))}</span>
                )}
              </span>
              {props.speedTests && ok && (
                <button type="button" className="btn btn-sm" disabled={!!testing}
                  title="Runs the model a few times on a made-up picture to see how fast it is on this PC"
                  onClick={(e) => {
                    e.preventDefault();
                    void runTest(m);
                  }}>
                  {testing === m.id ? 'Testing…' : 'Test speed'}
                </button>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
