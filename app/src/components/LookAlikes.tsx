// Look-alikes: groups of pictures that look the same (burst shots, the same
// pose again, re-saved or resized copies), like Baro Alarm's similar-photo
// finder. The best one of each group is kept (★); the others start out
// marked, and the bar at the bottom moves the marked ones to the trash.

import { useEffect, useState } from 'react';
import { api, thumbUrl, type Item, type SimilarLevel } from '../api';
import { onFingerprintProgress } from '../fingerprint';
import { onClipProgress } from '../ml/smart';
import { formatBytes } from '../theme';
import { plural } from '../undo';

const LEVELS: { id: SimilarLevel | 'exact'; label: string; hint: string }[] = [
  { id: 'exact', label: 'Exact copies', hint: 'byte-for-byte the same file' },
  { id: 'strict', label: 'Strict', hint: 'nearly identical only' },
  { id: 'normal', label: 'Normal', hint: 're-saved, resized and burst shots' },
  { id: 'loose', label: 'Loose', hint: 'catches more, with more mistakes' },
];

// Kept while the app is open.
let lastLevel: SimilarLevel | 'exact' = 'normal';
let lastSmart = false;
let lastVideos = false;

export function LookAlikes(props: {
  folder: number | null;
  folderName: string | null;
  /** Smart search is on and its models are there. */
  smartOk: boolean;
  /** Changes when the library changed (e.g. after moving marked ones to the trash). */
  tick: number;
  marked: Set<number>;
  setMarked: (s: Set<number>) => void;
  onGroups: (groups: Item[][]) => void;
  onOpen: (group: Item[], id: number) => void;
  onAllFolders: () => void;
}) {
  const [level, setLevelState] = useState<SimilarLevel | 'exact'>(lastLevel);
  const [smartWanted, setSmart] = useState(lastSmart);
  const [videos, setVideos] = useState(lastVideos);
  const smart = smartWanted && props.smartOk;
  const [groups, setGroups] = useState<Item[][] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fp, setFp] = useState<{ total: number; done: number } | null>(null);
  const [clip, setClip] = useState<{ total: number; done: number; failed: number } | null>(null);
  const [fpTick, setFpTick] = useState(0);

  const setLevel = (l: SimilarLevel | 'exact') => {
    lastLevel = l;
    setLevelState(l);
  };

  // Fingerprints are made in the background; regroup when a batch is finished.
  useEffect(() => {
    let wasDone = -1;
    const upd = () =>
      api.similarStatus().then((s) => {
        setFp(s);
        if (s.done >= s.total && wasDone >= 0 && wasDone < s.total) setFpTick((t) => t + 1);
        wasDone = s.done;
      }).catch(() => {});
    upd();
    const a = onFingerprintProgress(upd);
    const b = onClipProgress(() => api.clipStatus().then(setClip).catch(() => {}));
    api.clipStatus().then(setClip).catch(() => {});
    return () => {
      a();
      b();
    };
  }, []);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setErr(null);
    (level === 'exact' ? api.exactGroups(props.folder) : api.similarGroups(level, smart, props.folder, videos))
      .then((g) => {
        if (!live) return;
        setGroups(g);
        props.onGroups(g);
        // Everything but the best of each group starts out marked.
        props.setMarked(new Set(g.flatMap((x) => x.slice(1).map((i) => i.id))));
      })
      .catch((e) => live && setErr(String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [level, smart, videos, props.folder, props.tick, fpTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: number) => {
    const n = new Set(props.marked);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    props.setMarked(n);
  };
  const markedBytes = (groups ?? []).flat().filter((i) => props.marked.has(i.id)).reduce((a, i) => a + i.size, 0);
  const pending = fp && fp.done < fp.total;
  const clipPending = smart && clip && clip.done + clip.failed < clip.total;

  return (
    <div className="looks">
      <div className="looks-head">
        <div role="group" aria-label="Sensitivity" className="seg">
          {LEVELS.map((l) => (
            <button key={l.id} type="button" className={level === l.id ? 'on' : ''} title={l.hint} onClick={() => setLevel(l.id)}>{l.label}</button>
          ))}
        </div>
        <label className="check" title={props.smartOk ? 'Compare what the pictures show instead of their pixels: also finds crops, mirrored copies and the same scene from another angle.'
          : 'Turn smart search on (the ✦ button at the top) to use this.'}>
          <input type="checkbox" checked={smart} disabled={!props.smartOk} onChange={(e) => { lastSmart = e.target.checked; setSmart(e.target.checked); }} />
          Use smart-search analysis
        </label>
        <label className="check" title={smart ? 'Videos are compared by what they show' : 'Videos are compared by their thumbnail'}>
          <input type="checkbox" checked={videos} onChange={(e) => { lastVideos = e.target.checked; setVideos(e.target.checked); }} />
          Include videos
        </label>
        {props.folder != null && (
          <span className="faint" style={{ fontSize: 13 }}>
            Only in “{props.folderName}” · <button type="button" className="link" onClick={props.onAllFolders}>whole library</button>
          </span>
        )}
        {busy && <span className="faint" style={{ fontSize: 13 }}>Comparing…</span>}
      </div>

      {pending && (
        <div className="info">Making picture fingerprints: {fp!.done.toLocaleString()} of {fp!.total.toLocaleString()}. Groups update when it's done.</div>
      )}
      {clipPending && (
        <div className="info">Still analysing for smart search: {clip!.done.toLocaleString()} of {clip!.total.toLocaleString()}. Pictures not analysed yet are left out.</div>
      )}
      {err && <div className="error" role="alert">{err}</div>}

      {groups && groups.length > 0 && (
        <p className="faint" style={{ margin: 0, fontSize: 13 }}>
          {plural(groups.length, 'group')} · {plural(props.marked.size, 'picture')} marked ({formatBytes(markedBytes)}).
          ★ = the best of each group (favourite, sharpest, biggest, most viewed, oldest). Click a picture to mark or unmark it; double-click to open.
        </p>
      )}
      {groups && !groups.length && !busy && (
        <div className="dropzone">
          <b>No look-alikes {props.folder != null ? 'in this folder' : 'found'}</b>
          <span className="muted">{level !== 'loose' ? 'Try “Loose” to catch more.' : 'Nothing looks alike, even with loose matching.'}</span>
        </div>
      )}

      {groups?.map((g) => (
        <section key={g[0].id} className="look-group" aria-label={`${g.length} look-alikes`}>
          <div className="look-row">
            {g.map((it, k) => {
              const on = props.marked.has(it.id);
              return (
                <button key={it.id} type="button" className={`look-tile${on ? ' marked' : ''}`} aria-pressed={on}
                  title={`${it.name} · ${it.width && it.height ? `${it.width}×${it.height} · ` : ''}${formatBytes(it.size)}${on ? ' · marked for the trash' : ''}`}
                  onClick={() => toggle(it.id)} onDoubleClick={() => props.onOpen(g, it.id)}>
                  {it.thumb === 'ok' ? <img src={thumbUrl(it.id)} alt="" loading="lazy" draggable={false} /> : <span className="tile-msg">{it.name}</span>}
                  {k === 0 && <span className="look-best" title="The best one">★</span>}
                  {it.favourite && <span className="look-fav" aria-label="Favourite">♥</span>}
                  {on && <span className="look-mark">Trash</span>}
                  <span className="look-meta">{it.width && it.height ? `${it.width}×${it.height}` : it.kind} · {formatBytes(it.size)}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
