// What the vault does with each kind of item. Pictures, GIFs, videos, text
// and PDFs are shown (viewer, slideshows, walls, 3D, faces…). Music (`audio`)
// and every other file (`file`) are only kept: music plays in its own little
// player, other files are never opened (an info panel and Export instead).

import type { Kind } from './apitypes';

/** Kept, not shown: music and other files. Slideshows, walls, 3D, faces and the like leave these out. */
export function storedOnly(kind: Kind | string | null | undefined): boolean {
  return kind === 'audio' || kind === 'file';
}

/** Only what can be shown (music and other files left out). */
export function onlyShown<T extends { kind: Kind | string }>(list: T[]): T[] {
  return list.some((i) => storedOnly(i.kind)) ? list.filter((i) => !storedOnly(i.kind)) : list;
}

/**
 * What the viewer gets from a list, by the item it starts at. A song: the
 * list's songs (← → and the player's ⏮ ⏭ go to the next song). Anything
 * else: what can be shown. A slideshow never has music or other files.
 * Other files never open in the viewer at all (see `opensAsInfo`).
 */
export function viewerList<T extends { kind: Kind | string }>(list: T[], startKind: Kind | string | null | undefined, auto: boolean): T[] {
  if (!auto && startKind === 'audio') return list.filter((i) => i.kind === 'audio');
  return onlyShown(list);
}

/** Opening this item shows its info panel (with Export) instead of the viewer. */
export function opensAsInfo(kind: Kind | string | null | undefined): boolean {
  return kind === 'file';
}

/** The big type label on a file's tile: its extension ("ZIP", "DOCX"), at most 5 letters; "FILE" without one. */
export function typeLabel(ext: string | null | undefined): string {
  const e = (ext ?? '').trim().replace(/^\.+/, '').toUpperCase();
  if (!e) return 'FILE';
  return e.length > 5 ? `${e.slice(0, 4)}…` : e;
}

/** A file name's extension, lower case ("" when it has none). */
export function extOfName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
}

/** What a kind is called in the window ("Picture", "Music", "File"…). */
export function kindName(kind: Kind | string): string {
  const names: Record<string, string> = { image: 'Picture', gif: 'GIF', video: 'Video', text: 'Text', pdf: 'PDF', audio: 'Music', file: 'File' };
  return names[kind] ?? kind;
}

/** The type line of an item: "DOCX file", "MP3 music", "PDF"… */
export function typeLine(kind: Kind | string, ext: string | null | undefined): string {
  const e = (ext ?? '').trim().toUpperCase();
  if (kind === 'file') return e ? `${e} file` : 'File without a type';
  if (kind === 'audio') return e ? `${e} music` : 'Music';
  return [kindName(kind), e && e !== kindName(kind).toUpperCase() ? e : ''].filter(Boolean).join(' · ');
}

/** The import picker's file types: any file (the first, so it is what the picker starts with), or only what opens here. */
export const IMPORT_FILTERS = [
  { name: 'All files', extensions: ['*'] },
  {
    name: 'Pictures, videos, music, documents and .7z archives',
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'm4v', 'webm', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'weba',
      'pdf', 'txt', 'md', 'log', 'csv', 'json', 'xml', 'srt', '7z', '001'],
  },
];

/** The phone's hidden vault takes only these (what "Send to phone" leaves out is said, not sent). */
export const PHONE_KINDS: readonly string[] = ['image', 'gif', 'video'];

/** What the window says when a send to the phone left items out (the backend says the same). */
export function phoneSkippedText(n: number): string {
  return `${n === 1 ? '1 file was' : `${n} files were`} skipped: the phone's vault takes only pictures, GIFs and videos.`;
}

/** The hint shown while no phone is connected. */
export const PHONE_HINT = 'Unlock the hidden vault in Baro Alarm on your phone (older Baro Alarm: open Aktarım)';

/** Music volume in the viewer's music player (0–1), remembered in this window only. */
const VOLUME_KEY = 'mv-audio-volume';
export function savedVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) != null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  } catch {
    return 0.8;
  }
}
export function saveVolume(v: number) {
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.min(1, Math.max(0, v))));
  } catch {
    /* not remembered: fine */
  }
}
