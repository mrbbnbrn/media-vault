// People: who is in your photos. Faces you confirm teach the app a person;
// faces very much like them are then named automatically (listed under
// "Recognised automatically", easy to undo), unsure ones are asked, and
// everyone else is grouped ("Person 3 · 312 photos") to be named once.
// Naming never moves files: a person's page shows every photo of them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, thumbUrl, type FaceReview, type FolderCard, type Item, type OwnerProposal, type ReviewRequest, type Suggestion, type UnknownGroup } from '../api';
import { faceScanPaused, kickFaceScanner, NO_FACE_PACK, onFaceProgress, setFaceScanPaused } from '../ml/facescan';
import { openSortAll } from '../facesort';
import { groupLabel, photos, ticks } from '../peoplelogic';
import { plural } from '../undo';
import { Dropdown, Modal, PromptDialog, type MenuItem } from './Dialogs';
import { CloseIcon, FaceIcon } from './Icons';
import type { LibView } from '../screens/Library';
import { RoundCover } from './RoundCover';
import './people.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** A face cut out of an item's thumbnail (videos show the whole thumbnail). Loads when scrolled into view. */
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
      <img src={thumbUrl(s.item.id)} alt="" draggable={false} loading="lazy" decoding="async" style={{ position: 'absolute', maxWidth: 'none', ...style }}
        onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {video && <span className="face-at">▶ {clock(s.frameMs)}</span>}
    </div>
  );
}

function useReview(req: ReviewRequest) {
  const [review, setReview] = useState<FaceReview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reqRef = useRef(req);
  reqRef.current = req;
  const load = useCallback(() => api.facesReview(reqRef.current).then((r) => { setReview(r); setErr(null); }).catch((e) => setErr(errText(e))), []);
  useEffect(() => {
    load();
  }, [load, req]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    // While scanning, refresh now and then (not on every item).
    const off = onFaceProgress(() => {
      if (!t) t = setTimeout(() => { t = null; load(); }, 3000);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [load]);
  return { review, err, load };
}

const more = (list: [number, number][] | undefined, id: number, by: number, base: number): [number, number][] => {
  const now = list?.find((x) => x[0] === id)?.[1] ?? base;
  return [...(list ?? []).filter((x) => x[0] !== id), [id, now + by]];
};

export function PeopleView(props: {
  folders: FolderCard[]; onChanged: () => void; onOpenItem: (it: Item) => void; onTimeline?: (person: number) => void;
  /** Middle-click a person: open their folder (or timeline) in a new tab. */
  onOpenTab?: (v: LibView) => void;
}) {
  const [req, setReq] = useState<ReviewRequest>({});
  const { review, err, load } = useReview(req);
  const [paused, setPaused] = useState(faceScanPaused());
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [findMe, setFindMe] = useState<{ folder: number; name: string } | null>(null);
  const [naming, setNaming] = useState<UnknownGroup | null>(null);
  const people = review?.people ?? [];
  const st = review?.status;
  const engine = review?.engine;
  // Faces are only scanned with the faces pack.
  const noPack = engine?.active === 'none';
  const folderOf = (id: number) => props.folders.find((f) => f.id === id);

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
  const nameItems = (u: UnknownGroup): MenuItem[] => [
    ...people.map((p) => ({
      label: `This is ${p.person.name}`,
      onSelect: () => done(api.facesAccept(u.faceIds, p.person.folder), `Named ${photos(u.photos)} as ${p.person.name}.`),
    })),
    { label: 'Someone new…', sepBefore: people.length > 0, onSelect: () => setNaming(u) },
  ];

  return (
    <div className="people">
      <div className="people-head">
        <div className="pcol" style={{ gap: 2 }}>
          {st && (
            <span className="muted" style={{ fontSize: 13 }}>
              {st.scanned.toLocaleString()} scanned · {plural(st.faces, 'face')} found
              {st.queued > 0 && <> · <b>{st.queued.toLocaleString()} waiting{paused ? ' (paused)' : ''}</b></>}
              {st.failed > 0 && ` · ${st.failed} couldn't be read`}
            </span>
          )}
          {engine?.active === 'buffalo_l' && (
            <span className="faint" style={{ fontSize: 12 }}>
              {`InsightFace on the ${engine.native.device === 'gpu' ? 'graphics card' : 'processor'}`}
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {st && st.queued > 0 && !noPack && (
            <button type="button" className="btn btn-sm" onClick={() => { setFaceScanPaused(!paused); setPaused(!paused); }}>
              {paused ? 'Resume scanning' : 'Pause scanning'}
            </button>
          )}
          <button type="button" className="btn btn-sm" title="Go through every recognised person and move (or free-copy) their photos into their folder — you choose, person by person"
            onClick={() => openSortAll()}>Sort into folders…</button>
          {!noPack && <Dropdown className="btn btn-sm btn-primary" label={<><FaceIcon /> Scan for faces ▾</>} items={[
            { label: 'Scan everything not scanned yet', onSelect: () => scanAll(false) },
            { label: 'Scan everything again', hint: 'keeps your answers', onSelect: () => scanAll(true) },
          ]} />}
        </div>
      </div>

      {noPack && <div className="notice people-nopack"><FaceIcon size={16} /><span>{NO_FACE_PACK}</span></div>}
      {(err || error) && <div className="error"><span style={{ flex: 1 }}>{err ?? error}</span><button type="button" className="link" onClick={() => setError(null)}>Dismiss</button></div>}
      {msg && <div className="info row-between"><span>{msg}</span><button type="button" className="link" onClick={() => setMsg(null)}>Dismiss</button></div>}
      {engine && engine.upgradeLeft > 0 && (
        <div className="info people-upgrade">
          <span>Updating faces to the new model · {engine.upgradeLeft.toLocaleString()} left. Everything you said about who is who is kept.</span>
          <span className="people-bar"><i style={{ width: `${Math.round((100 * engine.upgraded) / Math.max(1, engine.upgraded + engine.upgradeLeft))}%` }} /></span>
        </div>
      )}

      {review && !noPack && people.length === 0 && review.unknown.length === 0 && (
        <div className="dropzone" style={{ minHeight: 0 }}>
          <FaceIcon size={28} />
          <b>No people yet</b>
          <span className="muted" style={{ maxWidth: 560, textAlign: 'center' }}>
            Scan your pictures (button above): the people who appear again and again show up here, ready to be named.
            Or choose <b>Person folder</b> in a folder's menu, and the app finds who that folder is about. All offline.
          </span>
        </div>
      )}

      {(review?.merges ?? []).map((m) => (
        <section key={`${m.a}-${m.b}`} className="person merge-hint">
          <div className="merge-faces">
            {[m.a, m.b].map((id) => {
              const f = folderOf(id);
              return f?.cover ? <RoundCover key={id} folder={f} size={44} className="people-round" /> : <span key={id} className="merge-blank"><FaceIcon size={20} /></span>;
            })}
          </div>
          <div className="pcol" style={{ gap: 2, flex: 1 }}>
            <b>{m.aName} and {m.bName} look like the same person — merge?</b>
            <span className="faint" style={{ fontSize: 12 }}>{m.confidence}% alike. Merging joins their faces; both folders and their files stay as they are.</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => done(api.facesMergePeople(m.a, m.b), `${m.bName} is now part of ${m.aName}.`)}>Keep “{m.aName}”</button>
            <button type="button" className="btn btn-sm" onClick={() => done(api.facesMergePeople(m.b, m.a), `${m.aName} is now part of ${m.bName}.`)}>Keep “{m.bName}”</button>
            <button type="button" className="btn btn-sm ghost" onClick={() => done(api.facesNotSame(m.a, m.b), 'Got it — they won’t be offered again.')}>Not the same</button>
          </div>
        </section>
      ))}

      {people.map((g) => (
        <PersonCard key={g.person.folder} g={g} folder={folderOf(g.person.folder)}
          onAccept={(ids) => done(api.facesAccept(ids, g.person.folder), `${plural(ids.length, 'face')} named ${g.person.name}.`)}
          onReject={(ids) => done(api.facesReject(ids, g.person.folder), `Got it — ${plural(ids.length, 'face')} marked as not ${g.person.name}.`)}
          onFindMe={() => setFindMe({ folder: g.person.folder, name: g.person.name })}
          onMore={() => setReq((r) => ({ ...r, more: more(r.more, g.person.folder, 48, 24) }))}
          onMoreRecent={() => setReq((r) => ({ ...r, recent: more(r.recent, g.person.folder, 36, 12) }))}
          onOpenItem={props.onOpenItem} onTimeline={props.onTimeline ? () => props.onTimeline!(g.person.folder) : undefined}
          onOpenTab={props.onOpenTab} />
      ))}

      {review && review.unknown.length > 0 && (
        <section className="person">
          <div className="person-head">
            <h2>Found people</h2>
            <span className="faint">The same face in several photos. Say who it is once and all of their photos are named.</span>
          </div>
          <div className="found-list">
            {review.unknown.map((u, i) => (
              <div key={u.key ?? u.faceIds[0]} className="found">
                <button type="button" className="found-face" title="Open a photo" onClick={() => u.samples[0] && props.onOpenItem(u.samples[0].item)}>
                  {u.samples[0] && <FaceCrop s={u.samples[0]} size={72} />}
                </button>
                <div className="pcol" style={{ gap: 4, minWidth: 0, flex: 1 }}>
                  <b>{groupLabel(i)} <span className="faint" style={{ fontWeight: 400 }}>· {photos(u.photos)}</span></b>
                  <div className="found-strip">{u.samples.slice(1, 5).map((s) => (
                    <button key={s.faceId} type="button" className="found-face" title="Open this photo" aria-label="Open this photo" onClick={() => props.onOpenItem(s.item)}>
                      <FaceCrop s={s} size={34} />
                    </button>
                  ))}</div>
                  {u.looksLike && (
                    <div className="row found-hint" style={{ gap: 6 }}>
                      <span>Looks like {u.looksLike.name}?</span>
                      <button type="button" className="link" onClick={() => done(api.facesAccept(u.faceIds, u.looksLike!.folder), `Named ${photos(u.photos)} as ${u.looksLike!.name}.`)}>Yes</button>
                    </div>
                  )}
                  <div className="row" style={{ gap: 6, marginTop: 2 }}>
                    <Dropdown className="btn btn-sm btn-primary" label="Who is this? ▾" items={nameItems(u)} />
                    <button type="button" className="btn btn-sm ghost" title="Never suggested again; listed under Hidden people"
                      onClick={() => done(api.facesHide(u.faceIds, true), `${groupLabel(i)} is hidden. Find them under Hidden people.`)}>Not important</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {(review.unknownTotal ?? 0) > review.unknown.length && (
            <button type="button" className="btn btn-sm people-more" onClick={() => setReq((r) => ({ ...r, groups: (r.groups ?? 24) + 24 }))}>
              Show more people ({(review.unknownTotal! - review.unknown.length).toLocaleString()} more)
            </button>
          )}
        </section>
      )}

      {review && (review.hidden?.length ?? 0) > 0 && (
        <details className="person hidden-people">
          <summary><b>Hidden people</b> <span className="faint">· {review.hidden!.length} — never suggested</span></summary>
          <div className="found-list" style={{ marginTop: 12 }}>
            {review.hidden!.map((u) => (
              <div key={u.key ?? u.faceIds[0]} className="found small">
                {u.samples[0] && (
                  <button type="button" className="found-face" title="Open a photo" onClick={() => props.onOpenItem(u.samples[0].item)}>
                    <FaceCrop s={u.samples[0]} size={56} />
                  </button>
                )}
                <div className="pcol" style={{ gap: 4 }}>
                  <span className="faint" style={{ fontSize: 12 }}>{photos(u.photos)}</span>
                  <button type="button" className="btn btn-sm" onClick={() => done(api.facesHide(u.faceIds, false), 'Shown again.')}>Show again</button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {naming && (
        <PromptDialog title="Who is this?" label="Name" confirm="Make person"
          hint={`A person folder with this name is made at the top level, and ${photos(naming.photos)} are named. Nothing is moved.`}
          onClose={() => setNaming(null)}
          onSubmit={async (name) => {
            await api.facesNewPerson(name.trim(), null, naming.faceIds);
            setMsg(`Made “${name.trim()}” · ${photos(naming.photos)} named.`);
            await load();
            props.onChanged();
          }} />
      )}
      {findMe && <FindMeDialog person={findMe} onClose={(changed) => { setFindMe(null); if (changed) { load(); props.onChanged(); } }} onMessage={setMsg} />}
    </div>
  );
}

function FaceGrid(props: {
  list: Suggestion[]; ticked: Set<number>; onToggle: (id: number) => void; onOpen: (it: Item) => void;
  onNo?: (id: number) => void; noLabel?: string; size?: number;
}) {
  return (
    <div className="face-grid">
      {props.list.map((s) => (
        <div key={s.faceId} className={`face-tile${props.ticked.has(s.faceId) ? ' on' : ''}`}>
          <button type="button" className="face-pick" onClick={() => props.onToggle(s.faceId)} onDoubleClick={() => props.onOpen(s.item)}
            aria-pressed={props.ticked.has(s.faceId)} title={`${s.item.name} · ${s.confidence}% alike — click to tick, double-click to open`}>
            <FaceCrop s={s} size={props.size ?? 96} />
            <span className="tick" aria-hidden="true">{props.ticked.has(s.faceId) ? '✓' : ''}</span>
            <span className="conf">{s.confidence}%</span>
          </button>
          {props.onNo && (
            <button type="button" className="face-no" aria-label={props.noLabel} title={props.noLabel} onClick={() => props.onNo!(s.faceId)}><CloseIcon size={11} /></button>
          )}
        </div>
      ))}
    </div>
  );
}

function useTicks(list: Suggestion[], allOn = false) {
  // Your own ticks and unticks win: the list refreshes while faces are being
  // scanned, and that must not undo what you clicked.
  const [choices, setChoices] = useState<Map<number, boolean>>(() => new Map());
  const t = useMemo(() => ticks(list, choices, allOn), [list, choices, allOn]);
  const ticked = useMemo(() => new Set(t.ticked), [t]);
  const toggle = (id: number) => setChoices((c) => new Map(c).set(id, !ticked.has(id)));
  return { ticked, unticked: t.unticked, toggle };
}

function PersonCard(props: {
  g: FaceReview['people'][number];
  folder?: FolderCard;
  onAccept: (ids: number[]) => void;
  onReject: (ids: number[]) => void;
  onFindMe: () => void;
  onMore: () => void;
  onMoreRecent: () => void;
  onOpenItem: (it: Item) => void;
  onTimeline?: () => void;
  onOpenTab?: (v: LibView) => void;
}) {
  const { person, suggestions, owner } = props.g;
  const recent = props.g.recent ?? [];
  const name = person.name;
  const middle = (v: LibView) => (props.onOpenTab ? {
    onMouseDown: (e: React.MouseEvent) => { if (e.button === 1) e.preventDefault(); },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      props.onOpenTab!(v);
    },
  } : {});
  const s = useTicks(suggestions);
  const r = useTicks(recent, true);
  const [showRecent, setShowRecent] = useState(false);
  const total = props.g.suggestionsTotal ?? suggestions.length;
  const recentTotal = props.g.recentTotal ?? recent.length;
  return (
    <section className="person">
      <div className="person-head">
        <h2 {...middle({ kind: 'folder', id: person.folder })} title={props.onOpenTab ? 'Middle-click to open this person’s folder in a new tab' : undefined}>
          {props.folder?.cover ? <RoundCover folder={props.folder} size={36} className="people-round" /> : <FaceIcon />} {name}
        </h2>
        {props.onTimeline && (
          <button type="button" className="btn btn-sm" onClick={props.onTimeline} {...middle({ kind: 'timeline', person: person.folder })}
            title="Every photo of them, wherever it is">
            {person.photos != null ? `All ${photos(person.photos)}` : 'All photos'}
          </button>
        )}
        <span className="faint">
          {person.known ? `learned from ${plural(person.known, 'face')}` : 'nothing confirmed yet'}
          {person.recognised ? ` · ${person.recognised.toLocaleString()} recognised automatically` : ''}
        </span>
        {!owner && <button type="button" className="link" onClick={props.onFindMe}>Find {name} in their folder</button>}
      </div>

      {owner && (
        <div className="owner-hint">
          <div className="row" style={{ gap: 4 }}>{owner.samples.map((x) => (
            <button key={x.faceId} type="button" className="found-face" title="Open this photo" aria-label="Open this photo" onClick={() => props.onOpenItem(x.item)}>
              <FaceCrop s={x} size={44} />
            </button>
          ))}</div>
          <div className="pcol" style={{ gap: 2, flex: 1 }}>
            <b>This looks like {name} in {photos(owner.photos)}</b>
            <span className="faint" style={{ fontSize: 12 }}>The face that appears again and again in their folder. Check it once and {name} is recognised everywhere.</span>
          </div>
          <button type="button" className="btn btn-sm btn-primary" onClick={props.onFindMe}>Check and confirm</button>
        </div>
      )}

      {suggestions.length === 0 ? (
        <p className="faint" style={{ fontSize: 13, margin: '4px 0 0' }}>{recentTotal || person.known ? 'Nothing to check.' : 'No suggestions yet.'}</p>
      ) : (
        <>
          <p className="person-q">Is this {name}? <span className="faint">{plural(total, 'face')} to check · ticked ones look most alike</span></p>
          <FaceGrid list={suggestions} ticked={s.ticked} onToggle={s.toggle} onOpen={props.onOpenItem}
            onNo={(id) => props.onReject([id])} noLabel={`Not ${name}`} />
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={!s.ticked.size} onClick={() => props.onAccept([...s.ticked])}>
              Ticked ones are {name}
            </button>
            <button type="button" className="btn btn-sm" disabled={!s.ticked.size} onClick={() => props.onReject([...s.ticked])}>Ticked ones are not {name}</button>
            <button type="button" className="btn btn-sm" disabled={!s.unticked.length} onClick={() => props.onReject(s.unticked)}>Unticked ones are not {name}</button>
            {total > suggestions.length && <button type="button" className="link" onClick={props.onMore}>Show more ({(total - suggestions.length).toLocaleString()})</button>}
          </div>
        </>
      )}

      {recentTotal > 0 && (
        <div className="recent">
          <button type="button" className="link recent-toggle" aria-expanded={showRecent} onClick={() => setShowRecent((x) => !x)}>
            {showRecent ? '▾' : '▸'} Recognised automatically · {recentTotal.toLocaleString()}
          </button>
          {showRecent && (
            <>
              <p className="faint" style={{ fontSize: 12, margin: '6px 0 8px' }}>Newest first. Untick any that aren't {name}.</p>
              <FaceGrid list={recent} ticked={r.ticked} onToggle={r.toggle} onOpen={props.onOpenItem} size={72}
                onNo={(id) => props.onReject([id])} noLabel={`Not ${name}`} />
              <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-sm" disabled={!r.unticked.length} onClick={() => props.onReject(r.unticked)}>Unticked ones are not {name}</button>
                <button type="button" className="btn btn-sm ghost" disabled={!r.ticked.size} title="Confirmed faces teach the app"
                  onClick={() => props.onAccept([...r.ticked])}>All correct</button>
                {recentTotal > recent.length && <button type="button" className="link" onClick={props.onMoreRecent}>Show more ({(recentTotal - recent.length).toLocaleString()})</button>}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** "Find me in this folder": the face that recurs in a person folder; untick mistakes, confirm once. */
export function FindMeDialog(props: { person: { folder: number; name: string }; onClose: (changed: boolean) => void; onMessage?: (m: string) => void }) {
  const [p, setP] = useState<OwnerProposal | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState(60);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.facesFindOwner(props.person.folder).then(setP).catch((e) => setErr(errText(e)));
  }, [props.person.folder]);
  const list = p?.faces ?? [];
  const t = useTicks(list, true);
  const name = props.person.name;
  const confirm = async () => {
    setBusy(true);
    try {
      const yes = [...t.ticked];
      if (yes.length) await api.facesAccept(yes, props.person.folder);
      if (t.unticked.length) await api.facesReject(t.unticked, props.person.folder);
      props.onMessage?.(`${name} confirmed in ${photos(yes.length)}. From now on they're recognised everywhere.`);
      props.onClose(true);
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Find ${name} in their folder`} wide onClose={() => props.onClose(false)}>
      {err && <div className="error">{err}</div>}
      {p === undefined && !err && <p className="muted">Looking…</p>}
      {p === null && (
        <p className="muted">
          No face appears often enough in {name}'s folder yet. Scan the folder (folder menu → Scan for faces), or name {name} on a
          photo in the viewer (face boxes) — that works too.
        </p>
      )}
      {p && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            This looks like <b>{name}</b> in {photos(list.length)}. Untick any that aren't {name}, then confirm.
          </p>
          <div className="findme-grid">
            <FaceGrid list={list.slice(0, shown)} ticked={t.ticked} onToggle={t.toggle} onOpen={() => {}} size={84} />
            {list.length > shown && <button type="button" className="btn btn-sm people-more" onClick={() => setShown((n) => n + 120)}>Show more ({list.length - shown})</button>}
          </div>
        </>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn" onClick={() => props.onClose(false)}>Cancel</button>
        {p && (
          <button type="button" className="btn btn-primary" disabled={busy || !t.ticked.size} onClick={confirm}>
            Yes, these are {name} ({t.ticked.size.toLocaleString()})
          </button>
        )}
      </div>
    </Modal>
  );
}

/** On a person folder: "Also in 120 other photos · Show all" (their page, without moving files). */
export function PersonAlso(props: { folder: FolderCard; onShowAll: () => void }) {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    api.queryItems({ people: [props.folder.id] }).then((all) => alive && setN(Math.max(0, all.length - props.folder.items))).catch(() => {});
    return () => {
      alive = false;
    };
  }, [props.folder.id, props.folder.items]);
  if (!n) return null;
  return (
    <button type="button" className="chip accent person-also" onClick={props.onShowAll} title="Photos where they were recognised, wherever they are">
      <FaceIcon size={11} /> Also in {photos(n)} elsewhere · Show all
    </button>
  );
}
