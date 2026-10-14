// Ctrl+C / Ctrl+V between the library and Windows.
//
// Ctrl+C in the library  -> copyOut(ids, folders): Explorer can paste them.
//   Nothing is decrypted until Explorer pastes; then Windows asks
//   "Copy N files out of the vault?" (Yes/No) once for that copy.
// Ctrl+V in the library  -> readPaste(): files copied in Explorer (import
//   them like files dropped on the window) or a copied picture (save it with
//   savePastedPicture).

import { winshell } from './api';

/** Put items/folders on the clipboard. Returns a short message for a toast. */
export async function copyOut(ids: number[], folders: number[]): Promise<string> {
  const n = await winshell.clipboardPutFiles(ids, folders);
  return `${n === 1 ? '1 file' : `${n} files`} ready to paste in a folder or on the desktop.`;
}

export interface Paste {
  files: string[];
  picture: Uint8Array | null;
  /** The clipboard holds items copied in this app (not files or a picture). */
  ours: boolean;
}

export async function readPaste(): Promise<Paste> {
  const c = await winshell.clipboardRead();
  return {
    files: c?.files ?? [],
    picture: c?.imagePng ? new Uint8Array(c.imagePng) : null,
    ours: c?.ours ?? false,
  };
}

/** "Pasted picture 2026-10-14 13.05.22.png" */
export function pastedPictureName(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Pasted picture ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.png`;
}

/** Save a pasted picture into a folder (null = top level); returns the new item id. */
export function savePastedPicture(folder: number | null, picture: Uint8Array): Promise<number> {
  return winshell.importImageBytes(folder, pastedPictureName(), picture);
}
