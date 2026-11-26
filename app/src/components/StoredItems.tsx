// Music and other files in the window (kinds.ts): their grid tiles, the
// viewer's little music player, and the info panel a file opens to (Export
// is the only way to use one: nothing is ever decrypted to a temporary file).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Item } from '../apitypes';
import { formatTime } from '../media';
import { formatBytes } from '../theme';
import { savedVolume, saveVolume, typeLabel, typeLine } from '../kinds';
import { Modal } from './Dialogs';
import { MuteIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, SoundIcon } from './Icons';

/** A music note (tiles and the player). */
export const MusicIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 18V5l11-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="17" cy="16" r="3" />
  </svg>
);

/** What a music or file tile shows instead of a thumbnail. */
export function StoredTileFace(props: { it: Pick<Item, 'kind' | 'name' | 'ext'>; w: number }) {
  const { it, w } = props;
  const big = Math.max(18, Math.min(56, Math.round(w / 4)));
  return (
    <span className={`tile-msg stored-tile ${it.kind}`}>
      {it.kind === 'audio' ? (
        <span className="stored-note"><MusicIcon size={big} /></span>
      ) : (
        <span className="stored-ext" style={{ fontSize: Math.round(big * 0.6) }}>{typeLabel(it.ext)}</span>
      )}
      {w >= 90 && <span className="stored-name">{it.name}</span>}
    </span>
  );
}

/** Never lets a click, wheel or key-press reach the viewer behind (it would pan, zoom or move on). */
const keep = {
  onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(),
  onClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onWheel: (e: React.SyntheticEvent) => e.stopPropagation(),
  onContextMenu: (e: React.SyntheticEvent) => e.stopPropagation(),
};
/** Buttons never take the focus (Space stays the viewer's play / pause). */
const noFocus = (e: React.MouseEvent) => e.preventDefault();

/**
 * The viewer's music player: play / pause (Space too), a seek bar with the
 * time, volume, and the previous / next song of the list. Plays the vault's
 * stream (vault://, read in ranges like videos).
 */
export function AudioView(props: {
  src: string;
  name: string;
  ext: string;
  /** The viewer's play / pause (Space). */
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onEnded: () => void;
  onError: () => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [at, setAt] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(savedVolume);
  const [muted, setMuted] = useState(false);
  const cb = useRef(props);
  cb.current = props;
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (props.paused) a.pause();
    // Not allowed to start by itself: it waits for ▶.
    else a.play().catch(() => cb.current.onPausedChange(true));
  }, [props.paused, props.src]);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = vol;
    a.muted = muted;
  }, [vol, muted]);
  const seek = (s: number) => {
    const a = ref.current;
    if (a && Number.isFinite(s)) a.currentTime = Math.max(0, Math.min(dur || s, s));
  };
  const setVolume = (v: number) => {
    setVol(v);
    setMuted(false);
    saveVolume(v);
  };
  return (
    <div className="audio-view" {...keep}>
      <div className="audio-art" aria-hidden="true"><MusicIcon size={64} /></div>
      <div className="audio-name ellipsis" title={props.name}>{props.name}</div>
      <div className="audio-type faint">{typeLine('audio', props.ext)}</div>
      <input type="range" className="audio-seek" aria-label="Position" min={0} max={dur || 0} step={0.1} value={Math.min(at, dur || 0)}
        disabled={!dur} onChange={(e) => seek(Number(e.target.value))} />
      <div className="audio-times"><span>{formatTime(at * 1000) || '0:00'}</span><span>{dur ? formatTime(dur * 1000) : '–:––'}</span></div>
      <div className="audio-buttons">
        <button type="button" className="pbtn" aria-label="Previous song" title="Previous (←)" disabled={!props.onPrev} onMouseDown={noFocus} onClick={() => props.onPrev?.()}><PrevIcon /></button>
        <button type="button" className="pbtn lg" aria-label={props.paused ? 'Play' : 'Pause'} title={props.paused ? 'Play (Space)' : 'Pause (Space)'} onMouseDown={noFocus}
          onClick={() => props.onPausedChange(!props.paused)}>{props.paused ? <PlayIcon size={20} /> : <PauseIcon size={20} />}</button>
        <button type="button" className="pbtn" aria-label="Next song" title="Next (→)" disabled={!props.onNext} onMouseDown={noFocus} onClick={() => props.onNext?.()}><NextIcon /></button>
        <span className="audio-volume">
          <button type="button" className="pbtn" aria-label={muted || vol === 0 ? 'Sound on' : 'Mute'} title={muted || vol === 0 ? 'Sound on' : 'Mute'} onMouseDown={noFocus}
            onClick={() => (vol === 0 ? setVolume(0.8) : setMuted((m) => !m))}>{muted || vol === 0 ? <MuteIcon size={16} /> : <SoundIcon size={16} />}</button>
          <input type="range" aria-label="Volume" min={0} max={1} step={0.01} value={muted ? 0 : vol} onChange={(e) => setVolume(Number(e.target.value))} />
        </span>
      </div>
      <audio ref={ref} src={props.src} preload="auto"
        onLoadedMetadata={(e) => setDur(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onPlay={() => cb.current.onPausedChange(false)}
        // Pausing at the very end is the song ending, not a pause (the next one plays).
        onPause={(e) => !e.currentTarget.ended && cb.current.onPausedChange(true)}
        onEnded={() => cb.current.onEnded()}
        onError={() => cb.current.onError()} />
    </div>
  );
}

/** A file in the viewer (it never opens there from the library; just in case). */
export function FileView(props: { name: string; ext: string; size: number | null }) {
  return (
    <div className="media-failed stored-view" {...keep}>
      <span className="stored-ext big">{typeLabel(props.ext)}</span>
      <span>{props.name}</span>
      <span className="faint">{typeLine('file', props.ext)}{props.size != null ? ` · ${formatBytes(props.size)}` : ''}</span>
      <span className="faint">Kept safely in the vault. Media Vault doesn't open this kind of file: export it to use it.</span>
    </div>
  );
}

const when = (seconds: number | null | undefined) =>
  seconds ? new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

/** What opening a file shows: what is known about it, and Export (the only way to use it). */
export function FileInfoDialog(props: { item: Item; folder: string; onExport: () => void; onClose: () => void }) {
  const it = props.item;
  const rows: [string, ReactNode][] = [
    ['Name', it.name],
    ['Type', typeLine(it.kind, it.ext)],
    ['Size', formatBytes(it.size)],
    ['Added', when(it.importedAt)],
    ['Date', when(it.takenAt)],
    ['Folder', props.folder],
    ['Note', it.note ?? ''],
  ];
  return (
    <Modal title="File" onClose={props.onClose}>
      <div className="file-info">
        <span className="stored-ext big" aria-hidden="true">{typeLabel(it.ext)}</span>
        <dl className="info-list">
          {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="faint">Kept encrypted in the vault, exactly as it was. Media Vault doesn't open this kind of file: export it to use it.</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Close</button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={props.onExport}>Export…</button>
      </div>
    </Modal>
  );
}
