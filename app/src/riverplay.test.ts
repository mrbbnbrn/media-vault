import { describe, expect, it } from 'vitest';
import { bigEnough, faceCountText, MAX_RIVER_PLAYERS, peopleText, riverPreviews, type RiverCardWant, type RiverFace } from './riverplay';

const card = (key: number, over: Partial<RiverCardWant> = {}): RiverCardWant => ({
  key, kind: 'video', layer: 4, hasTiny: true, hasStrip: true, hovered: false, frozen: false, onScreen: true, away: key, ...over,
});
const NEAREST = 4;

describe('river video previews', () => {
  it('near depths play the tiny clip, the real video while the budget lasts; far ones flip', () => {
    const plan = riverPreviews([card(1), card(2, { layer: 3 }), card(3, { layer: 2 }), card(4, { layer: 0 })], NEAREST, 1);
    // The nearest depth gets the one real video; the depth behind it the tiny clip.
    expect(plan.get(1)).toBe('real');
    expect(plan.get(2)).toBe('tiny');
    expect(plan.get(3)).toBe('flip');
    expect(plan.get(4)).toBe('flip');
  });

  it('no budget: tiny clips only; no tiny clip: the flip-book stands in; nothing at all: the picture', () => {
    const plan = riverPreviews([card(1), card(2, { hasTiny: false }), card(3, { hasTiny: false, hasStrip: false })], NEAREST, 0);
    expect([plan.get(1), plan.get(2), plan.get(3)]).toEqual(['tiny', 'flip', 'thumb']);
    const far = riverPreviews([card(5, { layer: 0, hasStrip: false })], NEAREST, 4);
    expect(far.get(5)).toBe('thumb');
  });

  it('the hovered card plays the real video at once, in any depth, budget or not', () => {
    const plan = riverPreviews([card(1), card(2, { layer: 0, hovered: true })], NEAREST, 0);
    expect(plan.get(2)).toBe('real');
    expect(plan.get(1)).toBe('tiny');
  });

  it('frozen cards count as near; cards not on screen yet get no player', () => {
    const plan = riverPreviews([card(1, { layer: 1, frozen: true }), card(2, { onScreen: false })], NEAREST, 0);
    expect(plan.get(1)).toBe('tiny');
    expect(plan.get(2)).toBe('flip');
  });

  it('pictures, GIFs and faces are left alone', () => {
    const plan = riverPreviews([card(1, { kind: 'image' }), card(2, { kind: 'gif' }), card(3, { kind: 'face' })], NEAREST, 4);
    expect(plan.size).toBe(0);
  });

  it('only so many players at once: the hovered one and those nearest the middle first', () => {
    const many = Array.from({ length: 30 }, (_, i) => card(i + 1, { away: 100 - i }));
    many.push(card(99, { layer: 0, hovered: true, away: 1000 }));
    const plan = riverPreviews(many, NEAREST, 2);
    const playing = [...plan].filter(([, l]) => l === 'tiny' || l === 'real');
    expect(playing.length).toBe(MAX_RIVER_PLAYERS);
    expect(plan.get(99)).toBe('real');
    // The card nearest the middle is playing; the one furthest away flips.
    expect(['tiny', 'real']).toContain(plan.get(30));
    expect(plan.get(1)).toBe('flip');
    // Hovered + one more real (budget 2).
    expect(playing.filter(([, l]) => l === 'real').length).toBe(2);
  });

  it('works with two layers (both are "near")', () => {
    const plan = riverPreviews([card(1, { layer: 0 }), card(2, { layer: 1 })], 1, 0);
    expect([plan.get(1), plan.get(2)]).toEqual(['tiny', 'tiny']);
  });
});

describe('faces river', () => {
  const face = (id: number, px: number | null): RiverFace => ({ id, media: id, person: 1, x: 0, y: 0, w: 0.1, h: 0.1, frameMs: 0, px, aspect: 1 });

  it('leaves out faces smaller than the slider (unknown sizes stay)', () => {
    const all = [face(1, 40), face(2, 120), face(3, null), face(4, 300)];
    expect(bigEnough(all, 0)).toBe(all);
    expect(bigEnough(all, 100).map((f) => f.id)).toEqual([2, 3, 4]);
    expect(bigEnough(all, 500).map((f) => f.id)).toEqual([3]);
  });

  it('counts in plain words', () => {
    expect(faceCountText(312, 1040)).toBe('312 of 1,040 faces');
    expect(faceCountText(5, 5)).toBe('5 faces');
    expect(faceCountText(1, 1)).toBe('1 face');
  });

  it('names who is picked', () => {
    const names = new Map([[1, 'Ann'], [2, 'Bob'], [3, 'Cem']]);
    expect(peopleText([], names)).toBe('Everyone');
    expect(peopleText([2], names)).toBe('Bob');
    expect(peopleText([1, 3, 2], names)).toBe('Ann + 2');
    // A person folder that is gone no longer counts.
    expect(peopleText([7], names)).toBe('Everyone');
  });
});
