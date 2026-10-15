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
// Everything stays in memory (one texture, one small depth texture), and the
// WebGL context is let go when the picture changes.

import { useEffect, useRef, useState } from 'react';
import { inTauri, type DepthInfo, type DepthMap, type ViewerSettings } from '../api';
import {
  cameraAt, depthChoice, depthLetGo, depthOf, depthPack, easeToward, framePose, mouseLean, mousePose, NO_DEPTH_PACK, pivotOf, scalePose,
  sharedCamera, type MotionChoice,
} from '../depth';
import { drawnRect } from '../flip';
import { DepthModelChoice } from './DepthModels';

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
}

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
const int N = ${STEPS};
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
  vec4 c = texture2D(uImg, h);
  if (uSharp > 0.0) {
    // The same light sharpening as the plain picture (0 -a 0 / -a 1+4a -a / 0 -a 0), one screen pixel apart.
    vec2 d = uPx / uScale;
    vec3 n = texture2D(uImg, h + vec2(d.x, 0.0)).rgb + texture2D(uImg, h - vec2(d.x, 0.0)).rgb
      + texture2D(uImg, h + vec2(0.0, d.y)).rgb + texture2D(uImg, h - vec2(0.0, d.y)).rgb;
    c.rgb = clamp(c.rgb * (1.0 + 4.0 * uSharp) - n * uSharp, 0.0, 1.0);
  }
  gl_FragColor = vec4(c.rgb, 1.0);
}`;

type Gl = WebGLRenderingContext;

interface Scene {
  gl: Gl;
  prog: WebGLProgram;
  buf: WebGLBuffer;
  img: WebGLTexture;
  depth: WebGLTexture;
  u: Record<'shift' | 'dolly' | 'scale' | 'pivot' | 'focus' | 'img' | 'depth' | 'px' | 'sharp', WebGLUniformLocation | null>;
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
function upload(s: Scene, picture: ImageBitmap, map: DepthMap) {
  const { gl } = s;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.img);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
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
  };
  gl.uniform1i(u.img, 0);
  gl.uniform1i(u.depth, 1);
  gl.clearColor(0, 0, 0, 0);
  return { gl, prog, buf, img, depth, u };
}

function dropScene(s: Scene) {
  const { gl } = s;
  gl.deleteTexture(s.img);
  gl.deleteTexture(s.depth);
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
      const [map, bmp] = await Promise.all([
        depthOf(propsRef.current.src, true),
        fetch(propsRef.current.src)
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
          .then((b) => createImageBitmap(b, { imageOrientation: 'from-image', resizeWidth: Math.max(1, Math.round(nw * k)), resizeHeight: Math.max(1, Math.round(nh * k)), resizeQuality: 'high' } as ImageBitmapOptions))
          .catch(() => null),
      ]);
      picture = bmp;
      if (!alive) return;
      if (!map || !bmp) return give(false);
      const byMouse = !!propsRef.current.mouse;
      scene = surface.scene;
      upload(scene, bmp, map);
      bmp.close();
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
      const pivot = pivotOf(map);
      const s = scene;
      const { lean, want } = mouseCam;
      let lastT = performance.now();
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
        const pose = byMouse ? mousePose(lean, amount)
          : scalePose(cameraAt(sharedCamera, p.motion?.shape ?? ('random' as MotionChoice), p.motion?.speed ?? 1, now(), !halted), amount * Math.max(0, p.motion?.amount ?? 1));
        // Held within what can be shown without the picture's edges.
        const f = framePose(pose, d.width, d.height, pivot);
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
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        // Still (paused, done moving, or the camera has caught up with the mouse): no need to keep drawing.
        const moving = byMouse ? Math.abs(lean.x - want.x) + Math.abs(lean.y - want.y) > 0.0005
          : !halted;
        if (moving) raf = requestAnimationFrame(frame);
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
      // Left before its depth came (quick browsing): don't keep the model busy with it.
      depthLetGo(src);
      cancelAnimationFrame(raf);
      kick.current = () => {};
      stopMouse();
      picture?.close();
      stopLost();
      if (surface) giveBack(surface);
      canvasRef.current = null;
    };
  }, [props.src, nw, nh, !!props.mouse]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resumed, resized, refitted or made stronger: draw again.
  useEffect(() => {
    kick.current();
  }, [props.halted, props.fit, props.amount, props.motion?.amount, props.motion?.speed, props.motion?.shape]);
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
