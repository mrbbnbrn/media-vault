// "Delete 3D data…" (folder, person folder, several folders or the selected
// media): first a list of what is saved for those pictures, per kind and
// model (the same model saved at other settings is its own line), each with
// how many pictures and how much space, all ticked to start with; then
// "Are you sure?". The pictures can be narrowed to those the face scan
// found no face (or only poor faces) in, e.g. screenshots. Every kind saved is listed (depth maps, outlines and
// Layered 3D's background fills and subject layers, and the videos' and GIFs' prepared 3D), so nothing is deleted
// unseen. Only that saved data goes: the pictures and videos never change.

import { errText } from '../text';
import { useEffect, useMemo, useState } from 'react';
import { api, type DerivedGroup, type DerivedKind, type FaceSplit, type ItemFilter } from '../api';
import { mapLabel, savedChanged } from '../derived';
import { forgetDepth } from '../depth';
import { folderFilters, pictureIds } from '../prepare';
import { forgetSubjects } from '../subject';
import { trackChanged } from '../track3d';
import { formatBytes } from '../theme';
import { plural } from '../undo';
import { ConfirmDialog, Modal } from './Dialogs';

export interface Delete3DTarget {
  /** How the pictures are named in the text ("“Anna”", "3 folders", "12 items"). */
  what: string;
  folders: { id: number; name: string; person: boolean }[];
  /** Pictures picked one by one (still pictures only). */
  ids: number[];
  /** Videos and GIFs picked one by one (their prepared 3D). */
  movingIds?: number[];
  /** Pictures found another way (the whole vault). */
  filters?: ItemFilter[];
}

/** Which of the pictures: all, only those the face scan found no face in, or no face that isn't poor. */
type Which = 'all' | 'noFaces' | 'noGood';

const KIND_TITLE: Record<DerivedKind, string> = {
  depth: 'Depth maps (3D photos)',
  outline: 'Subject outlines (Lift-off and the subject effects)',
  plate: 'Background fills (Layered 3D, Lift-off, Border fill, More layers)',
  fore: 'Subject layers (Lift-off, Layered 3D)',
  track: 'Prepared 3D of videos and GIFs',
};

/** The kinds in the order they are listed. */
const KINDS: DerivedKind[] = ['depth', 'outline', 'plate', 'fore', 'track'];

/** A kind in one word or two, for the "Are you sure?" list. */
const KIND_SHORT: Record<DerivedKind, string> = {
  depth: 'Depth map',
  outline: 'Outline',
  plate: 'Background fill',
  fore: 'Subject layer',
  track: 'Video 3D',
};

/** What a line counts: pictures, or videos and GIFs. */
const counted = (g: { kind: string; count: number }) => (g.kind === 'track' ? plural(g.count, 'video or GIF', 'videos and GIFs') : plural(g.count, 'picture'));

const keyOf = (g: { kind: string; model: string }) => `${g.kind}|${g.model}`;

export function Delete3DData(props: Delete3DTarget & { onClose: () => void; onDone: (text: string) => void }) {
  const anyPerson = props.folders.some((f) => f.person);
  const [others, setOthers] = useState(false);
  const [all, setAll] = useState<number[] | null>(null);
  /** The videos and GIFs here (their prepared 3D; the face choice doesn't apply to them). */
  const [moving, setMoving] = useState<number[]>([]);
  const [split, setSplit] = useState<FaceSplit | null>(null);
  const [which, setWhich] = useState<Which>('all');
  const ids = useMemo(() => {
    if (!all) return null;
    if (which === 'all' || !split) return all;
    return which === 'noFaces' ? split.noFaces : [...split.noFaces, ...split.onlyPoor];
  }, [all, split, which]);
  const [groups, setGroups] = useState<DerivedGroup[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void Promise.all([api.depthModels().catch(() => []), api.subjectModels().catch(() => []), api.inpaintModels().catch(() => [])]).then(
      ([d, s, f]) => setNames(new Map([...d, ...s, ...f].map((m) => [m.id, m.name]))),
    );
  }, []);

  // The pictures (and how the face scan sorted them).
  useEffect(() => {
    let live = true;
    setAll(null);
    setSplit(null);
    setGroups(null);
    setErr(null);
    void (async () => {
      try {
        const list = await pictureIds([...folderFilters(props.folders, others), ...(props.filters ?? [])], props.ids);
        const sp = list.length ? await api.facesSplit(list) : { withFaces: [], noFaces: [], onlyPoor: [], unscanned: [] };
        const mv = new Set(props.movingIds ?? []);
        for (const f of folderFilters(props.folders, false)) {
          for (const i of await api.queryItems({ ...f, kinds: ['video', 'gif'] })) if (i.deletedAt == null) mv.add(i.id);
        }
        if (!live) return;
        setMoving([...mv]);
        setAll(list);
        setSplit(sp);
      } catch (e) {
        if (live) setErr(errText(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [others]); // eslint-disable-line react-hooks/exhaustive-deps

  // What is saved for the pictures chosen.
  useEffect(() => {
    if (!ids) return;
    let live = true;
    setGroups(null);
    const look = [...ids, ...moving];
    void (look.length ? api.derivedSummary(look) : Promise.resolve([] as DerivedGroup[])).then(
      (g) => {
        if (!live) return;
        setGroups(g);
        setChecked(new Set(g.map(keyOf)));
      },
      (e) => live && setErr(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [ids, moving]);

  const chosen = useMemo(() => (groups ?? []).filter((g) => checked.has(keyOf(g))), [groups, checked]);
  const picGroups = chosen.filter((g) => g.kind !== 'track');
  const trackGroups = chosen.filter((g) => g.kind === 'track');
  const bytes = chosen.reduce((n, g) => n + g.bytes, 0);
  const toggle = (k: string) => setChecked((c) => {
    const n = new Set(c);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });

  if (confirming && groups) {
    return (
      <ConfirmDialog title="Are you sure?" confirm="Delete" danger onClose={props.onClose} cancel="Back" onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          const n = picGroups.length ? await api.derivedRemove(ids ?? [], picGroups.map((g): [DerivedKind, string] => [g.kind, g.model])) : 0;
          const t = trackGroups.length ? await api.derivedRemove(moving, trackGroups.map((g): [DerivedKind, string] => [g.kind, g.model])) : 0;
          // Copies in memory would otherwise still be used.
          forgetDepth();
          forgetSubjects();
          if (t) trackChanged();
          savedChanged();
          props.onDone(`Deleted ${[n ? `${plural(n, 'saved map')} of ${plural(ids?.length ?? 0, 'picture')}` : '', t ? 'the prepared 3D of videos and GIFs' : ''].filter(Boolean).join(' and ')} (${formatBytes(bytes)}) in ${props.what}.`);
        }}>
        {picGroups.length > 0 && <>{plural(picGroups.reduce((n, g) => n + g.count, 0), 'saved map')} of {which === 'all' ? 'the pictures' : which === 'noFaces' ? 'the pictures with no faces' : 'the pictures with no faces or only poor faces'}</>}
        {picGroups.length > 0 && trackGroups.length > 0 && ' and '}
        {trackGroups.length > 0 && 'the prepared 3D of videos and GIFs'} ({formatBytes(bytes)}) in {props.what} will be deleted:
        <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
          {chosen.map((g) => {
            const l = mapLabel(g.kind, g.model, names);
            return <li key={keyOf(g)}>{KIND_SHORT[g.kind] ?? g.kind}: {l.name}{l.detail ? ` · ${l.detail}` : ''} ({counted(g)})</li>;
          })}
        </ul>
        Your pictures and videos don't change. Pictures' data is worked out again when needed (3D, Lift-off and Layered 3D take a
        moment longer to start the first time); videos and GIFs play without 3D until they're prepared again.
      </ConfirmDialog>
    );
  }

  return (
    <Modal title={`Delete 3D data · ${props.what}`} onClose={props.onClose} wide>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
        Choose which saved 3D data to delete here: the pictures' depth maps, outlines, and Layered 3D's background
        fills and subject layers, and the prepared 3D of videos and GIFs.
      </div>
      {anyPerson && (
        <label className="check" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} />
          Also delete the data of {props.folders.filter((f) => f.person).length === 1 ? "this person's" : "these people's"} pictures in other folders
          (pictures their face was recognised in)
        </label>
      )}
      {all && split && all.length > 0 && (
        <div role="radiogroup" aria-label="Which pictures" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <b style={{ fontSize: 13 }}>Which pictures</b>
          {([
            ['all', 'All pictures here', all.length],
            ['noFaces', 'Only pictures with no faces found', split.noFaces.length],
            ['noGood', 'Only pictures with no faces, or only poor faces', split.noFaces.length + split.onlyPoor.length],
          ] as const).map(([v, label, n]) => (
            <label key={v} className="check" style={{ minHeight: 30 }}>
              <input type="radio" name="del3d-which" checked={which === v} onChange={() => setWhich(v)} />
              {label} <span className="faint">({plural(n, 'picture')})</span>
            </label>
          ))}
          {which !== 'all' && (
            <span className="faint" style={{ fontSize: 12 }}>
              Only pictures already scanned for faces count{split.unscanned.length ? `: ${plural(split.unscanned.length, 'picture')} not scanned yet ${split.unscanned.length === 1 ? 'is' : 'are'} left alone` : ''}.
              A hidden face still counts as a face; poor faces follow Settings → AI & 3D.
            </span>
          )}
        </div>
      )}
      {err && <div className="error" role="alert">{err}</div>}
      {!groups && !err && <div className="faint">Looking at what's saved…</div>}
      {groups && groups.length === 0 && (
        <div className="faint">{ids && ids.length + moving.length ? 'Nothing is saved for these.' : all && all.length ? 'No pictures here match that.' : 'There are no pictures, videos or GIFs here.'}</div>
      )}
      {groups && groups.length > 0 && (
        <>
          <div className="faint" style={{ fontSize: 13 }}>{plural(ids?.length ?? 0, 'picture')}{which === 'all' ? ' here' : ' chosen'}{moving.length ? `, ${plural(moving.length, 'video or GIF', 'videos and GIFs')}` : ''}.</div>
          {[...KINDS, ...new Set(groups.map((g) => g.kind).filter((k) => !KINDS.includes(k)))].map((kind) => {
            const list = groups.filter((g) => g.kind === kind);
            if (!list.length) return null;
            return (
              <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <b style={{ fontSize: 13 }}>{KIND_TITLE[kind] ?? kind}</b>
                {list.map((g) => {
                  const l = mapLabel(g.kind, g.model, names);
                  const k = keyOf(g);
                  return (
                    <label key={k} className="check" style={{ justifyContent: 'space-between', minHeight: 34 }}>
                      <span className="row" style={{ gap: 8 }}>
                        <input type="checkbox" checked={checked.has(k)} onChange={() => toggle(k)} />
                        <span>
                          {l.name}
                          {l.detail && <span className="faint"> · {l.detail}</span>}
                        </span>
                      </span>
                      <span className="faint mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{counted(g)} · {formatBytes(g.bytes)}</span>
                    </label>
                  );
                })}
              </div>
            );
          })}
          <div className="row" style={{ gap: 12 }}>
            <button type="button" className="link" onClick={() => setChecked(new Set(groups.map(keyOf)))}>Select all</button>
            <button type="button" className="link" onClick={() => setChecked(new Set())}>Select none</button>
          </div>
        </>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-danger-solid" disabled={!chosen.length} onClick={() => setConfirming(true)}>
          {chosen.length ? `Delete (${formatBytes(bytes)})…` : 'Delete…'}
        </button>
      </div>
    </Modal>
  );
}
