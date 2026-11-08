// Originals received from the phone in formats the window can't show (HEIC,
// HEIF, AVIF, BMP, TIFF pictures; MOV, MKV, 3GP, AVI, TS … videos). They are
// kept untouched as their own items, and a playable copy (JPEG / MP4) is made
// next to them (transfer/playable.rs, the same lists). Tiles draw a calm
// placeholder for them; the viewer offers to open the copy.

const PICTURE_EXT = ['heic', 'heif', 'hif', 'avif', 'bmp', 'tif', 'tiff'];
const VIDEO_EXT = ['mov', 'mkv', '3gp', '3g2', 'avi', 'ts', 'mts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg'];

/** An item the window can't show itself: an original from the phone (its copy is shown instead). */
export function isPhoneOriginal(it: { kind: string; ext?: string | null; name?: string }): boolean {
  const ext = (it.ext || extOf(it.name ?? '')).toLowerCase();
  if (it.kind === 'image') return PICTURE_EXT.includes(ext);
  if (it.kind === 'video') return VIDEO_EXT.includes(ext);
  return false;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

/** The file type as a short badge ("HEIC", "MOV"). */
export function typeBadge(it: { ext?: string | null; name?: string }): string {
  return (it.ext || extOf(it.name ?? '')).toUpperCase().slice(0, 5);
}

/** The name the playable copy gets ("IMG_0001.HEIC" → "IMG_0001.jpg"). */
export function copyName(it: { kind: string; name: string }): string {
  const stem = it.name.includes('.') ? it.name.slice(0, it.name.lastIndexOf('.')) : it.name;
  return `${stem.trim() ? stem : 'Converted'}.${it.kind === 'video' ? 'mp4' : 'jpg'}`;
}
