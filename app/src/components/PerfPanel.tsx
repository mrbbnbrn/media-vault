// The timing panel (Ctrl+Shift+T): how long things took on this PC, slow
// presses, freezes, the busiest backend calls and messages, and what was
// running in the background at each moment (perf.ts). "Copy report" puts it
// all on the clipboard as text.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { callStats, clearPerf, eventRates, onPerfChange, perfEntries, perfReport, perfVersion, type PerfKind } from '../perf';

const TABS: { id: PerfKind | 'calls'; label: string; hint: string }[] = [
  { id: 'step', label: 'Steps', hint: 'Unlocking, opening a folder, its first thumbnails, opening a picture' },
  { id: 'press', label: 'Slow presses', hint: 'Clicks and keys that took 80 ms or more until the screen answered' },
  { id: 'freeze', label: 'Freezes', hint: 'Moments the window could not draw for 100 ms or more, and the code that ran' },
  { id: 'calls', label: 'Backend', hint: 'Calls to the app’s own engine and the messages it sends, busiest first' },
];

function tone(ms: number, kind: PerfKind | 'calls') {
  const [ok, slow] = kind === 'step' ? [400, 1500] : kind === 'press' ? [120, 300] : [150, 400];
  return ms < ok ? 'ok' : ms < slow ? 'meh' : 'bad';
}

export function PerfPanel({ onClose }: { onClose: () => void }) {
  useSyncExternalStore(onPerfChange, perfVersion);
  const [tab, setTab] = useState<PerfKind | 'calls'>('step');
  const [copied, setCopied] = useState(false);
  // Message rates change without new entries: look again every second.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const list = tab === 'calls' ? [] : perfEntries().filter((e) => e.kind === tab).slice(-80).reverse();
  const calls = tab === 'calls' ? callStats().sort((a, b) => b.totalMs - a.totalMs).slice(0, 30) : [];
  const rates = tab === 'calls' ? eventRates().slice(0, 12) : [];
  const copy = () => {
    navigator.clipboard.writeText(perfReport()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  };
  return (
    <div className="perf-panel" role="region" aria-label="Timing panel" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="perf-head">
        <b>Where did the time go</b>
        <span className="faint">Ctrl+Shift+T</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="link" onClick={copy}>{copied ? 'Copied' : 'Copy report'}</button>
        <button type="button" className="link" onClick={clearPerf}>Clear</button>
        <button type="button" className="btn btn-icon btn-sm" aria-label="Close timing panel" onClick={onClose}>×</button>
      </div>
      <div className="perf-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} title={t.hint} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="perf-body">
        {tab !== 'calls' && !list.length && <p className="faint">Nothing yet. {TABS.find((t) => t.id === tab)?.hint}.</p>}
        {list.map((e, i) => (
          <div key={`${e.at}-${i}`} className="perf-row">
            <span className={`perf-ms ${tone(e.ms, e.kind)}`}>{e.ms.toLocaleString()} ms</span>
            <span className="perf-what">
              <span>{e.name}</span>
              {e.detail && <span className="faint"> · {e.detail}</span>}
              {e.jobs.length > 0 && <span className="perf-jobs">while: {e.jobs.join(', ')}</span>}
            </span>
            <span className="faint perf-at">{new Date(e.at).toLocaleTimeString()}</span>
          </div>
        ))}
        {tab === 'calls' && (
          <>
            <div className="perf-sub">Calls (most total time first)</div>
            {!calls.length && <p className="faint">No calls yet.</p>}
            {calls.map((c) => (
              <div key={c.name} className="perf-row">
                <span className={`perf-ms ${tone(c.totalMs / c.count, 'call')}`}>{Math.round(c.totalMs / c.count)} ms</span>
                <span className="perf-what"><span>{c.name}</span><span className="faint"> · {c.count}× · slowest {Math.round(c.maxMs)} ms</span></span>
              </div>
            ))}
            <div className="perf-sub">Messages from the backend, per second</div>
            {!rates.length && <p className="faint">None in the last 10 seconds.</p>}
            {rates.map((r) => (
              <div key={r.name} className="perf-row">
                <span className={`perf-ms ${r.perSec > 20 ? 'bad' : r.perSec > 5 ? 'meh' : 'ok'}`}>{r.perSec.toFixed(1)}/s</span>
                <span className="perf-what"><span>{r.name}</span></span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
