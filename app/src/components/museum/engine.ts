// The museum's 3D scene: builds the halls from a WingLayout, streams the
// pictures in (thumbnails first, the full picture up close, muted videos for
// the nearest few), and walks the visitor around.
//
// Nothing here writes to disk: pictures come from the vault's in-memory
// URLs (or the browser preview's generated ones) and live only as GPU textures.

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
import { collide, GALLERY_W, hallAt, WALL_T, type Door, type Frame, type Hall, type WingLayout } from './layout';
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
  onOpen: (f: Frame) => void;
  onDoor: (d: Door) => void;
  /** Text for wing doors and plaques. */
  doorText: (d: Door) => [string, string];
  plaqueText: (f: Frame) => [string, string];
}

const EYE = 1.62;
const RADIUS = 0.32;
const LOOK = 0.0022;

type Bucket = 'floor' | 'damask' | 'wood' | 'goldRail' | 'skirt' | 'marble' | 'frameGold' | 'gold' | 'carpet' | 'ceiling' | 'velvet' | 'pool' | 'shade' | 'plaque' | 'door' | 'fresco';

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
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

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

/** Image → something small enough for the GPU (in memory only). */
function fit(img: HTMLImageElement, max: number): TexImageSource {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (Math.max(w, h) <= max) return img;
  const k = max / Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
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

export class MuseumEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer | null = null;
  private mirror: Reflector | null = null;
  private last = performance.now();
  private time = 0;
  private raf = 0;
  private disposed = false;
  private disposables: { dispose: () => void }[] = [];
  private mats = new Map<Bucket, THREE.Material>();
  private slots: Slot[] = [];
  private doorMeshes: { mesh: THREE.Object3D; door: Door }[] = [];
  private lights: THREE.PointLight[] = [];
  private chandeliers: THREE.Vector3[] = [];
  private lods: { x: number; y: number; r: number; hi: THREE.Object3D[]; lo: THREE.Object3D[] }[] = [];
  private sparkle: THREE.ShaderMaterial | null = null;
  private keys = new Set<string>();
  private vel = new THREE.Vector2();
  private pose: Pose;
  private aim: Aim = null;
  private aimTick = 0;
  private streamTick = 0;
  private lightTick = 0;
  private loads = 0;
  private placeholder: THREE.Texture;
  private ray = new THREE.Raycaster();
  private doorFired = false;
  private resizeObs: ResizeObserver;
  private maxFull: number;
  private anisotropy: number;
  /** Frames rendered, for tests and the preview's fps readout. */
  frames = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    readonly layout: WingLayout,
    private quality: Quality,
    private sources: Sources,
    start: Pose,
    private events: EngineEvents,
  ) {
    this.pose = { ...start };
    const high = quality === 'high';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !high, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, high ? 1.5 : 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.info.autoReset = false;
    this.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.maxFull = high ? 2048 : 1280;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    this.camera = new THREE.PerspectiveCamera(68, w / h, 0.05, 75);
    this.camera.rotation.order = 'YXZ';
    this.scene.background = new THREE.Color(0x0b0705);
    this.scene.fog = new THREE.Fog(0x140c08, 28, 72);

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
    this.scene.environmentIntensity = 0.32;
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
    this.resizeObs.observe(canvas);
    this.applyPose();
    this.stream(true);
    this.updateLights(true);
    this.loop();
  }

  // ---- public ------------------------------------------------------------------------

  getPose(): Pose {
    return { ...this.pose };
  }

  /** Draw calls and triangles of the last frame, textures and geometries alive (for tuning). */
  stats() {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, geometries: i.memory.geometries };
  }

  setPose(p: Pose) {
    this.pose = { ...p };
    this.vel.set(0, 0);
    this.applyPose();
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
    this.pose.yaw -= dx * LOOK;
    this.pose.pitch = Math.max(-1.2, Math.min(1.2, this.pose.pitch - dy * LOOK));
  }

  /** Click at the screen centre (pointer locked) or at a point (-1..1). */
  click(ndc?: { x: number; y: number }) {
    const hit = this.pick(ndc ?? { x: 0, y: 0 });
    if (hit?.kind === 'frame') this.events.onOpen(hit.frame);
    else if (hit?.kind === 'door') this.events.onDoor(hit.door);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    for (const s of this.slots) this.dropAll(s);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !m.userData.shared) m.geometry.dispose();
    });
    for (const m of this.mats.values()) m.dispose();
    for (const d of this.disposables) d.dispose();
    this.composer?.dispose();
    this.mirror?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
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
    const floorR = this.canvasTex(tex.floorRough(), true, false);
    const dam = tex.damask([92, 12, 22], high ? 512 : 256);
    const orn = tex.ornament();
    const ornT = this.canvasTex(orn);
    const ornB = this.canvasTex(orn, true, false);
    const white = this.canvasTex(tex.whiteMarble(high ? 512 : 256));
    const gold = { color: new THREE.Color('#e3b55e'), metalness: 1, roughness: 0.27, envMapIntensity: 1.6 };
    const M = this.mats;
    M.set('floor', new THREE.MeshStandardMaterial({ map: floor, roughness: 0.6, roughnessMap: floorR, metalness: 0, envMapIntensity: 0.6 }));
    M.set('damask', new THREE.MeshStandardMaterial({ map: this.canvasTex(dam.map), bumpMap: this.canvasTex(dam.bump, true, false), bumpScale: 1.2, roughness: 0.62, envMapIntensity: 0.5 }));
    M.set('wood', new THREE.MeshStandardMaterial({ map: this.canvasTex(tex.wainscot()), roughness: 0.36, envMapIntensity: 0.7 }));
    M.set('goldRail', new THREE.MeshStandardMaterial({ ...gold, map: ornT, bumpMap: ornB, bumpScale: 2 }));
    M.set('frameGold', new THREE.MeshStandardMaterial({ ...gold, map: ornT, bumpMap: ornB, bumpScale: 3, roughness: 0.3 }));
    M.set('gold', new THREE.MeshStandardMaterial({ ...gold, roughness: 0.22 }));
    M.set('skirt', new THREE.MeshStandardMaterial({ map: this.canvasTex(tex.greenMarble()), roughness: 0.18, envMapIntensity: 1 }));
    M.set('marble', new THREE.MeshStandardMaterial({ map: white, roughness: 0.2, envMapIntensity: 0.8 }));
    M.set('carpet', new THREE.MeshStandardMaterial({ map: this.canvasTex(tex.carpet()), roughness: 0.95, envMapIntensity: 0.25 }));
    const cof = this.canvasTex(tex.coffer(high ? 512 : 256));
    M.set('ceiling', new THREE.MeshStandardMaterial({ map: cof, roughness: 0.6, emissive: new THREE.Color('#ffffff'), emissiveMap: cof, emissiveIntensity: 0.05, envMapIntensity: 0.5 }));
    const fr = this.canvasTex(tex.fresco(), false);
    M.set('fresco', new THREE.MeshStandardMaterial({ map: fr, roughness: 0.8, emissive: new THREE.Color('#ffffff'), emissiveMap: fr, emissiveIntensity: 0.1 }));
    M.set('velvet', new THREE.MeshStandardMaterial({ color: new THREE.Color('#6e0712'), roughness: 0.8, envMapIntensity: 0.4 }));
    M.set('pool', new THREE.MeshBasicMaterial({ map: this.canvasTex(tex.lightPool(), false), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.32, polygonOffset: true, polygonOffsetFactor: -2 }));
    M.set('shade', new THREE.MeshBasicMaterial({ map: this.canvasTex(tex.fade(), false, false), color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    M.set('plaque', new THREE.MeshStandardMaterial({ ...gold, roughness: 0.3 }));
    M.set('door', new THREE.MeshStandardMaterial({ map: this.canvasTex(tex.doorLeaf(), false), roughness: 0.4, envMapIntensity: 0.8 }));
  }

  // ---- building --------------------------------------------------------------------------

  private build() {
    this.materials();
    const L = this.layout;
    const buckets = L.halls.map(() => new Map<Bucket, Geo[]>());
    const put = (hall: number, b: Bucket, g: Geo) => {
      const m = buckets[Math.max(0, hall)];
      const list = m.get(b) ?? [];
      list.push(g);
      m.set(b, list);
    };
    const hallOf = (x: number, y: number) => hallAt(L, { x, y })?.index ?? 0;

    // Floors, carpets, ceilings, cornices.
    for (const h of L.halls) this.buildHall(h, put);

    // Walls with panelling.
    const doorNear = (p: { x: number; y: number }) => L.doors.some((d) => Math.hypot(d.at.x - p.x, d.at.y - p.y) < d.width / 2 + 0.05);
    for (const w of L.walls) {
      const dx = w.b.x - w.a.x;
      const dy = w.b.y - w.a.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const ux = dx / len;
      const uy = dy / len;
      const ea = doorNear(w.a) ? 0 : WALL_T / 2;
      const eb = doorNear(w.b) ? 0 : WALL_T / 2;
      const a = { x: w.a.x - ux * ea, y: w.a.y - uy * ea };
      const b = { x: w.b.x + ux * eb, y: w.b.y + uy * eb };
      const L2 = Math.hypot(b.x - a.x, b.y - a.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const alongX = Math.abs(ux) > 0.5;
      const sz = (along: number, thick: number) => (alongX ? [along, thick] : [thick, along]);
      const H = w.height;
      const hall = hallOf(cx + (alongX ? 0 : 0.5), cy + (alongX ? 0.5 : 0));
      const seg = (b0: Bucket, y0: number, y1: number, t: number, uv: number) => {
        const [sx, sz2] = sz(L2, t);
        put(hall, b0, box(cx, (y0 + y1) / 2, cy, sx, y1 - y0, sz2, uv));
      };
      seg('damask', 1.1, H, WALL_T, 0.75);
      seg('wood', 0.16, 1.1, WALL_T + 0.05, 1.1);
      seg('skirt', 0, 0.2, WALL_T + 0.08, 1);
      seg('goldRail', 1.08, 1.16, WALL_T + 0.1, 0.3);
      seg('marble', H - 1.05, H - 0.55, WALL_T + 0.04, 1.5);
      seg('goldRail', H - 1.12, H - 1.04, WALL_T + 0.09, 0.3);
      // Soft contact shadows on the floor along both faces.
      for (const side of [1, -1]) {
        const nx = alongX ? 0 : side;
        const ny = alongX ? side : 0;
        const o = WALL_T / 2 + 0.04;
        const p0 = v3(a.x + nx * o, 0.006, a.y + ny * o);
        const p1 = v3(b.x + nx * o, 0.006, b.y + ny * o);
        put(hall, 'shade', this.strip(p0, p1, v3(nx, 0, ny), 0.55));
      }
    }

    // Doors: marble surrounds, lintels, signs, closed doors to other wings.
    for (const d of L.doors) this.buildDoor(d, put);

    // Pictures.
    for (const f of L.frames) this.buildFrame(f, put);

    // Pilasters between pictures on each wall.
    const groups = new Map<string, Frame[]>();
    for (const f of L.frames) {
      const k = `${f.hall}:${f.normal.x}:${f.normal.y}:${(f.normal.x ? f.at.x : f.at.y).toFixed(2)}`;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    const hallH = (i: number) => L.halls[i]?.height ?? 6.5;
    for (const list of groups.values()) {
      const along = (f: Frame) => (f.normal.x ? f.at.y : f.at.x);
      const sorted = [...list].sort((p, q) => along(p) - along(q));
      for (let i = 1; i < sorted.length; i++) {
        const p = sorted[i - 1];
        const q = sorted[i];
        const gap = along(q) - along(p) - (p.w / 2 + p.border + q.w / 2 + q.border);
        if (gap < 1.0) continue;
        const m = (along(p) + along(q)) / 2;
        const at = p.normal.x ? { x: p.at.x, y: m } : { x: m, y: p.at.y };
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
    const grandH = L.halls[0]?.height ?? 8;
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

    // Velvet ropes on brass posts.
    const post = stanchion();
    for (const r of L.ropes) {
      const h = hallOf(r.a.x, r.a.y);
      const ends = [r.a, { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 }, r.b];
      for (const e of ends) {
        put(h, 'gold', post.clone().translate(e.x, 0, e.y));
        put(h, 'shade', this.blobGeo(e.x, e.y, 0.5));
      }
      for (let i = 0; i < 2; i++) {
        put(h, 'velvet', rope(v3(ends[i].x, 0.94, ends[i].y), v3(ends[i + 1].x, 0.94, ends[i + 1].y)));
      }
    }
    post.dispose();

    // Merge per hall and material.
    buckets.forEach((m) => {
      for (const [b, list] of m) {
        const g = merge(list);
        if (!g) continue;
        const mesh = new THREE.Mesh(g, this.mats.get(b)!);
        if (b === 'shade' || b === 'pool') mesh.renderOrder = 1;
        mesh.matrixAutoUpdate = false;
        this.scene.add(mesh);
      }
    });

    this.buildChandeliers();
    this.buildLights();
    if (this.quality === 'high') this.buildMirror();
  }

  /** Soft reflections in the polished floor (high quality only): a half-size mirror added on top. */
  private buildMirror() {
    const b = this.layout.bounds;
    const g = new THREE.PlaneGeometry(b.x1 - b.x0 + 2, b.y1 - b.y0 + 2);
    const pr = this.renderer.getPixelRatio();
    const w = Math.max(64, Math.round((this.canvas.clientWidth || 800) * pr * 0.5));
    const h = Math.max(64, Math.round((this.canvas.clientHeight || 600) * pr * 0.5));
    const m = new Reflector(g, { textureWidth: w, textureHeight: h, clipBias: 0.003, multisample: 0, shader: FLOOR_MIRROR, color: 0xfff4e6 });
    m.rotation.x = -Math.PI / 2;
    m.position.set((b.x0 + b.x1) / 2, 0.002, (b.y0 + b.y1) / 2);
    const mat = m.material as THREE.ShaderMaterial;
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    this.scene.add(m);
    this.mirror = m;
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
    // Make it face up whatever the order.
    const a = p1.clone().sub(p0);
    const b = q0.clone().sub(p0);
    if (a.cross(b).y < 0) {
      const P = g.getAttribute('position').array as Float32Array;
      const U = g.getAttribute('uv').array as Float32Array;
      for (const t of [0, 3]) {
        for (let k = 0; k < 3; k++) [P[(t + 1) * 3 + k], P[(t + 2) * 3 + k]] = [P[(t + 2) * 3 + k], P[(t + 1) * 3 + k]];
        for (let k = 0; k < 2; k++) [U[(t + 1) * 2 + k], U[(t + 2) * 2 + k]] = [U[(t + 2) * 2 + k], U[(t + 1) * 2 + k]];
      }
    }
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

  private buildHall(h: Hall, put: (hall: number, b: Bucket, g: Geo) => void) {
    const r = h.rect;
    const e = WALL_T / 2;
    put(h.index, 'floor', flat(r.x0 - e, r.y0 - e, r.x1 + e, r.y1 + e, 0, true, 3));
    // Ceiling and gilded cornice.
    const coffer = h.grand ? GALLERY_W / 3 : GALLERY_W / 3.2;
    put(h.index, 'ceiling', flat(r.x0, r.y0, r.x1, r.y1, h.height, false, coffer));
    const iw = r.x1 - r.x0 - WALL_T;
    const ih = r.y1 - r.y0 - WALL_T;
    const P = h.grand ? 0.75 : 0.6;
    const D = h.grand ? 0.7 : 0.55;
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
      ring.scale((r.x1 - r.x0) * 0.26, 3, (r.y1 - r.y0) * 0.28);
      ring.translate(cx, h.height - 0.05, cz);
      put(h.index, 'gold', norm(ring));
      const ring2 = new THREE.TorusGeometry(1, 0.05, 8, 64);
      ring2.rotateX(Math.PI / 2);
      ring2.scale((r.x1 - r.x0) * 0.28, 2, (r.y1 - r.y0) * 0.3);
      ring2.translate(cx, h.height - 0.05, cz);
      put(h.index, 'frameGold', norm(ring2));
    }
    // The red runner down the middle (it starts at the previous hall's centre so corners join up).
    const width = h.grand ? 3.6 : 2.7;
    const back = h.index >= 2 ? GALLERY_W / 2 : 0.2;
    const start = { x: h.origin.x - h.forward.x * back, y: h.origin.y - h.forward.y * back };
    const len = h.length + back - (h.grand ? 0.2 : 0.9);
    put(h.index, 'carpet', this.runner(start, h.forward, len, width, h.index >= 2 ? 0.014 : 0.01));
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
    const e1 = b.clone().sub(a);
    const e2 = c.clone().sub(a);
    if (e1.cross(e2).y < 0) {
      // Flip winding so it faces up.
      const p = g.getAttribute('position').array as Float32Array;
      const u = g.getAttribute('uv').array as Float32Array;
      for (const t of [0, 3]) {
        for (let k = 0; k < 3; k++) [p[(t + 1) * 3 + k], p[(t + 2) * 3 + k]] = [p[(t + 2) * 3 + k], p[(t + 1) * 3 + k]];
        for (let k = 0; k < 2; k++) [u[(t + 1) * 2 + k], u[(t + 2) * 2 + k]] = [u[(t + 2) * 2 + k], u[(t + 1) * 2 + k]];
      }
    }
    return g;
  }

  /** A box aligned with a wall: centre on the plan, size along the wall × through it × height. */
  private wallBox(c: { x: number; y: number }, along: { x: number; y: number }, len: number, thick: number, y0: number, y1: number, uv = 1): Geo {
    const ax = Math.abs(along.x) > 0.5;
    return box(c.x, (y0 + y1) / 2, c.y, ax ? len : thick, y1 - y0, ax ? thick : len, uv);
  }

  private putPilaster(at: { x: number; y: number }, n: { x: number; y: number }, H: number, hall: number, put: (hall: number, b: Bucket, g: Geo) => void) {
    const p = pilaster(H - 1.12);
    const ry = Math.atan2(n.x, n.y);
    for (const [g, b] of [[p.marble, 'marble'], [p.gold, 'frameGold'], [p.base, 'skirt']] as const) {
      g.rotateY(ry);
      g.translate(at.x, 0, at.y);
      put(hall, b, g);
    }
  }

  private buildDoor(d: Door, put: (hall: number, b: Bucket, g: Geo) => void) {
    const { at, along, inward } = d;
    const hw = d.width / 2;
    const off = (t: number, n = 0) => ({ x: at.x + along.x * t + inward.x * n, y: at.y + along.y * t + inward.y * n });
    // Lintel wall above the opening.
    put(d.hall, 'damask', this.wallBox(at, along, d.width, WALL_T, d.height, d.wallHeight, 0.75));
    // Marble surround: jambs and a head, through the wall, gold inner trim.
    const jw = 0.34;
    const depth = WALL_T + 0.16;
    for (const s of [-1, 1]) {
      put(d.hall, 'marble', this.wallBox(off(s * (hw + jw / 2)), along, jw, depth, 0, d.height + 0.42, 1));
      put(d.hall, 'gold', this.wallBox(off(s * (hw + 0.03)), along, 0.06, depth + 0.04, 0.2, d.height, 0.5));
      put(d.hall, 'gold', this.wallBox(off(s * (hw + jw + 0.03)), along, 0.06, depth + 0.02, 0.2, d.height + 0.42, 0.5));
    }
    put(d.hall, 'marble', this.wallBox(at, along, d.width + 2 * jw, depth, d.height, d.height + 0.42, 1));
    put(d.hall, 'gold', this.wallBox(at, along, d.width + 0.12, depth + 0.04, d.height - 0.03, d.height + 0.05, 0.5));
    put(d.hall, 'goldRail', this.wallBox(at, along, d.width + 2 * jw + 0.3, depth + 0.12, d.height + 0.42, d.height + 0.56, 0.3));
    put(d.hall, 'skirt', this.wallBox(at, along, d.width + 2 * jw + 0.1, depth + 0.06, 0, 0.22, 1));
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
      const c = off(0, side * (depth / 2 + 0.02));
      const t = this.canvasTex(tex.sign(text[0], text[1]), false);
      const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.35, metalness: 0.2, emissive: new THREE.Color('#ffffff'), emissiveMap: t, emissiveIntensity: 0.2 });
      this.disposables.push(mat);
      const g = quad(v3(c.x, d.height + 0.95, c.y), v3(along.x, 0, along.y).multiplyScalar(side), v3(inward.x * side, 0, inward.y * side), 2.4, 0.6);
      const m = new THREE.Mesh(g, mat);
      this.scene.add(m);
      // Gilded frame round the sign.
      const n3 = v3(inward.x * side, 0, inward.y * side);
      const r3 = v3(0, 1, 0).cross(n3).normalize().negate();
      put(d.hall, 'frameGold', sweepRect(v3(c.x, d.height + 0.95, c.y), r3, v3(0, 1, 0), n3, 2.4, 0.6, frameProfile(0.08), 0.2));
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
        const hp = off(s * 0.18, 0.08);
        const hg = new THREE.SphereGeometry(0.05, 12, 8);
        hg.translate(hp.x, 1.15, hp.y);
        g.add(new THREE.Mesh(hg, this.mats.get('gold')!));
        const hp2 = off(s * 0.18, -0.08);
        const hg2 = new THREE.SphereGeometry(0.05, 12, 8);
        hg2.translate(hp2.x, 1.15, hp2.y);
        g.add(new THREE.Mesh(hg2, this.mats.get('gold')!));
      }
      this.scene.add(g);
      this.doorMeshes.push({ mesh: g, door: d });
    }
  }

  private buildFrame(f: Frame, put: (hall: number, b: Bucket, g: Geo) => void) {
    const n = v3(f.normal.x, 0, f.normal.y);
    const right = n.clone().negate().cross(v3(0, 1, 0)).normalize();
    const up = v3(0, 1, 0);
    const c = v3(f.at.x, f.z, f.at.y);
    const prof = frameProfile(f.border);
    put(f.hall, 'frameGold', sweepRect(c, right, up, n, f.w, f.h, prof, f.border * 2.2));
    // A dark backing so nothing shows between frame and picture.
    put(f.hall, 'wood', norm(quad(c.clone().addScaledVector(n, 0.004), right, n, f.w + 0.04, f.h + 0.04)));
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
        const ro = new THREE.SphereGeometry(f.border * 0.32, 12, 8);
        ro.scale(1, 1, 0.45);
        ro.rotateY(Math.atan2(n.x, n.z));
        put(f.hall, 'frameGold', norm(ro.translate(p.x, p.y, p.z)));
      }
    }
    // Picture lamp above the frame.
    const lampY = f.z + f.h / 2 + f.border + 0.16;
    const lampW = Math.max(0.35, f.w * 0.5);
    const lp = c.clone().setY(lampY).addScaledVector(n, 0.24);
    const bar = new THREE.CylinderGeometry(0.035, 0.035, lampW, 12);
    bar.rotateZ(Math.PI / 2);
    bar.rotateY(Math.atan2(n.x, n.z));
    put(f.hall, 'gold', norm(bar.translate(lp.x, lp.y, lp.z)));
    const arm = new THREE.CylinderGeometry(0.012, 0.012, 0.28, 8);
    arm.rotateX(Math.PI / 2);
    arm.rotateY(Math.atan2(n.x, n.z));
    const ap = c.clone().setY(lampY + 0.04).addScaledVector(n, 0.12);
    put(f.hall, 'gold', norm(arm.translate(ap.x, ap.y, ap.z)));
    // Light pool on the wall around and above the picture.
    const pw = f.w + f.border * 2 + 1.1;
    const ph = f.h + f.border * 2 + 0.9;
    put(f.hall, 'pool', quad(c.clone().addScaledVector(up, 0.25).addScaledVector(n, 0.003), right, n, pw, ph));
    // Plaque below (on the panelling).
    const py = Math.max(0.78, f.z - f.h / 2 - f.border - 0.2);
    const pa = c.clone().setY(py).addScaledVector(n, 0.035);
    const plw = f.featured ? 0.5 : 0.36;
    const plh = plw * 0.3125;
    put(f.hall, 'plaque', this.wallBox({ x: pa.x - n.x * 0.015, y: pa.z - n.z * 0.015 }, { x: right.x, y: right.z }, plw + 0.03, 0.02, py - plh / 2 - 0.015, py + plh / 2 + 0.015, 0.3));

    // The picture itself, with a gentle top-lit gradient.
    const pg = quad(c.clone().addScaledVector(n, f.border * 0.62 * 0.12), right, n, f.w, f.h);
    const col = new Float32Array(6 * 3);
    const posA = pg.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < 6; i++) {
      const t = (posA.getY(i) - (f.z - f.h / 2)) / f.h;
      const k = 0.8 + 0.2 * t;
      col.set([k, k * 0.985, k * 0.95], i * 3);
    }
    pg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.MeshBasicMaterial({ map: this.placeholder, vertexColors: true, toneMapped: false });
    const mesh = new THREE.Mesh(pg, mat);
    mesh.userData.frame = f;
    this.scene.add(mesh);
    this.slots.push({
      frame: f, mesh, mat, thumb: null, full: null, video: null, videoTex: null, loadingThumb: false, loadingFull: false, dist: Infinity,
      plaque: null, plaqueAt: pa.clone().addScaledVector(n, 0.012), right, normal: n, gen: 0,
    });
  }

  private buildChandeliers() {
    const L = this.layout;
    const list: { x: number; y: number; scale: number; ceil: number }[] = [];
    for (const h of L.halls) for (const c of h.chandeliers) list.push({ ...c, ceil: h.height });
    if (!list.length) return;
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
    const shared = [ch.brass, ch.crystal, ch.candle, ch.flame, chLo.brass, chLo.crystal, chLo.candle, chLo.flame, chainG];
    this.disposables.push(...shared);
    const m4 = new THREE.Matrix4();
    const halo: number[] = [];
    const glint: number[] = [];
    const phase: number[] = [];
    // One small set of instanced meshes per hall, so halls out of sight are skipped,
    // with a simpler chandelier for the far halls.
    for (const h of L.halls) {
      const cs = h.chandeliers;
      if (!cs.length) continue;
      const make = (g: Geo, m: THREE.Material) => {
        const im = new THREE.InstancedMesh(g, m, cs.length);
        im.userData.shared = true;
        this.scene.add(im);
        return im;
      };
      const hi = [make(ch.brass, mats.brass), make(ch.crystal, mats.crystal), make(ch.candle, mats.candle), make(ch.flame, mats.flame)];
      const lo = [make(chLo.brass, mats.brass), make(chLo.crystal, mats.crystal), make(chLo.candle, mats.candle), make(chLo.flame, mats.flame)];
      const chain = make(chainG, mats.brass);
      cs.forEach((c, i) => {
        const bottom = h.height - 2.3 * c.scale - (h.height > 7 ? 0.6 : 0.2);
        const y = bottom + 0.72 * c.scale;
        m4.compose(v3(c.x, y, c.y), new THREE.Quaternion(), v3(c.scale, c.scale, c.scale));
        for (const p of [...hi, ...lo]) p.setMatrixAt(i, m4);
        const top = y + ch.top * c.scale;
        m4.compose(v3(c.x, top, c.y), new THREE.Quaternion(), v3(1, Math.max(0.05, h.height - top), 1));
        chain.setMatrixAt(i, m4);
        this.chandeliers.push(v3(c.x, y + 0.1, c.y));
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
      const cx = (h.rect.x0 + h.rect.x1) / 2;
      const cy = (h.rect.y0 + h.rect.y1) / 2;
      this.lods.push({ x: cx, y: cy, r: Math.hypot(h.rect.x1 - h.rect.x0, h.rect.y1 - h.rect.y0) / 2, hi, lo });
    }
    // Soft halos round the flames.
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(halo, 3));
    const glowT = this.canvasTex(tex.glow(), false);
    const hm = new THREE.PointsMaterial({ map: glowT, size: 0.32, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color('#ffc477'), opacity: 0.7 });
    this.disposables.push(hm);
    this.scene.add(new THREE.Points(hg, hm));
    // Twinkling glints on the crystals.
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(glint, 3));
    gg.setAttribute('phase', new THREE.Float32BufferAttribute(phase, 1));
    this.sparkle = new THREE.ShaderMaterial({
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
    this.disposables.push(this.sparkle);
    this.scene.add(new THREE.Points(gg, this.sparkle));
  }

  private buildLights() {
    const high = this.quality === 'high';
    this.scene.add(new THREE.HemisphereLight(0xfff0dc, 0x3a1810, 0.35));
    const n = high ? 4 : 2;
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffc98a, 0, 22, 1.6);
      this.lights.push(l);
      this.scene.add(l);
    }
  }

  // ---- per frame ----------------------------------------------------------------------------

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.mirror?.getRenderTarget().setSize(Math.round(w * pr * 0.5), Math.round(h * pr * 0.5));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.sparkle) this.sparkle.uniforms.scale.value = h / 600;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    this.renderer.info.reset();
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.move(dt);
    this.applyPose();
    const t = this.time;
    if (this.sparkle) this.sparkle.uniforms.time.value = t;
    if ((this.streamTick += dt) > 0.3) {
      this.streamTick = 0;
      this.stream(false);
    }
    if ((this.lightTick += dt) > 0.2) {
      this.updateLights(false, this.lightTick);
      this.lightTick = 0;
    }
    this.fadeLights(dt);
    if ((this.aimTick += dt) > 0.08) {
      this.aimTick = 0;
      const a = this.pick({ x: 0, y: 0 });
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
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = fast ? 5.2 : 2.3;
    const len = Math.hypot(fx, fz) || 1;
    const sy = Math.sin(this.pose.yaw);
    const cy = Math.cos(this.pose.yaw);
    // Forward is (-sin yaw, -cos yaw) on the plan; right is (cos yaw, -sin yaw).
    const tx = ((-sy * fz + cy * fx) / len) * speed;
    const ty = ((-cy * fz - sy * fx) / len) * speed;
    const a = 1 - Math.exp(-dt * 9);
    this.vel.x += (tx - this.vel.x) * a;
    this.vel.y += (ty - this.vel.y) * a;
    if (Math.abs(this.vel.x) < 1e-4 && Math.abs(this.vel.y) < 1e-4) return;
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

  private applyPose() {
    // A barely-there sway while walking.
    const speed = this.vel.length();
    const bob = Math.sin(this.time * 8.5) * 0.012 * Math.min(1, speed / 2.3);
    this.camera.position.set(this.pose.x, EYE + bob, this.pose.y);
    this.camera.rotation.set(this.pose.pitch, this.pose.yaw, 0);
  }

  private pick(ndc: { x: number; y: number }): Aim {
    this.ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    this.ray.far = 9;
    const targets: THREE.Object3D[] = [];
    for (const s of this.slots) if (s.dist < 10) targets.push(s.mesh);
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
    const a = { x: this.pose.x, y: this.pose.y };
    const b = { x: p.x, y: p.z };
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

  private updateLights(now: boolean, dt = 0) {
    void dt;
    const cam = this.camera.position;
    const look = new THREE.Vector3(-Math.sin(this.pose.yaw), 0, -Math.cos(this.pose.yaw));
    const scored = this.chandeliers
      .map((c) => {
        const d = c.clone().sub(cam);
        const dist = Math.hypot(d.x, d.z);
        // Prefer the ones in front of you.
        const front = (d.x * look.x + d.z * look.z) / (dist || 1);
        return { c, s: dist - front * 3 };
      })
      .sort((p, q) => p.s - q.s)
      .slice(0, this.lights.length);
    // Keep lights on chandeliers that stay chosen; move the others.
    const free = this.lights.filter((l) => !scored.some((x) => x.c.distanceToSquared(l.position) < 0.01));
    for (const x of scored) {
      if (this.lights.some((l) => l.position.distanceToSquared(x.c) < 0.01)) continue;
      const l = free.shift();
      if (!l) break;
      l.position.copy(x.c);
      l.userData.target = 1;
      if (now) l.intensity = this.lightPower();
      else l.intensity = 0;
    }
    for (const l of this.lights) l.userData.target = scored.some((x) => x.c.distanceToSquared(l.position) < 0.01) ? 1 : 0;
  }

  private lightPower() {
    return this.quality === 'high' ? 16 : 20;
  }

  private fadeLights(dt: number) {
    const P = this.lightPower();
    for (const l of this.lights) {
      const t = (l.userData.target ?? 0) * P;
      l.intensity += (t - l.intensity) * Math.min(1, dt * 3);
    }
  }

  // ---- streaming pictures ---------------------------------------------------------------------

  private stream(first: boolean) {
    const px = this.pose.x;
    const py = this.pose.y;
    for (const l of this.lods) {
      const near = Math.hypot(l.x - px, l.y - py) - l.r < 12;
      for (const o of l.hi) o.visible = near;
      for (const o of l.lo) o.visible = !near;
    }
    for (const s of this.slots) s.dist = Math.hypot(s.frame.at.x - px, s.frame.at.y - py);
    const sorted = [...this.slots].sort((a, b) => a.dist - b.dist);
    const high = this.quality === 'high';
    const THUMB_IN = 30;
    const THUMB_OUT = 40;
    const MAX_THUMBS = high ? 70 : 45;
    const FULL_IN = 7;
    const MAX_FULL = high ? 4 : 2;
    const MAX_VIDEO = high ? 3 : 2;
    let fulls = 0;
    let videos = 0;
    sorted.forEach((s, rank) => {
      const isVideo = s.frame.item.kind === 'video';
      const wantThumb = (s.dist < THUMB_IN || (s.thumb && s.dist < THUMB_OUT)) && rank < MAX_THUMBS;
      let wantFull = false;
      let wantVideo = false;
      if (isVideo) wantVideo = s.dist < 14 && videos++ < MAX_VIDEO;
      else wantFull = s.dist < FULL_IN && fulls++ < MAX_FULL;
      // Plaques close by.
      if (s.dist < 13 && !s.plaque) this.makePlaque(s);
      else if (s.dist > 20 && s.plaque) this.dropPlaque(s);

      if (wantVideo && !s.video) this.startVideo(s);
      else if (!wantVideo && s.video) this.stopVideo(s);
      if (wantFull && !s.full && !s.loadingFull && this.loads < 3) this.loadFull(s);
      else if (!wantFull && s.full) {
        s.full.dispose();
        s.full = null;
        this.show(s);
      }
      if ((wantThumb || wantFull || wantVideo) && !s.thumb && !s.loadingThumb && (this.loads < 3 || first)) this.loadThumb(s);
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

  private toTex(src: TexImageSource, w: number, h: number, s: Slot): THREE.Texture {
    const t = new THREE.Texture(src as HTMLImageElement);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(4, this.anisotropy);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    cover(t, w, h, s.frame.w, s.frame.h);
    t.needsUpdate = true;
    return t;
  }

  private async loadThumb(s: Slot) {
    s.loadingThumb = true;
    this.loads++;
    const gen = s.gen;
    try {
      const img = await loadImage(this.sources.thumb(s.frame.item.id));
      if (this.disposed || gen !== s.gen) return;
      s.thumb = this.toTex(fit(img, 1024), img.naturalWidth, img.naturalHeight, s);
      this.show(s);
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
      const img = await loadImage(this.sources.full(s.frame.item.id));
      if (this.disposed || gen !== s.gen || s.dist > 9) return;
      s.full = this.toTex(fit(img, this.maxFull), img.naturalWidth, img.naturalHeight, s);
      this.show(s);
    } catch {
      /* stay on the thumbnail */
    } finally {
      s.loadingFull = false;
      this.loads--;
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
    v.play().catch(() => {});
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
    const plw = s.frame.featured ? 0.5 : 0.36;
    const g = quad(s.plaqueAt, s.right, s.normal, plw, plw * 0.3125);
    const m = new THREE.MeshStandardMaterial({ map: t, metalness: 0.55, roughness: 0.32, envMapIntensity: 1.2, emissive: new THREE.Color('#ffffff'), emissiveMap: t, emissiveIntensity: 0.12 });
    s.plaque = new THREE.Mesh(g, m);
    this.scene.add(s.plaque);
  }

  private dropPlaque(s: Slot) {
    const p = s.plaque;
    if (!p) return;
    this.scene.remove(p);
    p.geometry.dispose();
    const m = p.material as THREE.MeshStandardMaterial;
    m.map?.dispose();
    m.dispose();
    s.plaque = null;
  }

  private dropAll(s: Slot) {
    s.gen++;
    this.stopVideo(s);
    s.thumb?.dispose();
    s.full?.dispose();
    s.thumb = s.full = null;
    this.dropPlaque(s);
    s.mat.dispose();
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
function segX(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): boolean {
  const o = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
