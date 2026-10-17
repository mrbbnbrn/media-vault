// Small modal dialogs and a dropdown menu, kept plain and keyboard-friendly.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { FolderCard } from '../api';
import { FolderIcon } from './Icons';
import { useLayer } from '../keylayers';
import { holdCalm } from '../calm';

let holdN = 0;
/** While `on`, changes from background work wait (an open menu stays as it is). */
function useHoldCalm(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const key = `menu${holdN++}`;
    holdCalm(key, true);
    return () => holdCalm(key, false);
  }, [on]);
}

/** ↑ / ↓ / Home / End move between a menu's items; Esc closes it. True when handled. */
export function menuKeys(e: KeyboardEvent, menu: HTMLElement | null, close: () => void): boolean {
  if (e.key === 'Escape') {
    close();
    return true;
  }
  if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return false;
  const items = [...menu.querySelectorAll<HTMLElement>(':scope > button:not(:disabled), :scope > .menu-item:not(:disabled)')];
  if (!items.length) return true;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
  items[n].focus();
  return true;
}

export function Modal(props: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean;
  /** Keys for the dialog itself (← / → in a preview…): return true when handled. Esc still closes it. */
  onKey?: (e: KeyboardEvent) => boolean | void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A layer: Esc closes it, and keys pressed here never reach what is behind (keylayers.ts).
  useLayer(true, {
    name: `dialog: ${props.title}`, modal: true, el: () => ref.current, onClose: props.onClose,
    onKey: (e) => {
      if (props.onKey?.(e)) return true;
      if (e.key === 'Escape') {
        props.onClose();
        return true;
      }
    },
  });
  useEffect(() => {
    // The marked button first (e.g. Delete in a confirmation), else the first field, else the main button.
    const r = ref.current;
    (r?.querySelector<HTMLElement>('[data-autofocus]') ?? r?.querySelector<HTMLElement>('input, select, button.btn-primary') ?? r)?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref} tabIndex={-1}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

export function PromptDialog(props: {
  title: string;
  label: string;
  initial?: string;
  hint?: ReactNode;
  confirm?: string;
  type?: 'text' | 'password' | 'number';
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [v, setV] = useState(props.initial ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await props.onSubmit(v);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="field">
          <label htmlFor="prompt-input">{props.label}</label>
          <input id="prompt-input" className="input" type={props.type ?? 'text'} value={v} autoFocus
            step={props.type === 'number' ? 'any' : undefined} onChange={(e) => setV(e.target.value)} />
          {props.hint && <span className="faint" style={{ fontSize: 12 }}>{props.hint}</span>}
        </div>
        {err && <div className="error" role="alert">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{props.confirm ?? 'OK'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  /** Label of the other button (default "Cancel"), and what it does (default: just close). */
  cancel?: string;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cancel = props.onCancel ?? props.onClose;
  return (
    <Modal title={props.title} onClose={cancel}>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>{props.children}</div>
      {err && <div className="error" role="alert">{err}</div>}
      {/* The confirm button has the focus: Enter confirms, ← / → switch between the buttons. */}
      <div className="row" style={{ justifyContent: 'flex-end' }} onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const bs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const i = bs.indexOf(document.activeElement as HTMLButtonElement);
        const n = bs[Math.max(0, Math.min(bs.length - 1, (i < 0 ? bs.length - 1 : i) + (e.key === 'ArrowLeft' ? -1 : 1)))];
        if (n) {
          e.preventDefault();
          n.focus();
        }
      }}>
        <button type="button" className="btn" onClick={cancel}>{props.cancel ?? 'Cancel'}</button>
        <button
          type="button"
          className={props.danger ? 'btn btn-danger-solid' : 'btn btn-primary'}
          data-autofocus
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await props.onConfirm();
              props.onClose();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}
        >
          {props.confirm}
        </button>
      </div>
    </Modal>
  );
}

/** Choose a destination folder (or the top level). */
export function FolderPicker(props: {
  title: string;
  folders: FolderCard[];
  exclude?: number[];
  confirm: string;
  topLabel?: string;
  onPick: (folder: number | null) => Promise<void> | void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const excluded = new Set<number>();
  for (const x of props.exclude ?? []) {
    excluded.add(x);
    for (const f of props.folders) if (f.path.some((c) => c.id === x)) excluded.add(f.id);
  }
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <div className="picker" role="listbox" aria-label="Folders">
        <button type="button" role="option" aria-selected={sel === null} className={`picker-row${sel === null ? ' on' : ''}`} onClick={() => setSel(null)}>
          <FolderIcon size={15} /> {props.topLabel ?? 'Top level'}
        </button>
        {props.folders.filter((f) => !excluded.has(f.id)).map((f) => (
          <button type="button" role="option" aria-selected={sel === f.id} key={f.id}
            className={`picker-row${sel === f.id ? ' on' : ''}`} style={{ paddingLeft: 14 + f.depth * 18 }} onClick={() => setSel(f.id)}>
            <FolderIcon size={15} /> {f.name}
          </button>
        ))}
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={async () => {
          try {
            await props.onPick(sel);
            props.onClose();
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          }
        }}>{props.confirm}</button>
      </div>
    </Modal>
  );
}

export interface MenuItem {
  label: string;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider line above this item. */
  sepBefore?: boolean;
  /** A submenu that opens to the side on hover, straight away. Clicking the item still runs onSelect. */
  sub?: MenuItem[];
  onSelect: () => void;
}

/** A dropdown anchored to its button; closes on outside click or Esc. */
export function Dropdown(props: { label: ReactNode; items: MenuItem[]; className?: string; up?: boolean; title?: string; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [right, setRight] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Menus near the right edge open towards the left instead of running off screen.
  useLayoutEffect(() => {
    if (!open) return setRight(false);
    const m = ref.current?.querySelector<HTMLElement>('.menu');
    if (m && m.getBoundingClientRect().right > window.innerWidth - 8) setRight(true);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  // While open: a layer (Esc closes it, ↑ / ↓ move through it, nothing behind gets the keys).
  useLayer(open, { name: 'menu', modal: true, el: () => ref.current, onKey: (e) => menuKeys(e, ref.current?.querySelector('.menu') ?? null, () => setOpen(false)) });
  useHoldCalm(open);
  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className={props.className ?? 'btn btn-sm'} aria-expanded={open} aria-haspopup="menu"
        title={props.title} aria-label={props.ariaLabel} onClick={() => setOpen((o) => !o)}>
        {props.label}
      </button>
      {open && (
        <div className={`menu${props.up ? ' up' : ''}${right ? ' right' : ''}`} role="menu">
          {props.items.map((it) => [
            it.sepBefore && <div key={`${it.label}-sep`} className="menu-sep" role="separator" />,
            <button key={it.label} type="button" role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={it.checked} disabled={it.disabled}
              className={`menu-item${it.checked ? ' on' : ''}${it.danger ? ' danger' : ''}`}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}>
              <span className="tick">{it.checked ? '✓' : ''}</span>
              {it.label}
              {it.hint && <span className="hint">{it.hint}</span>}
            </button>,
          ])}
        </div>
      )}
    </div>
  );
}

/** Right-click menu at the pointer. Same items as the "⋯" buttons. */
export function ContextMenu(props: { x: number; y: number; title?: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  const [sub, setSub] = useState<{ items: MenuItem[]; left: number; top: number; key: string } | null>(null);
  // Keep the submenu on screen: to the left if there's no room on the right, and up if needed.
  useLayoutEffect(() => {
    const el = subRef.current;
    if (!el || !sub) return;
    const r = el.getBoundingClientRect();
    let left = sub.left;
    let top = sub.top;
    if (r.right > window.innerWidth - 8) left = (ref.current?.getBoundingClientRect().left ?? left) - r.width + 4;
    if (r.bottom > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    if (left !== sub.left || top !== sub.top) setSub({ ...sub, left, top });
  }, [sub]);
  // Keep the whole menu on screen (measured before it is shown).
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const h = el.scrollHeight + 2;
      const w = el.offsetWidth;
      setPos({
        left: Math.max(8, Math.min(props.x, window.innerWidth - w - 8)),
        top: Math.max(8, Math.min(props.y, window.innerHeight - Math.min(h, window.innerHeight - 16) - 8)),
      });
    };
    place();
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [props.x, props.y]);
  useEffect(() => {
    const el = ref.current;
    if (el) el.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node) && !subRef.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('resize', props.onClose);
    window.addEventListener('wheel', props.onClose, { passive: true });
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('resize', props.onClose);
      window.removeEventListener('wheel', props.onClose);
    };
  }, [props.x, props.y]); // eslint-disable-line react-hooks/exhaustive-deps
  // A layer: Esc closes it, ↑ / ↓ move through it, → opens a submenu, nothing behind gets the keys.
  useLayer(true, {
    name: 'context menu', modal: true, el: () => ref.current,
    onKey: (e) => {
      const inSub = !!subRef.current?.contains(document.activeElement);
      if (inSub && e.key === 'ArrowLeft') {
        const key = sub?.key;
        setSub(null);
        [...(ref.current?.querySelectorAll<HTMLElement>(':scope > button') ?? [])].find((b) => b.dataset.label === key)?.focus();
        return true;
      }
      if (!inSub && e.key === 'ArrowRight') {
        const b = document.activeElement as HTMLElement | null;
        const it = b?.getAttribute('aria-haspopup') === 'menu' ? props.items.find((x) => x.label === b.dataset.label) : undefined;
        if (b && it?.sub?.length) {
          const r = b.getBoundingClientRect();
          setSub({ items: it.sub, left: r.right - 4, top: r.top - 5, key: it.label });
          requestAnimationFrame(() => subRef.current?.querySelector<HTMLElement>('button')?.focus());
          return true;
        }
      }
      return menuKeys(e, inSub ? subRef.current : ref.current, props.onClose);
    },
  });
  // Nothing on the screen behind changes while the menu is open (calm.ts).
  useHoldCalm(true);
  return (
    <div ref={ref} className="menu context" role="menu" aria-label={props.title} style={{ left: pos.left, top: pos.top, maxHeight: 'calc(100vh - 16px)' }}
      onContextMenu={(e) => e.preventDefault()}>
      {props.title && <div className="menu-title ellipsis">{props.title}</div>}
      {props.items.map((it) => [
        it.sepBefore && <div key={`${it.label}-sep`} className="menu-sep" role="separator" />,
        <button key={it.label} type="button" role="menuitem" disabled={it.disabled} aria-haspopup={it.sub ? 'menu' : undefined} data-label={it.label}
          className={`menu-item${it.danger ? ' danger' : ''}${sub?.key === it.label ? ' on' : ''}`}
          onPointerEnter={(e) => {
            if (it.sub?.length) {
              const r = e.currentTarget.getBoundingClientRect();
              setSub({ items: it.sub, left: r.right - 4, top: r.top - 5, key: it.label });
            } else setSub(null);
          }}
          onClick={() => {
            props.onClose();
            it.onSelect();
          }}>
          <span className="tick">{it.checked ? '✓' : ''}</span>
          {it.label}
          {it.hint && <span className="hint">{it.hint}</span>}
          {it.sub?.length ? <span className="hint">›</span> : null}
        </button>,
      ])}
      {sub && (
        <div ref={subRef} className="menu context sub" role="menu" style={{ left: sub.left, top: sub.top }}>
          {sub.items.map((it) => (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled} className={`menu-item${it.danger ? ' danger' : ''}`}
              onClick={() => {
                props.onClose();
                it.onSelect();
              }}>
              <span className="tick">{it.checked ? '✓' : ''}</span>
              {it.label}
              {it.hint && <span className="hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
