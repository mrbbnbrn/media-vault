import { describe, expect, it } from 'vitest';
import { extOfName, IMPORT_FILTERS, onlyShown, opensAsInfo, phoneSkippedText, storedOnly, typeLabel, typeLine, viewerList } from './kinds';

const list = [
  { id: 1, kind: 'image' },
  { id: 2, kind: 'audio' },
  { id: 3, kind: 'file' },
  { id: 4, kind: 'video' },
  { id: 5, kind: 'audio' },
  { id: 6, kind: 'pdf' },
];
const ids = (l: { id: number }[]) => l.map((i) => i.id);

describe('kinds', () => {
  it('music and other files are only kept', () => {
    expect(storedOnly('audio')).toBe(true);
    expect(storedOnly('file')).toBe(true);
    for (const k of ['image', 'gif', 'video', 'text', 'pdf', undefined, null]) expect(storedOnly(k)).toBe(false);
    expect(ids(onlyShown(list))).toEqual([1, 4, 6]);
    const plain = [{ id: 1, kind: 'image' }];
    expect(onlyShown(plain)).toBe(plain); // nothing to leave out: the same list
  });

  it('the viewer gets music among music, everything else without it', () => {
    expect(ids(viewerList(list, 'audio', false))).toEqual([2, 5]);
    expect(ids(viewerList(list, 'image', false))).toEqual([1, 4, 6]);
    expect(ids(viewerList(list, undefined, false))).toEqual([1, 4, 6]);
    // A slideshow never plays music or files, whatever it starts at.
    expect(ids(viewerList(list, 'audio', true))).toEqual([1, 4, 6]);
    expect(viewerList([{ id: 2, kind: 'audio' }], 'image', true)).toEqual([]);
    expect(opensAsInfo('file')).toBe(true);
    expect(opensAsInfo('audio')).toBe(false);
  });

  it('labels files by their type', () => {
    expect(typeLabel('zip')).toBe('ZIP');
    expect(typeLabel('.docx')).toBe('DOCX');
    expect(typeLabel('')).toBe('FILE');
    expect(typeLabel(null)).toBe('FILE');
    expect(typeLabel('torrent')).toBe('TORR…');
    expect(typeLine('file', 'docx')).toBe('DOCX file');
    expect(typeLine('file', '')).toBe('File without a type');
    expect(typeLine('audio', 'mp3')).toBe('MP3 music');
    expect(typeLine('pdf', 'pdf')).toBe('PDF');
    expect(typeLine('image', 'jpg')).toBe('Picture · JPG');
    expect(extOfName('Song.MP3')).toBe('mp3');
    expect(extOfName('C:\\Music\\a.b\\track')).toBe('');
    expect(extOfName('.bashrc')).toBe('');
    expect(extOfName('archive.tar.gz')).toBe('gz');
  });

  it('says what a send to the phone left out', () => {
    expect(phoneSkippedText(1)).toBe("1 file was skipped: the phone's vault takes only pictures, GIFs and videos.");
    expect(phoneSkippedText(3)).toBe("3 files were skipped: the phone's vault takes only pictures, GIFs and videos.");
  });

  it('the import picker starts with every file', () => {
    expect(IMPORT_FILTERS[0].extensions).toEqual(['*']);
    for (const e of ['mp3', 'flac', 'opus', '7z']) expect(IMPORT_FILTERS[1].extensions).toContain(e);
  });
});
