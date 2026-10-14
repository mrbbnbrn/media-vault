//! The picture maths behind the upscaler, kept apart from the AI models so
//! it can be tested without them: how big the result may be, resizing,
//! cutting a picture into overlapping tiles and blending them back without
//! seams, and lining faces up with the standard 512×512 face layout (and
//! pasting them back with a soft edge).
//!
//! Pictures here are RGB, interleaved, as f32 in 0…1. Pixel `i` covers the
//! span [i, i+1), so its centre is at i + 0.5.

/// Every model here makes pictures 4 times as wide and tall.
pub const SCALE: usize = 4;
/// Biggest result, in pixels (4096 × 4096).
pub const MAX_OUT_PX: u64 = 4096 * 4096;
/// Longest side of a result (the window can't show wider pictures well).
pub const MAX_OUT_SIDE: u64 = 16384;
/// Below this, upscaling isn't worth it: the picture is already big.
pub const MIN_FACTOR: f64 = 1.5;

/// The tile the upscaling model sees at once (always this size; edges are
/// mirrored to fill it).
pub const TILE: usize = 192;
/// How much neighbouring tiles share, in input pixels.
pub const OVERLAP: usize = 24;
/// Pixels at a tile's inner edges that are never used (the model sees too
/// little around them).
pub const MARGIN: usize = 4;

// ---- how big ----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// What the model gets (the picture itself, or smaller for big pictures).
    pub in_w: usize,
    pub in_h: usize,
    /// What comes out (always 4 × the model's input).
    pub out_w: usize,
    pub out_h: usize,
}

impl Plan {
    /// How much bigger than the original, e.g. 4.0 or 2.3.
    pub fn factor(&self, orig_w: usize) -> f64 {
        self.out_w as f64 / orig_w.max(1) as f64
    }
}

/// How a `w` × `h` picture is upscaled: ×4, or less for bigger pictures so
/// the result stays within 16 megapixels. Bigger pictures are first made
/// smaller, then upscaled ×4. (The window has the same rule in upscale.ts.)
pub fn plan(w: usize, h: usize) -> Result<Plan, String> {
    if w == 0 || h == 0 {
        return Err("This picture is empty.".into());
    }
    let px = w as f64 * h as f64;
    let f = (MAX_OUT_PX as f64 / px)
        .sqrt()
        .min(MAX_OUT_SIDE as f64 / w.max(h) as f64)
        .min(SCALE as f64);
    if f < MIN_FACTOR {
        return Err(format!(
            "This picture is already big ({w} × {h}). Upscaling is for smaller pictures."
        ));
    }
    let (in_w, in_h) = if f >= SCALE as f64 {
        (w, h)
    } else {
        let k = f / SCALE as f64;
        (((w as f64 * k).floor() as usize).max(1), ((h as f64 * k).floor() as usize).max(1))
    };
    Ok(Plan { in_w, in_h, out_w: in_w * SCALE, out_h: in_h * SCALE })
}

// ---- resizing ---------------------------------------------------------------------------

fn lanczos3(x: f32) -> f32 {
    let x = x.abs();
    if x < 1e-6 {
        return 1.0;
    }
    if x >= 3.0 {
        return 0.0;
    }
    let px = std::f32::consts::PI * x;
    3.0 * px.sin() * (px / 3.0).sin() / (px * px)
}

/// For each destination index: the first source index and its weights.
fn contributions(src: usize, dst: usize) -> Vec<(usize, Vec<f32>)> {
    let scale = dst as f32 / src as f32;
    // Shrinking widens the filter so nothing aliases.
    let stretch = scale.min(1.0);
    let support = 3.0 / stretch;
    (0..dst)
        .map(|i| {
            let centre = (i as f32 + 0.5) / scale;
            let lo = (centre - support).floor() as isize;
            let hi = (centre + support).ceil() as isize;
            let lo_c = lo.max(0) as usize;
            let hi_c = (hi.min(src as isize - 1)).max(0) as usize;
            let mut w = vec![0.0f32; hi_c + 1 - lo_c];
            for j in lo..=hi {
                let wt = lanczos3((j as f32 + 0.5 - centre) * stretch);
                let jc = j.clamp(0, src as isize - 1) as usize;
                w[jc - lo_c] += wt;
            }
            let sum: f32 = w.iter().sum();
            if sum.abs() > 1e-8 {
                w.iter_mut().for_each(|v| *v /= sum);
            }
            (lo_c, w)
        })
        .collect()
}

/// Resize an interleaved picture with `ch` channels (Lanczos, anti-aliased).
pub fn resize(src: &[f32], ch: usize, sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
    if sw == dw && sh == dh {
        return src.to_vec();
    }
    // Rows first (width), then columns.
    let cx = contributions(sw, dw);
    let mut mid = vec![0.0f32; dw * sh * ch];
    for y in 0..sh {
        let row = &src[y * sw * ch..(y + 1) * sw * ch];
        let out = &mut mid[y * dw * ch..(y + 1) * dw * ch];
        for (x, (lo, w)) in cx.iter().enumerate() {
            for c in 0..ch {
                let mut acc = 0.0;
                for (k, wt) in w.iter().enumerate() {
                    acc += row[(lo + k) * ch + c] * wt;
                }
                out[x * ch + c] = acc;
            }
        }
    }
    let cy = contributions(sh, dh);
    let mut out = vec![0.0f32; dw * dh * ch];
    for (y, (lo, w)) in cy.iter().enumerate() {
        let o = &mut out[y * dw * ch..(y + 1) * dw * ch];
        for (k, wt) in w.iter().enumerate() {
            let r = &mid[(lo + k) * dw * ch..(lo + k + 1) * dw * ch];
            for (a, b) in o.iter_mut().zip(r) {
                *a += b * wt;
            }
        }
    }
    out
}

// ---- tiles ------------------------------------------------------------------------------

/// Where the tiles start along one side `len` long. The last tile ends at
/// the edge (sharing more with its neighbour when it must).
pub fn tile_starts(len: usize, tile: usize, overlap: usize) -> Vec<usize> {
    if len <= tile {
        return vec![0];
    }
    let step = tile - overlap;
    let mut v = Vec::new();
    let mut p = 0;
    loop {
        if p + tile >= len {
            v.push(len - tile);
            break;
        }
        v.push(p);
        p += step;
    }
    v.dedup();
    v
}

/// How much a tile starting at `s` (covering `l` pixels of a side `len`
/// long) counts at position `x` (input pixels, continuous). Inner edges fade
/// in over the shared strip so neighbours always add up to 1.
pub fn axis_weight(x: f32, s: usize, l: usize, len: usize) -> f32 {
    let ramp = (OVERLAP - 2 * MARGIN) as f32;
    let mut w: f32 = 1.0;
    if s > 0 {
        w = w.min(((x - (s + MARGIN) as f32) / ramp).clamp(0.0, 1.0));
    }
    if s + l < len {
        w = w.min((((s + l - MARGIN) as f32 - x) / ramp).clamp(0.0, 1.0));
    }
    w
}

fn mirror(i: isize, len: usize) -> usize {
    if len == 1 {
        return 0;
    }
    let n = len as isize;
    let period = 2 * (n - 1);
    let mut m = i.rem_euclid(period);
    if m >= n {
        m = period - m;
    }
    m as usize
}

/// The upscaling model, one tile at a time.
pub type TileModel<'a> = dyn FnMut(&[f32]) -> Result<Vec<f32>, String> + 'a;

/// Upscale an RGB picture ×4 tile by tile. `model` gets one tile (planar
/// 3 × TILE × TILE) and gives back planar 3 × 4·TILE × 4·TILE. `tick` is
/// called after each tile with (done, total) and returns false to stop.
pub fn upscale_tiled(
    img: &[f32],
    w: usize,
    h: usize,
    model: &mut TileModel,
    tick: &mut dyn FnMut(usize, usize) -> bool,
) -> Result<Vec<f32>, String> {
    const T: usize = TILE;
    let ot = T * SCALE;
    let (ow, oh) = (w * SCALE, h * SCALE);
    let xs = tile_starts(w, T, OVERLAP);
    let ys = tile_starts(h, T, OVERLAP);
    let total = xs.len() * ys.len();
    let mut acc = vec![0.0f32; ow * oh * 3];
    let mut wsum = vec![0.0f32; ow * oh];
    let mut tile = vec![0.0f32; 3 * T * T];
    let mut done = 0;
    for &ty in &ys {
        let lh = T.min(h);
        // Output rows' weights for this row of tiles.
        let wy: Vec<f32> = (0..lh * SCALE)
            .map(|j| axis_weight(((ty * SCALE + j) as f32 + 0.5) / SCALE as f32, ty, lh, h))
            .collect();
        for &tx in &xs {
            let lw = T.min(w);
            for y in 0..T {
                let sy = mirror(ty as isize + y as isize, h).min(h - 1);
                for x in 0..T {
                    let sx = mirror(tx as isize + x as isize, w).min(w - 1);
                    let p = (sy * w + sx) * 3;
                    for c in 0..3 {
                        tile[c * T * T + y * T + x] = img[p + c];
                    }
                }
            }
            let out = model(&tile)?;
            if out.len() != 3 * ot * ot {
                return Err("The upscaler gave back something unexpected.".into());
            }
            let wx: Vec<f32> = (0..lw * SCALE)
                .map(|i| axis_weight(((tx * SCALE + i) as f32 + 0.5) / SCALE as f32, tx, lw, w))
                .collect();
            for (j, &wyj) in wy.iter().enumerate() {
                if wyj <= 0.0 {
                    continue;
                }
                let oy = ty * SCALE + j;
                for (i, &wxi) in wx.iter().enumerate() {
                    let wt = wxi * wyj;
                    if wt <= 0.0 {
                        continue;
                    }
                    let ox = tx * SCALE + i;
                    let q = oy * ow + ox;
                    wsum[q] += wt;
                    for c in 0..3 {
                        acc[q * 3 + c] += wt * out[c * ot * ot + j * ot + i];
                    }
                }
            }
            done += 1;
            if !tick(done, total) {
                return Err(STOPPED.into());
            }
        }
    }
    for (q, &s) in wsum.iter().enumerate() {
        let k = if s > 0.0 { 1.0 / s } else { 0.0 };
        for c in 0..3 {
            acc[q * 3 + c] = (acc[q * 3 + c] * k).clamp(0.0, 1.0);
        }
    }
    Ok(acc)
}

/// The error text for "cancelled" (never shown).
pub const STOPPED: &str = "stopped";

// ---- faces ------------------------------------------------------------------------------

/// The face size the face model works at.
pub const FACE: usize = 512;

/// Where the eyes, nose tip and mouth corners sit in a 512 × 512 face
/// (pixel centres; the FFHQ layout GFPGAN was trained on). Order: the eye
/// on the left of the picture, the other eye, nose, mouth left, mouth right.
pub const FACE_TEMPLATE: [[f32; 2]; 5] = [
    [192.98138, 239.94708],
    [318.90277, 240.1936],
    [256.63416, 314.01935],
    [201.26117, 371.41043],
    [313.08905, 371.15118],
];

/// A similarity transform (turn, uniform scale, shift): p ↦ [a −b; b a]·p + t.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Similarity {
    pub a: f32,
    pub b: f32,
    pub tx: f32,
    pub ty: f32,
}

impl Similarity {
    pub fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (self.a * x - self.b * y + self.tx, self.b * x + self.a * y + self.ty)
    }
    pub fn scale(&self) -> f32 {
        (self.a * self.a + self.b * self.b).sqrt()
    }
    pub fn inverse(&self) -> Similarity {
        let d = self.a * self.a + self.b * self.b;
        let (a, b) = (self.a / d, -self.b / d);
        // p = R⁻¹(q − t)
        Similarity { a, b, tx: -(a * self.tx - b * self.ty), ty: -(b * self.tx + a * self.ty) }
    }
}

/// The best similarity transform taking `src` points onto `dst` (least squares).
pub fn fit_similarity(src: &[[f32; 2]], dst: &[[f32; 2]]) -> Option<Similarity> {
    let n = src.len().min(dst.len());
    if n < 2 {
        return None;
    }
    let mean = |p: &[[f32; 2]]| {
        let (sx, sy) = p[..n].iter().fold((0.0, 0.0), |(x, y), q| (x + q[0], y + q[1]));
        (sx / n as f32, sy / n as f32)
    };
    let (mx, my) = mean(src);
    let (nx, ny) = mean(dst);
    let (mut num_a, mut num_b, mut den) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..n {
        let (px, py) = (src[i][0] - mx, src[i][1] - my);
        let (qx, qy) = (dst[i][0] - nx, dst[i][1] - ny);
        num_a += px * qx + py * qy;
        num_b += px * qy - py * qx;
        den += px * px + py * py;
    }
    if den < 1e-6 {
        return None;
    }
    let (a, b) = (num_a / den, num_b / den);
    Some(Similarity { a, b, tx: nx - (a * mx - b * my), ty: ny - (b * mx + a * my) })
}

/// The transform from picture coordinates (continuous) into the 512 face.
pub fn face_transform(points: &[[f32; 2]; 5]) -> Option<Similarity> {
    let dst: Vec<[f32; 2]> = FACE_TEMPLATE.iter().map(|p| [p[0] + 0.5, p[1] + 0.5]).collect();
    fit_similarity(points, &dst)
}

fn sample(img: &[f32], w: usize, h: usize, x: f32, y: f32, out: &mut [f32; 3], border: [f32; 3]) {
    // To index space (centres on integers).
    let (fx, fy) = (x - 0.5, y - 0.5);
    let (x0, y0) = (fx.floor(), fy.floor());
    let (dx, dy) = (fx - x0, fy - y0);
    let (x0, y0) = (x0 as isize, y0 as isize);
    let px = |xx: isize, yy: isize, c: usize| -> f32 {
        if xx < 0 || yy < 0 || xx >= w as isize || yy >= h as isize {
            border[c]
        } else {
            img[(yy as usize * w + xx as usize) * 3 + c]
        }
    };
    for (c, o) in out.iter_mut().enumerate() {
        let top = px(x0, y0, c) * (1.0 - dx) + px(x0 + 1, y0, c) * dx;
        let bot = px(x0, y0 + 1, c) * (1.0 - dx) + px(x0 + 1, y0 + 1, c) * dx;
        *o = top * (1.0 - dy) + bot * dy;
    }
}

/// Grey outside the picture (what GFPGAN's own tools use).
const FACE_BORDER: [f32; 3] = [132.0 / 255.0, 133.0 / 255.0, 135.0 / 255.0];

/// Cut the face out of the picture, lined up, as the face model wants it:
/// planar 3 × 512 × 512, −1…1.
pub fn warp_face(img: &[f32], w: usize, h: usize, m: &Similarity) -> Vec<f32> {
    let inv = m.inverse();
    let mut out = vec![0.0f32; 3 * FACE * FACE];
    let mut px = [0.0f32; 3];
    for v in 0..FACE {
        for u in 0..FACE {
            let (x, y) = inv.apply(u as f32 + 0.5, v as f32 + 0.5);
            sample(img, w, h, x, y, &mut px, FACE_BORDER);
            for c in 0..3 {
                out[c * FACE * FACE + v * FACE + u] = px[c] * 2.0 - 1.0;
            }
        }
    }
    out
}

/// How much of the restored face is used at (u, v) in the 512 face: all of
/// it in the middle, fading out towards the edges.
pub fn face_mask(u: f32, v: f32) -> f32 {
    let f = FACE as f32;
    let d = u.min(f - u).min(v).min(f - v);
    const START: f32 = 20.0;
    const FULL: f32 = 84.0;
    let t = ((d - START) / (FULL - START)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Put a restored face (planar 3 × 512 × 512, −1…1) back into the upscaled
/// picture `out` (`ow` × `oh`, `s` times the size of the picture `m` was made
/// for), blending with a soft edge.
pub fn paste_face(out: &mut [f32], ow: usize, oh: usize, s: f32, m: &Similarity, face: &[f32]) {
    // The face as interleaved 0…1.
    let mut rgb = vec![0.0f32; FACE * FACE * 3];
    for i in 0..FACE * FACE {
        for c in 0..3 {
            rgb[i * 3 + c] = ((face[c * FACE * FACE + i] + 1.0) * 0.5).clamp(0.0, 1.0);
        }
    }
    // Output pixels → face pixels: q = M(p / s).
    let to_face = Similarity { a: m.a / s, b: m.b / s, tx: m.tx, ty: m.ty };
    // Shown smaller than 512? Shrink it first so it doesn't sparkle.
    let k = to_face.scale();
    let (src, sw, kk) = if k > 1.25 {
        let n = ((FACE as f32 / k).round() as usize).max(8);
        (resize(&rgb, 3, FACE, FACE, n, n), n, n as f32 / FACE as f32)
    } else {
        (rgb, FACE, 1.0)
    };
    // Where the face lands in the output.
    let back = to_face.inverse();
    let corners = [(0.0, 0.0), (FACE as f32, 0.0), (0.0, FACE as f32), (FACE as f32, FACE as f32)];
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (u, v) in corners {
        let (x, y) = back.apply(u, v);
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    let xa = (x0.floor().max(0.0) as usize).min(ow);
    let xb = (x1.ceil().max(0.0) as usize).min(ow);
    let ya = (y0.floor().max(0.0) as usize).min(oh);
    let yb = (y1.ceil().max(0.0) as usize).min(oh);
    let mut px = [0.0f32; 3];
    for y in ya..yb {
        for x in xa..xb {
            let (u, v) = to_face.apply(x as f32 + 0.5, y as f32 + 0.5);
            let a = face_mask(u, v);
            if a <= 0.0 {
                continue;
            }
            sample(&src, sw, sw, u * kk, v * kk, &mut px, [0.0; 3]);
            let o = (y * ow + x) * 3;
            for c in 0..3 {
                out[o + c] = out[o + c] * (1.0 - a) + px[c] * a;
            }
        }
    }
}

/// Eye distance in the picture, in pixels (tiny faces are left alone).
pub fn eye_distance(points: &[[f32; 2]; 5]) -> f32 {
    let (dx, dy) = (points[1][0] - points[0][0], points[1][1] - points[0][1]);
    (dx * dx + dy * dy).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans() {
        let p = plan(800, 600).unwrap();
        assert_eq!((p.in_w, p.in_h, p.out_w, p.out_h), (800, 600, 3200, 2400));
        assert_eq!(p.factor(800), 4.0);
        // 2000 × 1500: 3 MP → ×2.3, made smaller first.
        let p = plan(2000, 1500).unwrap();
        assert!(p.in_w < 2000 && p.out_w > 4000);
        assert!((p.out_w * p.out_h) as u64 <= MAX_OUT_PX);
        assert!((p.factor(2000) - 2.36).abs() < 0.02, "{}", p.factor(2000));
        // A 12 MP photo is already big.
        assert!(plan(4000, 3000).is_err());
        assert!(plan(0, 10).is_err());
        // Very long and thin: limited by the longest side.
        let p = plan(6000, 20).unwrap();
        assert!(p.out_w as u64 <= MAX_OUT_SIDE);
        assert_eq!(plan(1, 1).unwrap().out_w, 4);
    }

    #[test]
    fn tiles_cover_everything() {
        assert_eq!(tile_starts(100, 192, 24), vec![0]);
        assert_eq!(tile_starts(192, 192, 24), vec![0]);
        assert_eq!(tile_starts(193, 192, 24), vec![0, 1]);
        let v = tile_starts(1000, 192, 24);
        assert_eq!(v[0], 0);
        assert_eq!(*v.last().unwrap(), 1000 - 192);
        for p in v.windows(2) {
            assert!(p[1] > p[0] && p[1] - p[0] <= 192 - 24);
        }
    }

    #[test]
    fn weights_add_up() {
        let len = 700;
        let starts = tile_starts(len, TILE, OVERLAP);
        for i in 0..len * 4 {
            let x = (i as f32 + 0.5) / 4.0;
            let s: f32 = starts.iter().map(|&st| axis_weight(x, st, TILE, len)).sum();
            assert!(s > 0.99, "x={x} sum={s}");
            // Where two neighbours meet at the normal distance they add up to exactly 1.
            if x < starts[starts.len() - 2] as f32 {
                assert!((s - 1.0).abs() < 1e-4, "x={x} sum={s}");
            }
        }
    }

    fn picture(w: usize, h: usize) -> Vec<f32> {
        (0..w * h * 3).map(|i| ((i * 37 % 101) as f32) / 100.0).collect()
    }

    /// A stand-in for the model: plain ×4 pixel copies.
    fn nearest(t: &[f32]) -> Vec<f32> {
        let ot = TILE * 4;
        let mut o = vec![0.0; 3 * ot * ot];
        for c in 0..3 {
            for y in 0..ot {
                for x in 0..ot {
                    o[c * ot * ot + y * ot + x] = t[c * TILE * TILE + (y / 4) * TILE + x / 4];
                }
            }
        }
        o
    }

    #[test]
    fn tiles_join_without_seams() {
        let (w, h) = (450, 230);
        let img = picture(w, h);
        let mut calls = 0;
        let out = upscale_tiled(&img, w, h, &mut |t| { calls += 1; Ok(nearest(t)) }, &mut |_, _| true).unwrap();
        assert_eq!(calls, tile_starts(w, TILE, OVERLAP).len() * tile_starts(h, TILE, OVERLAP).len());
        for y in 0..h * 4 {
            for x in 0..w * 4 {
                for c in 0..3 {
                    let want = img[((y / 4) * w + x / 4) * 3 + c];
                    let got = out[(y * w * 4 + x) * 3 + c];
                    assert!((want - got).abs() < 1e-4, "({x},{y}) {want} vs {got}");
                }
            }
        }
    }

    #[test]
    fn tile_edge_mistakes_never_show() {
        // A model that gets the outer 2 pixels of every tile wrong.
        let (w, h) = (500, 400);
        let img = picture(w, h);
        let bad = |t: &[f32]| {
            let mut o = nearest(t);
            let ot = TILE * 4;
            for c in 0..3 {
                for y in 0..ot {
                    for x in 0..ot {
                        if x < 8 || y < 8 || x >= ot - 8 || y >= ot - 8 {
                            o[c * ot * ot + y * ot + x] = 5.0;
                        }
                    }
                }
            }
            o
        };
        let out = upscale_tiled(&img, w, h, &mut |t| Ok(bad(t)), &mut |_, _| true).unwrap();
        // Away from the picture's own edges, nothing of the mistakes is left.
        for y in 8..h * 4 - 8 {
            for x in 8..w * 4 - 8 {
                let want = img[((y / 4) * w + x / 4) * 3];
                let got = out[(y * w * 4 + x) * 3];
                assert!((want - got).abs() < 1e-4, "({x},{y})");
            }
        }
    }

    #[test]
    fn small_pictures_are_mirrored_into_one_tile() {
        let (w, h) = (37, 5);
        let img = picture(w, h);
        let out = upscale_tiled(&img, w, h, &mut |t| Ok(nearest(t)), &mut |_, _| true).unwrap();
        assert_eq!(out.len(), w * 4 * h * 4 * 3);
        assert!((out[(19 * w * 4 + 147) * 3 + 1] - img[(4 * w + 36) * 3 + 1]).abs() < 1e-5);
    }

    #[test]
    fn stopping_stops() {
        let img = picture(500, 500);
        let r = upscale_tiled(&img, 500, 500, &mut |t| Ok(nearest(t)), &mut |d, _| d < 2);
        assert_eq!(r.unwrap_err(), STOPPED);
    }

    #[test]
    fn resize_keeps_flat_colour_and_size() {
        let src = vec![0.25f32; 40 * 30 * 3];
        for (dw, dh) in [(80, 60), (13, 7), (40, 30), (1, 1)] {
            let r = resize(&src, 3, 40, 30, dw, dh);
            assert_eq!(r.len(), dw * dh * 3);
            assert!(r.iter().all(|v| (v - 0.25).abs() < 1e-4));
        }
        // A step stays in place.
        let step: Vec<f32> = (0..20).map(|i| if i < 10 { 0.0 } else { 1.0 }).collect();
        let r = resize(&step, 1, 20, 1, 40, 1);
        assert!(r[10] < 0.1 && r[29] > 0.9);
    }

    #[test]
    fn similarity_round_trip() {
        let m = Similarity { a: 2.0 * 0.3f32.cos(), b: 2.0 * 0.3f32.sin(), tx: 10.0, ty: -4.0 };
        let src = [[1.0, 2.0], [30.0, 5.0], [12.0, 40.0], [7.0, 7.0], [50.0, 60.0]];
        let dst: Vec<[f32; 2]> = src.iter().map(|p| { let (x, y) = m.apply(p[0], p[1]); [x, y] }).collect();
        let f = fit_similarity(&src, &dst).unwrap();
        assert!((f.a - m.a).abs() < 1e-4 && (f.b - m.b).abs() < 1e-4 && (f.tx - m.tx).abs() < 1e-3 && (f.ty - m.ty).abs() < 1e-3);
        let i = f.inverse();
        let (x, y) = i.apply(dst[2][0], dst[2][1]);
        assert!((x - 12.0).abs() < 1e-3 && (y - 40.0).abs() < 1e-3);
        assert!((f.scale() - 2.0).abs() < 1e-4);
    }

    #[test]
    fn faces_line_up_with_the_template() {
        // A face at half the template's size, shifted: lands exactly on the template.
        let pts: [[f32; 2]; 5] = std::array::from_fn(|i| [FACE_TEMPLATE[i][0] * 0.5 + 100.5, FACE_TEMPLATE[i][1] * 0.5 + 20.5]);
        let m = face_transform(&pts).unwrap();
        assert!((m.scale() - 2.0).abs() < 1e-3 && m.b.abs() < 1e-4);
        let (u, v) = m.apply(pts[2][0], pts[2][1]);
        assert!((u - FACE_TEMPLATE[2][0] - 0.5).abs() < 0.05 && (v - FACE_TEMPLATE[2][1] - 0.5).abs() < 0.05);
        assert!(eye_distance(&pts) > 60.0);
    }

    #[test]
    fn face_mask_is_soft_and_full_inside() {
        assert_eq!(face_mask(256.0, 256.0), 1.0);
        assert_eq!(face_mask(2.0, 256.0), 0.0);
        let mid = face_mask(50.0, 256.0);
        assert!(mid > 0.1 && mid < 0.9);
    }

    #[test]
    fn warp_then_paste_gives_the_picture_back() {
        // A smooth picture; cut a face out, "restore" it unchanged, paste it
        // back into a ×4 copy: the copy must not change (no shifts, no seams).
        let (w, h) = (160, 160);
        let img: Vec<f32> = (0..w * h).flat_map(|i| {
            let (x, y) = ((i % w) as f32, (i / w) as f32);
            [x / w as f32, y / h as f32, 0.5]
        }).collect();
        let pts: [[f32; 2]; 5] = std::array::from_fn(|i| [FACE_TEMPLATE[i][0] * 0.2 + 30.0, FACE_TEMPLATE[i][1] * 0.2 + 25.0]);
        let m = face_transform(&pts).unwrap();
        let face = warp_face(&img, w, h, &m);
        let mut big = resize(&img, 3, w, h, w * 4, h * 4);
        let before = big.clone();
        paste_face(&mut big, w * 4, h * 4, 4.0, &m, &face);
        let worst = big.iter().zip(&before).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        assert!(worst < 0.02, "worst difference {worst}");
        // And a face that is different really goes in.
        let grey = vec![0.0f32; 3 * FACE * FACE];
        paste_face(&mut big, w * 4, h * 4, 4.0, &m, &grey);
        let (cx, cy) = m.inverse().apply(256.0, 256.0);
        let o = ((cy * 4.0) as usize * w * 4 + (cx * 4.0) as usize) * 3;
        assert!((big[o + 2] - 0.5).abs() < 1e-3 && (big[o] - 0.5).abs() < 1e-3);
    }
}
