// Person folders show a round cover centred on the face (folder cards, the
// sidebar, the compact sidebar and the People page).

import { useState } from 'react';
import { thumbUrl, type FolderCard } from '../api';
import { coverFit } from '../facealign';

export function RoundCover(props: {
  folder: Pick<FolderCard, 'cover' | 'coverFace'>;
  /** Pixel size; leave out to fill the parent (a square). */
  size?: number;
  /** Changes when covers change (cache buster). */
  bump?: number;
  className?: string;
}) {
  const { cover, coverFace } = props.folder;
  const [aspect, setAspect] = useState<number | null>(null);
  if (cover == null) return null;
  const face = coverFace ? { x: coverFace[0], y: coverFace[1], w: coverFace[2], h: coverFace[3] } : null;
  const fit = aspect ? coverFit(aspect, face) : null;
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  return (
    <span className={`pround${props.className ? ` ${props.className}` : ''}`} aria-hidden="true"
      style={props.size ? { width: props.size, height: props.size } : undefined}>
      <img src={`${thumbUrl(cover)}${props.bump != null ? `?c=${props.bump}` : ''}`} alt="" draggable={false}
        style={fit ? { width: pct(fit.w), height: pct(fit.h), left: pct(fit.left), top: pct(fit.top) } : { opacity: 0 }}
        onLoad={(e) => {
          const im = e.currentTarget;
          if (im.naturalWidth && im.naturalHeight) setAspect(im.naturalWidth / im.naturalHeight);
        }} />
    </span>
  );
}
