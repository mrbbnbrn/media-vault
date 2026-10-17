// Person folders show a round cover centred on the face (folder cards, the
// sidebar, the compact sidebar and the People page).
//
// On folder cards the circle opens into the card's full square while it is
// hovered (`open`): the picture eases from the face close-up to the whole
// cover, and after a while (`cycle`) other pictures from the folder take
// turns in that square.
//
// A framing set by hand ("Adjust cover…", coverframe.ts) wins over the face
// close-up. A video or GIF cover plays (`play`) in the same spot as its still,
// using the shared video players, so nothing new is decoded.

import { useState } from 'react';
import { mediaUrl, thumbUrl, type FolderCard } from '../api';
import { coverFit } from '../facealign';
import { placement } from '../coverframe';
import { CoverVideo } from './VideoPreview';
import { useThumbVersion } from '../thumbver';

export function RoundCover(props: {
  folder: Pick<FolderCard, 'cover' | 'coverFace' | 'coverPos'> & { coverKind?: FolderCard['coverKind'] };
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
  /** Play a video or GIF cover (the library's Preview setting decides). */
  play?: boolean;
}) {
  const { cover, coverFace, coverPos, coverKind } = props.folder;
  const [aspect, setAspect] = useState<number | null>(null);
  // Loads again only when this cover's own thumbnail changed (thumbver.ts).
  const ver = useThumbVersion(cover);
  const bump = props.bump ?? (ver || undefined);
  if (cover == null) return null;
  const face = coverFace ? { x: coverFace[0], y: coverFace[1], w: coverFace[2], h: coverFace[3] } : null;
  const fit = !aspect ? null : coverPos ? placement(aspect, 1, coverPos) : coverFit(aspect, face, !props.open);
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  const at = fit ? { width: pct(fit.w), height: pct(fit.h), left: pct(fit.left), top: pct(fit.top) } : null;
  const playing = !!props.play && !!at && (coverKind === 'video' || coverKind === 'gif');
  return (
    <span className={`pround${props.open ? ' open' : ''}${props.className ? ` ${props.className}` : ''}`} aria-hidden="true"
      style={props.size ? { width: props.size, height: props.size } : undefined}>
      <img src={`${thumbUrl(cover)}${bump != null ? `?c=${bump}` : ''}`} alt="" draggable={false}
        style={at ?? { opacity: 0 }}
        onLoad={(e) => {
          const im = e.currentTarget;
          if (im.naturalWidth && im.naturalHeight) setAspect(im.naturalWidth / im.naturalHeight);
        }} />
      {/* The moving cover sits exactly over its still (same size and place). */}
      {playing && coverKind === 'gif' && <img className="pround-anim" src={mediaUrl(cover)} alt="" draggable={false} style={at!} />}
      {playing && coverKind === 'video' && <span className="pround-vid" style={at!}><CoverVideo id={cover} /></span>}
      {props.before != null && <img key={`b${props.before}`} className="pround-cycle still" src={thumbUrl(props.before)} alt="" draggable={false} />}
      {props.cycle != null && <img key={props.cycle} className="pround-cycle" src={thumbUrl(props.cycle)} alt="" draggable={false} />}
    </span>
  );
}
