// Boxes around found faces, drawn over the picture in the viewer. Known people
// get a teal box with their name (click: everything of that person); unknown
// faces an amber dashed box "Who is it?" (click: say who it is).

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type FaceBox, type FolderCard } from '../api';
import type { Box } from '../flip';
import { PromptDialog } from './Dialogs';

// Person folder names, loaded once and shared by every viewer.
let people: Promise<FolderCard[]> | null = null;
export function personFolders(fresh = false): Promise<FolderCard[]> {
  if (!people || fresh) {
    people = api.folders().then((f) => f.filter((x) => x.person).sort((a, b) => a.name.localeCompare(b.name)));
    people.catch(() => {
      people = null;
    });
  }
  return people;
}

export function FaceLayer(props: {
  faces: FaceBox[];
  /** Where the picture is drawn, in the stage's own pixels. */
  rect: Box;
  onShowPerson?: (folderId: number) => void;
  /** A face was named: load the boxes again. */
  onChanged: () => void;
  onMessage: (text: string) => void;
}) {
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [ask, setAsk] = useState<{ face: FaceBox; left: number; top: number } | null>(null);
  useEffect(() => {
    let alive = true;
    personFolders().then((f) => alive && setNames(new Map(f.map((x) => [x.id, x.name])))).catch(() => {});
    return () => {
      alive = false;
    };
  }, [props.faces]);

  const r = props.rect;
  return (
    <div className="face-layer">
      {props.faces.map((f) => {
        const known = f.person != null;
        const left = r.left + f.x * r.width;
        const top = r.top + f.y * r.height;
        const name = known ? names.get(f.person!) ?? 'Someone you know' : 'Who is it?';
        return (
          <button key={f.id} type="button" className={`face-box ${known ? 'known' : 'unknown'}`}
            style={{ left, top, width: f.w * r.width, height: f.h * r.height }}
            title={known ? `See everything of ${name}` : 'Say who this is'}
            aria-label={known ? `${name} — see everything of this person` : 'Unknown face — say who this is'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (known) props.onShowPerson?.(f.person!);
              else {
                const b = e.currentTarget.getBoundingClientRect();
                setAsk({ face: f, left: b.left, top: b.bottom + 6 });
              }
            }}>
            <span className="face-tag">{name}</span>
          </button>
        );
      })}
      {ask && (
        <WhoIsIt face={ask.face} left={ask.left} top={ask.top} onClose={() => setAsk(null)}
          onDone={(msg) => {
            setAsk(null);
            props.onMessage(msg);
            props.onChanged();
          }} />
      )}
    </div>
  );
}

function WhoIsIt(props: { face: FaceBox; left: number; top: number; onClose: () => void; onDone: (msg: string) => void }) {
  const [list, setList] = useState<FolderCard[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    personFolders().then(setList).catch(() => setList([]));
  }, []);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!naming && !ref.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  }, [naming]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (list ?? []).filter((f) => !t || f.name.toLowerCase().includes(t));
  }, [list, q]);

  const accept = async (f: FolderCard) => {
    setBusy(true);
    try {
      await api.facesAccept([props.face.id], f.id);
      props.onDone(`Marked as ${f.name}`);
    } catch (e) {
      setBusy(false);
      props.onDone(`Couldn't save that: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Shown above everything (the picture may be inside a moving, scaled layer).
  return createPortal(
    <div onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div ref={ref} className="who-pop" role="dialog" aria-label="Who is this?"
        style={{ left: Math.min(props.left, window.innerWidth - 260), top: Math.min(props.top, window.innerHeight - 320) }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose();
          if (e.key === 'Enter' && shown.length === 1) accept(shown[0]);
        }}>
        <b>Who is this?</b>
        <input className="input small" autoFocus placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        <div className="who-list">
          {list === null && <span className="faint">Loading…</span>}
          {list !== null && shown.length === 0 && <span className="faint">{list.length ? 'Nobody with that name.' : 'No person folders yet.'}</span>}
          {shown.map((f) => (
            <button key={f.id} type="button" className="who-row" disabled={busy} onClick={() => accept(f)}>
              This is <b>{f.name}</b>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setNaming(true)}>New person…</button>
      </div>
      {naming && (
        <PromptDialog title="New person" label="Name" confirm="Create" initial={q.trim()}
          hint="A person folder is made for them, and this picture goes in it."
          onClose={() => setNaming(false)}
          onSubmit={async (name) => {
            await api.facesNewPerson(name.trim(), null, [props.face.id]);
            personFolders(true).catch(() => {});
            props.onDone(`Made a folder for ${name.trim()}`);
          }} />
      )}
    </div>,
    document.body,
  );
}
