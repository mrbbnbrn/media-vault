// "Why is this here?": why an item turned up in a search, worked out by the
// search's own rules (explain.rs) — matching words in the name or note, tags
// (direct or through a folder), recognised people, smart-search similarity
// and the filters it passed.

import { useEffect, useState, type ReactNode } from 'react';
import { api, thumbUrl, type Explanation, type Item, type Kind, type Ranges } from '../api';
import { embedQuery } from '../ml/smart';
import { Modal } from './Dialogs';
import { FaceIcon, FolderIcon, NoteIcon, SearchIcon, SparkleIcon, TagIcon } from './Icons';

export type WhyQuery =
  | { kind: 'search'; tags: string[]; names: string[]; people: number[] }
  | { kind: 'smart'; q: string };

/** Text with the matched parts marked (ranges count Unicode characters). */
export function highlight(text: string, ranges: Ranges): ReactNode[] {
  const chars = Array.from(text);
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of sorted) {
    if (s < at) continue;
    if (s > at) out.push(chars.slice(at, s).join(''));
    out.push(<mark key={s}>{chars.slice(s, e).join('')}</mark>);
    at = e;
  }
  if (at < chars.length) out.push(chars.slice(at).join(''));
  return out;
}

/** A short piece of a long note around the first match. */
function noteBit(note: string, ranges: Ranges): ReactNode[] {
  const chars = Array.from(note);
  if (chars.length <= 90 || !ranges.length) return highlight(note, ranges);
  const from = Math.max(0, ranges[0][0] - 30);
  const to = Math.min(chars.length, from + 90);
  const part = chars.slice(from, to).join('');
  const shifted = ranges.filter(([s, e]) => s >= from && e <= to).map(([s, e]): [number, number] => [s - from, e - from]);
  return [from > 0 ? '…' : '', ...highlight(part, shifted), to < chars.length ? '…' : ''];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function Row({ ok, icon, children }: { ok: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <li className={`why-row${ok ? '' : ' no'}`}>
      <span className="why-mark" aria-label={ok ? 'matches' : 'does not match'}>{ok ? '✓' : '✗'}</span>
      <span className="why-icon" aria-hidden="true">{icon}</span>
      <span className="why-text">{children}</span>
    </li>
  );
}

export function WhyHere({ item, query, kind, onClose }: { item: Item; query: WhyQuery; kind: Kind | 'any'; onClose: () => void }) {
  const [x, setX] = useState<Explanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const kinds = kind === 'any' ? [] : [kind];
      if (query.kind === 'smart') {
        const vec = Array.from(await embedQuery(query.q));
        return api.explainMatch(item.id, { kinds }, vec, null);
      }
      return api.explainMatch(item.id, { tags: query.tags, names: query.names, people: query.people, kinds });
    })()
      .then((r) => { if (live) setX(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => {
      live = false;
    };
  }, [item.id, query, kind]);

  const nameRanges: Ranges = x ? x.names.flatMap((n) => n.inName) : [];
  const where = x?.folderPath.length ? x.folderPath.join(' › ') : 'Top level';
  return (
    <Modal title="Why is this here?" onClose={onClose}>
      <div className="why-head">
        {item.thumb === 'ok' ? <img src={thumbUrl(item.id)} alt="" /> : <span className="why-thumb-none" />}
        <div style={{ minWidth: 0 }}>
          <div className="why-name">{x ? highlight(x.item.name, nameRanges) : item.name}</div>
          <div className="faint ellipsis" style={{ fontSize: 12 }}><FolderIcon size={12} /> {where}</div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!x && !error && <p className="faint" style={{ margin: 0 }}>Working it out…</p>}
      {x && (
        <>
          <p className={x.matched ? 'why-verdict' : 'why-verdict no'}>
            {x.matched ? 'It matches everything this search asks for:' : 'It no longer matches this search (something changed since it ran):'}
          </p>
          <ul className="why-list">
            {x.names.map((n) => (
              <Row key={`n${n.word}`} ok={n.found} icon={n.inName.length || !n.inNote.length ? <SearchIcon size={13} /> : <NoteIcon size={13} />}>
                {n.inName.length > 0 && <>“{n.word}” is in the name: <span className="why-quote">{highlight(x.item.name, n.inName)}</span></>}
                {n.inName.length === 0 && n.inNote.length > 0 && x.item.note && <>“{n.word}” is in your note: <span className="why-quote">{noteBit(x.item.note, n.inNote)}</span></>}
                {n.inName.length > 0 && n.inNote.length > 0 && <span className="faint"> (and in your note)</span>}
                {n.found && !n.inName.length && !n.inNote.length && <>“{n.word}” matches the name and note together</>}
                {!n.found && <>“{n.word}” isn't in the name or your note{n.inFolderPath ? <> — only in its folders' names, which a name search doesn't look at</> : null}</>}
                {n.found && n.inFolderPath && <span className="faint"> · also in its folder path</span>}
              </Row>
            ))}
            {x.tags.map((t) => (
              <Row key={`t${t.tag}`} ok={t.found} icon={<TagIcon size={13} />}>
                {t.own && <>Tagged <b>{t.tag}</b></>}
                {!t.own && t.fromFolders.length > 0 && <>Tagged <b>{t.tag}</b> through its folder {t.fromFolders.map((f) => `“${f}”`).join(', ')}</>}
                {t.own && t.fromFolders.length > 0 && <span className="faint"> (its folder {t.fromFolders.map((f) => `“${f}”`).join(', ')} has it too)</span>}
                {!t.found && <>Not tagged <b>{t.tag}</b></>}
              </Row>
            ))}
            {x.people.map((p) => (
              <Row key={`p${p.id}`} ok={p.found} icon={<FaceIcon size={13} />}>
                {p.faces > 0 && <><b>{p.name}</b> was recognised in it{p.faces > 1 ? ` (${p.faces} faces)` : ''}</>}
                {p.faces > 0 && p.inFolder && <span className="faint"> · and it's in {p.name}'s folder</span>}
                {p.faces === 0 && p.inFolder && <>It's in <b>{p.name}</b>'s person folder</>}
                {!p.found && <><b>{p.name}</b> isn't recognised in it</>}
              </Row>
            ))}
            {x.smart && (
              <Row ok={x.smart.kept} icon={<SparkleIcon size={13} />}>
                {x.smart.score == null ? <>Not analysed for smart search yet</> : <>
                  Looks like your search: <b>{pct(x.smart.score)} match</b>
                  {x.smart.rank != null && <span className="faint"> · number {x.smart.rank} of the results</span>}
                  <span className="why-meter" aria-hidden="true">
                    <span className="why-meter-fill" style={{ width: `${Math.max(2, Math.min(100, (x.smart.score / Math.max(x.smart.best, 0.01)) * 100))}%` }} />
                    <span className="why-meter-cut" style={{ left: `${Math.max(0, Math.min(100, (x.smart.cut / Math.max(x.smart.best, 0.01)) * 100))}%` }} />
                  </span>
                  <span className="faint why-small">
                    Smart search keeps matches of {pct(x.smart.cut)} or more (the best match, {pct(x.smart.best)}, minus 5), and always the best {x.smart.minResults}.
                  </span>
                </>}
              </Row>
            )}
            {x.filters.filter((f) => f.filter !== 'trash' || !f.passed).map((f) => (
              <Row key={`f${f.filter}`} ok={f.passed} icon={<span className="why-dot" />}>
                Only {f.wants}: it's {f.has}
              </Row>
            ))}
          </ul>
          {!x.names.length && !x.tags.length && !x.people.length && !x.smart && (
            <p className="faint" style={{ margin: 0 }}>This search has no words, tags or people, so everything that passes the filters is shown.</p>
          )}
        </>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" autoFocus onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
