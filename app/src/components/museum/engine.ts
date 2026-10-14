// The museum's 3D scene: builds the halls from a WingLayout, streams the
// pictures in (thumbnails first, the full picture up close, muted videos for
// the nearest few), and walks the visitor around.
//
// Nothing here writes to disk: pictures come from the vault's in-memory
// URLs (or the browser preview's generated ones) and live only as GPU textures.
//
// Kept light for ordinary laptops: static geometry is merged per hall and
// material, only the hall you're in and its neighbours are drawn, two real
// lights at most (the rest of the glow is painted on), textures are capped and
// uploaded a couple per frame, and the resolution drops a little when frames
// run long.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import {
  box, chandelier, column, corniceProfile, flat, frameProfile, lathe, merge, norm, pilaster, quad, rope, stanchion, sweepRect, type Geo,
} from './builders';
import {
  collide, fillDistance, hallAt, nearestHall, route, standSpot, tourOrder, WALL_T, yawOf, type Door, type Frame, type Hall, type Vec2, type WingLayout,
} from './layout';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as tex from './textures';

export type Quality = 'high' | 'fast';

export interface Sources {
  thumb: (id: number) => string;
  full: (id: number) => string;
}

export interface Pose {
  x: number;
  y: number;
  yaw: number;
  pitch: number;
}

export type Aim = { kind: 'frame'; frame: Frame } | { kind: 'door'; door: Door } | null;

export interface EngineEvents {
  onAim: (a: Aim) => void;
  /** Open this picture in the full viewer. */
  onOpen: (f: Frame) => void;
  onDoor: (d: Door) => void;
  /** A close look began on a picture, moved on to another, or ended (null). */
  onCloseLook?: (f: Frame | null) => void;
  /** Text for wing doors and plaques. */
  doorText: (d: Door) => [string, string];
  plaqueText: (f: Frame) => [string, string];
}

const EYE = 1.62;
const RADIUS = 0.32;
const LOOK = 0.0022;
const FOV = 66;
/** Walking and hurrying (Shift), metres per second. */
export const WALK = 4.2;
export const RUN = 10.5;

type Bucket =
  | 'lamp' | 'floor' | 'damask' | 'wood' | 'goldRail' | 'skirt' | 'marble' | 'frameGold' | 'gold' | 'carpet' | 'ceiling' | 'velvet' | 'pool' | 'shade'
  | 'plaque' | 'door' | 'fresco' | 'glow';

/** What shows in the polished floor (the rest is skipped by the reflection pass). */
const REFLECTED = new Set<Bucket>(['damask', 'wood', 'skirt', 'marble', 'frameGold', 'gold', 'ceiling', 'fresco', 'lamp', 'goldRail']);
const LAYER_REFLECT = 1;
/** Parts that share a material with another (one draw call less per hall). */
const SAME: Partial<Record<Bucket, Bucket>> = { goldRail: 'frameGold', plaque: 'gold' };

interface Slot {
  frame: Frame;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  thumb: THREE.Texture | null;
  full: THREE.Texture | null;
  video: HTMLVideoElement | null;
  videoTex: THREE.VideoTexture | null;
  loadingThumb: boolean;
  loadingFull: boolean;
  dist: number;
  plaque: THREE.Mesh | null;
  plaqueAt: THREE.Vector3;
  right: THREE.Vector3;
  normal: THREE.Vector3;
  /** Bumped on every dispose so late loads are dropped. */
  gen: number;
  /** An animated GIF playing on the full texture. */
  anim: { stop: () => void } | null;
  group: THREE.Group;
}

interface Glide {
  curve: THREE.CatmullRomCurve3;
  t: number;
  dur: number;
  yaw0: number;
  yaw1: number;
  pitch0: number;
  pitch1: number;
  eye0: number;
  eye1: number;
  /** Look where you're going (through doors) before turning to the picture. */
  follow: boolean;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAngle = (a: number, b: number, k: number) => a + wrap(b - a) * k;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('load failed'));
    img.src = url;
  });
}

/**
 * A picture made small enough for the GPU (in memory only). Prefers an
 * ImageBitmap, resized and flipped by the browser off the main thread.
 */
async function decodeFor(url: string, max: number): Promise<{ src: TexImageSource; w: number; h: number; bitmap: boolean }> {
  const img = await loadImage(url);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const k = Math.min(1, max / Math.max(w, h, 1));
  if (typeof createImageBitmap === 'function') {
    try {
      const bm = await createImageBitmap(img, {
        resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high', imageOrientation: 'flipY',
      });
      return { src: bm, w, h, bitmap: true };
    } catch {
      /* the canvas way below */
    }
  }
  if (k >= 1) return { src: img, w, h, bitmap: false };
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { src: c, w, h, bitmap: false };
}

/** Crops a texture to cover a w × h picture without stretching it. */
function cover(t: THREE.Texture, iw: number, ih: number, w: number, h: number) {
  const ia = iw / ih;
  const fa = w / h;
  let rx = 1;
  let ry = 1;
  if (ia > fa) rx = fa / ia;
  else ry = ia / fa;
  t.repeat.set(rx, ry);
  t.offset.set((1 - rx) / 2, (1 - ry) / 2);
}

/** The renderer's full pixel ratio (before the automatic lowering). */
const basePixelRatio = new WeakMap<THREE.WebGLRenderer, number>();

export class MuseumEngine {
  private canvas: HTMLCanvasElement;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer | null = null;
  private mirror: Reflector | null = null;
  private last = performance.now();
  private time = 0;
  private raf = 0;
  private disposed = false;
  private paused = false;
  private disposables: { dispose: () => void }[] = [];
  private mats = new Map<Bucket, THREE.Material>();
  private slots: Slot[] = [];
  private doorMeshes: { mesh: THREE.Object3D; door: Door }[] = [];
  /** Scene parts per set of halls; drawn when any of those halls is in view. */
  private groups = new Map<string, { obj: THREE.Group; halls: number[] }>();
  private hallVisible: boolean[] = [];
  private curHall = 0;
  private lights: { light: THREE.PointLight; at: number; want: number }[] = [];
  private chandeliers: { p: THREE.Vector3; hall: number }[] = [];
  private lods: { hall: number; x: number; y: number; hi: THREE.Object3D[]; lo: THREE.Object3D[] }[] = [];
  private sparkles: THREE.ShaderMaterial | null = null;
  private keys = new Set<string>();
  private vel = new THREE.Vector2();
  private pose: Pose;
  private eye = EYE;
  private glide: Glide | null = null;
  private close: { frame: Frame; entered: Frame; back: Pose } | null = null;
  /** The picture the last glide went to (Q / E carry on from there). */
  private at: Frame | null = null;
  private tour: Frame[];
  private aim: Aim = null;
  private aimTick = 0;
  private streamTick = 0;
  private lightTick = 0;
  private loads = 0;
  private uploads: (() => void)[] = [];
  private placeholder: THREE.Texture;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private pickList: THREE.Object3D[] = [];
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();
  private box = new THREE.Box3();
  private picTick = 0;
  private tmp = new THREE.Vector3();
  private doorFired = false;
  private resizeObs: ResizeObserver;
  private maxFull: number;
  private maxThumb: number;
  private anisotropy: number;
  /** Automatic resolution: a share of the full pixel ratio, lowered while frames run long. */
  private scale = 1;
  private perf = { acc: 0, n: 0, good: 0 };
  /** Frames rendered, for tests and the preview's fps readout. */
  frames = 0;

  /** One renderer per canvas, shared by the wings shown on it (shaders compile once). */
  static createRenderer(canvas: HTMLCanvasElement, quality: Quality): THREE.WebGLRenderer {
    const high = quality === 'high';
    // High quality smooths edges in the glow pass (multisampled target) instead.
    const r = new THREE.WebGLRenderer({ canvas, antialias: !high, powerPreference: 'high-performance', stencil: false });
    const pr = Math.min(window.devicePixelRatio || 1, high ? 1.25 : 1);
    basePixelRatio.set(r, pr);
    r.setPixelRatio(pr);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.9;
    r.info.autoReset = false;
    return r;
  }

  constructor(
    private renderer: THREE.WebGLRenderer,
    readonly layout: WingLayout,
    private quality: Quality,
    private sources: Sources,
    start: Pose,
    private events: EngineEvents,
  ) {
    this.pose = { ...start };
    this.canvas = renderer.domElement;
    this.tour = tourOrder(layout);
    const high = quality === 'high';
    this.anisotropy = Math.min(high ? 8 : 4, this.renderer.capabilities.getMaxAnisotropy());
    this.maxFull = high ? 2048 : 1280;
    this.maxThumb = high ? 512 : 384;
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    this.renderer.setPixelRatio(basePixelRatio.get(this.renderer) ?? this.renderer.getPixelRatio());
    this.renderer.setSize(w, h, false);
    // Near and far chosen for depth precision: nothing is closer than 10 cm.
    this.camera = new THREE.PerspectiveCamera(FOV, w / h, 0.1, 120);
    this.camera.rotation.order = 'YXZ';
    this.scene.background = new THREE.Color(0x0b0705);
    this.scene.fog = new THREE.Fog(0x140c08, 34, 100);

    // Reflections for gold, marble and crystal: a procedural room, no HDRI.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    pmrem.dispose();
    this.scene.environment = env;
    this.scene.environmentIntensity = high ? 0.34 : 0.42;
    this.disposables.push(env);

    this.placeholder = this.canvasTex(tex.placeholder(), false);
    this.build();

    if (high) {
      const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.32, 0.45, 1.0));
      this.composer.addPass(new OutputPass());
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.canvas);
    this.applyPose();
    this.cull();
    this.stream(true);
    this.updateLights(true);
    this.loop();
  }

  // ---- public ------------------------------------------------------------------------

  getPose(): Pose {
    // In a close look, coming back means standing where you were before it.
    return this.close ? { ...this.close.back } : { ...this.pose };
  }

  /** Where the camera is right now (also during a close look or a glide), for the map. */
  where(): Pose {
    return { ...this.pose };
  }

  /** Draw calls and triangles of the last frame, textures and geometries alive (for tuning). */
  stats() {
    const i = this.renderer.info;
    return {
      calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, geometries: i.memory.geometries,
      pixelRatio: +this.renderer.getPixelRatio().toFixed(2), halls: this.hallVisible.filter(Boolean).length,
    };
  }

  setPose(p: Pose) {
    this.pose = { ...p };
    this.eye = EYE;
    this.glide = null;
    this.close = null;
    this.vel.set(0, 0);
    this.applyPose();
    this.picTick = 0;
    this.cull();
    this.stream(true);
    this.updateLights(true);
  }

  setKey(code: string, down: boolean) {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  clearKeys() {
    this.keys.clear();
  }

  look(dx: number, dy: number) {
    if (this.close || this.glide) return;
    this.pose.yaw -= dx * LOOK;
    this.pose.pitch = Math.max(-1.2, Math.min(1.2, this.pose.pitch - dy * LOOK));
  }

  /** Stops drawing (the viewer is open on top) or carries on. */
  setPaused(p: boolean) {
    if (p === this.paused || this.disposed) return;
    this.paused = p;
    this.keys.clear();
    for (const s of this.slots) {
      if (!s.video) continue;
      if (p) s.video.pause();
      else s.video.play().catch(() => {});
    }
    if (p) cancelAnimationFrame(this.raf);
    else {
      this.last = performance.now();
      this.loop();
    }
  }

  /**
   * Click at the screen centre (mouse captured) or at a point (-1..1).
   * Walking: a picture gets a close look, a wing door opens. In a close look:
   * the picture itself opens in the viewer, anywhere else steps back.
   */
  click(ndc?: { x: number; y: number }) {
    const hit = this.pick(ndc ?? { x: 0, y: 0 }, this.close ? 6 : 12);
    if (this.close) {
      if (hit?.kind === 'frame' && hit.frame === this.close.frame) this.events.onOpen(hit.frame);
      else this.stepBack();
      return;
    }
    if (hit?.kind === 'frame') this.closeLook(hit.frame);
    else if (hit?.kind === 'door') this.events.onDoor(hit.door);
  }

  /** The picture being looked at closely, if any. */
  closeFrame(): Frame | null {
    return this.close?.frame ?? null;
  }

  /** Glides up to a picture until it fills the view. */
  closeLook(f: Frame, instant = false) {
    const back = this.close?.back ?? { ...this.pose };
    const entered = this.close?.entered ?? f;
    this.close = { frame: f, entered, back };
    this.at = f;
    this.keys.clear();
    this.vel.set(0, 0);
    // Nearly filling the view, and a little above the middle (the close look's bar sits below).
    const d = Math.max(0.9, fillDistance(f, FOV, this.camera.aspect, 0.8));
    const lift = 0.14 * d * Math.tan(((FOV / 2) * Math.PI) / 180);
    const target = { x: f.at.x + f.normal.x * d, y: f.at.y + f.normal.y * d, yaw: yawOf({ x: -f.normal.x, y: -f.normal.y }), pitch: 0, eye: f.z - lift };
    this.moveTo(target, instant);
    this.events.onCloseLook?.(f);
  }

  /** Back from a close look: where you stood, or in front of the picture you ended on. */
  stepBack(instant = false) {
    const c = this.close;
    if (!c) return;
    this.close = null;
    let target: Pose & { eye: number };
    if (c.frame === c.entered) target = { ...c.back, eye: EYE };
    else {
      const s = standSpot(this.layout, c.frame, FOV, this.camera.aspect);
      target = { x: s.x, y: s.y, yaw: s.yaw, pitch: Math.atan2(c.frame.z - EYE, s.dist) * 0.6, eye: EYE };
    }
    this.moveTo(target, instant);
    this.events.onCloseLook?.(null);
  }

  /** The next (1) or previous (-1) picture: a close look moves along, walking glides there. */
  step(dir: 1 | -1) {
    let f: Frame | undefined;
    if (this.close) f = this.tour[this.tour.indexOf(this.close.frame) + dir];
    else {
      const cur = this.currentFrame();
      f = cur.at ? this.tour[this.tour.indexOf(cur.at) + dir] : cur.near ?? undefined;
    }
    if (!f) return;
    if (this.close) this.closeLook(f);
    else this.walkTo(f);
  }

  /** Glides to a comfortable spot in front of a picture, facing it. */
  walkTo(f: Frame) {
    const s = standSpot(this.layout, f, FOV, this.camera.aspect);
    const p = collide(s, RADIUS, this.layout);
    this.at = f;
    this.moveTo({ x: p.x, y: p.y, yaw: s.yaw, pitch: Math.atan2(f.z - EYE, s.dist) * 0.6, eye: EYE });
  }

  /** Frees this wing's GPU resources (the renderer belongs to the caller). */
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    for (const s of this.slots) this.dropAll(s);
    this.uploads.length = 0;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !m.userData.shared) m.geometry.dispose();
    });
    for (const m of this.mats.values()) m.dispose();
    for (const d of this.disposables) d.dispose();
    this.composer?.dispose();
    this.mirror?.dispose();
    this.renderer.setRenderTarget(null);
  }

  // ---- materials -----------------------------------------------------------------------

  private canvasTex(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.Texture {
    const t = new THREE.CanvasTexture(c);
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = this.anisotropy;
    this.disposables.push(t);
    return t;
  }

  private materials() {
    const high = this.quality === 'high';
    const floor = this.canvasTex(tex.floorMarble(high ? 1024 : 512));
    const dam = tex.damask([92, 12, 22], high ? 512 : 256);
    const orn = tex.ornament();
    const ornT = this.canvasTex(orn);
    const white = this.canvasTex(tex.whiteMarble(high ? 512 : 256));
    const gold = { color: new THREE.Color('#e3b55e'), metalness: 1, roughness: 0.27, envMapIntensity: 1.6 };
    // Fast leaves out the bump and roughness maps (a few texture reads less per pixel).
    const bump = (c: HTMLCanvasElement, scale: number) => (high ? { bumpMap: this.canvasTex(c, true, false), bumpScale: scale } : {});
    const M = this.mats;
    M.set('floor', new THREE.MeshStandardMaterial({ map: floor, roughness: 0.6, ...(high ? { roughnessMap: this.canvasTex(tex.floorRough(), true, false) } : {}), metalness: 0, envMapIntensity: 0.6 }));
    M.set('damask', new THREE.MeshStandardMaterial({ map: this.canvasTex(dam.map), ...bump(dam.bump, 1.2), roughness: 0.62, envMapIntensity: 0.5 }));
    M.set('wood', new THREE.MeshStandardMaterial({ map: this.canvasTex(tex.wainscot()), roughness: 0.36, envMapIntensity: 0.7 }));
    M.set('frameGold', new THREE.MeshStandardMaterial({ ...gold, map: ornT, ...bump(orn, 3), roughness: 0.3 }));
    M.set('gold', new THREE.MeshStandardMaterial({ ...gold, roughness: 0.22 }));
    M.set('skirt', new THREE.MeshStandardMaterial({ map: this.canvasTex(tex.greenMarble()), roughness: 0.18, envMapIntensity: 1 }));
    M.set('marble', new THREE.MeshStandardMaterial({ map: white, roughness: 0.2, envMapIntensity: 0.8 }));
    M.set('carpet', new THREE.MeshStandardMaterial({ map: this.canvasTex(tex.carpet()), roughness: 0.95, envMapIntensity: 0.25 }));
    const cof = this.canvasTex(tex.coffer(high ? 512 : 256));
    M.set('ceiling', new THREE.MeshStandardMaterial({ map: cof, roughness: 0.6, emissive: new THREE.Color('#ffffff'), emissiveMap: cof, emissiveIntensity: high ? 0.06 : 0.1, envMapIntensity: 0.5 }));
    const fr = this.canvasTex(tex.fresco(), false);
    M.set('fresco', new THREE.MeshStandardMaterial({ map: fr, roughness: 0.8, emissive: new THREE.Color('#ffffff'), emissiveMap: fr, emissiveIntensity: 0.12 }));
    M.set('velvet', new THREE.MeshStandardMaterial({ color: new THREE.Color('#6e0712'), roughness: 0.8, envMapIntensity: 0.4 }));
    // Painted-on light: decals drawn after the solid parts, pulled towards the
    // camera in the depth buffer so they never flicker against the surface.
    const decal = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 };
    M.set('pool', new THREE.MeshBasicMaterial({ ...decal, map: this.canvasTex(tex.lightPool(), false), blending: THREE.AdditiveBlending, opacity: 0.32 }));
    M.set('glow', new THREE.MeshBasicMaterial({ ...decal, map: this.canvasTex(tex.glow(), false), blending: THREE.AdditiveBlending, opacity: high ? 0.16 : 0.24, fog: true }));
    M.set('shade', new THREE.MeshBasicMaterial({ ...decal, map: this.canvasTex(tex.fade(), false, false), color: 0x000000, opacity: 0.55 }));
    M.set('lamp', new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.4, 1.5), side: THREE.DoubleSide }));
    M.set('door', new THREE.MeshStandardMaterial({ map: this.canvasTex(tex.doorLeaf(), false), roughness: 0.4, envMapIntensity: 0.8 }));
  }

  // ---- building --------------------------------------------------------------------------

  /** The group drawn while any of these halls is in view. */
  private groupFor(halls: number | number[]): THREE.Group {
    const list = [...new Set(Array.isArray(halls) ? halls : [halls])].filter((h) => h >= 0 && h < this.layout.halls.length).sort((a, b) => a - b);
    if (!list.length) list.push(0);
    const key = list.join(',');
    let g = this.groups.get(key);
    if (!g) {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      this.scene.add(obj);
      g = { obj, halls: list };
      this.groups.set(key, g);
    }
    return g.obj;
  }

  private build() {
    this.materials();
    const L = this.layout;
    const buckets = new Map<string, { b: Bucket; halls: number[]; list: Geo[] }>();
    const put = (halls: number | number[], b0: Bucket, g: Geo) => {
      const b = SAME[b0] ?? b0;
      // Something seen from two halls (a doorway, the wall around it) goes into both: a
      // copy drawn twice now and then is cheaper than a draw call more for every hall.
      const hs = [...new Set((Array.isArray(halls) ? halls : [halls]).map((h) => Math.max(0, h)))];
      hs.forEach((h, i) => {
        const key = `${b}@${h}`;
        const e = buckets.get(key) ?? { b, halls: [h], list: [] };
        e.list.push(i ? g.clone() : g);
        buckets.set(key, e);
      });
    };
    const hallOf = (x: number, y: number) => hallAt(L, { x, y })?.index ?? nearestHall(L, { x, y })?.index ?? 0;

    // Floors, carpets, ceilings, cornices.
    for (const h of L.halls) this.buildHall(h, put);

    // Walls with panelling. Each wall is cut where the halls it faces change; a piece
    // facing two halls goes into both (drawn twice at most, but no extra draw calls).
    const doorNear = (p: { x: number; y: number }) => L.doors.some((d) => Math.hypot(d.at.x - p.x, d.at.y - p.y) < d.width / 2 + 0.05);
    for (const w of L.walls) {
      const dx = w.b.x - w.a.x;
      const dy = w.b.y - w.a.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const ux = dx / len;
      const uy = dy / len;
      // Close the corners, but stop just inside a wall met head-on (else its end shows
      // through). At a door the wall tucks into the marble surround: its end face
      // would otherwise lie exactly on the jamb's.
      const ea = doorNear(w.a) ? -0.06 : WALL_T / 2 - 0.02;
      const eb = doorNear(w.b) ? -0.06 : WALL_T / 2 - 0.02;
      const alongX = Math.abs(ux) > 0.5;
      const H = w.height;
      // The halls on either side, sampled every 20 cm.
      const facing = (t: number, side: 1 | -1) => {
        const nx = alongX ? 0 : side;
        const ny = alongX ? side : 0;
        return hallAt(L, { x: w.a.x + ux * t + nx * 0.5, y: w.a.y + uy * t + ny * 0.5 })?.index ?? -1;
      };
      const n = Math.max(1, Math.round(len / 0.2));
      const runs: { t0: number; t1: number; l: number; r: number }[] = [];
      for (let i = 0; i < n; i++) {
        const t = ((i + 0.5) * len) / n;
        const l = facing(t, 1);
        const r = facing(t, -1);
        const last = runs[runs.length - 1];
        if (last && last.l === l && last.r === r) last.t1 = ((i + 1) * len) / n;
        else runs.push({ t0: (i * len) / n, t1: ((i + 1) * len) / n, l, r });
      }
      runs.forEach((run, i) => {
        const hs = [run.l, run.r].filter((h) => h >= 0);
        if (!hs.length) hs.push(hallOf(w.a.x + ux * run.t0, w.a.y + uy * run.t0));
        // Pieces seen from two halls reach a little past their run (no gaps at the joins).
        const pad = hs.length > 1 ? 0.2 : 0;
        const t0 = i === 0 ? -ea : Math.max(-ea, run.t0 - pad);
        const t1 = i === runs.length - 1 ? len + eb : Math.min(len + eb, run.t1 + pad);
        if (t1 - t0 < 0.01) return;
        const cx = w.a.x + ux * (t0 + t1) / 2;
        const cy = w.a.y + uy * (t0 + t1) / 2;
        const L2 = t1 - t0;
        const seg = (b0: Bucket, y0: number, y1: number, th: number, uv: number) => {
          put(hs, b0, box(cx, (y0 + y1) / 2, cy, alongX ? L2 : th, y1 - y0, alongX ? th : L2, uv));
        };
        seg('damask', 1.1, H, WALL_T, 0.75);
        seg('wood', 0.16, 1.1, WALL_T + 0.05, 1.1);
        seg('skirt', 0, 0.2, WALL_T + 0.08, 1);
        seg('goldRail', 1.08, 1.16, WALL_T + 0.1, 0.3);
        seg('marble', H - 1.05, H - 0.55, WALL_T + 0.04, 1.5);
        seg('goldRail', H - 1.12, H - 1.04, WALL_T + 0.09, 0.3);
        // Soft contact shadows on the floor along the faces that look into a hall.
        for (const [hall, side] of [[run.l, 1], [run.r, -1]] as const) {
          if (hall < 0) continue;
          const nx = alongX ? 0 : side;
          const ny = alongX ? side : 0;
          const o = WALL_T / 2 + 0.04;
          const s0 = i === 0 ? -ea : run.t0;
          const s1 = i === runs.length - 1 ? len + eb : run.t1;
          const p0 = v3(w.a.x + ux * s0 + nx * o, 0.006, w.a.y + uy * s0 + ny * o);
          const p1 = v3(w.a.x + ux * s1 + nx * o, 0.006, w.a.y + uy * s1 + ny * o);
          put(hall, 'shade', this.strip(p0, p1, v3(nx, 0, ny), 0.55));
        }
      });
    }

    // Doors: marble surrounds, lintels, signs, closed doors to other wings.
    for (const d of L.doors) this.buildDoor(d, put);

    // Pictures.
    for (const f of L.frames) this.buildFrame(f, put);

    // Pilasters between groups of pictures (never between close neighbours).
    const groups = new Map<string, Frame[]>();
    for (const f of L.frames) {
      const k = `${f.hall}:${f.normal.x}:${f.normal.y}:${(f.normal.x ? f.at.x : f.at.y).toFixed(2)}`;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    const hallH = (i: number) => L.halls[i]?.height ?? 8;
    for (const list of groups.values()) {
      const along = (f: Frame) => (f.normal.x ? f.at.y : f.at.x);
      const sorted = [...list].sort((p, q) => along(p) - along(q));
      for (let i = 1; i < sorted.length; i++) {
        const p = sorted[i - 1];
        const q = sorted[i];
        const gap = along(q) - along(p) - (p.w / 2 + p.border + q.w / 2 + q.border);
        if (gap < 1.8) continue;
        const m = (along(p) + along(q)) / 2;
        const at = p.normal.x ? { x: p.at.x, y: m } : { x: m, y: p.at.y };
        if (L.doors.some((d) => Math.hypot(d.at.x - at.x, d.at.y - at.y) < d.width / 2 + 0.8)) continue;
        this.putPilaster(at, p.normal, hallH(p.hall), p.hall, put);
      }
    }
    // Pilasters in the corners of each hall.
    for (const h of L.halls) {
      const r = h.rect;
      const i = WALL_T / 2 + 0.32;
      for (const [x, y, nx, ny] of [
        [r.x0 + WALL_T / 2, r.y0 + i, 1, 0], [r.x0 + WALL_T / 2, r.y1 - i, 1, 0], [r.x1 - WALL_T / 2, r.y0 + i, -1, 0], [r.x1 - WALL_T / 2, r.y1 - i, -1, 0],
      ] as const) {
        if (L.doors.some((d) => Math.hypot(d.at.x - x, d.at.y - y) < d.width / 2 + 0.6)) continue;
        this.putPilaster({ x, y }, { x: nx, y: ny }, h.height, h.index, put);
      }
    }

    // Columns.
    const grandH = L.halls[0]?.height ?? 10;
    const col = column(grandH);
    for (const c of L.columns) {
      const h = hallOf(c.x, c.y);
      put(h, 'marble', col.marble.clone().translate(c.x, 0, c.y));
      put(h, 'gold', col.gold.clone().translate(c.x, 0, c.y));
      put(h, 'skirt', col.plinth.clone().translate(c.x, 0, c.y));
      put(h, 'shade', this.blobGeo(c.x, c.y, 1.4));
    }
    col.marble.dispose();
    col.gold.dispose();
    col.plinth.dispose();

    // Velvet ropes on brass posts (a post every couple of metres).
    const post = stanchion();
    for (const r of L.ropes) {
      const h = hallOf(r.a.x, r.a.y);
      const n = Math.max(2, Math.ceil(Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) / 2.4));
      const ends = Array.from({ length: n + 1 }, (_, i) => ({ x: r.a.x + ((r.b.x - r.a.x) * i) / n, y: r.a.y + ((r.b.y - r.a.y) * i) / n }));
      for (const e of ends) {
        put(h, 'gold', post.clone().translate(e.x, 0, e.y));
        put(h, 'shade', this.blobGeo(e.x, e.y, 0.5));
      }
      for (let i = 0; i < n; i++) {
        put(h, 'velvet', rope(v3(ends[i].x, 0.94, ends[i].y), v3(ends[i + 1].x, 0.94, ends[i + 1].y)));
      }
    }
    post.dispose();

    // Merge per set of halls and material: a few dozen draw calls in all.
    for (const { b, halls, list } of buckets.values()) {
      const g = merge(list);
      if (!g) continue;
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.mats.get(b)!);
      mesh.name = b;
      if (b === 'shade' || b === 'pool' || b === 'glow') mesh.renderOrder = 1;
      if (REFLECTED.has(b)) mesh.layers.enable(LAYER_REFLECT);
      mesh.matrixAutoUpdate = false;
      this.groupFor(halls).add(mesh);
    }

    this.buildChandeliers();
    this.buildLights();
    if (this.quality === 'high') this.buildMirror();
  }

  /** Soft reflections in the polished floor (high quality only): a low-resolution mirror added on top. */
  private buildMirror() {
    const b = this.layout.bounds;
    const g = new THREE.PlaneGeometry(b.x1 - b.x0 + 2, b.y1 - b.y0 + 2);
    const [w, h] = this.mirrorSize();
    const m = new Reflector(g, { textureWidth: w, textureHeight: h, clipBias: 0.003, multisample: 0, shader: FLOOR_MIRROR, color: 0xfff4e6 });
    m.rotation.x = -Math.PI / 2;
    m.position.set((b.x0 + b.x1) / 2, 0.002, (b.y0 + b.y1) / 2);
    const mat = m.material as THREE.ShaderMaterial;
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    // Just above the floor: keep it from flickering through it far away.
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -2;
    // The reflection pass draws only the big, bright things (walls, columns, chandeliers,
    // pictures), and only those of the hall you're in.
    m.getReflectionCamera(this.camera).layers.set(LAYER_REFLECT);
    const draw = m.onBeforeRender.bind(m);
    m.onBeforeRender = (...args: Parameters<THREE.Object3D['onBeforeRender']>) => {
      for (const g of this.groups.values()) if (g.obj.visible && !g.halls.includes(this.curHall)) g.obj.visible = false;
      draw(...args);
      this.applyCull();
    };
    this.scene.add(m);
    this.mirror = m;
  }

  private mirrorSize(): [number, number] {
    const pr = this.renderer.getPixelRatio();
    return [Math.max(64, Math.round((this.canvas.clientWidth || 800) * pr * 0.4)), Math.max(64, Math.round((this.canvas.clientHeight || 600) * pr * 0.4))];
  }

  private strip(p0: THREE.Vector3, p1: THREE.Vector3, n: THREE.Vector3, w: number): Geo {
    const q0 = p0.clone().addScaledVector(n, w);
    const q1 = p1.clone().addScaledVector(n, w);
    const pos = [p0, p1, q1, p0, q1, q0].flatMap((p) => [p.x, p.y, p.z]);
    const uv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1].map((x, i) => (i % 2 ? 1 - x : x));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [0, 1, 0]).flat(), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    upFacing(g);
    return g;
  }

  private blobGeo(x: number, y: number, s: number): Geo {
    // Corner vertices are "far" (transparent); add a centre fan instead.
    const pos: number[] = [];
    const uvs: number[] = [];
    const seg = 16;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      pos.push(x, 0.007, y, x + Math.cos(a1) * s / 2, 0.007, y + Math.sin(a1) * s / 2, x + Math.cos(a0) * s / 2, 0.007, y + Math.sin(a0) * s / 2);
      uvs.push(0.5, 1, 0.5, 0, 0.5, 0);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: seg * 3 }, () => [0, 1, 0]).flat(), 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    return out;
  }

  /** A soft round glow decal (light from a chandelier painted on the floor or ceiling). */
  private glowDisc(x: number, y: number, z: number, r: number, up: boolean): Geo {
    const g = flat(x - r, z - r, x + r, z + r, y, up, 1);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) - (x - r)) / (2 * r), (pos.getZ(i) - (z - r)) / (2 * r));
    return g;
  }

  private buildHall(h: Hall, put: (hall: number | number[], b: Bucket, g: Geo) => void) {
    const r = h.rect;
    const e = WALL_T / 2;
    put(h.index, 'floor', flat(r.x0 - e, r.y0 - e, r.x1 + e, r.y1 + e, 0, true, 3));
    // Ceiling and gilded cornice.
    const coffer = h.grand ? 3.4 : 3.3;
    put(h.index, 'ceiling', flat(r.x0, r.y0, r.x1, r.y1, h.height, false, coffer));
    const iw = r.x1 - r.x0 - WALL_T;
    const ih = r.y1 - r.y0 - WALL_T;
    const P = h.grand ? 0.85 : 0.7;
    const D = h.grand ? 0.8 : 0.62;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.y0 + r.y1) / 2;
    put(h.index, 'frameGold', sweepRect(v3(cx, h.height, cz), v3(1, 0, 0), v3(0, 0, 1), v3(0, -1, 0), iw - 2 * P, ih - 2 * P, corniceProfile(P, D), 0.5));
    // Grand hall: a painted sky in a gilded oval.
    if (h.grand) {
      const fr = new THREE.CircleGeometry(1, 48);
      fr.rotateX(Math.PI / 2);
      fr.scale((r.x1 - r.x0) * 0.26, 1, (r.y1 - r.y0) * 0.28);
      fr.translate(cx, h.height - 0.02, cz);
      put(h.index, 'fresco', norm(fr));
      const ring = new THREE.TorusGeometry(1, 0.035, 8, 64);
      ring.rotateX(Math.PI / 2);
      ring.scale((r.x1 - r.x0) * 0.26, 1, (r.y1 - r.y0) * 0.28);
      ring.translate(cx, h.height - 0.05, cz);
      put(h.index, 'gold', norm(ring));
      const ring2 = new THREE.TorusGeometry(1, 0.05, 8, 64);
      ring2.rotateX(Math.PI / 2);
      ring2.scale((r.x1 - r.x0) * 0.28, 1, (r.y1 - r.y0) * 0.3);
      ring2.translate(cx, h.height - 0.05, cz);
      put(h.index, 'frameGold', norm(ring2));
    }
    // The red runner down the middle. Where galleries turn, the new runner starts at the
    // edge of the one before (butted, not overlapping: no flicker where they meet).
    const width = h.grand ? 3.6 : 2.7;
    const back = h.index >= 2 ? h.width / 2 - 2.7 / 2 : 0.2;
    const start = { x: h.origin.x - h.forward.x * back, y: h.origin.y - h.forward.y * back };
    const len = h.length + back - (h.grand ? 0.2 : 0.9);
    put(h.index, 'carpet', this.runner(start, h.forward, len, width, 0.02));
    // Light from the chandeliers, painted on: a pool on the floor and a halo on the ceiling.
    for (const c of h.chandeliers) {
      put(h.index, 'glow', this.glowDisc(c.x, 0.03, c.y, 3.6 * c.scale, true));
      put(h.index, 'glow', this.glowDisc(c.x, h.height - 0.03, c.y, 2.6 * c.scale, false));
    }
  }

  private runner(s: { x: number; y: number }, f: { x: number; y: number }, len: number, w: number, y: number): Geo {
    const l = { x: f.y, y: -f.x };
    const P = (t: number, k: number) => v3(s.x + f.x * t + l.x * k, y, s.y + f.y * t + l.y * k);
    const a = P(0, -w / 2);
    const b = P(0, w / 2);
    const c = P(len, w / 2);
    const d = P(len, -w / 2);
    const vl = len / (w * 1.4);
    const pos = [a, b, c, a, c, d].flatMap((p) => [p.x, p.y, p.z]);
    const uv = [0, 0, 1, 0, 1, vl, 0, 0, 1, vl, 0, vl];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [0, 1, 0]).flat(), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    upFacing(g);
    return g;
  }

  /** A box aligned with a wall: centre on the plan, size along the wall × through it × height. */
  private wallBox(c: { x: number; y: number }, along: { x: number; y: number }, len: number, thick: number, y0: number, y1: number, uv = 1): Geo {
    const ax = Math.abs(along.x) > 0.5;
    return box(c.x, (y0 + y1) / 2, c.y, ax ? len : thick, y1 - y0, ax ? thick : len, uv);
  }

  private putPilaster(at: { x: number; y: number }, n: { x: number; y: number }, H: number, hall: number, put: (hall: number | number[], b: Bucket, g: Geo) => void) {
    const p = pilaster(H - 1.12);
    const ry = Math.atan2(n.x, n.y);
    for (const [g, b] of [[p.marble, 'marble'], [p.gold, 'frameGold'], [p.base, 'skirt']] as const) {
      g.rotateY(ry);
      g.translate(at.x, 0, at.y);
      put(hall, b, g);
    }
  }

  private buildDoor(d: Door, put: (hall: number | number[], b: Bucket, g: Geo) => void) {
    const { at, along, inward } = d;
    const hw = d.width / 2;
    const off = (t: number, n = 0) => ({ x: at.x + along.x * t + inward.x * n, y: at.y + along.y * t + inward.y * n });
    // A doorway between two halls is drawn with either of them.
    const halls = d.kind === 'pass' ? [d.hall, d.hall + 1] : [d.hall];
    // Lintel wall above the opening, butting onto the wall ends (which stop inside the jambs),
    // with the wall's marble frieze and gilded rails running on across it.
    const lw = d.width + 0.12;
    // (It starts inside the marble head, so its underside never meets the head's.)
    put(halls, 'damask', this.wallBox(at, along, lw, WALL_T, d.height + 0.12, d.wallHeight, 0.75));
    if (d.wallHeight - 1.12 > d.height + 0.7) {
      const H = d.wallHeight;
      put(halls, 'marble', this.wallBox(at, along, lw, WALL_T + 0.04, H - 1.05, H - 0.55, 1.5));
      put(halls, 'goldRail', this.wallBox(at, along, lw, WALL_T + 0.09, H - 1.12, H - 1.04, 0.3));
    }
    // Marble surround: jambs and a head, through the wall. Gilded beads run round the
    // opening on both faces, standing proud of the marble (no faces in common).
    const jw = 0.38;
    const depth = WALL_T + 0.16;
    for (const s of [-1, 1]) {
      put(halls, 'marble', this.wallBox(off(s * (hw + jw / 2)), along, jw, depth, 0, d.height + 0.46, 1));
      put(halls, 'gold', this.wallBox(off(s * (hw + jw + 0.03)), along, 0.06, depth + 0.02, 0.2, d.height + 0.46, 0.5));
      for (const n of [-1, 1]) {
        put(halls, 'gold', this.wallBox(off(s * (hw + 0.03), n * (depth / 2 + 0.01)), along, 0.08, 0.05, 0.2, d.height + 0.02, 0.5));
      }
    }
    put(halls, 'marble', this.wallBox(at, along, d.width + 2 * jw, depth, d.height, d.height + 0.46, 1));
    for (const n of [-1, 1]) put(halls, 'gold', this.wallBox(off(0, n * (depth / 2 + 0.01)), along, d.width + 0.14, 0.05, d.height - 0.02, d.height + 0.06, 0.5));
    put(halls, 'goldRail', this.wallBox(at, along, d.width + 2 * jw + 0.3, depth + 0.12, d.height + 0.46, d.height + 0.6, 0.3));
    // Green marble plinths under the jambs.
    for (const sgn of [-1, 1]) put(halls, 'skirt', this.wallBox(off(sgn * (hw + jw / 2)), along, jw + 0.08, depth + 0.06, 0, 0.3, 1));
    // Signs on both faces.
    for (const side of [1, -1]) {
      const inside = side === 1;
      let text: [string, string];
      if (d.kind === 'pass') {
        const target = this.layout.halls[inside ? d.hall + 1 : d.hall];
        text = [target?.name ?? '', ''];
      } else {
        if (!inside) continue;
        text = this.events.doorText(d);
      }
      const hall = inside ? d.hall : d.hall + 1;
      const c = off(0, side * (depth / 2 + 0.03));
      const t = this.canvasTex(tex.sign(text[0], text[1]), false);
      const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.35, metalness: 0.2, emissive: new THREE.Color('#ffffff'), emissiveMap: t, emissiveIntensity: 0.2 });
      this.disposables.push(mat);
      // Facing out of the wall; "right" is the reader's right so the text isn't mirrored.
      const n3 = v3(inward.x * side, 0, inward.y * side);
      const r3 = v3(0, 1, 0).cross(n3).normalize();
      const sy = d.height + 1.05;
      const m = new THREE.Mesh(quad(v3(c.x, sy, c.y), r3, n3, 2.4, 0.6), mat);
      m.matrixAutoUpdate = false;
      this.groupFor(hall).add(m);
      // Gilded frame round the sign.
      put(hall, 'frameGold', sweepRect(v3(c.x, sy, c.y), r3, v3(0, 1, 0), n3, 2.4, 0.6, frameProfile(0.08), 0.2));
    }
    if (d.kind !== 'pass') {
      // Closed double doors to another wing.
      const leafW = d.width / 2 - 0.02;
      const g: THREE.Object3D = new THREE.Group();
      for (const s of [-1, 1]) {
        const leaf = this.wallBox(off(s * (leafW / 2 + 0.01)), along, leafW, 0.1, 0, d.height - 0.02);
        // Map the door texture once per leaf.
        const uv = leaf.getAttribute('uv') as THREE.BufferAttribute;
        const pos = leaf.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) {
          const t = (pos.getX(i) - at.x) * along.x + (pos.getZ(i) - at.y) * along.y;
          uv.setXY(i, (t - (s < 0 ? -leafW - 0.01 : 0.01)) / leafW, pos.getY(i) / (d.height - 0.02));
        }
        g.add(new THREE.Mesh(leaf, this.mats.get('door')!));
        // Handles.
        for (const n of [0.08, -0.08]) {
          const hp = off(s * 0.18, n);
          const hg = new THREE.SphereGeometry(0.05, 12, 8);
          hg.translate(hp.x, 1.15, hp.y);
          g.add(new THREE.Mesh(hg, this.mats.get('gold')!));
        }
      }
      this.groupFor(d.hall).add(g);
      this.doorMeshes.push({ mesh: g, door: d });
    }
  }

  private buildFrame(f: Frame, put: (hall: number | number[], b: Bucket, g: Geo) => void) {
    const n = v3(f.normal.x, 0, f.normal.y);
    const right = n.clone().negate().cross(v3(0, 1, 0)).normalize();
    const up = v3(0, 1, 0);
    const c = v3(f.at.x, f.z, f.at.y);
    const prof = frameProfile(f.border);
    put(f.hall, 'frameGold', sweepRect(c, right, up, n, f.w, f.h, prof, f.border * 2.2));
    // A dark backing so nothing shows between frame and picture (well clear of both).
    put(f.hall, 'wood', norm(quad(c.clone().addScaledVector(n, 0.006), right, n, f.w + 0.04, f.h + 0.04)));
    // Featured: a gilded crest on top and rosettes in the corners.
    if (f.featured) {
      const top = c.clone().addScaledVector(up, f.h / 2 + f.border * 0.9).addScaledVector(n, f.border * 0.35);
      const shell = lathe([[0, 0], [0.16, 0.02], [0.2, 0.06], [0.16, 0.1], [0.06, 0.13], [0, 0.13]], 16);
      shell.scale(1.6, 1, 0.6);
      shell.rotateX(-Math.PI / 2);
      shell.rotateY(Math.atan2(n.x, n.z));
      put(f.hall, 'gold', shell.translate(top.x, top.y + 0.05, top.z));
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = c.clone().addScaledVector(right, sx * (f.w / 2 + f.border * 0.5)).addScaledVector(up, sy * (f.h / 2 + f.border * 0.5)).addScaledVector(n, f.border * 0.62);
        const ro = new THREE.SphereGeometry(f.border * 0.32, 10, 6);
        ro.scale(1, 1, 0.45);
        ro.rotateY(Math.atan2(n.x, n.z));
        put(f.hall, 'frameGold', norm(ro.translate(p.x, p.y, p.z)));
      }
    }
    // Picture lamp above the frame.
    const lampY = f.z + f.h / 2 + f.border + 0.16;
    const lampW = Math.max(0.35, f.w * 0.5);
    const lp = c.clone().setY(lampY).addScaledVector(n, 0.24);
    const bar = new THREE.CylinderGeometry(0.035, 0.035, lampW, 10);
    bar.rotateZ(Math.PI / 2);
    bar.rotateY(Math.atan2(n.x, n.z));
    put(f.hall, 'gold', norm(bar.translate(lp.x, lp.y, lp.z)));
    // Its warm glowing slit, facing down onto the picture.
    const slit = new THREE.PlaneGeometry(lampW * 0.94, 0.03);
    slit.rotateX(Math.PI / 2);
    slit.rotateY(Math.atan2(n.x, n.z));
    put(f.hall, 'lamp', norm(slit.translate(lp.x, lp.y - 0.036, lp.z)));
    const arm = new THREE.CylinderGeometry(0.012, 0.012, 0.28, 6);
    arm.rotateX(Math.PI / 2);
    arm.rotateY(Math.atan2(n.x, n.z));
    const ap = c.clone().setY(lampY + 0.04).addScaledVector(n, 0.12);
    put(f.hall, 'gold', norm(arm.translate(ap.x, ap.y, ap.z)));
    // Light pool on the wall around and above the picture.
    const pw = f.w + f.border * 2 + 1.1;
    const ph = f.h + f.border * 2 + 0.9;
    put(f.hall, 'pool', quad(c.clone().addScaledVector(up, 0.25).addScaledVector(n, 0.004), right, n, pw, ph));
    // Plaque below, standing 2 cm proud of the panelling (which is 2.5 cm proud of the wall).
    const py = Math.max(0.78, f.z - f.h / 2 - f.border - 0.2);
    const plw = f.featured ? 0.6 : 0.46;
    const plh = plw * 0.3125;
    const pc = c.clone().setY(py).addScaledVector(n, 0.0325);
    put(f.hall, 'plaque', this.wallBox({ x: pc.x, y: pc.z }, { x: right.x, y: right.z }, plw + 0.03, 0.025, py - plh / 2 - 0.015, py + plh / 2 + 0.015, 0.3));
    const pa = c.clone().setY(py).addScaledVector(n, 0.051);

    // The picture itself, with a gentle top-lit gradient.
    const pg = quad(c.clone().addScaledVector(n, Math.max(0.016, f.border * 0.62 * 0.15)), right, n, f.w, f.h);
    const col = new Float32Array(6 * 3);
    const posA = pg.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < 6; i++) {
      const t = (posA.getY(i) - (f.z - f.h / 2)) / f.h;
      const k = 0.8 + 0.2 * t;
      col.set([k, k * 0.985, k * 0.95], i * 3);
    }
    pg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    pg.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({ map: this.placeholder, vertexColors: true, toneMapped: false });
    const mesh = new THREE.Mesh(pg, mat);
    mesh.userData.frame = f;
    mesh.matrixAutoUpdate = false;
    mesh.layers.enable(LAYER_REFLECT);
    const group = this.groupFor(f.hall);
    group.add(mesh);
    this.slots.push({
      frame: f, mesh, mat, thumb: null, full: null, video: null, videoTex: null, loadingThumb: false, loadingFull: false, dist: Infinity,
      plaque: null, plaqueAt: pa, right, normal: n, gen: 0, anim: null, group,
    });
  }

  private buildChandeliers() {
    const L = this.layout;
    if (!L.halls.some((h) => h.chandeliers.length)) return;
    const ch = chandelier();
    const chLo = chandelier(true);
    const mats = {
      brass: this.mats.get('gold')!,
      crystal: new THREE.MeshStandardMaterial({ color: new THREE.Color('#ffffff'), metalness: 0.4, roughness: 0.04, envMapIntensity: 3.2, flatShading: true, emissive: new THREE.Color('#ffe7c2'), emissiveIntensity: 0.18 }),
      candle: new THREE.MeshStandardMaterial({ color: new THREE.Color('#f7efdf'), roughness: 0.55, emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: 0.45 }),
      flame: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3.2, 1.4) }),
    };
    this.disposables.push(mats.crystal, mats.candle, mats.flame);
    const chainG = norm(new THREE.CylinderGeometry(0.018, 0.018, 1, 5, 1, true).translate(0, 0.5, 0));
    // The far version is one mesh, its parts told apart by vertex colour (one draw call).
    const tint = (g: Geo, c: THREE.Color) => {
      const n = g.getAttribute('position').count;
      const a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g;
    };
    const loG = mergeGeometries([
      tint(chLo.brass, new THREE.Color('#e3b55e')), tint(chLo.crystal, new THREE.Color('#fff6ea')), tint(chLo.candle, new THREE.Color('#f7efdf')), tint(chLo.flame, new THREE.Color(1.6, 1.1, 0.5)),
    ])!;
    chLo.brass.dispose();
    chLo.crystal.dispose();
    chLo.candle.dispose();
    chLo.flame.dispose();
    const loMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.75, roughness: 0.25, envMapIntensity: 1.8, emissive: new THREE.Color('#3a2408') });
    const shared = [ch.brass, ch.crystal, ch.candle, ch.flame, loG, chainG, loMat];
    this.disposables.push(...shared);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const glowT = this.canvasTex(tex.glow(), false);
    const hm = new THREE.PointsMaterial({ map: glowT, size: 0.32, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color('#ffc477'), opacity: 0.7 });
    this.disposables.push(hm);
    this.sparkles = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, scale: { value: 1 } },
      vertexShader: `
        attribute float phase;
        uniform float time;
        uniform float scale;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float s = pow(max(0.0, sin(time * (1.3 + fract(phase * 7.1)) + phase * 3.0)), 24.0);
          vA = s;
          gl_PointSize = (2.0 + 26.0 * s) * scale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          float star = max(0.0, 1.0 - abs(p.x) * 14.0) * max(0.0, 1.0 - abs(p.y) * 2.2) + max(0.0, 1.0 - abs(p.y) * 14.0) * max(0.0, 1.0 - abs(p.x) * 2.2);
          float a = (smoothstep(0.5, 0.0, d) * 0.6 + star) * vA;
          gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * 2.0, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.disposables.push(this.sparkles);
    // One small set of instanced meshes per hall (drawn only while the hall is in view),
    // with a much simpler chandelier for the halls you're not in.
    for (const h of L.halls) {
      const cs = h.chandeliers;
      if (!cs.length) continue;
      const group = this.groupFor(h.index);
      const make = (g: Geo, m: THREE.Material) => {
        const im = new THREE.InstancedMesh(g, m, cs.length);
        im.userData.shared = true;
        im.layers.enable(LAYER_REFLECT);
        group.add(im);
        return im;
      };
      const hi = [make(ch.brass, mats.brass), make(ch.crystal, mats.crystal), make(ch.candle, mats.candle), make(ch.flame, mats.flame)];
      const lo = [make(loG, loMat)];
      const chain = make(chainG, mats.brass);
      const halo: number[] = [];
      const glint: number[] = [];
      const phase: number[] = [];
      cs.forEach((c, i) => {
        const bottom = h.height - 2.3 * c.scale - (h.height > 9 ? 1.2 : 0.6);
        const y = bottom + 0.72 * c.scale;
        m4.compose(v3(c.x, y, c.y), q, v3(c.scale, c.scale, c.scale));
        for (const p of [...hi, ...lo]) p.setMatrixAt(i, m4);
        const top = y + ch.top * c.scale;
        m4.compose(v3(c.x, top, c.y), q, v3(1, Math.max(0.05, h.height - top), 1));
        chain.setMatrixAt(i, m4);
        this.chandeliers.push({ p: v3(c.x, y + 0.1, c.y), hall: h.index });
        for (const f of ch.flames) halo.push(c.x + f.x * c.scale, y + f.y * c.scale, c.y + f.z * c.scale);
        for (const g of ch.glints) {
          glint.push(c.x + g.x * c.scale, y + g.y * c.scale, c.y + g.z * c.scale);
          phase.push(Math.random() * Math.PI * 2);
        }
      });
      for (const p of [...hi, ...lo, chain]) {
        p.instanceMatrix.needsUpdate = true;
        p.computeBoundingSphere();
      }
      for (const p of lo) p.visible = false;
      const lod = { hall: h.index, x: cs[0].x, y: cs[0].y, hi: [...hi] as THREE.Object3D[], lo };
      this.lods.push(lod);
      // Soft halos round the flames, twinkling glints on the crystals.
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.Float32BufferAttribute(halo, 3));
      const halos = new THREE.Points(hg, hm);
      group.add(halos);
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(glint, 3));
      gg.setAttribute('phase', new THREE.Float32BufferAttribute(phase, 1));
      const glints = new THREE.Points(gg, this.sparkles);
      // Glints only twinkle in the hall you are in.
      lod.hi.push(glints);
      group.add(glints);
    }
  }

  private buildLights() {
    const high = this.quality === 'high';
    this.scene.add(new THREE.HemisphereLight(0xfff0dc, 0x3a1810, high ? 0.42 : 0.6));
    // Two real lights (one in Fast) follow you from chandelier to chandelier; the
    // others' light is painted on (the glow decals under and above them).
    const n = high ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffc98a, 0, 26, 1.5);
      this.lights.push({ light: l, at: -1, want: 0 });
      this.scene.add(l);
    }
  }

  // ---- per frame ----------------------------------------------------------------------------

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    if (this.mirror) {
      const [mw, mh] = this.mirrorSize();
      this.mirror.getRenderTarget().setSize(mw, mh);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.sparkles) this.sparkles.uniforms.scale.value = (h * this.renderer.getPixelRatio()) / 600;
  }

  /** Lowers the resolution while frames run long, and raises it again once they're quick. */
  private adapt(dt: number) {
    if (dt > 0.25) return; // a hiccup (tab switch, loading), not the steady pace
    const p = this.perf;
    p.acc += dt;
    p.n++;
    if (p.acc < 1.2) return;
    const avg = p.acc / p.n;
    const min = this.quality === 'high' ? 0.6 : 0.5;
    let next = this.scale;
    if (avg > 1 / 45 && this.scale > min) {
      next = Math.max(min, this.scale * 0.85);
      p.good = 0;
    } else if (avg < 1 / 56) {
      p.good += p.acc;
      if (p.good > 4 && this.scale < 1) {
        next = Math.min(1, this.scale / 0.9);
        p.good = 0;
      }
    } else p.good = 0;
    p.acc = 0;
    p.n = 0;
    if (Math.abs(next - this.scale) > 1e-3) {
      this.scale = next;
      this.renderer.setPixelRatio((basePixelRatio.get(this.renderer) ?? 1) * next);
      this.resize();
    }
  }

  private loop = () => {
    if (this.disposed || this.paused) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    this.renderer.info.reset();
    const now = performance.now();
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.05, raw);
    this.last = now;
    this.time += dt;
    this.adapt(raw);
    if (this.glide) this.glideStep(dt);
    else this.move(dt);
    this.applyPose();
    this.cull();
    const t = this.time;
    if (this.sparkles) this.sparkles.uniforms.time.value = t;
    if ((this.streamTick += dt) > 0.3) {
      this.streamTick = 0;
      this.stream(false);
    }
    if ((this.lightTick += dt) > 0.2) {
      this.lightTick = 0;
      this.updateLights(false);
    }
    this.fadeLights(dt);
    // A couple of fresh textures go to the GPU per frame (not a burst that stutters).
    for (let i = 0; i < 2 && this.uploads.length; i++) this.uploads.shift()!();
    if ((this.aimTick += dt) > 0.08) {
      this.aimTick = 0;
      const a = this.glide || this.close ? null : this.pick({ x: 0, y: 0 });
      const same = a?.kind === this.aim?.kind && (a?.kind === 'frame' ? a.frame === (this.aim as { frame: Frame }).frame : a?.kind === 'door' ? a.door === (this.aim as { door: Door }).door : true);
      if (!same) {
        this.aim = a;
        this.events.onAim(a);
      }
    }
    for (const s of this.slots) if (s.videoTex && s.video && s.video.readyState >= 2) s.videoTex.needsUpdate = true;
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.frames++;
  };

  private move(dt: number) {
    const k = this.keys;
    let fx = 0;
    let fz = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) fz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fz -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
    if (this.close) fx = fz = 0;
    // Back to eye height after a close look.
    if (!this.close) this.eye += (EYE - this.eye) * (1 - Math.exp(-dt * 6));
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = fast ? RUN : WALK;
    const len = Math.hypot(fx, fz) || 1;
    const sy = Math.sin(this.pose.yaw);
    const cy = Math.cos(this.pose.yaw);
    // Forward is (-sin yaw, -cos yaw) on the plan; right is (cos yaw, -sin yaw).
    const tx = ((-sy * fz + cy * fx) / len) * speed;
    const ty = ((-cy * fz - sy * fx) / len) * speed;
    // Smooth: speeding up takes about a third of a second, stopping a little less.
    const moving = fx !== 0 || fz !== 0;
    const a = 1 - Math.exp(-dt * (moving ? 6 : 9));
    this.vel.x += (tx - this.vel.x) * a;
    this.vel.y += (ty - this.vel.y) * a;
    if (Math.abs(this.vel.x) < 1e-4 && Math.abs(this.vel.y) < 1e-4) return;
    if (moving) this.at = null;
    const p = collide({ x: this.pose.x + this.vel.x * dt, y: this.pose.y + this.vel.y * dt }, RADIUS, this.layout);
    this.pose.x = p.x;
    this.pose.y = p.y;
    // Walking into a door to another wing goes through it.
    let near: Door | null = null;
    for (const d of this.layout.doors) {
      if (d.kind === 'pass') continue;
      if (Math.hypot(p.x - d.at.x, p.y - d.at.y) < d.width / 2 && (p.x - d.at.x) * d.inward.x + (p.y - d.at.y) * d.inward.y < RADIUS + WALL_T / 2 + 0.12) near = d;
    }
    if (near && !this.doorFired) {
      this.doorFired = true;
      this.events.onDoor(near);
    } else if (!near) this.doorFired = false;
  }

  /** Starts a glide (through doors if need be) to a pose; instant if asked or for reduced motion. */
  private moveTo(to: Pose & { eye: number }, instant = false) {
    this.vel.set(0, 0);
    if (instant || reducedMotion()) {
      this.glide = null;
      this.pose = { x: to.x, y: to.y, yaw: to.yaw, pitch: to.pitch };
      this.eye = to.eye;
      return;
    }
    const from = { x: this.pose.x, y: this.pose.y };
    const way = [from, ...route(this.layout, from, to)];
    const pts = way.map((p) => v3(p.x, 0, p.y));
    if (pts.length === 2) pts.splice(1, 0, pts[0].clone().lerp(pts[1], 0.5));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const length = curve.getLength();
    this.glide = {
      curve, t: 0, dur: Math.min(2.6, Math.max(0.55, 0.4 + length / 12)),
      yaw0: this.pose.yaw, yaw1: to.yaw, pitch0: this.pose.pitch, pitch1: to.pitch, eye0: this.eye, eye1: to.eye, follow: way.length > 2,
    };
  }

  private glideStep(dt: number) {
    const g = this.glide!;
    // Pressing a walking key takes over (not in a close look).
    if (!this.close && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].some((k) => this.keys.has(k))) {
      this.glide = null;
      this.at = null;
      return;
    }
    g.t = Math.min(1, g.t + dt / g.dur);
    const k = ease(g.t);
    const p = g.curve.getPointAt(k, this.tmp);
    this.pose.x = p.x;
    this.pose.y = p.z;
    if (g.follow && k < 0.72) {
      const tan = g.curve.getTangentAt(Math.min(0.999, k + 0.02), this.tmp);
      this.pose.yaw = lerpAngle(this.pose.yaw, Math.atan2(-tan.x, -tan.z), 1 - Math.exp(-dt * 7));
    } else if (g.follow) {
      this.pose.yaw = lerpAngle(this.pose.yaw, g.yaw1, Math.max(1 - Math.exp(-dt * 7), (k - 0.72) / 0.28));
    } else this.pose.yaw = lerpAngle(g.yaw0, g.yaw1, k);
    this.pose.pitch = g.pitch0 + (g.pitch1 - g.pitch0) * k;
    this.eye = g.eye0 + (g.eye1 - g.eye0) * k;
    if (g.t >= 1) {
      this.pose.yaw = wrap(g.yaw1);
      this.glide = null;
    }
  }

  private applyPose() {
    // A barely-there sway while walking.
    const speed = this.vel.length();
    const bob = Math.sin(this.time * 8.5) * 0.012 * Math.min(1, speed / WALK);
    this.camera.position.set(this.pose.x, this.eye + bob, this.pose.y);
    this.camera.rotation.set(this.pose.pitch, this.pose.yaw, 0);
    this.camera.updateMatrixWorld();
  }

  /** The picture you're at (just glided to) or else the nearest one in front of you. */
  private currentFrame(): { at: Frame | null; near: Frame | null } {
    if (this.at) {
      const s = standSpot(this.layout, this.at, FOV, this.camera.aspect);
      if (Math.hypot(s.x - this.pose.x, s.y - this.pose.y) < 1.2) return { at: this.at, near: null };
    }
    if (this.aim?.kind === 'frame') return { at: null, near: this.aim.frame };
    const fx = -Math.sin(this.pose.yaw);
    const fy = -Math.cos(this.pose.yaw);
    let best: Frame | null = null;
    let bd = Infinity;
    for (const f of this.layout.frames) {
      const dx = f.at.x - this.pose.x;
      const dy = f.at.y - this.pose.y;
      const d = Math.hypot(dx, dy);
      // Facing the picture's front, and roughly in front of you.
      if (dx * f.normal.x + dy * f.normal.y > 0) continue;
      const ahead = (dx * fx + dy * fy) / (d || 1);
      const score = d * (ahead > 0.2 ? 1 : 3);
      if (score < bd) {
        bd = score;
        best = f;
      }
    }
    return { at: null, near: best };
  }

  /** Draws only the hall you're in, its neighbours, and one beyond if a doorway shows it. */
  private cull() {
    const L = this.layout;
    const cur = nearestHall(L, this.pose)?.index ?? 0;
    this.curHall = cur;
    const vis = this.hallVisible;
    vis.length = L.halls.length;
    for (let i = 0; i < vis.length; i++) vis[i] = i === cur;
    this.m4.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    // Walk out through the doors (halls are a chain): a hall is drawn while the
    // doorway leading to it is on screen, up to two halls away.
    for (const dir of [1, -1]) {
      for (let k = 1; k <= 2; k++) {
        const far = cur + dir * k;
        if (far < 0 || far >= vis.length) break;
        const d = L.doors.find((x) => x.kind === 'pass' && x.hall === (dir > 0 ? far - 1 : far));
        if (!d) break;
        const dist = Math.hypot(d.at.x - this.pose.x, d.at.y - this.pose.y);
        // The opening itself (a thin box): behind you it's out of view however near.
        const hx = Math.abs(d.along.x) * (d.width / 2) + Math.abs(d.inward.x) * 0.25;
        const hz = Math.abs(d.along.y) * (d.width / 2) + Math.abs(d.inward.y) * 0.25;
        this.box.min.set(d.at.x - hx, 0, d.at.y - hz);
        this.box.max.set(d.at.x + hx, d.height, d.at.y + hz);
        const seen = dist < 50 && this.frustum.intersectsBox(this.box);
        if (!seen) break;
        vis[far] = true;
      }
    }
    this.applyCull();
    // Pictures in the other halls: only those a doorway really shows (a plan check, a few times a second).
    if (--this.picTick <= 0) {
      this.picTick = 6;
      for (const s of this.slots) {
        const h = s.frame.hall;
        if (!vis[h]) continue;
        if (h === cur) {
          s.mesh.visible = true;
          continue;
        }
        const f = s.frame;
        const half = f.w / 2 + f.border;
        const ax = -f.normal.y;
        const ay = f.normal.x;
        s.mesh.visible = [0, -half, half].some((k) => this.seen(f.at.x + ax * k + f.normal.x * 0.05, f.at.y + ay * k + f.normal.y * 0.05));
      }
    }
    // Full chandeliers only in your own hall.
    for (const l of this.lods) {
      const hi = l.hall === cur;
      for (const o of l.hi) o.visible = hi;
      for (const o of l.lo) o.visible = !hi;
    }
  }

  private applyCull() {
    for (const g of this.groups.values()) {
      let on = false;
      for (const h of g.halls) if (this.hallVisible[h]) on = true;
      g.obj.visible = on;
    }
  }

  private pick(ndc: { x: number; y: number }, far = 12): Aim {
    this.ndc.set(ndc.x, ndc.y);
    this.ray.setFromCamera(this.ndc, this.camera);
    this.ray.far = far;
    const targets = this.pickList;
    targets.length = 0;
    for (const s of this.slots) if (s.dist < far + 2 && s.group.visible && s.mesh.visible) targets.push(s.mesh);
    for (const d of this.doorMeshes) targets.push(d.mesh);
    if (!targets.length) return null;
    const hits = this.ray.intersectObjects(targets, true);
    // Walls block the view: ignore hits farther than the nearest wall along the ray.
    for (const h of hits) {
      const f = h.object.userData.frame as Frame | undefined;
      if (f) return this.visible(h.point) ? { kind: 'frame', frame: f } : null;
      const d = this.doorMeshes.find((x) => x.mesh === h.object || x.mesh === h.object.parent);
      if (d) return { kind: 'door', door: d.door };
    }
    return null;
  }

  /** True if no wall stands between the camera and a point (plan check). */
  private visible(p: THREE.Vector3): boolean {
    return this.seen(p.x, p.z);
  }

  private seen(x: number, y: number): boolean {
    const a = { x: this.pose.x, y: this.pose.y };
    const b = { x, y };
    for (const w of this.layout.walls) {
      if (segX(a, b, w.a, w.b)) {
        // Hitting the very wall the picture hangs on is fine.
        const dx = w.b.x - w.a.x;
        const dy = w.b.y - w.a.y;
        const cross = Math.abs((b.x - w.a.x) * dy - (b.y - w.a.y) * dx) / (Math.hypot(dx, dy) || 1);
        if (cross > WALL_T) return false;
      }
    }
    return true;
  }

  /** Moves the real lights to the best chandeliers in view: one fades out before it moves on. */
  private updateLights(now: boolean) {
    const n = this.lights.length;
    if (!n || !this.chandeliers.length) return;
    const fx = -Math.sin(this.pose.yaw);
    const fy = -Math.cos(this.pose.yaw);
    // The n best chandeliers: near, in front of you, in a hall that's drawn.
    const best: number[] = [];
    const score: number[] = [];
    this.chandeliers.forEach((c, i) => {
      if (!this.hallVisible[c.hall]) return;
      const dx = c.p.x - this.pose.x;
      const dy = c.p.z - this.pose.y;
      const d = Math.hypot(dx, dy);
      const s = d - ((dx * fx + dy * fy) / (d || 1)) * 3 + (c.hall === this.curHall ? 0 : 4);
      let k = best.length;
      while (k > 0 && score[k - 1] > s) k--;
      if (k >= n) return;
      best.splice(k, 0, i);
      score.splice(k, 0, s);
      if (best.length > n) {
        best.pop();
        score.pop();
      }
    });
    const P = this.lightPower();
    for (const l of this.lights) l.want = best.includes(l.at) ? 1 : 0;
    for (const i of best) {
      if (this.lights.some((l) => l.at === i)) continue;
      // A light that has faded out (or never shone) moves here.
      const free = this.lights.find((l) => l.want === 0 && (l.light.intensity < 0.05 * P || now || l.at < 0));
      if (!free) continue;
      free.at = i;
      free.want = 1;
      free.light.position.copy(this.chandeliers[i].p);
      free.light.intensity = now ? P : 0;
    }
  }

  private lightPower() {
    return this.quality === 'high' ? 24 : 28;
  }

  private fadeLights(dt: number) {
    const P = this.lightPower();
    for (const l of this.lights) l.light.intensity += (l.want * P - l.light.intensity) * Math.min(1, dt * 3);
  }

  // ---- streaming pictures ---------------------------------------------------------------------

  private stream(first: boolean) {
    const px = this.pose.x;
    const py = this.pose.y;
    for (const s of this.slots) s.dist = Math.hypot(s.frame.at.x - px, s.frame.at.y - py);
    const sorted = [...this.slots].sort((a, b) => a.dist - b.dist);
    const high = this.quality === 'high';
    const THUMB_IN = 40;
    const THUMB_OUT = 50;
    const MAX_THUMBS = high ? 70 : 45;
    const FULL_IN = 7.5;
    const MAX_FULL = high ? 6 : 3;
    const MAX_VIDEO = high ? 3 : 2;
    const close = this.close?.frame;
    let fulls = 0;
    let videos = 0;
    let plaques = 0;
    sorted.forEach((s, rank) => {
      const isVideo = s.frame.item.kind === 'video';
      const wantThumb = (s.dist < THUMB_IN || (s.thumb && s.dist < THUMB_OUT)) && rank < MAX_THUMBS;
      let wantFull = false;
      let wantVideo = false;
      if (isVideo) wantVideo = s.frame === close || (s.dist < 14 && videos++ < MAX_VIDEO);
      else wantFull = s.frame === close || (s.dist < FULL_IN && fulls++ < MAX_FULL);
      // Plaques close enough to read (a couple at a time); farther off the brass plate is blank.
      if (s.dist < 8.5 && !s.plaque && (plaques++ < 2 || first)) this.makePlaque(s);
      else if (s.dist > 12 && s.plaque) this.dropPlaque(s);

      if (wantVideo && !s.video) this.startVideo(s);
      else if (!wantVideo && s.video) this.stopVideo(s);
      if (wantFull && !s.full && !s.loadingFull && (this.loads < 3 || s.frame === close)) this.loadFull(s);
      else if (!wantFull && s.full) {
        s.anim?.stop();
        s.anim = null;
        s.full.dispose();
        s.full = null;
        this.show(s);
      }
      if ((wantThumb || wantFull || wantVideo) && !s.thumb && !s.loadingThumb && (this.loads < 4 || first)) this.loadThumb(s);
      else if (!wantThumb && !wantFull && !wantVideo && s.thumb) {
        s.thumb.dispose();
        s.thumb = null;
        s.gen++;
        this.show(s);
      }
    });
  }

  private show(s: Slot) {
    const t = s.videoTex ?? s.full ?? s.thumb ?? this.placeholder;
    if (s.mat.map !== t) {
      s.mat.map = t;
      s.mat.needsUpdate = true;
    }
  }

  private toTex(d: { src: TexImageSource; w: number; h: number; bitmap: boolean }, s: Slot): THREE.Texture {
    const t = new THREE.Texture(d.src as HTMLImageElement);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(4, this.anisotropy);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    if (d.bitmap) {
      // Already flipped; once on the GPU the bitmap's memory can go.
      t.flipY = false;
      t.onUpdate = () => {
        (d.src as ImageBitmap).close();
        t.onUpdate = null;
      };
    }
    cover(t, d.w, d.h, s.frame.w, s.frame.h);
    t.needsUpdate = true;
    return t;
  }

  /** Hands a finished texture to the GPU on a later frame (a couple per frame). */
  private queue(s: Slot, gen: number, which: 'thumb' | 'full', t: THREE.Texture) {
    this.uploads.push(() => {
      if (this.disposed || gen !== s.gen || s[which] !== null) {
        t.dispose();
        return;
      }
      this.renderer.initTexture(t);
      s[which] = t;
      this.show(s);
    });
  }

  private async loadThumb(s: Slot) {
    s.loadingThumb = true;
    this.loads++;
    const gen = s.gen;
    try {
      const d = await decodeFor(this.sources.thumb(s.frame.item.id), this.maxThumb);
      if (this.disposed || gen !== s.gen) {
        if (d.bitmap) (d.src as ImageBitmap).close();
        return;
      }
      this.queue(s, gen, 'thumb', this.toTex(d, s));
    } catch {
      /* a missing thumbnail leaves the placeholder */
    } finally {
      s.loadingThumb = false;
      this.loads--;
    }
  }

  private async loadFull(s: Slot) {
    s.loadingFull = true;
    this.loads++;
    const gen = s.gen;
    try {
      if (s.frame.item.kind === 'gif' && (await this.loadGif(s, gen))) return;
      const d = await decodeFor(this.sources.full(s.frame.item.id), this.maxFull);
      if (this.disposed || gen !== s.gen || (s.dist > 10 && this.close?.frame !== s.frame)) {
        if (d.bitmap) (d.src as ImageBitmap).close();
        return;
      }
      this.queue(s, gen, 'full', this.toTex(d, s));
    } catch {
      /* stay on the thumbnail */
    } finally {
      s.loadingFull = false;
      this.loads--;
    }
  }

  /**
   * Plays an animated GIF on the wall: frames decoded in memory with the
   * browser's ImageDecoder (WebView2 has it) and drawn into a small canvas.
   * Returns false where that isn't available, so the still picture is used.
   */
  private async loadGif(s: Slot, gen: number): Promise<boolean> {
    type GifFrame = { image: VideoFrame };
    type Decoder = { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }; decode: (o: { frameIndex: number }) => Promise<GifFrame>; close: () => void };
    const IDC = (window as unknown as { ImageDecoder?: { new (o: { data: ArrayBuffer; type: string }): Decoder; isTypeSupported: (t: string) => Promise<boolean> } }).ImageDecoder;
    if (!IDC || !(await IDC.isTypeSupported('image/gif').catch(() => false))) return false;
    const data = await (await fetch(this.sources.full(s.frame.item.id))).arrayBuffer();
    if (this.disposed || gen !== s.gen) return true;
    const dec = new IDC({ data, type: 'image/gif' });
    try {
      await dec.tracks.ready;
      const n = dec.tracks.selectedTrack?.frameCount ?? 1;
      if (n <= 1) {
        dec.close();
        return false;
      }
      const first = (await dec.decode({ frameIndex: 0 })).image;
      const w0 = first.displayWidth;
      const h0 = first.displayHeight;
      const k = Math.min(1, 768 / Math.max(w0, h0));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w0 * k));
      c.height = Math.max(1, Math.round(h0 * k));
      const ctx = c.getContext('2d')!;
      ctx.drawImage(first, 0, 0, c.width, c.height);
      let wait = (first.duration ?? 100000) / 1000;
      first.close();
      if (this.disposed || gen !== s.gen || (s.dist > 10 && this.close?.frame !== s.frame)) {
        dec.close();
        return true;
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      cover(t, c.width, c.height, s.frame.w, s.frame.h);
      s.full = t;
      this.show(s);
      let i = 1;
      let stopped = false;
      let timer = 0;
      const step = async () => {
        if (stopped) return;
        try {
          // Hold still while the museum is paused under the viewer.
          if (this.paused) {
            timer = window.setTimeout(step, 250);
            return;
          }
          const f = (await dec.decode({ frameIndex: i })).image;
          if (stopped) return f.close();
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.drawImage(f, 0, 0, c.width, c.height);
          wait = (f.duration ?? 100000) / 1000;
          f.close();
          t.needsUpdate = true;
          i = (i + 1) % n;
          timer = window.setTimeout(step, Math.max(20, wait));
        } catch {
          /* stays on the last frame */
        }
      };
      timer = window.setTimeout(step, Math.max(20, wait));
      s.anim = {
        stop: () => {
          stopped = true;
          clearTimeout(timer);
          dec.close();
        },
      };
      return true;
    } catch {
      dec.close();
      return false;
    }
  }

  private startVideo(s: Slot) {
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.preload = 'auto';
    v.src = this.sources.full(s.frame.item.id);
    s.video = v;
    v.addEventListener('loadeddata', () => {
      if (s.video !== v || this.disposed) return;
      const t = new THREE.VideoTexture(v);
      t.colorSpace = THREE.SRGBColorSpace;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      cover(t, v.videoWidth || 16, v.videoHeight || 9, s.frame.w, s.frame.h);
      s.videoTex = t;
      this.show(s);
    }, { once: true });
    if (!this.paused) v.play().catch(() => {});
  }

  private stopVideo(s: Slot) {
    const v = s.video;
    if (!v) return;
    v.pause();
    v.removeAttribute('src');
    v.load();
    s.video = null;
    s.videoTex?.dispose();
    s.videoTex = null;
    this.show(s);
  }

  private makePlaque(s: Slot) {
    const [name, detail] = this.events.plaqueText(s.frame);
    const t = new THREE.CanvasTexture(tex.plaque(name, detail));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.anisotropy;
    const plw = s.frame.featured ? 0.6 : 0.46;
    const g = quad(s.plaqueAt, s.right, s.normal, plw, plw * 0.3125);
    const m = new THREE.MeshStandardMaterial({ map: t, metalness: 0.55, roughness: 0.32, envMapIntensity: 1.2, emissive: new THREE.Color('#ffffff'), emissiveMap: t, emissiveIntensity: 0.12 });
    s.plaque = new THREE.Mesh(g, m);
    s.plaque.matrixAutoUpdate = false;
    s.group.add(s.plaque);
  }

  private dropPlaque(s: Slot) {
    const p = s.plaque;
    if (!p) return;
    p.removeFromParent();
    p.geometry.dispose();
    const m = p.material as THREE.MeshStandardMaterial;
    m.map?.dispose();
    m.dispose();
    s.plaque = null;
  }

  private dropAll(s: Slot) {
    s.gen++;
    s.anim?.stop();
    s.anim = null;
    this.stopVideo(s);
    s.thumb?.dispose();
    s.full?.dispose();
    s.thumb = s.full = null;
    this.dropPlaque(s);
    s.mat.dispose();
  }
}

/** Makes a flat (two-triangle) geometry face up whatever order its corners came in. */
function upFacing(g: Geo) {
  const p = g.getAttribute('position').array as Float32Array;
  const u = g.getAttribute('uv').array as Float32Array;
  const e1 = new THREE.Vector3(p[3] - p[0], p[4] - p[1], p[5] - p[2]);
  const e2 = new THREE.Vector3(p[6] - p[0], p[7] - p[1], p[8] - p[2]);
  if (e1.cross(e2).y >= 0) return;
  for (const t of [0, 3]) {
    for (let k = 0; k < 3; k++) [p[(t + 1) * 3 + k], p[(t + 2) * 3 + k]] = [p[(t + 2) * 3 + k], p[(t + 1) * 3 + k]];
    for (let k = 0; k < 2; k++) [u[(t + 1) * 2 + k], u[(t + 2) * 2 + k]] = [u[(t + 2) * 2 + k], u[(t + 1) * 2 + k]];
  }
}

/** The floor mirror: blurred a little, stronger at grazing angles. */
const FLOOR_MIRROR = {
  name: 'FloorMirror',
  uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null } },
  vertexShader: `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vec2 uv = vUv.xy / vUv.w;
      vec2 px = vec2(0.003, 0.005);
      vec3 c = texture2D(tDiffuse, uv).rgb * 0.36
        + (texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb
        + texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb + texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb) * 0.16;
      vec3 v = normalize(cameraPosition - vWorld);
      float f = 0.1 + 0.5 * pow(1.0 - max(v.y, 0.0), 3.0);
      gl_FragColor = vec4(c * color * f, 1.0);
    }`,
};

/** Do segments ab and cd cross? */
function segX(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
