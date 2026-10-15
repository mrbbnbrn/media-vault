//! A person's faces, cut out: the face wall, "Best faces" and the face
//! time-lapse. The list comes straight from the library (named faces only,
//! leaving out "not important" ones, trashed items and videos). The
//! measuring (how sharp a face is, how straight it looks at the camera and
//! where its eyes are) decodes the original picture in memory, looks at the
//! face and forgets the picture again; only a few numbers per face are kept,
//! in memory, for this session. Nothing is ever written anywhere.
//!
//! Videos are left out on purpose: cutting a face out of a video frame means
//! seeking and decoding the video, which is too slow for a wall of hundreds
//! of faces. The window says "pictures only".

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use rusqlite::{Connection, params_from_iter};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use vault_core::{ObjectId, ObjectKind};

use crate::picture::{self, Filter, Rgb};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

// ---- the list ---------------------------------------------------------------------------------

/// One face of a person, as the window needs it to cut it out.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersonFace {
    pub id: i64,
    pub media_id: i64,
    pub frame_ms: i64,
    /// The face box, as parts (0–1) of the picture.
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// The photo's best known date (taken, else the file's date, else imported; seconds).
    pub date: i64,
    /// The picture's own size (0 when not known yet).
    pub width: i64,
    pub height: i64,
    /// How tall the face is in the original picture, in pixels.
    pub face_px: f32,
}

/// Every face of `person` in a picture (not videos), oldest photo first.
/// "Not important" faces and trashed items are left out.
pub fn person_faces(conn: &Connection, person: i64) -> Result<Vec<PersonFace>, String> {
    conn.prepare(
        "SELECT f.id, f.media_id, f.frame_ms, f.x, f.y, f.w, f.h, \
                COALESCE(NULLIF(m.taken_at, 0), NULLIF(m.file_mtime, 0), m.imported_at), \
                IFNULL(m.width, 0), IFNULL(m.height, 0) \
         FROM faces f JOIN media m ON m.id = f.media_id \
         WHERE f.person_id = ?1 AND f.hidden = 0 AND m.deleted_at IS NULL AND m.kind IN ('image', 'gif') \
         ORDER BY 8, f.media_id, f.id",
    )
    .map_err(e)?
    .query_map([person], |r| {
        let h: f32 = r.get(6)?;
        let height: i64 = r.get(9)?;
        Ok(PersonFace {
            id: r.get(0)?,
            media_id: r.get(1)?,
            frame_ms: r.get(2)?,
            x: r.get(3)?,
            y: r.get(4)?,
            w: r.get(5)?,
            h,
            date: r.get(7)?,
            width: r.get(8)?,
            height,
            face_px: h * height as f32,
        })
    })
    .map_err(e)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(e)
}

/// Faces at least `min_px` tall in the original picture (the "Smallest face" slider).
/// Faces of pictures whose size isn't known yet are kept (they can't be judged).
pub fn at_least(faces: &[PersonFace], min_px: f32) -> Vec<PersonFace> {
    faces.iter().filter(|f| f.height <= 0 || f.face_px >= min_px).cloned().collect()
}

// ---- measuring -------------------------------------------------------------------------------

/// What was measured on one face.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FaceMeasure {
    pub id: i64,
    /// Variance of the Laplacian of the face at 64 × 64 grey (higher = sharper).
    pub sharp: f32,
    /// 0 (turned away) … 1 (looking straight at the camera); None without the faces pack.
    pub front: Option<f32>,
    /// The five face points (eyes, nose tip, mouth corners) as parts of the picture.
    pub points: Option<[[f32; 2]; 5]>,
    /// How tall the face is in the original picture (pixels).
    pub face_px: f32,
    /// All together, 0…1 (higher = better), see `score`.
    pub score: f32,
    /// The picture couldn't be read here (the face is left out of "Best faces").
    pub failed: bool,
}

/// How much each part counts towards "best".
const W_SIZE: f32 = 0.35;
const W_SHARP: f32 = 0.35;
const W_FRONT: f32 = 0.30;
/// A Laplacian variance of this much counts as half way to perfectly sharp.
const SHARP_HALF: f32 = 120.0;
/// Faces this tall (or more) count as fully big; 40 px counts as nothing.
const SIZE_FULL: f32 = 800.0;
const SIZE_NONE: f32 = 40.0;

/// 0…1 for how big a face is (on a log scale: 80 → 400 px matters more than 800 → 1600).
pub fn size_part(face_px: f32) -> f32 {
    if face_px <= SIZE_NONE {
        return 0.0;
    }
    ((face_px / SIZE_NONE).ln() / (SIZE_FULL / SIZE_NONE).ln()).clamp(0.0, 1.0)
}

/// 0…1 for how sharp (gets close to 1 slowly: very sharp and sharp are close).
pub fn sharp_part(sharp: f32) -> f32 {
    let s = sharp.max(0.0);
    s / (s + SHARP_HALF)
}

/// Large, sharp and looking at the camera, all in one number (0…1). Without
/// the face points the "looking at the camera" part counts as half way.
pub fn score(face_px: f32, sharp: f32, front: Option<f32>) -> f32 {
    W_SIZE * size_part(face_px) + W_SHARP * sharp_part(sharp) + W_FRONT * front.unwrap_or(0.5).clamp(0.0, 1.0)
}

/// How straight a face looks at the camera, from its five points (any units):
/// the nose and the middle of the mouth sit half way between the eyes when
/// the head isn't turned, and the nose sits about half way down between the
/// eyes and the mouth when it isn't tilted up or down. Turning the picture
/// (a tilted head) doesn't count against it.
pub fn frontness(p: &[[f32; 2]; 5]) -> f32 {
    let [l, r, n, ml, mr] = *p;
    let (ex, ey) = (r[0] - l[0], r[1] - l[1]);
    let eye = (ex * ex + ey * ey).sqrt();
    if eye < 1e-6 {
        return 0.0;
    }
    // Along the eye line (u) and across it (v).
    let u = [ex / eye, ey / eye];
    let v = [-u[1], u[0]];
    let mid = [(l[0] + r[0]) / 2.0, (l[1] + r[1]) / 2.0];
    let mouth = [(ml[0] + mr[0]) / 2.0, (ml[1] + mr[1]) / 2.0];
    let along = |q: [f32; 2]| ((q[0] - mid[0]) * u[0] + (q[1] - mid[1]) * u[1]) / (eye / 2.0);
    let down = |q: [f32; 2]| (q[0] - mid[0]) * v[0] + (q[1] - mid[1]) * v[1];
    let nose_off = along(n).abs();
    let mouth_off = along(mouth).abs();
    let turn = (1.0 - (0.7 * nose_off + 0.3 * mouth_off)).clamp(0.0, 1.0);
    let mouth_down = down(mouth);
    let tilt = if mouth_down > 1e-6 { (1.0 - 2.0 * (down(n) / mouth_down - 0.55).abs()).clamp(0.0, 1.0) } else { 0.0 };
    0.75 * turn + 0.25 * tilt
}

/// The part of the picture looked at around a face: the box and half of it
/// again on every side (the face finder needs a little of the head around
/// the face), kept inside the picture. Pixels: (x, y, w, h).
pub fn crop_region(f: &PersonFace, w: usize, h: usize) -> (f64, f64, f64, f64) {
    let (pw, ph) = (w as f64, h as f64);
    let (fx, fy, fw, fh) = (f.x as f64 * pw, f.y as f64 * ph, f.w as f64 * pw, f.h as f64 * ph);
    let m = 0.5 * fw.max(fh);
    let x0 = (fx - m).clamp(0.0, pw - 1.0);
    let y0 = (fy - m).clamp(0.0, ph - 1.0);
    let x1 = (fx + fw + m).clamp(x0 + 1.0, pw);
    let y1 = (fy + fh + m).clamp(y0 + 1.0, ph);
    (x0, y0, x1 - x0, y1 - y0)
}

/// Grey (0.299 R + 0.587 G + 0.114 B) of resampled RGB values.
fn grey_of(rgb: &[f32]) -> Vec<f64> {
    rgb.chunks_exact(3).map(|p| 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64).collect()
}

/// The face points of the face in the middle of a crop, in crop pixels.
type PointsFn<'a> = dyn FnMut(&[u8], usize, usize) -> Option<Vec<[[f32; 2]; 5]>> + 'a;

/// Measure the faces of one decoded picture. `points` finds the five face
/// points in an RGBA crop (None: not available).
pub fn measure_picture(pic: &Rgb, faces: &[PersonFace], points: &mut PointsFn<'_>) -> Vec<FaceMeasure> {
    faces
        .iter()
        .map(|f| {
            // The face itself at 64 × 64 grey: the same size for every face,
            // so a small blurry face can't look sharp by being shrunk a lot.
            let (pw, ph) = (pic.w as f64, pic.h as f64);
            let fx = (f.x as f64 * pw).clamp(0.0, pw - 1.0);
            let fy = (f.y as f64 * ph).clamp(0.0, ph - 1.0);
            let fw = (f.w as f64 * pw).clamp(1.0, pw - fx);
            let fh = (f.h as f64 * ph).clamp(1.0, ph - fy);
            let face = picture::resample(pic, (fx, fy, fw, fh), 64, 64, Filter::Triangle);
            let sharp = picture::sharpness(&grey_of(&face), 64, 64) as f32;
            // The points, on a crop of at most 320 px around the face.
            let region = crop_region(f, pic.w, pic.h);
            let k = (320.0 / region.2.max(region.3)).min(1.0);
            let (cw, ch) = (((region.2 * k).round() as usize).max(8), ((region.3 * k).round() as usize).max(8));
            let crop = picture::resample(pic, region, cw, ch, Filter::Triangle);
            let mut rgba = zeroize::Zeroizing::new(Vec::with_capacity(cw * ch * 4));
            for p in crop.chunks_exact(3) {
                rgba.extend_from_slice(&[p[0].round().clamp(0.0, 255.0) as u8, p[1].round().clamp(0.0, 255.0) as u8, p[2].round().clamp(0.0, 255.0) as u8, 255]);
            }
            // The face we mean is the one whose nose is closest to the middle of the crop.
            let found = points(&rgba, cw, ch).and_then(|all| {
                let centre = [(f.x as f64 * pic.w as f64 + f.w as f64 * pic.w as f64 / 2.0 - region.0) * k, (f.y as f64 * pic.h as f64 + f.h as f64 * pic.h as f64 / 2.0 - region.1) * k];
                all.into_iter().min_by(|a, b| {
                    let d = |p: &[[f32; 2]; 5]| (p[2][0] as f64 - centre[0]).powi(2) + (p[2][1] as f64 - centre[1]).powi(2);
                    d(a).total_cmp(&d(b))
                })
            });
            let points = found.map(|p| p.map(|[x, y]| [((x as f64 / k + region.0) / pic.w as f64) as f32, ((y as f64 / k + region.1) / pic.h as f64) as f32]));
            let front = found.map(|p| frontness(&p));
            let face_px = f.h * pic.h as f32;
            FaceMeasure { id: f.id, sharp, front, points, face_px, score: score(face_px, sharp, front), failed: false }
        })
        .collect()
}

/// Measured faces of this session (face id → numbers). Forgotten when the vault locks.
static CACHE: Mutex<Option<(String, HashMap<i64, FaceMeasure>)>> = Mutex::new(None);
/// Measuring jobs asked to stop (by the window's job name).
static STOP: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Forget every measured face (the vault is locking).
pub fn forget() {
    *CACHE.lock().unwrap_or_else(|x| x.into_inner()) = None;
}

fn cached(key: &str, ids: &[i64]) -> HashMap<i64, FaceMeasure> {
    let c = CACHE.lock().unwrap_or_else(|x| x.into_inner());
    match &*c {
        Some((k, m)) if k == key => ids.iter().filter_map(|i| m.get(i).map(|v| (*i, v.clone()))).collect(),
        _ => HashMap::new(),
    }
}

fn remember(key: &str, list: &[FaceMeasure]) {
    let mut c = CACHE.lock().unwrap_or_else(|x| x.into_inner());
    if c.as_ref().is_none_or(|(k, _)| k != key) {
        *c = Some((key.to_string(), HashMap::new()));
    }
    if let Some((_, m)) = c.as_mut() {
        for f in list {
            m.insert(f.id, f.clone());
        }
    }
}

fn stopped(job: &str) -> bool {
    STOP.lock().unwrap_or_else(|x| x.into_inner()).as_ref().is_some_and(|s| s.contains(job))
}

/// The faces with these ids (named or not, any picture), for measuring.
fn faces_by_id(conn: &Connection, ids: &[i64]) -> Result<Vec<PersonFace>, String> {
    let mut out = Vec::new();
    for chunk in ids.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT f.id, f.media_id, f.frame_ms, f.x, f.y, f.w, f.h, 0, IFNULL(m.width, 0), IFNULL(m.height, 0) \
             FROM faces f JOIN media m ON m.id = f.media_id WHERE f.id IN ({marks}) AND m.kind IN ('image', 'gif')"
        );
        let mut st = conn.prepare(&sql).map_err(e)?;
        let rows = st
            .query_map(params_from_iter(chunk), |r| {
                let h: f32 = r.get(6)?;
                let height: i64 = r.get(9)?;
                Ok(PersonFace {
                    id: r.get(0)?,
                    media_id: r.get(1)?,
                    frame_ms: r.get(2)?,
                    x: r.get(3)?,
                    y: r.get(4)?,
                    w: r.get(5)?,
                    h,
                    date: 0,
                    width: r.get(8)?,
                    height,
                    face_px: h * height as f32,
                })
            })
            .map_err(e)?;
        for r in rows {
            out.push(r.map_err(e)?);
        }
    }
    Ok(out)
}

/// The picture, decoded in memory: the original when it can be read here,
/// else its thumbnail (HEIC, AVIF… are shown by the window; their thumbnail is enough to judge a face).
fn decode_item(s: &crate::session::Session, media: i64) -> Result<Rgb, String> {
    if let Ok(pic) = crate::rotate::read_item(s, media).and_then(|b| picture::decode(&b)) {
        return Ok(pic);
    }
    let thumb: Option<String> = s
        .db()
        .query_row("SELECT thumb_object_id FROM media WHERE id = ?", [media], |r| r.get(0))
        .map_err(e)?;
    let hex = thumb.filter(|t| !t.is_empty()).ok_or("This picture can't be read here.")?;
    let id = ObjectId::from_hex(&hex).map_err(|x| x.to_string())?;
    let bytes = s.vault().read_object(ObjectKind::Thumbnail, &id).map_err(|x| x.to_string())?;
    picture::decode(&bytes)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeasureProgress {
    job: String,
    done: usize,
    total: usize,
}

/// Measure faces (sharpness, looking at the camera, the five points),
/// remembered for the session: faces measured before come back at once.
/// Sends "face-measure-progress" ({ job, done, total }) about ten times a second.
pub fn measure(s: &crate::session::Session, job: &str, ids: &[i64], progress: &mut dyn FnMut(usize, usize)) -> Result<Vec<FaceMeasure>, String> {
    let key = s.vault().root().display().to_string();
    let known = cached(&key, ids);
    let todo: Vec<i64> = ids.iter().copied().filter(|i| !known.contains_key(i)).collect();
    let faces = faces_by_id(&s.db(), &todo)?;
    let mut by_media: Vec<(i64, Vec<PersonFace>)> = Vec::new();
    for f in faces {
        match by_media.iter_mut().find(|(m, _)| *m == f.media_id) {
            Some((_, l)) => l.push(f),
            None => by_media.push((f.media_id, vec![f])),
        }
    }
    let total = ids.len();
    let mut done = known.len();
    progress(done, total);
    let pack = crate::faceid::info().available;
    let mut points = |rgba: &[u8], w: usize, h: usize| if pack { crate::faceid::points(rgba, w, h).ok() } else { None };
    let mut out: Vec<FaceMeasure> = known.into_values().collect();
    for (media, list) in by_media {
        if stopped(job) || s.is_closed() {
            break;
        }
        let measured = match decode_item(s, media) {
            Ok(pic) => measure_picture(&pic, &list, &mut points),
            Err(_) => list
                .iter()
                .map(|f| FaceMeasure { id: f.id, sharp: 0.0, front: None, points: None, face_px: f.face_px, score: 0.0, failed: true })
                .collect(),
        };
        remember(&key, &measured);
        done += measured.len();
        out.extend(measured);
        progress(done.min(total), total);
    }
    Ok(out)
}

// ---- commands ---------------------------------------------------------------------------------

/// A person's faces in pictures, oldest first (see `person_faces`); with
/// `min_px`, only faces at least that tall. (The window asks for all of them
/// so its "Smallest face" slider can count live without asking again.)
#[tauri::command]
pub async fn face_crops_list(state: State<'_, crate::Shared>, person: i64, min_px: Option<f32>) -> Result<Vec<PersonFace>, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let all = person_faces(&s.db(), person)?;
        Ok(match min_px {
            Some(m) => at_least(&all, m),
            None => all,
        })
    })
    .await
    .map_err(|x| x.to_string())?
}

/// Measure these faces (see `measure`); `job` names the run for progress and stopping.
#[tauri::command]
pub async fn face_crops_measure(app: AppHandle, state: State<'_, crate::Shared>, job: String, ids: Vec<i64>) -> Result<Vec<FaceMeasure>, String> {
    let s = crate::sess(&state)?;
    if let Some(set) = STOP.lock().unwrap_or_else(|x| x.into_inner()).as_mut() {
        set.remove(&job);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut t = crate::throttle::Throttle::new();
        measure(&s, &job, &ids, &mut |done, total| {
            if t.ready(done >= total) {
                let _ = app.emit("face-measure-progress", MeasureProgress { job: job.clone(), done, total });
            }
        })
    })
    .await
    .map_err(|x| x.to_string())?
}

/// Stop a measuring run (what was measured so far is kept for the session).
#[tauri::command]
pub fn face_crops_stop(job: String) {
    STOP.lock().unwrap_or_else(|x| x.into_inner()).get_or_insert_with(HashSet::new).insert(job);
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use vault_core::db;

    fn add(c: &Connection, kind: &str, taken: i64, height: i64) -> i64 {
        c.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, taken_at, width, height) \
             VALUES (lower(hex(randomblob(16))), NULL, ?1, 'p.jpg', 'jpg', 1, 'h', 100, ?2, 1000, ?3)",
            params![kind, taken, height],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    fn face(c: &Connection, media: i64, h: f64, person: Option<i64>, hidden: bool) -> i64 {
        c.execute(
            "INSERT INTO faces(media_id, frame_ms, x, y, w, h, score, descriptor, person_id, hidden) VALUES (?1, 0, 0.1, 0.1, ?2, ?2, 0.9, x'00', ?3, ?4)",
            params![media, h, person, hidden as i64],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    #[test]
    fn a_persons_faces_oldest_first_without_hidden_trashed_or_videos() {
        let c = db::create_empty().unwrap();
        let p = crate::library::create_folder(&c, None, "Ayşe").unwrap();
        let other = crate::library::create_folder(&c, None, "Mehmet").unwrap();
        let newer = add(&c, "image", 3000, 2000);
        let older = add(&c, "gif", 1000, 1000);
        let undated = add(&c, "image", 0, 500); // falls back to imported_at (100): the oldest
        let video = add(&c, "video", 500, 1000);
        let trashed = add(&c, "image", 50, 1000);
        c.execute("UPDATE media SET deleted_at = 1 WHERE id = ?", [trashed]).unwrap();
        let a = face(&c, newer, 0.2, Some(p), false);
        let b = face(&c, older, 0.1, Some(p), false);
        let u = face(&c, undated, 0.5, Some(p), false);
        face(&c, newer, 0.3, Some(p), true); // not important
        face(&c, newer, 0.3, Some(other), false);
        face(&c, newer, 0.3, None, false);
        face(&c, video, 0.3, Some(p), false);
        face(&c, trashed, 0.3, Some(p), false);
        let list = person_faces(&c, p).unwrap();
        assert_eq!(list.iter().map(|f| f.id).collect::<Vec<_>>(), vec![u, b, a]);
        assert_eq!(list.iter().map(|f| f.date).collect::<Vec<_>>(), vec![100, 1000, 3000]);
        // Face heights in the original's pixels: 0.5 × 500, 0.1 × 1000, 0.2 × 2000.
        assert_eq!(list.iter().map(|f| f.face_px.round() as i64).collect::<Vec<_>>(), vec![250, 100, 400]);
        // The smallest-face slider.
        assert_eq!(at_least(&list, 200.0).iter().map(|f| f.id).collect::<Vec<_>>(), vec![u, a]);
        assert_eq!(at_least(&list, 0.0).len(), 3);
        assert!(at_least(&list, 1000.0).is_empty());
        // A picture whose size isn't known yet is kept.
        let mut unknown = list[1].clone();
        unknown.height = 0;
        unknown.face_px = 0.0;
        assert_eq!(at_least(&[unknown], 1000.0).len(), 1);
        // Looked up by id for measuring: pictures only.
        let by_id = faces_by_id(&c, &[a, b, 999]).unwrap();
        assert_eq!(by_id.len(), 2);
    }

    #[test]
    fn straight_faces_score_higher_than_turned_ones() {
        // Eyes at (40, 50) and (80, 50), nose in the middle, mouth below.
        let straight = [[40.0, 50.0], [80.0, 50.0], [60.0, 72.0], [45.0, 90.0], [75.0, 90.0]];
        let f = frontness(&straight);
        assert!(f > 0.95, "{f}");
        // The same face turned in the picture (a tilted head) is still straight on.
        let turn = |p: [[f32; 2]; 5], a: f32| p.map(|[x, y]| [x * a.cos() - y * a.sin(), x * a.sin() + y * a.cos()]);
        assert!((frontness(&turn(straight, 0.6)) - f).abs() < 1e-4);
        // Nose and mouth towards one eye: the head is turned away.
        let half = [[40.0, 50.0], [80.0, 50.0], [74.0, 72.0], [55.0, 90.0], [82.0, 90.0]];
        let profile = [[40.0, 50.0], [80.0, 50.0], [84.0, 72.0], [70.0, 90.0], [86.0, 90.0]];
        assert!(frontness(&half) < f && frontness(&profile) < frontness(&half));
        assert!(frontness(&profile) < 0.35, "{}", frontness(&profile));
        // Nose right under the eyes: looking up a lot.
        let up = [[40.0, 50.0], [80.0, 50.0], [60.0, 53.0], [45.0, 90.0], [75.0, 90.0]];
        assert!(frontness(&up) < f);
        // Nonsense points don't break anything.
        assert_eq!(frontness(&[[1.0, 1.0]; 5]), 0.0);
    }

    #[test]
    fn scores_reward_big_sharp_straight_faces() {
        assert_eq!(size_part(20.0), 0.0);
        assert_eq!(size_part(800.0), 1.0);
        assert_eq!(size_part(5000.0), 1.0);
        assert!(size_part(100.0) < size_part(400.0));
        assert!((sharp_part(SHARP_HALF) - 0.5).abs() < 1e-6);
        assert_eq!(sharp_part(-5.0), 0.0);
        let best = score(800.0, 1e6, Some(1.0));
        assert!((best - 1.0).abs() < 1e-3, "{best}");
        assert!(score(400.0, 300.0, Some(0.9)) > score(400.0, 30.0, Some(0.9)), "sharper wins");
        assert!(score(400.0, 300.0, Some(0.9)) > score(100.0, 300.0, Some(0.9)), "bigger wins");
        assert!(score(400.0, 300.0, Some(0.9)) > score(400.0, 300.0, Some(0.2)), "straighter wins");
        // Without the faces pack, looking at the camera counts as half way.
        assert_eq!(score(400.0, 300.0, None), score(400.0, 300.0, Some(0.5)));
    }

    fn pic(w: usize, h: usize, f: impl Fn(usize, usize) -> u8) -> Rgb {
        let mut px = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let v = f(x, y);
                px.extend_from_slice(&[v, v, v]);
            }
        }
        Rgb { w, h, px: zeroize::Zeroizing::new(px) }
    }

    fn pf(id: i64, x: f32, y: f32, w: f32, h: f32, height: i64) -> PersonFace {
        PersonFace { id, media_id: 1, frame_ms: 0, x, y, w, h, date: 0, width: 0, height, face_px: h * height as f32 }
    }

    #[test]
    fn crops_stay_inside_the_picture() {
        let near = |r: (f64, f64, f64, f64), want: (f64, f64, f64, f64)| {
            let d = [(r.0 - want.0), (r.1 - want.1), (r.2 - want.2), (r.3 - want.3)];
            assert!(d.iter().all(|x| x.abs() < 1e-3), "{r:?} vs {want:?}");
        };
        near(crop_region(&pf(1, 0.0, 0.0, 0.2, 0.2, 100), 100, 100), (0.0, 0.0, 30.0, 30.0));
        near(crop_region(&pf(1, 0.9, 0.9, 0.1, 0.1, 100), 100, 100), (85.0, 85.0, 15.0, 15.0));
        near(crop_region(&pf(1, 0.4, 0.4, 0.2, 0.2, 100), 100, 100), (30.0, 30.0, 40.0, 40.0));
    }

    #[test]
    fn a_detailed_face_is_sharper_than_a_flat_one_and_points_map_back() {
        // Left half: a fine checkerboard; right half: flat grey.
        let p = pic(200, 100, |x, y| if x < 100 { if (x + y) % 2 == 0 { 220 } else { 30 } } else { 128 });
        let faces = [pf(1, 0.1, 0.2, 0.3, 0.6, 100), pf(2, 0.6, 0.2, 0.3, 0.6, 100)];
        // A pretend face finder: one face, its points in the middle of the crop.
        let mut calls = Vec::new();
        let mut points = |_: &[u8], w: usize, h: usize| -> Option<Vec<[[f32; 2]; 5]>> {
            calls.push((w, h));
            let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
            // A straight face: the nose half way between the eyes and 55% of the way down to the mouth.
            Some(vec![[[cx - 10.0, cy - 5.0], [cx + 10.0, cy - 5.0], [cx, cy + 3.25], [cx - 8.0, cy + 10.0], [cx + 8.0, cy + 10.0]]])
        };
        let m = measure_picture(&p, &faces, &mut points);
        assert_eq!(calls.len(), 2);
        assert!(m[0].sharp > 100.0 * m[1].sharp.max(1e-3), "{} vs {}", m[0].sharp, m[1].sharp);
        assert!(m[0].score > m[1].score);
        assert!(m[0].front.unwrap() > 0.95);
        assert!((m[0].face_px - 60.0).abs() < 1e-3);
        // The nose maps back into the picture: face 1's crop is x 0…110 (the
        // box and half of it again around, cut at the edge), y 0…100.
        let nose = m[0].points.unwrap()[2];
        assert!((nose[0] - 55.0 / 200.0).abs() < 0.01 && (nose[1] - 0.5325).abs() < 0.01, "{nose:?}");
        // Without the faces pack: no points, still a score.
        let none = measure_picture(&p, &faces[..1], &mut |_: &[u8], _: usize, _: usize| -> Option<Vec<[[f32; 2]; 5]>> { None });
        assert_eq!((none[0].points, none[0].front), (None, None));
        assert!(none[0].score > 0.0);
    }
}
