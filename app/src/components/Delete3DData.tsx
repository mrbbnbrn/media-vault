// "Delete 3D data…" (folder, person folder, several folders or the selected
// media): first a list of what is saved for those pictures, per kind and
// model (the same model saved at other settings is its own line), each with
// how many pictures and how much space, all ticked to start with; then
// "Are you sure?". Only the saved depth maps and outlines go: the pictures
// never change, and the maps are worked out again when needed.

import { useEffect, useMemo, useState } from 'react';
import { api, type DerivedGroup, type DerivedKind } from '../api';
import { mapLabel, savedChanged } from '../derived';
import { forgetDepth } from '../depth';
import { folderFilters, pictureIds } from '../prepare';
import { forgetSubjects } from '../subject';
import { formatBytes } from '../theme';
import { plural } from '../undo';
import { ConfirmDialog, Modal } from './Dialogs';

export interface Delete3DTarget {
  /** How the pictures are named in the text ("“Anna”", "3 folders", "12 items"). */
  what: string;
  folders: { id: number; name: string; person: boolean }[];
  /** Pictures picked one by one (still pictures only). */
  ids: number[];
}

const KIND_TITLE: Record<DerivedKind, string> = {
  depth: 'Depth maps (3D photos)',
  outline: 'Subject outlines (Lift-off and the subject effects)',
};

const keyOf = (g: { kind: string; model: string }) => `${g.kind}|${g.model}`;

export function Delete3DData(props: Delete3DTarget & { onClose: () => void; onDone: (text: string) => void }) {
  const anyPerson = props.folders.some((f) => f.person);
  const [others, setOthers] = useState(false);
  const [ids, setIds] = useState<number[] | null>(null);
  const [groups, setGroups] = useState<DerivedGroup[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void Promise.all([api.depthModels().catch(() => []), api.subjectModels().catch(() => [])]).then(([d, s]) =>
      setNames(new Map([...d, ...s].map((m) => [m.id, m.name]))),
    );
  }, []);

  useEffect(() => {
    let live = true;
    setGroups(null);
    setErr(null);
    void (async () => {
      try {
        const list = await pictureIds(folderFilters(props.folders, others), props.ids);
        const g = list.length ? await api.derivedSummary(list) : [];
        if (!live) return;
        setIds(list);
        setGroups(g);
        setChecked(new Set(g.map(keyOf)));
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [others]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => (groups ?? []).filter((g) => checked.has(keyOf(g))), [groups, checked]);
  const maps = chosen.reduce((n, g) => n + g.count, 0);
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
          const n = await api.derivedRemove(ids ?? [], chosen.map((g): [DerivedKind, string] => [g.kind, g.model]));
          // Copies in memory would otherwise still be used.
          forgetDepth();
          forgetSubjects();
          savedChanged();
          props.onDone(`Deleted ${plural(n, 'saved map')} (${formatBytes(bytes)}) of the pictures in ${props.what}.`);
        }}>
        {plural(maps, 'saved map')} ({formatBytes(bytes)}) of the pictures in {props.what} will be deleted:
        <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
          {chosen.map((g) => {
            const l = mapLabel(g.kind, g.model, names);
            return <li key={keyOf(g)}>{g.kind === 'depth' ? 'Depth' : 'Outline'}: {l.name}{l.detail ? ` · ${l.detail}` : ''} ({plural(g.count, 'picture')})</li>;
          })}
        </ul>
        Your pictures don't change. These are worked out again when they're needed, so 3D and Lift-off take a moment longer
        to start the first time.
      </ConfirmDialog>
    );
  }

  return (
    <Modal title={`Delete 3D data · ${props.what}`} onClose={props.onClose} wide>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
        Choose which saved depth maps and outlines to delete for the still pictures here. GIFs and videos have none.
      </div>
      {anyPerson && (
        <label className="check" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} />
          Also delete the data of {props.folders.filter((f) => f.person).length === 1 ? "this person's" : "these people's"} pictures in other folders
          (pictures their face was recognised in)
        </label>
      )}
      {err && <div className="error" role="alert">{err}</div>}
      {!groups && !err && <div className="faint">Looking at what's saved…</div>}
      {groups && groups.length === 0 && (
        <div className="faint">{ids && ids.length ? `Nothing is saved for these ${plural(ids.length, 'picture')}.` : 'There are no still pictures here.'}</div>
      )}
      {groups && groups.length > 0 && (
        <>
          <div className="faint" style={{ fontSize: 13 }}>{plural(ids?.length ?? 0, 'picture')} here.</div>
          {(['depth', 'outline'] as const).map((kind) => {
            const list = groups.filter((g) => g.kind === kind);
            if (!list.length) return null;
            return (
              <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <b style={{ fontSize: 13 }}>{KIND_TITLE[kind]}</b>
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
                      <span className="faint mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{plural(g.count, 'picture')} · {formatBytes(g.bytes)}</span>
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
          {chosen.length ? `Delete ${plural(maps, 'map')} (${formatBytes(bytes)})…` : 'Delete…'}
        </button>
      </div>
    </Modal>
  );
}
