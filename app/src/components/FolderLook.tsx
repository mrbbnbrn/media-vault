// Colour dot and emoji for a folder, shown in the sidebar and on its card.

import { useState } from 'react';
import type { FolderCard } from '../api';
import { Modal } from './Dialogs';

export const FOLDER_COLORS = ['#2ec4b6', '#4c8dff', '#8b6cff', '#e05d9d', '#ff6b5e', '#ff9f43', '#f4c542', '#7bd36a', '#9aa4b2', '#ffffff'];

const EMOJI = (
  '⭐ ❤️ 🔥 ✨ 🌊 🏖️ 🏔️ 🌲 🌸 🌙 ☀️ 🌈 🎉 🎂 🎵 🎮 🎬 📷 🎨 📚 ✈️ 🚗 🏠 🐶 🐱 🍕 ☕ ⚽ 🏀 💼 ' +
  '👶 👧 👦 👩 👨 👵 👴 💑 👪 🧑‍🤝‍🧑 😀 😎 🥰 😂 🤔 😴 🙈 💎 🔒 📌'
).split(' ');

export function FolderLookDialog(props: { folder: FolderCard; onClose: () => void; onSave: (color: string | null, emoji: string | null) => Promise<void> }) {
  const [color, setColor] = useState<string | null>(props.folder.color);
  const [emoji, setEmoji] = useState<string>(props.folder.emoji ?? '');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await props.onSave(color, emoji.trim() || null);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title={`Colour and emoji for “${props.folder.name}”`} onClose={props.onClose}>
      <div className="look-preview">
        {color && <span className="fdot lg" style={{ background: color }} />}
        {emoji && <span className="femoji lg">{emoji}</span>}
        <b>{props.folder.name}</b>
      </div>
      <div className="field">
        <span className="label">Colour</span>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className={`fswatch none${color === null ? ' on' : ''}`} onClick={() => setColor(null)} aria-label="No colour">∅</button>
          {FOLDER_COLORS.map((c) => (
            <button key={c} type="button" className={`fswatch${color === c ? ' on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />
          ))}
          <label className="fswatch custom" title="Any colour">
            <input type="color" value={color ?? '#2ec4b6'} onChange={(e) => setColor(e.target.value)} aria-label="Pick any colour" />
          </label>
        </div>
      </div>
      <div className="field">
        <label htmlFor="emoji-input">Emoji</label>
        <div className="row" style={{ gap: 8 }}>
          <input id="emoji-input" className="input small" style={{ width: 90, fontSize: 18 }} value={emoji} maxLength={8}
            placeholder="none" onChange={(e) => setEmoji(e.target.value)} />
          <button type="button" className="link" onClick={() => setEmoji('')}>No emoji</button>
          <span className="faint" style={{ fontSize: 12 }}>Type any emoji (Windows: Win + .) or pick one:</span>
        </div>
        <div className="emoji-grid">
          {EMOJI.map((e) => (
            <button key={e} type="button" className={emoji === e ? 'on' : ''} onClick={() => setEmoji(e)}>{e}</button>
          ))}
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

/** The colour dot and emoji before a folder's name. */
export function FolderMark({ f }: { f: Pick<FolderCard, 'color' | 'emoji'> }) {
  return (
    <>
      {f.color && <span className="fdot" style={{ background: f.color }} aria-hidden="true" />}
      {f.emoji && <span className="femoji" aria-hidden="true">{f.emoji}</span>}
    </>
  );
}
