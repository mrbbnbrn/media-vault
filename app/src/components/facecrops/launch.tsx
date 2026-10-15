// Opening a person's Best faces and face time-lapse from anywhere in the
// library (the person page, person searches, the folder menu), and the
// viewer over them when a face's photo is opened: closing the viewer comes
// straight back to where you were. Kept small: the tools themselves load
// only when opened.

import { lazy, Suspense, useSyncExternalStore } from 'react';
import { api, onLocked, type Item } from '../../api';
import { fromItem } from '../../media';
import type { Nav } from '../../App';
import { Viewer } from '../../screens/Viewer';
import { forgetMeasures } from './render';
import './facecrops.css';

const FaceTimelapse = lazy(() => import('./FaceTimelapse'));
const BestFaces = lazy(() => import('./BestFaces'));

export type FaceTool = 'timelapse' | 'best';

interface Open {
  tool: FaceTool;
  person: number;
  name: string;
  /** A photo opened from the tool, shown in the viewer over it. */
  viewing: { id: number; items: Item[] } | null;
}

let open: Open | null = null;
const listeners = new Set<() => void>();
const set = (o: Open | null) => {
  open = o;
  listeners.forEach((l) => l());
};
let lockHooked = false;

/** True while a face tool is open (the library underneath leaves the keyboard alone). */
export const faceToolOpen = () => open !== null;

/** Open Best faces or the face time-lapse for a person (their person folder id). */
export function openFaceTool(tool: FaceTool, person: number, name: string) {
  if (!lockHooked) {
    lockHooked = true;
    // Locking the vault closes the tool and forgets every measurement.
    onLocked(() => {
      set(null);
      forgetMeasures();
    }).catch(() => {});
  }
  set({ tool, person, name, viewing: null });
}

/** Open a photo of the person over the tool (every photo they are in, so ← → keep going). */
async function openPhoto(id: number) {
  if (!open) return;
  const o = open;
  let items: Item[] = [];
  try {
    items = await api.queryItems({ people: [o.person] });
  } catch {
    items = [];
  }
  if (!items.some((i) => i.id === id)) {
    const one = await api.getItem(id).catch(() => null);
    if (one) items = [one];
  }
  if (open === o && items.length) set({ ...o, viewing: { id, items } });
}

/** Rendered once by the library; shows the open tool (and the viewer over it). */
export function FaceToolsHost(props: { nav: Nav; onChanged: () => void }) {
  const o = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
  if (!o) return null;
  const close = () => set(null);
  const covered = o.viewing != null;
  return (
    <Suspense fallback={<div className="fc-backdrop" />}>
      {o.tool === 'timelapse' ? (
        <FaceTimelapse person={o.person} name={o.name} covered={covered} onClose={close} onOpenPhoto={openPhoto} onSaved={props.onChanged} />
      ) : (
        <BestFaces person={o.person} name={o.name} covered={covered} onClose={close} onOpenPhoto={openPhoto} onChanged={props.onChanged} />
      )}
      {o.viewing && (
        <div className="fc-viewer">
          <Viewer nav={props.nav} items={o.viewing.items.map(fromItem)} startKey={`v${o.viewing.id}`} title={o.name} auto={false} person={o.person}
            onBack={() => {
              if (open) set({ ...open, viewing: null });
            }} />
        </div>
      )}
    </Suspense>
  );
}
