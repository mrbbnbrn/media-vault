// The "Smallest face" slider each face tool has (wall, Best faces,
// time-lapse): faces smaller than this many pixels tall in the original
// picture are left out, with a live count. It moves freely while dragged and
// is remembered when let go.

import { useEffect, useRef, useState } from 'react';
import type { PersonFace } from '../../api';
import { bigEnough, countLabel, sliderMax } from '../../facecrops';

export function MinFaceSlider(props: { faces: PersonFace[]; value: number; onChange: (v: number) => void; onCommit: (v: number) => void }) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  const max = sliderMax(props.faces);
  const shown = bigEnough(props.faces, v).length;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const change = (x: number) => {
    setV(x);
    // Narrowing hundreds of faces on every pixel of a drag is wasteful: a short pause first.
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => props.onChange(x), 60);
  };
  const commit = () => props.onCommit(v);
  return (
    <label className="fc-set fc-min" title="Leave out faces smaller than this in the original picture">
      <span>Smallest face · {v} px <span className="faint">({countLabel(shown, props.faces.length)})</span></span>
      <input type="range" min={0} max={max} step={10} value={Math.min(v, max)}
        onChange={(e) => change(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
    </label>
  );
}

/** Videos are left out of the face tools (cutting faces from video frames is too slow here). */
export function PicturesOnly() {
  return <span className="chip fc-chip" title="Faces found in videos are left out here">pictures only</span>;
}
