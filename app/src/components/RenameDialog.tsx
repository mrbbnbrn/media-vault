// Rename (F2): one thing → a simple name box; several → numbered names,
// find & replace, added text, or one by one, with a preview. File
// extensions are always kept.

import { useMemo, useState } from 'react';
import { FolderIcon } from './Icons';
import { Modal } from './Dialogs';

export interface RenameEntry {
  kind: 'folder' | 'item';
  id: number;
  name: string;
  /** Items: the file extension (kept as it is). */
  ext?: string;
}

/** "Beach 01.jpg" → ["Beach 01", ".jpg"]; folders have no extension. */
export function splitName(e: RenameEntry): [string, string] {
  if (e.kind === 'item' && e.ext) {
    const suf = `.${e.ext}`;
    if (e.name.toLowerCase().endsWith(suf.toLowerCase()) && e.name.length > suf.length) {
      return [e.name.slice(0, -suf.length), e.name.slice(-suf.length)];
    }
  }
  return [e.name, ''];
}

type Mode = 'number' | 'replace' | 'add' | 'each';
type Style = 'space' | 'paren' | 'under';

const BAD = /[\\/:*?"<>|]/;

export function newNames(
  entries: RenameEntry[], mode: Mode,
  o: { base: string; start: number; style: Style; find: string; repl: string; matchCase: boolean; before: string; after: string; each: string[] },
): string[] {
  const last = o.start + entries.length - 1;
  const width = String(Math.max(0, last)).length;
  const pad = (n: number) => String(n).padStart(Math.max(2, width), '0');
  return entries.map((e, i) => {
    const [stem, suf] = splitName(e);
    let s = stem;
    if (mode === 'number') {
      const n = o.start + i;
      const base = o.base.trim();
      s = o.style === 'paren' ? `${base} (${n})` : o.style === 'under' ? `${base}_${pad(n)}` : `${base} ${pad(n)}`;
    } else if (mode === 'replace') {
      if (o.find) {
        const rx = new RegExp(o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), o.matchCase ? 'g' : 'gi');
        s = stem.replace(rx, () => o.repl);
      }
    } else if (mode === 'add') {
      s = `${o.before}${stem}${o.after}`;
    } else {
      s = o.each[i] ?? stem;
    }
    return s.trim() + suf;
  });
}

export function RenameDialog(props: {
  entries: RenameEntry[];
  onClose: () => void;
  onRename: (changes: { entry: RenameEntry; name: string }[]) => Promise<void>;
}) {
  const single = props.entries.length === 1;
  const [mode, setMode] = useState<Mode>('number');
  const firstStem = splitName(props.entries[0])[0];
  const [base, setBase] = useState(firstStem.replace(/[\s_(]*\d+\)?$/, '') || firstStem);
  const [start, setStart] = useState(1);
  const [style, setStyle] = useState<Style>('space');
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [each, setEach] = useState(() => props.entries.map((e) => splitName(e)[0]));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const names = useMemo(
    () => newNames(props.entries, single ? 'each' : mode, { base, start, style, find, repl, matchCase, before, after, each }),
    [props.entries, single, mode, base, start, style, find, repl, matchCase, before, after, each],
  );
  const problem = (() => {
    for (let i = 0; i < names.length; i++) {
      const [stem] = splitName({ ...props.entries[i], name: names[i] });
      if (!stem.trim()) return 'Every name needs some text.';
      const bad = names[i].match(BAD);
      if (bad) return `A name can't contain ${bad[0]}`;
    }
    const fs = props.entries.map((e, i) => (e.kind === 'folder' ? names[i].toLowerCase() : null)).filter((x): x is string => x != null);
    if (new Set(fs).size < fs.length) return 'Two folders would get the same name.';
    return null;
  })();
  const changes = props.entries.map((entry, i) => ({ entry, name: names[i] })).filter((c) => c.name !== c.entry.name);

  const submit = async () => {
    if (problem || busy) return;
    if (!changes.length) return props.onClose();
    setBusy(true);
    setErr(null);
    try {
      await props.onRename(changes);
      props.onClose();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
      setBusy(false);
    }
  };

  if (single) {
    const [, suf] = splitName(props.entries[0]);
    return (
      <Modal title={props.entries[0].kind === 'folder' ? 'Rename folder' : 'Rename'} onClose={props.onClose}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            <input className="input" style={{ flex: 1 }} value={each[0]} aria-label="New name" autoFocus
              onFocus={(e) => e.currentTarget.select()} onChange={(e) => setEach([e.target.value])} />
            {suf && <span className="faint mono">{suf}</span>}
          </div>
          {(problem || err) && <div className="error" role="alert">{problem ?? err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!!problem || busy}>Rename</button>
          </div>
        </form>
      </Modal>
    );
  }

  const nf = props.entries.filter((e) => e.kind === 'folder').length;
  const ni = props.entries.length - nf;
  return (
    <Modal title={`Rename ${[nf ? `${nf} folder${nf > 1 ? 's' : ''}` : '', ni ? `${ni} item${ni > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')}`} onClose={props.onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div role="group" aria-label="How" className="seg" style={{ alignSelf: 'flex-start' }}>
          {([['number', 'Numbered'], ['replace', 'Find and replace'], ['add', 'Add text'], ['each', 'One by one']] as const).map(([m, l]) => (
            <button key={m} type="button" className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{l}</button>
          ))}
        </div>

        {mode === 'number' && (
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2, minWidth: 200 }}>
              <label htmlFor="rn-base">Name</label>
              <input id="rn-base" className="input" value={base} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setBase(e.target.value)} />
            </div>
            <div className="field" style={{ width: 110 }}>
              <label htmlFor="rn-start">Start at</label>
              <input id="rn-start" className="input" type="number" min={0} value={start} onChange={(e) => setStart(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
            </div>
            <div role="group" aria-label="Style" className="seg">
              {([['space', `${base.trim() || 'Name'} 01`], ['paren', `${base.trim() || 'Name'} (1)`], ['under', `${base.trim() || 'Name'}_01`]] as const).map(([st, l]) => (
                <button key={st} type="button" className={style === st ? 'on' : ''} onClick={() => setStyle(st)}>{l}</button>
              ))}
            </div>
          </div>
        )}
        {mode === 'replace' && (
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="rn-find">Find</label>
              <input id="rn-find" className="input" value={find} autoFocus onChange={(e) => setFind(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="rn-repl">Replace with</label>
              <input id="rn-repl" className="input" value={repl} onChange={(e) => setRepl(e.target.value)} />
            </div>
            <label className="check" style={{ minHeight: 44 }}>
              <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
            </label>
          </div>
        )}
        {mode === 'add' && (
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="rn-before">At the start</label>
              <input id="rn-before" className="input" value={before} autoFocus onChange={(e) => setBefore(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="rn-after">At the end (before the extension)</label>
              <input id="rn-after" className="input" value={after} onChange={(e) => setAfter(e.target.value)} />
            </div>
          </div>
        )}

        <div className="rename-list" role="list" aria-label="New names">
          {props.entries.map((e, i) => {
            const [, suf] = splitName(e);
            const changed = names[i] !== e.name;
            return (
              <div key={`${e.kind}${e.id}`} role="listitem" className="rename-row">
                <span className="rename-old ellipsis" title={e.name}>{e.kind === 'folder' && <FolderIcon size={13} />} {e.name}</span>
                <span className="faint">→</span>
                {mode === 'each' ? (
                  <span className="row" style={{ gap: 4, flex: 1, minWidth: 0 }}>
                    <input className="input rename-input" value={each[i]} aria-label={`New name for ${e.name}`} autoFocus={i === 0}
                      onChange={(ev) => setEach((a) => a.map((x, k) => (k === i ? ev.target.value : x)))} />
                    {suf && <span className="faint mono">{suf}</span>}
                  </span>
                ) : (
                  <span className={`rename-new ellipsis${changed ? '' : ' faint'}`} title={names[i]}>{names[i]}</span>
                )}
              </div>
            );
          })}
        </div>

        {(problem || err) && <div className="error" role="alert">{problem ?? err}</div>}
        <div className="row-between">
          <span className="faint" style={{ fontSize: 13 }}>{changes.length ? `${changes.length} will change · Ctrl+Z undoes it` : 'Nothing changes yet'}</span>
          <span className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!!problem || busy || !changes.length}>Rename {changes.length || ''}</button>
          </span>
        </div>
      </form>
    </Modal>
  );
}
