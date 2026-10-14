import { describe, expect, it } from 'vitest';
import { newNames, splitName, type RenameEntry } from './RenameDialog';

const e: RenameEntry[] = [
  { kind: 'folder', id: 1, name: 'Old trip' },
  { kind: 'item', id: 2, name: 'IMG_0001.JPG', ext: 'jpg' },
  { kind: 'item', id: 3, name: 'notes', ext: 'txt' },
];
const o = { base: 'Beach', start: 1, style: 'space' as const, find: '', repl: '', matchCase: false, before: '', after: '', each: [] as string[] };

describe('rename', () => {
  it('keeps the extension as it was', () => {
    expect(splitName(e[1])).toEqual(['IMG_0001', '.JPG']);
    expect(splitName(e[2])).toEqual(['notes', '']);
    expect(splitName(e[0])).toEqual(['Old trip', '']);
  });
  it('numbers', () => {
    expect(newNames(e, 'number', o)).toEqual(['Beach 01', 'Beach 02.JPG', 'Beach 03']);
    expect(newNames(e, 'number', { ...o, style: 'paren', start: 9 })).toEqual(['Beach (9)', 'Beach (10).JPG', 'Beach (11)']);
  });
  it('finds and replaces, ignoring case unless asked', () => {
    expect(newNames(e, 'replace', { ...o, find: 'img_', repl: 'Photo ' })[1]).toBe('Photo 0001.JPG');
    expect(newNames(e, 'replace', { ...o, find: 'img_', repl: 'x', matchCase: true })[1]).toBe('IMG_0001.JPG');
    expect(newNames(e, 'replace', { ...o, find: '.', repl: '-' })[1]).toBe('IMG_0001.JPG');
  });
  it('adds text before the extension', () => {
    expect(newNames(e, 'add', { ...o, before: '2024 ', after: ' (old)' })[1]).toBe('2024 IMG_0001 (old).JPG');
  });
});
