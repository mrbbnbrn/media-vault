// Person folders show a round cover centred on the face (folder cards, the
// sidebar, the compact sidebar and the People page).
//
// On folder cards the circle opens into the card's full square while it is
// hovered (`open`): the picture eases from the face close-up to the whole
// cover, and after a while (`cycle`) other pictures from the folder take
// turns in that square.

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
  /** Opened into a square (hovered folder card): the whole picture, shifted towards the face. */
  open?: boolean;
  /** Another picture from the folder to show over the cover (the living card cycle). */
  cycle?: number | null;
  /** The picture shown before `cycle` (kept underneath while it fades in). */
  before?: number | null;
}) {
  const { cover, coverFace } = props.folder;
  const [aspect, setAspect] = useState<number | null>(null);
  if (cover == null) return null;
  const face = coverFace ? { x: coverFace[0], y: coverFace[1], w: coverFace[2], h: coverFace[3] } : null;
  const fit = aspect ? coverFit(aspect, face, !props.open) : null;
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  return (
    <span className={`pround${props.open ? ' open' : ''}${props.className ? ` ${props.className}` : ''}`} aria-hidden="true"
      style={props.size ? { width: props.size, height: props.size } : undefined}>
      <img src={`${thumbUrl(cover)}${props.bump != null ? `?c=${props.bump}` : ''}`} alt="" draggable={false}
        style={fit ? { width: pct(fit.w), height: pct(fit.h), left: pct(fit.left), top: pct(fit.top) } : { opacity: 0 }}
        onLoad={(e) => {
          const im = e.currentTarget;
          if (im.naturalWidth && im.naturalHeight) setAspect(im.naturalWidth / im.naturalHeight);
        }} />
      {props.before != null && <img key={`b${props.before}`} className="pround-cycle still" src={thumbUrl(props.before)} alt="" draggable={false} />}
      {props.cycle != null && <img key={props.cycle} className="pround-cycle" src={thumbUrl(props.cycle)} alt="" draggable={false} />}
    </span>
  );
}
