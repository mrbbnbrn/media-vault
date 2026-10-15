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
/// JPEG quality thumbnails used to be made with (before WebP; still the
/// quality the WebP one is matched to, see `THUMB_WEBP_QUALITY`).
pub const THUMB_QUALITY: u8 = 86;
/// WebP quality of thumbnails: the lowest that looks as good as JPEG
/// quality 86 did (as close in SSIM and PSNR on real photos), measured by
/// `webp_quality_corpus` below and tools/thumbquality.py. The window uses
/// the same (canvaspic.ts).
pub const THUMB_WEBP_QUALITY: f32 = 83.0;
/// Small thumbnails (dense grids, the minimap): the longest side.
pub const SMALL_MAX: usize = 256;
/// WebP quality of small thumbnails (a little higher: each pixel counts more).
pub const SMALL_WEBP_QUALITY: f32 = 84.0;
/// libwebp's effort (0 fast … 6 slow); 4 is its default, a good balance.
const WEBP_METHOD: i32 = 4;
/// The face finder gets the picture at most this big (as facescan.ts sent it).
pub const FACES_MAX: usize = 1600;
/// Smart search (CLIP) looks at SIZE × SIZE.
pub const CLIP_SIZE: usize = 224;
// Written exactly as in clipcore.ts (CLIP's own numbers).
#[allow(clippy::excessive_precision)]
const CLIP_MEAN: [f32; 3] = [0.48145466, 0.4578275, 0.40821073];
#[allow(clippy::excessive_precision)]
const CLIP_STD: [f32; 3] = [0.26862954, 0.26130258, 0.27577711];

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

/// The thumbnail: at most 640 px on the longest side, as lossy WebP
/// (about a third smaller than the JPEG quality 86 it replaces, looking the same).
pub fn thumbnail(src: &Rgb) -> Result<(Rgb, Zeroizing<Vec<u8>>), String> {
    let t = fit(src, THUMB_MAX).unwrap_or_else(|| copy(src));
    // (Should libwebp ever refuse, a JPEG as before rather than none.)
    let bytes = encode_webp(&t, THUMB_WEBP_QUALITY).or_else(|_| encode_jpeg(&t, THUMB_QUALITY))?;
    Ok((t, bytes))
}

/// The small thumbnail made from a stored (big) one, JPEG or WebP: at most
/// 256 px, WebP. `None` when the stored one is already that small (it is
/// used as it is).
pub fn small_from_thumb(thumb: &[u8]) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let big = decode_thumb(thumb)?;
    match fit(&big, SMALL_MAX) {
        Some(small) => encode_webp(&small, SMALL_WEBP_QUALITY).map(Some),
        None => Ok(None),
    }
}

/// A stored thumbnail, decoded: WebP ones with libwebp (several times
/// quicker than the pure-Rust decoder; thumbnails have no orientation or
/// transparency to apply), anything else as any picture.
pub fn decode_thumb(bytes: &[u8]) -> Result<Rgb, String> {
    if image_mime(bytes) == Some("image/webp") {
        let (mut w, mut h): (std::ffi::c_int, std::ffi::c_int) = (0, 0);
        // SAFETY: libwebp reads `bytes` (its length given) and returns a
        // buffer of w × h × 3 bytes it allocated (or null); it is copied,
        // wiped and freed here.
        unsafe {
            let p = libwebp_sys::WebPDecodeRGB(bytes.as_ptr(), bytes.len(), &mut w, &mut h);
            if !p.is_null() {
                let n = w.max(0) as usize * h.max(0) as usize * 3;
                let buf = std::slice::from_raw_parts_mut(p, n);
                let px = Zeroizing::new(buf.to_vec());
                buf.iter_mut().for_each(|b| *b = 0);
                libwebp_sys::WebPFree(p.cast());
                if n > 0 {
                    return Ok(Rgb { w: w as usize, h: h as usize, px });
                }
            }
        }
    }
    decode(bytes)
}

/// Lossy WebP (libwebp), in memory. The encoded bytes are wiped when
/// dropped; libwebp's own working copy is freed when it is done.
pub fn encode_webp(p: &Rgb, quality: f32) -> Result<Zeroizing<Vec<u8>>, String> {
    use libwebp_sys as w;
    use std::ffi::c_int;
    let fail = |what: &str| format!("The thumbnail couldn't be made ({what}).");
    if p.w == 0 || p.h == 0 || p.w > 16_383 || p.h > 16_383 || p.px.len() < p.w * p.h * 3 {
        return Err(fail("size"));
    }
    // SAFETY: plain libwebp calls on structs it initialises itself; the
    // picture reads `p.px` (checked to be w × h × 3 bytes above) and writes
    // into `writer`, which outlives the encode; both are freed below.
    unsafe {
        let mut config = std::mem::MaybeUninit::<w::WebPConfig>::zeroed();
        if w::WebPConfigInitInternal(config.as_mut_ptr(), w::WebPPreset::WEBP_PRESET_DEFAULT, quality, w::WEBP_ENCODER_ABI_VERSION as c_int) == 0 {
            return Err(fail("libwebp version"));
        }
        let mut config = config.assume_init();
        config.quality = quality.clamp(0.0, 100.0);
        config.method = WEBP_METHOD;
        if w::WebPValidateConfig(&config) == 0 {
            return Err(fail("settings"));
        }
        let mut pic = std::mem::MaybeUninit::<w::WebPPicture>::zeroed();
        if w::WebPPictureInitInternal(pic.as_mut_ptr(), w::WEBP_ENCODER_ABI_VERSION as c_int) == 0 {
            return Err(fail("libwebp version"));
        }
        let mut pic = pic.assume_init();
        pic.use_argb = 0;
        pic.width = p.w as c_int;
        pic.height = p.h as c_int;
        let mut writer = std::mem::MaybeUninit::<w::WebPMemoryWriter>::zeroed();
        w::WebPMemoryWriterInit(writer.as_mut_ptr());
        let mut writer = writer.assume_init();
        pic.writer = Some(w::WebPMemoryWrite);
        pic.custom_ptr = (&mut writer as *mut w::WebPMemoryWriter).cast();
        let ok = w::WebPPictureImportRGB(&mut pic, p.px.as_ptr(), (p.w * 3) as c_int) != 0 && w::WebPEncode(&config, &mut pic) != 0;
        w::WebPPictureFree(&mut pic);
        let out = if ok && !writer.mem.is_null() {
            let bytes = std::slice::from_raw_parts_mut(writer.mem, writer.size);
            let out = Zeroizing::new(bytes.to_vec());
            bytes.iter_mut().for_each(|b| *b = 0);
            Some(out)
        } else {
            None
        };
        w::WebPMemoryWriterClear(&mut writer);
        out.ok_or_else(|| fail("encoder"))
    }
}

/// What kind of picture these bytes are, from their first bytes:
/// JPEG, WebP or PNG (thumbnails, small thumbnails and frame strips are one of these).
pub fn image_mime(head: &[u8]) -> Option<&'static str> {
    if head.len() >= 3 && head[..3] == [0xFF, 0xD8, 0xFF] {
        Some("image/jpeg")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else if head.len() >= 8 && head[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        Some("image/png")
    } else {
        None
    }
}

/// Frame strips are stored as WebP: a JPEG strip is re-encoded (about a third
/// smaller at the same look) when that comes out smaller. Anything else, or a
/// strip that can't be read here, is stored as it came.
pub fn strip_as_webp(data: &[u8]) -> Option<zeroize::Zeroizing<Vec<u8>>> {
    if !data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return None;
    }
    let pic = decode(data).ok()?;
    let webp = encode_webp(&pic, 80.0).ok()?;
    (webp.len() < data.len()).then_some(webp)
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
    fn strips_become_smaller_webp() {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(640, 360, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])));
        let jpeg = encode(img.clone(), ImageFormat::Jpeg);
        let w = strip_as_webp(&jpeg).expect("smaller as WebP");
        assert!(w.len() < jpeg.len());
        assert_eq!(image_mime(&w), Some("image/webp"));
        let back = decode(&w).unwrap();
        assert_eq!((back.w, back.h), (640, 360));
        // Not a JPEG: stored as it came.
        assert!(strip_as_webp(&encode(img, ImageFormat::Png)).is_none());
        assert!(strip_as_webp(b"nonsense").is_none());
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
    fn thumbnails_are_webps_that_read_back() {
        let p = solid(1600, 900, |x, y| [(x % 256) as u8, (y % 256) as u8, 128]);
        let (t, webp) = thumbnail(&p).unwrap();
        assert_eq!((t.w, t.h), (640, 360));
        assert_eq!(image_mime(&webp), Some("image/webp"));
        let back = decode(&webp).unwrap();
        assert_eq!((back.w, back.h), (640, 360));
        let (hash, sharp) = fingerprint(&back);
        assert_eq!(hash.len(), 16);
        assert!(sharp.is_finite() && sharp >= 0.0);
        let (rgba, w, h) = faces_input(&p);
        assert_eq!((w, h, rgba.len()), (1600, 900, 1600 * 900 * 4));
    }

    fn psnr(a: &Rgb, b: &Rgb) -> f64 {
        assert_eq!((a.w, a.h), (b.w, b.h));
        let se: f64 = a.px.iter().zip(b.px.iter()).map(|(x, y)| (*x as f64 - *y as f64).powi(2)).sum();
        10.0 * (255.0f64.powi(2) / (se / a.px.len() as f64).max(1e-9)).log10()
    }

    #[test]
    fn webp_keeps_the_picture_and_small_thumbnails_are_small() {
        // A smooth picture with some detail: WebP at the thumbnail quality is close to it.
        let p = solid(640, 427, |x, y| {
            let v = ((x as f64 / 9.0).sin() * 40.0 + (y as f64 / 13.0).cos() * 40.0 + 128.0) as u8;
            [v, (x * 255 / 640) as u8, (y * 255 / 427) as u8]
        });
        let webp = encode_webp(&p, THUMB_WEBP_QUALITY).unwrap();
        let back = decode(&webp).unwrap();
        assert!(psnr(&p, &back) > 33.0, "{}", psnr(&p, &back));
        // The quick (libwebp) way to read our own thumbnails gives the same picture.
        let quick = decode_thumb(&webp).unwrap();
        assert!(psnr(&back, &quick) > 40.0, "{}", psnr(&back, &quick));
        assert!(decode_thumb(b"RIFF\0\0\0\0WEBPnot really").is_err());
        let jpeg = encode_jpeg(&p, THUMB_QUALITY).unwrap();
        assert_eq!(image_mime(&jpeg), Some("image/jpeg"));
        // Small thumbnails from WebP and from older JPEG thumbnails.
        for big in [&webp, &jpeg] {
            let small = small_from_thumb(big).unwrap().unwrap();
            assert_eq!(image_mime(&small), Some("image/webp"));
            let s = decode(&small).unwrap();
            assert_eq!((s.w, s.h), (256, 171));
            assert!(small.len() < big.len() / 2, "{} vs {}", small.len(), big.len());
        }
        // Already small enough: used as it is.
        let tiny = encode_webp(&solid(200, 100, |_, _| [9, 9, 9]), 80.0).unwrap();
        assert!(small_from_thumb(&tiny).unwrap().is_none());
        // Bad sizes are refused, not crashed on.
        assert!(encode_webp(&Rgb { w: 0, h: 5, px: Zeroizing::new(Vec::new()) }, 80.0).is_err());
        assert!(encode_webp(&Rgb { w: 4, h: 4, px: Zeroizing::new(vec![0; 10]) }, 80.0).is_err());
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(image_mime(b"GIF89a"), None);
    }

    /// How WebP qualities compare with the JPEG quality 86 thumbnails, on real
    /// photos: writes, for every picture in MV_CORPUS, the 640 px reference
    /// (PNG), the JPEG q86 and WebP at several qualities into MV_OUT, for
    /// tools/thumbquality.py to score (SSIM, PSNR, size). Run with
    /// `MV_CORPUS=… MV_OUT=… cargo test -p media-vault-app webp_quality_corpus -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn webp_quality_corpus() {
        let (Some(dir), Some(out)) = (std::env::var_os("MV_CORPUS"), std::env::var_os("MV_OUT")) else {
            return;
        };
        let out = std::path::PathBuf::from(out);
        std::fs::create_dir_all(&out).unwrap();
        let size: usize = std::env::var("MV_SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(THUMB_MAX);
        let mut names: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
        names.sort();
        let (mut tj, mut tw) = (0.0, 0.0);
        for p in names {
            let Ok(bytes) = std::fs::read(&p) else { continue };
            let Ok(pic) = decode(&bytes) else { continue };
            let t = fit(&pic, size).unwrap_or_else(|| copy(&pic));
            let stem = p.file_stem().unwrap().to_string_lossy().to_string();
            let img = image::RgbImage::from_raw(t.w as u32, t.h as u32, t.px.to_vec()).unwrap();
            img.save(out.join(format!("{stem}.ref.png"))).unwrap();
            let t0 = std::time::Instant::now();
            let j = encode_jpeg(&t, THUMB_QUALITY).unwrap();
            tj += t0.elapsed().as_secs_f64();
            std::fs::write(out.join(format!("{stem}.jpg86.jpg")), &*j).unwrap();
            for q in [75.0f32, 80.0, 82.0, 83.0, 84.0, 86.0, 88.0] {
                let t0 = std::time::Instant::now();
                let w = encode_webp(&t, q).unwrap();
                if q == THUMB_WEBP_QUALITY {
                    tw += t0.elapsed().as_secs_f64();
                }
                std::fs::write(out.join(format!("{stem}.webp{q}.webp")), &*w).unwrap();
            }
        }
        println!("encode time: jpeg q86 {:.1} ms total, webp q{THUMB_WEBP_QUALITY} {:.1} ms total", tj * 1e3, tw * 1e3);
    }
}
