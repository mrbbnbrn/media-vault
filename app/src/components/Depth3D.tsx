// 3D photos: the picture drawn again with WebGL, moved with gentle depth
// parallax (a slow camera orbit, swing or dolly of a few per cent). It lies
// exactly over the plain picture (ImageStage) and starts and ends exactly
// like it, so it can appear and disappear without a jump; until the depth
// map and the picture are both ready (or if WebGL isn't there), the plain
// picture simply shows.
//
// Edges: the shader marches from near to far through the depth map and
// shows the first surface it meets, so near things cover what's behind
// them; where the background is uncovered it is stretched a little (the
// depth map's near things are grown and softened in depth.rs, so that
// stretch lands in the background, not on a face). The picture is enlarged
// just enough that its own edges never show.
//
// Subject effects (still pictures only): with Lift-off or Living subject on,
// a third texture holds the subject's outline (subject.ts). The subject is
// drawn again on top of the 3D picture, moved as one piece with the camera at
// its own depth: lifted (a little bigger, with a soft shadow that falls only
// on the background) and/or breathing and swaying around its bottom middle.
// The outline it is drawn with is grown a little, so the subject's old edge
// never shows from behind it. Without a depth map these work on a flat one.
//
// Everything stays in memory (one texture, one small depth texture, one
// outline), and the WebGL context is let go when the picture changes.

import { useEffect, useRef, useState } from 'react';
import { inTauri, type DepthInfo, type DepthMap, type ViewerSettings } from '../api';
import {
  cameraAt, depthChoice, depthFramesLetGo, depthLetGo, depthOf, depthOfFrames, depthPack, DOLLY, easeToward, frameDepth, framePose, mouseLean, mousePose,
  NO_DEPTH_PACK, pivotOf, scalePose, sharedCamera, SHIFT, blendDepth, depthForTime, VIDEO_DEPTH_MS, videoFrameDepth,
  type FrameDepths, type FrameFeed, type MotionChoice, type Pose,
} from '../depth';
import { drawnRect } from '../flip';
import {
  fadeAt, fadeDone, fadeTo, flatDepth, maskStats, newFade, subjectDepth, subjectFrame, subjectLetGo, subjectOf,
  type SubjectStats,
} from '../subject';
import { DepthModelChoice } from './DepthModels';
import { SubjectModelChoice } from './SubjectModels';

interface Props {
  src: string;
  /** The picture's own size (as shown, after its EXIF orientation). */
  natural: { w: number; h: number };
  fit: 'contain' | 'cover';
  /** How long this picture stays (ms; not used by the movement any more, which carries on from picture to picture). */
  showMs?: number;
  /** Paused: the camera waits. */
  halted: boolean;
  /** Same light sharpening as the plain picture. */
  sharpen: boolean;
  /** Told once the moving picture is showing (true) or given up (false). */
  onLive?: (live: boolean) => void;
  /** How strong the depth is (1 = as designed; View ▾ → 3D photos → 3D depth). */
  amount?: number;
  /** Follow the mouse instead of moving on its own; `react` = how strongly (1 = the edge of the picture leans all the way). */
  mouse?: { react: number };
  /** The automatic movement: its shape, how far (1 = as designed) and how fast (1 = as designed). */
  motion?: { shape: MotionChoice; amount: number; speed: number };
  /** Not in a slideshow (kept for callers; the movement is the same either way). */
  endless?: boolean;
  /** A moving picture (GIF, animated WebP/PNG): each frame as it's shown, drawn with that frame's own depth. */
  frames?: FrameFeed;
  /** A video: drawn frame by frame from the playing video with live depth; `delayMs` shows each frame that much later so it meets its own depth (0 = off). */
  video?: { ref: { current: HTMLVideoElement | null }; delayMs: number };
  /** 3D to the beat: `pulse` goes up by one on every beat; a push closer or a little bounce, this strong (1 = as designed). */
  beat?: { pulse: number; kind: 'push' | 'bounce'; amount: number };
  /** Subject effects (still pictures only; ignored for GIFs and videos): each 0 = off, else its amount (1 = as designed). */
  subject?: { lift: number; living: number };
  /** The depth map is wanted (false: the camera stays still anyway, so a flat one is used without asking). */
  depth?: boolean;
  /** The subject model and size in use (the outline is worked out again when it changes). */
  subjectModel?: string;
}

/** How far a beat pulse is (0–1) `dt` ms after the beat: a quick rise, a softer fall. */
export function beatEnvelope(dt: number): number {
  if (!(dt >= 0) || dt > BEAT_MS) return 0;
  return Math.min(1, 1.6 * (1 - Math.exp(-dt / 35)) * Math.exp(-dt / 170));
}
const BEAT_MS = 700;

/** A pose with the beat's push or bounce added. */
export function withBeat(p: Pose, kind: 'push' | 'bounce', amount: number, e: number): Pose {
  if (!e || !amount) return p;
  return kind === 'push' ? { ...p, dolly: p.dolly + DOLLY * 0.6 * amount * e } : { ...p, y: p.y - SHIFT * 0.7 * amount * e };
}

/** Lift-off was last fully up on this picture (and when it was let go): opened again at once (e.g. a 3D switch changed), it stays up. */
const lifted = { src: '', at: -Infinity };

/** With the 3D button: where the mouse points (want) and where the camera is (lean), kept from picture to picture. */
const mouseCam = { lean: { x: 0, y: 0 }, want: { x: 0, y: 0 } };
const STEPS = 14;

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uImg;
uniform sampler2D uDepth;
uniform vec2 uShift;
uniform float uDolly;
uniform float uScale;
uniform float uPivot;
uniform vec2 uFocus;
uniform vec2 uPx;
uniform float uSharp;
// Subject effects: the outline, whether the subject layer is drawn, the picture's shape (width / height),
// the lift (centre, scale), the living sway and breathing (pivot, cos/sin, scale), the grown outline,
// the shadow (darkness, offset, softness) and the subject's own depth.
uniform sampler2D uMask;
uniform float uSubj;
uniform float uAsp;
uniform vec2 uCen;
uniform float uLift;
uniform vec2 uBot;
uniform vec2 uRot;
uniform float uBreath;
uniform float uGrow;
uniform float uShadow;
uniform vec2 uShOff;
uniform float uShBlur;
uniform float uZSubj;
const int N = ${STEPS};
vec3 pic(vec2 h) {
  vec3 c = texture2D(uImg, h).rgb;
  if (uSharp > 0.0) {
    // The same light sharpening as the plain picture (0 -a 0 / -a 1+4a -a / 0 -a 0), one screen pixel apart.
    vec2 d = uPx / uScale;
    vec3 n = texture2D(uImg, h + vec2(d.x, 0.0)).rgb + texture2D(uImg, h - vec2(d.x, 0.0)).rgb
      + texture2D(uImg, h + vec2(0.0, d.y)).rgb + texture2D(uImg, h - vec2(0.0, d.y)).rgb;
    c = clamp(c * (1.0 + 4.0 * uSharp) - n * uSharp, 0.0, 1.0);
  }
  return c;
}
// Where the moved subject at q came from (the reverse of the lift, then of the sway and breathing).
vec2 unmove(vec2 q) {
  vec2 a = vec2((q.x - uBot.x) * uAsp, q.y - uBot.y);
  a = vec2(uRot.x * a.x + uRot.y * a.y, -uRot.y * a.x + uRot.x * a.y) / uBreath;
  vec2 l = uBot + vec2(a.x / uAsp, a.y);
  return uCen + (l - uCen) / uLift;
}
float mask(vec2 s) {
  return texture2D(uMask, clamp(s, 0.0, 1.0)).r;
}
void main() {
  vec2 p = 0.5 + (vUv - 0.5) / uScale;
  vec2 k = uShift + (p - uFocus) * uDolly;
  // From the nearest depth to the farthest: the first surface met is the one seen.
  vec2 hit = p + k * uPivot;
  float prevZ = 1.0;
  float prevDiff = -1.0;
  for (int i = 0; i <= N; i++) {
    float z = 1.0 - float(i) / float(N);
    vec2 s = p - k * (z - uPivot);
    float diff = texture2D(uDepth, s).r - z;
    if (diff >= 0.0) {
      if (i == 0) {
        hit = s;
      } else {
        float t = prevDiff / (prevDiff - diff);
        hit = p - k * (mix(prevZ, z, t) - uPivot);
      }
      break;
    }
    prevDiff = diff;
    prevZ = z;
  }
  vec2 h = clamp(hit, 0.0, 1.0);
  vec3 c = pic(h);
  if (uSubj > 0.0) {
    // The subject moves as one piece with the camera at its own depth, then is lifted and/or lives.
    vec2 ps = p - k * (uZSubj - uPivot);
    vec2 s = unmove(ps);
    float m = mask(s);
    // Drawn with a slightly grown outline (the most of the outline nearby), so its old edge never peeks out.
    float g = m;
    if (uGrow > 0.0) {
      for (int i = 0; i < 12; i++) {
        float an = float(i) * 0.5235988;
        vec2 dir = vec2(cos(an) / uAsp, sin(an)) * uGrow;
        g = max(g, max(mask(s + dir), mask(s + dir * 0.5)));
      }
    }
    vec3 sc = pic(clamp(s, 0.0, 1.0));
    vec3 o = mix(c, sc, g);
    if (uShadow > 0.0) {
      // A soft shadow down and to the right of the lifted subject, on the background only.
      vec2 s2 = unmove(ps - uShOff);
      float sh = mask(s2) * 0.16;
      for (int i = 0; i < 12; i++) {
        float an = float(i) * 0.5235988;
        vec2 dir = vec2(cos(an) / uAsp, sin(an)) * uShBlur;
        sh += mask(s2 + dir) * 0.04 + mask(s2 + dir * 0.5) * 0.03;
      }
      o *= 1.0 - uShadow * min(1.0, sh) * (1.0 - m);
    }
    c = o;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

type Gl = WebGLRenderingContext;

interface Scene {
  gl: Gl;
  prog: WebGLProgram;
  buf: WebGLBuffer;
  img: WebGLTexture;
  depth: WebGLTexture;
  mask: WebGLTexture;
  u: Record<'shift' | 'dolly' | 'scale' | 'pivot' | 'focus' | 'img' | 'depth' | 'px' | 'sharp' | 'mask' | 'subj' | 'asp' | 'cen' | 'lift' | 'bot' | 'rot'
    | 'breath' | 'grow' | 'shadow' | 'shOff' | 'shBlur' | 'zSubj', WebGLUniformLocation | null>;
}

/**
 * One drawing surface (canvas + WebGL) shared by every picture: making a new
 * one for each picture made some graphics cards flash white for a frame when
 * going to the next picture. The canvas moves into whichever picture is
 * showing; only a second 3D picture at the same time gets its own.
 */
let shared: { canvas: HTMLCanvasElement; scene: Scene } | null = null;
let sharedBusy = false;

function newCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'depth3d';
  c.setAttribute('aria-hidden', 'true');
  return c;
}

/** A surface to draw on: the shared one when it's free, else one of its own (`own`). */
function takeSurface(): { canvas: HTMLCanvasElement; scene: Scene; own: boolean } | null {
  if (shared && !sharedBusy && !shared.scene.gl.isContextLost()) {
    sharedBusy = true;
    return { ...shared, own: false };
  }
  const own = !!shared && sharedBusy;
  const canvas = newCanvas();
  const scene = makeScene(canvas);
  if (!scene) return null;
  if (!own) {
    shared = { canvas, scene };
    sharedBusy = true;
    canvas.addEventListener('webglcontextlost', () => {
      if (shared?.canvas === canvas) {
        shared = null;
        sharedBusy = false;
      }
    });
  }
  return { canvas, scene, own };
}

/** Done with a surface: the shared one is emptied and kept; one of its own is freed. */
function giveBack(t: { canvas: HTMLCanvasElement; scene: Scene; own: boolean }) {
  const { gl } = t.scene;
  if (!gl.isContextLost()) {
    gl.viewport(0, 0, t.canvas.width, t.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  t.canvas.remove();
  if (t.own) dropScene(t.scene);
  else if (shared?.canvas === t.canvas) sharedBusy = false;
}

/** This picture and its depth map into the surface's textures. */
function upload(s: Scene, picture: TexImageSource, map: DepthMap) {
  uploadPicture(s, picture);
  uploadDepth(s, map);
}

/** A (new) picture or frame into the picture texture. */
function uploadPicture(s: Scene, picture: TexImageSource) {
  const { gl } = s;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.img);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
}

/** A subject outline into the outline texture. */
function uploadMask(s: Scene, map: DepthMap) {
  const { gl } = s;
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, s.mask);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, map.w, map.h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, map.data);
}

/** A depth map into the depth texture. */
function uploadDepth(s: Scene, map: DepthMap) {
  const { gl } = s;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, s.depth);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, map.w, map.h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, map.data);
}

function compile(gl: Gl, type: number, text: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, text);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function texture(gl: Gl): WebGLTexture | null {
  const t = gl.createTexture();
  if (!t) return null;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

function makeScene(canvas: HTMLCanvasElement): Scene | null {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false }) as Gl | null;
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  if (!buf) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  const img = texture(gl);
  if (!img) return null;
  gl.activeTexture(gl.TEXTURE1);
  const depth = texture(gl);
  if (!depth) return null;
  gl.activeTexture(gl.TEXTURE2);
  const mask = texture(gl);
  if (!mask) return null;
  const u = {
    shift: gl.getUniformLocation(prog, 'uShift'),
    dolly: gl.getUniformLocation(prog, 'uDolly'),
    scale: gl.getUniformLocation(prog, 'uScale'),
    pivot: gl.getUniformLocation(prog, 'uPivot'),
    focus: gl.getUniformLocation(prog, 'uFocus'),
    img: gl.getUniformLocation(prog, 'uImg'),
    depth: gl.getUniformLocation(prog, 'uDepth'),
    px: gl.getUniformLocation(prog, 'uPx'),
    sharp: gl.getUniformLocation(prog, 'uSharp'),
    mask: gl.getUniformLocation(prog, 'uMask'),
    subj: gl.getUniformLocation(prog, 'uSubj'),
    asp: gl.getUniformLocation(prog, 'uAsp'),
    cen: gl.getUniformLocation(prog, 'uCen'),
    lift: gl.getUniformLocation(prog, 'uLift'),
    bot: gl.getUniformLocation(prog, 'uBot'),
    rot: gl.getUniformLocation(prog, 'uRot'),
    breath: gl.getUniformLocation(prog, 'uBreath'),
    grow: gl.getUniformLocation(prog, 'uGrow'),
    shadow: gl.getUniformLocation(prog, 'uShadow'),
    shOff: gl.getUniformLocation(prog, 'uShOff'),
    shBlur: gl.getUniformLocation(prog, 'uShBlur'),
    zSubj: gl.getUniformLocation(prog, 'uZSubj'),
  };
  gl.uniform1i(u.img, 0);
  gl.uniform1i(u.depth, 1);
  gl.uniform1i(u.mask, 2);
  gl.uniform1f(u.subj, 0);
  gl.clearColor(0, 0, 0, 0);
  const s: Scene = { gl, prog, buf, img, depth, mask, u };
  uploadMask(s, { w: 1, h: 1, data: new Uint8Array([0]) });
  return s;
}

function dropScene(s: Scene) {
  const { gl } = s;
  gl.deleteTexture(s.img);
  gl.deleteTexture(s.depth);
  gl.deleteTexture(s.mask);
  gl.deleteBuffer(s.buf);
  gl.deleteProgram(s.prog);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
}

/** Settings → 3D photos: whether a depth pack is there, the depth model and detail, and speed tests. */
export function DepthSection(props: { viewer: ViewerSettings; setViewer: (patch: Partial<ViewerSettings>) => void }) {
  const [info, setInfo] = useState<DepthInfo | null>(null);
  const { model, detail } = depthChoice(props.viewer);
  useEffect(() => {
    let alive = true;
    depthPack(true, { model, detail }).then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [model, detail]);
  return (
    <section className="section">
      <h2>3D photos</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        Still pictures can move gently in depth, as if the camera drifted a little: in slideshows, and over and over
        while a picture is open. Turn it on in the viewer under <b>View ▾ → 3D photos</b>, where you can also pick the
        motion's shape, amount and speed, or click the <b>3D</b> button to make the picture follow your mouse.
        The depth of each picture is worked out offline and kept in memory only.
      </p>
      {info && (info.available ? (
        <div className="info">
          Using {info.modelName ?? 'the depth pack'} · runs on the {info.device === 'gpu' ? 'graphics card' : 'processor'}{info.deviceKnown ? '' : info.device === 'gpu' ? ' (when it can)' : ''}.
        </div>
      ) : (
        <div className="notice">
          Depth pack not found. {info.problem && info.problem !== "The depth pack isn't installed." ? `${info.problem} ` : ''}{NO_DEPTH_PACK}
        </div>
      ))}
      <h3 style={{ margin: '14px 0 8px', fontSize: 14 }}>Depth model</h3>
      <DepthModelChoice value={props.viewer} onChange={props.setViewer} speedTests />
      <h3 style={{ margin: '18px 0 4px', fontSize: 14 }}>Subject outline model</h3>
      <p className="muted" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
        For <b>Lift-off</b> (the subject comes forward a little, with a soft shadow) and <b>Living subject</b> (it gently
        breathes and sways while the background stays still). Both are buttons next to the 3D buttons in the viewer, for
        still pictures. The outline of each picture is worked out offline and kept in memory only.
      </p>
      <SubjectModelChoice value={props.viewer} onChange={props.setViewer} speedTests />
    </section>
  );
}

export function Depth3D(props: Props) {
  /** Where the drawing surface goes (the shared canvas is moved in here). */
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [live, setLive] = useState(false);
  /** Draw again (and keep moving) once something changed. */
  const kick = useRef<() => void>(() => {});
  const propsRef = useRef(props);
  propsRef.current = props;
  /** The subject outline of this picture (subject effects; null until it comes, or when there's no clear subject). */
  const maskRef = useRef<{ src: string; mask: DepthMap; stats: SubjectStats } | null>(null);
  const subjOn = !props.frames && !props.video && !!props.subject && (props.subject.lift > 0 || props.subject.living > 0);
  // 3D to the beat: when the last beat came.
  const beatAt = useRef(-Infinity);
  const pulse = props.beat?.pulse;
  useEffect(() => {
    if (pulse == null || pulse === 0) return;
    beatAt.current = performance.now();
    kick.current();
  }, [pulse]);
  // Paused: the shared camera waits (it never jumps on afterwards).
  const clock = useRef({ halted: props.halted });
  useEffect(() => {
    clock.current.halted = props.halted;
  }, [props.halted]);
  /** The camera's clock (browser preview only: tests can set the time to look at single frames). */
  const now = () => {
    const fixed = inTauri ? undefined : (globalThis as { __mvDepthClock?: () => number }).__mvDepthClock;
    return fixed ? fixed() : performance.now();
  };

  const nw = props.natural.w;
  const nh = props.natural.h;
  useEffect(() => {
    let alive = true;
    let scene: Scene | null = null;
    let surface: ReturnType<typeof takeSurface> = null;
    let raf = 0;
    let picture: ImageBitmap | null = null;
    let stopMouse = () => {};
    let stopLost = () => {};
    let stopFrames = () => {};
    const moving = !!propsRef.current.frames;
    const vref = propsRef.current.video;
    const vid = vref?.ref.current ? { el: vref.ref.current, delayMs: vref.delayMs } : null;
    let stopVideo = () => {};
    const give = (ok: boolean) => alive && propsRef.current.onLive?.(ok);
    (async () => {
      const host = hostRef.current;
      if (!host || !nw || !nh) return give(false);
      surface = takeSurface();
      if (!surface) return give(false);
      const canvas = surface.canvas;
      host.appendChild(canvas);
      canvasRef.current = canvas;
      // The picture at the size it's drawn (never bigger than it is).
      const W = canvas.clientWidth || 1;
      const H = canvas.clientHeight || 1;
      const dpr = window.devicePixelRatio || 1;
      const box = drawnRect(W, H, nw, nh, propsRef.current.fit);
      const k = Math.min(1, (box.width * dpr) / nw, 4096 / Math.max(nw, nh));
      // A moving picture: every frame's depth first (the first frame's picture comes with the file).
      let frames: FrameDepths | null = null;
      // A video: its frames come straight from the playing video, its depth is worked out live.
      const depthCanvas = vid ? new OffscreenCanvas(1, 1) : null;
      if (vid && vid.el.readyState < 2) {
        await new Promise<void>((ok) => {
          const done = () => ok();
          vid.el.addEventListener('loadeddata', done, { once: true });
          setTimeout(done, 4000);
        });
      }
      const stillPic = !moving && !vid;
      /** A subject effect is on (still pictures only). */
      const subjWanted = () => {
        const sj = propsRef.current.subject;
        return stillPic && !!sj && (sj.lift > 0 || sj.living > 0);
      };
      const depthNow = vid
        ? videoFrameDepth(vid.el, depthCanvas!)
        : moving
          ? depthOfFrames(propsRef.current.src).then((f) => {
            frames = f;
            return f ? frameDepth(f, 0) : null;
          })
          : propsRef.current.depth === false && subjWanted() ? Promise.resolve(flatDepth()) : depthOf(propsRef.current.src, true);
      const [got, bmp] = await Promise.all([
        depthNow,
        vid ? Promise.resolve(null) : fetch(propsRef.current.src)
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
          .then((b) => createImageBitmap(b, { imageOrientation: 'from-image', resizeWidth: Math.max(1, Math.round(nw * k)), resizeHeight: Math.max(1, Math.round(nh * k)), resizeQuality: 'high' } as ImageBitmapOptions))
          .catch(() => null),
      ]);
      picture = bmp;
      if (!alive) return;
      // No depth map but a subject effect is on: a flat one, so the effects still work.
      const map = got ?? (subjWanted() ? flatDepth() : null);
      if (!map || (!bmp && !vid)) return give(false);
      const byMouse = !!propsRef.current.mouse;
      scene = surface.scene;
      try {
        upload(scene, bmp ?? vid!.el, map);
      } catch {
        return give(false);
      }
      bmp?.close();
      picture = null;
      const onLost = () => {
        cancelAnimationFrame(raf);
        if (alive) setLive(false);
      };
      canvas.addEventListener('webglcontextlost', onLost);
      stopLost = () => canvas.removeEventListener('webglcontextlost', onLost);
      // The automatic movement: one camera shared by every picture, moving on and on
      // (it carries on from the last picture; a new shape blends in). The 3D button:
      // the camera follows the mouse, also kept from picture to picture.
      let pivot = pivotOf(map);
      const s = scene;
      const { lean, want } = mouseCam;
      let lastT = performance.now();
      // Videos: live depth (smoothed over time) and, with the delay on, each frame shown a moment
      // late so it meets its own depth.
      let videoDraw: (() => void) | null = null;
      if (vid && depthCanvas) {
        const el = vid.el;
        const delay = Math.max(0, vid.delayMs);
        const maps: { at: number; map: DepthMap }[] = [{ at: el.currentTime, map }];
        let smoothed: DepthMap = map;
        let shownMap: DepthMap = map;
        let busyDepth = false;
        let lastAsk = 0;
        let lastAt = -1;
        const queue: { frame: VideoFrame; due: number; at: number }[] = [];
        const ask = async () => {
          if (!alive || busyDepth) return;
          const now = performance.now();
          // Paused on the same frame: nothing new to work out.
          if (now - lastAsk < VIDEO_DEPTH_MS || (el.paused && el.currentTime === lastAt)) return;
          busyDepth = true;
          lastAsk = now;
          const at = el.currentTime;
          try {
            const m = await videoFrameDepth(el, depthCanvas);
            if (!alive || !m) return;
            // A seek or a new scene starts fresh; otherwise blended for calm depth.
            smoothed = Math.abs(at - lastAt) > 1.5 ? m : blendDepth(smoothed, m, 0.5);
            lastAt = at;
            maps.push({ at, map: smoothed });
            while (maps.length > 12) maps.shift();
          } catch {
            /* the next frame tries again */
          } finally {
            busyDepth = false;
          }
        };
        type Rvfc = (cb: () => void) => number;
        const rvfc = (el as unknown as { requestVideoFrameCallback?: Rvfc }).requestVideoFrameCallback?.bind(el);
        let rvfcId = 0;
        const onVideoFrame = () => {
          if (!alive) return;
          if (delay > 0 && typeof VideoFrame !== 'undefined') {
            try {
              queue.push({ frame: new VideoFrame(el), due: performance.now() + delay, at: el.currentTime });
              while (queue.length > 30) queue.shift()?.frame.close();
            } catch {
              /* not ready yet */
            }
          }
          kick.current();
          if (rvfc) rvfcId = rvfc(onVideoFrame);
        };
        if (rvfc) rvfcId = rvfc(onVideoFrame);
        const poll = window.setInterval(() => void ask(), 20);
        stopVideo = () => {
          window.clearInterval(poll);
          const cancel = (el as unknown as { cancelVideoFrameCallback?: (id: number) => void }).cancelVideoFrameCallback;
          if (rvfcId && cancel) cancel.call(el, rvfcId);
          for (const q of queue) q.frame.close();
          queue.length = 0;
        };
        videoDraw = () => {
          if (s.gl.isContextLost()) return;
          let at = el.currentTime;
          try {
            if (delay > 0 && queue.length) {
              // The newest frame that is due now (older ones are dropped).
              const now = performance.now();
              let pick: { frame: VideoFrame; due: number; at: number } | null = null;
              while (queue.length && queue[0].due <= now) {
                if (pick) pick.frame.close();
                pick = queue.shift()!;
              }
              if (pick) {
                uploadPicture(s, pick.frame);
                at = pick.at;
                pick.frame.close();
              }
            } else if (el.readyState >= 2) uploadPicture(s, el);
          } catch {
            return;
          }
          const d = delay > 0 ? depthForTime(maps, at)?.map : maps[maps.length - 1]?.map;
          if (d && d !== shownMap) {
            uploadDepth(s, d);
            shownMap = d;
            // The still depth follows the scene, slowly.
            pivot = pivot * 0.8 + pivotOf(d) * 0.2;
          }
        };
      }
      // Moving pictures: each frame as it's shown, with its own depth.
      const feed = propsRef.current.frames;
      if (feed && frames) {
        const fd: FrameDepths = frames;
        let shownMap = map;
        stopFrames = feed.listen((image, index) => {
          if (!alive || s.gl.isContextLost()) return;
          try {
            uploadPicture(s, image);
            const m = frameDepth(fd, index);
            if (m && m !== shownMap) {
              uploadDepth(s, m);
              shownMap = m;
            }
          } catch {
            return; // a frame already gone: the next one comes soon
          }
          kick.current();
        });
      }
      // Subject effects: the outline shown, the subject's own depth, how far each effect is on (eased) and the Living clock.
      let shownMask: { src: string; mask: DepthMap; stats: SubjectStats } | null = null;
      let zSubj = pivot;
      const srcNow = propsRef.current.src;
      const keepLift = lifted.src === srcNow && performance.now() - lifted.at < 600;
      const liftF = newFade(0);
      const liveF = newFade(0);
      let liftAmt = 1;
      let liveAmt = 1;
      const liveStart = performance.now();
      const frame = () => {
        raf = 0;
        if (!alive) return;
        const p = propsRef.current;
        const cw = canvas.clientWidth || 1;
        const ch = canvas.clientHeight || 1;
        const r = window.devicePixelRatio || 1;
        const bw = Math.max(1, Math.round(cw * r));
        const bh = Math.max(1, Math.round(ch * r));
        if (canvas.width !== bw || canvas.height !== bh) {
          canvas.width = bw;
          canvas.height = bh;
        }
        const d = drawnRect(cw, ch, nw, nh, p.fit);
        const amount = Math.max(0, p.amount ?? 1);
        const t = performance.now();
        if (byMouse) {
          // (After a still moment the first step is one frame, not the whole pause.)
          const dt = Math.min(t - lastT, 34);
          lean.x = easeToward(lean.x, want.x, dt);
          lean.y = easeToward(lean.y, want.y, dt);
        }
        lastT = t;
        const halted = clock.current.halted;
        const base = byMouse ? mousePose(lean, amount)
          : scalePose(cameraAt(sharedCamera, p.motion?.shape ?? ('random' as MotionChoice), p.motion?.speed ?? 1, now(), !halted), amount * Math.max(0, p.motion?.amount ?? 1));
        // 3D to the beat: a push closer or a little bounce on each beat.
        const b = p.beat;
        const env = b ? beatEnvelope(t - beatAt.current) : 0;
        const pose = b ? withBeat(base, b.kind, b.amount * Math.max(0.3, amount), env) : base;
        // Held within what can be shown without the picture's edges.
        const f = framePose(pose, d.width, d.height, pivot);
        videoDraw?.();
        const { gl } = s;
        gl.clear(gl.COLOR_BUFFER_BIT);
        // Whole pixels from the top left, exactly where the plain picture is drawn (GL counts from the bottom).
        const vw = Math.round(d.width * r);
        const vh = Math.round(d.height * r);
        gl.viewport(Math.round(d.left * r), bh - Math.round(d.top * r) - vh, vw, vh);
        gl.uniform2f(s.u.shift, f.shift.x, f.shift.y);
        gl.uniform1f(s.u.dolly, f.dolly);
        gl.uniform1f(s.u.scale, f.scale);
        gl.uniform1f(s.u.pivot, pivot);
        gl.uniform2f(s.u.focus, 0.5, 0.5);
        gl.uniform2f(s.u.px, 1 / Math.max(1, vw), 1 / Math.max(1, vh));
        gl.uniform1f(s.u.sharp, p.sharpen ? 0.35 : 0);
        // Subject effects (still pictures only): Lift-off and Living subject on top of the 3D picture.
        let subjBusy = false;
        if (stillPic) {
          const mk = maskRef.current && maskRef.current.src === p.src ? maskRef.current : null;
          if (mk && mk !== shownMask) {
            uploadMask(s, mk.mask);
            shownMask = mk;
            zSubj = subjectDepth(map, mk.mask) ?? pivot;
            if (keepLift && (p.subject?.lift ?? 0) > 0) Object.assign(liftF, newFade(1));
          }
          const sj = p.subject;
          if (sj && sj.lift > 0) liftAmt = sj.lift;
          if (sj && sj.living > 0) liveAmt = sj.living;
          fadeTo(liftF, mk && sj && sj.lift > 0 ? 1 : 0, t);
          fadeTo(liveF, mk && sj && sj.living > 0 ? 1 : 0, t);
          const lv = fadeAt(liftF, t);
          const gv = fadeAt(liveF, t);
          if (lv >= 1) {
            lifted.src = p.src;
            lifted.at = Infinity;
          }
          const on = !!shownMask && (lv > 0 || gv > 0);
          gl.uniform1f(s.u.subj, on ? 1 : 0);
          if (on && shownMask) {
            const asp = d.width / Math.max(1, d.height);
            const sf = subjectFrame(shownMask.stats, asp, { level: lv, amount: liftAmt }, { level: gv, amount: liveAmt, t: t - liveStart });
            gl.uniform1f(s.u.asp, asp);
            gl.uniform2f(s.u.cen, sf.centre.x, sf.centre.y);
            gl.uniform1f(s.u.lift, sf.lift);
            gl.uniform2f(s.u.bot, sf.pivot.x, sf.pivot.y);
            gl.uniform2f(s.u.rot, Math.cos(sf.angle), Math.sin(sf.angle));
            gl.uniform1f(s.u.breath, sf.breath);
            gl.uniform1f(s.u.grow, sf.grow);
            gl.uniform1f(s.u.shadow, sf.shadow);
            gl.uniform2f(s.u.shOff, sf.shadowOffset.x, sf.shadowOffset.y);
            gl.uniform1f(s.u.shBlur, sf.shadowBlur);
            gl.uniform1f(s.u.zSubj, zSubj);
          }
          // Living keeps moving; Lift-off moves while it eases in or out.
          subjBusy = gv > 0 || !fadeDone(liftF, t) || !fadeDone(liveF, t);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        // Still (paused, done moving, or the camera has caught up with the mouse): no need to keep drawing.
        const still = byMouse ? Math.abs(lean.x - want.x) + Math.abs(lean.y - want.y) <= 0.0005 : halted;
        if (!still || env > 0 || subjBusy) raf = requestAnimationFrame(frame);
      };
      frame();
      kick.current = () => {
        if (!raf && alive) raf = requestAnimationFrame(frame);
      };
      if (byMouse) {
        const onMove = (e: PointerEvent) => {
          const b = canvas.getBoundingClientRect();
          const d = drawnRect(b.width, b.height, nw, nh, propsRef.current.fit);
          const cx = b.left + d.left + d.width / 2;
          const cy = b.top + d.top + d.height / 2;
          const r = mouseLean((e.clientX - cx) / (d.width / 2 || 1), (e.clientY - cy) / (d.height / 2 || 1), propsRef.current.mouse?.react ?? 1);
          want.x = r.x;
          want.y = r.y;
          kick.current();
        };
        // The mouse left the window: back to the middle.
        const onLeave = () => {
          want.x = 0;
          want.y = 0;
          kick.current();
        };
        window.addEventListener('pointermove', onMove);
        document.documentElement.addEventListener('pointerleave', onLeave);
        window.addEventListener('blur', onLeave);
        stopMouse = () => {
          window.removeEventListener('pointermove', onMove);
          document.documentElement.removeEventListener('pointerleave', onLeave);
          window.removeEventListener('blur', onLeave);
        };
      }
      setLive(true);
      give(true);
    })().catch(() => give(false));
    const src = propsRef.current.src;
    return () => {
      alive = false;
      if (lifted.src === src && lifted.at === Infinity) lifted.at = performance.now();
      // Left before its depth came (quick browsing): don't keep the model busy with it.
      if (moving) depthFramesLetGo(src);
      else if (!vid) depthLetGo(src);
      stopFrames();
      stopVideo();
      cancelAnimationFrame(raf);
      kick.current = () => {};
      stopMouse();
      picture?.close();
      stopLost();
      if (surface) giveBack(surface);
      canvasRef.current = null;
    };
  }, [props.src, nw, nh, !!props.mouse, !!props.video, props.video?.delayMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subject effects: this picture's outline, worked out first (the neighbours' ones are worked out ahead by the viewer).
  useEffect(() => {
    if (!subjOn) return;
    let alive = true;
    const src = props.src;
    void subjectOf(src, true).then((m) => {
      if (!alive) return;
      const stats = maskStats(m);
      maskRef.current = m && stats ? { src, mask: m, stats } : null;
      kick.current();
    });
    return () => {
      alive = false;
      subjectLetGo(src);
    };
  }, [props.src, subjOn, props.subjectModel]);

  // Resumed, resized, refitted, made stronger or a subject effect switched: draw again.
  useEffect(() => {
    kick.current();
  }, [props.halted, props.fit, props.amount, props.motion?.amount, props.motion?.speed, props.motion?.shape, props.subject?.lift, props.subject?.living]);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => kick.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={hostRef} className={`depth3d-host${live ? ' live' : ''}`} aria-hidden="true" />
  );
}
