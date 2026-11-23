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
// Subject effects (still pictures only): with Lift-off on,
// a third texture holds the subject's outline (subject.ts). The subject is
// drawn again on top of the 3D picture, moved as one piece with the camera at
// its own depth: lifted (a little bigger, with a soft shadow that falls only
// on the background) and/or breathing and swaying around its bottom middle.
// The outline it is drawn with is grown a little, so the subject's old edge
// never shows from behind it. Without a depth map these work on a flat one.
//
// Videos and GIFs: drawn from their prepared 3D (video3d.ts, track3d.ts):
// each frame shown is matched to its own prepared frame (by the video's exact
// frame time, or the GIF's frame number), which holds the depth, outline,
// Layered 3D background and subject layer as tiles of one texture, so every
// effect works on them too. Not prepared (yet) at some time: flat there.
//
// 3D looks (still pictures; docs/picture-3d-looks-plan.md): Depth light
// (the depth texture also carries each spot's facing and crease), Border fill
// (a painted border around the picture: less zoom or bigger moves), More
// layers (the picture cut at its depth jumps, each layer marched with its own
// depth, the nearest seen in front), Focus (a second pass blurs the drawn
// picture by each part's depth) and Wiggle (the camera jumps between views;
// captureWiggle draws them off screen for Save wiggle as GIF). Each eases in
// after the picture appears, so it still starts exactly like the plain one.
//
// Everything stays in memory (one texture, one small depth texture, one
// outline), and the WebGL context is let go when the picture changes.

import { useEffect, useRef, useState } from 'react';
import { inTauri, type DepthInfo, type DepthMap, type ViewerSettings } from '../api';
import {
  cameraAt, depthChoice, depthSetup, depthTag, depthLetGo, depthOf, depthPack, DOLLY, easeToward, framePose, mouseLean, mousePose,
  NO_DEPTH_PACK, pivotOf, scalePose, sharedCamera, SHIFT,
  type FrameFeed, type MotionChoice, type Pose,
} from '../depth';
import { TrackPlayer, type TrackIndex } from '../track3d';
import { COLS, motionDamp, ROWS, tileRect, type FrameInfo, type TileName } from '../video3dmath';
import { drawnRect, type Fit } from '../flip';
import {
  fadeAt, fadeDone, fadeTo, flatDepth, maskStats, newFade, subjectDepth, subjectFrame, subjectLetGo, subjectOf,
  type SubjectStats,
} from '../subject';
import { bgDepthNear } from '../layers';
import { foreFor, layerTags, peekRefined, plateFor, refinedDepth } from '../plate';
import { savedId } from '../derived';
import { DepthModelChoice } from './DepthModels';
import { InpaintModelChoice } from './InpaintModels';
import { SavedMapsSection } from './SavedMaps';
import { Video3DSection } from './Prepare3D';
import { SubjectModelChoice } from './SubjectModels';
import { bitmapOffThread } from '../picturecache';
import {
  blurReach, depthAtPoint, depthSpread, depthTexture, farDepth, FLAT_SPREAD, focusPullAt, focusPullMoving, leanOfShift, lightDir, lightTint,
  sharpRange, wigglePose, wiggleViewPose, type FocusPull, type LightFollow, type LightSide, type WiggleOptions,
} from '../depthlook';
import { borderFor, borderTag, layersFor, layersTag, type Border, type Layers } from '../looklayers';
import type { CutSize } from '../layersmath';


interface Props {
  src: string;
  /** The picture's own size (as shown, after its EXIF orientation). */
  natural: { w: number; h: number };
  fit: Fit;
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
  /** A moving picture (GIF, animated WebP/PNG): each frame as it's shown (and its number), drawn with its prepared 3D. */
  frames?: FrameFeed;
  /** A video: drawn frame by frame from the playing video with its prepared 3D. */
  video?: { ref: { current: HTMLVideoElement | null } };
  /** The prepared 3D of this video or GIF (needed for both). */
  track?: { item: number; index: TrackIndex };
  /** Videos and GIFs: a calmer camera (slower, smaller, less on fast scenes). */
  calm?: boolean;
  /** 3D to the beat: `pulse` goes up by one on every beat; a push closer or a little bounce, this strong (1 = as designed). */
  beat?: { pulse: number; kind: 'push' | 'bounce'; amount: number };
  /** Subject effects (pictures; videos and GIFs whose prepared 3D has the outline): each 0 = off, else its amount (1 = as designed). */
  subject?: { lift: number };
  /** The depth map is wanted (false: the camera stays still anyway, so a flat one is used without asking). */
  depth?: boolean;
  /** The subject model and size in use (the outline is worked out again when it changes). */
  subjectModel?: string;
  /**
   * Picture layers (still pictures only, with an outline): sharper depth edges (0 = off, else the strength),
   * a light that stays put, 3D only on the subject, and layered 3D (the background filled in behind the subject).
   */
  layers?: PictureLayers;
  /** The 3D looks (still pictures only): Focus, Depth light, Border fill, More layers, Wiggle. */
  looks?: PictureLooks;
}

/** The 3D looks for still pictures (docs/picture-3d-looks-plan.md); each null = off. */
export interface PictureLooks {
  focus: {
    on: 'subject' | 'mouse' | 'face';
    /** The nearest face's middle (0–1 each way), for "Nearest face". */
    face: { x: number; y: number } | null;
    pull: FocusPull;
    pullSec: number;
    blur: number;
    range: number;
    round: boolean;
    mini: boolean;
  } | null;
  light: { follow: LightFollow; side: LightSide; strength: number; crease: number; warmth: number; softSubject: boolean } | null;
  border: { size: number; use: 'zoom' | 'moves'; model: string } | null;
  multi: { max: number; cut: CutSize; model: string } | null;
  wiggle: WiggleOptions | null;
  /** The outline model is there: the looks use the outline (Focus on the subject, Softer on the subject, More layers). */
  outline: boolean;
}

/** A capture of the wiggle's views (Save wiggle as GIF): RGBA rows top to bottom, one per view. */
export interface WiggleCapture {
  w: number;
  h: number;
  views: Uint8Array[];
  /** Something wanted isn't ready yet (the depth, the layers, the border): better to wait a moment. */
  pending: boolean;
}

const capturers = new Map<string, (width: number) => Promise<WiggleCapture | null>>();
/** The views of the 3D picture showing `src`, drawn with every look that's on (null: it isn't showing in 3D). */
export function captureWiggle(src: string, width: number): Promise<WiggleCapture | null> {
  const c = capturers.get(src);
  return c ? c(width) : Promise.resolve(null);
}

/** The wiggle's own clock (ms), carried from picture to picture and stopped while paused. */
const wiggleClock = { ms: 0, last: Number.NaN };
/** Where the mouse is over the picture (0–1 each way), for focus and light that follow it. */
const lookMouse = { x: 0.5, y: 0.5, lean: { x: 0, y: 0 } };

export interface PictureLayers {
  edges: number;
  subjectOnly: boolean;
  /** '' = Simple fill, else the fill model. */
  layered: { model: string } | null;
}

/** Any picture layer needs the outline. */
function layersOn(l: PictureLayers | undefined): boolean {
  return !!l && (l.edges > 0 || l.subjectOnly || !!l.layered);
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
// Picture layers: the background stays still (3D only on the subject); the subject moves with its own depth;
// layered 3D (the background plate: the subject filled in, its depth in alpha); a light that stays put
// (how far on, the shadow's darkness, where the subject is seen from a shadow point, its softness,
// the rim step towards the light and the rim's brightness) and the background's depth by the subject.
uniform float uBgStill;
uniform float uOwn;
uniform sampler2D uPlate;
uniform float uLayer;
uniform float uZBg;
// The subject as its own layer (plate.ts foreFor): rgb = its colours with the rim cleaned, a = its own
// depth carried out past its rim; on once made (until then the picture and the depth map are used).
uniform sampler2D uFore;
uniform float uForeOn;
// Videos and GIFs: every map from the prepared frame's tiles (video3dmath.ts) in one texture;
// where each tile is, two texels to stay inside it, and how far the filled background reaches.
uniform sampler2D uTrk;
uniform float uTrack;
uniform vec4 uTDepth;
uniform vec4 uTMask;
uniform vec4 uTPlate;
uniform vec4 uTPlateD;
uniform vec4 uTFore;
uniform vec4 uTForeD;
uniform vec2 uTIn;
uniform float uHoleR;
// 3D looks (still pictures; docs/picture-3d-looks-plan.md).
// Border fill: the painted border around the picture (rgb, a = depth), where the picture lies in it.
uniform float uBorder;
uniform sampler2D uBord;
uniform vec2 uBOff;
uniform vec2 uBIn;
// More layers: how many (0 = off, else 2–4), layers 0 … n−1 stacked in one texture (a = each layer's own
// depth, carried out past its edges), each tile's share of it and a half texel, and where layers 1–3 are
// the surface (r, g, b).
uniform float uMulti;
uniform sampler2D uLAtlas;
uniform sampler2D uLCov;
uniform float uLTile;
uniform float uLIn;
// Depth light: strength, crease shade, where the light comes from, its colour, softer on the subject.
uniform float uLight;
uniform float uCrease;
uniform vec3 uLDir;
uniform vec3 uLTint;
uniform float uLSoft;
// Drawing into the focus pass: alpha carries the depth of what is seen.
uniform float uOutZ;
const int N = ${STEPS};
bool inPic(vec2 s) {
  return s.x >= 0.0 && s.x <= 1.0 && s.y >= 0.0 && s.y <= 1.0;
}
// The painted border at a point outside the picture.
vec4 bordAt(vec2 s) {
  return texture2D(uBord, clamp(uBOff + s * uBIn, 0.0, 1.0));
}
vec2 tileAt(vec4 r, vec2 s) {
  return r.xy + clamp(clamp(s, 0.0, 1.0) * r.zw, uTIn, r.zw - uTIn);
}
float trk1(vec4 r, vec2 s) {
  return texture2D(uTrk, tileAt(r, s)).r;
}
float depthAt(vec2 s) {
  if (uTrack > 0.0) return trk1(uTDepth, s);
  if (uBorder > 0.0 && !inPic(s)) return bordAt(s).a;
  return texture2D(uDepth, s).r;
}
vec4 plateAt(vec2 s) {
  return uTrack > 0.0 ? vec4(texture2D(uTrk, tileAt(uTPlate, s)).rgb, trk1(uTPlateD, s)) : texture2D(uPlate, s);
}
vec4 foreAt(vec2 s) {
  return uTrack > 0.0 ? vec4(texture2D(uTrk, tileAt(uTFore, s)).rgb, trk1(uTForeD, s)) : texture2D(uFore, s);
}
vec3 sharpen(vec3 c, vec3 n) {
  return clamp(c * (1.0 + 4.0 * uSharp) - n * uSharp, 0.0, 1.0);
}
vec3 pic(vec2 h) {
  if (uBorder > 0.0 && !inPic(h)) return bordAt(h).rgb;
  h = clamp(h, 0.0, 1.0);
  vec3 c = texture2D(uImg, h).rgb;
  if (uSharp > 0.0) {
    // The same light sharpening as the plain picture (0 -a 0 / -a 1+4a -a / 0 -a 0), one screen pixel apart.
    vec2 d = uPx / uScale;
    vec3 n = texture2D(uImg, h + vec2(d.x, 0.0)).rgb + texture2D(uImg, h - vec2(d.x, 0.0)).rgb
      + texture2D(uImg, h + vec2(0.0, d.y)).rgb + texture2D(uImg, h - vec2(0.0, d.y)).rgb;
    c = sharpen(c, n);
  }
  return c;
}
vec3 platePic(vec2 h) {
  if (uBorder > 0.0 && !inPic(h)) return bordAt(h).rgb;
  h = clamp(h, 0.0, 1.0);
  vec3 c = plateAt(h).rgb;
  if (uSharp > 0.0) {
    vec2 d = uPx / uScale;
    vec3 n = plateAt(h + vec2(d.x, 0.0)).rgb + plateAt(h - vec2(d.x, 0.0)).rgb
      + plateAt(h + vec2(0.0, d.y)).rgb + plateAt(h - vec2(0.0, d.y)).rgb;
    c = sharpen(c, n);
  }
  return c;
}
// The depth the background is drawn with: the plate's (subject filled in) when layered.
float dep(vec2 s) {
  if (uLayer > 0.0 && !(uBorder > 0.0 && !inPic(s))) return plateAt(s).a;
  return depthAt(s);
}
// More layers: layer j's depth, colour and where it is the surface (far 0 … near n−1; the nearest is the picture).
vec2 tileUv(int j, vec2 s) {
  vec2 c = clamp(s, 0.0, 1.0);
  return vec2(c.x, (float(j) + clamp(c.y, uLIn, 1.0 - uLIn)) * uLTile);
}
float lDep(int j, int nl, vec2 s) {
  if (j == 0 && uBorder > 0.0 && !inPic(s)) return bordAt(s).a;
  return texture2D(uLAtlas, tileUv(j, s)).a;
}
vec3 lCol(int j, int nl, vec2 h) {
  if (j == nl - 1) return pic(h);
  if (j == 0 && uBorder > 0.0 && !inPic(h)) return bordAt(h).rgb;
  return texture2D(uLAtlas, tileUv(j, h)).rgb;
}
float lCov(int j, vec2 s) {
  if (j == 0) return 1.0;
  if (!inPic(s)) return 0.0;
  vec3 c = texture2D(uLCov, s).rgb;
  float v = j == 1 ? c.r : j == 2 ? c.g : c.b;
  return smoothstep(0.3, 0.7, v);
}
// From the nearest depth to the farthest through layer j (j < 0: the picture as drawn without layers):
// where the first surface met is, and its depth.
vec3 march(int j, int nl, vec2 p, vec2 kb) {
  vec2 hit = p + kb * uPivot;
  float hz = 0.0;
  float prevZ = 1.0;
  float prevDiff = -1.0;
  for (int i = 0; i <= N; i++) {
    float z = 1.0 - float(i) / float(N);
    vec2 s = p - kb * (z - uPivot);
    float diff = (j < 0 ? dep(s) : lDep(j, nl, s)) - z;
    if (diff >= 0.0) {
      if (i == 0) {
        hit = s;
        hz = z;
      } else {
        float t = prevDiff / (prevDiff - diff);
        hz = mix(prevZ, z, t);
        hit = p - kb * (hz - uPivot);
      }
      return vec3(hit, hz);
    }
    prevDiff = diff;
    prevZ = z;
  }
  return vec3(hit, 0.0);
}
// Where the moved subject at q came from (the reverse of the lift, then of the sway and breathing).
vec2 unmove(vec2 q) {
  vec2 a = vec2((q.x - uBot.x) * uAsp, q.y - uBot.y);
  a = vec2(uRot.x * a.x + uRot.y * a.y, -uRot.y * a.x + uRot.x * a.y) / uBreath;
  vec2 l = uBot + vec2(a.x / uAsp, a.y);
  return uCen + (l - uCen) / uLift;
}
float mask(vec2 s) {
  // Videos: the outline comes through a video codec, which adds faint noise everywhere; read without it
  // (else Lift-off's shadow and the subject layer turn it into dark specks).
  return uTrack > 0.0 ? smoothstep(0.12, 0.88, trk1(uTMask, s)) : texture2D(uMask, clamp(s, 0.0, 1.0)).r;
}
// Videos: where the background was filled in (the outline grown a little); the picture itself elsewhere.
float holeW(vec2 s) {
  float g = mask(s);
  for (int i = 0; i < 8; i++) {
    float an = float(i) * 0.7853982;
    g = max(g, mask(s + vec2(cos(an) / uAsp, sin(an)) * uHoleR));
  }
  return clamp(g * 1.5, 0.0, 1.0);
}
// The outline softened over r (share of the height): for soft shadows.
float softMask(vec2 s, float r) {
  float sh = mask(s) * 0.16;
  for (int i = 0; i < 12; i++) {
    float an = float(i) * 0.5235988;
    vec2 dir = vec2(cos(an) / uAsp, sin(an)) * r;
    sh += mask(s + dir) * 0.04 + mask(s + dir * 0.5) * 0.03;
  }
  return min(1.0, sh);
}
void main() {
  vec2 p = 0.5 + (vUv - 0.5) / uScale;
  vec2 k = uShift + (p - uFocus) * uDolly;
  // The background's camera (still with 3D only on the subject).
  vec2 kb = k * (1.0 - uBgStill);
  vec3 c;
  vec2 h;
  float hz;
  // What the light reads its surface from, and that surface's depth.
  vec2 nh;
  float nz;
  int nl = int(uMulti + 0.5);
  if (nl >= 2) {
    // More layers: each layer marched from the nearest, the nearest one seen in front (soft where it ends).
    vec3 col = vec3(0.0);
    float acc = 0.0;
    float za = 0.0;
    nh = p;
    nz = 0.0;
    for (int jj = 3; jj >= 0; jj--) {
      if (jj >= nl || acc > 0.995) continue;
      vec3 r = march(jj, nl, p, kb);
      float a = lCov(jj, r.xy) * (1.0 - acc);
      if (a > 0.0) {
        col += a * lCol(jj, nl, r.xy);
        za += a * r.z;
        if (acc < 0.5) {
          nh = r.xy;
          nz = lDep(jj, nl, r.xy);
        }
        acc += a;
      }
    }
    c = col / max(acc, 0.0001);
    hz = za / max(acc, 0.0001);
    h = nh;
  } else {
    // From the nearest depth to the farthest: the first surface met is the one seen.
    vec3 r = march(-1, 0, p, kb);
    h = uBorder > 0.0 ? r.xy : clamp(r.xy, 0.0, 1.0);
    hz = r.z;
    c = uLayer > 0.0 ? (uTrack > 0.0 ? mix(pic(h), platePic(h), holeW(h)) : platePic(h)) : pic(h);
    nh = h;
    nz = dep(h);
  }
  if (uSubj > 0.0) {
    // The subject moves as one piece with the camera at its own depth (or, with uOwn, with the depth
    // of each of its parts), then is lifted and/or lives.
    // Lifted means a little closer: the whole subject comes forward in depth by as much as it grows.
    float lz = (uLift - 1.0) * 2.5;
    float zs = uZSubj + lz;
    vec2 ps = p - k * (zs - uPivot);
    vec2 s = unmove(ps);
    // Every part of the subject moves with its own depth (it stays a 3D shape, not a flat sticker).
    // Its own layer's depth is smooth right out past its rim, so this settles everywhere, edges too
    // (the depth map's rim holds some of the background's depth: the edge used to swim and get cut off).
    if (uForeOn > 0.0) {
      for (int i = 0; i < 4; i++) {
        zs = foreAt(clamp(s, 0.0, 1.0)).a + lz;
        ps = p - k * (zs - uPivot);
        s = unmove(ps);
      }
    } else {
      for (int i = 0; i < 3; i++) {
        zs = mix(uZSubj, depthAt(clamp(s, 0.0, 1.0)), mask(s)) + lz;
        ps = p - k * (zs - uPivot);
        s = unmove(ps);
      }
    }
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
    // Its own layer: its cleaned colours (no fringe of the old background at the rim).
    vec3 sc = uForeOn > 0.0 ? foreAt(clamp(s, 0.0, 1.0)).rgb : pic(clamp(s, 0.0, 1.0));
    vec3 o = mix(c, sc, g);
    if (uShadow > 0.0) {
      // A soft shadow down and to the right of the lifted subject, on the background only.
      vec2 s2 = unmove(ps - uShOff);
      o *= 1.0 - uShadow * softMask(s2, uShBlur) * (1.0 - m);
    }
    c = o;
    if (g > 0.5) {
      hz = zs;
      nh = clamp(s, 0.0, 1.0);
      nz = depthAt(nh);
    }
  }
  if (uLight > 0.0 || uCrease > 0.0) {
    // Depth light: the surface's facing (from the depth map's texture) lit from uLDir; with the light
    // where the camera is, nothing changes. Flat where what's drawn isn't the depth map's own surface
    // (a filled-in background, the painted border), so no ghost of a near thing's shape lands there.
    vec4 nd = texture2D(uDepth, clamp(nh, 0.0, 1.0));
    float ok = inPic(nh) ? 1.0 - smoothstep(0.04, 0.1, abs(nd.r - nz)) : 0.0;
    vec2 nxy = (nd.gb - 0.5) * 2.0 * ok;
    float nzz = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
    vec3 n = vec3(nxy, nzz);
    float dif = dot(n, uLDir) - nzz * uLDir.z;
    float soft = 1.0 - uLSoft * 0.6 * mask(nh);
    vec3 tint = dif > 0.0 ? uLTint : vec3(1.0);
    c = c + c * tint * (uLight * 1.8 * dif * soft);
    c *= 1.0 - uCrease * 0.55 * nd.a * ok * soft;
    c = clamp(c, 0.0, 1.0);
  }
  gl_FragColor = vec4(c, uOutZ > 0.0 ? clamp(hz, 0.0, 1.0) : 1.0);
}`;

// Focus (depth of field): the 3D picture drawn first (alpha = depth) is blurred by how far each part is
// from the focus depth, sampled around each pixel; a farther sample counts only as far as this pixel's
// own blur reaches, so a sharp subject never smears onto a blurred background or the other way round.
// Miniature: blurred by height instead (a sharp band across the middle).
const BLUR_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uPx;
uniform float uR;
uniform float uFz;
uniform float uRange;
uniform float uMini;
uniform float uRound;
uniform float uN;
float coc(float z, float y) {
  if (uMini > 0.5) return clamp((abs(y - 0.55) - (0.1 + uRange)) / 0.3, 0.0, 1.0);
  return clamp((abs(z - uFz) - uRange) / 0.25, 0.0, 1.0);
}
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec4 c0 = texture2D(uSrc, uv);
  float cs = coc(c0.a, vUv.y) * uR;
  vec3 col = c0.rgb;
  float tot = 1.0;
  float ang = 0.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= uN) break;
    float r = uR * sqrt((float(i) + 0.5) / uN);
    ang += 2.39996323;
    vec2 o = vec2(cos(ang), sin(ang)) * r;
    vec4 sm = texture2D(uSrc, clamp(uv + o * uPx, 0.0, 1.0));
    float ss = coc(sm.a, vUv.y - o.y * uPx.y) * uR;
    if (sm.a < c0.a) ss = min(ss, cs * 2.0);
    float m = smoothstep(r - 0.5, r + 0.5, ss);
    float wgt = 1.0 + uRound * 6.0 * max(0.0, dot(sm.rgb, vec3(0.3, 0.59, 0.11)) - 0.7) * m;
    col += mix(col / tot, sm.rgb, m) * wgt;
    tot += wgt;
  }
  gl_FragColor = vec4(col / tot, 1.0);
}`;

type Gl = WebGLRenderingContext;

interface Scene {
  gl: Gl;
  prog: WebGLProgram;
  buf: WebGLBuffer;
  img: WebGLTexture;
  depth: WebGLTexture;
  mask: WebGLTexture;
  plate: WebGLTexture;
  fore: WebGLTexture;
  trk: WebGLTexture;
  /** The 3D looks' textures (border, More layers' layers and coverage): only when the card has the texture units for them. */
  bord: WebGLTexture | null;
  latlas: WebGLTexture | null;
  lcov: WebGLTexture | null;
  u: Record<'shift' | 'dolly' | 'scale' | 'pivot' | 'focus' | 'img' | 'depth' | 'px' | 'sharp' | 'mask' | 'subj' | 'asp' | 'cen' | 'lift' | 'bot' | 'rot'
    | 'breath' | 'grow' | 'shadow' | 'shOff' | 'shBlur' | 'zSubj'
    | 'bgStill' | 'own' | 'plate' | 'layer' | 'zBg' | 'fore' | 'foreOn'
    | 'trk' | 'track' | 'tDepth' | 'tMask' | 'tPlate' | 'tPlateD' | 'tFore' | 'tForeD' | 'tIn' | 'holeR'
    | 'border' | 'bord' | 'bOff' | 'bIn' | 'multi' | 'lAtlas' | 'lCov' | 'lTile' | 'lIn'
    | 'light' | 'crease' | 'lDir' | 'lTint' | 'lSoft' | 'outZ', WebGLUniformLocation | null>;
  /** Focus: the blur pass (made the first time it's needed) and the off-screen pictures it reads (and captures draw into). */
  blur: BlurPass | null | undefined;
  targets: Map<string, Target>;
}

interface BlurPass {
  prog: WebGLProgram;
  u: Record<'src' | 'px' | 'r' | 'fz' | 'range' | 'mini' | 'round' | 'n', WebGLUniformLocation | null>;
}

/** An off-screen picture to draw into. */
interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

/** The texture unit the blur pass reads from (the 3D program never samples it). */
const BLUR_UNIT = 9;

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

/** Layered 3D's background plate (RGBA: the colour with the subject filled in, alpha = its depth). */
function uploadPlate(s: Scene, p: { w: number; h: number; data: Uint8Array }) {
  const { gl } = s;
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, s.plate);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, p.w, p.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, p.data);
}

/** The subject's own layer (RGBA: its cleaned colours, alpha = its own depth). */
function uploadFore(s: Scene, p: { w: number; h: number; data: Uint8Array }) {
  const { gl } = s;
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D, s.fore);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, p.w, p.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, p.data);
}

/** A prepared frame of a video or GIF (its tiles) into the track texture. */
function uploadTrack(s: Scene, img: TexImageSource) {
  const { gl } = s;
  gl.activeTexture(gl.TEXTURE5);
  gl.bindTexture(gl.TEXTURE_2D, s.trk);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
}

/** Where the tiles of a prepared track are (once per video or GIF). */
function trackTiles(s: Scene, index: TrackIndex) {
  const { gl } = s;
  const put = (u: WebGLUniformLocation | null, name: TileName) => {
    const [x, y, w, h] = tileRect(name);
    gl.uniform4f(u, x, y, w, h);
  };
  put(s.u.tDepth, 'depth');
  put(s.u.tMask, 'mask');
  put(s.u.tPlate, 'plate');
  put(s.u.tPlateD, 'plateDepth');
  put(s.u.tFore, 'fore');
  put(s.u.tForeD, 'foreDepth');
  gl.uniform2f(s.u.tIn, 2 / (index.w * COLS), 2 / (index.h * ROWS));
  // The fill reaches a little past the outline (platemath.ts colourHole), at the tile's size.
  gl.uniform1f(s.u.holeR, 4 / Math.max(1, index.h));
}

/** A depth map into the depth texture (R = depth, G/B = the surface's facing, A = crease: depthlook.ts). */
function uploadDepth(s: Scene, map: DepthMap) {
  const { gl } = s;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, s.depth);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, map.w, map.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, depthTexture(map));
}

/** An RGBA picture into one of the looks' textures (on its own unit). */
function uploadRgba(s: Scene, tex: WebGLTexture | null, unit: number, w: number, h: number, data: Uint8Array) {
  if (!tex) return;
  const { gl } = s;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

/** An off-screen picture of this size (kept by name, made again when the size changes). */
function target(s: Scene, name: string, w: number, h: number): Target | null {
  const { gl } = s;
  const known = s.targets.get(name);
  if (known && known.w === w && known.h === h) return known;
  if (known) {
    gl.deleteFramebuffer(known.fb);
    gl.deleteTexture(known.tex);
    s.targets.delete(name);
  }
  gl.activeTexture(gl.TEXTURE0 + BLUR_UNIT);
  const tex = texture(gl);
  const fb = gl.createFramebuffer();
  if (!tex || !fb) return null;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) {
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    return null;
  }
  const t = { fb, tex, w, h };
  s.targets.set(name, t);
  return t;
}

/** The blur pass's program (made once; null if it can't be). */
function blurPass(s: Scene): BlurPass | null {
  if (s.blur !== undefined) return s.blur;
  const { gl } = s;
  s.blur = null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, BLUR_FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const at = (n: string) => gl.getUniformLocation(prog, n);
  const u = { src: at('uSrc'), px: at('uPx'), r: at('uR'), fz: at('uFz'), range: at('uRange'), mini: at('uMini'), round: at('uRound'), n: at('uN') };
  gl.useProgram(prog);
  gl.uniform1i(u.src, BLUR_UNIT);
  gl.useProgram(s.prog);
  s.blur = { prog, u };
  return s.blur;
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
  // (The blur pass uses the same corner buffer at the same place.)
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  if (!buf) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  const img = texture(gl);
  if (!img) return null;
  gl.activeTexture(gl.TEXTURE1);
  const depth = texture(gl);
  if (!depth) return null;
  gl.activeTexture(gl.TEXTURE2);
  const mask = texture(gl);
  if (!mask) return null;
  gl.activeTexture(gl.TEXTURE3);
  const plate = texture(gl);
  if (!plate) return null;
  gl.activeTexture(gl.TEXTURE4);
  const fore = texture(gl);
  if (!fore) return null;
  gl.activeTexture(gl.TEXTURE5);
  const trk = texture(gl);
  if (!trk) return null;
  // Border fill and More layers need three more texture units (and the blur pass one): most cards have 16.
  const units = Number(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)) || 8;
  const roomy = units > BLUR_UNIT;
  gl.activeTexture(gl.TEXTURE6);
  const bord = roomy ? texture(gl) : null;
  gl.activeTexture(gl.TEXTURE7);
  const latlas = roomy ? texture(gl) : null;
  gl.activeTexture(gl.TEXTURE8);
  const lcov = roomy ? texture(gl) : null;
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
    bgStill: gl.getUniformLocation(prog, 'uBgStill'),
    own: gl.getUniformLocation(prog, 'uOwn'),
    plate: gl.getUniformLocation(prog, 'uPlate'),
    layer: gl.getUniformLocation(prog, 'uLayer'),
    zBg: gl.getUniformLocation(prog, 'uZBg'),
    fore: gl.getUniformLocation(prog, 'uFore'),
    foreOn: gl.getUniformLocation(prog, 'uForeOn'),
    trk: gl.getUniformLocation(prog, 'uTrk'),
    track: gl.getUniformLocation(prog, 'uTrack'),
    tDepth: gl.getUniformLocation(prog, 'uTDepth'),
    tMask: gl.getUniformLocation(prog, 'uTMask'),
    tPlate: gl.getUniformLocation(prog, 'uTPlate'),
    tPlateD: gl.getUniformLocation(prog, 'uTPlateD'),
    tFore: gl.getUniformLocation(prog, 'uTFore'),
    tForeD: gl.getUniformLocation(prog, 'uTForeD'),
    tIn: gl.getUniformLocation(prog, 'uTIn'),
    holeR: gl.getUniformLocation(prog, 'uHoleR'),
    border: gl.getUniformLocation(prog, 'uBorder'),
    bord: gl.getUniformLocation(prog, 'uBord'),
    bOff: gl.getUniformLocation(prog, 'uBOff'),
    bIn: gl.getUniformLocation(prog, 'uBIn'),
    multi: gl.getUniformLocation(prog, 'uMulti'),
    lAtlas: gl.getUniformLocation(prog, 'uLAtlas'),
    lCov: gl.getUniformLocation(prog, 'uLCov'),
    lTile: gl.getUniformLocation(prog, 'uLTile'),
    lIn: gl.getUniformLocation(prog, 'uLIn'),
    light: gl.getUniformLocation(prog, 'uLight'),
    crease: gl.getUniformLocation(prog, 'uCrease'),
    lDir: gl.getUniformLocation(prog, 'uLDir'),
    lTint: gl.getUniformLocation(prog, 'uLTint'),
    lSoft: gl.getUniformLocation(prog, 'uLSoft'),
    outZ: gl.getUniformLocation(prog, 'uOutZ'),
  };
  gl.uniform1i(u.img, 0);
  gl.uniform1i(u.depth, 1);
  gl.uniform1i(u.mask, 2);
  gl.uniform1i(u.plate, 3);
  gl.uniform1i(u.fore, 4);
  gl.uniform1i(u.trk, 5);
  // (Without the units for them, the looks' samplers share unit 0: they're never switched on then.)
  gl.uniform1i(u.bord, roomy ? 6 : 0);
  gl.uniform1i(u.lAtlas, roomy ? 7 : 0);
  gl.uniform1i(u.lCov, roomy ? 8 : 0);
  gl.uniform1f(u.border, 0);
  gl.uniform1f(u.multi, 0);
  gl.uniform1f(u.light, 0);
  gl.uniform1f(u.crease, 0);
  gl.uniform1f(u.outZ, 0);
  gl.uniform3f(u.lDir, 0, 0, 1);
  gl.uniform3f(u.lTint, 1, 1, 1);
  gl.uniform1f(u.track, 0);
  gl.uniform1f(u.foreOn, 0);
  gl.uniform1f(u.subj, 0);
  gl.uniform1f(u.layer, 0);
  gl.uniform1f(u.bgStill, 0);
  gl.uniform1f(u.own, 0);
  gl.clearColor(0, 0, 0, 0);
  const s: Scene = { gl, prog, buf, img, depth, mask, plate, fore, trk, bord, latlas, lcov, u, blur: undefined, targets: new Map() };
  uploadMask(s, { w: 1, h: 1, data: new Uint8Array([0]) });
  uploadPlate(s, { w: 1, h: 1, data: new Uint8Array([0, 0, 0, 0]) });
  uploadFore(s, { w: 1, h: 1, data: new Uint8Array([0, 0, 0, 0]) });
  gl.activeTexture(gl.TEXTURE5);
  gl.bindTexture(gl.TEXTURE_2D, trk);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  return s;
}

function dropScene(s: Scene) {
  const { gl } = s;
  gl.deleteTexture(s.img);
  gl.deleteTexture(s.depth);
  gl.deleteTexture(s.mask);
  gl.deleteTexture(s.plate);
  gl.deleteTexture(s.fore);
  gl.deleteTexture(s.trk);
  if (s.bord) gl.deleteTexture(s.bord);
  if (s.latlas) gl.deleteTexture(s.latlas);
  if (s.lcov) gl.deleteTexture(s.lcov);
  for (const t of s.targets.values()) {
    gl.deleteFramebuffer(t.fb);
    gl.deleteTexture(t.tex);
  }
  s.targets.clear();
  if (s.blur) gl.deleteProgram(s.blur.prog);
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
        The depth of each picture is worked out offline and saved in the vault (encrypted), so it is only worked out once.
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
        For <b>Lift-off</b> (the subject comes forward a little, with a soft shadow). It is in the viewer’s <b>3D ▾</b> menu, for
        still pictures. The outline of each picture is worked out offline and saved in the vault (encrypted), so it is only worked out once.
      </p>
      <SubjectModelChoice value={props.viewer} onChange={props.setViewer} speedTests />
      <h3 style={{ margin: '18px 0 4px', fontSize: 14 }}>Background fill (Layered 3D)</h3>
      <p className="muted" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
        With <b>Layered 3D</b> on, the background behind the subject is filled in, so moving the camera shows background
        there instead of stretched edges. Simple needs no download; MI-GAN and LaMa fill in more convincingly.
      </p>
      <InpaintModelChoice value={props.viewer} onChange={props.setViewer} speedTests />
      <SavedMapsSection viewer={props.viewer} setViewer={props.setViewer} />
      <Video3DSection />
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
  const subjOn = !props.frames && !props.video && !props.track && ((!!props.subject && props.subject.lift > 0) || layersOn(props.layers) || !!props.looks?.outline);
  /** The outline has been asked for this picture (found or not): More layers waits for it. */
  const maskDone = useRef('');
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
    const vid = vref?.ref.current ? { el: vref.ref.current } : null;
    // Videos and GIFs: their prepared 3D (nothing to show without it).
    const tr = moving || vid ? propsRef.current.track ?? null : null;
    let player: TrackPlayer | null = null;
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
      if ((moving || vid) && !tr) return give(false);
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
        return stillPic && (!!sj && sj.lift > 0);
      };
      // (Videos and GIFs: each frame's depth comes with its prepared frame; flat until then.)
      const depthNow = tr
        ? Promise.resolve(flatDepth())
        : propsRef.current.depth === false && subjWanted() ? Promise.resolve(flatDepth()) : depthOf(propsRef.current.src, true);
      const [got, bmp] = await Promise.all([
        depthNow,
        // Decoded and resized in the worker (a high-quality resize here froze the window for up to a second).
        vid ? Promise.resolve(null) : bitmapOffThread(propsRef.current.src, Math.max(1, Math.round(nw * k)), Math.max(1, Math.round(nh * k))),
      ]);
      picture = bmp;
      if (!alive) return;
      // The picture's size as drawn (Layered 3D's plate is made at this size, at most).
      const picW = bmp?.width ?? 1;
      const picH = bmp?.height ?? 1;
      // No depth map but a subject effect is on: a flat one, so the effects still work.
      const map = got ?? (subjWanted() ? flatDepth() : null);
      // A real depth map of a still picture in the vault: its 3D layers can be saved and used again.
      const realDepth = stillPic && !!got && propsRef.current.depth !== false && got.w > 1;
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
      // Videos and GIFs: each frame shown with its own prepared frame (its exact time, or its number).
      /** The prepared frame shown (null: none for this moment: flat). */
      let trkShown: { img: unknown; info: FrameInfo; t: number } | null = null;
      /** How far the prepared 3D is on (eased in and out, 0–1). */
      let trkFade = 0;
      const trkOn = () => !!trkShown;
      /** The GIF frame shown last. */
      let lastIndex = -1;
      const showTrack = (at: number) => {
        if (!player || s.gl.isContextLost()) return;
        const f = player.frameAt(at);
        if (!f) {
          // Its own frame isn't decoded yet: the last one stays a few frames (no flat flash), then flat.
          if (trkShown && Math.abs(at - trkShown.t) > player.step * 4) trkShown = null;
          return;
        }
        if (f.img !== trkShown?.img) {
          try {
            uploadTrack(s, f.img as TexImageSource);
          } catch {
            return;
          }
        }
        trkShown = { img: f.img, info: f.info, t: f.t };
      };
      if (tr) {
        trackTiles(s, tr.index);
        const trk = tr;
        player = new TrackPlayer(trk.item, trk.index, () => {
          // A frame that was missing arrived (e.g. while paused): shown now.
          if (!alive) return;
          if (vid) {
            if (vid.el.paused) showTrack(vid.el.currentTime);
          } else if (lastIndex >= 0) showTrack(lastIndex);
          kick.current();
        });
      }
      if (vid && player) {
        const el = vid.el;
        type Rvfc = (cb: (now: number, meta: { mediaTime: number }) => void) => number;
        const rvfc = (el as unknown as { requestVideoFrameCallback?: Rvfc }).requestVideoFrameCallback?.bind(el);
        let rvfcId = 0;
        // Each new video frame: the picture and its own prepared frame, together.
        const onVideoFrame = (_now: number, meta: { mediaTime: number }) => {
          if (!alive) return;
          try {
            if (!s.gl.isContextLost() && el.readyState >= 2) uploadPicture(s, el);
          } catch {
            /* not ready yet */
          }
          showTrack(meta.mediaTime);
          kick.current();
          if (rvfc) rvfcId = rvfc(onVideoFrame);
        };
        if (rvfc) rvfcId = rvfc(onVideoFrame);
        // Jumps while paused show no new frame by themselves.
        const onSeeked = () => {
          try {
            if (!s.gl.isContextLost() && el.readyState >= 2) uploadPicture(s, el);
          } catch {
            /* fine */
          }
          showTrack(el.currentTime);
          kick.current();
        };
        el.addEventListener('seeked', onSeeked);
        showTrack(el.currentTime);
        stopVideo = () => {
          el.removeEventListener('seeked', onSeeked);
          const cancel = (el as unknown as { cancelVideoFrameCallback?: (id: number) => void }).cancelVideoFrameCallback;
          if (rvfcId && cancel) cancel.call(el, rvfcId);
        };
      }
      // Moving pictures: each frame as it's shown, with its own prepared frame.
      const feed = propsRef.current.frames;
      if (feed && player) {
        stopFrames = feed.listen((image, index) => {
          if (!alive || s.gl.isContextLost()) return;
          try {
            uploadPicture(s, image);
          } catch {
            return; // a frame already gone: the next one comes soon
          }
          lastIndex = index;
          showTrack(index);
          kick.current();
        });
      }
      // Subject effects: the outline shown, the subject's own depth and how far each effect is on (eased).
      let shownMask: { src: string; mask: DepthMap; stats: SubjectStats } | null = null;
      let zSubj = pivot;
      // Picture layers: the background's depth by the subject, the depth map shown (sharper edges or not),
      // Layered 3D's plate (made once, in the background) and how far the light is on.
      let zBg = pivot;
      let shownDepth: DepthMap = map;
      let refining = '';
      let plate: { key: string; ready: boolean } | null = null;
      let fore: { key: string; ready: boolean } | null = null;
      // 3D looks: the border and the layers (made once, in the background), the depth map's spread and
      // far depth (flat pictures get no focus or light), the looks' fades, the focus depth as eased.
      let bord: { key: string; got: Border | null } | null = null;
      let lays: { key: string; got: Layers | null } | null = null;
      let spreadOf: DepthMap | null = null;
      let spread = 0;
      let far = 0;
      const focusF = newFade(0);
      const lightF = newFade(0);
      let focusZ = -1;
      const liveAt = performance.now();
      /** Save wiggle as GIF: a capture asked for (done at the end of the next frame). */
      let capReq: { width: number; ok: (c: WiggleCapture | null) => void } | null = null;
      // The looks as last on (they fade out with these after being switched off).
      let lastLight: PictureLooks['light'] = null;
      let lastFocus: PictureLooks['focus'] = null;
      let lastFocusT = performance.now();
      const srcNow = propsRef.current.src;
      const keepLift = lifted.src === srcNow && performance.now() - lifted.at < 600;
      const liftF = newFade(0);
      let liftAmt = 1;
      let instantLift = false;
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
        const asp = d.width / Math.max(1, d.height);
        const t = performance.now();
        // Videos and GIFs: the prepared frame's numbers; the 3D eases in where it's prepared and out where not.
        const ti = tr && trkShown ? trkShown.info : null;
        if (tr) {
          const step = Math.min(1, Math.max(0, t - lastT) / 180);
          trkFade = trkOn() ? Math.min(1, trkFade + step) : Math.max(0, trkFade - step);
          if (ti) {
            pivot = ti.p;
            zSubj = ti.z ?? pivot;
            zBg = ti.b ?? Math.min(zSubj, pivot);
          }
        }
        const calmCam = !!tr && !!p.calm;
        const amount = Math.max(0, p.amount ?? 1) * (tr ? trkFade * motionDamp(ti?.mo ?? 0, calmCam) * (calmCam ? 0.75 : 1) : 1);
        const { gl } = s;
        // Still pictures: the outline (when it has come) and the picture layers that use it.
        const mk = stillPic && maskRef.current && maskRef.current.src === p.src ? maskRef.current : null;
        if (mk && mk !== shownMask) {
          uploadMask(s, mk.mask);
          shownMask = mk;
          zSubj = subjectDepth(map, mk.mask) ?? pivot;
          zBg = bgDepthNear(map, mk.mask) ?? Math.min(zSubj, pivot);
          // (Lifted on the picture before too: lifted at once, as soon as its clean layers are made.)
          if (keepLift && (p.subject?.lift ?? 0) > 0) instantLift = true;
        }
        const lay = stillPic ? p.layers : undefined;
        // Sharper depth edges: the depth map made to follow the outline (worked out once, kept).
        const edgeK = mk && lay && lay.edges > 0 ? lay.edges : 0;
        const ds = depthSetup();
        const depthId = `${p.src}|${ds ? depthTag(ds) : 'flat'}|${map.w}x${map.h}|${p.subjectModel ?? ''}`;
        // (Worked out just after this frame, so the picture never waits for it; the plain map shows until then.)
        let wantDepth = map;
        let refinedReady = false;
        // The picture layers need the final map: worked out now (a small map, once per picture).
        const layersNeedIt = !!mk && (!!p.layers?.layered || (!!p.subject && p.subject.lift > 0) || !!p.layers?.subjectOnly);
        if (mk && edgeK > 0) {
          const known = peekRefined(depthId, edgeK) ?? (layersNeedIt ? refinedDepth(depthId, map, mk.mask, edgeK) : undefined);
          if (known) {
            wantDepth = known;
            refinedReady = true;
          } else if (refining !== `${depthId}|${edgeK}`) {
            refining = `${depthId}|${edgeK}`;
            const mask = mk.mask;
            setTimeout(() => {
              if (!alive) return;
              refinedDepth(depthId, map, mask, edgeK);
              kick.current();
            }, 0);
          }
        }
        if (wantDepth !== shownDepth) {
          uploadDepth(s, wantDepth);
          shownDepth = wantDepth;
        }
        // Whenever the subject is drawn as its own layer (Layered 3D, Lift-off, 3D only on the subject):
        // the background with the subject filled in (Layered 3D's fill, else Simple), so the subject's old
        // place never shows (no doubled edge, no outline), and the subject's own layer (clean rim, its own
        // depth). Both are made once per picture in the background; until then, as before.
        const liftWanted = !!p.subject && p.subject.lift > 0;
        const layerWanted = !!mk && (!!lay?.layered || liftWanted || !!lay?.subjectOnly);
        const fillModel = lay?.layered?.model ?? '';
        // Asked for once the depth map is final (with sharper edges: once they are worked out), so
        // nothing is made twice and the saved layers (made the same way) are found.
        const depthFinal = edgeK === 0 || refinedReady;
        const plateKey = layerWanted && depthFinal ? `${depthId}|${edgeK.toFixed(2)}|${fillModel}|${p.natural.w}x${p.natural.h}` : '';
        // Made at the picture's own size (at most 1600 px: plate.ts), whatever size it's drawn at.
        const layerSize = { w: p.natural.w || picW, h: p.natural.h || picH };
        // Saved under the depth they were made with: the depth model's, or 'flat' (no 3D motion: the subject effects on a flat picture).
        const vaultId = stillPic && p.subjectModel && (realDepth ? !!ds : map.w === 1) ? savedId(p.src) : null;
        const tags = vaultId != null ? layerTags(realDepth && ds ? depthTag(ds) : 'flat', p.subjectModel!, edgeK, fillModel) : null;
        if (plateKey && fore?.key !== plateKey) {
          const key = plateKey;
          fore = { key, ready: false };
          void foreFor(key, { src: p.src, ...layerSize, mask: mk!.mask, depth: wantDepth, save: tags && vaultId != null ? { id: vaultId, tag: tags.fore } : undefined }).then((fl) => {
            if (!alive || !fl || fore?.key !== key || s.gl.isContextLost()) return;
            try {
              uploadFore(s, fl);
              fore.ready = true;
            } catch {
              return;
            }
            kick.current();
          });
        }
        if (plateKey && plate?.key !== plateKey) {
          const key = plateKey;
          plate = { key, ready: false };
          void plateFor(key, { src: p.src, ...layerSize, mask: mk!.mask, depth: wantDepth, model: fillModel, save: tags && vaultId != null ? { id: vaultId, tag: tags.plate } : undefined }).then((pl) => {
            if (!alive || !pl || plate?.key !== key || s.gl.isContextLost()) return;
            try {
              uploadPlate(s, pl);
              plate.ready = true;
            } catch {
              return;
            }
            kick.current();
          });
        }
        // ---- 3D looks (still pictures) ----
        const lk = stillPic ? p.looks : undefined;
        if (shownDepth !== spreadOf) {
          spreadOf = shownDepth;
          spread = shownDepth.w > 1 ? depthSpread(shownDepth) : 0;
          far = farDepth(shownDepth);
        }
        // A flat picture (a document, a screenshot) gets no focus blur and no depth light.
        const flatPic = !realDepth || spread < FLAT_SPREAD;
        const roomy = !!s.bord;
        const lookId = stillPic && realDepth && ds ? savedId(p.src) : null;
        let pending = false;
        // Border fill: made once the depth is final; until then the picture zooms as before.
        const bdw = lk?.border && realDepth && roomy && ds && depthFinal ? lk.border : null;
        const bKey = bdw ? `${depthId}|${edgeK.toFixed(2)}|b${bdw.size}|${bdw.model}|${p.natural.w}x${p.natural.h}` : '';
        if (bdw && bord?.key !== bKey) {
          const key = bKey;
          bord = { key, got: null };
          void borderFor(key, { src: p.src, natural: layerSize, size: bdw.size, depth: wantDepth, model: bdw.model, save: lookId != null ? { id: lookId, tag: borderTag(depthTag(ds!), bdw.size, bdw.model) } : undefined }).then((g) => {
            if (!alive || !g || bord?.key !== key || s.gl.isContextLost()) return;
            try {
              uploadRgba(s, s.bord, 6, g.W, g.H, g.data);
              bord.got = g;
            } catch {
              return;
            }
            kick.current();
          });
        }
        const bOn = !!bdw && bord?.key === bKey && !!bord.got;
        if (bdw && !bOn) pending = true;
        // More layers: made once the depth is final and the outline has been asked for (when there is one).
        const mw = lk?.multi && realDepth && roomy && ds && depthFinal && (!lk.outline || maskDone.current === p.src) ? lk.multi : null;
        if (lk?.multi && !mw) pending = true;
        const mMax = mw ? mw.max : 0;
        const mKey = mw ? `${depthId}|${edgeK.toFixed(2)}|m${mMax}${mw.cut}|${mw.model}|${mk ? 'm' : 'n'}|${p.natural.w}x${p.natural.h}` : '';
        if (mw && lays?.key !== mKey) {
          const key = mKey;
          lays = { key, got: null };
          const tag = layersTag(depthTag(ds!), mk ? p.subjectModel ?? '' : '', edgeK, mMax, mw.cut, mw.model);
          void layersFor(key, { src: p.src, natural: layerSize, depth: wantDepth, mask: mk?.mask ?? null, max: mMax, cut: mw.cut, model: mw.model, save: lookId != null ? { id: lookId, tag } : undefined }).then((g) => {
            if (!alive || lays?.key !== key || s.gl.isContextLost()) return;
            if (g) {
              try {
                uploadRgba(s, s.latlas, 7, g.w, g.h * g.n, g.atlas);
                uploadRgba(s, s.lcov, 8, g.cov.w, g.cov.h, g.cov.data);
              } catch {
                return;
              }
            }
            lays.got = g;
            kick.current();
          });
        }
        const lOn = !!mw && lays?.key === mKey && !!lays.got;
        if (mw && lays?.key === mKey && !lays.got) pending = true;
        // Videos and GIFs: what their prepared 3D holds, for the effects switched on.
        const tLay = tr ? p.layers : undefined;
        const tSt = ti?.st ?? null;
        const layered = tr ? !!ti && tr.index.has.plate && !!tLay?.layered : !!plateKey && !!plate?.ready && plate.key === plateKey;
        const foreOn = tr ? !!ti && tr.index.has.subject : !!plateKey && !!fore?.ready && fore.key === plateKey;
        // Both made: the subject's own layer over the filled background (else as before).
        // (Videos: the subject's layer is always there with the outline.)
        const clean = tr ? foreOn : layered && foreOn;
        // 3D only on the subject: the background stays still and the subject moves against the background's depth.
        const bgStill = tr ? foreOn && !!tSt && !!tLay?.subjectOnly : !!mk && !!lay?.subjectOnly;
        const pv = bgStill ? zBg : pivot;
        if (byMouse) {
          // (After a still moment the first step is one frame, not the whole pause.)
          const dt = Math.min(t - lastT, 34);
          lean.x = easeToward(lean.x, want.x, dt);
          lean.y = easeToward(lean.y, want.y, dt);
        }
        lastT = t;
        const halted = clock.current.halted;
        // Wiggle (pictures): the camera jumps between its views on its own clock (it wins over the mouse).
        const wig = lk?.wiggle ?? null;
        if (wig) {
          const wt = now();
          if (Number.isFinite(wiggleClock.last) && !halted) wiggleClock.ms += Math.min(100, Math.max(0, wt - wiggleClock.last));
          wiggleClock.last = wt;
        }
        const motionAmount = amount * Math.max(0, p.motion?.amount ?? 1);
        const base = wig ? wigglePose(wiggleClock.ms, wig, motionAmount) : byMouse ? mousePose(lean, amount)
          : scalePose(cameraAt(sharedCamera, p.motion?.shape ?? ('random' as MotionChoice), (p.motion?.speed ?? 1) * (calmCam ? 0.6 : 1), now(), !halted), amount * Math.max(0, p.motion?.amount ?? 1));
        // 3D to the beat: a push closer or a little bounce on each beat.
        const b = p.beat;
        const env = b ? beatEnvelope(t - beatAt.current) : 0;
        const pose = b ? withBeat(base, b.kind, b.amount * Math.max(0.3, amount), env) : base;
        // Held within what can be shown without the picture's edges (with Border fill: its painted edges).
        const room = bOn && bord?.got ? { x: bord.got.b / bord.got.w, y: bord.got.b / bord.got.h, use: lk!.border!.use } : null;
        const f = framePose(pose, d.width, d.height, pv, room);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(s.u.track, tr && ti ? 1 : 0);
        gl.uniform1f(s.u.asp, asp);
        // Whole pixels from the top left, exactly where the plain picture is drawn (GL counts from the bottom).
        const vw = Math.round(d.width * r);
        const vh = Math.round(d.height * r);
        gl.viewport(Math.round(d.left * r), bh - Math.round(d.top * r) - vh, vw, vh);
        gl.uniform2f(s.u.shift, f.shift.x, f.shift.y);
        gl.uniform1f(s.u.dolly, f.dolly);
        gl.uniform1f(s.u.scale, f.scale);
        gl.uniform1f(s.u.pivot, pv);
        gl.uniform2f(s.u.focus, 0.5, 0.5);
        gl.uniform2f(s.u.px, 1 / Math.max(1, vw), 1 / Math.max(1, vh));
        gl.uniform1f(s.u.sharp, p.sharpen ? 0.35 : 0);
        // (More layers draws the whole background itself.)
        gl.uniform1f(s.u.layer, layered && !lOn ? 1 : 0);
        gl.uniform1f(s.u.border, bOn ? 1 : 0);
        if (bOn && bord?.got) {
          const g = bord.got;
          gl.uniform2f(s.u.bOff, g.b / g.W, g.b / g.H);
          gl.uniform2f(s.u.bIn, g.w / g.W, g.h / g.H);
        }
        gl.uniform1f(s.u.multi, lOn && lays?.got ? lays.got.n : 0);
        if (lOn && lays?.got) {
          gl.uniform1f(s.u.lTile, 1 / lays.got.n);
          gl.uniform1f(s.u.lIn, 0.5 / Math.max(1, lays.got.h));
        }
        // Looks ease in after the picture appears (it starts exactly like the plain picture) and when switched on or off.
        const lookIn = Math.min(1, Math.max(0, (t - liveAt) / 700));
        const lookK = lookIn * lookIn * (3 - 2 * lookIn);
        const lw = lk?.light && !flatPic ? lk.light : null;
        fadeTo(lightF, lw ? 1 : 0, t);
        const lightV = fadeAt(lightF, t) * lookK;
        const lightLast = lw ?? lastLight;
        if (lw) lastLight = lw;
        const setLight = (shift: { x: number; y: number }) => {
          if (!lightLast || lightV <= 0) {
            gl.uniform1f(s.u.light, 0);
            gl.uniform1f(s.u.crease, 0);
            return;
          }
          const ln = lightLast.follow === 'mouse' ? lookMouse.lean : leanOfShift(shift, asp);
          const [lx, ly, lz] = lightDir(lightLast.follow, ln, lightLast.side, t);
          const [tr0, tg0, tb0] = lightTint(lightLast.warmth);
          gl.uniform3f(s.u.lDir, lx, ly, lz);
          gl.uniform3f(s.u.lTint, tr0, tg0, tb0);
          gl.uniform1f(s.u.light, lightLast.strength * lightV);
          gl.uniform1f(s.u.crease, lightLast.crease * lightV);
          gl.uniform1f(s.u.lSoft, lightLast.softSubject && shownMask ? 1 : 0);
        };
        setLight(f.shift);
        gl.uniform1f(s.u.foreOn, clean ? 1 : 0);
        gl.uniform1f(s.u.bgStill, bgStill ? 1 : 0);
        gl.uniform1f(s.u.own, bgStill || layered ? 1 : 0);
        // Subject effects (still pictures only): Lift-off on top of the 3D picture.
        let subjBusy = false;
        if (stillPic) {
          const sj = p.subject;
          if (sj && sj.lift > 0) liftAmt = sj.lift;
          // Lift-off starts once its clean layers are made (a moment after the outline), so it never shows a doubled edge.
          if (clean && instantLift) {
            instantLift = false;
            if (sj && sj.lift > 0) Object.assign(liftF, newFade(1));
          }
          fadeTo(liftF, mk && sj && sj.lift > 0 && clean ? 1 : 0, t);
          const lv = fadeAt(liftF, t);
          if (lv >= 1) {
            lifted.src = p.src;
            lifted.at = Infinity;
          }
          // The subject layer is drawn for Lift-off, and always over a still or filled-in background.
          const on = !!shownMask && (lv > 0 || bgStill || layered);
          gl.uniform1f(s.u.subj, on ? 1 : 0);
          if (shownMask) {
            const sf = subjectFrame(shownMask.stats, asp, { level: lv, amount: liftAmt });
            // Over the still background the moved subject's old place is covered by a grown outline; over the plate nothing needs covering.
            const reach = bgStill && !layered ? (Math.hypot(f.shift.x * asp, f.shift.y) + Math.abs(f.dolly) * 0.5) * Math.abs(zSubj - zBg) * 1.3 + 0.003 : 0;
            gl.uniform1f(s.u.asp, asp);
            gl.uniform2f(s.u.cen, sf.centre.x, sf.centre.y);
            gl.uniform1f(s.u.lift, sf.lift);
            gl.uniform2f(s.u.bot, sf.pivot.x, sf.pivot.y);
            gl.uniform2f(s.u.rot, Math.cos(sf.angle), Math.sin(sf.angle));
            gl.uniform1f(s.u.breath, sf.breath);
            gl.uniform1f(s.u.grow, layered ? 0 : Math.max(sf.grow, reach));
            gl.uniform1f(s.u.shadow, sf.shadow);
            gl.uniform2f(s.u.shOff, sf.shadowOffset.x, sf.shadowOffset.y);
            gl.uniform1f(s.u.shBlur, sf.shadowBlur);
            gl.uniform1f(s.u.zSubj, zSubj);
            gl.uniform1f(s.u.zBg, zBg);
          }
          // Lift-off moves while it eases in or out.
          subjBusy = !fadeDone(liftF, t);
        } else if (tr && ti) {
          // Videos and GIFs: the same subject effects, from each prepared frame's outline and numbers.
          const sj = p.subject;
          if (sj && sj.lift > 0) liftAmt = sj.lift;
          fadeTo(liftF, tSt && sj && sj.lift > 0 && clean ? 1 : 0, t);
          const lv = fadeAt(liftF, t);
          const on = !!tSt && (lv > 0 || bgStill || layered);
          gl.uniform1f(s.u.subj, on ? 1 : 0);
          if (tSt) {
            const sf = subjectFrame(tSt, asp, { level: lv, amount: liftAmt });
            const reach = bgStill && !layered ? (Math.hypot(f.shift.x * asp, f.shift.y) + Math.abs(f.dolly) * 0.5) * Math.abs(zSubj - zBg) * 1.3 + 0.003 : 0;
            gl.uniform2f(s.u.cen, sf.centre.x, sf.centre.y);
            gl.uniform1f(s.u.lift, sf.lift);
            gl.uniform2f(s.u.bot, sf.pivot.x, sf.pivot.y);
            gl.uniform2f(s.u.rot, Math.cos(sf.angle), Math.sin(sf.angle));
            gl.uniform1f(s.u.breath, sf.breath);
            gl.uniform1f(s.u.grow, layered ? 0 : Math.max(sf.grow, reach));
            gl.uniform1f(s.u.shadow, sf.shadow);
            gl.uniform2f(s.u.shOff, sf.shadowOffset.x, sf.shadowOffset.y);
            gl.uniform1f(s.u.shBlur, sf.shadowBlur);
            gl.uniform1f(s.u.zSubj, zSubj);
            gl.uniform1f(s.u.zBg, zBg);
          }
          subjBusy = !fadeDone(liftF, t);
        } else gl.uniform1f(s.u.subj, 0);
        // Focus: what stays sharp (eased), pulled over time; blurred in a second pass.
        const fw = lk?.focus && !flatPic && roomy ? lk.focus : null;
        fadeTo(focusF, fw ? 1 : 0, t);
        const focusV = fadeAt(focusF, t) * lookK;
        if (fw) lastFocus = fw;
        const fl = fw ?? lastFocus;
        let focusBusy = false;
        if (fl) {
          const target = fl.on === 'mouse' ? depthAtPoint(shownDepth, lookMouse.x, lookMouse.y)
            : fl.on === 'face' && fl.face ? depthAtPoint(shownDepth, fl.face.x, fl.face.y)
              : shownMask ? zSubj : pivot;
          const goal = focusPullAt(fl.pull, t - liveAt, fl.pullSec, target, Math.min(far, target));
          const dtF = Math.min(50, Math.max(0, t - lastFocusT));
          focusZ = focusZ < 0 || fl.pull !== 'off' ? goal : easeToward(focusZ, goal, dtF / 2.5);
          focusBusy = Math.abs(focusZ - goal) > 0.002 || focusPullMoving(fl.pull, t - liveAt, fl.pullSec);
        }
        lastFocusT = t;
        const blurPx = (cw2: number, ch2: number) => (fl ? blurReach(fl.blur) * Math.min(ch2, cw2 * 1.5) * focusV : 0);
        const bp = fl && focusV > 0 ? blurPass(s) : null;
        /** Draws the 3D picture into `out` (null: the screen at `vp`), through the focus pass when it's on. */
        const draw = (out: Target | null, vp: [number, number, number, number], name: string) => {
          const R = blurPx(vp[2], vp[3]);
          const pass = bp && R > 0.3 ? target(s, name, vp[2], vp[3]) : null;
          if (!pass) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
            gl.viewport(...vp);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            return;
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, pass.fb);
          gl.viewport(0, 0, vp[2], vp[3]);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.uniform1f(s.u.outZ, 1);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.uniform1f(s.u.outZ, 0);
          gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
          gl.viewport(...vp);
          gl.useProgram(bp!.prog);
          gl.activeTexture(gl.TEXTURE0 + BLUR_UNIT);
          gl.bindTexture(gl.TEXTURE_2D, pass.tex);
          gl.uniform2f(bp!.u.px, 1 / vp[2], 1 / vp[3]);
          gl.uniform1f(bp!.u.r, R);
          gl.uniform1f(bp!.u.fz, focusZ);
          gl.uniform1f(bp!.u.range, sharpRange(fl!.range));
          gl.uniform1f(bp!.u.mini, fl!.mini ? 1 : 0);
          gl.uniform1f(bp!.u.round, fl!.round ? 1 : 0);
          gl.uniform1f(bp!.u.n, 40);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.useProgram(s.prog);
        };
        draw(null, [Math.round(d.left * r), bh - Math.round(d.top * r) - vh, vw, vh], 'pass');
        // Save wiggle as GIF: each view drawn off screen at the GIF's size, with every look as it is now.
        if (capReq) {
          const req = capReq;
          capReq = null;
          try {
            const cw = Math.max(16, Math.round(req.width));
            const chh = Math.max(16, Math.round(cw / Math.max(0.05, asp)));
            const out = target(s, 'cap', cw, chh);
            const wo = wig ?? { views: 3, speed: 5, order: 'bounce' as const, dir: 'side' as const, smooth: false };
            if (!out) throw new Error('no target');
            gl.uniform2f(s.u.px, 1 / cw, 1 / chh);
            const views: Uint8Array[] = [];
            for (let i = 0; i < wo.views; i++) {
              const fv = framePose(wiggleViewPose(i, wo, motionAmount || amount), cw, chh, pv, room);
              gl.uniform2f(s.u.shift, fv.shift.x, fv.shift.y);
              gl.uniform1f(s.u.dolly, fv.dolly);
              gl.uniform1f(s.u.scale, fv.scale);
              setLight(fv.shift);
              gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
              gl.clear(gl.COLOR_BUFFER_BIT);
              draw(out, [0, 0, cw, chh], 'cap-pass');
              const px = new Uint8Array(cw * chh * 4);
              gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
              gl.readPixels(0, 0, cw, chh, gl.RGBA, gl.UNSIGNED_BYTE, px);
              // GL reads from the bottom row up.
              const rows = new Uint8Array(px.length);
              const line = cw * 4;
              for (let y = 0; y < chh; y++) rows.set(px.subarray((chh - 1 - y) * line, (chh - y) * line), y * line);
              views.push(rows);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            req.ok({ w: cw, h: chh, views, pending: pending || !realDepth });
          } catch {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            req.ok(null);
          }
          // The screen is drawn again as it was.
          raf = requestAnimationFrame(frame);
          return;
        }
        // Still (paused, done moving, or the camera has caught up with the mouse): no need to keep drawing.
        const looksBusy = !fadeDone(focusF, t) || !fadeDone(lightF, t) || lookIn < 1 || (focusV > 0 && focusBusy) || (lightV > 0 && lightLast?.follow === 'sweep');
        const still = (byMouse && !wig ? Math.abs(lean.x - want.x) + Math.abs(lean.y - want.y) <= 0.0005 : halted) && !looksBusy;
        // (Videos and GIFs: also while their 3D eases in or out.)
        const fading = !!tr && trkFade !== (trkOn() ? 1 : 0);
        if (!still || env > 0 || subjBusy || fading) raf = requestAnimationFrame(frame);
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
      if (stillPic) {
        const csrc = propsRef.current.src;
        const cap = (width: number) => new Promise<WiggleCapture | null>((ok) => {
          if (!alive) return ok(null);
          capReq = { width, ok };
          kick.current();
        });
        capturers.set(csrc, cap);
        const onLookMove = (e: PointerEvent) => {
          const lk = propsRef.current.looks;
          if (!lk || !(lk.focus?.on === 'mouse' || lk.light?.follow === 'mouse')) return;
          const b = canvas.getBoundingClientRect();
          const d = drawnRect(b.width, b.height, nw, nh, propsRef.current.fit);
          const x = (e.clientX - b.left - d.left) / (d.width || 1);
          const y = (e.clientY - b.top - d.top) / (d.height || 1);
          lookMouse.x = Math.min(1, Math.max(0, x));
          lookMouse.y = Math.min(1, Math.max(0, y));
          lookMouse.lean = { x: Math.min(1, Math.max(-1, x * 2 - 1)), y: Math.min(1, Math.max(-1, y * 2 - 1)) };
          kick.current();
        };
        window.addEventListener('pointermove', onLookMove);
        const prevStop = stopMouse;
        stopMouse = () => {
          prevStop();
          window.removeEventListener('pointermove', onLookMove);
          if (capturers.get(csrc) === cap) capturers.delete(csrc);
          capReq?.ok(null);
          capReq = null;
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
      if (!moving && !vid) depthLetGo(src);
      stopFrames();
      stopVideo();
      player?.close();
      cancelAnimationFrame(raf);
      kick.current = () => {};
      stopMouse();
      picture?.close();
      stopLost();
      if (surface) giveBack(surface);
      canvasRef.current = null;
    };
  }, [props.src, nw, nh, !!props.mouse, !!props.video, props.track?.index]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subject effects: this picture's outline, worked out first (the neighbours' ones are worked out ahead by the viewer).
  useEffect(() => {
    if (!subjOn) return;
    let alive = true;
    const src = props.src;
    void subjectOf(src, true).then((m) => {
      if (!alive) return;
      const stats = maskStats(m);
      maskRef.current = m && stats ? { src, mask: m, stats } : null;
      maskDone.current = src;
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
  }, [props.halted, props.fit, props.amount, props.motion?.amount, props.motion?.speed, props.motion?.shape, props.subject?.lift,
    props.layers?.edges, props.layers?.subjectOnly, props.layers?.layered?.model, !!props.layers?.layered, props.calm, props.looks]);
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
