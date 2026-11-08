import { describe, expect, it } from 'vitest';
import type { TransferDone } from './apitypes';
import { countdown, doneMessage, formatCode, progressFraction, progressText } from './transferlogic';

const done = (p: Partial<TransferDone>): TransferDone => ({ dir: 'receive', done: 0, have: 0, cant: 0, failed: [], stopped: null, folder: null, playable: 0, ...p });

describe('phone transfer words', () => {
  it('formats the pairing code in two groups', () => {
    expect(formatCode('004217')).toBe('004 217');
    expect(formatCode('199921')).toBe('199 921');
    expect(formatCode(' 004 217 ')).toBe('004 217');
    expect(formatCode(null)).toBe('');
    expect(formatCode('12345')).toBe('12345');
  });

  it('counts down the pairing window', () => {
    expect(countdown(120_000, 0)).toBe('2:00');
    expect(countdown(102_000, 0)).toBe('1:42');
    expect(countdown(1_500, 0)).toBe('0:02');
    expect(countdown(0, 5_000)).toBe('0:00');
  });

  it('progress text and fraction', () => {
    const p = { dir: 'send' as const, done: 3, total: 10, bytes: 50, totalBytes: 200, current: 'a.jpg' };
    expect(progressText(p)).toBe('Sending to phone 3/10');
    expect(progressText({ ...p, dir: 'receive', total: 0 })).toBe('Receiving from phone');
    expect(progressFraction(p)).toBe(0.25);
    expect(progressFraction({ ...p, totalBytes: 0 })).toBe(0.3);
    expect(progressFraction({ ...p, totalBytes: 0, total: 0 })).toBeUndefined();
  });

  it('says what arrived', () => {
    expect(doneMessage(done({ done: 12 }), 'Telefon')).toEqual({ text: '12 items arrived from Telefon — in Received from phone', kind: 'done' });
    expect(doneMessage(done({ done: 1, playable: 1, have: 2 }), 'Telefon').text)
      .toBe('1 item arrived from Telefon — in Received from phone (1 playable copy made, 2 you already had)');
    expect(doneMessage(done({ done: 0, have: 3 }), null)).toEqual({ text: 'Nothing new arrived from your phone (3 you already had)', kind: 'note' });
    const cut = doneMessage(done({ done: 4, stopped: 'Your phone locked its vault.' }), 'Telefon');
    expect(cut.text).toBe('4 items arrived from Telefon — in Received from phone. Stopped: Your phone locked its vault.');
    expect(cut.kind).toBe('problem');
    expect(doneMessage(done({ failed: [['a.heic', 'It is damaged.']] }), 'Telefon'))
      .toEqual({ text: 'Nothing new arrived from Telefon (1 failed). “a.heic”: It is damaged.', kind: 'problem' });
  });

  it('says what was sent', () => {
    expect(doneMessage(done({ dir: 'send', done: 8, have: 3 }), 'Telefon').text).toBe('Sent 8 items to Telefon (3 it already had)');
    expect(doneMessage(done({ dir: 'send', done: 1 }), 'Telefon').text).toBe('Sent 1 item to Telefon');
    expect(doneMessage(done({ dir: 'send', have: 5 }), 'Telefon')).toEqual({ text: 'Telefon already had all 5', kind: 'note' });
    expect(doneMessage(done({ dir: 'send', have: 1 }), null).text).toBe('Your phone already had it');
    expect(doneMessage(done({ dir: 'send', done: 2, cant: 1, have: 1 }), 'Telefon').text).toBe("Sent 2 items to Telefon (1 it already had, 1 it can't take)");
    expect(doneMessage(done({ dir: 'send', cant: 2 }), 'Telefon')).toEqual({ text: "Nothing was sent to Telefon (2 it can't take)", kind: 'note' });
  });
});
