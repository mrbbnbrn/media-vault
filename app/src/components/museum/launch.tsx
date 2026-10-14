// Opening the museum from the library, and coming back to it from the viewer.
// Kept free of three.js: the museum itself is loaded only when opened.

import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react';
import { api, mediaUrl, onLocked, thumbUrl, type FolderCard, type Item } from '../../api';
import { fromItem } from '../../media';
import type { Nav } from '../../App';
import type { LibView } from '../../screens/Library';
import type { MuseumItem } from './layout';
import type { Pose } from './engine';

const Museum = lazy(() => import('./Museum'));

interface Session {
  title: string;
  items: Item[];
  /** The same items as the museum sees them (made once, so the halls aren't rebuilt). */
  pieces: MuseumItem[];
  /** Set while the viewer is open on one of the museum's pictures. */
  away: { view: string; wing: number; pose: Pose } | null;
  resume: { wing: number; pose: Pose } | null;
}

let session: Session | null = null;
const listeners = new Set<() => void>();
const set = (s: Session | null) => {
  session = s;
  listeners.forEach((l) => l());
};
let lockHooked = false;

const visual = (i: Item) => i.kind === 'image' || i.kind === 'gif' || i.kind === 'video';

const toMuseum = (i: Item): MuseumItem => ({
  id: i.id, name: i.name, kind: i.kind as MuseumItem['kind'], width: i.width, height: i.height, favourite: i.favourite, weight: i.weight, takenAt: i.takenAt,
});

/** Opens a museum of these items (pictures, GIFs and videos only). */
export function openMuseum(title: string, items: Item[], note?: (text: string) => void) {
  const list = items.filter(visual);
  if (!list.length) {
    note?.('There are no pictures or videos to hang here.');
    return;
  }
  if (!lockHooked) {
    lockHooked = true;
    // Locking the vault closes the museum.
    onLocked(() => set(null)).catch(() => {});
  }
  set({ title, items: list, pieces: list.map(toMuseum), away: null, resume: null });
}

/** A folder's museum (everything inside it; a person: everyone tagged too). */
export async function openFolderMuseum(f: FolderCard, note?: (text: string) => void) {
  try {
    const items = f.person ? await api.queryItems({ people: [f.id] }) : await api.queryItems({ folder: f.id, recursive: true });
    openMuseum(f.name, items, note);
  } catch (e) {
    note?.(e instanceof Error ? e.message : String(e));
  }
}

const sources = { thumb: thumbUrl, full: mediaUrl };

/** Rendered once by the library; shows the museum while one is open. */
export function MuseumHost({ nav, view }: { nav: Nav; view: LibView }) {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => session,
  );
  // Back from the viewer: walk on from where you stood (only to the same place in the library).
  useEffect(() => {
    if (!session?.away) return;
    const a = session.away;
    if (a.view === JSON.stringify(view)) set({ ...session, away: null, resume: { wing: a.wing, pose: a.pose } });
    else set(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s || s.away) return null;
  return (
    <Suspense fallback={<div style={{ position: 'fixed', inset: 0, zIndex: 45, background: '#0b0705' }} />}>
      <Museum
        title={s.title}
        items={s.pieces}
        sources={sources}
        resume={s.resume}
        onClose={() => set(null)}
        onOpenItem={(id, at) => {
          set({ ...s, away: { view: JSON.stringify(view), ...at } });
          nav.go({ name: 'viewer', items: s.items.map(fromItem), startKey: `v${id}`, title: s.title, auto: false, back: view });
        }}
      />
    </Suspense>
  );
}
