// Small, testable pieces of the People page and people search.

import type { FolderCard, Suggestion } from './api';

/** Lower-case for matching names: Turkish İ/I/ı/i all match. */
export const foldName = (x: string) => x.toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/̇/g, '').trim();

/**
 * "Baran + Ayşe", "Baran & Ayşe", "Baran, Ayşe", "Baran and Ayşe" or
 * "Baran ve Ayşe": every part names a person folder → those people
 * (photos with all of them together). Null if any part isn't a person.
 */
export function peopleInText(text: string, folders: Pick<FolderCard, 'id' | 'name' | 'person'>[]): number[] | null {
  const parts = text.split(/\s*(?:\+|&|,|\band\b|\bve\b|\bund\b|\bet\b)\s*/i).map(foldName).filter(Boolean);
  if (parts.length < 2) return null;
  const people = folders.filter((f) => f.person);
  const ids: number[] = [];
  for (const p of parts) {
    const exact = people.filter((f) => foldName(f.name) === p);
    const start = exact.length ? exact : people.filter((f) => foldName(f.name).startsWith(p));
    if (start.length !== 1) return null;
    if (!ids.includes(start[0].id)) ids.push(start[0].id);
  }
  return ids.length >= 2 ? ids : null;
}

/** Ticked faces: your own clicks win over the default (sure = ticked). */
export function ticks(list: Pick<Suggestion, 'faceId' | 'sure'>[], choices: Map<number, boolean>, allOn = false): { ticked: number[]; unticked: number[] } {
  const ticked: number[] = [];
  const unticked: number[] = [];
  for (const s of list) (choices.get(s.faceId) ?? (allOn || s.sure) ? ticked : unticked).push(s.faceId);
  return { ticked, unticked };
}

/** "Person 3" for the third unknown group shown. */
export const groupLabel = (index: number) => `Person ${index + 1}`;

/** "1 photo", "312 photos". */
export const photos = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'photo' : 'photos'}`;
