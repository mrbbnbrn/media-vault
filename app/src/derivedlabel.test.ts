import { describe, expect, it } from 'vitest';
import { mapLabel } from './derived';
import { folderFilters } from './prepare';

describe('saved map labels', () => {
  const names = new Map([['da3-mono-large', 'Best'], ['birefnet-lite', 'Fast']]);
  it('names the model and what it was made with', () => {
    expect(mapLabel('depth', 'da3-mono-large@518~0.5', names)).toEqual({ name: 'Best', detail: 'standard detail · sharper edges (×0.5)' });
    expect(mapLabel('depth', 'v2-small@756~1', names)).toEqual({ name: 'v2-small', detail: 'high detail (756 px) · edges as designed' });
    expect(mapLabel('depth', 'v2-small@518~1.5', names).detail).toBe('standard detail · softer edges (×1.5)');
    expect(mapLabel('outline', 'birefnet-lite@1024', names)).toEqual({ name: 'Fast', detail: '' });
    expect(mapLabel('outline', 'birefnet@512', names)).toEqual({ name: 'birefnet', detail: '512 px' });
    expect(mapLabel('depth', 'odd', names)).toEqual({ name: 'odd', detail: '' });
  });
  it('person folders take their pictures elsewhere only when asked', () => {
    const fs = [{ id: 1, person: true }, { id: 2, person: false }];
    expect(folderFilters(fs, false)).toEqual([{ folder: 1, recursive: true, kinds: ['image'] }, { folder: 2, recursive: true, kinds: ['image'] }]);
    expect(folderFilters(fs, true).at(-1)).toEqual({ people: [1], kinds: ['image'] });
  });
});
