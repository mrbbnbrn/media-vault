// Draws the discovery river: a pool of cards moved with transforms only (one
// requestAnimationFrame loop, no React per frame), soft motes on a small
// canvas, and the mouse handled by hit-testing the moving cards. Cards are
// reused as they leave, so it can run for hours with the same few elements.
// The maths is river.ts.
//
// Videos move too: the two nearest depths play their tiny clip (the real
// video while the PC keeps up), further depths a flip-book; which card shows
// what is riverplay.ts. Players come from a reused pool (videopool.ts) and
// rest while the viewer covers the river or the window is hidden. In the faces
// river, cards are round bubbles cut out of the picture on screen (nothing is
// stored).

import {
  cardSize, Deck, fill, flowText, unit, hitTest, LAYERS, MAX_FLOW, MIN_FLOW, Momentum, NEAREST, placed, setDensity, setLayerCount, step, stepFlow, wheelFlow,
  type Drifter, type Spawner, type View,
} from '../../river';
import { riverPreviews, type RiverCardWant } from '../../riverplay';
import { Budget, type Layer } from '../../previewplan';
import { PlayerPool } from '../../videopool';
import { CLIP_FPS, FRAMES, frameTimes, framePosition, tinyToSource } from '../../previews';
import { coverFit } from '../../facealign';
import { isWindowResting, onWindowResting } from '../../previewgate';
import { makePlayer } from '../VideoPreview';

export interface RiverItem {
  id: number;
  kind: 'image' | 'gif' | 'video';
  name: string;
  /** Width / height when known. */
  aspect: number | null;
  /** Videos: a frame strip (flip-book) exists. */
  preview: boolean;
  /** A thumbnail exists. */
  thumb: boolean;
  /** Videos: a tiny silent clip exists. */
  tiny?: boolean;
  durationMs?: number | null;
  /** Faces river: the face to cut out of picture `media` (box in parts of the picture). */
  face?: { media: number; x: number; y: number; w: number; h: number };
}

export interface Sources {
  thumb: (id: number) => string;
  full: (id: number) => string;
  preview: (id: number) => string;
  tiny: (id: number) => string;
}

export interface EngineEvents {
  onOpen: (index: number) => void;
  /** Flow changed or paused (for the little speed note); `flow` is the new current. */
  onFlow: (text: string, flow: number) => void;
  onLeave: () => void;
  /** Middle-click: this item in the mini player. */
  onMini?: (index: number) => void;
}

export interface RiverOptions {
  flow?: number;
  density?: number;
  layers?: number;
}

interface Card {
  el: HTMLDivElement;
  card: HTMLDivElement;
  img: HTMLImageElement;
  glow: HTMLDivElement;
  name: HTMLDivElement;
  layer: number;
  /** The drifter it shows now. */
  key: number;
  shownOpacity: number;
  lift: number;
  full: boolean;
  /** What this video card shows now (riverplay.ts). */
  want: Layer;
  /** The flip-book (made when first needed, kept with the card). */
  flip: HTMLDivElement | null;
  /** The player on screen and the one fading in over it (tiny <-> real). */
  player: HTMLVideoElement | null;
  next: HTMLVideoElement | null;
}

const IDLE_MS = 2600;
/** How often the river looks again at which cards play what (s). */
const PLAN_EVERY = 0.5;
/** How often it looks at how smoothly the real videos play (ms). */
const BUDGET_EVERY = 2000;
/** A player that was replaced fades out this long before it is handed back. */
const FADE_MS = 650;

export class RiverEngine {
  private readonly view: View;
  private deck: Deck;
  private drifters: Drifter[] = [];
  private cards = new Map<number, Card>();
  private pool: Card[][] = LAYERS.map(() => []);
  private raf = 0;
  private last = 0;
  private t = 0;
  private flow = 1;
  private target = 1;
  private paused = false;
  private covered = false;
  private mouse: { x: number; y: number } | null = null;
  private hovered: Drifter | null = null;
  private dt = 1 / 60;
  private motes: { x: number; y: number; r: number; z: number; a: number; p: number }[] = [];
  private mote: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private dpr = 1;
  private moteScale = 0.5;
  private readonly spawner: Spawner;
  private readonly onResize = () => this.resize();
  private aspects = new Map<number, number>();
  private videoTimer = 0;
  /** The hovered video, once the mouse has stayed on it a moment: it plays the real video. */
  private hoverPlays: Drifter | null = null;
  // The title stays a little longer at the start.
  private lastMove = performance.now() + 3000;
  private stats = { frames: 0, maxCards: 0, ms: 0 };
  /** The card held by the mouse, where on it it was taken, and whether it has been moved yet. */
  private grab: { d: Drifter; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null = null;
  private readonly momentum = new Momentum();
  // Video players: a pool of its own (the grid's rests while the river is open), every one ever made
  // (to let go of them all at the end), and the ones fading out.
  private readonly made = new Set<HTMLVideoElement>();
  private readonly players = new PlayerPool<HTMLVideoElement>(() => {
    const v = makePlayer();
    this.made.add(v);
    return v;
  });
  private leaving = new Set<HTMLVideoElement>();
  /** Takes off a player's listeners for the card it was started for. */
  private offs = new WeakMap<HTMLVideoElement, () => void>();
  private flips = new Set<HTMLDivElement>();
  private flipFrame = -1;
  private sinceReplan = 0;
  private windowResting = isWindowResting();
  private readonly offWindow: () => void;
  // How many cards may play the real video (grows while the PC keeps up, as in the grid).
  private readonly budget = new Budget(2);
  private realBudget = 2;
  private watch = { start: performance.now(), frames: 0, slow: 0, sum: 0 };
  private quality = new WeakMap<HTMLVideoElement, { total: number; dropped: number }>();

  constructor(
    private readonly root: HTMLElement,
    private readonly stage: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private items: RiverItem[],
    private readonly src: Sources,
    private readonly ev: EngineEvents,
    reduced: boolean,
    opts: RiverOptions = {},
  ) {
    setLayerCount(opts.layers ?? 5);
    setDensity(opts.density ?? 1);
    this.pool = LAYERS.map(() => []);
    this.flow = this.target = Math.max(MIN_FLOW, Math.min(MAX_FLOW, opts.flow ?? 1));
    this.view = { w: root.clientWidth || 1280, h: root.clientHeight || 720, reduced };
    this.deck = new Deck(items.length);
    const showing = () => new Set(this.drifters.map((d) => d.item));
    this.spawner = {
      rand: Math.random,
      pick: () => {
        const i = this.deck.next(showing());
        if (i < 0) return null;
        const it = this.items[i];
        if (it.face) return { item: i, aspect: 1 };
        return { item: i, aspect: this.aspects.get(it.id) ?? it.aspect ?? 4 / 3 };
      },
    };
    this.ctx = canvas.getContext('2d');
    this.mote = moteSprite();
    this.resize();
    this.drifters = fill(this.view, this.spawner);
    for (const d of this.drifters) this.attach(d);
    this.plan();
    window.addEventListener('resize', this.onResize);
    this.offWindow = onWindowResting((r) => {
      this.windowResting = r;
      this.rest();
    });
    // The UI tests look in (development only).
    if (import.meta.env.DEV) (window as unknown as { __river?: unknown }).__river = this;
  }

  // ---- outside controls ----------------------------------------------------------------------

  start() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** The viewer is open on top: hold still, let go of the mouse. */
  setCovered(on: boolean) {
    this.covered = on;
    if (on) {
      this.stop();
      this.mouse = null;
      this.setHover(null);
    } else this.start();
    this.rest();
  }

  /** Players pause while nobody can see them (viewer on top, window hidden or minimised). */
  private rest() {
    const r = this.covered || this.windowResting;
    if (r === this.players.isPaused) return;
    if (r) this.players.pauseAll();
    else this.players.resumeAll();
  }

  /** Other things to drift (pictures or faces, other people): the river starts over with them. */
  setItems(items: RiverItem[]) {
    if (items === this.items) return;
    this.grab = null;
    this.root.classList.remove('rv-holding');
    this.setHover(null);
    for (const d of this.drifters) this.detach(d);
    this.items = items;
    this.deck = new Deck(items.length);
    this.drifters = fill(this.view, this.spawner);
    for (const d of this.drifters) {
      d.shown = 0;
      this.attach(d);
    }
    this.plan();
  }

  togglePause() {
    this.paused = !this.paused;
    this.ev.onFlow(this.paused ? 'Paused' : `Current ${flowText(this.target)}`, this.target);
  }

  faster(dir: 1 | -1) {
    this.target = stepFlow(this.target, dir);
    if (this.paused) this.paused = false;
    this.ev.onFlow(`Current ${flowText(this.target)}`, this.target);
  }

  wheel(deltaY: number) {
    this.target = wheelFlow(this.target, deltaY);
    if (this.paused) this.paused = false;
    this.ev.onFlow(`Current ${flowText(this.target)}`, this.target);
  }

  /** The speed slider. */
  setFlow(flow: number) {
    this.target = Math.max(MIN_FLOW, Math.min(MAX_FLOW, flow));
    if (this.paused) this.paused = false;
  }

  /** The flow amount slider (new cards come closer together or further apart). */
  setDensity(d: number) {
    setDensity(d);
  }

  /** The layers slider: the river starts over with this many depths (frozen cards are let go). */
  setLayers(n: number) {
    if (Math.round(n) === LAYERS.length) return;
    this.grab = null;
    for (const d of this.drifters) this.detach(d);
    this.drifters = [];
    this.setHover(null);
    setLayerCount(n);
    this.pool = LAYERS.map(() => []);
    this.drifters = fill(this.view, this.spawner);
    for (const d of this.drifters) {
      d.shown = 0;
      this.attach(d);
    }
    this.plan();
  }

  pointer(x: number | null, y = 0) {
    this.mouse = x == null || this.covered ? null : { x, y };
    this.lastMove = performance.now();
    const g = this.grab;
    if (g && x != null) {
      if (!g.moved && Math.hypot(x - g.sx, y - g.sy) > 5) g.moved = true;
      g.d.x = x + g.dx;
      g.d.y = y + g.dy;
      this.momentum.add(x, y, performance.now());
    }
  }

  /** The card under a point (index into the items), if any. */
  itemAt(x: number, y: number): number | null {
    const d = hitTest(this.drifters, x, y, this.t, this.view, this.hovered?.key ?? null);
    return d ? d.item : null;
  }

  /** Left button down: take the card under the mouse (true if there was one). */
  press(x: number, y: number): boolean {
    const d = hitTest(this.drifters, x, y, this.t, this.view, this.hovered?.key ?? null);
    if (!d) return false;
    d.held = true;
    d.frozen = false;
    d.vx = 0;
    d.vy = 0;
    this.grab = { d, dx: d.x - x, dy: d.y - y, sx: x, sy: y, moved: false };
    this.momentum.clear();
    this.momentum.add(x, y, performance.now());
    this.setHover(d);
    const c = this.cards.get(d.key);
    if (c) {
      c.el.classList.remove('rv-frozen');
      c.el.style.zIndex = '210';
    }
    this.root.classList.add('rv-holding');
    return true;
  }

  /** Left button up: a card that wasn't moved opens; a moved one flies on with the mouse's speed. */
  release() {
    const g = this.grab;
    if (!g) return;
    this.grab = null;
    this.root.classList.remove('rv-holding');
    g.d.held = false;
    if (!g.moved) {
      this.ev.onOpen(g.d.item);
      return;
    }
    const v = this.momentum.velocity(performance.now());
    g.d.vx = v.x;
    g.d.vy = v.y;
  }

  /** Right-click while holding: the card stays right there. */
  freeze(): boolean {
    const g = this.grab;
    if (!g) return false;
    this.grab = null;
    this.root.classList.remove('rv-holding');
    g.d.held = false;
    g.d.frozen = true;
    g.d.vx = 0;
    g.d.vy = 0;
    // Frozen pictures come to the front: front-row size, front-row look, around the same middle.
    const d = g.d;
    const c = this.cards.get(d.key);
    if (d.layer !== NEAREST) {
      const s = cardSize(NEAREST, d.w / d.h, this.view);
      d.layer = NEAREST;
      d.w = s.w;
      d.h = s.h;
      if (c) {
        this.lookFor(c, NEAREST, this.items[d.item]);
        c.el.classList.add('rv-grow');
        c.el.style.width = `${d.w.toFixed(1)}px`;
        c.el.style.height = `${d.h.toFixed(1)}px`;
        window.setTimeout(() => c.el.classList.remove('rv-grow'), 450);
      }
    }
    if (c) {
      c.el.classList.add('rv-frozen');
      c.el.classList.toggle('rv-lifted', this.hovered === d);
      c.el.style.zIndex = String(10 + NEAREST * 10 + 5);
    }
    this.ev.onFlow('Frozen here · grab it again to let it go', this.target);
    this.plan();
    return true;
  }

  get holding() {
    return !!this.grab;
  }

  /** For the UI tests. */
  info() {
    const shows: Record<string, number> = {};
    for (const d of this.drifters) {
      const c = this.cards.get(d.key);
      if (c && isVideo(this.items[d.item])) shows[c.want] = (shows[c.want] ?? 0) + 1;
    }
    return {
      cards: this.drifters.length, elements: this.stage.childElementCount, pool: this.pool.reduce((s, p) => s + p.length, 0), flow: this.flow, ...this.stats,
      msPerFrame: this.stats.ms / Math.max(1, this.stats.frames), hovered: this.hovered ? this.items[this.hovered.item].name : null,
      faces: this.items.filter((i) => i.face).length, shows,
      players: { ...this.players.stats, made: this.made.size, leaving: this.leaving.size, paused: this.players.isPaused, realBudget: this.realBudget },
    };
  }

  /** Jump ahead (UI tests: many minutes of drifting in a moment). */
  fastForward(seconds: number) {
    for (let s = 0; s < seconds * 20; s++) this.advance(0.05);
  }

  destroy() {
    this.stop();
    window.clearTimeout(this.videoTimer);
    window.removeEventListener('resize', this.onResize);
    this.offWindow();
    for (const c of this.cards.values()) this.stopVideo(c);
    for (const v of this.leaving) this.players.release(v);
    this.leaving.clear();
    // Nothing kept loaded once the river is gone.
    for (const v of this.made) {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
    }
    this.made.clear();
    this.flips.clear();
    this.stage.replaceChildren();
    this.cards.clear();
    this.pool = LAYERS.map(() => []);
    const w = window as unknown as { __river?: unknown };
    if (w.__river === this) delete w.__river;
  }

  // ---- the loop ------------------------------------------------------------------------------

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const t0 = performance.now();
    this.advance(dt);
    this.draw(now);
    this.watchSmoothness(now, dt);
    this.stats.ms += performance.now() - t0;
  };

  private advance(dt: number) {
    this.t += dt;
    this.dt = dt;
    const goal = this.paused ? 0 : this.target;
    this.flow += (goal - this.flow) * (1 - Math.exp(-dt * (this.paused ? 3 : 2)));
    const hit = this.grab ? this.grab.d : this.mouse ? hitTest(this.drifters, this.mouse.x, this.mouse.y, this.t, this.view, this.hovered?.key ?? null) : null;
    if (hit !== this.hovered) this.setHover(hit);
    const { gone, added } = step(this.drifters, dt, this.flow, this.view, this.spawner, this.hovered?.key ?? null);
    for (const d of gone) this.detach(d);
    for (const d of added) this.attach(d);
    if (this.hovered && gone.includes(this.hovered)) this.setHover(null);
    if (this.grab && gone.includes(this.grab.d)) this.grab = null;
    this.stats.maxCards = Math.max(this.stats.maxCards, this.drifters.length);
    this.sinceReplan += dt;
    if (this.sinceReplan >= PLAN_EVERY) this.plan();
  }

  private draw(now: number) {
    this.stats.frames++;
    const v = this.view;
    for (const d of this.drifters) {
      const c = this.cards.get(d.key);
      if (!c) continue;
      const p = placed(d, this.t, v);
      c.el.style.transform = `translate3d(${(p.x - p.w / 2).toFixed(1)}px, ${(p.y - p.h / 2).toFixed(1)}px, 0) rotate(${p.rot.toFixed(2)}deg) scale(${p.scale.toFixed(3)})`;
      const L = LAYERS[d.layer];
      if (!L) continue;
      const op = (L.opacity + (1 - L.opacity) * d.lift) * d.shown;
      if (Math.abs(op - c.shownOpacity) > 0.004) {
        c.el.style.opacity = op.toFixed(3);
        c.shownOpacity = op;
      }
      if (Math.abs(d.lift - c.lift) > 0.004) {
        c.lift = d.lift;
        const l = d.lift < 0.01 ? '0' : d.lift.toFixed(3);
        c.glow.style.opacity = l;
        c.name.style.opacity = l;
      }
    }
    // Flip-books: one shared frame for all, changed only when it moves on.
    if (this.flips.size) {
      const f = Math.floor(now / (1000 / CLIP_FPS)) % FRAMES;
      if (f !== this.flipFrame) {
        this.flipFrame = f;
        const pos = framePosition(f);
        for (const el of this.flips) el.style.backgroundPosition = pos;
      }
    }
    // The mouse rests: hide the pointer, as in the viewer.
    this.root.classList.toggle('rv-idle', now - this.lastMove > IDLE_MS && !this.hovered && !this.grab);
    this.drawMotes();
  }

  // ---- cards ---------------------------------------------------------------------------------

  private attach(d: Drifter) {
    const c = this.pool[d.layer].pop() ?? this.makeCard(d.layer);
    const it = this.items[d.item];
    c.key = d.key;
    c.el.style.width = `${d.w.toFixed(1)}px`;
    c.el.style.height = `${d.h.toFixed(1)}px`;
    c.el.style.opacity = '0';
    c.el.style.zIndex = String(10 + d.layer * 10);
    this.lookFor(c, d.layer, it);
    c.shownOpacity = 0;
    c.lift = -1;
    c.full = false;
    c.want = 'thumb';
    // Shown once its picture is in (no empty boxes while loading).
    c.el.classList.add('rv-wait');
    c.name.textContent = it.face ? it.name : it.name.replace(/\.[^.]+$/, '');
    // A reused card may have held a face cut-out: the picture fills the card again.
    c.img.removeAttribute('style');
    // Thumbnails mostly; GIFs move when near; the nearest pictures get the full picture when the thumbnail would be soft.
    const near = d.layer >= NEAREST - 1;
    const wantFull = it.face ? null : it.kind === 'gif' ? near : it.kind === 'image' && (!it.thumb || (d.layer === NEAREST && d.h * this.dpr > 600));
    let loaded = false;
    c.img.onload = () => {
      if (c.key !== d.key || loaded) return;
      loaded = true;
      c.el.classList.remove('rv-wait');
      if (it.face) {
        this.cutFace(c, it);
        // A small face in the thumbnail would be soft up close: the whole picture then.
        if (near && !c.full && it.face.h * c.img.naturalHeight < d.h * 0.5 * this.dpr * 0.8) this.upgrade(c, d.key, it);
        return;
      }
      this.learnShape(d, c, it);
      if (wantFull && it.thumb && !c.full) this.upgrade(c, d.key, it);
    };
    c.img.onerror = it.thumb && it.kind !== 'video' ? () => {
      if (c.key === d.key && !c.full) this.upgrade(c, d.key, it);
    } : null;
    const pic = picOf(it);
    c.img.src = it.thumb ? this.src.thumb(pic) : this.src.full(pic);
    if (!it.thumb) c.full = true;
    // Already there (the same picture again): no load event may come.
    if (c.img.complete && c.img.naturalWidth) c.img.onload?.(new Event('load'));
    this.stage.appendChild(c.el);
    this.cards.set(d.key, c);
  }

  /** Faces river: the picture placed so the face sits in the middle of the round bubble. */
  private cutFace(c: Card, it: RiverItem) {
    const nw = c.img.naturalWidth;
    const nh = c.img.naturalHeight;
    if (!it.face || !nw || !nh) return;
    const f = coverFit(nw / nh, it.face, true);
    const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
    const st = c.img.style;
    st.position = 'absolute';
    st.maxWidth = 'none';
    st.width = pct(f.w);
    st.height = pct(f.h);
    st.left = pct(f.left);
    st.top = pct(f.top);
  }

  /** The real shape from the thumbnail (the stored size may be unknown or turned). */
  private learnShape(d: Drifter, c: Card, it: RiverItem) {
    const nw = c.img.naturalWidth;
    const nh = c.img.naturalHeight;
    if (!nw || !nh) return;
    const a = nw / nh;
    this.aspects.set(it.id, a);
    const now = d.w / d.h;
    if (Math.abs(a - now) / now < 0.04) return;
    const h = d.h;
    d.w = h * Math.max(0.6, Math.min(1.8, a));
    c.el.style.width = `${d.w.toFixed(1)}px`;
    if (c.flip && c.flip.style.display !== 'none') this.sizeFlip(c, d, it);
  }

  private upgrade(c: Card, key: number, it: RiverItem) {
    const full = new Image();
    full.decoding = 'async';
    full.src = this.src.full(picOf(it));
    const swap = () => {
      if (c.key !== key) return;
      c.img.onload = null;
      c.img.onerror = null;
      c.img.src = full.src;
      c.full = true;
      c.el.classList.remove('rv-wait');
      // The whole picture has the thumbnail's shape, so a face cut-out stays where it was.
    };
    full.decode().then(swap, () => {
      /* stays a thumbnail */
    });
  }

  /** Depth: further away is dimmer, softer and a little cooler (pointing at it clears it). */
  private lookFor(c: Card, layer: number, it: RiverItem | undefined) {
    const L = LAYERS[layer];
    const n = LAYERS.length;
    // The style sheet knows five depth bands (reflections, shadows): far … near.
    const band = n <= 1 ? 4 : Math.round(4 - (4 * (n - 1 - layer)) / Math.max(4, n - 1));
    c.el.className = `rv-item rv-l${Math.max(0, Math.min(4, band))}${isVideo(it) ? ' rv-video' : ''}${it?.face ? ' rv-face' : ''}`;
    c.card.style.filter = L.blur > 0 || L.bright < 1 ? `blur(${L.blur}px) brightness(${L.bright}) saturate(${(0.6 + 0.4 * L.bright).toFixed(2)})` : '';
    c.card.style.borderRadius = it?.face ? '50%' : `${Math.round(4 + (L.size / 0.31) * 8)}px`;
  }

  private makeCard(layer: number): Card {
    const el = document.createElement('div');
    el.className = `rv-item rv-l${layer}`;
    const glow = document.createElement('div');
    glow.className = 'rv-glow';
    const card = document.createElement('div');
    card.className = 'rv-card';
    const img = document.createElement('img');
    img.className = 'rv-img';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    card.appendChild(img);
    const name = document.createElement('div');
    name.className = 'rv-name';
    el.append(glow, card, name);
    return { el, card, img, glow, name, layer, key: 0, shownOpacity: 0, lift: 0, full: false, want: 'thumb', flip: null, player: null, next: null };
  }

  private detach(d: Drifter) {
    const c = this.cards.get(d.key);
    if (!c) return;
    this.cards.delete(d.key);
    // Its players go back to the pool for the next cards.
    this.stopVideo(c);
    this.setFlip(c, d, null);
    c.want = 'thumb';
    c.img.onload = null;
    c.img.onerror = null;
    c.el.classList.remove('rv-lifted', 'rv-frozen');
    c.el.remove();
    c.key = 0;
    // A few spare cards per layer are plenty.
    if (this.pool[c.layer] && this.pool[c.layer].length < 6) this.pool[c.layer].push(c);
    else c.img.removeAttribute('src');
  }

  private setHover(d: Drifter | null) {
    const before = this.hovered && this.cards.get(this.hovered.key);
    if (before) {
      before.el.classList.remove('rv-lifted');
      before.el.style.zIndex = String(10 + before.layer * 10 + (this.hovered?.frozen ? 5 : 0));
    }
    window.clearTimeout(this.videoTimer);
    this.hoverPlays = null;
    const had = this.hovered;
    this.hovered = d;
    this.root.classList.toggle('rv-pointing', !!d);
    // A video left behind goes back to what its depth plays (at once: frees its real player).
    if (had && isVideo(this.items[had.item])) this.plan();
    if (!d) return;
    const c = this.cards.get(d.key);
    if (!c) return;
    c.el.classList.add('rv-lifted');
    c.el.style.zIndex = d.held ? '210' : '200';
    const it = this.items[d.item];
    // A video plays the real thing once the mouse stays a moment (passing over doesn't start players).
    if (isVideo(it)) {
      this.videoTimer = window.setTimeout(() => {
        this.hoverPlays = d;
        this.plan();
      }, d.held ? 0 : 220);
    }
    else if (!c.full) this.upgrade(c, d.key, it);
  }

  // ---- videos ------------------------------------------------------------------------------

  /** Which video card plays what (riverplay.ts), and each card brought in line. */
  private plan() {
    this.sinceReplan = 0;
    const v = this.view;
    const wants: RiverCardWant[] = [];
    for (const d of this.drifters) {
      const it = this.items[d.item];
      if (!isVideo(it)) continue;
      wants.push({
        key: d.key, kind: 'video', layer: d.layer, hasTiny: !!it.tiny, hasStrip: it.preview,
        // Hovered counts once the mouse has stayed (the timer in setHover), or while it is held.
        hovered: !!d.held || d === this.hoverPlays,
        frozen: !!d.frozen, onScreen: d.x + d.w / 2 > 0 && d.x - d.w / 2 < v.w, away: Math.hypot(d.x - v.w / 2, d.y - v.h / 2),
      });
    }
    if (!wants.length) return;
    const plan = riverPreviews(wants, NEAREST, this.realBudget);
    for (const d of this.drifters) {
      const c = this.cards.get(d.key);
      const want = plan.get(d.key);
      if (c && want) this.show(c, d, this.items[d.item], want);
    }
  }

  private show(c: Card, d: Drifter, it: RiverItem, want: Layer) {
    if (c.want === want) return;
    c.want = want;
    // The flip-book plays far away, and stands in under a player until its first picture is drawn.
    this.setFlip(c, d, want !== 'thumb' && it.preview ? it : null);
    if (want === 'tiny' || want === 'real') {
      const src = want === 'real' ? this.src.full(it.id) : this.src.tiny(it.id);
      if (c.next?.dataset.role === want) return;
      if (c.next) {
        this.letGo(c.next);
        c.next = null;
      }
      if (c.player?.dataset.role === want) return;
      this.startPlayer(c, d.key, it, want, src);
    } else this.stopVideo(c);
  }

  private startPlayer(c: Card, key: number, it: RiverItem, role: 'tiny' | 'real', src: string) {
    const v = this.players.acquire(src);
    this.leaving.delete(v);
    v.dataset.role = role;
    v.dataset.layer = role;
    v.className = 'rv-clip';
    const warm = v.src === src && v.readyState >= 1;
    if (!warm) v.src = src;
    // The real video carries on from the moment the tiny clip or flip-book shows.
    const dur = (it.durationMs ?? 0) / 1000;
    const from = role !== 'real' || !dur ? 0
      : c.player?.dataset.role === 'tiny' && Number.isFinite(c.player.currentTime) ? tinyToSource(c.player.currentTime + 0.35, dur)
      : c.flip && c.flip.style.display !== 'none' ? frameTimes(dur)[Math.max(0, this.flipFrame)] ?? 0 : 0;
    const seek = () => {
      if (c.next !== v || from < 0.05 || !Number.isFinite(v.duration)) return;
      try {
        v.currentTime = Math.min(from, Math.max(0, v.duration - 0.2));
      } catch {
        // not seekable yet
      }
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener('loadedmetadata', seek, { once: true });
    c.next = v;
    c.card.appendChild(v);
    // Shown once its first picture is drawn (no black flash), then the one under it goes.
    // Frame callbacks can go missing (a seek near the end of a looping video): time moving on counts too.
    const onTime = () => {
      if (v.readyState >= 2 && !v.paused) ready();
    };
    const off = () => {
      v.removeEventListener('loadedmetadata', seek);
      v.removeEventListener('timeupdate', onTime);
      this.offs.delete(v);
    };
    this.offs.set(v, off);
    v.addEventListener('timeupdate', onTime);
    const ready = () => {
      if (c.key !== key || c.next !== v) return;
      off();
      c.next = null;
      v.classList.add('on');
      const old = c.player;
      c.player = v;
      if (old) this.fadeOut(old);
    };
    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(() => ready());
    else v.addEventListener('playing', () => requestAnimationFrame(() => requestAnimationFrame(ready)), { once: true });
    this.players.play(v);
  }

  /** A replaced player stays a moment under the new one, then goes back to the pool. */
  private fadeOut(v: HTMLVideoElement) {
    this.leaving.add(v);
    window.setTimeout(() => {
      if (!this.leaving.delete(v)) return;
      this.letGo(v);
    }, FADE_MS);
  }

  private letGo(v: HTMLVideoElement) {
    this.offs.get(v)?.();
    this.leaving.delete(v);
    v.classList.remove('on');
    delete v.dataset.role;
    this.players.release(v);
  }

  /** The card's players back to the pool (the card leaves, or goes back to its picture or flip-book). */
  private stopVideo(c: Card) {
    if (c.next) this.letGo(c.next);
    if (c.player) this.letGo(c.player);
    // One still fading out in this card goes now too (the card may be reused at once).
    c.card.querySelectorAll('video').forEach((v) => {
      if (this.leaving.has(v)) this.letGo(v);
    });
    c.next = null;
    c.player = null;
  }

  private setFlip(c: Card, d: Drifter, it: RiverItem | null) {
    if (!it) {
      if (c.flip && this.flips.delete(c.flip)) {
        c.flip.style.display = 'none';
        c.flip.style.backgroundImage = '';
      }
      return;
    }
    if (!c.flip) {
      c.flip = document.createElement('div');
      c.flip.className = 'rv-flip';
      c.card.insertBefore(c.flip, c.img.nextSibling);
    }
    if (this.flips.has(c.flip)) return;
    c.flip.style.backgroundImage = `url("${this.src.preview(it.id)}")`;
    c.flip.style.backgroundPosition = framePosition(Math.max(0, this.flipFrame));
    c.flip.style.display = '';
    this.sizeFlip(c, d, it);
    this.flips.add(c.flip);
  }

  /** The flip-book covers the card as the video would (its frames have the video's shape). */
  private sizeFlip(c: Card, d: Drifter, it: RiverItem) {
    if (!c.flip) return;
    const a = this.aspects.get(it.id) ?? it.aspect ?? d.w / d.h;
    const ca = d.w / d.h;
    // In parts of the card, so it follows the card's size (freezing, resizing) by itself.
    const w = Math.max(1, a / ca);
    const h = w * (ca / a);
    const st = c.flip.style;
    st.width = `${(w * 100).toFixed(2)}%`;
    st.height = `${(h * 100).toFixed(2)}%`;
    st.left = `${((1 - w) * 50).toFixed(2)}%`;
    st.top = `${((1 - h) * 50).toFixed(2)}%`;
  }

  /** Every couple of seconds: did the real videos and the river keep up? (previewplan.ts Budget, as in the grid.) */
  private watchSmoothness(now: number, dt: number) {
    const w = this.watch;
    const ms = dt * 1000;
    if (ms < 1000) {
      w.frames++;
      w.sum += ms;
      if (ms > 50) w.slow++;
    }
    if (now - w.start < BUDGET_EVERY) return;
    let total = 0;
    let dropped = 0;
    let real = 0;
    let wanted = 0;
    for (const c of this.cards.values()) {
      if (c.want === 'tiny' || c.want === 'real') wanted++;
      if (c.want === 'real') real++;
    }
    for (const v of this.players.inUse()) {
      if (v.dataset.role !== 'real') continue;
      const q = v.getVideoPlaybackQuality?.();
      if (!q) continue;
      const prev = this.quality.get(v);
      // A reused player starts counting afresh.
      if (prev && q.totalVideoFrames >= prev.total) {
        total += q.totalVideoFrames - prev.total;
        dropped += Math.max(0, q.droppedVideoFrames - prev.dropped);
      }
      this.quality.set(v, { total: q.totalVideoFrames, dropped: q.droppedVideoFrames });
    }
    if (w.frames > 10 && !this.players.isPaused) {
      const b = this.budget.look({ real, wanted, frames: total, dropped, slowShare: w.slow / w.frames, avgFrameMs: w.sum / w.frames }, now);
      if (b !== this.realBudget) {
        this.realBudget = b;
        this.plan();
      }
    }
    this.watch = { start: now, frames: 0, slow: 0, sum: 0 };
  }

  // ---- motes ---------------------------------------------------------------------------------

  private resize() {
    const w = this.root.clientWidth || 1280;
    const h = this.root.clientHeight || 720;
    const sx = w / this.view.w;
    const sy = h / this.view.h;
    const su = unit({ ...this.view, w, h }) / unit(this.view);
    if (this.drifters.length && (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001 || Math.abs(su - 1) > 0.001)) {
      // Keep each card where it was, relative to the screen; sizes follow the new height.
      for (const d of this.drifters) {
        d.x *= sx;
        d.y *= sy;
        d.w *= su;
        d.h *= su;
        const c = this.cards.get(d.key);
        if (c) {
          c.el.style.width = `${d.w.toFixed(1)}px`;
          c.el.style.height = `${d.h.toFixed(1)}px`;
        }
      }
    }
    this.view.w = w;
    this.view.h = h;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.moteScale);
    this.canvas.height = Math.round(h * this.moteScale);
    const want = Math.round(Math.min(90, (w * h) / 22000));
    while (this.motes.length < want) this.motes.push(this.newMote(true));
    this.motes.length = want;
  }

  private newMote(anywhere: boolean) {
    const z = Math.random();
    return {
      x: anywhere ? Math.random() * this.view.w : -10,
      y: this.view.h * (0.08 + Math.random() * 0.86),
      r: 1 + z * z * 3.2,
      z,
      a: 0.18 + Math.random() * 0.5,
      p: Math.random() * Math.PI * 2,
    };
  }

  private drawMotes() {
    const g = this.ctx;
    if (!g) return;
    const s = this.moteScale;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const dt = this.view.reduced ? this.dt * 0.4 : this.dt;
    for (let i = 0; i < this.motes.length; i++) {
      const m = this.motes[i];
      m.x += (6 + m.z * 26) * (this.view.h / 1080) * this.flow * dt;
      m.y += Math.sin(this.t * 0.3 + m.p) * 3.6 * dt;
      if (m.x > this.view.w + 10) this.motes[i] = this.newMote(false);
      const tw = this.view.reduced ? 0.8 : 0.55 + 0.45 * Math.sin(this.t * (0.6 + m.z) + m.p * 3);
      g.globalAlpha = m.a * tw;
      const r = m.r * 4 * s;
      g.drawImage(this.mote, m.x * s - r, m.y * s - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
  }
}

/** A video card (faces are always cut out of a still picture). */
const isVideo = (it: RiverItem | undefined) => !!it && it.kind === 'video' && !it.face;
/** The picture an item shows: its own, or for a face the picture it was found in. */
const picOf = (it: RiverItem) => it.face?.media ?? it.id;

/** A soft round light, drawn once. */
function moteSprite(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  if (g) {
    const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    r.addColorStop(0, 'rgba(220, 255, 248, 1)');
    r.addColorStop(0.18, 'rgba(160, 236, 226, 0.65)');
    r.addColorStop(0.5, 'rgba(46, 196, 182, 0.14)');
    r.addColorStop(1, 'rgba(46, 196, 182, 0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 32, 32);
  }
  return c;
}

/** A small tile of film grain, made once (a data address, nothing stored). */
export function grainTile(): string {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    if (!g) return '';
    const d = g.createImageData(128, 128);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = Math.random() * 255;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      d.data[i + 3] = 255;
    }
    g.putImageData(d, 0, 0);
    return c.toDataURL('image/png');
  } catch {
    return '';
  }
}
