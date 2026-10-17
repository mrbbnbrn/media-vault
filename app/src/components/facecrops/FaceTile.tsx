// One face cut out of its photo's thumbnail, for the face wall and Best
// faces: the thumbnail is simply drawn bigger and moved so the face fills
// the tile (CSS only; nothing is cropped or kept anywhere).

import { useState } from 'react';
import { thumbUrl, type PersonFace } from '../../api';
import { tileCrop } from '../../facecrops';

export function FaceTile(props: { face: PersonFace; size: number; round?: boolean; title?: string; onOpen: () => void; onContext?: (e: React.MouseEvent) => void; children?: React.ReactNode }) {
  const f = props.face;
  // The picture's shape: from the library, else from the thumbnail once it is here.
  const [shape, setShape] = useState<{ w: number; h: number } | null>(f.width > 0 && f.height > 0 ? { w: f.width, h: f.height } : null);
  const c = shape ? tileCrop(f, shape.w, shape.h, props.size) : null;
  return (
    <button type="button" className={`fc-tile${props.round ? ' round' : ''}`} style={{ width: props.size, height: props.size }}
      title={props.title} onClick={props.onOpen} onContextMenu={props.onContext ? (e) => { e.preventDefault(); props.onContext!(e); } : undefined} onAuxClick={(e) => e.button === 1 && e.preventDefault()}>
      <img src={thumbUrl(f.mediaId)} alt="" draggable={false} loading="lazy" decoding="async"
        style={c ? { width: c.w, height: c.h, left: c.left, top: c.top } : { width: '100%', height: '100%', objectFit: 'cover', left: 0, top: 0 }}
        onLoad={(e) => !shape && setShape({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {props.children}
    </button>
  );
}
