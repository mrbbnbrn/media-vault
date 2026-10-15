//! "Save rotation" in the viewer: an item's stored file is replaced by a
//! rotated one, and the old file is kept so Ctrl+Z can put it back.
//!
//! - JPEG: lossless. Only the EXIF orientation is changed (or added); every
//!   picture byte stays as it is. The window, the thumbnailer, face finding
//!   and the upscaler all draw pictures the way their orientation says.
//! - PNG, WebP, GIF: the window draws the picture turned and encodes it again
//!   (PNG losslessly); the bytes arrive here ([`replace`]).
//! - Videos: only the rotation in the file is changed, without re-encoding
//!   (videotool.rs, `rotate_video`).
//!
//! Free copies share the stored file, so they turn with it (and their face
//! boxes turn too). The old file is listed as "retired" in the library; it
//! is removed when the vault is next opened (the undo list doesn't outlive
//! the session), or straight away the new one when the rotation is undone.
//! Nothing decrypted is written to disk.

use std::io::Read;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use vault_core::{ObjectId, ObjectKind};
use zeroize::Zeroizing;

use crate::import;
use crate::library::{self, Orphans};
use crate::session::Session;
use crate::stripmeta::{exif_orientation, minimal_exif};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

// ---- EXIF orientation -------------------------------------------------------------------------

/// An EXIF orientation (1–8) as (mirrored, clockwise quarter turns): the
/// stored picture is mirrored left–right first, then turned.
fn parts(o: u16) -> (bool, u8) {
    match o {
        2 => (true, 0),
        3 => (false, 2),
        4 => (true, 2),
        5 => (true, 3),
        6 => (false, 1),
        7 => (true, 1),
        8 => (false, 3),
        _ => (false, 0),
    }
}

fn from_parts(mirrored: bool, turns: u8) -> u16 {
    match (mirrored, turns % 4) {
        (false, 0) => 1,
        (false, 1) => 6,
        (false, 2) => 3,
        (false, 3) => 8,
        (true, 0) => 2,
        (true, 1) => 7,
        (true, 2) => 4,
        _ => 5,
    }
}

/// The orientation that shows a picture of orientation `o` turned a further
/// `quarter` clockwise quarter turns.
pub fn turned_orientation(o: u16, quarter: u8) -> u16 {
    let (m, r) = parts(o);
    from_parts(m, r + quarter % 4)
}

/// Where the first EXIF block says the orientation is.
enum Spot {
    /// The value's offset in the file, its byte order and size (2 = SHORT, 4 = LONG).
    Value { at: usize, big_endian: bool, size: usize, current: u16 },
    /// An EXIF block without an orientation starts here: a small one goes before it.
    Before(usize),
    /// No EXIF at all: one goes here (after the JFIF header, if any).
    Insert(usize),
}

fn find_orientation(d: &[u8]) -> Option<Spot> {
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    let mut insert_at = 2usize;
    let mut picture = false;
    while i + 4 <= d.len() {
        if d[i] != 0xFF {
            return None;
        }
        let mut j = i + 1;
        while j < d.len() && d[j] == 0xFF {
            j += 1;
        }
        let m = *d.get(j)?;
        if m == 0xD9 || m == 0xDA || (0xC0..=0xCF).contains(&m) && m != 0xC4 && m != 0xC8 && m != 0xCC {
            // Picture data starts: no EXIF before it.
            picture = true;
            break;
        }
        if m == 0x01 || (0xD0..=0xD7).contains(&m) {
            i = j + 1;
            continue;
        }
        let l = u16::from_be_bytes([*d.get(j + 1)?, *d.get(j + 2)?]) as usize;
        if l < 2 || j + 1 + l > d.len() {
            return None;
        }
        let start = j - 1;
        let payload = &d[j + 3..j + 1 + l];
        if m == 0xE0 && start == 2 && payload.starts_with(b"JFIF\0") {
            insert_at = j + 1 + l;
        }
        if m == 0xE1 && payload.starts_with(b"Exif\0\0") {
            let tiff_at = j + 3 + 6;
            let t = &d[tiff_at..j + 1 + l];
            return Some(match orientation_entry(t) {
                Some((off, be, size)) => Spot::Value { at: tiff_at + off, big_endian: be, size, current: exif_orientation(t).unwrap_or(1) },
                None => Spot::Before(start),
            });
        }
        i = j + 1 + l;
    }
    picture.then_some(Spot::Insert(insert_at))
}

/// The orientation value's place in a TIFF block: (offset, big-endian, size).
fn orientation_entry(t: &[u8]) -> Option<(usize, bool, usize)> {
    let be = match t.get(..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let u16_at = |o: usize| t.get(o..o + 2).map(|b| if be { u16::from_be_bytes([b[0], b[1]]) } else { u16::from_le_bytes([b[0], b[1]]) });
    let u32_at = |o: usize| {
        t.get(o..o + 4).map(|b| {
            let a = [b[0], b[1], b[2], b[3]];
            if be { u32::from_be_bytes(a) } else { u32::from_le_bytes(a) }
        })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let n = u16_at(ifd)? as usize;
    for k in 0..n.min(1024) {
        let entry = ifd + 2 + k * 12;
        if u16_at(entry)? == 0x0112 {
            return match (u16_at(entry + 2)?, u32_at(entry + 4)?) {
                (3, 1) => t.get(entry + 8..entry + 10).map(|_| (entry + 8, be, 2)),
                (4, 1) => t.get(entry + 8..entry + 12).map(|_| (entry + 8, be, 4)),
                _ => None,
            };
        }
    }
    None
}

/// A JPEG shown `quarter` clockwise quarter turns further, losslessly: the
/// EXIF orientation is changed in place (same length), or a small EXIF block
/// with just the orientation is added. None if it isn't a JPEG.
pub fn turn_jpeg(d: &[u8], quarter: u8) -> Option<Vec<u8>> {
    let spot = find_orientation(d)?;
    let mut out = d.to_vec();
    match spot {
        Spot::Value { at, big_endian, size, current } => {
            let v = turned_orientation(current, quarter);
            let bytes: Vec<u8> = match (size, big_endian) {
                (2, true) => v.to_be_bytes().to_vec(),
                (2, false) => v.to_le_bytes().to_vec(),
                (_, true) => (v as u32).to_be_bytes().to_vec(),
                (_, false) => (v as u32).to_le_bytes().to_vec(),
            };
            out[at..at + bytes.len()].copy_from_slice(&bytes);
        }
        Spot::Before(at) | Spot::Insert(at) => {
            let v = turned_orientation(1, quarter);
            out.splice(at..at, minimal_exif(v));
        }
    }
    Some(out)
}

/// The orientation a JPEG is shown with (1 when it has none).
#[cfg(test)]
pub fn jpeg_orientation(d: &[u8]) -> Option<u16> {
    match find_orientation(d)? {
        Spot::Value { current, .. } => Some(current),
        _ => Some(1),
    }
}

pub fn is_jpeg(d: &[u8]) -> bool {
    d.starts_with(&[0xFF, 0xD8, 0xFF])
}

/// The new file is what this kind of item should hold.
fn looks_like(ext: &str, d: &[u8]) -> bool {
    match ext {
        "jpg" | "jpeg" | "jpe" | "jfif" => is_jpeg(d),
        "png" | "apng" => d.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        "webp" => d.len() >= 12 && &d[..4] == b"RIFF" && &d[8..12] == b"WEBP",
        "gif" => d.starts_with(b"GIF87a") || d.starts_with(b"GIF89a"),
        "mp4" | "m4v" | "mov" => d.len() >= 8 && (&d[4..8] == b"ftyp" || &d[4..8] == b"moov" || &d[4..8] == b"free"),
        _ => false,
    }
}

// ---- replacing the stored file -----------------------------------------------------------------

/// What a saved rotation changed, so it can be undone.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Turned {
    pub item: i64,
    /// Clockwise quarter turns that were saved.
    pub quarter: u8,
    /// Other items (free copies, not in the trash) that share the file and turned too.
    pub copies: usize,
    /// No picture data was re-encoded (JPEG orientation, video rotation).
    pub lossless: bool,
    pub old_object: String,
    pub new_object: String,
    pub old_thumb: Option<String>,
    pub old_preview: Option<String>,
    pub old_size: i64,
    pub old_sha: String,
    pub old_width: Option<i64>,
    pub old_height: Option<i64>,
    /// The size now (turned).
    pub width: Option<i64>,
    pub height: Option<i64>,
}

struct Current {
    object: String,
    thumb: Option<String>,
    preview: Option<String>,
    size: i64,
    sha: String,
    width: Option<i64>,
    height: Option<i64>,
    ext: String,
}

fn current(conn: &Connection, item: i64) -> Result<Current, String> {
    conn.query_row(
        "SELECT object_id, thumb_object_id, preview_object_id, size, sha256, width, height, ext FROM media WHERE id = ? AND deleted_at IS NULL",
        [item],
        |r| {
            Ok(Current {
                object: r.get(0)?,
                thumb: r.get(1)?,
                preview: r.get(2)?,
                size: r.get(3)?,
                sha: r.get(4)?,
                width: r.get(5)?,
                height: r.get(6)?,
                ext: r.get::<_, String>(7)?.to_ascii_lowercase(),
            })
        },
    )
    .optional()
    .map_err(e)?
    .ok_or_else(|| "It's no longer in the library.".to_string())
}

/// The item's stored file, decrypted in memory.
pub fn read_item(s: &Session, item: i64) -> Result<Zeroizing<Vec<u8>>, String> {
    let obj = current(&s.db(), item)?.object;
    let id = ObjectId::from_hex(&obj).map_err(|x| x.to_string())?;
    let mut r = s.vault().open_object(ObjectKind::Media, &id).map_err(|x| x.to_string())?;
    let mut out = Zeroizing::new(Vec::new());
    r.read_to_end(&mut out).map_err(|x| x.to_string())?;
    Ok(out)
}

/// The item's extension (lower case).
pub fn item_ext(s: &Session, item: i64) -> Result<String, String> {
    Ok(current(&s.db(), item)?.ext)
}

/// Face boxes (parts of the picture) turned `quarter` clockwise quarter turns.
fn turn_faces(conn: &Connection, ids: &[i64], quarter: u8) -> Result<(), String> {
    let sql = match quarter % 4 {
        1 => "UPDATE faces SET x = 1.0 - y - h, y = x, w = h, h = w WHERE media_id = ?",
        2 => "UPDATE faces SET x = 1.0 - x - w, y = 1.0 - y - h WHERE media_id = ?",
        3 => "UPDATE faces SET x = y, y = 1.0 - x - w, w = h, h = w WHERE media_id = ?",
        _ => return Ok(()),
    };
    for id in ids {
        conn.execute(sql, [id]).map_err(e)?;
    }
    Ok(())
}

/// After the picture changed: look-alike fingerprint and smart search again,
/// and faces looked for again (when they were looked for before).
fn analyse_again(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    for &id in ids {
        crate::similar::reset(conn, id)?;
        crate::clip::reset(conn, id)?;
        conn.execute("UPDATE media SET faces_state = 2 WHERE id = ? AND faces_state <> 0", [id]).map_err(e)?;
    }
    Ok(())
}

const RETIRED: &str = "rotate:retired";

fn retired(conn: &Connection) -> Result<Orphans, String> {
    let v: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = ?", [RETIRED], |r| r.get(0)).optional().map_err(e)?;
    let (media, thumbs): (Vec<String>, Vec<String>) = v.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
    Ok(Orphans { media, thumbs })
}

fn set_retired(conn: &Connection, o: &Orphans) -> Result<(), String> {
    if o.media.is_empty() && o.thumbs.is_empty() {
        conn.execute("DELETE FROM settings WHERE key = ?", [RETIRED]).map_err(e)?;
        return Ok(());
    }
    let v = serde_json::to_string(&(&o.media, &o.thumbs)).map_err(|x| x.to_string())?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![RETIRED, v],
    )
    .map_err(e)?;
    Ok(())
}

fn some(x: &Option<String>) -> Option<String> {
    x.clone().filter(|x| !x.is_empty())
}

fn ids_with(conn: &Connection, object: &str) -> Result<Vec<i64>, String> {
    conn.prepare("SELECT id FROM media WHERE object_id = ? ORDER BY id")
        .map_err(e)?
        .query_map([object], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)
}

/// Store `bytes` (the item turned `quarter` clockwise quarter turns) in place
/// of the item's file, for it and every free copy sharing that file. The old
/// file is kept for [`undo`].
pub fn replace(s: &Session, item: i64, bytes: &[u8], quarter: u8, lossless: bool) -> Result<Turned, String> {
    let quarter = quarter % 4;
    if quarter == 0 {
        return Err("It isn't rotated, so there's nothing to save.".into());
    }
    let cur = current(&s.db(), item)?;
    if !looks_like(&cur.ext, bytes) {
        return Err("The rotated file didn't come out right, so nothing was changed.".into());
    }
    let (oid, written) = s.vault().add_object(ObjectKind::Media, bytes).map_err(|x| x.to_string())?;
    let new = oid.to_hex();
    let (w, h) = if quarter % 2 == 1 { (cur.height, cur.width) } else { (cur.width, cur.height) };
    let copies = {
        let db = s.db();
        let tx = db.unchecked_transaction().map_err(e)?;
        let ids = ids_with(&tx, &cur.object)?;
        tx.execute(
            "UPDATE media SET object_id = ?1, size = ?2, sha256 = ?3, width = ?4, height = ?5, \
             thumb_object_id = NULL, preview_object_id = NULL, sketch = NULL WHERE object_id = ?6",
            params![new, written.plaintext_len as i64, written.sha256_hex, w, h, cur.object],
        )
        .map_err(e)?;
        turn_faces(&tx, &ids, quarter)?;
        analyse_again(&tx, &ids)?;
        let mut keep = retired(&tx)?;
        keep.media.push(cur.object.clone());
        keep.thumbs.extend(some(&cur.thumb));
        keep.thumbs.extend(some(&cur.preview));
        set_retired(&tx, &keep)?;
        let copies: i64 = tx
            .query_row("SELECT COUNT(*) FROM media WHERE object_id = ? AND id <> ? AND deleted_at IS NULL", params![new, item], |r| r.get(0))
            .map_err(e)?;
        tx.commit().map_err(e)?;
        copies as usize
    };
    s.mark_dirty();
    s.save()?;
    Ok(Turned {
        item,
        quarter,
        copies,
        lossless,
        old_object: cur.object,
        new_object: new,
        old_thumb: cur.thumb,
        old_preview: cur.preview,
        old_size: cur.size,
        old_sha: cur.sha,
        old_width: cur.width,
        old_height: cur.height,
        width: w,
        height: h,
    })
}

/// Put the old file back (Ctrl+Z). The rotated file is removed.
pub fn undo(s: &Session, t: &Turned) -> Result<(), String> {
    let orphans = {
        let db = s.db();
        let mut keep = retired(&db)?;
        if !keep.media.contains(&t.old_object) {
            return Err("The file from before is no longer there, so this can't be undone.".into());
        }
        let ids = ids_with(&db, &t.new_object)?;
        if ids.is_empty() {
            return Err("It has changed since, so this can't be undone.".into());
        }
        // What was made for the rotated file goes.
        let mut gone = Orphans { media: vec![t.new_object.clone()], thumbs: Vec::new() };
        {
            let mut st = db.prepare("SELECT thumb_object_id, preview_object_id FROM media WHERE object_id = ?").map_err(e)?;
            let rows = st.query_map([&t.new_object], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))).map_err(e)?;
            for row in rows {
                let (a, b) = row.map_err(e)?;
                gone.thumbs.extend(some(&a));
                gone.thumbs.extend(some(&b));
            }
        }
        let tx = db.unchecked_transaction().map_err(e)?;
        tx.execute(
            "UPDATE media SET object_id = ?1, size = ?2, sha256 = ?3, width = ?4, height = ?5, \
             thumb_object_id = ?6, preview_object_id = ?7, sketch = NULL WHERE object_id = ?8",
            params![t.old_object, t.old_size, t.old_sha, t.old_width, t.old_height, t.old_thumb, t.old_preview, t.new_object],
        )
        .map_err(e)?;
        turn_faces(&tx, &ids, (4 - t.quarter % 4) % 4)?;
        analyse_again(&tx, &ids)?;
        let back: Vec<String> = [Some(t.old_object.clone()), some(&t.old_thumb), some(&t.old_preview)].into_iter().flatten().collect();
        keep.media.retain(|x| !back.contains(x));
        keep.thumbs.retain(|x| !back.contains(x));
        set_retired(&tx, &keep)?;
        tx.commit().map_err(e)?;
        library::unused_only(&db, gone)?
    };
    s.mark_dirty();
    s.save()?;
    import::remove_objects(s, &orphans);
    Ok(())
}

/// When a vault opens: files kept for undoing rotations of an earlier session go.
pub fn clean_retired(s: &Session) -> Result<usize, String> {
    let orphans = {
        let db = s.db();
        let keep = retired(&db)?;
        if keep.media.is_empty() && keep.thumbs.is_empty() {
            return Ok(0);
        }
        set_retired(&db, &Orphans::default())?;
        library::unused_only(&db, keep)?
    };
    s.mark_dirty();
    s.save()?;
    import::remove_objects(s, &orphans);
    Ok(orphans.media.len())
}

/// Save a JPEG's rotation losslessly (its EXIF orientation).
pub fn turn_jpeg_item(s: &Session, item: i64, quarter: u8) -> Result<Turned, String> {
    let data = read_item(s, item)?;
    if !is_jpeg(&data) {
        return Err("This picture isn't really a JPEG, so its rotation can't be saved this way.".into());
    }
    let out = Zeroizing::new(turn_jpeg(&data, quarter).ok_or("This JPEG couldn't be read, so nothing was changed.")?);
    drop(data);
    replace(s, item, &out, quarter, true)
}

/// Pictures re-encoded by the window (PNG, WebP, GIF): 4 bytes (little-endian)
/// of JSON length, the request as JSON, then the new file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub item_id: i64,
    pub quarter: u8,
    #[serde(default)]
    pub lossless: bool,
}

pub fn split_body(body: &[u8]) -> Result<(ReplaceRequest, &[u8]), String> {
    let bad = || "The rotated picture didn't arrive whole.".to_string();
    let n = u32::from_le_bytes(body.get(..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?) as usize;
    let json = body.get(4..4 + n).ok_or_else(bad)?;
    let req: ReplaceRequest = serde_json::from_slice(json).map_err(|x| x.to_string())?;
    Ok((req, &body[4 + n..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    type Grid = Vec<Vec<u32>>;

    /// A W×H picture whose every pixel is different.
    fn grid(w: usize, h: usize) -> Grid {
        (0..h).map(|y| (0..w).map(|x| (y * w + x) as u32).collect()).collect()
    }

    /// How a viewer shows stored pixels with EXIF orientation `o`, written
    /// straight from the EXIF table (independently of `parts`).
    fn show(o: u16, g: &Grid) -> Grid {
        let (h, w) = (g.len(), g[0].len());
        let swapped = o >= 5;
        let (ow, oh) = if swapped { (h, w) } else { (w, h) };
        let mut out = vec![vec![0; ow]; oh];
        for (v, row) in g.iter().enumerate() {
            for (u, &px) in row.iter().enumerate() {
                let (x, y) = match o {
                    1 => (u, v),
                    2 => (w - 1 - u, v),
                    3 => (w - 1 - u, h - 1 - v),
                    4 => (u, h - 1 - v),
                    5 => (v, u),
                    6 => (h - 1 - v, u),
                    7 => (h - 1 - v, w - 1 - u),
                    8 => (v, w - 1 - u),
                    _ => unreachable!(),
                };
                out[y][x] = px;
            }
        }
        out
    }

    /// Turn a shown picture a quarter clockwise.
    fn cw(g: &Grid) -> Grid {
        let (h, w) = (g.len(), g[0].len());
        (0..w).map(|y| (0..h).map(|x| g[h - 1 - x][y]).collect()).collect()
    }

    #[test]
    fn all_eight_orientations_compose_with_quarter_turns() {
        let g = grid(4, 3);
        for o in 1..=8u16 {
            let mut expect = show(o, &g);
            for q in 0..8u8 {
                assert_eq!(show(turned_orientation(o, q), &g), expect, "orientation {o} turned {q}");
                expect = cw(&expect);
            }
            // Four quarter turns are no turn; right then left cancels.
            assert_eq!(turned_orientation(o, 4), o);
            assert_eq!(turned_orientation(turned_orientation(o, 1), 3), o);
        }
        assert_eq!(turned_orientation(1, 1), 6);
        assert_eq!(turned_orientation(1, 3), 8);
        assert_eq!(turned_orientation(6, 1), 3);
        // Unknown values count as upright.
        assert_eq!(turned_orientation(0, 1), 6);
        assert_eq!(turned_orientation(9, 2), 3);
    }

    fn base_jpeg() -> Vec<u8> {
        let img = image::RgbImage::from_fn(16, 8, |x, y| image::Rgb([(x * 15) as u8, (y * 30) as u8, 90]));
        let mut v = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut v, 90).encode_image(&img).unwrap();
        v
    }

    fn seg(marker: u8, payload: &[u8]) -> Vec<u8> {
        let mut s = vec![0xFF, marker];
        s.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        s.extend_from_slice(payload);
        s
    }

    /// EXIF with a Make entry and, if given, an orientation.
    fn exif(orientation: Option<u16>, big_endian: bool) -> Vec<u8> {
        let w16 = |v: u16| if big_endian { v.to_be_bytes() } else { v.to_le_bytes() };
        let w32 = |v: u32| if big_endian { v.to_be_bytes() } else { v.to_le_bytes() };
        let mut t = if big_endian { b"MM".to_vec() } else { b"II".to_vec() };
        t.extend_from_slice(&w16(42));
        t.extend_from_slice(&w32(8));
        let n: u16 = if orientation.is_some() { 2 } else { 1 };
        t.extend_from_slice(&w16(n));
        let data_at = 8 + 2 + 12 * n as u32 + 4;
        t.extend_from_slice(&w16(0x010F));
        t.extend_from_slice(&w16(2));
        t.extend_from_slice(&w32(6));
        t.extend_from_slice(&w32(data_at));
        if let Some(o) = orientation {
            t.extend_from_slice(&w16(0x0112));
            t.extend_from_slice(&w16(3));
            t.extend_from_slice(&w32(1));
            t.extend_from_slice(&w16(o));
            t.extend_from_slice(&[0, 0]);
        }
        t.extend_from_slice(&[0, 0, 0, 0]);
        t.extend_from_slice(b"Canon\0");
        let mut p = b"Exif\0\0".to_vec();
        p.extend_from_slice(&t);
        p
    }

    fn with_exif(payload: &[u8]) -> Vec<u8> {
        let base = base_jpeg();
        let app0_end = 4 + u16::from_be_bytes([base[4], base[5]]) as usize;
        let mut v = base[..app0_end].to_vec();
        v.extend(seg(0xE1, payload));
        v.extend_from_slice(&base[app0_end..]);
        v
    }

    fn decodes(d: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory_with_format(d, image::ImageFormat::Jpeg).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn jpeg_orientation_is_changed_in_place() {
        for be in [false, true] {
            for o in 1..=8u16 {
                let src = with_exif(&exif(Some(o), be));
                for q in 1..4u8 {
                    let out = turn_jpeg(&src, q).unwrap();
                    assert_eq!(out.len(), src.len(), "same length");
                    let diff = src.iter().zip(&out).filter(|(a, b)| a != b).count();
                    assert!(diff <= 1, "only the orientation value changes ({diff} bytes)");
                    assert_eq!(jpeg_orientation(&out), Some(turned_orientation(o, q)));
                    assert_eq!(decodes(&out), (16, 8), "the picture itself is untouched");
                }
            }
        }
    }

    #[test]
    fn jpeg_without_orientation_gets_one() {
        // No EXIF at all: a small one after the JFIF header.
        let plain = base_jpeg();
        assert_eq!(jpeg_orientation(&plain), Some(1));
        let out = turn_jpeg(&plain, 1).unwrap();
        assert_eq!(jpeg_orientation(&out), Some(6));
        assert_eq!(&out[2..4], &[0xFF, 0xE0], "JFIF stays first");
        assert_eq!(decodes(&out), (16, 8));
        // Turning again changes that one in place.
        let again = turn_jpeg(&out, 1).unwrap();
        assert_eq!((again.len(), jpeg_orientation(&again)), (out.len(), Some(3)));

        // EXIF without an orientation: the small one goes first (readers use the first EXIF), the camera's stays.
        let cam = with_exif(&exif(None, false));
        let out = turn_jpeg(&cam, 3).unwrap();
        assert_eq!(jpeg_orientation(&out), Some(8));
        assert!(out.windows(6).any(|w| w == b"Canon\0"));
        assert_eq!(decodes(&out), (16, 8));
        // Export with camera info removed keeps the orientation.
        let clean = crate::stripmeta::clean_jpeg(&out).unwrap();
        assert_eq!(jpeg_orientation(&clean), Some(8));
        assert!(!clean.windows(6).any(|w| w == b"Canon\0"));

        assert!(turn_jpeg(b"not a jpeg", 1).is_none());
        assert!(turn_jpeg(&[0xFF, 0xD8, 0xFF, 0xE1, 0xFF], 1).is_none());
    }

    fn vault(t: &tempfile::TempDir) -> Session {
        crate::session::create(t.path().to_str().unwrap(), "v", "correct horse battery", vault_core::KdfParams::TEST_ONLY).unwrap().0
    }

    fn object_of(s: &Session, id: i64) -> String {
        s.db().query_row("SELECT object_id FROM media WHERE id = ?", [id], |r| r.get(0)).unwrap()
    }

    /// Still stored (a deleted object's space in a pack is only freed later, so look at the index).
    fn kept(s: &Session, kind: ObjectKind, hex: &str) -> bool {
        let id = ObjectId::from_hex(hex).unwrap();
        let v = s.vault();
        v.is_packed(&id) || (v.loose_objects(kind).unwrap().contains(&id) && v.open_object(kind, &id).is_ok())
    }

    fn exists(s: &Session, hex: &str) -> bool {
        kept(s, ObjectKind::Media, hex)
    }

    fn thumb_exists(s: &Session, hex: &str) -> bool {
        kept(s, ObjectKind::Thumbnail, hex)
    }

    fn face(s: &Session, id: i64) -> (f64, f64, f64, f64) {
        s.db().query_row("SELECT x, y, w, h FROM faces WHERE media_id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
    }

    fn close(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
        (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6 && (a.2 - b.2).abs() < 1e-6 && (a.3 - b.3).abs() < 1e-6
    }

    /// A JPEG item 16×8 with a thumbnail, a face and a fingerprint.
    fn picture(s: &Session) -> (i64, String) {
        let id = import::add_bytes(s, None, "Beach.jpg", &with_exif(&exif(Some(1), false))).unwrap();
        let (thumb, _) = s.vault().add_object(ObjectKind::Thumbnail, &b"thumb bytes"[..]).unwrap();
        let db = s.db();
        db.execute(
            "UPDATE media SET width = 16, height = 8, thumb_object_id = ?1, phash = 'abc', phash_state = 1, faces_state = 1, clip_state = 1 WHERE id = ?2",
            params![thumb.to_hex(), id],
        )
        .unwrap();
        db.execute(
            "INSERT INTO faces(media_id, frame_ms, x, y, w, h, score, descriptor, model) VALUES (?, 0, 0.1, 0.2, 0.3, 0.4, 0.9, x'00', 0)",
            [id],
        )
        .unwrap();
        (id, thumb.to_hex())
    }

    #[test]
    fn saved_rotation_can_be_undone_and_the_old_file_comes_back() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let (id, thumb) = picture(&s);
        let before = object_of(&s, id);
        let original = read_item(&s, id).unwrap().to_vec();

        let turned = turn_jpeg_item(&s, id, 1).unwrap();
        assert!(turned.lossless);
        assert_eq!((turned.copies, turned.old_object.clone()), (0, before.clone()));
        assert_eq!(object_of(&s, id), turned.new_object);
        assert_eq!(jpeg_orientation(&read_item(&s, id).unwrap()), Some(6));
        // Turned size, thumbnail to make again, analysis again, the face box turned.
        let (w, h, th, ph, fs): (i64, i64, Option<String>, i64, i64) = s
            .db()
            .query_row("SELECT width, height, thumb_object_id, phash_state, faces_state FROM media WHERE id = ?", [id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap();
        assert_eq!((w, h, th, ph, fs), (8, 16, None, 0, 2));
        assert!(close(face(&s, id), (1.0 - 0.2 - 0.4, 0.1, 0.4, 0.3)));
        // The old file and thumbnail are kept for undo.
        assert!(exists(&s, &before) && thumb_exists(&s, &thumb));

        // The thumbnailer makes a new thumbnail meanwhile.
        let (t2, _) = s.vault().add_object(ObjectKind::Thumbnail, &b"turned thumb"[..]).unwrap();
        s.db().execute("UPDATE media SET thumb_object_id = ? WHERE id = ?", params![t2.to_hex(), id]).unwrap();

        undo(&s, &turned).unwrap();
        assert_eq!(object_of(&s, id), before);
        assert_eq!(read_item(&s, id).unwrap().to_vec(), original);
        let (w, h, th): (i64, i64, Option<String>) =
            s.db().query_row("SELECT width, height, thumb_object_id FROM media WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((w, h, th), (16, 8, Some(thumb.clone())));
        assert!(close(face(&s, id), (0.1, 0.2, 0.3, 0.4)));
        // The rotated file and its thumbnail are gone; nothing is left retired.
        assert!(!exists(&s, &turned.new_object));
        assert!(!thumb_exists(&s, &t2.to_hex()));
        assert_eq!(retired(&s.db()).unwrap(), Orphans::default());
        // Once is enough.
        assert!(undo(&s, &turned).is_err());
    }

    #[test]
    fn old_files_go_when_the_vault_opens_again() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let (id, thumb) = picture(&s);
        let first = turn_jpeg_item(&s, id, 1).unwrap();
        let second = turn_jpeg_item(&s, id, 1).unwrap();
        assert_eq!(second.old_object, first.new_object);
        assert_eq!(jpeg_orientation(&read_item(&s, id).unwrap()), Some(3));
        // Undo in order works through both.
        undo(&s, &second).unwrap();
        assert_eq!(object_of(&s, id), first.new_object);
        let third = turn_jpeg_item(&s, id, 2).unwrap();
        // Next session: the undo list is gone, so are the files kept for it.
        assert_eq!(clean_retired(&s).unwrap(), 2);
        assert!(!exists(&s, &first.old_object) && !exists(&s, &first.new_object));
        assert!(!thumb_exists(&s, &thumb));
        assert!(exists(&s, &third.new_object));
        assert_eq!(jpeg_orientation(&read_item(&s, id).unwrap()), Some(8));
        assert!(undo(&s, &third).is_err(), "too late to undo");
        assert_eq!(clean_retired(&s).unwrap(), 0);
    }

    #[test]
    fn free_copies_turn_with_the_file_they_share() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let (id, _) = picture(&s);
        let f = library::create_folder(&s.db(), None, "Holiday").unwrap();
        let copy = crate::organize::free_copy(&s.db(), &[id], Some(f)).unwrap()[0];
        let before = object_of(&s, id);
        // Turning the copy turns the original too (one file, one picture).
        let turned = turn_jpeg_item(&s, copy, 3).unwrap();
        assert_eq!(turned.copies, 1);
        assert_eq!(object_of(&s, id), turned.new_object);
        assert_eq!(object_of(&s, copy), turned.new_object);
        assert!(close(face(&s, id), face(&s, copy)));
        assert!(close(face(&s, copy), (0.2, 1.0 - 0.1 - 0.3, 0.4, 0.3)));
        let it = library::get_item(&s.db(), id).unwrap();
        assert_eq!((it.width, it.height), (Some(8), Some(16)));
        // Still linked, still a free copy.
        assert_eq!(library::get_item(&s.db(), copy).unwrap().copy_of, Some(id));
        // A copy in the trash comes back turned too, and undo restores all of them.
        library::trash_items(&s.db(), &[copy]).unwrap();
        undo(&s, &turned).unwrap();
        assert_eq!(object_of(&s, id), before);
        assert_eq!(object_of(&s, copy), before);
        assert!(close(face(&s, copy), (0.1, 0.2, 0.3, 0.4)));
    }

    #[test]
    fn replaced_bytes_must_match_the_kind() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let png = {
            let mut v = Vec::new();
            image::RgbImage::new(3, 2).write_to(&mut std::io::Cursor::new(&mut v), image::ImageFormat::Png).unwrap();
            v
        };
        let id = import::add_bytes(&s, None, "a.png", &png).unwrap();
        assert!(replace(&s, id, b"GIF89a....", 1, false).is_err());
        assert!(replace(&s, id, &png, 0, false).is_err());
        let r = replace(&s, id, &png, 2, false).unwrap();
        assert!(!r.lossless);
        assert!(turn_jpeg_item(&s, id, 1).is_err(), "a PNG isn't turned as a JPEG");
        // The window's body: length, JSON, file.
        let json = br#"{"itemId":7,"quarter":3}"#;
        let mut body = (json.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(json);
        body.extend_from_slice(b"GIF89a");
        let (req, file) = split_body(&body).unwrap();
        assert_eq!((req.item_id, req.quarter, req.lossless, file), (7, 3, false, &b"GIF89a"[..]));
        assert!(split_body(&body[..6]).is_err());
    }
}
