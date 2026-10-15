// Opening the discovery river from the library, and the viewer over it.
// A picture opened from the river shows in the viewer right here, on top of
// the river, which holds still underneath: closing the viewer carries on
// exactly where it was.

import { lazy, Suspense, useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, mediaUrl, onLocked, previewUrl, thumbUrl, tinyUrl, type FolderCard, type Item } from '../../api';
import { setPreviewCover } from '../../previewgate';
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
  /** Faces river: the photos the viewer steps through (else `items`). */
  viewList: Item[] | null;
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
  tiny: !!i.tiny, durationMs: i.durationMs,
});

// Faces river: the photos behind the faces, looked up once per river (every item, as the vault river does).
let allItems: Promise<Map<number, Item>> | null = null;
async function photosOf(media: number[]): Promise<Item[]> {
  allItems ??= api.queryItems({}).then((l) => new Map(l.map((i) => [i.id, i])));
  try {
    const all = await allItems;
    return media.map((id) => all.get(id)).filter((i): i is Item => !!i && i.deletedAt == null);
  } catch (e) {
    allItems = null;
    throw e;
  }
}

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
  allItems = null;
  set({ title, kicker, items: list, drifting: list.map(toRiver), viewing: null, viewList: null });
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

const sources = { thumb: thumbUrl, full: mediaUrl, preview: previewUrl, tiny: tinyUrl };

/** Rendered once by the library; shows the river while one is open. */
export function RiverHost({ nav }: { nav: Nav }) {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => session,
  );
  const items = s?.viewList ?? s?.items;
  const play = useMemo(() => (items ? items.map(fromItem) : []), [items]);
  // The library's grid previews rest while the river covers them (the river plays its own).
  const open = !!s;
  useEffect(() => {
    setPreviewCover('river', open);
    return () => setPreviewCover('river', false);
  }, [open]);

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
          if (session) set({ ...session, viewing: session.items[index]?.id ?? null, viewList: null });
        }}
        onOpenPhoto={(media, all) => {
          photosOf(all).then((list) => {
            if (session && list.some((i) => i.id === media)) set({ ...session, viewing: media, viewList: list });
          }).catch(() => {});
        }}
        onMiniPhoto={nav.mini ? (media, all) => {
          photosOf(all).then((list) => {
            if (session && list.some((i) => i.id === media)) nav.mini?.({ items: list.map(fromItem), startKey: `v${media}`, title: s.title, auto: false });
          }).catch(() => {});
        } : undefined}
        onMini={nav.mini ? (index) => {
          const id = session?.items[index]?.id;
          if (id != null) nav.mini?.({ items: play, startKey: `v${id}`, title: s.title, auto: false });
        } : undefined}
      />
      {s.viewing != null && (
        <div className="river-viewer">
          <Viewer nav={nav} items={play} startKey={`v${s.viewing}`} title={s.title} auto={false}
            onBack={() => {
              if (session) set({ ...session, viewing: null, viewList: null });
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
