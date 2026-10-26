// Small modal dialogs and a dropdown menu, kept plain and keyboard-friendly.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  // On the page itself (a portal): a dialog opened from the library still works while the
  // viewer covers the library (which is inert then), e.g. from the viewer's right-click menu.
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref} tabIndex={-1}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>,
    document.body,
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

/** Lower case, accents and Turkish dotted/dotless i folded, for matching typed text. */
function fold(x: string): string {
  return x.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

/**
 * Choose a destination folder (or the top level), from every folder. Typing filters the
 * list (by name or path); ↑/↓ choose, Enter confirms, a double-click confirms that row.
 * Nothing is chosen at first, so Enter never moves anything by accident.
 */
export function FolderPicker(props: {
  title: string;
  folders: FolderCard[];
  exclude?: number[];
  confirm: string;
  topLabel?: string;
  onPick: (folder: number | null) => Promise<void> | void;
  onClose: () => void;
}) {
  /** undefined = nothing chosen yet, null = the top level. */
  const [sel, setSel] = useState<number | null | undefined>(undefined);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const excluded = new Set<number>();
  for (const x of props.exclude ?? []) {
    excluded.add(x);
    for (const f of props.folders) if (f.path.some((c) => c.id === x)) excluded.add(f.id);
  }
  const fq = fold(q);
  const shown = props.folders.filter((f) => !excluded.has(f.id) && (!fq || fold([...f.path.map((c) => c.name), f.name].join(' ')).includes(fq)));
  const rows: (number | null)[] = [...(fq ? [] : [null]), ...shown.map((f) => f.id)];
  const pick = async (id: number | null | undefined = sel) => {
    if (id === undefined || busy) return;
    setBusy(true);
    try {
      await props.onPick(id);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const step = (d: number) => {
    if (!rows.length) return;
    const i = sel === undefined ? -1 : rows.indexOf(sel);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? (d > 0 ? 0 : rows.length - 1) : i + d))];
    setSel(next);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row="${next ?? 'top'}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <input type="search" className="input" placeholder={`Search ${props.folders.length.toLocaleString()} folders…`} value={q} autoFocus
        aria-label="Search folders"
        onChange={(e) => {
          setQ(e.target.value);
          // The best match is chosen as you type, so Enter takes it.
          const fq2 = fold(e.target.value);
          const first = fq2 ? props.folders.find((f) => !excluded.has(f.id) && fold([...f.path.map((c) => c.name), f.name].join(' ')).includes(fq2)) : undefined;
          setSel(first ? first.id : undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            step(e.key === 'ArrowDown' ? 1 : -1);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            void pick();
          }
        }} />
      <div className="picker" role="listbox" aria-label="Folders" ref={listRef}>
        {!fq && (
          <button type="button" role="option" data-row="top" aria-selected={sel === null} className={`picker-row${sel === null ? ' on' : ''}`}
            onClick={() => setSel(null)} onDoubleClick={() => void pick(null)}>
            <FolderIcon size={15} /> {props.topLabel ?? 'Top level'}
          </button>
        )}
        {shown.map((f) => (
          <button type="button" role="option" data-row={f.id} aria-selected={sel === f.id} key={f.id}
            className={`picker-row${sel === f.id ? ' on' : ''}`} style={{ paddingLeft: 14 + (fq ? 0 : f.depth * 18) }}
            onClick={() => setSel(f.id)} onDoubleClick={() => void pick(f.id)}>
            <FolderIcon size={15} /> {f.name}
            {fq && f.path.length > 0 && <span className="faint picker-path">{f.path.map((c) => c.name).join(' › ')}</span>}
          </button>
        ))}
        {fq && !shown.length && <p className="faint" style={{ padding: '8px 12px' }}>No folder matches “{q}”.</p>}
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={sel === undefined || busy} title={sel === undefined ? 'Choose a folder first' : undefined}
          onClick={() => void pick()}>{props.confirm}</button>
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
  /** The item only opens its submenu (clicking it doesn't close the menu or run anything). */
  subOnly?: boolean;
  onSelect: () => void;
}

/** A dropdown anchored to its button; closes on outside click or Esc. */
export function Dropdown(props: {
  label: ReactNode;
  /** The items, or a function giving them (worked out only when the menu opens). */
  items: MenuItem[] | (() => MenuItem[]);
  className?: string; up?: boolean; title?: string; ariaLabel?: string;
}) {
  const [open, setOpenRaw] = useState(false);
  /** A submenu shown in place of the menu (with a way back), for items that have one. */
  const [subOf, setSubOf] = useState<MenuItem | null>(null);
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => {
    setSubOf(null);
    setOpenRaw(v);
  };
  const top = open ? (typeof props.items === 'function' ? props.items() : props.items) : [];
  const items: MenuItem[] = subOf?.sub
    ? [{ label: `‹ ${subOf.label}`, hint: 'back', onSelect: () => {} }, ...subOf.sub.map((x, i) => (i === 0 ? { ...x, sepBefore: true } : x))]
    : top;
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
          {items.map((it) => [
            it.sepBefore && <div key={`${it.label}-sep`} className="menu-sep" role="separator" />,
            <button key={it.label} type="button" role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={it.checked} disabled={it.disabled}
              className={`menu-item${it.checked ? ' on' : ''}${it.danger ? ' danger' : ''}`}
              onClick={() => {
                if (subOf && it === items[0]) {
                  setSubOf(null);
                  return;
                }
                if (!subOf && it.sub?.length && (it.subOnly || !it.onSelect)) {
                  setSubOf(it);
                  requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('.menu button')?.focus());
                  return;
                }
                setOpen(false);
                it.onSelect();
              }}>
              <span className="tick">{it.checked ? '✓' : ''}</span>
              {it.label}
              {it.hint && <span className="hint">{it.hint}</span>}
              {!subOf && it.sub?.length && it.subOnly ? <span className="hint">›</span> : null}
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
    // The wheel over the menu scrolls it (long menus are taller than the screen); elsewhere it closes it.
    const wheel = (e: Event) => {
      if (!ref.current?.contains(e.target as Node) && !subRef.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('resize', props.onClose);
    window.addEventListener('wheel', wheel, { passive: true });
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('resize', props.onClose);
      window.removeEventListener('wheel', wheel);
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
  return createPortal(
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
          onClick={(e) => {
            if (it.subOnly && it.sub?.length) {
              // Opens its submenu (and its first entry gets the keyboard).
              const r = e.currentTarget.getBoundingClientRect();
              setSub({ items: it.sub, left: r.right - 4, top: r.top - 5, key: it.label });
              requestAnimationFrame(() => subRef.current?.querySelector<HTMLElement>('button')?.focus());
              return;
            }
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
    </div>,
    document.body,
  );
}
