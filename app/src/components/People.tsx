// People: face recognition review. Person folders teach the app what someone
// looks like; it then suggests other pictures that show them. Nothing moves
// until the user confirms.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, mediaUrl, thumbUrl, type FaceBox, type FaceReview, type FolderCard, type Item, type Suggestion } from '../api';
import { faceScanPaused, kickFaceScanner, onFaceProgress, setFaceScanPaused } from '../ml/facescan';
import { plural } from '../undo';
import { Dropdown, Modal, PromptDialog } from './Dialogs';
import { CloseIcon, FaceIcon } from './Icons';
import type { LibView } from '../screens/Library';
import { RoundCover } from './RoundCover';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** A face cut out of an item's thumbnail (videos show the whole thumbnail). */
export function FaceCrop(props: { s: Pick<Suggestion, 'item' | 'x' | 'y' | 'w' | 'h' | 'frameMs'>; size: number }) {
  const { s, size } = props;
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const video = s.item.kind === 'video';
  let style: React.CSSProperties = { opacity: 0 };
  if (nat && !video) {
    const r = Math.max(s.w * nat.w, s.h * nat.h) * 1.7;
    const k = size / r;
    style = {
      width: nat.w * k,
      height: nat.h * k,
      left: size / 2 - (s.x + s.w / 2) * nat.w * k,
      top: size / 2 - (s.y + s.h / 2) * nat.h * k,
    };
  } else if (video) style = { width: '100%', height: '100%', objectFit: 'cover', left: 0, top: 0 };
  return (
    <div className="face-crop" style={{ width: size, height: size }}>
      <img src={thumbUrl(s.item.id)} alt="" draggable={false} style={{ position: 'absolute', maxWidth: 'none', ...style }}
        onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {video && <span className="face-at">▶ {clock(s.frameMs)}</span>}
    </div>
  );
}

function useScanStatus() {
  const [review, setReview] = useState<FaceReview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.facesReview().then((r) => { setReview(r); setErr(null); }).catch((e) => setErr(errText(e))), []);
  useEffect(() => {
    load();
    let t: ReturnType<typeof setTimeout> | null = null;
    // While scanning, refresh now and then (not on every item).
    const off = onFaceProgress(() => {
      if (!t) t = setTimeout(() => { t = null; load(); }, 2500);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [load]);
  return { review, err, load };
}

export function PeopleView(props: {
  folders: FolderCard[]; onChanged: () => void; onOpenItem: (it: Item) => void; onTimeline?: (person: number) => void;
  /** Middle-click a person: open their folder (or timeline) in a new tab. */
  onOpenTab?: (v: LibView) => void;
}) {
  const { review, err, load } = useScanStatus();
  const [paused, setPaused] = useState(faceScanPaused());
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teach, setTeach] = useState<{ folder: number; name: string } | null>(null);
  const [naming, setNaming] = useState<number[] | null>(null);
  const people = review?.people ?? [];
  const st = review?.status;

  const done = async (p: Promise<unknown>, text: string) => {
    try {
      await p;
      setMsg(text);
      await load();
      props.onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };
  const scanAll = async (again: boolean) => {
    const n = await api.facesQueue({ all: true, again });
    kickFaceScanner();
    setMsg(n ? `${plural(n, 'item')} will be scanned.` : 'Everything has been scanned already.');
    load();
  };

  return (
    <div className="people">
      <div className="people-head">
        <div>
          {st && (
            <span className="muted" style={{ fontSize: 13 }}>
              {st.scanned.toLocaleString()} scanned · {plural(st.faces, 'face')} found
              {st.queued > 0 && <> · <b>{st.queued.toLocaleString()} waiting{paused ? ' (paused)' : ''}</b></>}
              {st.failed > 0 && ` · ${st.failed} couldn't be read`}
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {st && st.queued > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => { setFaceScanPaused(!paused); setPaused(!paused); }}>
              {paused ? 'Resume scanning' : 'Pause scanning'}
            </button>
          )}
          <Dropdown className="btn btn-sm btn-primary" label={<><FaceIcon /> Scan for faces ▾</>} items={[
            { label: 'Scan everything not scanned yet', onSelect: () => scanAll(false) },
            { label: 'Scan everything again', hint: 'keeps your answers', onSelect: () => scanAll(true) },
          ]} />
        </div>
      </div>

      {(err || error) && <div className="error"><span style={{ flex: 1 }}>{err ?? error}</span><button type="button" className="link" onClick={() => setError(null)}>Dismiss</button></div>}
      {msg && <div className="info row-between"><span>{msg}</span><button type="button" className="link" onClick={() => setMsg(null)}>Dismiss</button></div>}

      {review && people.length === 0 && (
        <div className="dropzone" style={{ minHeight: 0 }}>
          <FaceIcon size={28} />
          <b>No person folders yet</b>
          <span className="muted" style={{ maxWidth: 560, textAlign: 'center' }}>
            Make a folder for someone and put a few pictures of them in it, then choose <b>Person folder</b> in the folder's menu.
            Scan your pictures (button above) and the app suggests where else that person appears. It works fully offline.
          </span>
        </div>
      )}

      {people.map((g) => (
        <PersonCard key={g.person.folder} g={g} onTeach={() => setTeach({ folder: g.person.folder, name: g.person.name })}
          onAccept={(ids) => done(api.facesAccept(ids, g.person.folder), `${plural(ids.length, 'picture')} added to ${g.person.name}.`)}
          onReject={(ids) => done(api.facesReject(ids, g.person.folder), `Got it — ${plural(ids.length, 'face')} marked as not ${g.person.name}.`)}
          onOpenItem={props.onOpenItem} onTimeline={props.onTimeline ? () => props.onTimeline!(g.person.folder) : undefined}
          onOpenTab={props.onOpenTab} folder={props.folders.find((f) => f.id === g.person.folder)} />
      ))}

      {review && review.unknown.length > 0 && (
        <section className="person">
          <div className="person-head">
            <h2>People the app doesn't know yet</h2>
            <span className="faint">The same face seen in several pictures. Give them a name to make a person folder.</span>
          </div>
          <div className="unknown-list">
            {review.unknown.map((u) => (
              <div key={u.faceIds[0]} className="unknown">
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {u.samples.slice(0, 6).map((s) => <FaceCrop key={s.faceId} s={s} size={64} />)}
                </div>
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <span className="faint" style={{ fontSize: 12 }}>{plural(u.photos, 'picture')}</span>
                  <button type="button" className="btn btn-sm" onClick={() => setNaming(u.faceIds)}>Name…</button>
                  {people.length > 0 && (
                    <Dropdown className="btn btn-sm" label="This is… ▾" items={people.map((p) => ({
                      label: p.person.name,
                      onSelect: () => done(api.facesAccept(u.faceIds, p.person.folder), `${plural(u.photos, 'picture')} added to ${p.person.name}.`),
                    }))} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {naming && (
        <PromptDialog title="Who is this?" label="Name" confirm="Make person folder" onClose={() => setNaming(null)}
          hint="A person folder with this name is made at the top level, and these pictures are moved into it and tagged with the name."
          onSubmit={async (name) => {
            const r = await api.facesNewPerson(name, null, naming);
            setMsg(`Made “${name}” with ${plural(r.accepted.moved, 'picture')} moved in.`);
            await load();
            props.onChanged();
          }} />
      )}
      {teach && <TeachDialog person={teach} onClose={() => { setTeach(null); load(); props.onChanged(); }} />}
    </div>
  );
}

function PersonCard(props: {
  g: FaceReview['people'][number];
  onAccept: (ids: number[]) => void;
  onReject: (ids: number[]) => void;
  onTeach: () => void;
  onOpenItem: (it: Item) => void;
  onTimeline?: () => void;
  onOpenTab?: (v: LibView) => void;
  folder?: FolderCard;
}) {
  const { person, suggestions } = props.g;
  const middle = (v: LibView) => (props.onOpenTab ? {
    onMouseDown: (e: React.MouseEvent) => { if (e.button === 1) e.preventDefault(); },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      props.onOpenTab!(v);
    },
  } : {});
  // Your own ticks and unticks win: the list refreshes while faces are being
  // scanned, and that must not undo what you clicked.
  const [choices, setChoices] = useState<Map<number, boolean>>(() => new Map());
  const ticked = useMemo(
    () => new Set(suggestions.filter((s) => choices.get(s.faceId) ?? s.sure).map((s) => s.faceId)),
    [suggestions, choices],
  );
  const unticked = useMemo(() => suggestions.filter((s) => !ticked.has(s.faceId)).map((s) => s.faceId), [suggestions, ticked]);
  const toggle = (id: number) => setChoices((c) => new Map(c).set(id, !ticked.has(id)));
  return (
    <section className="person">
      <div className="person-head">
        <h2 {...middle({ kind: 'folder', id: person.folder })} title={props.onOpenTab ? 'Middle-click to open this person’s folder in a new tab' : undefined}>{props.folder?.cover ? <RoundCover folder={props.folder} size={36} className="people-round" /> : <FaceIcon />} {person.name}</h2>
        <span className="faint">
          learned from {plural(person.known, 'face')}
          {person.known < 3 && ' — add a few more clear pictures for better suggestions'}
        </span>
        {props.onTimeline && <button type="button" className="btn btn-sm" onClick={props.onTimeline} {...middle({ kind: 'timeline', person: person.folder })}>Timeline</button>}
        {person.unsure > 0 && (
          <button type="button" className="link" onClick={props.onTeach}>
            {plural(person.unsure, 'picture')} with several people — show which one is {person.name}
          </button>
        )}
      </div>
      {suggestions.length === 0 ? (
        <p className="faint" style={{ fontSize: 13, margin: '4px 0 0' }}>No new suggestions.</p>
      ) : (
        <>
          <div className="face-grid">
            {suggestions.map((s) => (
              <div key={s.faceId} className={`face-tile${ticked.has(s.faceId) ? ' on' : ''}`}>
                <button type="button" className="face-pick" onClick={() => toggle(s.faceId)} onDoubleClick={() => props.onOpenItem(s.item)}
                  title={`${s.item.name} · ${s.confidence}% alike — click to tick, double-click to open`}>
                  <FaceCrop s={s} size={96} />
                  <span className="tick" aria-hidden="true">{ticked.has(s.faceId) ? '✓' : ''}</span>
                  <span className="conf">{s.confidence}%</span>
                </button>
                <button type="button" className="face-no" aria-label={`Not ${person.name}`} title={`Not ${person.name}`}
                  onClick={() => props.onReject([s.faceId])}><CloseIcon size={11} /></button>
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={!ticked.size} onClick={() => props.onAccept([...ticked])}>
              Yes, add {ticked.size ? plural(ticked.size, 'ticked picture') : 'ticked pictures'} to {person.name}
            </button>
            {unticked.length > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => props.onReject(unticked)}>Unticked are not {person.name}</button>
            )}
            <span className="faint" style={{ fontSize: 12 }}>Added pictures are tagged “{person.name}” and moved into the folder.</span>
          </div>
        </>
      )}
    </section>
  );
}

/** Pictures in a person folder with several faces: click the right one. */
function TeachDialog(props: { person: { folder: number; name: string }; onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [i, setI] = useState(0);
  const [boxes, setBoxes] = useState<FaceBox[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.facesUnsure(props.person.folder).then(setItems).catch((e) => setErr(errText(e)));
  }, [props.person.folder]);
  const it = items?.[i];
  useEffect(() => {
    setBoxes([]);
    if (it) api.facesOf(it.id).then(setBoxes).catch(() => {});
  }, [it]);
  const pick = async (b: FaceBox) => {
    try {
      await api.facesAccept([b.id], props.person.folder);
      setI((x) => x + 1);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <Modal title={`Which one is ${props.person.name}?`} wide onClose={props.onClose}>
      {err && <div className="error">{err}</div>}
      {items && !it && <p className="muted">All done. Thanks — that helps the suggestions.</p>}
      {it && (
        <>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Click {props.person.name}'s face. ({i + 1} of {items!.length})</p>
          <div className="teach">
            <div className="teach-pic">
              <img src={it.kind === 'video' ? thumbUrl(it.id) : mediaUrl(it.id)} alt={it.name} />
              {boxes.filter((b) => it.kind !== 'video' || b.frameMs === boxes[0]?.frameMs).map((b) => (
                <button key={b.id} type="button" className={`teach-box${b.person ? ' known' : ''}`} aria-label="This face"
                  style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
                  onClick={() => pick(b)} />
              ))}
            </div>
          </div>
        </>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        {it && <button type="button" className="btn" onClick={() => setI((x) => x + 1)}>Not in this one / skip</button>}
        <button type="button" className="btn btn-primary" onClick={props.onClose}>Done</button>
      </div>
    </Modal>
  );
}
