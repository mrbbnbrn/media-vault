// The live status line under "Change on the beat" (Timing panel): which
// sound output the app listens to, how loud, the tempo and a dot on every
// beat, or plainly why it can't hear anything. "Details" shows the format,
// the Windows volume and what happened lately, for when something is off.

import { useState } from 'react';
import { beatStatusText, useBeatSync } from '../beats';

const noop = () => {};

export function BeatStatusLine({ on }: { on: boolean }) {
  const b = useBeatSync({ enabled: on, everyBeats: 1, minSeconds: 0, onAdvance: noop });
  const [details, setDetails] = useState(false);
  if (!on) return null;
  const { text, problem } = beatStatusText(b);
  const st = b.status;
  const hearing = !problem && st?.state === 'listening' && st.receiving;
  const bars = Math.round(Math.max(0, Math.min(1, b.level)) * 5);
  const lowVolume = st?.volume != null && st.volume < 0.1 && !st.muted;
  return (
    <div className={`beat-status${problem ? ' problem' : ''}`} role="status">
      <div className="beat-status-row">
        {!problem && (
          <span className="beat-bars" aria-label={`Level ${Math.round(b.level * 100)}%`}>
            {[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= bars ? 'on' : ''} />)}
          </span>
        )}
        <span className="beat-status-text">{text}</span>
        {hearing && <span className="faint">· {b.bpm ? `${Math.round(b.bpm)} BPM` : 'finding the beat…'}</span>}
        {hearing && (
          <span className="beat-dot-wrap" title="Flashes on every beat">
            · beats: <span key={b.pulse} className={`beat-dot${b.pulse ? ' hit' : ''}`} />
          </span>
        )}
        {(st || b.error) && (
          <button type="button" className="linkish" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
            {details ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
      {lowVolume && <div className="faint beat-tip">The Windows volume is very low ({Math.round((st?.volume ?? 0) * 100)}%), so beats may be missed.</div>}
      {details && (
        <div className="beat-details">
          {st?.format && <div>Sound: {st.format}</div>}
          {st?.volume != null && <div>Windows volume: {Math.round(st.volume * 100)}%{st.muted ? ' (muted)' : ''}</div>}
          {b.error && <div>Start: {b.error}</div>}
          {(st?.log ?? []).map((l, i) => <div key={i} className="faint">{l}</div>)}
        </div>
      )}
    </div>
  );
}
