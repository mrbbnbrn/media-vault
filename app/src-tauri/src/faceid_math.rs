//! The picture maths behind native face recognition (InsightFace buffalo_l:
//! the SCRFD-10G face finder and the ArcFace R50 fingerprint model), kept
//! apart from the models so it can be tested without them: fitting the
//! picture into the finder's input, decoding its answer (anchors, boxes, the
//! five face points), removing double finds (NMS), and lining each face up
//! with ArcFace's 112 × 112 layout.
//!
//! Coordinates follow InsightFace (and OpenCV): pixel `i` has its centre at
//! `i`, so results match the published models exactly.

use crate::upscale_img::{fit_similarity, Similarity};

/// The finder looks at the picture fitted into this square (InsightFace's default).
pub const DET_SIZE: usize = 640;
/// Feature map strides of SCRFD-10G and anchors per position.
pub const STRIDES: [usize; 3] = [8, 16, 32];
pub const ANCHORS: usize = 2;
/// Finds below this score are dropped (InsightFace's default).
pub const DET_THRESH: f32 = 0.5;
/// Two finds overlapping more than this are the same face.
pub const NMS_IOU: f32 = 0.4;
/// The fingerprint model's face size.
pub const REC: usize = 112;
/// Length of one fingerprint.
pub const DIM: usize = 512;

/// Where the eyes, nose tip and mouth corners sit in a 112 × 112 ArcFace
/// face (InsightFace `arcface_dst`). Order: eye on the left of the picture,
/// other eye, nose, mouth left, mouth right.
pub const ARCFACE: [[f32; 2]; 5] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

// ---- the finder's input ---------------------------------------------------------------

/// How a `w` × `h` picture is fed to the finder: scaled to fit `size` ×
/// `size` (bigger or smaller), placed top left, the rest padded with black.
/// The padding is only up to the next multiple of 32 (the model takes any
/// such size), which saves work on wide or tall pictures.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetPlan {
    /// Picture pixels → input pixels.
    pub scale: f32,
    /// The scaled picture.
    pub w: usize,
    pub h: usize,
    /// The input (multiples of 32).
    pub in_w: usize,
    pub in_h: usize,
}

pub fn det_plan(w: usize, h: usize, size: usize) -> Option<DetPlan> {
    if w == 0 || h == 0 {
        return None;
    }
    let ratio = h as f32 / w as f32;
    let (nw, nh) = if ratio > 1.0 {
        (((size as f32 / ratio) as usize).max(1), size)
    } else {
        (size, ((size as f32 * ratio) as usize).max(1))
    };
    let up = |v: usize| v.div_ceil(32) * 32;
    Some(DetPlan { scale: nh as f32 / h as f32, w: nw, h: nh, in_w: up(nw), in_h: up(nh) })
}

/// The finder's input: planar RGB, (v − 127.5) / 128, black padding.
/// `rgb` is the scaled picture (interleaved RGB, 0…255, `plan.w` × `plan.h`).
pub fn det_input(rgb: &[f32], plan: &DetPlan) -> Vec<f32> {
    let (iw, ih) = (plan.in_w, plan.in_h);
    let pad = -127.5 / 128.0;
    let mut out = vec![pad; 3 * iw * ih];
    for y in 0..plan.h {
        for x in 0..plan.w {
            let p = (y * plan.w + x) * 3;
            for c in 0..3 {
                out[c * iw * ih + y * iw + x] = (rgb[p + c] - 127.5) / 128.0;
            }
        }
    }
    out
}

// ---- decoding ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Detection {
    /// x1, y1, x2, y2.
    pub bbox: [f32; 4],
    pub score: f32,
    pub kps: [[f32; 2]; 5],
}

impl Detection {
    /// Into picture pixels (divide by the plan's scale).
    pub fn unscaled(&self, scale: f32) -> Detection {
        Detection {
            bbox: self.bbox.map(|v| v / scale),
            score: self.score,
            kps: self.kps.map(|p| [p[0] / scale, p[1] / scale]),
        }
    }
}

/// Number of anchors for one stride.
pub fn anchor_count(in_w: usize, in_h: usize, stride: usize) -> usize {
    (in_w / stride) * (in_h / stride) * ANCHORS
}

/// Anchor centres for one stride: row by row, each position twice.
pub fn anchor_centres(in_w: usize, in_h: usize, stride: usize) -> Vec<[f32; 2]> {
    let (fw, fh) = (in_w / stride, in_h / stride);
    let mut v = Vec::with_capacity(fw * fh * ANCHORS);
    for y in 0..fh {
        for x in 0..fw {
            for _ in 0..ANCHORS {
                v.push([(x * stride) as f32, (y * stride) as f32]);
            }
        }
    }
    v
}

/// The finds of one stride: `scores` (n), `boxes` (n × 4 distances to the
/// left, top, right, bottom edge) and `kps` (n × 10 offsets), all in
/// strides. Returns those scoring at least `thresh`, in input pixels.
pub fn decode(scores: &[f32], boxes: &[f32], kps: &[f32], in_w: usize, in_h: usize, stride: usize, thresh: f32) -> Result<Vec<Detection>, String> {
    let n = anchor_count(in_w, in_h, stride);
    if scores.len() != n || boxes.len() != n * 4 || kps.len() != n * 10 {
        return Err(format!("The face finder gave back something unexpected ({} scores for {n} anchors).", scores.len()));
    }
    let centres = anchor_centres(in_w, in_h, stride);
    let s = stride as f32;
    let mut out = Vec::new();
    for (i, &score) in scores.iter().enumerate() {
        if score < thresh || !score.is_finite() {
            continue;
        }
        let [cx, cy] = centres[i];
        let b = &boxes[i * 4..i * 4 + 4];
        let k = &kps[i * 10..i * 10 + 10];
        out.push(Detection {
            bbox: [cx - b[0] * s, cy - b[1] * s, cx + b[2] * s, cy + b[3] * s],
            score,
            kps: std::array::from_fn(|j| [cx + k[j * 2] * s, cy + k[j * 2 + 1] * s]),
        });
    }
    Ok(out)
}

/// Overlap of two boxes (InsightFace counts edges as pixels: +1).
pub fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let area = |r: &[f32; 4]| (r[2] - r[0] + 1.0).max(0.0) * (r[3] - r[1] + 1.0).max(0.0);
    let w = (a[2].min(b[2]) - a[0].max(b[0]) + 1.0).max(0.0);
    let h = (a[3].min(b[3]) - a[1].max(b[1]) + 1.0).max(0.0);
    let inter = w * h;
    let union = area(a) + area(b) - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

/// Keep the best find of each face: highest score first, dropping those
/// that overlap a kept one by more than `thresh`.
pub fn nms(mut dets: Vec<Detection>, thresh: f32) -> Vec<Detection> {
    dets.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut keep: Vec<Detection> = Vec::new();
    for d in dets {
        if keep.iter().all(|k| iou(&k.bbox, &d.bbox) <= thresh) {
            keep.push(d);
        }
    }
    keep
}

// ---- lining faces up --------------------------------------------------------------------

/// The transform from picture pixels into the 112 × 112 ArcFace face.
pub fn arcface_transform(kps: &[[f32; 2]; 5]) -> Option<Similarity> {
    fit_similarity(kps, &ARCFACE)
}

/// Cut a face out of an RGBA picture, lined up, as ArcFace wants it:
/// planar RGB 3 × 112 × 112, (v − 127.5) / 127.5, black outside the picture
/// (OpenCV's warpAffine with bilinear sampling).
pub fn warp_arcface(rgba: &[u8], w: usize, h: usize, m: &Similarity, out: &mut [f32]) {
    let inv = m.inverse();
    let px = |x: isize, y: isize, c: usize| -> f32 {
        if x < 0 || y < 0 || x >= w as isize || y >= h as isize {
            0.0
        } else {
            rgba[(y as usize * w + x as usize) * 4 + c] as f32
        }
    };
    for v in 0..REC {
        for u in 0..REC {
            let (sx, sy) = inv.apply(u as f32, v as f32);
            let (x0, y0) = (sx.floor(), sy.floor());
            let (dx, dy) = (sx - x0, sy - y0);
            let (x0, y0) = (x0 as isize, y0 as isize);
            for c in 0..3 {
                let top = px(x0, y0, c) * (1.0 - dx) + px(x0 + 1, y0, c) * dx;
                let bot = px(x0, y0 + 1, c) * (1.0 - dx) + px(x0 + 1, y0 + 1, c) * dx;
                out[c * REC * REC + v * REC + u] = (top * (1.0 - dy) + bot * dy - 127.5) / 127.5;
            }
        }
    }
}

/// Unit length (a zero vector stays zero).
pub fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 1e-12 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

/// Dot product, written so the compiler can use wide instructions.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let mut acc = [0.0f32; 8];
    let ca = a.chunks_exact(8);
    let cb = b.chunks_exact(8);
    let (ra, rb) = (ca.remainder(), cb.remainder());
    for (x, y) in ca.zip(cb) {
        for k in 0..8 {
            acc[k] += x[k] * y[k];
        }
    }
    let mut s: f32 = acc.iter().sum();
    for (x, y) in ra.iter().zip(rb) {
        s += x * y;
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_fit_and_pad_to_32() {
        let p = det_plan(1920, 1080, 640).unwrap();
        assert_eq!((p.w, p.h, p.in_w, p.in_h), (640, 360, 640, 384));
        assert!((p.scale - 360.0 / 1080.0).abs() < 1e-6);
        let p = det_plan(600, 1200, 640).unwrap();
        assert_eq!((p.w, p.h, p.in_w, p.in_h), (320, 640, 320, 640));
        // Small pictures are made bigger, like InsightFace does.
        let p = det_plan(100, 100, 640).unwrap();
        assert_eq!((p.w, p.h, p.scale), (640, 640, 6.4));
        assert!(det_plan(0, 5, 640).is_none());
        // Extremely thin: never zero.
        let p = det_plan(10_000, 3, 640).unwrap();
        assert_eq!((p.h, p.in_h), (1, 32));
    }

    #[test]
    fn input_is_planar_normalised_and_padded() {
        let plan = det_plan(2, 1, 64).unwrap(); // 64 × 32
        assert_eq!((plan.w, plan.h, plan.in_w, plan.in_h), (64, 32, 64, 32));
        let plan = DetPlan { scale: 1.0, w: 2, h: 1, in_w: 32, in_h: 32 };
        let rgb = [255.0, 0.0, 127.5, 0.0, 0.0, 0.0];
        let t = det_input(&rgb, &plan);
        assert_eq!(t.len(), 3 * 32 * 32);
        assert!((t[0] - 127.5 / 128.0).abs() < 1e-6); // R of pixel 0
        assert!((t[32 * 32] + 127.5 / 128.0).abs() < 1e-6); // G of pixel 0
        assert!(t[2 * 32 * 32].abs() < 1e-6); // B of pixel 0
        assert!((t[5] + 127.5 / 128.0).abs() < 1e-6); // padding
    }

    #[test]
    fn anchors_follow_insightface() {
        let c = anchor_centres(64, 32, 16);
        assert_eq!(c.len(), anchor_count(64, 32, 16));
        assert_eq!(c.len(), 4 * 2 * 2);
        assert_eq!(&c[..4], &[[0.0, 0.0], [0.0, 0.0], [16.0, 0.0], [16.0, 0.0]]);
        assert_eq!(c[8], [0.0, 16.0]);
        let total: usize = STRIDES.iter().map(|&s| anchor_count(640, 640, s)).sum();
        assert_eq!(total, 12800 + 3200 + 800);
    }

    #[test]
    fn decoding_turns_distances_into_boxes_and_points() {
        let (w, h, s) = (64, 64, 32);
        let n = anchor_count(w, h, s); // 2 × 2 positions × 2 anchors
        let mut scores = vec![0.1; n];
        let mut boxes = vec![0.0; n * 4];
        let mut kps = vec![0.0; n * 10];
        // Anchor 3 = second anchor at (32, 0).
        scores[3] = 0.9;
        boxes[12..16].copy_from_slice(&[0.5, 0.0, 1.0, 1.5]);
        kps[30..40].copy_from_slice(&[0.25, 0.5, 0.75, 0.5, 0.5, 1.0, 0.25, 1.25, 0.75, 1.25]);
        let d = decode(&scores, &boxes, &kps, w, h, s, 0.5).unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].bbox, [16.0, 0.0, 64.0, 48.0]);
        assert_eq!(d[0].kps[0], [40.0, 16.0]);
        assert_eq!(d[0].kps[4], [56.0, 40.0]);
        assert!(decode(&scores[1..], &boxes, &kps, w, h, s, 0.5).is_err());
        let u = d[0].unscaled(0.5);
        assert_eq!(u.bbox, [32.0, 0.0, 128.0, 96.0]);
        assert_eq!(u.kps[0], [80.0, 32.0]);
    }

    fn det(b: [f32; 4], score: f32) -> Detection {
        Detection { bbox: b, score, kps: [[0.0; 2]; 5] }
    }

    #[test]
    fn nms_keeps_the_best_of_each_face() {
        assert!((iou(&[0.0, 0.0, 9.0, 9.0], &[0.0, 0.0, 9.0, 9.0]) - 1.0).abs() < 1e-6);
        assert_eq!(iou(&[0.0, 0.0, 9.0, 9.0], &[20.0, 20.0, 29.0, 29.0]), 0.0);
        // Half overlapping: 50 / 150.
        assert!((iou(&[0.0, 0.0, 9.0, 9.0], &[5.0, 0.0, 14.0, 9.0]) - 1.0 / 3.0).abs() < 1e-6);
        let kept = nms(
            vec![det([0.0, 0.0, 10.0, 10.0], 0.7), det([1.0, 1.0, 11.0, 11.0], 0.9), det([50.0, 50.0, 60.0, 60.0], 0.6), det([6.0, 0.0, 16.0, 10.0], 0.8)],
            0.4,
        );
        let scores: Vec<f32> = kept.iter().map(|d| d.score).collect();
        assert_eq!(scores, vec![0.9, 0.8, 0.6], "the 0.7 one is the same face as 0.9; 0.8 only overlaps a little");
    }

    #[test]
    fn faces_line_up_with_the_arcface_layout() {
        // A face twice the template's size, turned 30°, moved: lands on the template.
        let (c, s) = (2.0 * 30f32.to_radians().cos(), 2.0 * 30f32.to_radians().sin());
        let pts: [[f32; 2]; 5] = ARCFACE.map(|p| [c * p[0] - s * p[1] + 300.0, s * p[0] + c * p[1] + 80.0]);
        let m = arcface_transform(&pts).unwrap();
        assert!((m.scale() - 0.5).abs() < 1e-4);
        for (p, q) in pts.iter().zip(ARCFACE) {
            let (u, v) = m.apply(p[0], p[1]);
            assert!((u - q[0]).abs() < 1e-3 && (v - q[1]).abs() < 1e-3);
        }
    }

    #[test]
    fn warping_samples_like_opencv() {
        // A picture whose red is x and green is y: the warp must hand back
        // exactly where each face pixel came from.
        let (w, h) = (200, 150);
        let rgba: Vec<u8> = (0..w * h).flat_map(|i| [(i % w) as u8, (i / w) as u8, 9, 255]).collect();
        let m = Similarity { a: 1.0, b: 0.0, tx: -40.0, ty: -20.0 }; // face pixel (u, v) = picture (u + 40, v + 20)
        let mut out = vec![0.0; 3 * REC * REC];
        warp_arcface(&rgba, w, h, &m, &mut out);
        let at = |out: &[f32], c: usize, u: usize, v: usize| out[c * REC * REC + v * REC + u] * 127.5 + 127.5;
        assert!((at(&out, 0, 0, 0) - 40.0).abs() < 1e-3 && (at(&out, 1, 0, 0) - 20.0).abs() < 1e-3);
        assert!((at(&out, 0, 111, 50) - 151.0).abs() < 1e-3 && (at(&out, 1, 111, 50) - 70.0).abs() < 1e-3);
        assert!((at(&out, 2, 5, 5) - 9.0).abs() < 1e-3);
        // Half a pixel: blended. Outside: black.
        let m = Similarity { a: 1.0, b: 0.0, tx: -10.5, ty: 0.0 };
        warp_arcface(&rgba, w, h, &m, &mut out);
        assert!((at(&out, 0, 0, 0) - 10.5).abs() < 1e-3);
        let m = Similarity { a: 1.0, b: 0.0, tx: 0.0, ty: 100.0 }; // face row v = picture row v − 100
        warp_arcface(&rgba, w, h, &m, &mut out);
        assert!((at(&out, 0, 3, 50) - 0.0).abs() < 1e-3 && (at(&out, 2, 3, 50) - 0.0).abs() < 1e-3);
    }

    #[test]
    fn dot_and_normalize() {
        let a: Vec<f32> = (0..37).map(|i| i as f32 * 0.1).collect();
        let b: Vec<f32> = (0..37).map(|i| 1.0 - i as f32 * 0.02).collect();
        let want: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        assert!((dot(&a, &b) - want).abs() < 1e-3);
        let mut v = vec![3.0, 4.0];
        normalize(&mut v);
        assert_eq!(v, vec![0.6, 0.8]);
        let mut z = vec![0.0; 4];
        normalize(&mut z);
        assert_eq!(z, vec![0.0; 4]);
    }
}
