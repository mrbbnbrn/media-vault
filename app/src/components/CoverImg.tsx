// A thumbnail that loads again only when its own thumbnail changed (thumbver.ts),
// and a counter for the living folder card's cycle that only the hovered card
// listens to (the rest of the library doesn't redraw every 0.9 s).

import { useEffect, useState, type CSSProperties } from 'react';
import { thumbUrl } from '../api';
import { useThumbVersion, verTag } from '../thumbver';

export function CoverImg(props: { id: number; small?: boolean; className?: string; style?: CSSProperties }) {
  const v = useThumbVersion(props.id);
  return <img className={props.className} style={props.style} src={thumbUrl(props.id, verTag(v), props.small)} alt="" draggable={false} />;
}

/** 0 when not hovered; then 1, 2, 3… every `ms` while hovered. */
export function useHoverCycle(hovered: boolean, ms = 900): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (!hovered) return;
    const iv = setInterval(() => setN((c) => c + 1), ms);
    return () => clearInterval(iv);
  }, [hovered, ms]);
  return hovered ? n : 0;
}
