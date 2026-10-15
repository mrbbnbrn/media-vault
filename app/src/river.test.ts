import { describe, expect, it } from 'vitest';
import {
  cardSize, Deck, DEFAULT_LAYERS, fill, flowText, flowToSlider, hitTest, LAYERS, layerSpeed, loose, makeLayers, margin, MAX_FLOW, MAX_LAYERS, MIN_FLOW, MIN_LAYERS,
  Momentum, NEAREST, placed, seeded, setDensity, setLayerCount, sliderToFlow, step, stepFlow, wheelFlow,
  type Drifter, type Spawner, type View,
} from './river';

const V: View = { w: 1920, h: 1080, reduced: false };

function spawner(n: number, seed = 7, aspect = (i: number) => [4 / 3, 3 / 4, 16 / 9, 1][i % 4]): Spawner & { deck: Deck; showing: () => Set<number>; list?: Drifter[] } {
  const rand = seeded(seed);
  const deck = new Deck(n, seeded(seed + 1));
  const s: Spawner & { deck: Deck; showing: () => Set<number>; list?: Drifter[] } = {
    rand,
    deck,
    showing: () => new Set((s.list ?? []).map((d) => d.item)),
    pick: () => {
      const i = deck.next(s.showing());
      return i < 0 ? null : { item: i, aspect: aspect(i) };
    },
  };
  return s;
}

const run = (list: Drifter[], s: Spawner, seconds: number, flow = 1, v = V, hovered: (l: Drifter[]) => number | null = () => null) => {
  let gone = 0;
  let added = 0;
  for (let i = 0; i < seconds * 30; i++) {
    const r = step(list, 1 / 30, flow, v, s, hovered(list));
    gone += r.gone.length;
    added += r.added.length;
  }
  return { gone, added };
};

describe('deck', () => {
  it('every item once before any repeats', () => {
    const d = new Deck(10, seeded(3));
    const seen = Array.from({ length: 10 }, () => d.next(new Set()));
    expect(new Set(seen).size).toBe(10);
  });
  it('skips items already on screen when there are others', () => {
    const d = new Deck(5, seeded(3));
    for (let k = 0; k < 40; k++) expect([0, 1, 2]).not.toContain(d.next(new Set([0, 1, 2])));
  });
  it('a tiny library still flows (repeats allowed)', () => {
    const d = new Deck(1, seeded(3));
    expect(d.next(new Set([0]))).toBe(0);
    expect(new Deck(0).next(new Set())).toBe(-1);
  });
});

describe('layers', () => {
  it('further away is smaller, slower, dimmer and softer', () => {
    for (let i = 1; i < LAYERS.length; i++) {
      expect(LAYERS[i].size).toBeGreaterThan(LAYERS[i - 1].size);
      expect(LAYERS[i].speed).toBeGreaterThan(LAYERS[i - 1].speed);
      expect(LAYERS[i].opacity).toBeGreaterThanOrEqual(LAYERS[i - 1].opacity);
      expect(LAYERS[i].blur).toBeLessThanOrEqual(LAYERS[i - 1].blur);
    }
    expect(LAYERS[NEAREST].blur).toBe(0);
  });
  it('card sizes keep the shape, within reason', () => {
    const a = cardSize(NEAREST, 4 / 3, V);
    expect(a.w / a.h).toBeCloseTo(4 / 3, 5);
    const pano = cardSize(NEAREST, 5, V);
    expect(pano.w / pano.h).toBeCloseTo(1.8, 5);
    expect(pano.h).toBeLessThan(a.h);
    expect(cardSize(0, NaN, V).w).toBeGreaterThan(0);
  });
  it('a tall narrow window gets smaller cards', () => {
    expect(cardSize(NEAREST, 1, { w: 900, h: 1000, reduced: false }).h).toBeLessThan(cardSize(NEAREST, 1, { w: 1600, h: 1000, reduced: false }).h);
  });
  it('speed follows the screen height and the flow; reduced motion is gentler', () => {
    expect(layerSpeed(0, 1, { ...V, w: 3840, h: 2160 })).toBeCloseTo(layerSpeed(0, 1, V) * 2, 5);
    expect(layerSpeed(1, 2, V)).toBeCloseTo(layerSpeed(1, 1, V) * 2, 5);
    expect(layerSpeed(2, 1, { ...V, reduced: true })).toBeCloseTo(layerSpeed(2, 1, V) / 2, 5);
  });
});

describe('the stream', () => {
  it('starts with every layer spread across the screen, cards not overlapping in a layer', () => {
    const s = spawner(500);
    const list = fill(V, s);
    for (let l = 0; l < LAYERS.length; l++) {
      const mine = list.filter((d) => d.layer === l).sort((a, b) => a.x - b.x);
      expect(mine.length).toBeGreaterThan(1);
      expect(mine[0].x - mine[0].w / 2).toBeLessThan(V.w * 0.3);
      expect(mine[mine.length - 1].x + mine[mine.length - 1].w / 2).toBeGreaterThan(V.w * 0.6);
      for (let i = 1; i < mine.length; i++) expect(mine[i].x - mine[i].w / 2).toBeGreaterThan(mine[i - 1].x + mine[i - 1].w / 2);
    }
    expect(new Set(list.map((d) => d.item)).size).toBe(list.length);
  });

  it('drifts right; the nearer layers faster', () => {
    const s = spawner(500);
    const list = fill(V, s);
    const before = new Map(list.map((d) => [d.key, d.x]));
    step(list, 0.05, 1, V, s, null);
    const moved = (l: number) => {
      const d = list.find((x) => x.layer === l && before.has(x.key))!;
      return d.x - before.get(d.key)!;
    };
    expect(moved(0)).toBeGreaterThan(0);
    expect(moved(NEAREST)).toBeGreaterThan(moved(0) * 3);
  });

  it('runs for hours with a bounded number of cards, all items coming round', () => {
    const s = spawner(300);
    const list = fill(V, s);
    s.list = list;
    const seen = new Set(list.map((d) => d.item));
    let most = list.length;
    // Two hours at double speed, in ten-minute pieces.
    for (let k = 0; k < 12; k++) {
      for (let i = 0; i < 600 * 10; i++) {
        const r = step(list, 0.1, 2, V, s, null);
        r.added.forEach((d) => seen.add(d.item));
      }
      most = Math.max(most, list.length);
    }
    expect(most).toBeLessThan(80);
    expect(seen.size).toBe(300);
    // Nothing piles up off screen.
    const m = margin(V);
    for (const d of list) {
      expect(d.x - d.w / 2).toBeLessThanOrEqual(V.w + m + 1);
      expect(d.x + d.w / 2).toBeGreaterThan(-m - LAYERS[d.layer].gapMax * d.h - d.w - 1);
    }
  });

  it('no item twice on screen when the library is big enough', () => {
    const s = spawner(200);
    const list = fill(V, s);
    s.list = list;
    for (let i = 0; i < 3000; i++) {
      step(list, 0.1, 3, V, s, null);
      expect(new Set(list.map((d) => d.item)).size).toBe(list.length);
    }
  });

  it('a hovered card nearly stops; the ones behind it queue instead of running into it', () => {
    const s = spawner(500);
    const list = fill(V, s);
    s.list = list;
    const target = list.filter((d) => d.layer === NEAREST).sort((a, b) => b.x - a.x).find((d) => d.x < V.w * 0.6)!;
    const x0 = target.x;
    run(list, s, 30, 1, V, () => target.key);
    expect(target.lift).toBeGreaterThan(0.99);
    const freeTravel = layerSpeed(NEAREST, 1, V) * 30;
    expect(target.x - x0).toBeLessThan(freeTravel * 0.2);
    const behind = list.filter((d) => d.layer === NEAREST && d.x < target.x && Math.abs(d.y - target.y) < (d.h + target.h) / 2);
    for (const d of behind) expect(target.x - target.w / 2 - (d.x + d.w / 2)).toBeGreaterThan(0);
    // Let go: it floats on again.
    const x1 = target.x;
    run(list, s, 5, 1, V);
    expect(target.lift).toBeLessThan(0.01);
    expect(target.x - x1).toBeGreaterThan(layerSpeed(NEAREST, 1, V) * 2);
  });

  it('flow 0 holds everything still', () => {
    const s = spawner(100);
    const list = fill(V, s);
    const xs = new Map(list.map((d) => [d, d.x]));
    run(list, s, 2, 0);
    for (const [d, x] of xs) expect(d.x).toBe(x);
  });

  it('handles a huge time step and an empty library', () => {
    const s = spawner(50);
    const list = fill(V, s);
    expect(() => step(list, 5, 1, V, s, null)).not.toThrow();
    const empty = spawner(0);
    expect(fill(V, empty)).toEqual([]);
    const none: Drifter[] = [];
    step(none, 0.1, 1, V, empty, null);
    expect(none).toEqual([]);
  });

  it('fades in at the start', () => {
    const s = spawner(50);
    const list = fill(V, s);
    expect(list.every((d) => d.shown === 0)).toBe(true);
    run(list, s, 4);
    expect(list.filter((d) => d.x > 0 && d.x < V.w).every((d) => d.shown > 0.95)).toBe(true);
  });
});

describe('drawing and the mouse', () => {
  const d = (over: Partial<Drifter>): Drifter => ({ key: 1, layer: 0, item: 0, x: 500, y: 400, w: 200, h: 150, phase: 0, tilt: 0, lift: 0, shown: 1, ...over });

  it('lifted cards are bigger and level; reduced motion has no bob or sway', () => {
    const a = placed(d({ tilt: 1.2, phase: 1 }), 3, V);
    const b = placed(d({ tilt: 1.2, phase: 1, lift: 1 }), 3, V);
    expect(b.scale).toBeGreaterThan(a.scale);
    expect(b.rot).toBe(0);
    const r = placed(d({ tilt: 0.5, phase: 1 }), 3, { ...V, reduced: true });
    expect(r.y).toBe(400);
    expect(r.rot).toBe(0.5);
  });

  it('nearer cards win; points outside hit nothing; faded-in-only cards are skipped', () => {
    const far = d({ key: 1, layer: 0 });
    const near = d({ key: 2, layer: NEAREST, x: 560 });
    const ghost = d({ key: 3, layer: NEAREST, x: 900, shown: 0.1 });
    const list = [near, far, ghost];
    const v = { ...V, reduced: true };
    expect(hitTest(list, 520, 400, 0, v)?.key).toBe(2);
    expect(hitTest(list, 420, 400, 0, v)?.key).toBe(1);
    expect(hitTest(list, 900, 400, 0, v)).toBeNull();
    expect(hitTest(list, 50, 50, 0, v)).toBeNull();
    // The hovered one keeps the mouse where they overlap.
    expect(hitTest(list, 520, 400, 0, v, 1)?.key).toBe(1);
  });
});

describe('flow', () => {
  it('steps up and down within bounds', () => {
    expect(stepFlow(1, 1)).toBe(1.5);
    expect(stepFlow(1, -1)).toBe(0.75);
    expect(stepFlow(MAX_FLOW, 1)).toBe(MAX_FLOW);
    expect(stepFlow(MIN_FLOW, -1)).toBe(MIN_FLOW);
    expect(stepFlow(1.2, 1)).toBe(1.5);
    expect(stepFlow(1.2, -1)).toBe(1);
  });
  it('the wheel: away is faster, towards slower, within bounds', () => {
    expect(wheelFlow(1, -100)).toBeGreaterThan(1);
    expect(wheelFlow(1, 100)).toBeLessThan(1);
    expect(wheelFlow(1, -100000)).toBe(MAX_FLOW);
    expect(wheelFlow(1, 100000)).toBe(MIN_FLOW);
  });
  it('reads nicely', () => {
    expect(flowText(1)).toBe('×1');
    expect(flowText(1.5)).toBe('×1.5');
    expect(flowText(0.25)).toBe('×0.25');
  });
});

describe('layers, flow amount, speed range', () => {
  it('two layers are the front row and the row just behind; more than five are in between', () => {
    const two = makeLayers(2);
    expect(two).toHaveLength(2);
    expect(two[1].size).toBeCloseTo(0.31);
    expect(two[0].size).toBeCloseTo(0.215);
    const eight = makeLayers(8);
    expect(eight).toHaveLength(8);
    for (let i = 1; i < eight.length; i++) expect(eight[i].size).toBeGreaterThan(eight[i - 1].size);
    expect(makeLayers(99)).toHaveLength(MAX_LAYERS);
    expect(makeLayers(0)).toHaveLength(MIN_LAYERS);
  });

  it('even the furthest layer stays easy to see', () => {
    for (const l of makeLayers(8)) {
      expect(l.opacity).toBeGreaterThanOrEqual(0.55);
      expect(l.blur).toBeLessThanOrEqual(1.4);
    }
  });

  it('the layer count changes everywhere at once; more flow means more cards', () => {
    try {
      setLayerCount(3);
      expect(LAYERS).toHaveLength(3);
      expect(NEAREST).toBe(2);
      const s = spawner(400);
      const few = fill(V, s);
      expect(new Set(few.map((x) => x.layer)).size).toBe(3);
      setDensity(2.5);
      const many = fill(V, spawner(400));
      expect(many.length).toBeGreaterThan(few.length * 1.6);
    } finally {
      setLayerCount(DEFAULT_LAYERS);
      setDensity(1);
    }
  });

  it('the speed slider covers very slow to very fast, evenly', () => {
    expect(MIN_FLOW).toBeLessThanOrEqual(0.1);
    expect(MAX_FLOW).toBeGreaterThanOrEqual(8);
    expect(sliderToFlow(0)).toBeCloseTo(MIN_FLOW);
    expect(sliderToFlow(1)).toBeCloseTo(MAX_FLOW);
    for (const f of [0.1, 0.5, 1, 3, 8]) expect(sliderToFlow(flowToSlider(f))).toBeCloseTo(f);
  });
});

describe('holding, flicking and freezing', () => {
  const card = (o: Partial<Drifter> = {}): Drifter => ({ key: 9001, layer: NEAREST, item: 0, x: 500, y: 400, w: 200, h: 150, phase: 0, tilt: 0, lift: 0, shown: 1, ...o });

  it('a held or frozen card stays put; others pass instead of queueing behind it', () => {
    const s = spawner(200);
    const list = fill(V, s);
    s.list = list;
    const held = card({ held: true });
    const frozen = card({ key: 9002, frozen: true, x: 900 });
    list.push(held, frozen);
    run(list, s, 5);
    expect([held.x, held.y]).toEqual([500, 400]);
    expect([frozen.x, frozen.y]).toEqual([900, 400]);
    expect(loose(held) && loose(frozen)).toBe(true);
    // The stream kept flowing past them.
    expect(list.filter((x) => !loose(x)).length).toBeGreaterThan(10);
  });

  it('a flicked card flies on, slows to the current and rejoins it — or leaves if thrown off screen', () => {
    const s = spawner(200);
    const list: Drifter[] = [];
    s.list = list;
    const thrown = card({ vx: 0, vy: -900 });
    list.push(thrown);
    step(list, 0.05, 1, V, s, null);
    expect(thrown.y).toBeLessThan(400 - 30);
    const off = card({ key: 9003, vx: -6000, vy: 0, x: 100 });
    list.push(off);
    let left = false;
    for (let i = 0; i < 40 && !left; i++) left = step(list, 1 / 30, 1, V, s, null).gone.includes(off);
    expect(left).toBe(true);
    const slow = card({ key: 9004, vx: 300, vy: 0 });
    list.push(slow);
    for (let i = 0; i < 120; i++) step(list, 1 / 30, 1, V, s, null);
    expect(loose(slow)).toBe(false);
  });

  it("the hand's speed counts only the last moment before letting go", () => {
    const m = new Momentum();
    m.add(0, 0, 0);
    m.add(50, 0, 50);
    m.add(100, 0, 100);
    expect(m.velocity(100).x).toBeCloseTo(1000);
    // Held still before letting go: no throw.
    expect(m.velocity(300)).toEqual({ x: 0, y: 0 });
    m.clear();
    expect(m.velocity(0)).toEqual({ x: 0, y: 0 });
  });

  it('a held card is what the mouse is on', () => {
    const held = card({ held: true, layer: 0 });
    const near = card({ key: 9005, layer: NEAREST });
    expect(hitTest([near, held], 500, 400, 0, { ...V, reduced: true })?.key).toBe(9001);
  });
});
