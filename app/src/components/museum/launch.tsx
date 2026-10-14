// Opening the museum from the library, and the viewer over it.
// Kept free of three.js: the museum itself is loaded only when opened.
//
// A picture opened from the museum shows in the viewer right here, on top of
// the museum, which stays loaded and holds still underneath: closing the
// viewer is instant and you stand exactly where you were.

import { lazy, Suspense, useMemo, useSyncExternalStore } from 'react';
import { api, mediaUrl, onLocked, thumbUrl, type FolderCard, type Item } from '../../api';
import { fromItem } from '../../media';
import type { Nav } from '../../App';
import type { LibView } from '../../screens/Library';
import { Viewer } from '../../screens/Viewer';
import type { MuseumItem } from './layout';

const Museum = lazy(() => import('./Museum'));

interface Session {
  title: string;
  items: Item[];
  /** The same items as the museum sees them (made once, so the halls aren't rebuilt). */
  pieces: MuseumItem[];
  /** The viewer open over the museum, on this item. */
  viewing: number | null;
  /** The item the viewer ended on, to look at closely when it closes. */
  returnTo: { id: number; n: number } | null;
}

let session: Session | null = null;
const listeners = new Set<() => void>();
const set = (s: Session | null) => {
  session = s;
  listeners.forEach((l) => l());
};
let lockHooked = false;

/** True while a museum is open (the library underneath leaves the keyboard alone). */
export const museumOpen = () => session !== null;

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
  set({ title, items: list, pieces: list.map(toMuseum), viewing: null, returnTo: null });
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
export function MuseumHost({ nav }: { nav: Nav; view?: LibView }) {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => session,
  );
  const items = s?.items;
  const play = useMemo(() => (items ? items.map(fromItem) : []), [items]);

  if (!s) return null;
  return (
    <Suspense fallback={<div style={{ position: 'fixed', inset: 0, zIndex: 45, background: '#0b0705' }} />}>
      <Museum
        title={s.title}
        items={s.pieces}
        sources={sources}
        covered={s.viewing != null}
        returnTo={s.returnTo}
        onClose={() => set(null)}
        onOpenItem={(id) => {
          if (session) set({ ...session, viewing: id });
        }}
      />
      {s.viewing != null && (
        <div className="museum-viewer">
          <Viewer nav={nav} items={play} startKey={`v${s.viewing}`} title={s.title} auto={false}
            onBack={(last) => {
              if (session) set({ ...session, viewing: null, returnTo: last?.itemId != null ? { id: last.itemId, n: Date.now() } : session.returnTo });
            }} />
        </div>
      )}
    </Suspense>
  );
}
