// "Doesn't fit in the graphics card's memory" under a 3D model in the model
// choosers (depth, subject outlines, background fill). The sizes are measured
// the first time each model runs on this PC (gpuroom.rs, kept between starts);
// a model that doesn't fit still works, only slower.

import { useEffect, useState } from 'react';
import { api, type ModelFit } from '../api';

let cache: ModelFit[] | null = null;

export function useModelFit(): ModelFit[] {
  const [fit, setFit] = useState<ModelFit[]>(cache ?? []);
  useEffect(() => {
    let alive = true;
    api.modelsFit().then((f) => {
      cache = f;
      if (alive) setFit(f);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return fit;
}

const gb = (mb: number) => (mb / 1024).toFixed(1);

/** The warning for one model, when it's the one in use and it doesn't fit. */
export function FitWarning({ fit, model, show }: { fit: ModelFit[]; model: string; show: boolean }) {
  const f = fit.find((x) => x.model === model);
  if (!show || !f || f.fits) return null;
  return (
    <span className="depth-model-problem">
      This doesn't fit in the graphics card's memory (it needs about {gb(f.needMb)} GB, the card has {gb(f.cardMb)} GB for the app), so it will be slower than expected.
    </span>
  );
}
