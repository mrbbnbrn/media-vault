// The library's search bars: plain search (tags, names, people), smart search
// (what the picture shows) and the tag-name bar.

import { useEffect, useState } from 'react';
import { type FolderCard, type TagCount } from '../../api';
import { CloseIcon, FolderIcon, FaceIcon, SearchIcon, SparkleIcon, TagIcon } from '../../components/Icons';
import { peopleInText } from '../../peoplelogic';

export type SearchValue = { tags: string[]; names: string[]; people: number[] };

export function SearchBar(props: {
  tags: TagCount[]; folders: FolderCard[]; value: SearchValue; onChange: (v: SearchValue) => void; onOpenFolder: (id: number) => void;
  smart: boolean; smartQuery: string; onSmart: (q: string) => void; onEscape: () => void;
}) {
  if (props.smart) return <SmartBar query={props.smartQuery} onSearch={props.onSmart} onEscape={props.onEscape} />;
  return <TagNameBar {...props} />;
}

/** Smart search: type a description, Enter to search. */
export function SmartBar(props: { query: string; onSearch: (q: string) => void; onEscape: () => void }) {
  const [text, setText] = useState(props.query);
  useEffect(() => setText(props.query), [props.query]);
  return (
    <div className="search smart">
      <SparkleIcon />
      <label htmlFor="lib-search" className="sr-only">Smart search</label>
      <input id="lib-search" value={text} autoComplete="off" placeholder="Describe what you're looking for… (any language)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); props.onSearch(text.trim()); }
          else if (e.key === 'Escape') {
            // Esc clears the box; Esc on an empty box leaves the search.
            if (text) setText('');
            else {
              (e.target as HTMLInputElement).blur();
              props.onEscape();
            }
          }
        }} />
      {text && (
        <button type="button" className="link" aria-label="Clear" onClick={() => { setText(''); props.onSearch(''); }}><CloseIcon size={12} /></button>
      )}
    </div>
  );
}

export function TagNameBar(props: { tags: TagCount[]; folders: FolderCard[]; value: SearchValue; onChange: (v: SearchValue) => void; onOpenFolder: (id: number) => void; onEscape: () => void }) {
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const [hi, setHi] = useState(0);
  const fold = (x: string) => x.toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/\u0307/g, '');
  const q = fold(text.trim());
  const { tags, names, people } = props.value;
  const starts = (x: string) => Number(!fold(x).startsWith(q));
  const tagHits = props.tags
    .filter((t) => !tags.some((v) => v.toLowerCase() === t.name.toLowerCase()))
    .filter((t) => !q || fold(t.name).includes(q))
    .sort((a, b) => starts(a.name) - starts(b.name))
    .slice(0, 8);
  // People (person folders) and other folders whose name matches.
  const personHits = props.folders
    .filter((f) => f.person && !people.includes(f.id) && (!q || fold(f.name).includes(q)))
    .sort((a, b) => starts(a.name) - starts(b.name))
    .slice(0, q ? 5 : 3);
  const folderHits = q
    ? props.folders.filter((f) => !f.person && fold(f.name).includes(q)).sort((a, b) => starts(a.name) - starts(b.name)).slice(0, 5)
    : [];
  // "Baran + Ayşe": photos with both of them.
  const together = (peopleInText(text, props.folders) ?? []).filter((id) => !people.includes(id));
  type Opt =
    | { t: 'people'; ids: number[]; name: string; hint: string }
    | { t: 'person'; id: number; name: string; hint: string }
    | { t: 'tag'; name: string; hint: string }
    | { t: 'folder'; id: number; name: string; hint: string }
    | { t: 'name'; text: string };
  const opts: Opt[] = [
    ...(together.length >= 2 ? [{ t: 'people', ids: together, name: together.map((id) => props.folders.find((f) => f.id === id)?.name ?? '').join(' + '), hint: 'together in a photo' } as Opt] : []),
    ...personHits.map((f): Opt => ({ t: 'person', id: f.id, name: f.name, hint: 'person' })),
    ...tagHits.map((t): Opt => ({
      t: 'tag', name: t.name,
      hint: `${t.items ? `${t.items} items` : ''}${t.items && t.folders ? ' · ' : ''}${t.folders ? `${t.folders} folders` : ''}`,
    })),
    ...folderHits.map((f): Opt => ({ t: 'folder', id: f.id, name: f.name, hint: f.path.length ? f.path.map((c) => c.name).join(' › ') : 'open folder' })),
    ...(q ? [{ t: 'name', text: text.trim() } as Opt] : []),
  ];
  const choose = (o: Opt | undefined) => {
    if (!o) return;
    if (o.t === 'people') props.onChange({ tags, names, people: [...people, ...o.ids] });
    else if (o.t === 'person') props.onChange({ tags, names, people: [...people, o.id] });
    else if (o.t === 'tag') props.onChange({ tags: [...tags, o.name], names, people });
    else if (o.t === 'folder') props.onOpenFolder(o.id);
    else props.onChange({ tags, names: [...names, o.text], people });
    setText('');
    setHi(0);
  };
  const any = tags.length || names.length || people.length;
  const personName = (id: number) => props.folders.find((f) => f.id === id)?.name ?? 'person';
  return (
    <div className="search">
      <SearchIcon />
      {people.map((p) => (
        <span key={`p${p}`} className="chip accent"><FaceIcon size={11} /> {personName(p)}
          <button type="button" aria-label={`Remove ${personName(p)}`} onClick={() => props.onChange({ tags, names, people: people.filter((x) => x !== p) })}><CloseIcon size={11} /></button>
        </span>
      ))}
      {tags.map((t) => (
        <span key={`t${t}`} className="chip accent"><TagIcon size={11} /> {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => props.onChange({ tags: tags.filter((x) => x !== t), names, people })}><CloseIcon size={11} /></button>
        </span>
      ))}
      {names.map((n) => (
        <span key={`n${n}`} className="chip name">“{n}” in name
          <button type="button" aria-label={`Remove ${n}`} onClick={() => props.onChange({ tags, names: names.filter((x) => x !== n), people })}><CloseIcon size={11} /></button>
        </span>
      ))}
      <label htmlFor="lib-search" className="sr-only">Search people, tags, folders or file names</label>
      <input id="lib-search" value={text} placeholder={any ? 'Narrow down…' : 'Search people, tags, folders or file names…'} autoComplete="off"
        onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
        onChange={(e) => { setText(e.target.value); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); choose(opts[hi]); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, opts.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Backspace' && !text && any) {
            if (names.length) props.onChange({ tags, names: names.slice(0, -1), people });
            else if (tags.length) props.onChange({ tags: tags.slice(0, -1), names, people });
            else props.onChange({ tags, names, people: people.slice(0, -1) });
          } else if (e.key === 'Escape') {
            // Esc clears what you typed; Esc again leaves the search.
            if (text) setText('');
            else {
              (e.target as HTMLInputElement).blur();
              props.onEscape();
            }
          }
        }} />
      {focus && opts.length > 0 && (
        <div className="menu suggest" role="listbox">
          {opts.map((o, i) => (
            <button key={o.t === 'name' ? 'name' : o.t === 'people' ? 'people' : `${o.t}${'id' in o ? o.id : o.name}`} type="button" role="option" aria-selected={i === hi}
              className={`menu-item${i === hi ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
              {o.t === 'person' || o.t === 'people' ? <><FaceIcon size={13} /> {o.name}<span className="hint">{o.hint}</span></>
                : o.t === 'tag' ? <><TagIcon size={13} /> {o.name}<span className="hint">{o.hint}</span></>
                : o.t === 'folder' ? <><FolderIcon size={13} /> {o.name}<span className="hint">{o.hint}</span></>
                : <><SearchIcon size={13} /> File name contains “{o.text}”</>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
