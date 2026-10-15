// Boxes around found faces, drawn over the picture in the viewer. Known people
// get a teal box with their name (click: everything of that person); unknown
// faces an amber dashed box "Who is it?" (click: say who it is). Middle-click
// opens the person in a new tab behind this one, Ctrl+middle-click marks a
// face "not important", right-click has everything else.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type FaceBox, type FolderCard } from '../api';
import type { Box } from '../flip';
import { ContextMenu, PromptDialog } from './Dialogs';

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

/** What a face's right-click menu and the picture's menu can do with faces. */
export interface FaceTools {
  /** The "not important" faces are shown too (dimmed). */
  showHidden: boolean;
  setShowHidden: (on: boolean) => void;
  /** Forget every face in this picture and look again. */
  reset: () => void;
}

/** Takes a face's name off (so it isn't suggested for them again) and hides
 *  it: "not important". A hidden one is shown again. */
async function toggleImportant(f: FaceBox): Promise<string> {
  if (f.hidden) {
    await api.facesHide([f.id], false);
    return 'Important again';
  }
  if (f.person != null) await api.facesReject([f.id], f.person);
  await api.facesHide([f.id], true);
  return 'Hidden: not important';
}

export function FaceLayer(props: {
  faces: FaceBox[];
  /** Where the picture is drawn, in the stage's own pixels. */
  rect: Box;
  onShowPerson?: (folderId: number) => void;
  /** Opens a person in a new tab behind this one (middle-click). */
  onOpenPerson?: (folderId: number) => void;
  /** A face was named: load the boxes again. */
  onChanged: () => void;
  onMessage: (text: string) => void;
  /** "Who is it?" is open (shown faces must stay while you answer). */
  onAsking?: (asking: boolean) => void;
  tools?: FaceTools;
}) {
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [ask, setAsk] = useState<{ face: FaceBox; left: number; top: number } | null>(null);
  const [menu, setMenu] = useState<{ face: FaceBox; x: number; y: number } | null>(null);
  // Pointing at a box or answering "Who is it?" keeps the boxes on screen.
  const [over, setOver] = useState(false);
  const onAsking = props.onAsking;
  const holding = ask != null || menu != null || over;
  useEffect(() => {
    onAsking?.(holding);
  }, [holding, onAsking]);
  useEffect(() => () => onAsking?.(false), [onAsking]);
  useEffect(() => {
    let alive = true;
    personFolders().then((f) => alive && setNames(new Map(f.map((x) => [x.id, x.name])))).catch(() => {});
    return () => {
      alive = false;
    };
  }, [props.faces]);

  const nameOf = (f: FaceBox) => (f.person != null ? names.get(f.person) ?? 'Someone you know' : null);
  const important = async (f: FaceBox) => {
    try {
      props.onMessage(await toggleImportant(f));
      props.onChanged();
    } catch (e) {
      props.onMessage(`Couldn't change it: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const openBehind = (f: FaceBox) => {
    const name = nameOf(f);
    if (f.person == null || !name) {
      props.onMessage('Say who this is first');
      return;
    }
    if (!props.onOpenPerson) return;
    props.onOpenPerson(f.person);
    props.onMessage(`Opened ${name} in a new tab`);
  };
  const askAbout = (f: FaceBox, el: Element) => {
    const b = el.getBoundingClientRect();
    setAsk({ face: f, left: b.left, top: b.bottom + 6 });
  };
  const boxEls = useRef(new Map<number, HTMLElement>());

  const r = props.rect;
  const mf = menu?.face;
  const mname = mf ? nameOf(mf) : null;
  return (
    <div className="face-layer">
      {props.faces.map((f) => {
        const known = f.person != null;
        const left = r.left + f.x * r.width;
        const top = r.top + f.y * r.height;
        const name = f.hidden ? 'Not important' : known ? nameOf(f)! : 'Who is it?';
        const hint = f.hidden
          ? 'Not important · Ctrl+middle-click: important again'
          : known
            ? `${name} · double-click: see all · middle-click: new tab · right-click: more`
            : 'Who is it? · click to say · right-click: more';
        return (
          <button key={f.id} type="button" className={`face-box ${f.hidden ? 'hidden-face' : known ? 'known' : 'unknown'}`}
            ref={(el) => {
              if (el) boxEls.current.set(f.id, el);
              else boxEls.current.delete(f.id);
            }}
            style={{ left, top, width: f.w * r.width, height: f.h * r.height }}
            title={hint} aria-label={hint}
            onPointerDown={(e) => e.stopPropagation()}
            // No auto-scroll circle on middle-click.
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.ctrlKey || e.metaKey) important(f);
              else if (!f.hidden) openBehind(f);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setAsk(null);
              setMenu({ face: f, x: e.clientX, y: e.clientY });
            }}
            onPointerEnter={() => setOver(true)} onPointerLeave={() => setOver(false)}
            onClick={(e) => {
              e.stopPropagation();
              askAbout(f, e.currentTarget);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (!known || f.hidden) return;
              setAsk(null);
              props.onShowPerson?.(f.person!);
            }}>
            <span className="face-tag">{name}</span>
          </button>
        );
      })}
      {menu && mf && createPortal(
        <div onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          <ContextMenu x={menu.x} y={menu.y} title={mf.hidden ? 'Not important face' : mname ?? 'Unknown face'} onClose={() => setMenu(null)} items={[
            ...(mf.person != null && mname && !mf.hidden ? [
              { label: `See everything of ${mname}`, hint: 'double-click', onSelect: () => { setMenu(null); props.onShowPerson?.(mf.person!); } },
              ...(props.onOpenPerson ? [{ label: `Open ${mname} in a new tab`, hint: 'middle-click', onSelect: () => { setMenu(null); openBehind(mf); } }] : []),
            ] : []),
            ...(!mf.hidden ? [{
              label: mname ? 'Change who this is…' : 'Say who this is…', hint: 'click', sepBefore: mf.person != null,
              onSelect: () => {
                const el = boxEls.current.get(mf.id);
                setMenu(null);
                if (el) askAbout(mf, el);
              },
            }] : []),
            ...(mname && !mf.hidden ? [{
              label: `This isn't ${mname}`,
              onSelect: async () => {
                setMenu(null);
                try {
                  await api.facesReject([mf.id], mf.person!);
                  props.onMessage(`Not ${mname} any more`);
                  props.onChanged();
                } catch (e) {
                  props.onMessage(`Couldn't change it: ${e instanceof Error ? e.message : String(e)}`);
                }
              },
            }] : []),
            { label: mf.hidden ? 'Important after all' : 'Not important', hint: 'Ctrl+middle-click', onSelect: () => { setMenu(null); important(mf); } },
            ...(props.tools ? [
              { label: "Show 'not important' faces too", checked: props.tools.showHidden, sepBefore: true, onSelect: () => { setMenu(null); props.tools!.setShowHidden(!props.tools!.showHidden); } },
              { label: 'Reset faces in this picture and scan again…', onSelect: () => { setMenu(null); props.tools!.reset(); } },
            ] : []),
          ]} />
        </div>,
        document.body,
      )}
      {ask && (
        <WhoIsIt face={ask.face} left={ask.left} top={ask.top}
          current={ask.face.person != null ? { id: ask.face.person, name: names.get(ask.face.person) ?? 'Someone you know' } : null}
          onShowPerson={props.onShowPerson ? (id) => { setAsk(null); props.onShowPerson!(id); } : undefined}
          onClose={() => { setAsk(null); setOver(false); }}
          onDone={(msg) => {
            setAsk(null);
            props.onMessage(msg);
            props.onChanged();
          }} />
      )}
    </div>
  );
}

function WhoIsIt(props: {
  face: FaceBox; left: number; top: number; onClose: () => void; onDone: (msg: string) => void;
  /** The face already has a name: the box offers to change or remove it. */
  current?: { id: number; name: string } | null;
  onShowPerson?: (folderId: number) => void;
}) {
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
    return (list ?? []).filter((f) => f.id !== props.current?.id && (!t || f.name.toLowerCase().includes(t)));
  }, [list, q, props.current?.id]);
  const cur = props.current ?? null;
  /** Takes the name off this face ("not this person": it won't be suggested for them again). */
  const unname = async () => {
    if (cur) await api.facesReject([props.face.id], cur.id);
  };

  const accept = async (f: FolderCard) => {
    setBusy(true);
    try {
      await api.facesAccept([props.face.id], f.id);
      props.onDone(cur ? `Changed to ${f.name}` : `Marked as ${f.name}`);
    } catch (e) {
      setBusy(false);
      props.onDone(`Couldn't save that: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Shown above everything (the picture may be inside a moving, scaled layer).
  return createPortal(
    <div onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div ref={ref} className="who-pop" role="dialog" aria-label={cur ? `Change ${cur.name}` : 'Who is this?'}
        style={{ left: Math.min(props.left, window.innerWidth - 260), top: Math.min(props.top, window.innerHeight - 320) }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose();
          if (e.key === 'Enter' && shown.length === 1) accept(shown[0]);
        }}>
        {cur ? (
          <>
            <span className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span>This is <b>{cur.name}</b></span>
              {props.onShowPerson && <button type="button" className="link" onClick={() => props.onShowPerson!(cur.id)}>See all</button>}
            </span>
            <button type="button" className="btn btn-sm" disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await unname();
                  props.onDone(`Not ${cur.name} any more`);
                } catch (e) {
                  setBusy(false);
                  props.onDone(`Couldn't change it: ${e instanceof Error ? e.message : String(e)}`);
                }
              }}>This isn't {cur.name}</button>
            <span className="faint" style={{ fontSize: 12 }}>Or change it to:</span>
          </>
        ) : <b>Who is this?</b>}
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
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn-sm" style={{ flex: 1 }} disabled={busy} onClick={() => setNaming(true)}>New person…</button>
          <button type="button" className="btn btn-sm" style={{ flex: 1 }} disabled={busy} title="Hide this face: it's never suggested or asked about again (People → Hidden people shows it again)"
            onClick={async () => {
              setBusy(true);
              try {
                await unname();
                await api.facesHide([props.face.id], true);
                props.onDone('Hidden: not important');
              } catch (e) {
                setBusy(false);
                props.onDone(`Couldn't hide it: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}>Not important</button>
        </div>
      </div>
      {naming && (
        <PromptDialog title="New person" label="Name" confirm="Create" initial={q.trim()}
          hint="A person folder is made for them, and every photo they are recognised in shows on their page. Nothing is moved."
          onClose={() => setNaming(false)}
          onSubmit={async (name) => {
            await unname();
            await api.facesNewPerson(name.trim(), null, [props.face.id]);
            personFolders(true).catch(() => {});
            props.onDone(`Made a folder for ${name.trim()}`);
          }} />
      )}
    </div>,
    document.body,
  );
}
