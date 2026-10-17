// The library's item menu, for places outside it (the viewer's right-click menu):
// the same actions, worked out by the library (Library.tsx mediaActions), so a
// picture can be tagged, moved or shared the same way wherever it shows.

import type { MenuItem } from './components/Dialogs';

type Provider = (id: number, leaveOut: string[]) => Promise<MenuItem[]>;
let provider: Provider | null = null;

/** Set by the library while it is open (null when it closes). */
export function setItemMenuProvider(p: Provider | null) {
  provider = p;
}

/** The library's actions for this item, minus the ones named in `leaveOut` (action ids). */
export function libraryItemMenu(id: number, leaveOut: string[] = []): Promise<MenuItem[]> {
  return provider ? provider(id, leaveOut).catch(() => []) : Promise.resolve([]);
}

type Trasher = (id: number) => Promise<boolean>;
let trasher: Trasher | null = null;

/** Set by the library: move one item to the trash (true when it went; false when it asked first or failed). */
export function setItemTrasher(t: Trasher | null) {
  trasher = t;
}

/** The viewer's Delete key: the library does it, the same way as its own Delete (undoable). */
export function trashFromViewer(id: number): Promise<boolean> {
  return trasher ? trasher(id).catch(() => false) : Promise.resolve(false);
}
