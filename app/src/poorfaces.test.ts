import { describe, expect, it } from 'vitest';
import { blurWords, faceKind, poorReason, poorSettings, visibleFaces } from './poorfaces';

describe('poor faces', () => {
  const unknown = { id: 1, person: null, poor: false };
  const poor = { id: 2, person: null, poor: true };
  const named = { id: 3, person: 7, poor: true }; // named by you: never treated as poor
  const hidden = { id: 4, person: null, poor: true, hidden: true };

  it('gives each face its kind of box', () => {
    expect(faceKind(unknown)).toBe('unknown');
    expect(faceKind(poor)).toBe('poor');
    expect(faceKind(named)).toBe('known');
    expect(faceKind(hidden)).toBe('hidden');
  });

  it('shows poor faces only when asked', () => {
    const all = [unknown, poor, named, hidden];
    expect(visibleFaces(all, false).map((f) => f.id)).toEqual([1, 3, 4]);
    expect(visibleFaces(all, true).map((f) => f.id)).toEqual([1, 2, 3, 4]);
  });

  it('says why in plain words', () => {
    expect(poorReason({ small: true, blurry: false, turned: false })).toBe('Too small');
    expect(poorReason({ small: true, blurry: true, turned: true })).toBe('Too small · blurry · turned away');
    expect(poorReason({ small: false, blurry: false, turned: true })).toBe('Turned away');
    expect(poorReason({ small: false, blurry: false, turned: false })).toBe('Poor face');
  });

  it('puts settings right like the app does', () => {
    expect(poorSettings(undefined)).toEqual({ minPx: 40, blur: 25, turn: 60 });
    expect(poorSettings({ minPx: -5, blur: 200, turn: 3 })).toEqual({ minPx: 0, blur: 95, turn: 15 });
    expect(poorSettings({ minPx: Number.NaN, blur: 10 })).toEqual({ minPx: 40, blur: 10, turn: 60 });
    expect(blurWords(0)).toBe('off');
    expect(blurWords(25)).toBe('quite blurry faces');
  });
});
