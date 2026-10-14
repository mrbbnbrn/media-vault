// Procedural textures for the museum, painted on in-memory canvases: marble,
// silk damask, mahogany panelling, carpet, coffered ceiling, gilded
// ornament, a painted sky, brass plaques. Nothing is downloaded.

// ---- tileable value noise -------------------------------------------------------

function makeNoise(seed: number) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rnd();
  /** Value noise with period `per` cells (so it tiles). */
  const noise = (x: number, y: number, per: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const x0 = ((xi % per) + per) % per;
    const y0 = ((yi % per) + per) % per;
    const x1 = (x0 + 1) % per;
    const y1 = (y0 + 1) % per;
    const h = (a: number, b: number) => vals[perm[perm[a & 255] + (b & 255)]];
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = h(x0, y0) + (h(x1, y0) - h(x0, y0)) * u;
    const b = h(x0, y1) + (h(x1, y1) - h(x0, y1)) * u;
    return a + (b - a) * v;
  };
  /** Fractal noise over the unit square (u, v in 0..1), tiling. */
  const fbm = (u: number, v: number, base: number, oct: number) => {
    let sum = 0;
    let amp = 0.5;
    let per = base;
    for (let o = 0; o < oct; o++) {
      sum += amp * noise(u * per, v * per, per);
      per *= 2;
      amp *= 0.5;
    }
    return sum;
  };
  return { noise, fbm, rnd };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Marble: a base colour, two vein colours, how strong the veins are. */
function marbleField(size: number, seed: number, base: RGB, cloud: RGB, vein: RGB, veinAmt: number, scale = 3) {
  const n = makeNoise(seed);
  const out = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const w = n.fbm(u, v, scale, 5);
      const c = n.fbm(u + 0.37, v + 0.11, scale + 1, 4);
      // Veins: thin ridges of a warped noise field.
      const ridge = 1 - Math.abs(2 * n.fbm(u + w * 0.55, v + w * 0.4, scale, 4) - 1);
      const vv = Math.pow(ridge, 18) * veinAmt;
      const fine = Math.pow(1 - Math.abs(2 * n.fbm(u * 1 + c * 0.3, v, scale * 2, 3) - 1), 40) * veinAmt * 0.5;
      let col = mix(base, cloud, Math.max(0, Math.min(1, (c - 0.35) * 1.6)));
      col = mix(col, vein, Math.min(1, vv + fine));
      const i = (y * size + x) * 3;
      out[i] = col[0];
      out[i + 1] = col[1];
      out[i + 2] = col[2];
    }
  }
  return out;
}

function putField(ctx: CanvasRenderingContext2D, f: Float32Array, size: number, x0 = 0, y0 = 0) {
  const img = ctx.createImageData(size, size);
  for (let i = 0, j = 0; i < f.length; i += 3, j += 4) {
    img.data[j] = f[i];
    img.data[j + 1] = f[i + 1];
    img.data[j + 2] = f[i + 2];
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, x0, y0);
}

/** Polished floor: big cream marble slabs with small dark-red diamonds where four meet. One canvas = 2 × 2 slabs. */
export function floorMarble(size = 1024): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  putField(ctx, marbleField(size, 7, [222, 212, 194], [206, 192, 170], [140, 128, 114], 0.8), size);
  const half = size / 2;
  // Grout lines.
  ctx.strokeStyle = 'rgba(120, 104, 84, 0.55)';
  ctx.lineWidth = Math.max(1, size / 512);
  for (const p of [0, half, size]) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  // Cabochons: rosso marble diamonds with a thin brass line.
  const red = marbleField(128, 3, [104, 22, 26], [70, 12, 16], [190, 150, 120], 0.6, 2);
  const [rc, rctx] = canvas(128, 128);
  putField(rctx, red, 128);
  const d = size * 0.085;
  for (const [x, y] of [[0, 0], [half, 0], [size, 0], [0, half], [half, half], [size, half], [0, size], [half, size], [size, size]]) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(rc, x - d, y - d, d * 2, d * 2);
    ctx.restore();
    ctx.strokeStyle = 'rgba(196, 160, 90, 0.9)';
    ctx.lineWidth = size / 400;
    ctx.beginPath();
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
    ctx.stroke();
  }
  return c;
}

/** Roughness for the floor: polished slabs, duller grout. */
export function floorRough(size = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  ctx.fillStyle = 'rgb(34,34,34)';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgb(200,200,200)';
  ctx.lineWidth = 2;
  for (const p of [0, size / 2, size]) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  return c;
}

/** White statuary marble for columns, pilasters and door surrounds. */
export function whiteMarble(size = 512): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  putField(ctx, marbleField(size, 11, [240, 236, 228], [226, 220, 210], [140, 136, 132], 0.7, 2), size);
  return c;
}

/** Dark green marble (verde antico) for skirting and plinths. */
export function greenMarble(size = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  putField(ctx, marbleField(size, 5, [22, 44, 34], [12, 26, 20], [150, 170, 150], 0.7, 2), size);
  return c;
}

// ---- damask --------------------------------------------------------------------

function damaskMotif(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  // One symmetric ogee bloom, drawn as mirrored halves.
  for (const m of [1, -1]) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(m, 1);
    ctx.beginPath();
    ctx.moveTo(0, -0.48 * s);
    ctx.bezierCurveTo(0.12 * s, -0.36 * s, 0.05 * s, -0.24 * s, 0.16 * s, -0.16 * s);
    ctx.bezierCurveTo(0.32 * s, -0.06 * s, 0.36 * s, 0.14 * s, 0.22 * s, 0.24 * s);
    ctx.bezierCurveTo(0.12 * s, 0.32 * s, 0.06 * s, 0.38 * s, 0, 0.48 * s);
    ctx.lineTo(0, 0.3 * s);
    ctx.bezierCurveTo(0.12 * s, 0.18 * s, 0.2 * s, 0.06 * s, 0.1 * s, -0.08 * s);
    ctx.bezierCurveTo(0.04 * s, -0.16 * s, 0.03 * s, -0.26 * s, 0, -0.3 * s);
    ctx.closePath();
    ctx.fill();
    // Side leaves.
    ctx.beginPath();
    ctx.moveTo(0.18 * s, -0.02 * s);
    ctx.bezierCurveTo(0.34 * s, -0.24 * s, 0.46 * s, -0.12 * s, 0.42 * s, 0.02 * s);
    ctx.bezierCurveTo(0.36 * s, -0.06 * s, 0.28 * s, -0.06 * s, 0.18 * s, -0.02 * s);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0.06 * s, -0.36 * s);
    ctx.quadraticCurveTo(0.2 * s, -0.46 * s, 0.24 * s, -0.36 * s);
    ctx.quadraticCurveTo(0.16 * s, -0.38 * s, 0.06 * s, -0.36 * s);
    ctx.fill();
    // Small curls.
    ctx.beginPath();
    ctx.arc(0.3 * s, 0.3 * s, 0.035 * s, 0, Math.PI * 2);
    ctx.arc(0.08 * s, 0.06 * s, 0.02 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Centre: a pomegranate.
  ctx.beginPath();
  ctx.ellipse(cx, cy + 0.02 * s, 0.06 * s, 0.09 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Silk damask in the given ground colour; returns the colour map and a bump map. */
export function damask(ground: RGB, size = 512): { map: HTMLCanvasElement; bump: HTMLCanvasElement } {
  const [c, ctx] = canvas(size, size);
  const [b, bctx] = canvas(size, size);
  const n = makeNoise(21);
  // Ground with a woven texture.
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const weave = (Math.sin(y * 1.6) * 0.5 + 0.5) * 0.05 + n.fbm(x / size, y / size, 16, 2) * 0.08;
      const k = 0.92 + weave;
      const i = (y * size + x) * 4;
      img.data[i] = ground[0] * k;
      img.data[i + 1] = ground[1] * k;
      img.data[i + 2] = ground[2] * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  bctx.fillStyle = '#000';
  bctx.fillRect(0, 0, size, size);
  const motifs: [number, number, number][] = [
    [size / 2, size / 2, size * 0.9],
    [0, 0, size * 0.9], [size, 0, size * 0.9], [0, size, size * 0.9], [size, size, size * 0.9],
  ];
  // The pattern is a satin weave: lighter and a touch golden.
  const lite = mix(ground, [210, 150, 100], 0.13);
  ctx.fillStyle = `rgb(${lite.map(Math.round).join(',')})`;
  bctx.fillStyle = '#fff';
  for (const [x, y, s] of motifs) {
    damaskMotif(ctx, x, y, s * 0.62);
    damaskMotif(bctx, x, y, s * 0.62);
  }
  // Small diamonds between.
  const dot = (g: CanvasRenderingContext2D, x: number, y: number) => {
    g.beginPath();
    g.moveTo(x, y - 10);
    g.lineTo(x + 7, y);
    g.lineTo(x, y + 10);
    g.lineTo(x - 7, y);
    g.fill();
  };
  for (const [x, y] of [[size / 2, 0], [0, size / 2], [size, size / 2], [size / 2, size]]) {
    dot(ctx, x, y);
    dot(bctx, x, y);
  }
  return { map: c, bump: b };
}

// ---- mahogany panelling -----------------------------------------------------------

/** One raised panel (1 m wide, 1.1 m tall) of dark mahogany with a gilded inlay line. */
export function wainscot(w = 512, h = 512): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  const n = makeNoise(31);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const warp = n.fbm(u, v, 3, 3);
      const g = Math.sin((u * 60 + warp * 9) * 1.0) * 0.5 + 0.5;
      const fine = n.fbm(u * 1, v, 24, 2);
      const k = 0.65 + g * 0.22 + fine * 0.25;
      const i = (y * w + x) * 4;
      img.data[i] = 92 * k;
      img.data[i + 1] = 38 * k;
      img.data[i + 2] = 22 * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Raised panel: bevels lit from above.
  const m = w * 0.1;
  const bev = w * 0.05;
  const x0 = m;
  const y0 = h * 0.16;
  const x1 = w - m;
  const y1 = h * 0.86;
  ctx.fillStyle = 'rgba(255, 210, 160, 0.12)';
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1 - bev, y0 + bev); ctx.lineTo(x0 + bev, y0 + bev); ctx.fill();
  ctx.fillStyle = 'rgba(255, 210, 160, 0.06)';
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x0 + bev, y0 + bev); ctx.lineTo(x0 + bev, y1 - bev); ctx.lineTo(x0, y1); ctx.fill();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1 - bev, y1 - bev); ctx.lineTo(x0 + bev, y1 - bev); ctx.fill();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.beginPath();
  ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); ctx.lineTo(x1 - bev, y1 - bev); ctx.lineTo(x1 - bev, y0 + bev); ctx.fill();
  // Gilded inlay line and a shadow groove around the panel.
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
  ctx.strokeStyle = 'rgba(214, 170, 84, 0.95)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(x0 + bev + 8, y0 + bev + 8, x1 - x0 - 2 * bev - 16, y1 - y0 - 2 * bev - 16);
  return c;
}

// ---- carpet ------------------------------------------------------------------------

/** Red runner, across = u, along = v (one canvas = 1.5 widths of length). */
export function carpet(w = 256, h = 512): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  const n = makeNoise(41);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = 0.85 + n.fbm(x / w, y / h, 32, 2) * 0.3;
      const i = (y * w + x) * 4;
      img.data[i] = 128 * k;
      img.data[i + 1] = 14 * k;
      img.data[i + 2] = 24 * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const gold = 'rgb(206, 158, 70)';
  const deep = 'rgba(60, 4, 10, 0.75)';
  // Borders: gold band, a dark line, a row of small gold lozenges.
  for (const side of [0, 1]) {
    const x = side ? w : 0;
    const dir = side ? -1 : 1;
    ctx.fillStyle = gold;
    ctx.fillRect(Math.min(x, x + dir * w * 0.07), 0, w * 0.07, h);
    ctx.fillStyle = deep;
    ctx.fillRect(Math.min(x + dir * w * 0.07, x + dir * w * 0.1), 0, w * 0.03, h);
    ctx.fillStyle = gold;
    ctx.fillRect(Math.min(x + dir * w * 0.13, x + dir * w * 0.145), 0, w * 0.015, h);
    for (let y = 0; y < h; y += h / 16) {
      const cx = x + dir * w * 0.105;
      ctx.beginPath();
      ctx.moveTo(cx, y + 4);
      ctx.lineTo(cx + 5, y + h / 32);
      ctx.lineTo(cx, y + h / 16 - 4);
      ctx.lineTo(cx - 5, y + h / 32);
      ctx.fillStyle = gold;
      ctx.fill();
    }
  }
  // A faint medallion in the field.
  ctx.strokeStyle = 'rgba(214, 150, 80, 0.28)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w * 0.22, h * 0.2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w / 2, h * 0.24); ctx.lineTo(w * 0.66, h / 2); ctx.lineTo(w / 2, h * 0.76); ctx.lineTo(w * 0.34, h / 2); ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = 'rgba(214, 150, 80, 0.3)';
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, w * 0.05, 0, Math.PI * 2);
  ctx.fill();
  for (const y of [0, h]) {
    ctx.beginPath();
    ctx.arc(w / 2, y, w * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

// ---- coffered ceiling ------------------------------------------------------------

/** One coffer (square), ivory with gilded mouldings and a rosette. */
export function coffer(size = 512): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  const ivory = '#e9dfc8';
  ctx.fillStyle = ivory;
  ctx.fillRect(0, 0, size, size);
  const steps = [0.1, 0.16, 0.22];
  // Stepped recess: each step a little darker, gold lines between.
  steps.forEach((s, i) => {
    const p = size * s;
    ctx.fillStyle = ['#ddd0b2', '#cdbd99', '#b9a67f'][i];
    ctx.fillRect(p, p, size - 2 * p, size - 2 * p);
    // Light from the room below: lower edge brighter.
    ctx.fillStyle = 'rgba(255,240,210,0.25)';
    ctx.fillRect(p, size - p - size * 0.02, size - 2 * p, size * 0.02);
    ctx.strokeStyle = '#c4943e';
    ctx.lineWidth = size * (i === 0 ? 0.018 : 0.008);
    ctx.strokeRect(p, p, size - 2 * p, size - 2 * p);
  });
  // Recessed field.
  const f = size * 0.28;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.32);
  g.addColorStop(0, '#5d1e24');
  g.addColorStop(1, '#3b1016');
  ctx.fillStyle = g;
  ctx.fillRect(f, f, size - 2 * f, size - 2 * f);
  ctx.strokeStyle = '#d4a24c';
  ctx.lineWidth = size * 0.01;
  ctx.strokeRect(f, f, size - 2 * f, size - 2 * f);
  // Rosette.
  ctx.save();
  ctx.translate(size / 2, size / 2);
  for (let i = 0; i < 12; i++) {
    ctx.rotate(Math.PI / 6);
    ctx.beginPath();
    ctx.ellipse(0, size * 0.07, size * 0.025, size * 0.065, 0, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? '#e2b65e' : '#b8862f';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.04, 0, Math.PI * 2);
  ctx.fillStyle = '#f0cd7a';
  ctx.fill();
  ctx.restore();
  // Egg-and-dart band on the outer moulding.
  ctx.fillStyle = '#c99a44';
  const step = size / 16;
  for (let i = 0; i < 16; i++) {
    for (const [x, y, rot] of [[i * step + step / 2, size * 0.05, 0], [i * step + step / 2, size * 0.95, 0], [size * 0.05, i * step + step / 2, 1], [size * 0.95, i * step + step / 2, 1]] as const) {
      ctx.beginPath();
      ctx.ellipse(x, y, rot ? size * 0.012 : step * 0.28, rot ? step * 0.28 : size * 0.012, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

/** A painted sky for the grand hall's ceiling oval. */
export function fresco(size = 512): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  const n = makeNoise(77);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const cl = n.fbm(u, v, 4, 5);
      const cloud = Math.max(0, Math.min(1, (cl - 0.45) * 3.2));
      // Sky deepens towards the middle; warm golden light at the edges.
      const sky = mix([214, 186, 140], [120, 156, 196], Math.max(0, 1 - d) ** 0.7);
      const col = mix(sky, [250, 238, 222], cloud * 0.85);
      const i = (y * size + x) * 4;
      img.data[i] = col[0];
      img.data[i + 1] = col[1];
      img.data[i + 2] = col[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // A burst of light.
  const g = ctx.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.25);
  g.addColorStop(0, 'rgba(255, 236, 190, 0.8)');
  g.addColorStop(1, 'rgba(255, 236, 190, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// ---- gilding -------------------------------------------------------------------------

/**
 * Carved ornament for frames and mouldings, along u (repeats), across v
 * (the moulding profile): leaves on the crest, beads near the edges. White =
 * raised gold, dark = recesses (also used as the bump map).
 */
export function ornament(w = 256, h = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, w, h);
  // Bead row near the inner edge (v ~ 0.1) and the outer edge (v ~ 0.85).
  const beads = (v: number, count: number, r: number) => {
    for (let i = 0; i < count; i++) {
      const x = ((i + 0.5) / count) * w;
      const g = ctx.createRadialGradient(x - r * 0.3, v * h - r * 0.3, 0, x, v * h, r);
      g.addColorStop(0, '#fff');
      g.addColorStop(1, '#555');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, v * h, r * (i % 2 ? 0.6 : 1.1), r, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  beads(0.12, 8, h * 0.035);
  beads(0.86, 12, h * 0.025);
  // Acanthus leaves on the crest band (v 0.3–0.65).
  for (let i = 0; i < 4; i++) {
    const x = ((i + 0.5) / 4) * w;
    const y0 = h * 0.28;
    const y1 = h * 0.66;
    const g = ctx.createLinearGradient(x - w * 0.1, 0, x + w * 0.1, 0);
    g.addColorStop(0, '#eee');
    g.addColorStop(0.5, '#fff');
    g.addColorStop(1, '#777');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.bezierCurveTo(x + w * 0.14, y0 + h * 0.06, x + w * 0.12, y1 - h * 0.1, x, y1);
    ctx.bezierCurveTo(x - w * 0.12, y1 - h * 0.1, x - w * 0.14, y0 + h * 0.06, x, y0);
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y0 + 6);
    ctx.lineTo(x, y1 - 6);
    for (let k = 1; k < 4; k++) {
      const yy = y0 + ((y1 - y0) * k) / 4;
      ctx.moveTo(x, yy);
      ctx.lineTo(x + w * 0.07, yy - h * 0.04);
      ctx.moveTo(x, yy);
      ctx.lineTo(x - w * 0.07, yy - h * 0.04);
    }
    ctx.stroke();
    // Small flower between leaves.
    const fx = x + w / 8;
    ctx.fillStyle = '#ddd';
    ctx.beginPath();
    ctx.arc(fx, (y0 + y1) / 2, h * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
  // Recess lines between bands.
  ctx.fillStyle = '#333';
  for (const v of [0.21, 0.72, 0.95]) ctx.fillRect(0, v * h, w, h * 0.015);
  return c;
}

/** Soft round glow (additive sprites, wall light pools). */
export function glow(size = 128, warm = true): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const col = warm ? '255, 214, 150' : '255, 255, 255';
  g.addColorStop(0, `rgba(${col}, 1)`);
  g.addColorStop(0.25, `rgba(${col}, 0.55)`);
  g.addColorStop(0.6, `rgba(${col}, 0.12)`);
  g.addColorStop(1, `rgba(${col}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** A light pool for over a picture: bright at the top, fading down and out. */
export function lightPool(w = 256, h = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  // Drawn in unit space so the ellipse fades out before every edge.
  ctx.setTransform(w, 0, 0, h, 0, 0);
  const g = ctx.createRadialGradient(0.5, 0.36, 0, 0.5, 0.42, 0.48);
  g.addColorStop(0, 'rgba(255, 222, 165, 0.95)');
  g.addColorStop(0.35, 'rgba(255, 205, 140, 0.45)');
  g.addColorStop(0.75, 'rgba(255, 190, 120, 0.1)');
  g.addColorStop(1, 'rgba(255, 190, 120, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1, 1);
  return c;
}

/** Vertical fade used for soft contact shadows (dark at v = 0). */
export function fade(size = 64): HTMLCanvasElement {
  const [c, ctx] = canvas(4, size);
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.4, 'rgba(0,0,0,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, size);
  return c;
}

/** A round soft shadow. */
export function blob(size = 64): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// ---- text ------------------------------------------------------------------------------

const SERIF = '"Cormorant Garamond", "Garamond", "Palatino Linotype", "Book Antiqua", Georgia, "Times New Roman", serif';

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight = '600'): number {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px ${SERIF}`;
    if (ctx.measureText(text).width <= maxW) break;
    s -= 2;
  } while (s > 14);
  return s;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Brass name plaque with engraved text (2 lines: name, detail). */
export function plaque(name: string, detail: string, w = 512, h = 160): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f3d58e');
  g.addColorStop(0.45, '#c9a050');
  g.addColorStop(0.55, '#b88d3f');
  g.addColorStop(1, '#e6c27a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Brushed lines.
  ctx.globalAlpha = 0.12;
  for (let x = 0; x < w; x += 3) {
    ctx.fillStyle = x % 2 ? '#fff' : '#6b4a14';
    ctx.fillRect(x, 0, 1, h);
  }
  ctx.globalAlpha = 1;
  // Bevel and engraved border.
  ctx.strokeStyle = 'rgba(255,245,210,0.8)';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);
  ctx.strokeStyle = 'rgba(80,52,10,0.7)';
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 16, w - 32, h - 32);
  // Screws.
  for (const x of [30, w - 30]) {
    ctx.fillStyle = '#7a5a20';
    ctx.beginPath();
    ctx.arc(x, h / 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f6dd9a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 5, h / 2 - 3);
    ctx.lineTo(x + 5, h / 2 + 3);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxW = w - 110;
  const s = fitText(ctx, name, maxW, 62, '700');
  ctx.font = `700 ${s}px ${SERIF}`;
  const nm = ellipsize(ctx, name, maxW);
  const y1 = detail ? h * 0.42 : h / 2;
  // Engraving: dark cut with a light lower lip.
  ctx.fillStyle = 'rgba(255,240,200,0.7)';
  ctx.fillText(nm, w / 2, y1 + 2);
  ctx.fillStyle = '#3a2508';
  ctx.fillText(nm, w / 2, y1);
  if (detail) {
    ctx.font = `italic 600 34px ${SERIF}`;
    const d = ellipsize(ctx, detail, maxW);
    ctx.fillStyle = 'rgba(255,240,200,0.6)';
    ctx.fillText(d, w / 2, h * 0.73 + 1.5);
    ctx.fillStyle = '#4a3110';
    ctx.fillText(d, w / 2, h * 0.73);
  }
  return c;
}

/** Gilded sign above a doorway, e.g. "Gallery III". */
export function sign(text: string, sub: string, w = 1024, h = 256): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  // Dark green marble plate in a gold cartouche.
  const n = greenMarble(256);
  ctx.drawImage(n, 0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#d9ad57';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, w - 14, h - 14);
  ctx.strokeStyle = '#8a6420';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, w - 48, h - 48);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const s = fitText(ctx, text.toUpperCase(), w - 140, 110, '600');
  ctx.font = `600 ${s}px ${SERIF}`;
  const g = ctx.createLinearGradient(0, h * 0.2, 0, h * 0.7);
  g.addColorStop(0, '#fff1c4');
  g.addColorStop(0.5, '#e4b75c');
  g.addColorStop(1, '#a8781f');
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillText(text.toUpperCase(), w / 2 + 3, (sub ? h * 0.42 : h / 2) + 4);
  ctx.fillStyle = g;
  ctx.fillText(text.toUpperCase(), w / 2, sub ? h * 0.42 : h / 2);
  if (sub) {
    ctx.font = `italic 500 46px ${SERIF}`;
    ctx.fillStyle = '#e8c87e';
    ctx.fillText(ellipsize(ctx, sub, w - 140), w / 2, h * 0.76);
  }
  return c;
}

/** Placeholder for a picture that hasn't loaded yet: a dim, warm canvas. */
export function placeholder(size = 64): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#2a1d14');
  g.addColorStop(1, '#17100b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** Door panels: dark wood with gilded raised panels. */
export function doorLeaf(w = 256, h = 512): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  ctx.drawImage(wainscot(256, 256), 0, 0, w, h);
  ctx.fillStyle = 'rgba(20, 6, 2, 0.35)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#d6a650';
  ctx.lineWidth = 6;
  const m = w * 0.14;
  ctx.strokeRect(m, h * 0.06, w - 2 * m, h * 0.4);
  ctx.strokeRect(m, h * 0.52, w - 2 * m, h * 0.42);
  ctx.lineWidth = 2;
  ctx.strokeRect(m + 14, h * 0.06 + 14, w - 2 * m - 28, h * 0.4 - 28);
  ctx.strokeRect(m + 14, h * 0.52 + 14, w - 2 * m - 28, h * 0.42 - 28);
  // A gilded rosette in each panel.
  for (const y of [h * 0.26, h * 0.73]) {
    ctx.fillStyle = '#e2b85e';
    ctx.beginPath();
    ctx.arc(w / 2, y, w * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8c6220';
    ctx.beginPath();
    ctx.arc(w / 2, y, w * 0.04, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}
