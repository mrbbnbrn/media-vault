import { describe, expect, it } from 'vitest';
import { groupLabel, peopleInText, photos, ticks } from './peoplelogic';

const folders = [
  { id: 1, name: 'Baran', person: true },
  { id: 2, name: 'Ayşe', person: true },
  { id: 3, name: 'İlknur', person: true },
  { id: 4, name: 'Holiday', person: false },
  { id: 5, name: 'Bora', person: true },
];

describe('people in the search box', () => {
  it('finds two or more people joined by + & , and ve', () => {
    expect(peopleInText('Baran + Ayşe', folders)).toEqual([1, 2]);
    expect(peopleInText('baran & AYŞE', folders)).toEqual([1, 2]);
    expect(peopleInText('Baran, Ayşe, ilknur', folders)).toEqual([1, 2, 3]);
    expect(peopleInText('Baran ve Ayşe', folders)).toEqual([1, 2]);
    expect(peopleInText('Baran and Ayşe', folders)).toEqual([1, 2]);
  });
  it('takes the start of a name when only one person matches', () => {
    expect(peopleInText('bar + ay', folders)).toEqual([1, 2]);
    expect(peopleInText('b + ay', folders)).toBeNull(); // Baran or Bora
  });
  it('ignores single names, ordinary folders and unknown words', () => {
    expect(peopleInText('Baran', folders)).toBeNull();
    expect(peopleInText('Baran + Holiday', folders)).toBeNull();
    expect(peopleInText('Baran + beach', folders)).toBeNull();
    expect(peopleInText('Baran + Baran', folders)).toBeNull();
  });
});

describe('ticks', () => {
  const list = [{ faceId: 1, sure: true }, { faceId: 2, sure: false }, { faceId: 3, sure: true }];
  it('starts from sure = ticked and lets clicks win', () => {
    expect(ticks(list, new Map())).toEqual({ ticked: [1, 3], unticked: [2] });
    expect(ticks(list, new Map([[1, false], [2, true]]))).toEqual({ ticked: [2, 3], unticked: [1] });
    expect(ticks(list, new Map(), true)).toEqual({ ticked: [1, 2, 3], unticked: [] });
  });
});

describe('labels', () => {
  it('reads well', () => {
    expect(groupLabel(0)).toBe('Person 1');
    expect(photos(1)).toBe('1 photo');
    expect(photos(312)).toBe('312 photos');
  });
});
