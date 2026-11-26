import { describe, expect, it } from 'vitest';
import { keptText, protectedText } from './folderkeep';

describe('deleting folders but keeping favourites and free copies', () => {
  it('says what the folders hold', () => {
    expect(protectedText({ favourites: 4, copies: 2, originals: 0, total: 6 }, 1)).toBe('This folder holds 4 favourites and 2 free copies.');
    expect(protectedText({ favourites: 1, copies: 0, originals: 0, total: 1 }, 1)).toBe('This folder holds 1 favourite.');
    expect(protectedText({ favourites: 0, copies: 1, originals: 2, total: 3 }, 3)).toBe('These folders hold 1 free copy and 2 originals with free copies.');
    expect(protectedText({ favourites: 2, copies: 3, originals: 1, total: 5 }, 1)).toBe('This folder holds 2 favourites, 3 free copies and 1 original with a free copy.');
  });
  it('says what Keep them did', () => {
    expect(keptText({ items: 12, folders: 0, kept: 3 })).toBe('Moved 12 items to the trash · kept 3 favourites and free copies');
    expect(keptText({ items: 1, folders: 2, kept: 1 })).toBe('Moved 1 item and 2 subfolders to the trash · kept 1 favourite or free copy');
  });
});
