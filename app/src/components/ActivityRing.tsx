// The background-jobs ring: in the title bar, so it shows on every screen
// (library, viewer, settings…) while something runs, and fades to a faint
// ring once everything finished. Click it for a small list of the jobs with
// their bars and a way to stop each one that can be stopped, "Pause background
// work" (thumbnails, previews, faces… wait until resumed), and
// what finished recently with its result. The open list closes on any click
// elsewhere (that click still goes through).

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { inTauri } from '../api';
import { backgroundPaused, onBackgroundPause, setBackgroundPaused } from '../bgpace';
import {
  countText, demoJobs, formatLeft, jobFraction, listenForJobs, overall, secondsLeft, setNotifyWhenDone, useJobs, useRecentJobs, visibleJobs, type DoneJob, type Job,
} from '../jobs';
import { CloseIcon, PauseIcon } from './Icons';
import { useLayer } from '../keylayers';

let demoStarted = false;

/** The jobs "Pause background work" holds (they wait between items, bgpace.ts). */
const BACKGROUND = /^(thumbs|previews|fingerprints|sharpen|thumbWebp|faces|prepare)/;
const usePaused = () => useSyncExternalStore(onBackgroundPause, backgroundPaused);
const ago = (at: number, now: number) => {
  const m = Math.round((now - at) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function ActivityRing(props: { notify?: boolean; rail?: boolean; titlebar?: boolean }) {
  const all = useJobs();
  const recent = useRecentJobs();
  const paused = usePaused();
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    listenForJobs();
    if (!inTauri && !demoStarted && /[?&]jobs\b/.test(window.location.search)) {
      demoStarted = true;
      demoJobs();
    }
  }, []);
  useEffect(() => setNotifyWhenDone(props.notify !== false), [props.notify]);

  const any = all.length > 0;
  useEffect(() => {
    if (!any) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [any]);

  const shown = visibleJobs(all, Math.max(now, Date.now() - 1000));
  const running = shown.filter((j) => !j.endedAt);
  const allDone = shown.length > 0 && running.length === 0;
  const failed = shown.some((j) => j.failed);
  const frac = allDone ? 1 : overall(running);
  const unknown = running.length > 0 && running.every((j) => jobFraction(j) == null);

  // In the title bar it stays (faint) while there is something to look back at.
  const idle = !shown.length;
  const keep = props.titlebar && (recent.length > 0 || paused);
  useEffect(() => {
    if (idle && !keep && open) setOpen(false);
  }, [idle, keep, open]);

  // Place the list above the ring (fixed, so the sidebar's scrolling can't clip it).
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      // Title bar: below the ring, kept inside the window; sidebar: above it.
      if (props.titlebar) setAt({ left: Math.max(8, Math.min(window.innerWidth - 328, r.left - 140)), bottom: -(r.bottom + 8) });
      else setAt({ left: Math.max(8, r.left - 4), bottom: window.innerHeight - r.top + 10 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  // While open, a layer (keylayers.ts): Esc closes it, nothing behind reacts.
  const ringLayer = useLayer(open, { name: 'background jobs', onBack: () => setOpen(false) });
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ringLayer.mine()) {
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  if (idle && !keep) return null;

  const pct = Math.round(frac * 100);
  const lead = running[0] ?? shown[shown.length - 1];
  const caption = idle ? (paused ? 'Background work paused' : 'Nothing running') : allDone ? (failed ? 'Something stopped' : 'All done') : running.length > 1 ? `${running.length} jobs running` : lead.label;
  const label = idle || allDone ? `Background jobs: ${caption}` : `Background jobs: ${running.length} running${unknown ? '' : `, ${pct}%`}${paused ? ' (background work paused)' : ''}`;

  return (
    <div className={`jobring-wrap${props.rail || props.titlebar ? ' rail' : ''}${props.titlebar ? ' in-titlebar' : ''}${allDone && !props.titlebar ? ' fading' : ''}${idle ? ' idle' : ''}`}>
      <button ref={btn} type="button" className={`jobring${open ? ' open' : ''}${paused ? ' paused' : ''}`} aria-label={label} aria-expanded={open} tabIndex={props.titlebar ? -1 : undefined}
        title={props.rail || props.titlebar ? `${caption}${allDone || unknown || idle ? '' : ` · ${pct}%`}` : undefined} onClick={() => setOpen((o) => !o)}>
        <Ring frac={idle ? 1 : frac} unknown={unknown && !paused} done={allDone || (idle && !paused)} failed={failed && !idle} />
        {running.length > 1 && <span className="jobring-n" aria-hidden="true">{running.length}</span>}
        {!props.rail && !props.titlebar && (
          <span className="jobring-text">
            <span className="ellipsis">{caption}</span>
            {!allDone && !unknown && <span className="jobring-pct">{pct}%</span>}
          </span>
        )}
      </button>
      {open && at && (
        <div ref={pop} className="jobpop" role="dialog" aria-label="Background jobs" style={at.bottom < 0 ? { left: at.left, top: -at.bottom } : { left: at.left, bottom: at.bottom }}>
          <div className="jobpop-head">
            <b>Background jobs</b>
            <span className="faint">{running.length ? `${running.length} running` : shown.length ? 'all finished' : 'nothing running'}</span>
          </div>
          <button type="button" className={`btn btn-sm${paused ? ' accent-soft' : ''}`} aria-pressed={paused}
            title="Thumbnails, preview clips, face scanning, fingerprints and 3D preparing wait until you resume. Imports, exports and other jobs you started keep going."
            onClick={() => setBackgroundPaused(!paused)}>
            <PauseIcon size={12} /> {paused ? 'Resume background work' : 'Pause background work'}
          </button>
          {shown.map((j) => <JobRow key={j.id} j={j} now={now} paused={paused} />)}
          {recent.length > 0 && (
            <div className="jobpop-recent">
              <span className="faint">Recently finished</span>
              {recent.map((d) => <RecentRow key={`${d.id}-${d.at}`} d={d} now={now} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecentRow({ d, now }: { d: DoneJob; now: number }) {
  return (
    <div className={`jobrecent${d.failed ? ' failed' : ''}`}>
      <span>{d.summary}</span>
      <span className="faint mono">{ago(d.at, now)}</span>
    </div>
  );
}

function JobRow({ j, now, paused }: { j: Job; now: number; paused: boolean }) {
  const f = jobFraction(j);
  const left = j.endedAt ? '' : paused && BACKGROUND.test(j.id) ? '' : formatLeft(secondsLeft(j, now));
  const state = j.endedAt ? (j.failed ? 'Stopped' : 'Done') : paused && BACKGROUND.test(j.id) ? 'Paused' : countText(j);
  return (
    <div className={`jobrow${j.endedAt ? ' ended' : ''}${j.failed ? ' failed' : ''}`}>
      <div className="jobrow-top">
        <span className="ellipsis">
          {j.label}
          {j.detail && <span className="faint"> · {j.detail}</span>}
        </span>
        {j.cancel && (
          <button type="button" className="jobrow-x" title={j.cancelLabel ?? 'Cancel'} aria-label={`${j.cancelLabel ?? 'Cancel'} ${j.label.toLowerCase()}`} onClick={j.cancel}>
            {j.cancelLabel === 'Pause' ? <PauseIcon size={12} /> : <CloseIcon size={12} />}
          </button>
        )}
      </div>
      <div className={`bar${f == null ? ' indef' : ''}`}><div style={f == null ? undefined : { width: `${f * 100}%` }} /></div>
      <div className="jobrow-meta mono">
        <span>{state}</span>
        <span>{left}</span>
      </div>
    </div>
  );
}

function Ring({ frac, unknown, done, failed }: { frac: number; unknown: boolean; done: boolean; failed: boolean }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`jring${unknown ? ' spin' : ''}${failed && done ? ' failed' : ''}`} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={r} className="jring-track" />
      <circle cx="12" cy="12" r={r} className="jring-arc" strokeDasharray={c} strokeDashoffset={unknown ? c * 0.72 : c * (1 - Math.max(0.03, frac))} transform="rotate(-90 12 12)" />
      {done && (failed ? <path d="M9 9l6 6M15 9l-6 6" className="jring-mark" /> : <path d="M8.2 12.3l2.5 2.5 5-5.3" className="jring-mark" />)}
    </svg>
  );
}
