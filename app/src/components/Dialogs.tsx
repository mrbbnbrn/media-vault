// Small modal dialogs and a dropdown menu, kept plain and keyboard-friendly.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FolderCard } from '../api';
import { FolderIcon } from './Icons';

export function Modal(props: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('input, select, button.btn-primary')?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
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
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>{props.children}</div>
      {err && <div className="error" role="alert">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button
          type="button"
          className={props.danger ? 'btn btn-danger-solid' : 'btn btn-primary'}
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
  onSelect: () => void;
}

/** A dropdown anchored to its button; closes on outside click or Esc. */
export function Dropdown(props: { label: ReactNode; items: MenuItem[]; className?: string; up?: boolean; title?: string; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className={props.className ?? 'btn btn-sm'} aria-expanded={open} aria-haspopup="menu"
        title={props.title} aria-label={props.ariaLabel} onClick={() => setOpen((o) => !o)}>
        {props.label}
      </button>
      {open && (
        <div className={`menu${props.up ? ' up' : ''}`} role="menu">
          {props.items.map((it) => (
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
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Right-click menu at the pointer. Same items as the "⋯" buttons. */
export function ContextMenu(props: { x: number; y: number; title?: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({
        left: Math.max(8, Math.min(props.x, window.innerWidth - r.width - 8)),
        top: Math.max(8, Math.min(props.y, window.innerHeight - r.height - 8)),
      });
      el.querySelector<HTMLElement>('button')?.focus();
    }
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', props.onClose);
    window.addEventListener('wheel', props.onClose, { passive: true });
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', props.onClose);
      window.removeEventListener('wheel', props.onClose);
    };
  }, [props.x, props.y]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className="menu context" role="menu" aria-label={props.title} style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}>
      {props.title && <div className="menu-title ellipsis">{props.title}</div>}
      {props.items.map((it) => (
        <button key={it.label} type="button" role="menuitem" disabled={it.disabled}
          className={`menu-item${it.danger ? ' danger' : ''}`}
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
  );
}
