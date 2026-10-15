//! A tiny colour sketch of each thumbnail: a few cells of average colour
//! (3×3, 4×3 or 3×4, by shape), drawn blurred as the tile's background the
//! moment a grid shows, before the thumbnail itself has loaded.
//!
//! Text form (stored in `media.sketch`, sent with each item):
//! one digit for the columns, one for the rows, then 3 hex digits per cell
//! (red, green, blue, 4 bits each), row by row, e.g. a 4×3 sketch is
//! `"43"` followed by 36 hex digits (38 characters). An empty string means
//! "tried, couldn't be made" (so it isn't tried again); NULL = not made yet.
//!
//! Made whenever a thumbnail is saved (from its bytes, whoever made it), and
//! for older items by a slow background pass ([`backfill`]).

use std::sync::Arc;
use std::time::Duration;

use vault_core::{ObjectId, ObjectKind};

use crate::session::Session;

/// Cells across and down for a picture of this shape (cells roughly square).
pub fn grid_for(width: u32, height: u32) -> (usize, usize) {
    let a = width.max(1) as f64 / height.max(1) as f64;
    if a >= 1.2 {
        (4, 3)
    } else if a <= 1.0 / 1.2 {
        (3, 4)
    } else {
        (3, 3)
    }
}

fn to_linear(v: u8) -> f32 {
    let c = v as f32 / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn to_srgb(l: f32) -> f32 {
    let l = l.clamp(0.0, 1.0);
    let c = if l <= 0.003_130_8 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
    c * 255.0
}

/// The sketch of an RGB picture (3 bytes per pixel, row by row). Pure, so
/// any thumbnail maker can call it with the pixels it already has.
/// Colours are averaged in linear light, so a cell of fine black-and-white
/// detail comes out mid grey, as it looks from a distance.
pub fn sketch_from_rgb(width: u32, height: u32, rgb: &[u8]) -> String {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || rgb.len() < w * h * 3 {
        return String::new();
    }
    let (cols, rows) = grid_for(width, height);
    let mut lut = [0f32; 256];
    for (i, v) in lut.iter_mut().enumerate() {
        *v = to_linear(i as u8);
    }
    let mut sums = vec![[0f32; 3]; cols * rows];
    let mut counts = vec![0u32; cols * rows];
    // Every pixel on small pictures; a sample grid on big ones (a few
    // thousand pixels per cell is plenty for an average).
    let step = ((w * h) / 200_000).max(1).isqrt().max(1);
    for y in (0..h).step_by(step) {
        let cy = y * rows / h;
        let row = &rgb[y * w * 3..(y + 1) * w * 3];
        for x in (0..w).step_by(step) {
            let cx = x * cols / w;
            let k = cy * cols + cx;
            let p = &row[x * 3..x * 3 + 3];
            sums[k][0] += lut[p[0] as usize];
            sums[k][1] += lut[p[1] as usize];
            sums[k][2] += lut[p[2] as usize];
            counts[k] += 1;
        }
    }
    let mut out = format!("{cols}{rows}");
    for (s, n) in sums.iter().zip(&counts) {
        let n = (*n).max(1) as f32;
        for c in s {
            let v = (to_srgb(c / n) / 17.0).round().clamp(0.0, 15.0) as u32;
            out.push(char::from_digit(v, 16).unwrap());
        }
    }
    out
}

/// The sketch of an encoded picture (a thumbnail: JPEG, PNG or WebP).
pub fn sketch_from_encoded(bytes: &[u8]) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?.to_rgb8();
    let s = sketch_from_rgb(img.width(), img.height(), img.as_raw());
    (!s.is_empty()).then_some(s)
}

/// Is this a well-formed sketch? (For tests and for checking input.)
pub fn is_valid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 {
        return false;
    }
    let (Some(c), Some(r)) = ((b[0] as char).to_digit(10), (b[1] as char).to_digit(10)) else {
        return false;
    };
    c > 0 && r > 0 && b.len() == 2 + 3 * (c * r) as usize && b[2..].iter().all(|x| x.is_ascii_hexdigit())
}

/// Sketches for items that have a thumbnail but none yet (older libraries,
/// free copies, thumbnails saved some other way). Slow and steady, while the
/// vault is open; checks again every few seconds.
pub fn backfill(s: Arc<Session>) {
    std::thread::spawn(move || {
        while !s.is_closed() {
            let todo: Vec<String> = {
                let db = s.db();
                let Ok(mut st) = db.prepare(
                    "SELECT DISTINCT thumb_object_id FROM media WHERE sketch IS NULL \
                     AND thumb_object_id IS NOT NULL AND thumb_object_id <> '' LIMIT 40",
                ) else {
                    return;
                };
                st.query_map([], |r| r.get(0)).and_then(|it| it.collect()).unwrap_or_default()
            };
            if todo.is_empty() {
                for _ in 0..10 {
                    if s.is_closed() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                continue;
            }
            for thumb in todo {
                if s.is_closed() {
                    return;
                }
                let sketch = ObjectId::from_hex(&thumb)
                    .ok()
                    .and_then(|oid| s.vault().read_object(ObjectKind::Thumbnail, &oid).ok())
                    .and_then(|bytes| sketch_from_encoded(&bytes))
                    .unwrap_or_default();
                let _ = s.db().execute(
                    "UPDATE media SET sketch = ?1 WHERE thumb_object_id = ?2 AND sketch IS NULL",
                    rusqlite::params![sketch, thumb],
                );
                s.mark_dirty();
                // Leave the computer to the things you are doing.
                std::thread::sleep(Duration::from_millis(3));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_pick_the_grid() {
        assert_eq!(grid_for(400, 300), (4, 3));
        assert_eq!(grid_for(300, 400), (3, 4));
        assert_eq!(grid_for(100, 100), (3, 3));
        assert_eq!(grid_for(1000, 10), (4, 3));
        assert_eq!(grid_for(0, 0), (3, 3));
    }

    #[test]
    fn a_flat_colour_is_that_colour_everywhere() {
        let (w, h) = (40, 30);
        let rgb: Vec<u8> = (0..w * h).flat_map(|_| [255u8, 0, 136]).collect();
        let s = sketch_from_rgb(w, h, &rgb);
        assert!(is_valid(&s), "{s}");
        assert_eq!(s.len(), 38);
        assert_eq!(&s[..2], "43");
        assert!(s[2..].as_bytes().chunks(3).all(|c| c == b"f08"), "{s}");
    }

    #[test]
    fn cells_follow_the_picture() {
        // Left half white, right half black, portrait: 3×4.
        let (w, h) = (30u32, 40u32);
        let mut rgb = Vec::new();
        for _y in 0..h {
            for x in 0..w {
                let v = if x < 10 { 255 } else if x < 20 { 128 } else { 0 };
                rgb.extend([v, v, v]);
            }
        }
        let s = sketch_from_rgb(w, h, &rgb);
        assert_eq!(&s[..2], "34");
        let cells: Vec<&[u8]> = s[2..].as_bytes().chunks(3).collect();
        assert_eq!(cells.len(), 12);
        for r in 0..4 {
            assert_eq!(cells[r * 3], b"fff");
            assert_eq!(cells[r * 3 + 1], b"888");
            assert_eq!(cells[r * 3 + 2], b"000");
        }
    }

    #[test]
    fn fine_detail_averages_in_linear_light() {
        // A checkerboard of black and white looks about 73% bright (sRGB 188), not 50%.
        let (w, h) = (30u32, 30u32);
        let rgb: Vec<u8> = (0..w * h).flat_map(|i| { let v = if (i % w + i / w) % 2 == 0 { 255 } else { 0 }; [v, v, v] }).collect();
        let s = sketch_from_rgb(w, h, &rgb);
        assert!(s[2..].as_bytes().chunks(3).all(|c| c == b"bbb"), "{s}");
    }

    #[test]
    fn big_pictures_are_sampled_and_bad_input_is_refused() {
        let (w, h) = (3000u32, 2000u32);
        let rgb = vec![17u8; (w * h * 3) as usize];
        let s = sketch_from_rgb(w, h, &rgb);
        assert!(s[2..].bytes().all(|c| c == b'1'), "{s}");
        assert_eq!(sketch_from_rgb(10, 10, &[0; 5]), "");
        assert_eq!(sketch_from_rgb(0, 10, &[]), "");
        assert!(!is_valid("43abc"));
        assert!(!is_valid(""));
        assert!(is_valid("11abc"));
    }

    #[test]
    fn from_a_jpeg() {
        let img = image::RgbImage::from_pixel(64, 48, image::Rgb([0, 200, 255]));
        let mut jpg = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut jpg), image::ImageFormat::Jpeg)
            .unwrap();
        let s = sketch_from_encoded(&jpg).unwrap();
        assert_eq!(&s[..2], "43");
        assert!(s[2..].as_bytes().chunks(3).all(|c| c == b"0cf"), "{s}");
        assert_eq!(sketch_from_encoded(b"not a picture"), None);
    }
}
