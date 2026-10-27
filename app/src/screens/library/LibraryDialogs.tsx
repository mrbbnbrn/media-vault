// Smaller dialogs and cards the library opens: tagging items, an archive's
// password, the after-import summary, and choosing a folder cover.

import { errText } from '../../text';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, mediaUrl, thumbUrl, type DropSummary, type FolderCard, type ImportReport, type Item, type Kind, type TagCount } from '../../api';
import { Modal } from '../../components/Dialogs';
import { CloseIcon } from '../../components/Icons';
import { formatBytes } from '../../theme';
import { plural } from '../../undo';

const COVER_PAGE = 600;

export function TagItemsDialog(props: {
  ids: number[]; all: TagCount[]; onClose: () => void; onDone: () => Promise<void>;
  did: (label: string, undo: () => Promise<unknown>) => void;
}) {
  const [own, setOwn] = useState<string[]>([]);
  const [inherited, setInherited] = useState<[string, string][]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const single = props.ids.length === 1;
  const load = useCallback(async () => {
    if (!single) return;
    const t = await api.itemTags(props.ids[0]);
    setOwn(t.own);
    setInherited(t.inherited);
  }, [props.ids, single]);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    const list = text.split(',').map((t) => t.trim()).filter(Boolean);
    if (!list.length) return;
    try {
      const added = await api.tagItems(props.ids, list);
      const real = added.filter(([, ids]) => ids.length);
      if (real.length)
        props.did(`Tagged ${plural(new Set(real.flatMap(([, ids]) => ids)).size, 'item')} “${real.map(([t]) => t).join('”, “')}”`, async () => {
          for (const [t, ids] of real) await api.untagItems(ids, t);
        });
      setText('');
      await load();
      await props.onDone();
    } catch (e) { setErr(String(e)); }
  };
  const remove = async (t: string) => {
    const had = await api.untagItems(props.ids, t);
    if (had.length) props.did(`Removed tag “${t}” from ${plural(had.length, 'item')}`, () => api.tagItems(had, [t]));
    await load();
    await props.onDone();
  };
  return (
    <Modal title={single ? 'Tags' : `Tag ${props.ids.length} items`} onClose={props.onClose}>
      {single && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            {own.length ? own.map((t) => (
              <span key={t} className="chip">{t}<button type="button" aria-label={`Remove ${t}`} onClick={() => remove(t)}><CloseIcon size={11} /></button></span>
            )) : <span className="faint">No tags of its own yet.</span>}
          </div>
          {inherited.length > 0 && (
            <div className="faint" style={{ fontSize: 13 }}>
              Also tagged through folders: {inherited.map(([t, f]) => `${t} (from ${f})`).join(', ')}
            </div>
          )}
        </div>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="input" style={{ flex: 1 }} list="known-tags" value={text} autoFocus aria-label="New tags"
          placeholder="Add tags, separated by commas" onChange={(e) => setText(e.target.value)} />
        <datalist id="known-tags">{props.all.map((t) => <option key={t.name} value={t.name} />)}</datalist>
        <button type="submit" className="btn btn-primary">Add</button>
      </form>
      {!single && (
        <form className="row" onSubmit={async (e) => {
          e.preventDefault();
          const t = (new FormData(e.currentTarget).get('rm') as string).trim();
          if (t) { await remove(t); (e.currentTarget as HTMLFormElement).reset(); }
        }}>
          <input name="rm" className="input" style={{ flex: 1 }} list="known-tags" placeholder="Remove a tag from all of them" aria-label="Tag to remove" />
          <button type="submit" className="btn">Remove</button>
        </form>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Done</button>
      </div>
    </Modal>
  );
}

export function ArchivePasswordDialog(props: { summary: DropSummary; onClose: () => void; onImport: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = props.summary.archives.filter((a) => a.needsPassword);
  return (
    <Modal title="Archive password" onClose={props.onClose}>
      <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>
        {locked.length === 1 ? `“${locked[0].name}” is` : `${locked.length} archives are`} password-protected.
        Files are decrypted in memory and go straight into the vault — nothing is extracted to disk.
        The password is not saved.
      </p>
      <ul className="faint" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
        {props.summary.archives.map((a) => (
          <li key={a.path}>{a.name}{a.parts > 1 ? ` (${a.parts} parts)` : ''}{a.error ? ` — ${a.error}` : ''}</li>
        ))}
      </ul>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          for (const a of locked) await api.checkArchivePassword(a.path, pw);
          await props.onImport(pw);
          props.onClose();
        } catch (x) {
          setErr(errText(x));
        } finally {
          setBusy(false);
        }
      }}>
        <div className="field">
          <label htmlFor="arch-pw">Password{locked.length > 1 ? ' (tried on all of them)' : ''}</label>
          <input id="arch-pw" className="input" type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} />
        </div>
        {err && <div className="error" role="alert">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!pw || busy}>{busy ? 'Checking…' : 'Import'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ImportSummary({ r, onClose }: { r: ImportReport; onClose: () => void }) {
  const [more, setMore] = useState(false);
  return (
    <div className="icard">
      <div className="row-between">
        <b>{r.cancelled ? 'Import cancelled' : 'Import finished'}</b>
        <button type="button" className="link" onClick={onClose}>Dismiss</button>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        {r.imported.toLocaleString()} imported ({formatBytes(r.bytes)} in {Math.max(1, Math.round(r.seconds))} s)
        {r.duplicates > 0 && <> · {r.duplicates} already in that folder</>}
        {r.skippedCount > 0 && <> · {r.skippedCount} not media, skipped</>}
      </div>
      {r.failed.length > 0 && (
        <div className="error" style={{ flexDirection: 'column', gap: 4 }}>
          {(more ? r.failed : r.failed.slice(0, 3)).map(([n, why], i) => <span key={i}>{n}: {why}</span>)}
          {r.failed.length > 3 && !more && <button type="button" className="link" onClick={() => setMore(true)}>Show all {r.failed.length}</button>}
        </div>
      )}
    </div>
  );
}

/** Where "Choose cover…" looks: this folder, the person's photos anywhere, or the whole library. */
export type CoverSource = 'here' | 'person' | 'all';

export function CoverPicker(props: { folder: FolderCard; onClose: () => void; onPicked: (id: number | null) => Promise<void> }) {
  const f = props.folder;
  // A person folder opens on that person's photos (they may live anywhere, or the folder may be empty).
  const [source, setSource] = useState<CoverSource>(f.person ? 'person' : 'here');
  const [q, setQ] = useState('');
  const [favs, setFavs] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [limit, setLimit] = useState(COVER_PAGE);
  const [err, setErr] = useState<string | null>(null);
  /** The picture being looked at big (an index into the list), or null. */
  const [big, setBig] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setItems(null);
    setBig(null);
    setLimit(COVER_PAGE);
    const media: Kind[] = ['image', 'gif', 'video'];
    const words = q.trim().split(/\s+/).filter(Boolean);
    const t = setTimeout(() => {
      const filter = source === 'here' ? { folder: f.id, recursive: true }
        : source === 'person' ? { people: [f.id], kinds: media }
        : { kinds: media, names: words.length ? words : undefined, favouritesOnly: favs || undefined };
      api.queryItems(filter).then((x) => alive && setItems(x)).catch((e) => alive && setErr(String(e)));
    }, source === 'all' && words.length ? 250 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [source, q, favs, f.id]);
  const pick = async (id: number | null) => {
    try {
      await props.onPicked(id);
      props.onClose();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const shown = items?.slice(0, limit) ?? [];
  const cur = big != null ? shown[big] : undefined;
  // Looking at one big: ←/→ step through, Enter uses it (Esc goes back to the list, see Modal's close below).
  useEffect(() => {
    if (big == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const n = shown.length;
        if (n) setBig((i) => (i == null ? i : (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n));
      } else if (e.key === 'Enter' && cur) {
        e.preventDefault();
        e.stopPropagation();
        pick(cur.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => (big != null ? setBig(null) : props.onClose());
  const close = useCallback(() => closeRef.current(), []);
  const tabs: [CoverSource, string][] = [
    ['here', 'In this folder'],
    ...(f.person ? [['person', `Photos of ${f.name}`] as [CoverSource, string]] : []),
    ['all', 'Whole library'],
  ];
  return (
    <Modal title={`Cover for “${f.name}”`} onClose={close} wide>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div role="tablist" aria-label="Where to choose from" className="seg">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={source === k} className={source === k ? 'on' : ''} onClick={() => setSource(k)}>{label}</button>
          ))}
        </div>
        {source === 'all' && (
          <>
            <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Search by name…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by name" />
            <label className="check"><input type="checkbox" checked={favs} onChange={(e) => setFavs(e.target.checked)} /> Favourites only</label>
          </>
        )}
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        {source === 'person' ? `Every picture, GIF and video where ${f.name} is recognised, wherever it is. ` : source === 'all' ? 'Any picture, GIF or video in the vault. ' : 'Pictures, GIFs and videos in this folder (and its subfolders). '}
        Click one to look at it big (←/→ to go through them), or <b>Use</b> to pick it straight away. The cover doesn't have to be inside the folder.
      </p>
      {err && <div className="error">{err}</div>}
      {cur ? (
        <div className="cover-big">
          <div className="cover-big-media">
            {cur.kind === 'video' ? <video key={cur.id} src={mediaUrl(cur.id)} autoPlay muted loop playsInline controls />
              : cur.kind === 'image' || cur.kind === 'gif' ? <img key={cur.id} src={mediaUrl(cur.id)} alt={cur.name} />
              : <img key={cur.id} src={thumbUrl(cur.id)} alt={cur.name} />}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={() => setBig(null)}>← Back to the list</button>
            <button type="button" className="btn ghost" aria-label="Previous" onClick={() => setBig((i) => (i == null ? i : (i + shown.length - 1) % shown.length))}>‹</button>
            <span className="faint" style={{ fontSize: 12 }}>{(big ?? 0) + 1} of {shown.length.toLocaleString()} · {cur.name}</span>
            <button type="button" className="btn ghost" aria-label="Next" onClick={() => setBig((i) => (i == null ? i : (i + 1) % shown.length))}>›</button>
            <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => pick(cur.id)}>Use as cover</button>
          </div>
        </div>
      ) : (
        <div className="cover-grid">
          {source === 'here' && (
            <button type="button" className={`cover-pick${f.cover == null ? ' on' : ''}`} onClick={() => pick(null)}>
              <span className="tile-msg">Automatic<br />(first picture)</span>
            </button>
          )}
          {shown.map((it, i) => (
            <div key={it.id} className={`cover-pick${f.cover === it.id ? ' on' : ''}${it.kind === 'pdf' || it.kind === 'text' ? ' doc' : ''}`} title={it.name}
              role="button" tabIndex={0} onClick={() => setBig(i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBig(i); } }}>
              {it.thumb === 'ok' ? <img src={thumbUrl(it.id)} alt={it.name} loading="lazy" /> : <span className="tile-msg">{it.name}</span>}
              {it.kind !== 'image' && <span className="badge">{it.kind === 'video' ? 'VIDEO' : it.kind.toUpperCase()}</span>}
              <button type="button" className="btn btn-sm cover-use" onClick={(e) => { e.stopPropagation(); pick(it.id); }}>Use</button>
            </div>
          ))}
          {!items && <span className="faint">Loading…</span>}
          {items && !items.length && <span className="faint">{source === 'person' ? `No photos of ${f.name} found yet.` : 'Nothing here.'}</span>}
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        {!cur && items && items.length > limit && (
          <button type="button" className="btn" style={{ marginRight: 'auto' }} onClick={() => setLimit((n) => n + COVER_PAGE)}>
            Show more ({(items.length - limit).toLocaleString()} left)
          </button>
        )}
        <button type="button" className="btn" onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}

/**
 * A folder card's video or GIF cover shown whole while hovered: at the same
 * scale as on the card, growing in the direction that was cut off, kept
 * inside the window (like "Show the whole video on hover" in the grid).
 */
export function WholeCover(props: { id: number; kind: 'video' | 'gif' }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const card = anchor.current?.parentElement;
    if (!card || !nat) return;
    const r = card.getBoundingClientRect();
    const sc = Math.max(r.width / nat.w, r.height / nat.h);
    const w = nat.w * sc;
    const h = nat.h * sc;
    if (w <= r.width + 2 && h <= r.height + 2) return setBox(null);
    const left = Math.max(4, Math.min(window.innerWidth - 4 - w, r.left + (r.width - w) / 2));
    const top = Math.max(40, Math.min(window.innerHeight - 4 - h, r.top + (r.height - h) / 2));
    setBox({ left, top, w, h });
  }, [nat]);
  const media = props.kind === 'video'
    ? <video src={mediaUrl(props.id)} autoPlay muted loop playsInline crossOrigin="anonymous" onLoadedMetadata={(e) => setNat({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })} />
    : <img src={mediaUrl(props.id)} alt="" draggable={false} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />;
  return (
    <span ref={anchor} className="whole-anchor" aria-hidden="true">
      {createPortal(
        <div className="whole-pop whole-card" style={box ? { left: box.left, top: box.top, width: box.w, height: box.h } : { left: -9999, top: 0, width: 10, height: 10, opacity: 0 }}>{media}</div>,
        document.body,
      )}
    </span>
  );
}
