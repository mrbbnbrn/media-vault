//! Poor faces: faces too small, too blurry or turned too far away to be
//! trusted. Their fingerprints are unreliable, so a poor face is never named
//! automatically and never used to learn what a person looks like — unless
//! you name it yourself (then it teaches like any other).
//!
//! Each face keeps three measurements (library v17): `px` (its height in
//! the item's own pixels), `sharp` (variance of the Laplacian of a small
//! grey crop; -1 = couldn't be measured) and `turn` (degrees away from
//! looking at the camera). Whether that makes it poor is decided every time
//! it's asked, from Settings → Faces, so moving a slider re-sorts every face
//! at once: nothing is scanned again and no name is lost. A value not
//! measured yet (NULL) never makes a face poor.
//!
//! Faces found now are measured when found (the picture is decoded anyway);
//! faces found before v17 get theirs from a small background job in the
//! analysis pass that decodes the picture once more and measures the boxes
//! already there, without touching names or ids.

use std::cell::Cell;
use std::sync::RwLock;

use rusqlite::{Connection, params};
use zeroize::Zeroizing;

use crate::config::PoorFaceSettings;
use crate::library::R;
use crate::picture::{self, Rgb};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

// ---- the rule -------------------------------------------------------------------------------

/// Where "poor" starts, in the units stored per face.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PoorRule {
    /// Shorter than this (pixels) = too small. 0 = never.
    pub min_px: f64,
    /// Laplacian variance below this = too blurry. 0 = never.
    pub min_sharp: f64,
    /// Turned more than this (degrees) = too far away. 90 = never.
    pub max_turn: f64,
}

impl Default for PoorRule {
    fn default() -> Self {
        Self::from_settings(&PoorFaceSettings::default())
    }
}

impl PoorRule {
    pub fn from_settings(s: &PoorFaceSettings) -> Self {
        let s = s.clone().sanitized();
        PoorRule { min_px: s.min_px, min_sharp: blur_to_sharpness(s.blur), max_turn: s.turn }
    }
    pub fn small(&self, px: Option<f64>) -> bool {
        px.is_some_and(|p| p < self.min_px)
    }
    pub fn blurry(&self, sharp: Option<f64>) -> bool {
        sharp.is_some_and(|s| s >= 0.0 && s < self.min_sharp)
    }
    pub fn turned(&self, turn: Option<f64>) -> bool {
        turn.is_some_and(|t| t > self.max_turn)
    }
    /// SQL: the measurements of face `a` (a table alias) are poor.
    fn measures_sql(&self, a: &str) -> String {
        // Plain numbers (sanitised, never NaN), so they can be written into the SQL.
        let n = |x: f64| if x.is_finite() { format!("{x:.6}") } else { "0".into() };
        format!(
            "(({a}.px IS NOT NULL AND {a}.px < {}) OR ({a}.sharp IS NOT NULL AND {a}.sharp >= 0 AND {a}.sharp < {}) OR ({a}.turn IS NOT NULL AND {a}.turn > {}))",
            n(self.min_px),
            n(self.min_sharp),
            n(self.max_turn)
        )
    }
}

/// Sharpness on the friendly 0–100 scale of the settings: 100·(1 − e^(−σ/8)),
/// σ being the standard deviation of the Laplacian (the square root of the
/// stored variance). About 20 = very soft, 40 = a bit soft, 70+ = crisp.
/// (The app only needs the other way round; this one checks the two agree.)
#[cfg(test)]
pub fn sharpness_score(var: f64) -> f64 {
    100.0 * (1.0 - (-var.max(0.0).sqrt() / 8.0).exp())
}

/// The other way: the friendly 0–100 "blur" setting as a Laplacian variance.
pub fn blur_to_sharpness(blur: f64) -> f64 {
    let t = (blur / 100.0).clamp(0.0, 0.99);
    let sd = -8.0 * (1.0 - t).ln();
    sd * sd
}

static RULE: RwLock<Option<PoorRule>> = RwLock::new(None);

thread_local! {
    /// Tests run side by side: each sets its own rule on its own thread.
    static TEST_RULE: Cell<Option<PoorRule>> = const { Cell::new(None) };
}

/// The settings changed (or were loaded): from now on faces are judged by these.
pub fn set_rule(s: &PoorFaceSettings) {
    *RULE.write().unwrap_or_else(|x| x.into_inner()) = Some(PoorRule::from_settings(s));
}

/// For tests: this thread's own rule (None = back to the shared one).
#[cfg(test)]
pub fn set_test_rule(r: Option<PoorRule>) {
    TEST_RULE.with(|t| t.set(r));
}

pub fn rule() -> PoorRule {
    if let Some(r) = TEST_RULE.with(|t| t.get()) {
        return r;
    }
    RULE.read().unwrap_or_else(|x| x.into_inner()).unwrap_or_default()
}

/// SQL (1 or 0): face `a` counts as poor right now. A face you named
/// yourself never does — you've vouched for it, so it teaches the app.
pub fn poor_sql(a: &str) -> String {
    format!("({} AND NOT ({a}.person_id IS NOT NULL AND {a}.auto = 0))", rule().measures_sql(a))
}

// ---- measuring ------------------------------------------------------------------------------

/// How far a face is turned away (0 = straight at the camera, 90 = side on),
/// from the five face points the face finder gives (eyes, nose tip, mouth
/// corners). Turning moves the nose tip towards one eye while the eyes come
/// closer together: the nose's distance from the eyes' midpoint, along the
/// line through the eyes, over the eye distance is about 0.55·tan(angle)
/// (the nose sits about half an eye distance in front of the eyes).
pub fn turn_degrees(kps: &[[f32; 2]; 5]) -> f32 {
    let (l, r, n) = (kps[0], kps[1], kps[2]);
    let (dx, dy) = (r[0] - l[0], r[1] - l[1]);
    let d = (dx * dx + dy * dy).sqrt();
    if !d.is_finite() || d < 1e-3 {
        return 90.0;
    }
    let mid = [(l[0] + r[0]) / 2.0, (l[1] + r[1]) / 2.0];
    // Along the eye line, so a tilted (rolled) head doesn't count as turned.
    let along = ((n[0] - mid[0]) * dx + (n[1] - mid[1]) * dy) / d;
    let t = (along / d).abs();
    if !t.is_finite() {
        return 90.0;
    }
    (t / 0.55).atan().to_degrees().clamp(0.0, 90.0)
}

/// Sharpness of the face inside `bbox` (x1, y1, x2, y2 in pixels of the RGBA
/// picture): the variance of the Laplacian of a grey copy at most 64 px
/// across (never enlarged, so a small face isn't blurred by stretching it).
/// The box is taken in by a tenth on each side, so a sharp background
/// around a soft face counts less. Kept in memory only.
pub fn crop_sharpness(rgba: &[u8], w: usize, h: usize, bbox: [f32; 4]) -> Option<f32> {
    if w == 0 || h == 0 || rgba.len() != w * h * 4 || !bbox.iter().all(|v| v.is_finite()) {
        return None;
    }
    let (bw, bh) = (bbox[2] - bbox[0], bbox[3] - bbox[1]);
    let cl = |v: f32, max: usize| (v.max(0.0) as usize).min(max);
    let (x1, y1) = (cl((bbox[0] + 0.1 * bw).floor(), w), cl((bbox[1] + 0.1 * bh).floor(), h));
    let (x2, y2) = (cl((bbox[2] - 0.1 * bw).ceil(), w), cl((bbox[3] - 0.1 * bh).ceil(), h));
    if x2 < x1 + 4 || y2 < y1 + 4 {
        return None;
    }
    let (cw, ch) = (x2 - x1, y2 - y1);
    let mut px = Zeroizing::new(Vec::with_capacity(cw * ch * 3));
    for y in y1..y2 {
        for p in rgba[(y * w + x1) * 4..(y * w + x2) * 4].chunks_exact(4) {
            px.extend_from_slice(&p[..3]);
        }
    }
    let crop = Rgb { w: cw, h: ch, px };
    let size = cw.max(ch).clamp(8, 64);
    let g = Zeroizing::new(picture::grey(&crop, size));
    let s = picture::sharpness(&g, size, size) as f32;
    s.is_finite().then_some(s.max(0.0))
}

/// One face the finder found: its box (x1, y1, x2, y2) and five points, in pixels.
pub type Detected = ([f32; 4], [[f32; 2]; 5]);

/// Measure the faces of one picture found before v17 (not measured yet),
/// keeping everything else about them. `pic` is the picture the face finder
/// would see (RGBA, width, height) or None when it couldn't be read: then
/// they are marked "couldn't be measured" (sharp = -1) so they aren't tried
/// again. `found` are the faces the finder sees in it now, for how turned
/// each one is (matched to the stored boxes by overlap). Returns how many
/// faces were measured.
pub fn store_measures(conn: &Connection, media: i64, pic: Option<(&[u8], usize, usize)>, found: &[Detected]) -> R<usize> {
    let faces: Vec<(i64, [f32; 4])> = conn
        .prepare("SELECT id, x, y, w, h FROM faces WHERE media_id = ? AND frame_ms = 0 AND sharp IS NULL")
        .map_err(e)?
        .query_map([media], |r| {
            Ok((r.get(0)?, [r.get::<_, f64>(1)? as f32, r.get::<_, f64>(2)? as f32, r.get::<_, f64>(3)? as f32, r.get::<_, f64>(4)? as f32]))
        })
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    let mut n = 0;
    for (id, r) in faces {
        let (sharp, turn) = match pic {
            None => (-1.0, None),
            Some((rgba, w, h)) => {
                let (fw, fh) = (w as f32, h as f32);
                let b = [r[0] * fw, r[1] * fh, (r[0] + r[2]) * fw, (r[1] + r[3]) * fh];
                let sharp = crop_sharpness(rgba, w, h, b).unwrap_or(-1.0);
                let best = found
                    .iter()
                    .map(|d| (d, crate::faceid_math::iou(&d.0, &b)))
                    .filter(|x| x.1 >= 0.3)
                    .max_by(|a, b| a.1.total_cmp(&b.1));
                (sharp, best.map(|(d, _)| turn_degrees(&d.1)))
            }
        };
        n += tx.execute("UPDATE faces SET sharp = ?, turn = COALESCE(?, turn) WHERE id = ?", params![sharp, turn, id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(n)
}

/// Pictures (that the analysis pass can decode itself: `here` is its SQL
/// for that) with faces not measured yet.
pub fn measure_needed(conn: &Connection, here: &str, limit: i64) -> R<Vec<(i64, String)>> {
    conn.prepare(&format!(
        "SELECT id, object_id FROM media WHERE deleted_at IS NULL AND faces_state = 1 AND {here} \
         AND id IN (SELECT media_id FROM faces WHERE sharp IS NULL AND frame_ms = 0) ORDER BY id DESC LIMIT ?"
    ))
    .map_err(e)?
    .query_map([limit], |r| Ok((r.get(0)?, r.get(1)?)))
    .map_err(e)?
    .collect::<rusqlite::Result<_>>()
    .map_err(e)
}

/// One small round of the background job (when the analysis pass has
/// nothing else to do and the faces pack works): a few pictures decoded,
/// their faces measured. Returns how many pictures were done (0 = none left).
pub fn measure_round(s: &crate::session::Session, here: &str) -> usize {
    use vault_core::{ObjectId, ObjectKind};
    let todo = measure_needed(&s.db(), here, 4).unwrap_or_default();
    let mut done = 0;
    for (id, object) in todo {
        if s.is_closed() {
            break;
        }
        let pic = ObjectId::from_hex(&object)
            .map_err(|x| x.to_string())
            .and_then(|o| s.vault().read_object(ObjectKind::Media, &o).map_err(|x| x.to_string()))
            .and_then(|b| picture::decode(&b));
        let r = match pic {
            Err(_) => store_measures(&s.db(), id, None, &[]),
            Ok(pic) => {
                let (rgba, w, h) = picture::faces_input(&pic);
                drop(pic);
                let found = match crate::faceid::detections(&rgba, w, h) {
                    Ok(f) => f,
                    // The face finder stopped working: try again later.
                    Err(_) if !crate::faceid::info().available => return done,
                    Err(_) => Vec::new(),
                };
                store_measures(&s.db(), id, Some((&rgba, w, h)), &found)
            }
        };
        if r.is_ok() {
            s.mark_dirty();
        }
        done += 1;
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turning_is_read_from_the_face_points() {
        // Straight on: the nose right between the eyes.
        let front = [[40.0, 50.0], [80.0, 50.0], [60.0, 70.0], [45.0, 85.0], [75.0, 85.0]];
        assert!(turn_degrees(&front) < 1.0);
        // A tilted head looking straight is not turned.
        let tilt = [[40.0, 40.0], [80.0, 60.0], [50.0, 70.0], [45.0, 85.0], [75.0, 85.0]];
        assert!(turn_degrees(&tilt) < 10.0, "{}", turn_degrees(&tilt));
        // Nose over one eye: well over 45°; eyes on top of each other: side on.
        let side = [[40.0, 50.0], [60.0, 50.0], [70.0, 70.0], [45.0, 85.0], [60.0, 85.0]];
        assert!(turn_degrees(&side) > 55.0, "{}", turn_degrees(&side));
        let profile = [[50.0, 50.0], [50.0, 50.0], [70.0, 70.0], [50.0, 85.0], [55.0, 85.0]];
        assert_eq!(turn_degrees(&profile), 90.0);
        // A little turned stays under the default 60°.
        let bit = [[40.0, 50.0], [80.0, 50.0], [68.0, 70.0], [45.0, 85.0], [75.0, 85.0]];
        let a = turn_degrees(&bit);
        assert!(a > 10.0 && a < 40.0, "{a}");
    }

    fn picture(w: usize, h: usize, f: impl Fn(usize, usize) -> u8) -> Vec<u8> {
        let mut v = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                let g = f(x, y);
                v.extend_from_slice(&[g, g, g, 255]);
            }
        }
        v
    }

    #[test]
    fn sharp_faces_measure_sharper_than_soft_ones() {
        let sharp = picture(100, 100, |x, y| if (x / 4 + y / 4) % 2 == 0 { 230 } else { 20 });
        let soft = picture(100, 100, |x, _| (x * 2) as u8);
        let b = [10.0, 10.0, 90.0, 90.0];
        let s = crop_sharpness(&sharp, 100, 100, b).unwrap();
        let o = crop_sharpness(&soft, 100, 100, b).unwrap();
        assert!(s > 1000.0 && o < 1.0, "{s} {o}");
        assert!(sharpness_score(s as f64) > 95.0 && sharpness_score(o as f64) < 15.0);
        // Too small or outside the picture: no value.
        assert!(crop_sharpness(&sharp, 100, 100, [99.0, 99.0, 100.0, 100.0]).is_none());
        assert!(crop_sharpness(&sharp, 100, 99, b).is_none());
        // The friendly scale and the setting agree.
        for t in [5.0, 25.0, 60.0] {
            assert!((sharpness_score(blur_to_sharpness(t)) - t).abs() < 1e-6);
        }
        assert_eq!(blur_to_sharpness(0.0), 0.0);
    }

    #[test]
    fn rules_judge_only_what_was_measured() {
        let r = PoorRule { min_px: 40.0, min_sharp: 10.0, max_turn: 60.0 };
        assert!(r.small(Some(39.0)) && !r.small(Some(40.0)) && !r.small(None));
        assert!(r.blurry(Some(3.0)) && !r.blurry(Some(-1.0)) && !r.blurry(None) && !r.blurry(Some(11.0)));
        assert!(r.turned(Some(61.0)) && !r.turned(Some(60.0)) && !r.turned(None));
        let off = PoorRule::from_settings(&PoorFaceSettings { min_px: 0.0, blur: 0.0, turn: 90.0 });
        assert!(!off.small(Some(1.0)) && !off.blurry(Some(0.0)) && !off.turned(Some(90.0)));
        let d = PoorRule::default();
        assert_eq!(d.min_px, 40.0);
        assert_eq!(d.max_turn, 60.0);
        // Older settings files get the defaults; odd values are brought back in range.
        let c: crate::config::AppConfig = serde_json::from_str(r##"{"accent":"#2ec4b6"}"##).unwrap();
        assert_eq!(c.poor_faces, PoorFaceSettings::default());
        assert!(!c.viewer.poor_faces, "poor face boxes start hidden");
        let c: crate::config::AppConfig = serde_json::from_str(r#"{"poorFaces":{"minPx":-3,"blur":500}}"#).unwrap();
        let s = c.sanitized().poor_faces;
        assert_eq!((s.min_px, s.blur, s.turn), (0.0, 95.0, 60.0));
    }

    #[test]
    fn old_faces_are_measured_without_touching_anything_else() {
        let c = vault_core::db::create_empty().unwrap();
        c.execute(
            "INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at, faces_state) VALUES ('o', 'image', 'a', 'jpg', 1, 'h', 0, 1)",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO folders(id, name, created_at, person) VALUES (7, 'P', 0, 1)", []).unwrap();
        for (x, person) in [(0.1, Some(7)), (0.6, None)] {
            c.execute(
                "INSERT INTO faces(media_id, x, y, w, h, score, descriptor, person_id, auto) VALUES (1, ?, 0.1, 0.3, 0.3, 1, x'00', ?, 0)",
                params![x, person],
            )
            .unwrap();
        }
        let here = "kind = 'image'";
        assert_eq!(measure_needed(&c, here, 10).unwrap().len(), 1);
        // Left face crisp and found looking aside; right face flat grey.
        let pic = picture(100, 100, |x, y| if x < 50 { if (x / 3 + y / 3) % 2 == 0 { 220 } else { 30 } } else { 128 });
        let found: Vec<Detected> = vec![([10.0, 10.0, 40.0, 40.0], [[15.0, 20.0], [25.0, 20.0], [30.0, 30.0], [15.0, 35.0], [25.0, 35.0]])];
        assert_eq!(store_measures(&c, 1, Some((&pic, 100, 100)), &found).unwrap(), 2);
        let rows: Vec<(i64, Option<i64>, f64, Option<f64>)> = c
            .prepare("SELECT id, person_id, sharp, turn FROM faces ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!((rows[0].0, rows[0].1), (1, Some(7)), "ids and names kept");
        assert!(rows[0].2 > 100.0 && rows[0].3.unwrap() > 55.0, "{rows:?}");
        assert!(rows[1].2 < 1.0 && rows[1].3.is_none(), "{rows:?}");
        assert!(measure_needed(&c, here, 10).unwrap().is_empty(), "done once");
        assert_eq!(store_measures(&c, 1, None, &[]).unwrap(), 0);
        // A picture that can't be read: marked so it isn't tried again.
        c.execute("UPDATE faces SET sharp = NULL", []).unwrap();
        store_measures(&c, 1, None, &[]).unwrap();
        let s: f64 = c.query_row("SELECT MAX(sharp) FROM faces", [], |r| r.get(0)).unwrap();
        assert_eq!(s, -1.0);
        assert!(measure_needed(&c, here, 10).unwrap().is_empty());
    }
}
