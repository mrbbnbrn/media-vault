// Folder banners: a wide picture (or a muted video / GIF) across the top of a
// folder, with the folder's name and note over a soft gradient into the page.
// As you scroll down, the picture drifts slower than the page and fades away.
// The banner and where it looks (drag it up or down) are kept in the vault.

import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl, thumbUrl, type FolderBanner, type FolderCard, type Item } from '../api';
import { bannerRank, bannerSpan, dragFocus } from '../bannerlogic';
import { Modal } from './Dialogs';
import './folderbanner.css';

/** The banner of the folder shown (refetched whenever the folder is reloaded). */
export function useFolderBanner(folder: FolderCard | null): [FolderBanner | null, () => void] {
  const [banner, setBanner] = useState<FolderBanner | null>(null);
  const [tick, setTick] = useState(0);
  const id = folder?.id ?? null;
  useEffect(() => {
    if (id == null) {
      setBanner(null);
      return;
    }
    let alive = true;
    api.folderBanner(id).then((b) => alive && setBanner(b ?? null), () => alive && setBanner(null));
    return () => {
      alive = false;
    };
  }, [folder, id, tick]);
  return [banner && banner.folder === id ? banner : null, () => setTick((t) => t + 1)];
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function FolderBannerView({ banner, title, note, preview, scroller, editing, onReposition, onEditDone, onChange, onRemove }: {
  banner: FolderBanner;
  /** The folder's name (with its colour or emoji). */
  title: React.ReactNode;
  note: string | null;
  /** The grid's preview setting: videos and GIFs play always, on hover, or never (always muted). */
  preview: 'all' | 'hover' | 'off';
  /** The page that scrolls (for the parallax). */
  scroller: React.RefObject<HTMLElement | null>;
  /** Choosing what shows: drag up or down, then Done. */
  editing: boolean;
  onReposition: () => void;
  /** The chosen focus, or null to keep the old one. */
  onEditDone: (y: number | null) => void;
  onChange: () => void;
  onRemove: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [hover, setHover] = useState(false);
  const [full, setFull] = useState(false);
  const [moving, setMoving] = useState(false);
  const [y, setY] = useState(banner.y);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(
    banner.width && banner.height ? { w: banner.width, h: banner.height } : null,
  );
  useEffect(() => {
    setFull(false);
    setNatural(banner.width && banner.height ? { w: banner.width, h: banner.height } : null);
  }, [banner.media, banner.width, banner.height]);
  useEffect(() => setY(banner.y), [banner.media, banner.y]);
  useEffect(() => {
    if (!editing) setY(banner.y);
  }, [editing, banner.y]);

  // Parallax: the picture moves at a third of the page's speed and fades as it goes.
  useEffect(() => {
    const el = scroller.current;
    const me = root.current;
    if (!el || !me || reducedMotion()) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const h = me.offsetHeight || 1;
      const top = Math.max(0, Math.min(h, el.scrollTop));
      me.style.setProperty('--bs', `${top}px`);
      me.style.setProperty('--bp', String(top / h));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scroller]);

  const playing = banner.kind !== 'image' && (preview === 'all' || (preview === 'hover' && hover)) && !editing;

  // Dragging while choosing what shows.
  const onPointerDown = (e: React.PointerEvent) => {
    if (!editing || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    const me = root.current;
    if (!me) return;
    const span = bannerSpan(natural, me.clientWidth, me.clientHeight);
    const startY = e.clientY;
    const from = y;
    setMoving(true);
    const move = (ev: PointerEvent) => setY(dragFocus(from, ev.clientY - startY, span));
    const up = () => {
      setMoving(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEditDone(null);
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        onEditDone(y);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setY((v) => Math.min(1, Math.max(0, v + (e.key === 'ArrowUp' ? -0.05 : 0.05))));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, y, onEditDone]);

  const pos = `50% ${(y * 100).toFixed(1)}%`;
  const learn = (w: number, h: number) => {
    if (w > 0 && h > 0 && (!natural || Math.abs(natural.w / natural.h - w / h) > 0.01)) setNatural({ w, h });
  };
  return (
    <section ref={root} data-kind={banner.kind} className={`fbanner${editing ? ' editing' : ''}${moving ? ' moving' : ''}${full ? ' full' : ''}`}
      aria-label="Folder banner" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onPointerDown={onPointerDown}>
      <div className="fbanner-media" aria-hidden="true">
        <img className="fbanner-still" src={thumbUrl(banner.media)} alt="" draggable={false} style={{ objectPosition: pos }}
          onLoad={(e) => !natural && learn(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
        {banner.kind === 'image' && (
          <img className="fbanner-full" src={mediaUrl(banner.media)} alt="" draggable={false} decoding="async" style={{ objectPosition: pos }}
            onLoad={(e) => {
              learn(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
              setFull(true);
            }} />
        )}
        {banner.kind === 'gif' && playing && (
          <img className="fbanner-full" src={mediaUrl(banner.media)} alt="" draggable={false} style={{ objectPosition: pos }} onLoad={() => setFull(true)} />
        )}
        {banner.kind === 'video' && playing && (
          <video className="fbanner-full" src={mediaUrl(banner.media)} muted loop autoPlay playsInline disablePictureInPicture style={{ objectPosition: pos }}
            onPlaying={() => setFull(true)} onLoadedMetadata={(e) => learn(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />
        )}
      </div>
      <div className="fbanner-shade" aria-hidden="true" />
      <div className="fbanner-text">
        <h1>{title}</h1>
        {note && <p title={note}>{note}</p>}
      </div>
      {editing ? (
        <div className="fbanner-edit" role="group" aria-label="Choose what the banner shows">
          <span>Drag the picture up or down</span>
          <button type="button" className="btn btn-sm glass" onClick={() => onEditDone(null)}>Cancel</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => onEditDone(y)}>Done</button>
        </div>
      ) : (
        <div className="fbanner-tools">
          <button type="button" className="btn btn-sm glass" onClick={onReposition} title="Drag the picture up or down to choose what shows">Reposition</button>
          <button type="button" className="btn btn-sm glass" onClick={onChange}>Change…</button>
          <button type="button" className="btn btn-sm glass" onClick={onRemove}>Remove</button>
        </div>
      )}
    </section>
  );
}

/** "Set banner…": pick a picture, GIF or video from inside the folder (wide ones first). */
export function BannerPicker(props: { folder: FolderCard; current: number | null; onClose: () => void; onPicked: (id: number) => Promise<void> }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.queryItems({ folder: props.folder.id, recursive: true })
      .then((x) => setItems(bannerRank(x).slice(0, 600)))
      .catch((e) => setErr(String(e)));
  }, [props.folder.id]);
  const pick = async (id: number) => {
    try {
      await props.onPicked(id);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title={`Banner for “${props.folder.name}”`} onClose={props.onClose} wide>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        Pick a picture, GIF or video from this folder to show wide at the top. Wide ones are first. Next, drag it up or down to choose what shows.
      </p>
      {err && <div className="error">{err}</div>}
      <div className="cover-grid banner-grid">
        {items?.map((it) => (
          <button key={it.id} type="button" title={it.name} className={`cover-pick${props.current === it.id ? ' on' : ''}`} onClick={() => pick(it.id)}>
            {it.thumb === 'ok' ? <img src={thumbUrl(it.id)} alt={it.name} loading="lazy" /> : <span className="tile-msg">{it.name}</span>}
            {it.kind !== 'image' && <span className="badge">{it.kind === 'video' ? 'VIDEO' : it.kind.toUpperCase()}</span>}
          </button>
        ))}
        {items && items.length === 0 && <span className="faint">There are no pictures, GIFs or videos in this folder yet.</span>}
        {!items && <span className="faint">Loading…</span>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}
