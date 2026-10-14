// Quick look: a big preview over the grid without leaving it.
// Space or Esc closes, ←/→ go to the neighbours, Enter opens the viewer.

import { useEffect, useRef } from 'react';
import { mediaUrl, thumbUrl, type Item } from '../api';
import { useViewerPrefs } from '../prefs';
import { ArrowIcon, CloseIcon, FolderIcon, PlayIcon } from './Icons';

export function QuickLook(props: {
  items: Item[];
  id: number;
  onClose: () => void;
  onMove: (id: number) => void;
  onOpen: (item: Item) => void;
  onShowFolder?: (item: Item) => void;
}) {
  const i = Math.max(0, props.items.findIndex((x) => x.id === props.id));
  const it = props.items[i];
  const prefs = useViewerPrefs();
  const video = useRef<HTMLVideoElement>(null);
  const state = useRef({ props, i });
  state.current = { props, i };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { props: p, i: at } = state.current;
      const k = e.key;
      if (k === ' ' || k === 'Escape' || k === 'Backspace') p.onClose();
      else if (k === 'ArrowRight' && at < p.items.length - 1) p.onMove(p.items[at + 1].id);
      else if (k === 'ArrowLeft' && at > 0) p.onMove(p.items[at - 1].id);
      else if (k === 'Enter') p.onOpen(p.items[at]);
      else {
        // Everything else stays inside quick look (the grid underneath doesn't react).
        if (!e.ctrlKey) e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const v = video.current;
    if (v) {
      v.muted = prefs.muted;
      v.volume = Math.max(0, Math.min(1, prefs.soundVolume));
    }
  }, [it?.id, prefs.muted, prefs.soundVolume]);

  if (!it) return null;
  return (
    <div className="qlook" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="qlook-stage" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        {it.kind === 'video' ? (
          <video key={it.id} ref={video} src={mediaUrl(it.id)} autoPlay loop controls playsInline />
        ) : it.kind === 'image' || it.kind === 'gif' ? (
          <img key={it.id} src={mediaUrl(it.id)} alt={it.name} draggable={false} />
        ) : (
          <img key={it.id} src={thumbUrl(it.id)} alt={it.name} draggable={false} />
        )}
      </div>
      <div className="qlook-bar">
        <button type="button" className="btn btn-icon btn-sm" aria-label="Previous" disabled={i === 0} onClick={() => props.onMove(props.items[i - 1].id)}><ArrowIcon /></button>
        <span className="ellipsis"><b>{it.name}</b> <span className="faint">{i + 1} of {props.items.length}</span></span>
        <button type="button" className="btn btn-icon btn-sm" aria-label="Next" disabled={i >= props.items.length - 1} onClick={() => props.onMove(props.items[i + 1].id)}><ArrowIcon dir="right" /></button>
        <span style={{ flex: 1 }} />
        {props.onShowFolder && (
          <button type="button" className="btn btn-sm" onClick={() => props.onShowFolder?.(it)}><FolderIcon size={14} /> Show in folder</button>
        )}
        <button type="button" className="btn btn-sm btn-primary" title="Enter" onClick={() => props.onOpen(it)}><PlayIcon size={13} /> Open</button>
        <button type="button" className="btn btn-icon btn-sm" aria-label="Close (Space or Esc)" title="Close (Space or Esc)" onClick={props.onClose}><CloseIcon size={13} /></button>
      </div>
    </div>
  );
}
