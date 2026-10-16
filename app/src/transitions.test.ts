import { describe, expect, it } from 'vitest';
import { normalize } from './presets';
import { normalTransition, pickEffect, RANDOM_POOL, transitionMs, transitionPlan, TRANSITIONS } from './transitions';

describe('transitions', () => {
  it('reads old and unknown saved values', () => {
    expect(normalTransition('fade')).toBe('fade');
    expect(normalTransition('none')).toBe('none');
    expect(normalTransition('cube')).toBe('cube');
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
    expect(pickEffect('random', null, () => 0.99999)).toBe('film');
  });

  it('has keyframes for every one, mirrored when going back', () => {
    for (const e of RANDOM_POOL) {
      const p = transitionPlan(e, 1);
      expect(p.in.length).toBeGreaterThanOrEqual(2);
      expect(p.out.length).toBeGreaterThanOrEqual(2);
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
