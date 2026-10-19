// Saved 3D layers (plate.ts): Layered 3D's background plate and the subject's
// own layer are RGBA pictures at the plate's size whose colours are mostly the
// picture itself. They are saved as only what differs: the alpha (the depth)
// whole, a bit per pixel saying which colours changed, and those colours,
// compressed (deflate). Read back onto the picture decoded at the same size,
// they are exactly what was made. Pure arithmetic plus the browser's own
// compression streams; works in the layer worker and here.
//
// Layout: "MVL1", width u32, height u32, changed u32 (little-endian), then
// deflate-raw( alpha[w·h] · changed bits[⌈w·h/8⌉] · rgb[changed·3] ).

const MAGIC = [0x4d, 0x56, 0x4c, 0x31]; // "MVL1"

/** What differs from `orig` (RGBA, w × h), uncompressed; `changed` = how many colours differ. */
export function diffLayer(orig: ArrayLike<number>, layer: ArrayLike<number>, w: number, h: number): { body: Uint8Array; changed: number } {
  const n = w * h;
  const bits = Math.ceil(n / 8);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (layer[o] !== orig[o] || layer[o + 1] !== orig[o + 1] || layer[o + 2] !== orig[o + 2]) changed++;
  }
  const body = new Uint8Array(n + bits + changed * 3);
  let c = n + bits;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    body[i] = layer[o + 3];
    if (layer[o] !== orig[o] || layer[o + 1] !== orig[o + 1] || layer[o + 2] !== orig[o + 2]) {
      body[n + (i >> 3)] |= 1 << (i & 7);
      body[c++] = layer[o];
      body[c++] = layer[o + 1];
      body[c++] = layer[o + 2];
    }
  }
  return { body, changed };
}

/** The layer again from `orig` (RGBA, w × h) and what differed. */
export function applyLayer(orig: ArrayLike<number>, body: Uint8Array, w: number, h: number, changed: number): Uint8Array {
  const n = w * h;
  const bits = Math.ceil(n / 8);
  if (body.length !== n + bits + changed * 3) throw new Error('The saved 3D layer is damaged.');
  const out = new Uint8Array(n * 4);
  let c = n + bits;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (body[n + (i >> 3)] & (1 << (i & 7))) {
      out[o] = body[c++];
      out[o + 1] = body[c++];
      out[o + 2] = body[c++];
    } else {
      out[o] = orig[o];
      out[o + 1] = orig[o + 1];
      out[o + 2] = orig[o + 2];
    }
    out[o + 3] = body[i];
  }
  return out;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** A layer packed for saving. */
export async function packLayer(orig: ArrayLike<number>, layer: ArrayLike<number>, w: number, h: number): Promise<Uint8Array> {
  const { body, changed } = diffLayer(orig, layer, w, h);
  const z = await through(body, new CompressionStream('deflate-raw'));
  const out = new Uint8Array(16 + z.length);
  out.set(MAGIC, 0);
  const v = new DataView(out.buffer);
  v.setUint32(4, w, true);
  v.setUint32(8, h, true);
  v.setUint32(12, changed, true);
  out.set(z, 16);
  return out;
}

/** The size a packed layer was made at (the picture is decoded at this size to read it back). */
export function packedSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 16 || MAGIC.some((m, i) => bytes[i] !== m)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = v.getUint32(4, true);
  const h = v.getUint32(8, true);
  return w > 0 && h > 0 && w <= 8192 && h <= 8192 ? { w, h } : null;
}

/** A packed layer read back onto `orig` (the picture at the packed size). */
export async function unpackLayer(orig: ArrayLike<number>, bytes: Uint8Array): Promise<Uint8Array> {
  const size = packedSize(bytes);
  if (!size) throw new Error('The saved 3D layer is damaged.');
  const changed = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
  const body = await through(bytes.subarray(16), new DecompressionStream('deflate-raw'));
  return applyLayer(orig, body, size.w, size.h, changed);
}
