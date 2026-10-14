// The slot machine's odds and matching: which pictures land on the three reels
// and whether they make a jackpot (all three the same person or tag) or
// "so close" (two of a kind). Pure, so it is tested with a seeded random.

export interface SlotGroup {
  kind: 'person' | 'tag';
  /** Person folder id, or the tag. */
  key: string;
  label: string;
  /** Item ids. */
  items: number[];
}

export type Rng = () => number;

/** A small seeded random number generator (for tests and replays). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** About one spin in five or six lands on a group when there are groups. */
export const JACKPOT_ODDS = 0.18;
/** And about one in four is a near miss. */
export const PAIR_ODDS = 0.25;

/**
 * Groups worth playing for: at least two items of the pool, and not almost
 * everything (a tag on the folder itself would make every spin a jackpot).
 * People first, then bigger groups.
 */
export function usefulGroups(groups: SlotGroup[], pool: number[]): SlotGroup[] {
  const inPool = new Set(pool);
  const max = pool.length >= 6 ? Math.floor(pool.length * 0.6) : pool.length - 1;
  return groups
    .map((g) => ({ ...g, items: [...new Set(g.items.filter((id) => inPool.has(id)))] }))
    .filter((g) => g.items.length >= 2 && g.items.length <= max)
    .sort((a, b) => Number(b.kind === 'person') - Number(a.kind === 'person') || b.items.length - a.items.length || a.label.localeCompare(b.label));
}

const pick = <T,>(list: T[], rng: Rng): T => list[Math.floor(rng() * list.length) % list.length];

/** `n` different items from `list` (fewer if it is shorter, then repeats). */
function pickDistinct(list: number[], n: number, rng: Rng): number[] {
  const rest = [...list];
  const out: number[] = [];
  while (out.length < n && rest.length) out.push(rest.splice(Math.floor(rng() * rest.length) % rest.length, 1)[0]);
  while (out.length < n && list.length) out.push(pick(list, rng));
  return out;
}

function shuffle<T>(list: T[], rng: Rng): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The three items a spin lands on. `groups` should come from usefulGroups. */
export function planSpin(pool: number[], groups: SlotGroup[], rng: Rng): number[] {
  if (!pool.length) return [];
  const roll = rng();
  const big = groups.filter((g) => g.items.length >= 3);
  if (big.length && roll < JACKPOT_ODDS) return pickDistinct(pick(big, rng).items, 3, rng);
  if (groups.length && roll < JACKPOT_ODDS + PAIR_ODDS) {
    const g = pick(groups, rng);
    const two = pickDistinct(g.items, 2, rng);
    const others = pool.filter((id) => !g.items.includes(id));
    const third = others.length ? pick(others, rng) : pickDistinct(pool, 1, rng)[0];
    return shuffle([...two, third], rng);
  }
  return pickDistinct(pool, 3, rng);
}

export type SpinResult =
  | { kind: 'jackpot'; group: SlotGroup }
  | { kind: 'pair'; group: SlotGroup; reels: [number, number] }
  | { kind: 'none' };

/** What three reels show: the first matching group wins (people first). */
export function evaluate(reels: number[], groups: SlotGroup[]): SpinResult {
  if (reels.length < 3) return { kind: 'none' };
  for (const g of groups) {
    const set = new Set(g.items);
    if (reels.every((id) => set.has(id))) return { kind: 'jackpot', group: g };
  }
  for (const g of groups) {
    const set = new Set(g.items);
    const hits = reels.map((id, k) => (set.has(id) ? k : -1)).filter((k) => k >= 0);
    if (hits.length >= 2) return { kind: 'pair', group: g, reels: [hits[0], hits[1]] };
  }
  return { kind: 'none' };
}

/** A strip of pictures for a reel to spin through, ending on `last`. */
export function reelStrip(pool: number[], last: number, length: number, rng: Rng): number[] {
  const out: number[] = [];
  for (let k = 0; k < length - 1; k++) out.push(pick(pool, rng));
  out.push(last);
  return out;
}
