import { describe, expect, it } from 'vitest';
import { normalize } from './presets';
import { EDIT_POOL, ENDLESS_START, normalTransition, pickEffect, RANDOM_POOL, randomSpot, transitionMs, transitionPlan, TRANSITIONS } from './transitions';

describe('transitions', () => {
  it('reads old and unknown saved values', () => {
    expect(normalTransition('fade')).toBe('fade');
    expect(normalTransition('none')).toBe('none');
    expect(normalTransition('cube')).toBe('cube');
    expect(normalTransition('whip')).toBe('whip');
    expect(normalTransition('edits')).toBe('edits');
    expect(normalTransition('glitch')).toBe('fade');
    expect(normalTransition('sparkles')).toBe('fade');
    expect(normalTransition(undefined)).toBe('fade');
    expect(normalize({ transition: 'none' }).transition).toBe('none');
    expect(normalize({ transition: 'weird' as never }).transition).toBe('fade');
    expect(normalize({}).fadeMs).toBe(350);
  });

  it('plays nothing extra for None and the plain Fade', () => {
    expect(pickEffect('none', null)).toBeNull();
    expect(pickEffect('fade', null)).toBeNull();
    expect(pickEffect('iris', null)).toBe('iris');
  });

  it('Random picks any one, never the same twice in a row', () => {
    const seen = new Set<string>();
    let last = null as ReturnType<typeof pickEffect>;
    for (let i = 0; i < 400; i++) {
      const e = pickEffect('random', last);
      expect(e).not.toBeNull();
      expect(e).not.toBe(last);
      seen.add(e!);
      last = e;
    }
    expect([...seen].sort()).toEqual([...RANDOM_POOL].sort());
    expect(pickEffect('random', 'fade', () => 0)).toBe('black');
    expect(pickEffect('random', null, () => 0.99999)).toBe('endless');
  });

  it('Random edit style only mixes the edit-style ones, never the same twice in a row', () => {
    const seen = new Set<string>();
    let last = null as ReturnType<typeof pickEffect>;
    for (let i = 0; i < 300; i++) {
      const e = pickEffect('edits', last);
      expect(e).not.toBe(last);
      expect(EDIT_POOL).toContain(e);
      seen.add(e!);
      last = e;
    }
    expect([...seen].sort()).toEqual([...EDIT_POOL].sort());
    for (const e of EDIT_POOL) {
      expect(RANDOM_POOL).toContain(e);
      expect(TRANSITIONS.map((t) => t.id)).toContain(e);
    }
    expect(pickEffect('whip', 'whip')).toBe('whip');
    expect(TRANSITIONS.every((t) => t.hint.length > 0)).toBe(true);
  });

  it('edit-style keyframes: whip goes with the direction, endless zoom stays together', () => {
    expect(transitionPlan('whip', 1).in[0].transform).toContain('calc(115%');
    expect(transitionPlan('whip', -1).in[0].transform).toContain('calc(-115%');
    expect(transitionPlan('whip', -1).out[1].transform).toContain('translateX(115%)');
    expect(String(transitionPlan('shake', 1).in.at(-1)!.transform)).toContain('scale(1)');
    const p = transitionPlan('endless', 1, 0, { x: 0.25, y: 0.75 });
    expect(p.ghostOnTop).toBe(false);
    expect(p.in[0].transformOrigin).toBe('25.00% 75.00%');
    expect(p.out[0].transformOrigin).toBe('25.00% 75.00%');
    const sc = (k: Keyframe) => Number(/scale\(([\d.]+)\)/.exec(String(k.transform))![1]);
    expect(sc(p.in[0])).toBeCloseTo(ENDLESS_START);
    expect(sc(p.in.at(-1)!)).toBeCloseTo(1);
    // The next item is a fixed part of the old picture all the way.
    p.in.forEach((k, i) => expect(sc(k) / sc(p.out[i])).toBeCloseTo(ENDLESS_START, 3));
    expect(transitionPlan('endless', 1, 0, { x: NaN, y: 9 }).in[0].transformOrigin).toBe('50.00% 100.00%');
    const r = randomSpot(() => 0);
    expect(r.x).toBeCloseTo(0.3);
    expect(randomSpot(() => 0.999).y).toBeLessThan(0.71);
  });

  it('has keyframes for every one, mirrored when going back', () => {
    for (const e of RANDOM_POOL) {
      const p = transitionPlan(e, 1);
      expect(p.in.length).toBeGreaterThanOrEqual(2);
      expect(p.out.length).toBeGreaterThanOrEqual(2);
      // Offsets go up (the browser refuses them otherwise).
      for (const list of [p.in, p.out]) {
        const offs = list.map((k) => k.offset).filter((o): o is number => typeof o === 'number');
        offs.forEach((o, i) => expect(o).toBeGreaterThanOrEqual(i ? offs[i - 1] : 0));
        expect(offs.every((o) => o <= 1)).toBe(true);
      }
    }
    expect(transitionPlan('slide', 1).in[0].transform).toContain('100%');
    expect(transitionPlan('slide', -1).in[0].transform).toContain('-100%');
    // A swipe carries on from where the mouse left it.
    expect(transitionPlan('slide', 1, -120).out[0].transform).toBe('translateX(-120px)');
    expect(transitionPlan('iris', 1).ghostOnTop).toBe(false);
    expect(transitionPlan('film', 1).film).toBe(true);
    expect(TRANSITIONS.map((t) => t.id)).toContain('random');
  });

  it('keeps up with fast beat sync', () => {
    expect(transitionMs(800, null, 1)).toBe(800);
    expect(transitionMs(800, 120, 1)).toBeCloseTo(175);
    expect(transitionMs(100, 120, 4)).toBe(100);
    expect(transitionMs(800, 1000, 1)).toBe(60);
  });
});
