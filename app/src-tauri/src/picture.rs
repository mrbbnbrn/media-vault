//! Pictures decoded natively, in memory, for the analysis pass (analyse.rs):
//! JPEG, PNG, WebP and GIF (first frame), turned the right way up from their
//! EXIF orientation like the window does, transparent parts on black like
//! the window's thumbnails. Then everything the pass makes from one decode:
//! the thumbnail, the look-alike fingerprint, the smart-search input and the
//! picture the face finder looks at. Nothing is ever written anywhere.
//!
//! Other formats (HEIC, AVIF, BMP…) and anything that fails here go the
//! window's way, as before.

use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use zeroize::Zeroizing;

/// File endings decoded here (the rest are left to the window).
pub const NATIVE_EXTS: [&str; 7] = ["jpg", "jpeg", "jpe", "jfif", "png", "webp", "gif"];
/// Biggest side decoded here (bigger pictures go the window's way).
const MAX_SIDE: u32 = 24_000;
/// Most memory one decode may take.
const MAX_ALLOC: u64 = 1 << 30;

/// Thumbnails: the longest side (as the window makes them, media.ts).
pub const THUMB_MAX: usize = 640;
/// JPEG quality of thumbnails (as the window makes them).
pub const THUMB_QUALITY: u8 = 86;
/// The face finder gets the picture at most this big (as facescan.ts sent it).
pub const FACES_MAX: usize = 1600;
/// Smart search (CLIP) looks at SIZE × SIZE.
pub const CLIP_SIZE: usize = 224;
const CLIP_MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const CLIP_STD: [f32; 3] = [0.268_629_54, 0.261_302_58, 0.275_777_1];

/// An RGB picture (8 bits per channel, row by row), wiped from memory when dropped.
pub struct Rgb {
    pub w: usize,
    pub h: usize,
    pub px: Zeroizing<Vec<u8>>,
}

impl std::fmt::Debug for Rgb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Rgb({}×{})", self.w, self.h)
    }
}

/// Can this file be decoded here (by its ending)?
pub fn native_ext(ext: &str) -> bool {
    NATIVE_EXTS.contains(&ext.to_ascii_lowercase().as_str())
}

/// Decode a JPEG, PNG, WebP or GIF (its first frame), the right way up.
pub fn decode(bytes: &[u8]) -> Result<Rgb, String> {
    let bad = |e: &dyn std::fmt::Display| format!("This picture couldn't be read here ({e}).");
    let mut r = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| bad(&e))?;
    match r.format() {
        Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif) => {}
        _ => return Err("This kind of picture is read by the window.".into()),
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    r.limits(limits);
    let mut dec = r.into_decoder().map_err(|e| bad(&e))?;
    let orientation = dec.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(dec).map_err(|e| bad(&e))?;
    img.apply_orientation(orientation);
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w == 0 || h == 0 {
        return Err("This picture is empty.".into());
    }
    let px = if img.color().has_alpha() {
        // On black, like the window's thumbnails.
        let rgba = Zeroizing::new(img.into_rgba8().into_raw());
        let mut out = Zeroizing::new(Vec::with_capacity(w * h * 3));
        for p in rgba.chunks_exact(4) {
            let a = p[3] as u32;
            out.extend((0..3).map(|c| ((p[c] as u32 * a + 127) / 255) as u8));
        }
        out
    } else {
        Zeroizing::new(img.into_rgb8().into_raw())
    };
    Ok(Rgb { w, h, px })
}

// ---- resampling ------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Filter {
    /// Lanczos (3 lobes), widened when shrinking: the sharpest without aliasing.
    Lanczos3,
    /// A tent widened when shrinking (an area average, smooth).
    Triangle,
    /// Plain bilinear sampling (what the window's canvas does for mild shrinking).
    Bilinear,
}

impl Filter {
    fn radius(self) -> f64 {
        match self {
            Filter::Lanczos3 => 3.0,
            Filter::Triangle | Filter::Bilinear => 1.0,
        }
    }
    fn widens(self) -> bool {
        self != Filter::Bilinear
    }
    fn at(self, x: f64) -> f64 {
        let x = x.abs();
        match self {
            Filter::Lanczos3 => {
                if x < 1e-9 {
                    1.0
                } else if x >= 3.0 {
                    0.0
                } else {
                    let p = std::f64::consts::PI * x;
                    3.0 * p.sin() * (p / 3.0).sin() / (p * p)
                }
            }
            Filter::Triangle | Filter::Bilinear => (1.0 - x).max(0.0),
        }
    }
}

/// For each of `n_out` output pixels: the first source pixel and the weights.
/// Output pixel `i` covers source `[start + i / scale, start + (i + 1) / scale)`
/// (pixel centres at +0.5); samples past the edges repeat the edge pixel.
fn axis(n_in: usize, n_out: usize, start: f64, scale: f64, f: Filter) -> Vec<(usize, Vec<f32>)> {
    let stretch = if f.widens() { scale.min(1.0) } else { 1.0 };
    let support = f.radius() / stretch;
    (0..n_out)
        .map(|i| {
            let centre = start + (i as f64 + 0.5) / scale;
            let lo = (centre - 0.5 - support).floor() as isize;
            let hi = (centre - 0.5 + support).ceil() as isize;
            let last = n_in as isize - 1;
            let lo_c = lo.clamp(0, last) as usize;
            let hi_c = hi.clamp(0, last) as usize;
            let mut w = vec![0.0f64; hi_c + 1 - lo_c];
            for j in lo..=hi {
                let wt = f.at((j as f64 + 0.5 - centre) * stretch);
                w[j.clamp(0, last) as usize - lo_c] += wt;
            }
            let sum: f64 = w.iter().sum();
            let w = w.iter().map(|v| if sum.abs() > 1e-12 { (v / sum) as f32 } else { 0.0 }).collect();
            (lo_c, w)
        })
        .collect()
}

/// The part of `src` at (x, y, w, h) (source pixels, fractions allowed)
/// resampled to `dw` × `dh`; RGB, 0…255, not rounded.
pub fn resample(src: &Rgb, region: (f64, f64, f64, f64), dw: usize, dh: usize, f: Filter) -> Zeroizing<Vec<f32>> {
    let (x, y, rw, rh) = region;
    let cx = axis(src.w, dw, x, dw as f64 / rw, f);
    let cy = axis(src.h, dh, y, dh as f64 / rh, f);
    // Only the rows the output needs.
    let (y0, y1) = cy.iter().fold((usize::MAX, 0), |(a, b), (lo, w)| (a.min(*lo), b.max(lo + w.len())));
    let rows = y1 - y0;
    let mut mid = Zeroizing::new(vec![0.0f32; dw * rows * 3]);
    for r in 0..rows {
        let row = &src.px[(y0 + r) * src.w * 3..(y0 + r + 1) * src.w * 3];
        let out = &mut mid[r * dw * 3..(r + 1) * dw * 3];
        for (o, (lo, w)) in out.chunks_exact_mut(3).zip(&cx) {
            let mut acc = [0.0f32; 3];
            for (k, wt) in w.iter().enumerate() {
                let p = &row[(lo + k) * 3..(lo + k) * 3 + 3];
                acc[0] += p[0] as f32 * wt;
                acc[1] += p[1] as f32 * wt;
                acc[2] += p[2] as f32 * wt;
            }
            o.copy_from_slice(&acc);
        }
    }
    let mut out = Zeroizing::new(vec![0.0f32; dw * dh * 3]);
    for (yy, (lo, w)) in cy.iter().enumerate() {
        let o = &mut out[yy * dw * 3..(yy + 1) * dw * 3];
        for (k, wt) in w.iter().enumerate() {
            let r = &mid[(lo + k - y0) * dw * 3..(lo + k - y0 + 1) * dw * 3];
            for (a, b) in o.iter_mut().zip(r) {
                *a += b * wt;
            }
        }
    }
    out
}

fn to_u8(v: &[f32]) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(v.iter().map(|x| x.round().clamp(0.0, 255.0) as u8).collect())
}

/// Average `k` × `k` blocks (a quick first step before a big shrink).
fn shrink_box(src: &Rgb, k: usize) -> Rgb {
    let (w, h) = (src.w.div_ceil(k), src.h.div_ceil(k));
    let mut acc = vec![0u32; w * 3];
    let mut cnt = vec![0u32; w];
    let mut px = Zeroizing::new(Vec::with_capacity(w * h * 3));
    for by in 0..h {
        acc.iter_mut().for_each(|a| *a = 0);
        cnt.iter_mut().for_each(|c| *c = 0);
        for y in by * k..((by + 1) * k).min(src.h) {
            let row = &src.px[y * src.w * 3..(y + 1) * src.w * 3];
            for (x, p) in row.chunks_exact(3).enumerate() {
                let bx = x / k;
                acc[bx * 3] += p[0] as u32;
                acc[bx * 3 + 1] += p[1] as u32;
                acc[bx * 3 + 2] += p[2] as u32;
                cnt[bx] += 1;
            }
        }
        for bx in 0..w {
            let n = cnt[bx].max(1);
            px.extend((0..3).map(|c| ((acc[bx * 3 + c] + n / 2) / n) as u8));
        }
    }
    acc.iter_mut().for_each(|a| *a = 0);
    Rgb { w, h, px }
}

/// `src` scaled to fit `max` × `max` (never bigger), sharp and smooth
/// (a box shrink to about twice the size, then Lanczos).
pub fn fit(src: &Rgb, max: usize) -> Option<Rgb> {
    let scale = (max as f64 / src.w.max(src.h) as f64).min(1.0);
    if scale >= 1.0 {
        return None;
    }
    let tw = ((src.w as f64 * scale).round() as usize).max(1);
    let th = ((src.h as f64 * scale).round() as usize).max(1);
    let k = (src.w / tw).min(src.h / th) / 2;
    let small;
    let (from, fw, fh) = if k >= 2 {
        small = shrink_box(src, k);
        (&small, src.w as f64 / k as f64, src.h as f64 / k as f64)
    } else {
        (src, src.w as f64, src.h as f64)
    };
    let v = resample(from, (0.0, 0.0, fw, fh), tw, th, Filter::Lanczos3);
    Some(Rgb { w: tw, h: th, px: to_u8(&v) })
}

/// A copy (when no scaling is needed).
fn copy(src: &Rgb) -> Rgb {
    Rgb { w: src.w, h: src.h, px: Zeroizing::new(src.px.to_vec()) }
}

/// The thumbnail: at most 640 px on the longest side, as JPEG (quality 86).
pub fn thumbnail(src: &Rgb) -> Result<(Rgb, Zeroizing<Vec<u8>>), String> {
    let t = fit(src, THUMB_MAX).unwrap_or_else(|| copy(src));
    let jpeg = encode_jpeg(&t, THUMB_QUALITY)?;
    Ok((t, jpeg))
}

pub fn encode_jpeg(p: &Rgb, quality: u8) -> Result<Zeroizing<Vec<u8>>, String> {
    let (w, h) = (u16::try_from(p.w).map_err(|_| "Too big.")?, u16::try_from(p.h).map_err(|_| "Too big.")?);
    let mut out = Zeroizing::new(Vec::new());
    jpeg_encoder::Encoder::new(&mut *out, quality)
        .encode(&p.px, w, h, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| format!("The thumbnail couldn't be made ({e})."))?;
    Ok(out)
}

/// The face finder's picture: at most 1600 px, RGBA.
pub fn faces_input(src: &Rgb) -> (Zeroizing<Vec<u8>>, usize, usize) {
    let fitted = fit(src, FACES_MAX);
    let p = fitted.as_ref().unwrap_or(src);
    let mut rgba = Zeroizing::new(Vec::with_capacity(p.w * p.h * 4));
    for c in p.px.chunks_exact(3) {
        rgba.extend_from_slice(&[c[0], c[1], c[2], 255]);
    }
    (rgba, p.w, p.h)
}

// ---- smart search input -----------------------------------------------------------------

/// The part (x, y, w, h) of `src`, scaled to cover 224 × 224 and centred
/// (CLIP's resize and crop, clipcore.ts `coverRect`), normalised the CLIP
/// way, planar (3 × 224 × 224). The window's canvas samples bilinearly when
/// shrinking a little and averages when shrinking more; this does the same,
/// so the results match what was stored before.
pub fn clip_input(src: &Rgb, part: Option<(f64, f64, f64, f64)>) -> Vec<f32> {
    let (px, py, pw, ph) = part.unwrap_or((0.0, 0.0, src.w as f64, src.h as f64));
    let s = CLIP_SIZE as f64 / pw.min(ph);
    let (vw, vh) = (CLIP_SIZE as f64 / s, CLIP_SIZE as f64 / s);
    let region = (px + (pw - vw) / 2.0, py + (ph - vh) / 2.0, vw, vh);
    let f = if s > 0.55 { Filter::Bilinear } else { Filter::Triangle };
    let v = resample(src, region, CLIP_SIZE, CLIP_SIZE, f);
    let plane = CLIP_SIZE * CLIP_SIZE;
    let mut out = vec![0.0f32; 3 * plane];
    for i in 0..plane {
        for c in 0..3 {
            let x = v[i * 3 + c].round().clamp(0.0, 255.0);
            out[c * plane + i] = (x / 255.0 - CLIP_MEAN[c]) / CLIP_STD[c];
        }
    }
    out
}

// ---- look-alike fingerprints (fingerprint.ts, exactly) -----------------------------------

/// Half the size, each pixel the average of 2 × 2 (one mipmap level).
fn halve(src: &Rgb) -> Rgb {
    let (w, h) = ((src.w / 2).max(1), (src.h / 2).max(1));
    let mut px = Zeroizing::new(Vec::with_capacity(w * h * 3));
    let at = |x: usize, y: usize, c: usize| src.px[(y.min(src.h - 1) * src.w + x.min(src.w - 1)) * 3 + c] as u32;
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                let s = at(2 * x, 2 * y, c) + at(2 * x + 1, 2 * y, c) + at(2 * x, 2 * y + 1, c) + at(2 * x + 1, 2 * y + 1, c);
                px.push(((s + 2) / 4) as u8);
            }
        }
    }
    Rgb { w, h, px }
}

/// Grey values (0.299 R + 0.587 G + 0.114 B) of the picture stretched to
/// size × size. Shrunk the way the window's canvas does it (halved down to
/// two to four times the size, then sampled bilinearly), so fingerprints
/// and sharpness match those it made (pHash ≈ 2 of 64 bits apart, sharpness
/// within about 10 % on real photos).
pub fn grey(src: &Rgb, size: usize) -> Vec<f64> {
    let s = (size as f64 / src.w as f64).min(size as f64 / src.h as f64);
    let halvings = if s < 1.0 { ((1.0 / s).log2().floor() as i32 - 1).max(0) } else { 0 };
    let mut level: Option<Rgb> = None;
    for _ in 0..halvings {
        let next = halve(level.as_ref().unwrap_or(src));
        level = Some(next);
    }
    let from = level.as_ref().unwrap_or(src);
    let v = resample(from, (0.0, 0.0, from.w as f64, from.h as f64), size, size, Filter::Bilinear);
    v.chunks_exact(3)
        .map(|p| {
            let c = |x: f32| x.round().clamp(0.0, 255.0) as f64;
            0.299 * c(p[0]) + 0.587 * c(p[1]) + 0.114 * c(p[2])
        })
        .collect()
}

/// pHash of a 32 × 32 grey picture (row by row): a 2D DCT, the top-left
/// 8 × 8, each above the median (leaving out the average brightness) = 1.
/// Bit `i` is coefficient `i` (row by row); 16 hex digits.
pub fn phash(gray: &[f64]) -> String {
    let cos: Vec<[f64; 32]> = (0..8)
        .map(|u| std::array::from_fn(|x| (((2 * x + 1) * u) as f64 * std::f64::consts::PI / 64.0).cos()))
        .collect();
    let mut rows = vec![[0.0f64; 8]; 32];
    for (y, row) in rows.iter_mut().enumerate() {
        for (u, r) in row.iter_mut().enumerate() {
            let mut s = 0.0;
            for x in 0..32 {
                s += gray[y * 32 + x] * cos[u][x];
            }
            *r = s;
        }
    }
    let mut vals = [0.0f64; 64];
    for v in 0..8 {
        for u in 0..8 {
            let mut s = 0.0;
            for (y, row) in rows.iter().enumerate() {
                s += row[u] * cos[v][y];
            }
            vals[v * 8 + u] = s;
        }
    }
    let mut rest: Vec<f64> = vals[1..].to_vec();
    rest.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = (rest[31] + rest[32]) / 2.0;
    let mut bits = 0u64;
    for (i, v) in vals.iter().enumerate() {
        if *v > median {
            bits |= 1 << i;
        }
    }
    format!("{bits:016x}")
}

/// Sharpness: the variance of the Laplacian (4·pixel − its 4 neighbours).
pub fn sharpness(g: &[f64], w: usize, h: usize) -> f64 {
    let (mut s, mut s2, mut n) = (0.0, 0.0, 0.0);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let l = 4.0 * g[y * w + x] - g[y * w + x - 1] - g[y * w + x + 1] - g[(y - 1) * w + x] - g[(y + 1) * w + x];
            s += l;
            s2 += l * l;
            n += 1.0;
        }
    }
    let m = s / n;
    s2 / n - m * m
}

/// Both fingerprints of a thumbnail.
pub fn fingerprint(thumb: &Rgb) -> (String, f64) {
    (phash(&grey(thumb, 32)), sharpness(&grey(thumb, 64), 64, 64))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same made-up grey picture as fingerprint.test.ts.
    pub fn pattern32() -> Vec<f64> {
        (0..32 * 32)
            .map(|i| {
                let (x, y) = ((i % 32) as f64, (i / 32) as f64);
                (128.0 + 90.0 * (x / 5.0).sin() * (y / 7.0).cos() + 2.0 * x - y).round()
            })
            .collect()
    }

    #[test]
    fn phash_and_sharpness_match_the_window() {
        // fingerprint.test.ts checks the same numbers for the TypeScript version.
        let g = pattern32();
        assert_eq!(phash(&g), "bd02ed03ad5253ad");
        assert!((sharpness(&g, 32, 32) - 9.843_332_098_765_433).abs() < 1e-9, "{}", sharpness(&g, 32, 32));
    }

    fn solid(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 3]) -> Rgb {
        let mut px = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                px.extend_from_slice(&f(x, y));
            }
        }
        Rgb { w, h, px: Zeroizing::new(px) }
    }

    #[test]
    fn resampling_keeps_flat_colour_and_size() {
        let p = solid(1000, 500, |_, _| [10, 200, 30]);
        let t = fit(&p, 640).unwrap();
        assert_eq!((t.w, t.h), (640, 320));
        assert!(t.px.chunks(3).all(|c| c == [10, 200, 30]));
        let small = solid(300, 200, |_, _| [1, 2, 3]);
        assert!(fit(&small, 640).is_none(), "never made bigger");
        let big = solid(5000, 3000, |x, _| if x < 2500 { [0, 0, 0] } else { [255, 255, 255] });
        let t = fit(&big, 640).unwrap();
        assert_eq!((t.w, t.h), (640, 384));
        assert_eq!(&t.px[0..3], &[0, 0, 0]);
        assert_eq!(&t.px[639 * 3..640 * 3], &[255, 255, 255]);
        let c = clip_input(&p, None);
        assert_eq!(c.len(), 3 * 224 * 224);
        let want = (10.0 / 255.0 - CLIP_MEAN[0]) / CLIP_STD[0];
        assert!(c[..224 * 224].iter().all(|v| (v - want).abs() < 1e-5));
    }

    #[test]
    fn clip_crop_is_the_centre() {
        // Left third red, middle green, right third blue (wide): the crop shows only green.
        let p = solid(672, 224, |x, _| if x < 224 { [255, 0, 0] } else if x < 448 { [0, 255, 0] } else { [0, 0, 255] });
        let c = clip_input(&p, None);
        let g = (1.0 - CLIP_MEAN[1]) / CLIP_STD[1];
        assert!(c[224 * 224..2 * 224 * 224].iter().all(|v| (v - g).abs() < 1e-5));
        // A part of a strip (a video's preview clip): only that cell.
        let strip = solid(400, 100, |x, _| if x < 200 { [0, 0, 0] } else { [255, 255, 255] });
        let c = clip_input(&strip, Some((200.0, 0.0, 200.0, 100.0)));
        let white = (1.0 - CLIP_MEAN[0]) / CLIP_STD[0];
        assert!(c[..224 * 224].iter().all(|v| (v - white).abs() < 1e-5));
    }

    fn encode(img: image::DynamicImage, f: ImageFormat) -> Vec<u8> {
        let mut b = Cursor::new(Vec::new());
        img.write_to(&mut b, f).unwrap();
        b.into_inner()
    }

    #[test]
    fn decodes_the_formats_and_puts_transparency_on_black() {
        let rgba = image::RgbaImage::from_fn(30, 20, |x, _| if x < 15 { image::Rgba([255, 255, 255, 0]) } else { image::Rgba([200, 100, 50, 255]) });
        let png = encode(image::DynamicImage::ImageRgba8(rgba.clone()), ImageFormat::Png);
        let d = decode(&png).unwrap();
        assert_eq!((d.w, d.h), (30, 20));
        assert_eq!(&d.px[0..3], &[0, 0, 0], "see-through is black");
        assert_eq!(&d.px[29 * 3..30 * 3], &[200, 100, 50]);
        for f in [ImageFormat::Jpeg, ImageFormat::Gif, ImageFormat::WebP] {
            let img = image::DynamicImage::ImageRgb8(image::DynamicImage::ImageRgba8(rgba.clone()).to_rgb8());
            let d = decode(&encode(img, f)).unwrap_or_else(|e| panic!("{f:?}: {e}"));
            assert_eq!((d.w, d.h), (30, 20), "{f:?}");
        }
        assert!(decode(b"BM not a picture we read").is_err());
        assert!(decode(&[]).is_err());
        assert!(native_ext("JPG") && native_ext("webp") && !native_ext("heic"));
    }

    #[test]
    fn exif_orientation_is_applied() {
        // A 40 × 20 JPEG marked "turn 90° clockwise" (orientation 6) comes out 20 × 40.
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(40, 20, |x, _| if x < 20 { image::Rgb([255, 0, 0]) } else { image::Rgb([0, 0, 255]) }));
        let jpeg = encode(img, ImageFormat::Jpeg);
        // APP1 Exif with one IFD entry: Orientation (0x0112) = 6, big-endian TIFF.
        let tiff: Vec<u8> = [&b"MM\0\x2a\0\0\0\x08"[..], &[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0], &[0, 0, 0, 0]].concat();
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(tiff);
        let mut with = jpeg[..2].to_vec();
        with.extend([0xff, 0xe1]);
        with.extend(((app1.len() + 2) as u16).to_be_bytes());
        with.extend(app1);
        with.extend(&jpeg[2..]);
        let d = decode(&with).unwrap();
        assert_eq!((d.w, d.h), (20, 40));
        // Turned clockwise: the red left half is now the top.
        assert!(d.px[0] > 200 && d.px[2] < 60, "{:?}", &d.px[0..3]);
        let last = (d.w * d.h - 1) * 3;
        assert!(d.px[last + 2] > 200 && d.px[last] < 60);
    }

    #[test]
    fn thumbnails_are_jpegs_that_read_back() {
        let p = solid(1600, 900, |x, y| [(x % 256) as u8, (y % 256) as u8, 128]);
        let (t, jpeg) = thumbnail(&p).unwrap();
        assert_eq!((t.w, t.h), (640, 360));
        let back = decode(&jpeg).unwrap();
        assert_eq!((back.w, back.h), (640, 360));
        let (hash, sharp) = fingerprint(&back);
        assert_eq!(hash.len(), 16);
        assert!(sharp.is_finite() && sharp >= 0.0);
        let (rgba, w, h) = faces_input(&p);
        assert_eq!((w, h, rgba.len()), (1600, 900, 1600 * 900 * 4));
    }
}
