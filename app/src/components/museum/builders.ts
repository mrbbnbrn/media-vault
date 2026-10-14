// Geometry for the museum: boxes with world-space UVs, swept mouldings
// (frames, cornices), lathed brass and marble, a crystal chandelier.
// Everything is non-indexed with position, normal and uv so it can be merged.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Geo = THREE.BufferGeometry;

/** Makes a geometry mergeable: non-indexed, with uv. */
export function norm(g: Geo): Geo {
  const out = g.index ? g.toNonIndexed() : g;
  if (!out.getAttribute('uv')) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((out.getAttribute('position').count) * 2), 2));
  }
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  for (const k of Object.keys(out.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') out.deleteAttribute(k);
  if (out !== g) g.dispose();
  return out;
}

export function merge(list: Geo[]): Geo | null {
  if (!list.length) return null;
  const m = mergeGeometries(list.map(norm), false);
  for (const g of list) g.dispose();
  return m;
}

/**
 * An axis-aligned box with UVs in metres / `uv` (u along the longer
 * horizontal side or x, v up). Centre (x, y, z), size (sx, sy, sz).
 */
export function box(x: number, y: number, z: number, sx: number, sy: number, sz: number, uv = 1, uvOffset = 0): Geo {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  // face: normal, and four corners (counter-clockwise seen from outside), uv basis
  const face = (n: [number, number, number], c: [number, number, number][], uvc: [number, number][]) => {
    const idx = [0, 1, 2, 0, 2, 3];
    for (const i of idx) {
      pos.push(x + c[i][0], y + c[i][1], z + c[i][2]);
      nor.push(...n);
      uvs.push(uvc[i][0] / uv + uvOffset, uvc[i][1] / uv);
    }
  };
  const X0 = -hx, X1 = hx, Y0 = -hy, Y1 = hy, Z0 = -hz, Z1 = hz;
  const wx = x; // world offsets for continuous texturing
  const wz = z;
  const yb = y - hy;
  // +z
  face([0, 0, 1], [[X0, Y0, Z1], [X1, Y0, Z1], [X1, Y1, Z1], [X0, Y1, Z1]], [[wx + X0, yb], [wx + X1, yb], [wx + X1, yb + sy], [wx + X0, yb + sy]]);
  // -z
  face([0, 0, -1], [[X1, Y0, Z0], [X0, Y0, Z0], [X0, Y1, Z0], [X1, Y1, Z0]], [[-(wx + X1), yb], [-(wx + X0), yb], [-(wx + X0), yb + sy], [-(wx + X1), yb + sy]]);
  // +x
  face([1, 0, 0], [[X1, Y0, Z1], [X1, Y0, Z0], [X1, Y1, Z0], [X1, Y1, Z1]], [[-(wz + Z1), yb], [-(wz + Z0), yb], [-(wz + Z0), yb + sy], [-(wz + Z1), yb + sy]]);
  // -x
  face([-1, 0, 0], [[X0, Y0, Z0], [X0, Y0, Z1], [X0, Y1, Z1], [X0, Y1, Z0]], [[wz + Z0, yb], [wz + Z1, yb], [wz + Z1, yb + sy], [wz + Z0, yb + sy]]);
  // +y
  face([0, 1, 0], [[X0, Y1, Z1], [X1, Y1, Z1], [X1, Y1, Z0], [X0, Y1, Z0]], [[wx + X0, -(wz + Z1)], [wx + X1, -(wz + Z1)], [wx + X1, -(wz + Z0)], [wx + X0, -(wz + Z0)]]);
  // -y
  face([0, -1, 0], [[X0, Y0, Z0], [X1, Y0, Z0], [X1, Y0, Z1], [X0, Y0, Z1]], [[wx + X0, wz + Z0], [wx + X1, wz + Z0], [wx + X1, wz + Z1], [wx + X0, wz + Z1]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/** A horizontal rectangle at height y facing up (or down), UV = world x/z divided by `uv`. */
export function flat(x0: number, z0: number, x1: number, z1: number, y: number, up: boolean, uv: number, rot = false): Geo {
  const g = new THREE.BufferGeometry();
  const p = up
    ? [x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z1, x1, y, z0, x0, y, z0]
    : [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
  const uvs: number[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const u = p[i] / uv;
    const v = -p[i + 2] / uv;
    if (rot) uvs.push(v, u);
    else uvs.push(u, v);
  }
  const n = up ? 1 : -1;
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [0, n, 0]).flat(), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/** A vertical quad: centre c, along unit a (horizontal), facing unit n, size w × h, uv 0..1. */
export function quad(c: THREE.Vector3, a: THREE.Vector3, n: THREE.Vector3, w: number, h: number, uvRect: [number, number, number, number] = [0, 0, 1, 1]): Geo {
  const up = new THREE.Vector3(0, 1, 0);
  if (Math.abs(n.y) > 0.9) up.set(0, 0, -1);
  const r = a.clone().multiplyScalar(w / 2);
  const u = up.clone().multiplyScalar(h / 2);
  const p0 = c.clone().sub(r).sub(u);
  const p1 = c.clone().add(r).sub(u);
  const p2 = c.clone().add(r).add(u);
  const p3 = c.clone().sub(r).add(u);
  const [u0, v0, u1, v1] = uvRect;
  const pos = [p0, p1, p2, p0, p2, p3].flatMap((p) => [p.x, p.y, p.z]);
  const uv = [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [n.x, n.y, n.z]).flat(), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/**
 * Sweeps a moulding profile around a rectangle, mitred at the corners.
 * The rectangle lies in the plane through `c` spanned by `right` and `up`;
 * `out` points away from the plane. Profile points are (o, z): o = distance
 * outward from the rectangle's edge, z = height off the plane. Solid lies on
 * the right of the profile direction.
 */
export function sweepRect(
  c: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, out: THREE.Vector3,
  w: number, h: number, profile: [number, number][], uRepeat: number,
): Geo {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  // Profile normals (2D) per segment, then per vertex with a crease angle.
  const segN: [number, number][] = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const dx = profile[i + 1][0] - profile[i][0];
    const dz = profile[i + 1][1] - profile[i][1];
    const l = Math.hypot(dx, dz) || 1;
    segN.push([-dz / l, dx / l]);
  }
  const vN = (seg: number, end: 0 | 1): [number, number] => {
    const own = segN[seg];
    const nb = segN[seg + (end ? 1 : -1)];
    if (!nb || own[0] * nb[0] + own[1] * nb[1] < 0.7) return own;
    const x = own[0] + nb[0];
    const z = own[1] + nb[1];
    const l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  };
  const vCoord: number[] = [0];
  for (let i = 1; i < profile.length; i++) vCoord.push(vCoord[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const total = vCoord[vCoord.length - 1] || 1;
  const hw = w / 2;
  const hh = h / 2;
  const R = right;
  const U = up;
  const at = (a: number, b: number) => c.clone().addScaledVector(R, a).addScaledVector(U, b);
  // Sides: start corner, end corner, direction along, outward.
  const sides: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3, number][] = [
    [at(-hw, -hh), at(hw, -hh), R.clone(), U.clone().negate(), w],
    [at(hw, -hh), at(hw, hh), U.clone(), R.clone(), h],
    [at(hw, hh), at(-hw, hh), R.clone().negate(), U.clone(), w],
    [at(-hw, hh), at(-hw, -hh), U.clone().negate(), R.clone().negate(), h],
  ];
  const tmp = new THREE.Vector3();
  for (const [p0, p1, s, n, len] of sides) {
    for (let i = 0; i < profile.length - 1; i++) {
      const pts: THREE.Vector3[] = [];
      const ns: THREE.Vector3[] = [];
      const us: number[] = [];
      const vs: number[] = [];
      for (const [k, end] of [[i, 0], [i + 1, 1]] as const) {
        const [o, z] = profile[k];
        const nn = vN(i, end as 0 | 1);
        const N = n.clone().multiplyScalar(nn[0]).addScaledVector(out, nn[1]).normalize();
        pts.push(p0.clone().addScaledVector(n, o).addScaledVector(s, -o).addScaledVector(out, z));
        pts.push(p1.clone().addScaledVector(n, o).addScaledVector(s, o).addScaledVector(out, z));
        ns.push(N, N);
        us.push(-o / uRepeat, (len + o) / uRepeat);
        vs.push(vCoord[k] / total, vCoord[k] / total);
      }
      // pts: a0 (start, k), a1 (end, k), b0 (start, k+1), b1 (end, k+1)
      for (const j of [0, 1, 3, 0, 3, 2]) {
        tmp.copy(pts[j]);
        pos.push(tmp.x, tmp.y, tmp.z);
        nor.push(ns[j].x, ns[j].y, ns[j].z);
        uvs.push(us[j], vs[j]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // Winding depends on the basis; render the mouldings double-sided-safe by
  // checking one triangle against its normal and flipping if needed.
  fixWinding(g);
  return g;
}

/** Flips triangles whose winding disagrees with their stored normals. */
export function fixWinding(g: Geo) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nn = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    nn.set(0, 0, 0);
    for (let k = 0; k < 3; k++) nn.add(tmp.set(n.getX(i + k), n.getY(i + k), n.getZ(i + k)));
    const face = b.clone().sub(a).cross(c.clone().sub(a));
    if (face.dot(nn) < 0) {
      for (const attr of [p, n, uv]) {
        const sz = attr.itemSize;
        for (let k = 0; k < sz; k++) {
          const t = attr.array[(i + 1) * sz + k];
          (attr.array as Float32Array)[(i + 1) * sz + k] = attr.array[(i + 2) * sz + k];
          (attr.array as Float32Array)[(i + 2) * sz + k] = t;
        }
      }
    }
  }
}

/** Frame profile scaled to a border width (inner sight edge → outer edge). */
export function frameProfile(b: number): [number, number][] {
  const d = b * 0.62;
  const P: [number, number][] = [
    [0.0, 0.1], [0.0, 0.3], [0.04, 0.42], [0.09, 0.42], [0.12, 0.36], [0.16, 0.48], [0.28, 0.74], [0.4, 0.92], [0.5, 0.96],
    [0.6, 0.86], [0.68, 0.66], [0.74, 0.6], [0.8, 0.66], [0.86, 0.78], [0.92, 0.74], [0.98, 0.58], [1.0, 0.4], [1.0, 0.0],
  ];
  return P.map(([o, z]) => [o * b, z * d]);
}

/** Cornice profile: inner edge on the ceiling, outer edge down the wall. */
export function corniceProfile(p: number, d: number): [number, number][] {
  const P: [number, number][] = [
    [0, 0], [0.0, 0.08], [0.12, 0.12], [0.2, 0.2], [0.24, 0.3], [0.4, 0.34], [0.52, 0.44], [0.6, 0.58], [0.74, 0.62], [0.82, 0.72],
    [0.86, 0.86], [0.94, 0.9], [1, 1],
  ];
  return P.map(([o, z]) => [o * p, z * d]);
}

/** Lathe around y from a (radius, y) profile, as a mergeable geometry. */
export function lathe(profile: [number, number][], segs = 24, uvRepeat = 1): Geo {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), y)), segs);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * uvRepeat);
  return norm(g);
}

export const T = (g: Geo, x: number, y: number, z: number, s = 1, ry = 0) => {
  if (ry) g.rotateY(ry);
  if (s !== 1) g.scale(s, s, s);
  g.translate(x, y, z);
  return g;
};

// ---- columns -----------------------------------------------------------------------

/** A fluted marble column of height h with gilded base and capital. */
export function column(h: number, r = 0.32): { marble: Geo; gold: Geo; plinth: Geo } {
  const baseH = 0.5;
  const capH = 0.75;
  const shaftH = h - baseH - capH - 0.25;
  const shaft = new THREE.CylinderGeometry(r * 0.9, r, shaftH, 48, 6, true);
  const p = shaft.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const a = Math.atan2(z, x);
    const rr = Math.hypot(x, z);
    const flute = 1 - 0.06 * Math.pow(Math.abs(Math.sin(a * 12)), 0.6);
    p.setX(i, Math.cos(a) * rr * flute);
    p.setZ(i, Math.sin(a) * rr * flute);
  }
  shaft.computeVertexNormals();
  const uv = shaft.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * (shaftH / 2));
  shaft.translate(0, 0.25 + baseH + shaftH / 2, 0);
  const marble = norm(shaft);
  const plinth = box(0, 0.125, 0, r * 2.9, 0.25, r * 2.9, 1);
  const base = lathe([[r * 1.35, 0], [r * 1.35, 0.08], [r * 1.25, 0.12], [r * 1.3, 0.2], [r * 1.12, 0.28], [r * 1.05, 0.34], [r * 1.1, 0.4], [r * 0.98, 0.46], [r * 0.95, baseH]], 32);
  base.translate(0, 0.25, 0);
  const top = h - capH;
  const cap = lathe([
    [r * 0.9, 0], [r * 1.0, 0.04], [r * 0.94, 0.08], [r * 0.95, 0.2], [r * 1.05, 0.36], [r * 1.25, 0.5], [r * 1.42, 0.58], [r * 1.42, 0.62],
  ], 32, 4);
  cap.translate(0, top, 0);
  const abacus = box(0, top + 0.68, 0, r * 3.1, 0.14, r * 3.1, 0.5);
  // Volutes: four gilded scrolls under the corners of the abacus.
  const vol: Geo[] = [];
  for (let k = 0; k < 4; k++) {
    const t = new THREE.TorusGeometry(r * 0.22, r * 0.08, 8, 16);
    t.rotateY(Math.PI / 4 + (k * Math.PI) / 2);
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    t.translate(Math.cos(a) * r * 1.35, top + 0.5, Math.sin(a) * r * 1.35);
    vol.push(norm(t));
  }
  return { marble, gold: merge([base, cap, abacus, ...vol])!, plinth };
}

/** A flat pilaster against a wall, from the floor to height h, facing +z at z = 0. */
export function pilaster(h: number, w = 0.56, d = 0.11): { marble: Geo; gold: Geo; base: Geo } {
  const marble = box(0, (0.64 + h - 0.62) / 2, d / 2, w, h - 0.62 - 0.64, d, 1);
  const base = box(0, 0.28, (d + 0.06) / 2, w + 0.14, 0.56, d + 0.06, 1);
  const gold = merge([
    box(0, 0.6, (d + 0.05) / 2, w + 0.08, 0.08, d + 0.05, 0.4),
    box(0, h - 0.58, (d + 0.03) / 2, w + 0.06, 0.08, d + 0.03, 0.4),
    box(0, h - 0.36, (d + 0.04) / 2, w + 0.04, 0.36, d + 0.04, 0.36),
    box(0, h - 0.12, (d + 0.12) / 2, w + 0.26, 0.12, d + 0.12, 0.4),
  ])!;
  return { marble, gold, base };
}

// ---- velvet rope stanchion ---------------------------------------------------------------

export function stanchion(): Geo {
  return lathe([
    [0, 0], [0.17, 0], [0.17, 0.02], [0.14, 0.05], [0.06, 0.08], [0.03, 0.12], [0.022, 0.16], [0.022, 0.86], [0.035, 0.88], [0.03, 0.9],
    [0.05, 0.93], [0.055, 0.96], [0.04, 0.99], [0.012, 1.01], [0, 1.02],
  ], 20);
}

/** A sagging velvet rope between two post tops. */
export function rope(a: THREE.Vector3, b: THREE.Vector3): Geo {
  const mid = a.clone().lerp(b, 0.5);
  mid.y -= 0.16;
  const curve = new THREE.CatmullRomCurve3([a, a.clone().lerp(mid, 0.5).setY(a.y - 0.11), mid, b.clone().lerp(mid, 0.5).setY(a.y - 0.11), b]);
  return norm(new THREE.TubeGeometry(curve, 24, 0.026, 8, false));
}

// ---- chandelier ------------------------------------------------------------------------

export interface ChandelierGeo {
  brass: Geo;
  crystal: Geo;
  candle: Geo;
  flame: Geo;
  /** Points where sparkles twinkle (local). */
  glints: THREE.Vector3[];
  /** Flame positions (local), for halo sprites. */
  flames: THREE.Vector3[];
  /** Height above the origin of the top (where the chain starts). */
  top: number;
}

/** A crystal chandelier, about 1.5 m across, origin at the candle ring. */
export function chandelier(lo = false): ChandelierGeo {
  const brass: Geo[] = [];
  const crystal: Geo[] = [];
  const candle: Geo[] = [];
  const flame: Geo[] = [];
  const glints: THREE.Vector3[] = [];
  const flames: THREE.Vector3[] = [];

  // Central stem and body.
  brass.push(lathe([
    [0, -0.62], [0.03, -0.58], [0.05, -0.5], [0.03, -0.44], [0.07, -0.38], [0.13, -0.3], [0.16, -0.2], [0.14, -0.12], [0.09, -0.06], [0.05, 0],
    [0.04, 0.1], [0.07, 0.16], [0.06, 0.22], [0.035, 0.3], [0.035, 0.5], [0.08, 0.55], [0.1, 0.6], [0.06, 0.66], [0.03, 0.72], [0.03, 0.88],
    [0.06, 0.92], [0.06, 0.96], [0.02, 1.0], [0, 1.0],
  ], lo ? 10 : 16));
  // Crown ring at the top.
  const crown = new THREE.TorusGeometry(0.26, 0.012, 4, lo ? 12 : 24);
  crown.rotateX(Math.PI / 2);
  crown.translate(0, 0.78, 0);
  brass.push(norm(crown));

  const bead = new THREE.OctahedronGeometry(0.016, 0);
  const drop = new THREE.OctahedronGeometry(0.03, 0);
  drop.scale(0.8, 1.9, 0.8);
  const smallDrop = new THREE.OctahedronGeometry(0.02, 0);
  smallDrop.scale(0.8, 1.8, 0.8);
  const put = (g: Geo, at: THREE.Vector3, into: Geo[]) => into.push(norm(g.clone().translate(at.x, at.y, at.z)));

  const tier = (n: number, R: number, y: number, rise: number, phase: number, scale: number) => {
    const cups: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const p = (r: number, yy: number) => dir.clone().multiplyScalar(r).setY(yy);
      // S-shaped arm.
      const curve = new THREE.CatmullRomCurve3([p(0.06, y - 0.12), p(R * 0.35, y - 0.2), p(R * 0.75, y - 0.16), p(R * 0.98, y - 0.04), p(R, y + rise)]);
      brass.push(norm(new THREE.TubeGeometry(curve, lo ? 6 : 12, 0.014 * scale, lo ? 4 : 5, false)));
      // A small scroll under the arm.
      if (!lo) {
        const sc = new THREE.TorusGeometry(0.05 * scale, 0.008 * scale, 4, 10, Math.PI * 1.4);
        sc.rotateY(-a + Math.PI / 2);
        const sp = p(R * 0.45, y - 0.24);
        sc.translate(sp.x, sp.y, sp.z);
        brass.push(norm(sc));
      }
      const cup = p(R, y + rise);
      cups.push(cup);
      // Bobeche and candle.
      const bob = lathe([[0, 0], [0.06 * scale, 0.01], [0.065 * scale, 0.02], [0.03 * scale, 0.03], [0.02 * scale, 0.05], [0, 0.05]], lo ? 6 : 8);
      brass.push(bob.translate(cup.x, cup.y, cup.z));
      const cnd = new THREE.CylinderGeometry(0.017 * scale, 0.017 * scale, 0.15 * scale, lo ? 5 : 8, 1, true);
      cnd.translate(cup.x, cup.y + 0.05 + 0.075 * scale, cup.z);
      candle.push(norm(cnd));
      const fl = new THREE.SphereGeometry(0.018 * scale, lo ? 4 : 6, lo ? 3 : 4);
      fl.scale(1, 2, 1);
      const fp = new THREE.Vector3(cup.x, cup.y + 0.05 + 0.15 * scale + 0.03 * scale, cup.z);
      fl.translate(fp.x, fp.y, fp.z);
      flame.push(norm(fl));
      flames.push(fp);
      // Pendant drop under the bobeche.
      const dp = cup.clone().setY(cup.y - 0.08);
      put(drop, dp, crystal);
      glints.push(dp);
    }
    // Garlands of beads sagging between neighbouring cups.
    for (let i = 0; i < n; i++) {
      const a = cups[i];
      const b = cups[(i + 1) % n];
      const beads = lo ? 5 : 9;
      for (let k = 1; k < beads; k++) {
        const t = k / beads;
        const q = a.clone().lerp(b, t);
        q.y -= 0.02 + Math.sin(t * Math.PI) * 0.12 * scale;
        put(bead, q, crystal);
        if (k % 3 === 0) glints.push(q);
      }
      // A drop hanging from the lowest point.
      const low = a.clone().lerp(b, 0.5);
      low.y -= 0.02 + 0.12 * scale + 0.06;
      put(smallDrop, low, crystal);
    }
    return cups;
  };
  const lower = tier(8, 0.68, 0, 0.12, 0, 1);
  tier(6, 0.36, 0.42, 0.1, Math.PI / 6, 0.8);
  // Strands from the crown down to the lower arms.
  for (const c of lo ? [] : lower) {
    const top = new THREE.Vector3(c.x * 0.38, 0.78, c.z * 0.38);
    const bot = c.clone().setY(c.y + 0.02);
    const n = 12;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const q = top.clone().lerp(bot, t);
      q.y -= Math.sin(t * Math.PI) * 0.1;
      put(bead, q, crystal);
      if (k % 4 === 0) glints.push(q);
    }
  }
  // A basket of drops round the bottom of the body.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const q = new THREE.Vector3(Math.cos(a) * 0.15, -0.36 - (i % 2) * 0.04, Math.sin(a) * 0.15);
    put(drop, q, crystal);
    glints.push(q);
  }
  put(drop.clone().scale(1.4, 1.4, 1.4), new THREE.Vector3(0, -0.72, 0), crystal);
  bead.dispose();
  drop.dispose();
  smallDrop.dispose();
  return { brass: merge(brass)!, crystal: merge(crystal)!, candle: merge(candle)!, flame: merge(flame)!, glints, flames, top: 1.0 };
}

/** Classical urn for pedestals. */
export function urn(): Geo {
  return lathe([
    [0, 0], [0.12, 0], [0.12, 0.03], [0.07, 0.06], [0.06, 0.12], [0.1, 0.16], [0.2, 0.26], [0.24, 0.38], [0.22, 0.5], [0.15, 0.58],
    [0.13, 0.62], [0.17, 0.66], [0.17, 0.69], [0.1, 0.72], [0.06, 0.78], [0.04, 0.84], [0, 0.86],
  ], 28, 3);
}
