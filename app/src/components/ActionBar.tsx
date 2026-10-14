// The slim bar at the bottom of the library: what is selected and what you can
// do with it. Buttons that don't fit go into a "⋯" menu that opens upwards.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Dropdown } from './Dialogs';

export interface BarAction {
  key: string;
  label: string;
  icon?: ReactNode;
  title?: string;
  danger?: boolean;
  /** Always shown at the right end, never moved into the "⋯" menu. */
  pinned?: boolean;
  onClick: () => void;
}

const GAP = 6;
const MORE_W = 40;

export function ActionBar(props: { summary: ReactNode; actions: BarAction[]; end?: ReactNode }) {
  const area = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const flowing = props.actions.filter((a) => !a.pinned);
  const pinned = props.actions.filter((a) => a.pinned);
  const [fit, setFit] = useState(flowing.length);
  const sig = flowing.map((a) => a.key + a.label).join('|');

  useLayoutEffect(() => {
    const calc = () => {
      const a = area.current;
      const m = measure.current;
      if (!a || !m) return;
      const avail = a.clientWidth;
      const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth + GAP);
      const total = widths.reduce((x, y) => x + y, 0);
      if (total <= avail) return setFit(widths.length);
      let n = 0;
      let used = MORE_W;
      while (n < widths.length && used + widths[n] <= avail) used += widths[n++];
      setFit(n);
    };
    calc();
    const ro = new ResizeObserver(calc);
    if (area.current) ro.observe(area.current);
    return () => ro.disconnect();
  }, [sig]);

  const button = (a: BarAction) => (
    <button key={a.key} type="button" className={`btn btn-sm${a.danger ? ' btn-danger' : ''}`} title={a.title} onClick={a.onClick}>
      {a.icon}{a.label}
    </button>
  );
  const hidden = flowing.slice(fit);
  return (
    <div className="actbar" role="toolbar" aria-label="Selection">
      <span className="actbar-sum ellipsis">{props.summary}</span>
      <div className="actbar-acts" ref={area}>
        <div className="actbar-measure" ref={measure} aria-hidden="true">{flowing.map(button)}</div>
        {flowing.slice(0, fit).map(button)}
        {hidden.length > 0 && (
          <Dropdown up className="btn btn-sm" ariaLabel="More actions" title="More actions" label="⋯"
            items={hidden.map((a) => ({ label: a.label, danger: a.danger, onSelect: a.onClick }))} />
        )}
      </div>
      {pinned.map(button)}
      {props.end}
    </div>
  );
}
