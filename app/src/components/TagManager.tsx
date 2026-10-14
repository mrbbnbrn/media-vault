// Tag manager: every tag with how many items and folders have it; rename
// (renaming to an existing tag merges the two), delete, and give tags a colour.

import { useCallback, useEffect, useState } from 'react';
import { api, type TagInfo } from '../api';
import { plural } from '../undo';
import { ConfirmDialog, Modal } from './Dialogs';
import { CloseIcon, SearchIcon, TagIcon } from './Icons';

export const TAG_COLORS = ['#2EC4B6', '#5DA9E9', '#9B8AFB', '#E36BAE', '#EF6F6C', '#F4A259', '#F2D06B', '#7BC47F', '#A0A6AD'];

export function TagManager(props: {
  onClose: () => void;
  onChanged: () => void;
  onSearch: (tag: string) => void;
  did: (label: string, undo: () => Promise<unknown>) => void;
}) {
  const [tags, setTags] = useState<TagInfo[] | null>(null);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [palette, setPalette] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ t: 'delete'; tag: TagInfo } | { t: 'merge'; tag: TagInfo; into: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.tagList().then(setTags).catch((e) => setErr(String(e))), []);
  useEffect(() => {
    load();
  }, [load]);
  const after = async () => {
    await load();
    props.onChanged();
  };

  const rename = async (t: TagInfo, to: string) => {
    const name = to.trim().replace(/^#/, '');
    setEditing(null);
    if (!name || name === t.name) return;
    const exists = tags?.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.name !== t.name);
    if (exists && !ask) {
      setAsk({ t: 'merge', tag: t, into: exists.name });
      return;
    }
    await doRename(t, name);
  };
  const doRename = async (t: TagInfo, name: string) => {
    try {
      const before = await api.renameTag(t.name, name);
      props.did(`Renamed tag “${t.name}” to “${name}”`, () => api.restoreTag(before, name));
      await after();
    } catch (e) {
      setErr(String(e));
    }
  };
  const remove = async (t: TagInfo) => {
    try {
      const before = await api.deleteTag(t.name);
      props.did(`Deleted tag “${t.name}”`, () => api.restoreTag(before, null));
      await after();
    } catch (e) {
      setErr(String(e));
    }
  };
  const color = async (t: TagInfo, c: string | null) => {
    setPalette(null);
    const old = await api.setTagColor(t.name, c);
    props.did(`Changed the colour of “${t.name}”`, () => api.setTagColor(t.name, old));
    await after();
  };

  const q = filter.trim().toLowerCase();
  const shown = (tags ?? []).filter((t) => !q || t.name.toLowerCase().includes(q));
  return (
    <Modal title="Tags" onClose={props.onClose} wide>
      <div className="row" style={{ gap: 8 }}>
        <div className="search" style={{ flex: 1 }}>
          <SearchIcon />
          <input value={filter} placeholder="Find a tag…" aria-label="Find a tag" onChange={(e) => setFilter(e.target.value)} autoFocus />
        </div>
        <span className="faint" style={{ fontSize: 13 }}>{tags ? plural(tags.length, 'tag') : 'Loading…'}</span>
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      <div className="tagman" role="list">
        {shown.map((t) => (
          <div key={t.name} className="tagman-row" role="listitem">
            <span className="tagman-color-wrap">
              <button type="button" className="tagman-color" style={{ background: t.color ?? 'transparent' }} aria-label={`Colour of ${t.name}`}
                onClick={() => setPalette(palette === t.name ? null : t.name)} />
              {palette === t.name && (
                <span className="tagman-palette">
                  {TAG_COLORS.map((c) => <button key={c} type="button" style={{ background: c }} aria-label={c} onClick={() => color(t, c)} />)}
                  <button type="button" className="none" aria-label="No colour" onClick={() => color(t, null)}><CloseIcon size={11} /></button>
                </span>
              )}
            </span>
            {editing === t.name ? (
              <input className="input tagman-input" value={draft} autoFocus aria-label="New name"
                onChange={(e) => setDraft(e.target.value)} onBlur={() => rename(t, draft)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') rename(t, draft);
                  else if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); }
                }} />
            ) : (
              <button type="button" className="link tagman-name" title="Show everything with this tag" onClick={() => props.onSearch(t.name)}>
                <TagIcon size={12} /> {t.name}
              </button>
            )}
            <span className="faint tagman-count">
              {t.items ? plural(t.items, 'item') : ''}{t.items && t.folders ? ' · ' : ''}{t.folders ? plural(t.folders, 'folder') : ''}
            </span>
            <button type="button" className="btn btn-sm ghost" onClick={() => { setEditing(t.name); setDraft(t.name); }}>Rename</button>
            <button type="button" className="btn btn-sm ghost danger-text" onClick={() => setAsk({ t: 'delete', tag: t })}>Delete</button>
          </div>
        ))}
        {tags && !shown.length && <span className="faint">{tags.length ? 'No tag matches.' : 'No tags yet. Tag items with Tag… or by typing #name in quick sort.'}</span>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Done</button>
      </div>
      {ask?.t === 'delete' && (
        <ConfirmDialog title={`Delete the tag “${ask.tag.name}”?`} confirm="Delete tag" danger onClose={() => setAsk(null)} onConfirm={() => remove(ask.tag)}>
          It comes off {[ask.tag.items ? plural(ask.tag.items, 'item') : '', ask.tag.folders ? plural(ask.tag.folders, 'folder') : ''].filter(Boolean).join(' and ') || 'everything'}.
          The items themselves stay. Ctrl+Z brings it back.
        </ConfirmDialog>
      )}
      {ask?.t === 'merge' && (
        <ConfirmDialog title={`Merge “${ask.tag.name}” into “${ask.into}”?`} confirm="Merge" onClose={() => setAsk(null)} onConfirm={() => doRename(ask.tag, ask.into)}>
          There is already a tag called “{ask.into}”. Everything tagged “{ask.tag.name}” gets “{ask.into}” instead. Ctrl+Z undoes it.
        </ConfirmDialog>
      )}
    </Modal>
  );
}
