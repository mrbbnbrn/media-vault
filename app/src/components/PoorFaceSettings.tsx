// Settings → Faces → Poor faces: where "too small, too blurry, too turned"
// starts. Faces are judged when they're shown, so moving a slider re-sorts
// every face at once: nothing is scanned again and no name is lost.

import type { PoorFaceSettings } from '../api';
import { blurWords, poorSettings } from '../poorfaces';
import './poorfaces.css';

export function PoorFaceSettingsView(props: { value: PoorFaceSettings | undefined; onChange: (next: PoorFaceSettings) => void }) {
  const v = poorSettings(props.value);
  const set = (patch: Partial<PoorFaceSettings>) => props.onChange({ ...v, ...patch });
  return (
    <section className="section poor-settings">
      <h2>Poor faces</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        Faces that are too small, too blurry or turned too far away can't be recognised reliably. They're never named on their own
        and never used to learn what someone looks like — unless you name one yourself. People lists them under <b>Poor faces</b>;
        the viewer shows them when you choose <b>Show poor faces too</b>. Changes apply straight away, without scanning again.
      </p>
      <div className="setting">
        <div className="text">
          <label className="title" htmlFor="poor-px">Smallest face · {v.minPx ? `${v.minPx} px tall` : 'off'}</label>
          <span className="desc">Faces shorter than this (in the photo's own pixels) are poor.</span>
        </div>
        <input id="poor-px" type="range" min={0} max={200} step={5} value={v.minPx} onChange={(e) => set({ minPx: Number(e.target.value) })} />
      </div>
      <div className="setting">
        <div className="text">
          <label className="title" htmlFor="poor-blur">Blur · {v.blur ? `${v.blur} — ${blurWords(v.blur)}` : 'off'}</label>
          <span className="desc">How sharp a face must be, from 0 (anything goes) to 100 (only crisp faces).</span>
        </div>
        <input id="poor-blur" type="range" min={0} max={95} step={1} value={v.blur} onChange={(e) => set({ blur: Number(e.target.value) })} />
      </div>
      <div className="setting">
        <div className="text">
          <label className="title" htmlFor="poor-turn">Turned away · {v.turn >= 90 ? 'off' : `more than ${v.turn}°`}</label>
          <span className="desc">0° looks straight at the camera, 90° is side on.</span>
        </div>
        <input id="poor-turn" type="range" min={15} max={90} step={5} value={v.turn} onChange={(e) => set({ turn: Number(e.target.value) })} />
      </div>
    </section>
  );
}
