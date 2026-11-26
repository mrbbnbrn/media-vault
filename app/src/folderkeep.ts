// Deleting folders that hold favourites or free copies: the question's text
// (components/FolderKeepDialog.tsx; the backend's foldertrash.rs does the work).

import type { FoldersProtected } from './apitypes';
import { plural } from './undo';

const list = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** "This folder holds 4 favourites and 2 free copies." (several folders: "These folders hold …"). */
export function protectedText(p: FoldersProtected, folders: number): string {
  const parts = [
    p.favourites ? plural(p.favourites, 'favourite') : '',
    p.copies ? plural(p.copies, 'free copy', 'free copies') : '',
    p.originals ? plural(p.originals, 'original with a free copy', 'originals with free copies') : '',
  ].filter(Boolean);
  return `${folders === 1 ? 'This folder holds' : 'These folders hold'} ${list(parts)}.`;
}

/** What "Keep them" did, for the note (and the undo list). */
export function keptText(r: { items: number; folders: number; kept: number }): string {
  const went = [plural(r.items, 'item'), r.folders ? plural(r.folders, 'subfolder') : ''].filter(Boolean);
  return `Moved ${list(went)} to the trash · kept ${plural(r.kept, 'favourite or free copy', 'favourites and free copies')}`;
}
