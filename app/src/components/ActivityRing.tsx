// The background-jobs ring: sits at the bottom of the sidebar, only while
// something runs, and fades away a few seconds after everything finished.
// Click it for a small list of the jobs with their bars and a way to stop
// each one that can be stopped. It never covers the grid unless opened, and
// the open list closes on any click elsewhere (that click still goes through).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { inTauri } from '../api';
import {
  countText, demoJobs, formatLeft, jobFraction, listenForJobs, overall, secondsLeft, setNotifyWhenDone, useJobs, visibleJobs, type Job,
} from '../jobs';
import { CloseIcon, PauseIcon } from './Icons';

let demoStarted = false;

export function ActivityRing(props: { notify?: boolean; rail?: boolean }) {
  const all = useJobs();
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

  useEffect(() => {
    if (!shown.length && open) setOpen(false);
  }, [shown.length, open]);

  // Place the list above the ring (fixed, so the sidebar's scrolling can't clip it).
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      setAt({ left: Math.max(8, r.left - 4), bottom: window.innerHeight - r.top + 10 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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

  if (!shown.length) return null;

  const pct = Math.round(frac * 100);
  const lead = running[0] ?? shown[shown.length - 1];
  const caption = allDone ? (failed ? 'Something stopped' : 'All done') : running.length > 1 ? `${running.length} jobs running` : lead.label;
  const label = allDone ? caption : `Background jobs: ${running.length} running${unknown ? '' : `, ${pct}%`}`;

  return (
    <div className={`jobring-wrap${props.rail ? ' rail' : ''}${allDone ? ' fading' : ''}`}>
      <button ref={btn} type="button" className={`jobring${open ? ' open' : ''}`} aria-label={label} aria-expanded={open}
        title={props.rail ? `${caption}${allDone || unknown ? '' : ` · ${pct}%`}` : undefined} onClick={() => setOpen((o) => !o)}>
        <Ring frac={frac} unknown={unknown} done={allDone} failed={failed} />
        {running.length > 1 && <span className="jobring-n" aria-hidden="true">{running.length}</span>}
        {!props.rail && (
          <span className="jobring-text">
            <span className="ellipsis">{caption}</span>
            {!allDone && !unknown && <span className="jobring-pct">{pct}%</span>}
          </span>
        )}
      </button>
      {open && at && (
        <div ref={pop} className="jobpop" role="dialog" aria-label="Background jobs" style={{ left: at.left, bottom: at.bottom }}>
          <div className="jobpop-head">
            <b>Background jobs</b>
            <span className="faint">{running.length ? `${running.length} running` : 'all finished'}</span>
          </div>
          {shown.map((j) => <JobRow key={j.id} j={j} now={now} />)}
        </div>
      )}
    </div>
  );
}

function JobRow({ j, now }: { j: Job; now: number }) {
  const f = jobFraction(j);
  const left = j.endedAt ? '' : formatLeft(secondsLeft(j, now));
  const state = j.endedAt ? (j.failed ? 'Stopped' : 'Done') : countText(j);
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
