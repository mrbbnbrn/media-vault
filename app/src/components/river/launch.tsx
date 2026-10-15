// Opening the discovery river from the library, and the viewer over it.
// A picture opened from the river shows in the viewer right here, on top of
// the river, which holds still underneath: closing the viewer carries on
// exactly where it was.

import { lazy, Suspense, useMemo, useSyncExternalStore } from 'react';
import { api, mediaUrl, onLocked, previewUrl, thumbUrl, type FolderCard, type Item } from '../../api';
import { fromItem } from '../../media';
import type { Nav } from '../../App';
import { Viewer } from '../../screens/Viewer';
import type { RiverItem } from './engine';

const River = lazy(() => import('./River'));

interface Session {
  title: string;
  kicker: string;
  items: Item[];
  /** The same items as the river sees them (made once). */
  drifting: RiverItem[];
  /** The viewer is open over the river, on this item. */
  viewing: number | null;
}

let session: Session | null = null;
const listeners = new Set<() => void>();
const set = (s: Session | null) => {
  session = s;
  listeners.forEach((l) => l());
};
let lockHooked = false;

/** True while the river is open (the library underneath leaves the keyboard alone). */
export const riverOpen = () => session !== null;

const visual = (i: Item) => (i.kind === 'image' || i.kind === 'gif' || i.kind === 'video') && i.deletedAt == null;
/** Videos need a thumbnail to show; pictures can use themselves. */
const drawable = (i: Item) => visual(i) && (i.kind !== 'video' || i.thumb === 'ok');

const toRiver = (i: Item): RiverItem => ({
  id: i.id, kind: i.kind as RiverItem['kind'], name: i.name, aspect: i.width && i.height ? i.width / i.height : null, preview: i.preview, thumb: i.thumb === 'ok',
});

/** Opens the river with these items (pictures, GIFs and videos only). */
export function openRiver(title: string, kicker: string, items: Item[], note?: (text: string) => void) {
  const list = items.filter(drawable);
  if (!list.length) {
    note?.('There are no pictures or videos for the river here yet.');
    return;
  }
  if (!lockHooked) {
    lockHooked = true;
    // Locking the vault closes the river.
    onLocked(() => set(null)).catch(() => {});
  }
  set({ title, kicker, items: list, drifting: list.map(toRiver), viewing: null });
}

/** Everything in the vault. */
export async function openVaultRiver(note?: (text: string) => void) {
  try {
    openRiver('The whole vault', 'Discovery river', await api.queryItems({}), note);
  } catch (e) {
    note?.(e instanceof Error ? e.message : String(e));
  }
}

/** A folder's river (everything inside it; a person: everyone tagged too). */
export async function openFolderRiver(f: FolderCard, note?: (text: string) => void) {
  try {
    const items = f.person ? await api.queryItems({ people: [f.id] }) : await api.queryItems({ folder: f.id, recursive: true });
    openRiver(f.name, 'Discovery river', items, note);
  } catch (e) {
    note?.(e instanceof Error ? e.message : String(e));
  }
}

const sources = { thumb: thumbUrl, full: mediaUrl, preview: previewUrl };

/** Rendered once by the library; shows the river while one is open. */
export function RiverHost({ nav }: { nav: Nav }) {
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
    <Suspense fallback={<div className="river-wait" style={{ position: 'fixed', inset: 0, zIndex: 45, background: '#04080a' }} />}>
      <River
        title={s.title}
        kicker={s.kicker}
        items={s.drifting}
        sources={sources}
        covered={s.viewing != null}
        onClose={() => set(null)}
        onOpen={(index) => {
          if (session) set({ ...session, viewing: session.items[index]?.id ?? null });
        }}
        onMini={nav.mini ? (index) => {
          const id = session?.items[index]?.id;
          if (id != null) nav.mini?.({ items: play, startKey: `v${id}`, title: s.title, auto: false });
        } : undefined}
      />
      {s.viewing != null && (
        <div className="river-viewer">
          <Viewer nav={nav} items={play} startKey={`v${s.viewing}`} title={s.title} auto={false}
            onBack={() => {
              if (session) set({ ...session, viewing: null });
            }} />
        </div>
      )}
    </Suspense>
  );
}

/** Three gentle waves (the sidebar's "Discovery river"). */
export const RiverIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0" />
    <path d="M3 12c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0" />
    <path d="M3 17c2-1.6 4-1.6 6 0s4 1.6 6 0 4-1.6 6 0" />
  </svg>
);
