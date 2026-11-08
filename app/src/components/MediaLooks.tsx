// "Looks" laid over whatever the player shows (pictures, GIFs, videos):
//  - Mirror world: the media mirrored into a symmetric view (2 sides, four
//    ways or a 6-slice kaleidoscope) whose source window slowly drifts and turns.
//  - Echo trail: moving media leave soft fading copies behind them (each new
//    frame is blended over the faded earlier ones, like a long exposure).
// Drawn with WebGL from the media itself (the picture's canvas or the video),
// on one canvas over the media; plain canvas 2D where WebGL isn't there.
// Only made while a look is on; stops while paused or the window is hidden.

import { useEffect, useRef } from 'react';
import type { Box } from '../flip';
import { turnMatrix, type Quarter } from '../rotation';
import type { MenuItem } from './Dialogs';
import {
  ECHO_LOOKS, echoAmounts, echoLook, MIRROR_LOOKS, mirrorLook, mirrorMotion, lookCanvasSize,
  type EchoLook, type MirrorLook,
} from '../looks';

export interface LookSource {
  el: HTMLCanvasElement | HTMLVideoElement | HTMLImageElement;
  /** Where the element's picture shows on the stage (px); null: the element is the stage itself (the picture's canvas). */
  box: Box | null;
}

interface Props {
  mirror: MirrorLook;
  echo: EchoLook;
  source: () => LookSource | null;
  /** Clockwise quarter turns of a video shown turned. */
  rot: Quarter;
  /** The stage size (px) and the part of it the media covers. */
  W: number;
  H: number;
  area: Box;
  running: boolean;
  /** The media moves (videos, GIFs): read it again every step. */
  live: boolean;
}

/** The two looks in a menu (View ▾ in the viewer, the Fit menu of a multi-screen window). */
export function lookMenuItems(s: { mirror?: MirrorLook; echo?: EchoLook }, set: (x: { mirror?: MirrorLook; echo?: EchoLook }) => void): MenuItem[] {
  const m = mirrorLook(s.mirror);
  const e = echoLook(s.echo);
  return [
    { label: 'Mirror world', hint: m === 'off' ? 'mirrored, slowly moving' : MIRROR_LOOKS.find((x) => x.id === m)?.label, checked: m !== 'off', sepBefore: true, subOnly: true,
      onSelect: () => {}, sub: MIRROR_LOOKS.map((x) => ({ label: x.label, hint: x.hint, checked: m === x.id, onSelect: () => set({ mirror: x.id }) })) },
    { label: 'Echo trail', hint: e === 'off' ? 'moving things leave a trail' : ECHO_LOOKS.find((x) => x.id === e)?.label, checked: e !== 'off', subOnly: true,
      onSelect: () => {}, sub: ECHO_LOOKS.map((x) => ({ label: x.label, hint: x.id === 'off' ? x.hint : `${x.hint} (videos, GIFs)`, checked: e === x.id, onSelect: () => set({ echo: x.id }) })) },
  ];
}

const MODE = { off: 0, two: 1, four: 2, six: 3 } as const;
/** The echo trail is stepped this many times a second (the same trail length at any screen rate). */
const STEP_HZ = 30;

const VERT = `
attribute vec2 a;
varying vec2 vN;
void main() { vN = vec2((a.x + 1.0) * 0.5, (1.0 - a.y) * 0.5); gl_Position = vec4(a, 0.0, 1.0); }`;

// The media at a stage point (parts 0..1, y down); transparent outside it.
const SRC = `
precision highp float;
varying vec2 vN;
uniform sampler2D uSrc;
uniform vec4 uBox;
uniform int uRot;
vec4 src(vec2 n) {
  vec2 b = (n - uBox.xy) / uBox.zw;
  if (b.x < 0.0 || b.y < 0.0 || b.x > 1.0 || b.y > 1.0) return vec4(0.0);
  if (uRot == 1) b = vec2(b.y, 1.0 - b.x);
  else if (uRot == 2) b = vec2(1.0 - b.x, 1.0 - b.y);
  else if (uRot == 3) b = vec2(1.0 - b.y, b.x);
  return texture2D(uSrc, b);
}`;

const ECHO_FRAG = `${SRC}
uniform sampler2D uPrev;
uniform float uTake;
uniform float uFirst;
void main() {
  vec4 cur = src(vN);
  vec4 prev = texture2D(uPrev, vec2(vN.x, 1.0 - vN.y));
  vec4 d = cur - prev;
  // Always at least a step of 1.5/255 towards the new frame, so no ghost stays for good in 8 bits.
  vec4 mv = sign(d) * max(abs(d) * uTake, min(abs(d), vec4(1.5 / 255.0)));
  gl_FragColor = uFirst > 0.5 ? cur : prev + mv;
}`;

const SHOW_FRAG = `${SRC}
uniform sampler2D uTrail;
uniform vec4 uArea;
uniform vec2 uPx;
uniform int uMode;
uniform vec4 uMotion;
uniform float uShow;
float refl(float v, float lo, float hi) {
  float w = hi - lo;
  float t = mod(v - lo, 2.0 * w);
  return lo + (t > w ? 2.0 * w - t : t);
}
void main() {
  vec2 n = vN;
  if (n.x < uArea.x || n.y < uArea.y || n.x > uArea.x + uArea.z || n.y > uArea.y + uArea.w) { gl_FragColor = vec4(0.0); return; }
  if (uMode > 0) {
    vec2 c = uArea.xy + uArea.zw * 0.5;
    vec2 hs = uArea.zw * uPx * 0.5;
    vec2 p = (n - c) * uPx;
    if (uMode == 1) p.x = abs(p.x);
    else if (uMode == 2) p = abs(p);
    else {
      float seg = 1.0471975512;
      float r = length(p);
      float a = atan(p.y, p.x);
      a = mod(a, 2.0 * seg);
      if (a > seg) a = 2.0 * seg - a;
      p = r * vec2(cos(a), sin(a));
    }
    float cs = cos(uMotion.x), sn = sin(uMotion.x);
    vec2 s = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y) * uMotion.w + uMotion.yz;
    // Half a pixel in from the edge: the soft sampling never picks up what's outside the media.
    s = vec2(refl(s.x, -hs.x + 0.5, hs.x - 0.5), refl(s.y, -hs.y + 0.5, hs.y - 0.5));
    n = c + s / uPx;
  }
  vec4 col = src(n);
  if (uShow > 0.0) col = mix(col, texture2D(uTrail, vec2(n.x, 1.0 - n.y)), uShow);
  gl_FragColor = col;
}`;

type Gl = WebGLRenderingContext;

interface GlState {
  gl: Gl;
  echoProg: WebGLProgram;
  showProg: WebGLProgram;
  src: WebGLTexture;
  trail: { tex: WebGLTexture; fb: WebGLFramebuffer }[];
  trailSize: { w: number; h: number };
  ping: number;
  fresh: boolean;
}

function compile(gl: Gl, frag: string): WebGLProgram | null {
  const sh = (type: number, text: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, text);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const v = sh(gl.VERTEX_SHADER, VERT);
  const f = sh(gl.FRAGMENT_SHADER, frag);
  const p = gl.createProgram();
  if (!v || !f || !p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.bindAttribLocation(p, 0, 'a');
  gl.linkProgram(p);
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
}

function newTexture(gl: Gl): WebGLTexture | null {
  const t = gl.createTexture();
  if (!t) return null;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function setupGl(c: HTMLCanvasElement): GlState | null {
  const gl = c.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, preserveDrawingBuffer: true }) as Gl | null;
  if (!gl) return null;
  const echoProg = compile(gl, ECHO_FRAG);
  const showProg = compile(gl, SHOW_FRAG);
  const src = newTexture(gl);
  const buf = gl.createBuffer();
  if (!echoProg || !showProg || !src || !buf) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  return { gl, echoProg, showProg, src, trail: [], trailSize: { w: 0, h: 0 }, ping: 0, fresh: true };
}

function sizeTrail(st: GlState, w: number, h: number) {
  const gl = st.gl;
  if (st.trailSize.w === w && st.trailSize.h === h && st.trail.length === 2) return;
  for (const t of st.trail) {
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
  }
  st.trail = [];
  for (let i = 0; i < 2; i++) {
    const tex = newTexture(gl);
    const fb = gl.createFramebuffer();
    if (!tex || !fb) return;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    st.trail.push({ tex, fb });
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  st.trailSize = { w, h };
  st.fresh = true;
}

function freeGl(st: GlState) {
  const gl = st.gl;
  for (const t of st.trail) {
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
  }
  st.trail = [];
  st.trailSize = { w: 0, h: 0 };
  gl.deleteTexture(st.src);
  gl.deleteProgram(st.echoProg);
  gl.deleteProgram(st.showProg);
}

/** Is the source drawable now (a video with a frame, a canvas or picture with pixels)? */
function ready(s: LookSource): boolean {
  const el = s.el;
  if (el instanceof HTMLVideoElement) return el.readyState >= 2 && el.videoWidth > 0;
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0;
  return el.width > 0 && el.height > 0 && el.style.visibility !== 'hidden';
}

export function MediaLooks(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const p = useRef(props);
  p.current = props;
  /** Draws once now (when settings change while paused). */
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let gs: GlState | null = setupGl(c);
    // Canvas 2D fallback: the stage-sized frame, and the trail.
    let ctx: CanvasRenderingContext2D | null = null;
    const frame = document.createElement('canvas');
    const trail = document.createElement('canvas');
    const comp = document.createElement('canvas');
    let trailFresh = true;
    if (!gs) ctx = c.getContext('2d');
    const lost = (e: Event) => {
      e.preventDefault();
      gs = null;
    };
    c.addEventListener('webglcontextlost', lost);

    let t = 0; // look time (s), runs only while playing
    let last = 0;
    let stepAcc = 1;
    let uploadedAt = -1e9;
    let haveSrc = false;
    let shownAt = -1e9;
    let raf = 0;
    let dead = false;

    const upload = (s: LookSource) => {
      const st = gs;
      if (st) {
        const gl = st.gl;
        gl.bindTexture(gl.TEXTURE_2D, st.src);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.el);
          haveSrc = true;
        } catch {
          /* not readable (yet) */
        }
        return;
      }
      // 2D: the media drawn into a stage-sized canvas.
      const fx = frame.getContext('2d');
      if (!fx) return;
      fx.setTransform(1, 0, 0, 1, 0, 0);
      fx.clearRect(0, 0, frame.width, frame.height);
      const kx = frame.width / Math.max(1, p.current.W);
      const ky = frame.height / Math.max(1, p.current.H);
      try {
        if (!s.box) fx.drawImage(s.el, 0, 0, frame.width, frame.height);
        else {
          const el = s.el;
          const nw = el instanceof HTMLVideoElement ? el.videoWidth : el instanceof HTMLImageElement ? el.naturalWidth : el.width;
          const nh = el instanceof HTMLVideoElement ? el.videoHeight : el instanceof HTMLImageElement ? el.naturalHeight : el.height;
          const r = p.current.rot;
          const b = s.box;
          fx.setTransform(...turnMatrix(r, b.left * kx, b.top * ky, b.width * kx, b.height * ky));
          const iw = r % 2 ? b.height * ky : b.width * kx;
          const ih = r % 2 ? b.width * kx : b.height * ky;
          fx.drawImage(el, 0, 0, nw, nh, 0, 0, iw, ih);
        }
        haveSrc = true;
      } catch {
        /* not drawable yet */
      }
    };

    const echoStep = (s: LookSource) => {
      const q = p.current;
      const take = echoAmounts(q.echo).take;
      const st = gs;
      if (st) {
        const gl = st.gl;
        sizeTrail(st, c.width, c.height);
        if (st.trail.length < 2) return;
        const from = st.trail[st.ping];
        const to = st.trail[1 - st.ping];
        gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb);
        gl.viewport(0, 0, c.width, c.height);
        gl.useProgram(st.echoProg);
        srcUniforms(st.echoProg, s);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, from.tex);
        gl.uniform1i(gl.getUniformLocation(st.echoProg, 'uPrev'), 1);
        gl.uniform1f(gl.getUniformLocation(st.echoProg, 'uTake'), take);
        gl.uniform1f(gl.getUniformLocation(st.echoProg, 'uFirst'), st.fresh ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
        st.ping = 1 - st.ping;
        st.fresh = false;
        return;
      }
      const tx = trail.getContext('2d');
      if (!tx) return;
      tx.globalAlpha = trailFresh ? 1 : take;
      tx.drawImage(frame, 0, 0);
      tx.globalAlpha = 1;
      trailFresh = false;
    };

    const srcUniforms = (prog: WebGLProgram, s: LookSource) => {
      const st = gs!;
      const gl = st.gl;
      const q = p.current;
      const b = s.box;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, st.src);
      gl.uniform1i(gl.getUniformLocation(prog, 'uSrc'), 0);
      gl.uniform4f(gl.getUniformLocation(prog, 'uBox'), b ? b.left / q.W : 0, b ? b.top / q.H : 0, b ? b.width / q.W : 1, b ? b.height / q.H : 1);
      gl.uniform1i(gl.getUniformLocation(prog, 'uRot'), b ? q.rot : 0);
    };

    const show = (s: LookSource) => {
      const q = p.current;
      const a = q.area;
      const mode = q.mirror;
      // In canvas pixels: the motion sums work on the shown size so it looks the same at any sharpness.
      const kx = c.width / Math.max(1, q.W);
      const ky = c.height / Math.max(1, q.H);
      const hw = (a.width * kx) / 2;
      const hh = (a.height * ky) / 2;
      const m = mirrorMotion(mode, t, hw, hh);
      const showAmt = echoAmounts(q.echo).show;
      const st = gs;
      if (st) {
        const gl = st.gl;
        gl.viewport(0, 0, c.width, c.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(st.showProg);
        srcUniforms(st.showProg, s);
        const echoOn = q.echo !== 'off' && st.trail.length === 2 && !st.fresh;
        if (echoOn) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, st.trail[st.ping].tex);
          gl.uniform1i(gl.getUniformLocation(st.showProg, 'uTrail'), 1);
          gl.activeTexture(gl.TEXTURE0);
        }
        const u = (n: string) => gl.getUniformLocation(st.showProg, n);
        gl.uniform4f(u('uArea'), a.left / q.W, a.top / q.H, a.width / q.W, a.height / q.H);
        gl.uniform2f(u('uPx'), c.width, c.height);
        gl.uniform1i(u('uMode'), MODE[mode]);
        gl.uniform4f(u('uMotion'), m.angle, m.dx, m.dy, m.scale);
        gl.uniform1f(u('uShow'), echoOn ? showAmt : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return;
      }
      if (!ctx) return;
      // 2D: what to mirror (the frame, with the trail over it), then the slices.
      let base: HTMLCanvasElement = frame;
      const cx2 = q.echo !== 'off' && !trailFresh ? comp.getContext('2d') : null;
      if (cx2) {
        if (comp.width !== frame.width || comp.height !== frame.height) {
          comp.width = frame.width;
          comp.height = frame.height;
        }
        cx2.globalAlpha = 1;
        cx2.clearRect(0, 0, comp.width, comp.height);
        cx2.drawImage(frame, 0, 0);
        cx2.globalAlpha = showAmt;
        cx2.drawImage(trail, 0, 0);
        cx2.globalAlpha = 1;
        base = comp;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(a.left * kx, a.top * ky, a.width * kx, a.height * ky);
      ctx.clip();
      if (mode === 'off') ctx.drawImage(base, 0, 0);
      else drawSlices2d(ctx, base, mode, (a.left + a.width / 2) * kx, (a.top + a.height / 2) * ky, hw, hh, m);
      ctx.restore();
    };

    const tick = (now: number) => {
      raf = 0;
      if (dead) return;
      const q = p.current;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const moving = q.running && !document.hidden;
      if (moving) t += dt;
      // The canvas follows the stage size.
      const size = lookCanvasSize(q.W, q.H, window.devicePixelRatio || 1);
      if (c.width !== size.w || c.height !== size.h) {
        c.width = size.w;
        c.height = size.h;
        frame.width = trail.width = size.w;
        frame.height = trail.height = size.h;
        trailFresh = true;
        uploadedAt = -1e9;
      }
      const s = q.source();
      if (s && ready(s)) {
        // Moving media: a new frame every step; still pictures now and then (they may be drawn sharper later).
        stepAcc += dt * STEP_HZ;
        const due = q.live ? stepAcc >= 1 || !haveSrc : now - uploadedAt > 1000;
        if (due) {
          upload(s);
          uploadedAt = now;
          if (q.live && q.echo !== 'off' && haveSrc) echoStep(s);
          stepAcc = Math.min(stepAcc - 1, 1);
          if (stepAcc < 0) stepAcc = 0;
        }
        // Still pictures: the slow drift needs no more than about 30 drawings a second.
        if (haveSrc && (q.live || due || now - shownAt > 30)) {
          show(s);
          shownAt = now;
        }
      }
      if (moving || !haveSrc) raf = requestAnimationFrame(tick);
      else last = 0;
    };
    const wake = () => {
      if (!raf && !dead) raf = requestAnimationFrame(tick);
    };
    redraw.current = () => {
      uploadedAt = -1e9;
      shownAt = -1e9;
      stepAcc = 1;
      wake();
    };
    wake();
    document.addEventListener('visibilitychange', wake);
    return () => {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', wake);
      c.removeEventListener('webglcontextlost', lost);
      // Give the graphics memory back straight away (many multi-screen windows may each have had one).
      // (Not by losing the context: React may set this canvas up again.)
      if (gs) freeGl(gs);
      frame.width = trail.width = comp.width = 0;
    };
  }, []);

  // Playing again, or a setting / size changed: draw again.
  const a = props.area;
  useEffect(() => {
    redraw.current();
  }, [props.running, props.mirror, props.echo, props.W, props.H, props.rot, a.left, a.top, a.width, a.height]);

  return <canvas ref={canvas} className="look-canvas" aria-hidden="true"
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />;
}

/** Canvas 2D: each slice is the first slice turned or mirrored into place (the same fold as the shader). */
function drawSlices2d(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, mode: MirrorLook, cx: number, cy: number, hw: number, hh: number,
  m: { angle: number; dx: number; dy: number; scale: number }) {
  const R = Math.hypot(hw, hh) * 1.1;
  // [clip polygon (relative to the centre), the slice's own transform back from the first slice]
  const slices: { clip: [number, number][]; t: [number, number, number, number] }[] = [];
  if (mode === 'two') {
    slices.push({ clip: [[0, -R], [R, -R], [R, R], [0, R]], t: [1, 0, 0, 1] });
    slices.push({ clip: [[0, -R], [-R, -R], [-R, R], [0, R]], t: [-1, 0, 0, 1] });
  } else if (mode === 'four') {
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]])
      slices.push({ clip: [[0, 0], [sx * R, 0], [sx * R, sy * R], [0, sy * R]], t: [sx, 0, 0, sy] });
  } else {
    const seg = Math.PI / 3;
    for (let k = 0; k < 6; k++) {
      const a0 = k * seg;
      const a1 = a0 + seg;
      const clip: [number, number][] = [[0, 0], [R * 1.2 * Math.cos(a0), R * 1.2 * Math.sin(a0)], [R * 1.2 * Math.cos(a1), R * 1.2 * Math.sin(a1)]];
      let t: [number, number, number, number];
      if (k % 2 === 0) {
        const c = Math.cos(a0), s = Math.sin(a0);
        t = [c, s, -s, c]; // turn by k·60°
      } else {
        const c2 = Math.cos(a1), s2 = Math.sin(a1);
        t = [c2, s2, s2, -c2]; // mirror across the line at a1 / 2
      }
      slices.push({ clip, t });
    }
  }
  for (const sl of slices) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    sl.clip.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.clip();
    ctx.transform(sl.t[0], sl.t[1], sl.t[2], sl.t[3], 0, 0);
    ctx.scale(1 / m.scale, 1 / m.scale);
    ctx.rotate(-m.angle);
    ctx.translate(-m.dx - cx, -m.dy - cy);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }
}
