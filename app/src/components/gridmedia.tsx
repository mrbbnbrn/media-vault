// What the Breathing grid, Pulse grid and Parallax layers show in each piece:
// a playing video (only a few at once, always muted), a video's still, a GIF
// or a picture (the small thumbnail where the piece is small).

import { useEffect, useState } from 'react';
import type { PlayItem } from '../media';

/** At most this many videos play at once in these modes. */
export const GRID_MAX_VIDEOS = 8;

/** The window is hidden (minimised or another app in front, on another desktop…). */
export function useHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}

/** Pause or play the playing videos inside `root` when `stopped` changes (or the pieces do). */
export function usePauseVideos(root: { current: HTMLElement | null }, stopped: boolean, deps: unknown) {
  useEffect(() => {
    root.current?.querySelectorAll<HTMLVideoElement>('video[data-play]').forEach((v) => (stopped ? v.pause() : v.play().catch(() => {})));
  }, [stopped, deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function aspectOf(i: PlayItem): number {
  if (i.width && i.height && i.width > 0 && i.height > 0) return i.width / i.height;
  return i.kind === 'video' ? 16 / 9 : 4 / 3;
}

export function GridMedia({ item, play, stopped, big }: { item: PlayItem; play: boolean; stopped: boolean; big: boolean }) {
  if (item.kind === 'video') {
    if (play)
      return (
        <video data-play src={item.src} muted loop autoPlay={!stopped} playsInline preload="auto"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (Number.isFinite(v.duration) && v.duration > 6) v.currentTime = Math.random() * (v.duration - 5);
          }} />
      );
    if (item.thumb) return <img src={item.thumb} alt="" draggable={false} />;
    // No thumbnail (files on this PC): the video's own first frame.
    return <video src={item.src} muted playsInline preload="metadata" />;
  }
  if (item.kind === 'image' && !big && item.thumb) return <img src={item.thumb} alt="" draggable={false} />;
  if (item.kind === 'image' || item.kind === 'gif') return <img src={item.src} alt="" draggable={false} />;
  return item.thumb ? <img src={item.thumb} alt="" draggable={false} /> : <span className="grid-name">{item.name}</span>;
}
