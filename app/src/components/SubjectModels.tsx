// The subject outline model chooser for Lift-off and Living subject (Settings
// → Faces & smart search → 3D photos, and the viewer's View ▾ → "3D photo
// settings…"): Automatic, Fast or Best; the ones not installed are greyed
// with the download they come in, and in Settings a speed test per model.

import { useEffect, useState } from 'react';
import { api, type SubjectInfo, type SubjectModel, type ViewerSettings } from '../api';
import { speedText } from '../depth';
import { lastSubjectSpeed, SUBJECT_ZIPS, subjectChoice, subjectPack, testSubjectSpeed } from '../subject';
import { saveViewerPrefs, useViewerPrefs } from '../prefs';

function sizeText(b: number): string {
  if (!b) return '';
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
}

const ABOUT: Record<string, string> = {
  'birefnet-lite': 'quicker, fine on most PCs',
  birefnet: 'the cleanest outlines (hair, fingers), needs a good graphics card',
};

/** `value` / `onChange`: the settings to show and change (Settings passes its own copy); `speedTests` adds "Test speed". */
export function SubjectModelChoice(props: { value?: ViewerSettings; onChange?: (patch: Partial<ViewerSettings>) => void; speedTests?: boolean }) {
  const shared = useViewerPrefs();
  const choice = subjectChoice(props.value ?? shared);
  const save = props.onChange ?? ((p: Partial<ViewerSettings>) => void saveViewerPrefs(p));
  const speedTests = !!props.speedTests;
  const [models, setModels] = useState<SubjectModel[] | null>(null);
  const [inUse, setInUse] = useState<SubjectInfo | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [speedErr, setSpeedErr] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api.subjectModels().then((m) => alive && setModels(m)).catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    subjectPack(true, choice).then((i) => alive && setInUse(i));
    return () => {
      alive = false;
    };
  }, [choice]);

  if (!models) return null;
  const ready = (m: SubjectModel) => m.installed && !m.problem;
  const current = models.find((m) => m.id === inUse?.model);

  const runTest = async (m: SubjectModel) => {
    setTesting(m.id);
    setSpeedErr((e) => ({ ...e, [m.id]: '' }));
    try {
      await testSubjectSpeed(m.id);
    } catch (e) {
      setSpeedErr((x) => ({ ...x, [m.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setTesting(null);
      setTick((t) => t + 1);
      subjectPack(true, choice).then(setInUse);
    }
  };

  return (
    <div className="depth-models">
      <div role="radiogroup" aria-label="Subject outline model" className="depth-model-list">
        <label className={`depth-model${choice === '' ? ' on' : ''}`}>
          <input type="radio" name="subject-model" checked={choice === ''} onChange={() => save({ subjectModel: '' })} />
          <span className="depth-model-text">
            <b>Automatic</b>
            <span className="faint">The best one installed{choice === '' && current ? ` (now ${current.name})` : ''}</span>
          </span>
        </label>
        {models.map((m) => {
          const ok = ready(m);
          const speed = lastSubjectSpeed(m.id);
          const zip = m.zip ?? SUBJECT_ZIPS[m.id];
          const fellBack = choice === m.id && inUse?.model && inUse.model !== m.id;
          return (
            <label key={m.id} className={`depth-model${choice === m.id ? ' on' : ''}${ok ? '' : ' off'}`} title={m.folder ? `Folder: ${m.folder}` : undefined}>
              <input type="radio" name="subject-model" disabled={!ok} checked={choice === m.id} onChange={() => save({ subjectModel: m.id })} />
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
                  <span className={speedErr[m.id] ? 'depth-model-problem' : 'depth-model-speed'}>{speedErr[m.id] || (speed && speedText(speed))}</span>
                )}
              </span>
              {speedTests && ok && (
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
      {inUse && !inUse.available && <span className="faint" style={{ fontSize: 12 }}>Needs a subject outline model installed first.</span>}
    </div>
  );
}
