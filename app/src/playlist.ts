// Play order for the viewer, slideshows and multi-screen panels.
//
// Orders: name, date added, size, shuffle (each item once per round),
// fully random, and weighted random (an item with weight 5 comes up about
// five times as often as one with weight 1; weight 0 never comes up).

export type Order = 'nameAsc' | 'nameDesc' | 'newest' | 'oldest' | 'largest' | 'shuffle' | 'random' | 'weighted';
export type Repeat = 'off' | 'all' | 'one';

export const ORDERS: { id: Order; label: string; hint?: string }[] = [
  { id: 'nameAsc', label: 'Name A–Z' },
  { id: 'nameDesc', label: 'Name Z–A' },
  { id: 'newest', label: 'Date added, newest' },
  { id: 'oldest', label: 'Date added, oldest' },
  { id: 'largest', label: 'Size, largest' },
  { id: 'shuffle', label: 'Shuffle', hint: 'each once' },
  { id: 'random', label: 'Fully random', hint: 'repeats allowed' },
  { id: 'weighted', label: 'Weighted random', hint: 'by weight' },
];

export interface Entry {
  key: string;
  name: string;
  added: number;
  size: number;
  /** Missing or invalid weights count as 1. */
  weight?: number;
}

export type Rng = () => number;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function weightOf(e: Entry): number {
  const w = e.weight;
  return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : 1;
}

export function sorted<T extends Entry>(entries: T[], order: Order): T[] {
  const a = [...entries];
  switch (order) {
    case 'nameAsc':
      return a.sort((x, y) => collator.compare(x.name, y.name));
    case 'nameDesc':
      return a.sort((x, y) => collator.compare(y.name, x.name));
    case 'newest':
      return a.sort((x, y) => y.added - x.added || collator.compare(x.name, y.name));
    case 'oldest':
      return a.sort((x, y) => x.added - y.added || collator.compare(x.name, y.name));
    case 'largest':
      return a.sort((x, y) => y.size - x.size);
    default:
      return a;
  }
}

export function shuffled<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick an index with probability proportional to its weight. `avoid` (the
 * item just shown) is skipped when anything else can be picked, so the same
 * file never plays twice in a row.
 */
export function weightedPick(weights: number[], rng: Rng, avoid = -1): number {
  const usable = weights.map((w, i) => (i === avoid ? 0 : w));
  let total = usable.reduce((s, w) => s + w, 0);
  if (total <= 0) {
    if (avoid >= 0 && weights[avoid] > 0) return avoid;
    return -1;
  }
  let r = rng() * total;
  for (let i = 0; i < usable.length; i++) {
    if (usable[i] <= 0) continue;
    r -= usable[i];
    if (r < 0) return i;
  }
  // Floating-point edge: return the last usable item.
  for (let i = usable.length - 1; i >= 0; i--) if (usable[i] > 0) return i;
  total = 0;
  return -1;
}

const isRandomish = (o: Order) => o === 'random' || o === 'weighted';

export class Playlist<T extends Entry = Entry> {
  private seq: T[] = [];
  private pos = -1;
  private history: number[] = []; // positions/indices visited (random modes)
  private items: T[];

  constructor(
    items: T[],
    private order: Order,
    public repeat: Repeat = 'all',
    startKey?: string,
    private rng: Rng = Math.random,
  ) {
    this.items = items;
    this.rebuild(startKey);
  }

  get length(): number {
    return this.items.length;
  }

  get orderName(): Order {
    return this.order;
  }

  private rebuild(keepKey?: string) {
    this.history = [];
    if (isRandomish(this.order)) {
      this.seq = this.items;
      const i = keepKey ? this.items.findIndex((x) => x.key === keepKey) : -1;
      this.pos = i >= 0 ? i : this.pick(-1);
    } else {
      let s = this.order === 'shuffle' ? shuffled(this.items, this.rng) : sorted(this.items, this.order);
      if (keepKey && this.order === 'shuffle') {
        // Start the shuffled round with the item that is showing now.
        const i = s.findIndex((x) => x.key === keepKey);
        if (i > 0) s = [s[i], ...s.slice(0, i), ...s.slice(i + 1)];
      }
      this.seq = s;
      const i = keepKey ? s.findIndex((x) => x.key === keepKey) : -1;
      this.pos = s.length ? Math.max(0, i) : -1;
    }
    if (this.pos >= 0) this.history.push(this.pos);
  }

  private pick(avoid: number): number {
    if (!this.items.length) return -1;
    if (this.order === 'weighted') return weightedPick(this.items.map(weightOf), this.rng, avoid);
    if (this.items.length === 1) return 0;
    let i = Math.floor(this.rng() * (this.items.length - 1));
    if (avoid >= 0 && i >= avoid) i += 1;
    return i;
  }

  current(): T | null {
    return this.pos >= 0 ? (this.seq[this.pos] ?? null) : null;
  }

  setOrder(order: Order) {
    const key = this.current()?.key;
    this.order = order;
    this.rebuild(key);
  }

  setItems(items: T[], keepKey?: string) {
    this.items = items;
    this.rebuild(keepKey ?? this.current()?.key);
  }

  /**
   * Move forward. `auto` = the slideshow advancing by itself (repeat-one
   * replays the same item); a manual skip always moves on.
   * Returns null when the end is reached with repeat off.
   */
  next(auto = false): T | null {
    if (this.pos < 0) return null;
    if (auto && this.repeat === 'one') return this.current();
    if (isRandomish(this.order)) {
      const p = this.pick(this.pos);
      if (p < 0) return null;
      this.pos = p;
      this.history.push(p);
      if (this.history.length > 500) this.history.shift();
      return this.current();
    }
    if (this.pos + 1 < this.seq.length) {
      this.pos += 1;
      return this.current();
    }
    if (this.repeat === 'off' && auto) return null;
    if (this.repeat === 'off') return this.current();
    // Start again from the beginning; a shuffle gets a fresh order, without
    // repeating the last item first.
    if (this.order === 'shuffle' && this.seq.length > 1) {
      const last = this.seq[this.pos];
      let s = shuffled(this.items, this.rng);
      if (s[0].key === last.key) s = [...s.slice(1), s[0]];
      this.seq = s;
    }
    this.pos = 0;
    return this.current();
  }

  prev(): T | null {
    if (this.pos < 0) return null;
    if (isRandomish(this.order)) {
      if (this.history.length > 1) {
        this.history.pop();
        this.pos = this.history[this.history.length - 1];
      }
      return this.current();
    }
    if (this.pos > 0) this.pos -= 1;
    else if (this.repeat === 'all') this.pos = this.seq.length - 1;
    return this.current();
  }

  /** Jump straight to an item (e.g. clicked in the grid). */
  jump(key: string): T | null {
    const i = this.seq.findIndex((x) => x.key === key);
    if (i >= 0) {
      this.pos = i;
      this.history.push(i);
    }
    return this.current();
  }

  /** Position for "34 of 214"; -1 in random modes. */
  index(): number {
    return isRandomish(this.order) ? -1 : this.pos;
  }
}

/** Deterministic RNG for tests. */
export function seeded(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
