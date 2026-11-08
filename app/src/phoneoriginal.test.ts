import { describe, expect, it } from 'vitest';
import { copyName, isPhoneOriginal, typeBadge } from './phoneoriginal';

describe('phone originals', () => {
  it('knows which items the window cannot show', () => {
    expect(isPhoneOriginal({ kind: 'image', ext: 'heic' })).toBe(true);
    expect(isPhoneOriginal({ kind: 'image', ext: 'HEIF' })).toBe(true);
    expect(isPhoneOriginal({ kind: 'image', ext: 'bmp' })).toBe(true);
    expect(isPhoneOriginal({ kind: 'video', ext: 'mov' })).toBe(true);
    expect(isPhoneOriginal({ kind: 'video', ext: 'mkv' })).toBe(true);
    expect(isPhoneOriginal({ kind: 'image', name: 'IMG_1.HEIC' })).toBe(true);
    for (const ext of ['jpg', 'png', 'webp', 'gif'])
      expect(isPhoneOriginal({ kind: 'image', ext })).toBe(false);
    for (const ext of ['mp4', 'm4v', 'webm']) expect(isPhoneOriginal({ kind: 'video', ext })).toBe(false);
    expect(isPhoneOriginal({ kind: 'video', ext: 'heic' })).toBe(false);
    expect(isPhoneOriginal({ kind: 'text', ext: 'ts' })).toBe(false);
  });

  it('names the badge and the copy', () => {
    expect(typeBadge({ ext: 'heic' })).toBe('HEIC');
    expect(typeBadge({ name: 'a.mov' })).toBe('MOV');
    expect(copyName({ kind: 'image', name: 'IMG_0001.HEIC' })).toBe('IMG_0001.jpg');
    expect(copyName({ kind: 'video', name: 'VID.2024.mov' })).toBe('VID.2024.mp4');
    expect(copyName({ kind: 'image', name: '.heic' })).toBe('Converted.jpg');
  });
});
