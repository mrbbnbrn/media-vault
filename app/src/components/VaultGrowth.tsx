// How the vault grew: a chart of stored size by month (Statistics page) and
// a small sparkline (Settings → Storage). Hand-made SVG in the app's colours.
// Two panels on one time axis instead of two y-scales on one chart: stored
// size (running total) on top, files added per month below.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { jobsApi, type Growth, type GrowthMonth } from '../api';
import { formatBytes } from '../theme';

function useGrowth(): [Growth | null, string | null] {
  const [g, setG] = useState<Growth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    jobsApi.vaultGrowth().then(setG).catch((e) => setErr(String(e)));
  }, []);
  return [g, err];
}

const monthName = (m: string, long = false) => {
  const [y, mo] = m.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, long ? { month: 'long', year: 'numeric' } : { month: 'short', year: '2-digit' }).format(new Date(y, mo - 1, 1));
};

const many = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;

export function grewText(g: Growth): string {
  return g.last30Bytes > 0 ? `grew ${formatBytes(g.last30Bytes)} in the last 30 days` : 'nothing added in the last 30 days';
}

/** Round axis steps (1, 2, 2.5, 5 × 10ⁿ) for 0…max. */
export function niceTicks(max: number, count = 3): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    setW(Math.floor(ref.current.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---- the Statistics chart -------------------------------------------------------------------

const SHOW_MONTHS = 36;

export function GrowthChart() {
  const [g, err] = useGrowth();
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (err) return null;
  const months: GrowthMonth[] = g ? g.months.slice(-SHOW_MONTHS) : [];

  const L = 64;
  const R = 14;
  const TOP_H = 168;
  const GAP = 40;
  const BAR_H = 84;
  const AXIS = 22;
  const H = TOP_H + GAP + BAR_H + AXIS;
  const W = Math.max(280, width);
  const plotW = W - L - R;
  const n = months.length;
  const step = n ? plotW / n : plotW;
  const cx = (i: number) => L + step * (i + 0.5);

  const maxBytes = Math.max(1, ...months.map((m) => m.totalBytes));
  const sizeTicks = niceTicks(maxBytes);
  const sizeTop = sizeTicks[sizeTicks.length - 1];
  const ySize = (b: number) => 8 + (TOP_H - 8) * (1 - b / sizeTop);
  const maxItems = Math.max(1, ...months.map((m) => m.items));
  const itemTicks = niceTicks(maxItems, 2);
  const itemTop = itemTicks[itemTicks.length - 1];
  const barTop = TOP_H + GAP;
  const yItems = (k: number) => barTop + BAR_H * (1 - k / itemTop);

  const line = months.map((m, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${ySize(m.totalBytes).toFixed(1)}`).join('');
  const area = n ? `${line}L${cx(n - 1).toFixed(1)},${TOP_H}L${cx(0).toFixed(1)},${TOP_H}Z` : '';
  const labelEvery = Math.max(1, Math.ceil(64 / step));
  const barW = Math.max(2, Math.min(28, step * 0.62));
  const h = hover != null ? months[hover] : null;

  return (
    <section className="spanel growth">
      <div className="growth-head">
        <h2>Vault size over time</h2>
        {g && g.months.length > 0 && (
          <span className="faint">
            <b className="growth-total">{formatBytes(g.totalBytes)}</b> in {many(g.totalItems, 'file')} · {grewText(g)}
          </span>
        )}
      </div>
      <div ref={box} className="growth-plot" onPointerLeave={() => setHover(null)}>
        {!g && <div className="faint" style={{ height: H }}>Counting…</div>}
        {g && n === 0 && <p className="faint" style={{ margin: 0 }}>Nothing stored yet.</p>}
        {g && n > 0 && width > 0 && (
          <svg width={W} height={H} role="img" aria-label={`Stored size by month: ${formatBytes(g.totalBytes)} now, ${grewText(g)}.`}>
            <defs>
              <linearGradient id="growth-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {/* stored size */}
            {sizeTicks.map((t) => (
              <g key={`s${t}`}>
                <line x1={L} x2={W - R} y1={ySize(t)} y2={ySize(t)} className="growth-grid" />
                <text x={L - 8} y={ySize(t) + 4} className="growth-y">{t === 0 ? '0' : formatBytes(t)}</text>
              </g>
            ))}
            <path d={area} fill="url(#growth-fill)" />
            <path d={line} className="growth-line" />
            <text x={L} y={2} className="growth-panel" dominantBaseline="hanging">Stored</text>
            {/* files added */}
            {itemTicks.map((t) => (
              <g key={`i${t}`}>
                <line x1={L} x2={W - R} y1={yItems(t)} y2={yItems(t)} className="growth-grid" />
                <text x={L - 8} y={yItems(t) + 4} className="growth-y">{t.toLocaleString()}</text>
              </g>
            ))}
            <text x={L} y={barTop - 16} className="growth-panel" dominantBaseline="hanging">Files added</text>
            {months.map((m, i) => {
              const y = yItems(m.items);
              const base = barTop + BAR_H;
              const r = Math.min(3, barW / 2, base - y);
              const a = cx(i) - barW / 2;
              const b = cx(i) + barW / 2;
              return m.items > 0 ? (
                <path key={m.month} className={`growth-bar${hover === i ? ' on' : ''}`}
                  d={`M${a},${base}V${y + r}Q${a},${y} ${a + r},${y}H${b - r}Q${b},${y} ${b},${y + r}V${base}Z`} />
              ) : null;
            })}
            {/* time axis */}
            {months.map((m, i) =>
              (n - 1 - i) % labelEvery === 0 ? (
                <text key={`x${m.month}`} x={cx(i)} y={H - 6} className="growth-x">{monthName(m.month)}</text>
              ) : null,
            )}
            {h && hover != null && (
              <g pointerEvents="none">
                <line x1={cx(hover)} x2={cx(hover)} y1={8} y2={barTop + BAR_H} className="growth-cross" />
                <circle cx={cx(hover)} cy={ySize(h.totalBytes)} r={4.5} className="growth-dot" />
              </g>
            )}
            {months.map((m, i) => (
              <rect key={`h${m.month}`} x={L + step * i} y={0} width={step} height={barTop + BAR_H} fill="transparent"
                onPointerEnter={() => setHover(i)} onPointerMove={() => hover !== i && setHover(i)} />
            ))}
          </svg>
        )}
        {h && hover != null && (
          <div className="growth-tip" style={{ left: Math.min(Math.max(cx(hover), 90), W - 90), top: Math.max(0, ySize(h.totalBytes) - 12) }}>
            <b>{monthName(h.month, true)}</b>
            <span>Added {many(h.items, 'file')}{h.items ? ` · ${formatBytes(h.bytes)}` : ''}</span>
            <span className="faint">Vault {formatBytes(h.totalBytes)} · {many(h.totalItems, 'file')}</span>
          </div>
        )}
      </div>
      {g && g.months.length > 0 && (
        <p className="faint growth-hint">
          By the month things were added. Free copies share one file, so they count once.
          {g.trashItems > 0 ? ` Includes ${formatBytes(g.trashBytes)} in the trash: it takes space until the trash is emptied.` : ' Items in the trash count until it is emptied.'}
        </p>
      )}
    </section>
  );
}

// ---- the Settings sparkline -------------------------------------------------------------------

export function GrowthSpark() {
  const [g] = useGrowth();
  if (!g || g.months.length === 0) return null;
  const months = g.months.slice(-12);
  const W = 140;
  const H = 34;
  const max = Math.max(1, ...months.map((m) => m.totalBytes));
  const min = Math.min(...months.map((m) => m.totalBytes));
  const span = Math.max(1, max - min);
  const x = (i: number) => (months.length === 1 ? W / 2 : 2 + ((W - 4) * i) / (months.length - 1));
  const y = (b: number) => 3 + (H - 6) * (1 - (b - min) / span);
  const d = months.map((m, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(m.totalBytes).toFixed(1)}`).join('');
  const last = months[months.length - 1];
  return (
    <div className="growth-spark" title="Stored size over the last 12 months (Statistics has the full chart)">
      <svg width={W} height={H} aria-hidden="true">
        <path d={`${d}L${x(months.length - 1)},${H}L${x(0)},${H}Z`} className="growth-spark-fill" />
        <path d={d} className="growth-line" />
        <circle cx={x(months.length - 1)} cy={y(last.totalBytes)} r={3} className="growth-dot" />
      </svg>
      <span>
        <b>{formatBytes(g.totalBytes)}</b> stored · {grewText(g)}
      </span>
    </div>
  );
}
