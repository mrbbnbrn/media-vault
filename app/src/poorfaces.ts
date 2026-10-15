// Poor faces: faces too small, too blurry or turned too far away to be
// trusted. The app decides which ones are poor (from Settings → Faces); this
// is only how the window shows them.

import { DEFAULT_POOR_FACES, type FaceBox, type PoorFace, type PoorFaceSettings } from './api';

/** Which kind of box a face gets in the viewer. "Not important" wins over
 *  poor, and a face you named is never poor. */
export type FaceKind = 'hidden' | 'poor' | 'known' | 'unknown';

export function faceKind(f: Pick<FaceBox, 'hidden' | 'poor' | 'person'>): FaceKind {
  if (f.hidden) return 'hidden';
  if (f.poor && f.person == null) return 'poor';
  return f.person != null ? 'known' : 'unknown';
}

/** The faces the viewer draws: poor ones only when "Show poor faces too" is on. */
export function visibleFaces<T extends Pick<FaceBox, 'hidden' | 'poor' | 'person'>>(faces: T[], showPoor: boolean): T[] {
  return showPoor ? faces : faces.filter((f) => faceKind(f) !== 'poor');
}

/** Why a face is poor, in a few words ("Too small · blurry"). */
export function poorReason(p: Pick<PoorFace, 'small' | 'blurry' | 'turned'>): string {
  const why = [p.small && 'too small', p.blurry && 'blurry', p.turned && 'turned away'].filter(Boolean) as string[];
  if (!why.length) return 'Poor face';
  const text = why.join(' · ');
  return text[0].toUpperCase() + text.slice(1);
}

/** Saved settings with anything missing or out of range put right (the app does the same). */
export function poorSettings(s: Partial<PoorFaceSettings> | null | undefined): PoorFaceSettings {
  const d = DEFAULT_POOR_FACES;
  const c = (x: unknown, lo: number, hi: number, def: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def);
  return { minPx: c(s?.minPx, 0, 400, d.minPx), blur: c(s?.blur, 0, 95, d.blur), turn: c(s?.turn, 15, 90, d.turn) };
}

/** Plain words for the blur slider (0–100 sharpness needed). */
export function blurWords(v: number): string {
  if (v <= 0) return 'off';
  if (v < 15) return 'only very blurry faces';
  if (v < 35) return 'quite blurry faces';
  if (v < 60) return 'soft faces too';
  return 'anything not crisp';
}
