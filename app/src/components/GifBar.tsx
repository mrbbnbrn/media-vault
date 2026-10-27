// The GIF / animated WebP bar under the player: frame position and scrubbing,
// redrawn on its own as frames change (not the whole player).

import { useSyncExternalStore, type MutableRefObject } from 'react';
import { PositionBar } from './VideoTools';

/** The GIF's frame bar: draws again on each frame by itself (the rest of the viewer doesn't). */
export function GifBar(props: { at: MutableRefObject<number>; subs: Set<() => void>; count: number; onSeek: (i: number) => void; loop: { a: number | null; b: number | null } }) {
  const index = useSyncExternalStore(
    (cb) => {
      props.subs.add(cb);
      return () => props.subs.delete(cb);
    },
    () => props.at.current,
  );
  return <PositionBar at={index} dur={props.count - 1} onSeek={props.onSeek} bookmarks={[]} loop={props.loop} frames={{ index, count: props.count }} />;
}
