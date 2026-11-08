//! Playable copies of files received from the phone.
//!
//! The phone sends its originals as they are. Some are in formats the window
//! can't show (HEIC / HEIF / AVIF / BMP / TIFF pictures; MOV / MKV / 3GP / AVI
//! / TS … videos). Those originals are kept untouched as their own items (with
//! a calm "original from phone" tile instead of a thumbnail), and a playable
//! copy (a JPEG picture, an H.264 MP4 video) is made next to them, in the same
//! folder, with the same name and the new extension ("IMG_0001.HEIC" →
//! "IMG_0001.jpg").
//!
//! The copies are made by the app's video tool (videotool.rs): ffmpeg reads
//! the original from the tiny in-app 127.0.0.1 server and writes the result to
//! its output, which is stored encrypted. Nothing decrypted touches the disk.
//!
//! Which copy belongs to which original is remembered in the library's
//! settings table ("playable:<original id>" = copy id); `copy_for` also finds
//! a copy by name (same folder, same name with .jpg / .mp4) for originals
//! received before the copy was recorded.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{Connection, OptionalExtension, params};
use tauri::State;

use crate::import;
use crate::session::Session;
use crate::videotool::{self, ConvertRequest};
pub use crate::videotool::Target;

/// Phone picture formats the window can't show: a JPEG copy is made.
pub const PICTURE_EXT: &[&str] = &["heic", "heif", "hif", "avif", "bmp", "tif", "tiff"];
/// Phone / camera video formats the window can't play: an MP4 copy is made.
pub const VIDEO_EXT: &[&str] = &["mov", "mkv", "3gp", "3g2", "avi", "ts", "mts", "m2ts", "wmv", "flv", "mpg", "mpeg"];

/// Shown once when there is no video tool (no copies can be made).
pub const NO_TOOL: &str = "The video tool isn't installed, so no playable copies were made. The originals are kept.";

fn clean_ext(ext: &str) -> String {
    ext.trim().trim_start_matches('.').to_ascii_lowercase()
}

/// Does a received file with this extension (and stored kind: "image",
/// "video", or "" when not known yet) get a playable copy, and which?
pub fn needs_copy(ext: &str, kind: &str) -> Option<Target> {
    let e = clean_ext(ext);
    if PICTURE_EXT.contains(&e.as_str()) && matches!(kind, "image" | "") {
        Some(Target::Jpg)
    } else if VIDEO_EXT.contains(&e.as_str()) && matches!(kind, "video" | "") {
        Some(Target::Mp4)
    } else {
        None
    }
}

/// The kind a received file is stored as: what a normal import would use, or
/// "image" / "video" for the phone formats above. None: not taken at all.
#[allow(dead_code)] // for the receive code (transfer)
pub fn phone_kind(name: &str) -> Option<&'static str> {
    if let Some(k) = import::kind_by_ext(name) {
        return Some(k);
    }
    match needs_copy(&import::ext_of(name), "")? {
        Target::Jpg => Some("image"),
        _ => Some("video"),
    }
}

/// An original the window can't show: no thumbnail, preview clips, faces,
/// look-alike prints or smart-search analysis are tried for it (they would only
/// fail). The window draws a placeholder tile for it instead.
pub fn mark_unshowable(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE media SET thumb_object_id = IFNULL(thumb_object_id, ''), preview_object_id = IFNULL(preview_object_id, ''), \
         tiny_object_id = IFNULL(tiny_object_id, ''), \
         faces_state = CASE WHEN faces_state IN (0, 2) THEN 1 ELSE faces_state END, \
         faces_model = CASE WHEN faces_state IN (0, 2) THEN ?2 ELSE faces_model END, \
         phash_state = CASE WHEN phash_state = 0 THEN -1 ELSE phash_state END, \
         clip_state = CASE WHEN clip_state = 0 THEN -1 ELSE clip_state END \
         WHERE id = ?1",
        params![id, crate::faces::ARCFACE],
    )?;
    Ok(())
}

/// Store a file received from the phone as a new item (encrypted, from
/// memory). Phone formats the window can't show are stored as their own
/// item too (marked so background passes leave them alone); everything else
/// exactly as a normal import would. Returns the new item's id.
#[allow(dead_code)] // called by the receive code (transfer)
pub fn add_original(s: &Session, folder: Option<i64>, name: &str, bytes: &[u8]) -> Result<i64, String> {
    let ext = import::ext_of(name);
    let Some(target) = needs_copy(&ext, "") else {
        return import::add_bytes(s, folder, name, bytes);
    };
    let kind = if target == Target::Jpg { "image" } else { "video" };
    let id = import::add_bytes_as(s, folder, name, bytes, kind)?;
    mark_unshowable(&s.db(), id).map_err(|e| e.to_string())?;
    Ok(id)
}

fn link_key(original: i64) -> String {
    format!("playable:{original}")
}

/// The playable copy of `original` still in the library (not in the trash):
/// the one recorded when it was made, or one with the same name and the new
/// extension in the same folder.
pub fn copy_for(conn: &Connection, original: i64) -> rusqlite::Result<Option<i64>> {
    let row: Option<(Option<i64>, String, String, String)> = conn
        .query_row(
            "SELECT folder_id, original_name, ext, kind FROM media WHERE id = ?",
            [original],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((folder, name, ext, kind)) = row else { return Ok(None) };
    let Some(target) = needs_copy(&ext, &kind) else { return Ok(None) };
    let alive = |id: i64| -> rusqlite::Result<bool> {
        conn.query_row("SELECT 1 FROM media WHERE id = ? AND deleted_at IS NULL", [id], |_| Ok(())).optional().map(|x| x.is_some())
    };
    let linked: Option<String> =
        conn.query_row("SELECT value FROM settings WHERE key = ?", [link_key(original)], |r| r.get(0)).optional()?;
    if let Some(id) = linked.and_then(|v| v.parse::<i64>().ok())
        && id != original
        && alive(id)?
    {
        return Ok(Some(id));
    }
    let want = videotool::new_name(&name, target.ext());
    conn.query_row(
        "SELECT id FROM media WHERE IFNULL(folder_id, 0) = IFNULL(?1, 0) AND deleted_at IS NULL AND id <> ?2 \
         AND original_name = ?3 COLLATE NOCASE AND kind = ?4 ORDER BY id LIMIT 1",
        params![folder, original, want, if target == Target::Jpg { "image" } else { "video" }],
        |r| r.get(0),
    )
    .optional()
}

/// The copy gets what the original has (the date taken and tags come with
/// the video tool's copy already): favourite, weight, note, bookmarks. And
/// the link between them is recorded.
fn carry_over(conn: &Connection, original: i64, copy: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE media SET favourite = MAX(favourite, (SELECT favourite FROM media WHERE id = ?1)), \
         weight = CASE WHEN weight = 1 THEN (SELECT weight FROM media WHERE id = ?1) ELSE weight END, \
         note = IFNULL(note, (SELECT note FROM media WHERE id = ?1)) WHERE id = ?2",
        params![original, copy],
    )?;
    conn.execute(
        "INSERT INTO bookmarks(media_id, position_ms, note, created_at) SELECT ?2, position_ms, note, created_at \
         FROM bookmarks WHERE media_id = ?1 AND NOT EXISTS (SELECT 1 FROM bookmarks WHERE media_id = ?2)",
        params![original, copy],
    )?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![link_key(original), copy.to_string()],
    )?;
    Ok(())
}

/// Make playable copies of the received items `items` (media ids) that need
/// one, each next to its original. Items that need none, or already have
/// one, are passed over. Blocking (one ffmpeg run per item): call it from a
/// background thread. Stops soon after `cancel` is set or the vault locks.
///
/// Returns how many copies were made and what went wrong (name, why). No
/// video tool: no copies and a single entry saying so.
#[allow(dead_code)] // called by the receive code (transfer)
pub fn make_copies(s: &Arc<Session>, items: &[i64], cancel: &AtomicBool) -> (usize, Vec<(String, String)>) {
    let stop = || cancel.load(Ordering::SeqCst) || s.is_closed();
    let mut failed = Vec::new();
    if stop() {
        return (0, failed);
    }
    let todo: Vec<(i64, String, Target)> = {
        let db = s.db();
        items
            .iter()
            .filter_map(|&id| {
                let (name, ext, kind): (String, String, String) = db
                    .query_row("SELECT original_name, ext, kind FROM media WHERE id = ? AND deleted_at IS NULL", [id], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })
                    .ok()?;
                let target = needs_copy(&ext, &kind)?;
                // Made already (e.g. the same batch handed over twice).
                if copy_for(&db, id).ok().flatten().is_some() {
                    return None;
                }
                Some((id, name, target))
            })
            .collect()
    };
    if todo.is_empty() {
        return (0, failed);
    }
    let Some(tool) = videotool::tool_path() else {
        failed.push(("Playable copies".to_string(), NO_TOOL.to_string()));
        return (0, failed);
    };
    let mut made = 0;
    for (id, name, target) in todo {
        if stop() {
            break;
        }
        let req = ConvertRequest { ids: vec![id], target, replace: false };
        let done = videotool::run_convert(s, &tool, &req, cancel, &mut |_| {});
        if let Some(e) = done.error {
            // The tool itself couldn't start: the same for every item.
            failed.push(("Playable copies".to_string(), e));
            break;
        }
        if done.cancelled {
            break;
        }
        failed.extend(done.failed);
        if let Some(&copy) = done.created.first().filter(|&&c| c != id) {
            let r = carry_over(&s.db(), id, copy);
            match r {
                Ok(()) => {
                    s.mark_dirty();
                    made += 1;
                }
                Err(e) => failed.push((name, e.to_string())),
            }
        }
    }
    if !s.is_closed() && s.is_dirty() {
        let _ = s.save();
    }
    (made, failed)
}

/// The playable copy of an original received from the phone (the viewer's
/// "Open the playable copy" button). None: there is none (any more).
#[tauri::command]
pub(crate) async fn playable_copy(state: State<'_, crate::Shared>, id: i64) -> Result<Option<i64>, String> {
    crate::read_db(state.inner(), move |c| copy_for(c, id).map_err(|e| e.to_string())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{library, session};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use vault_core::{ObjectId, ObjectKind};

    #[test]
    fn which_files_get_a_copy() {
        for e in ["heic", "HEIC", ".heif", "hif", "avif", "bmp", "tif", "tiff"] {
            assert_eq!(needs_copy(e, "image"), Some(Target::Jpg), "{e}");
            assert_eq!(needs_copy(e, ""), Some(Target::Jpg), "{e}");
        }
        for e in ["mov", "MOV", "mkv", "3gp", "avi", "ts", "mts", "m2ts", "wmv", "flv", "mpg", "mpeg"] {
            assert_eq!(needs_copy(e, "video"), Some(Target::Mp4), "{e}");
        }
        for e in ["jpg", "jpeg", "png", "webp", "gif", "mp4", "m4v", "webm", "pdf", "txt", ""] {
            assert_eq!(needs_copy(e, "image"), None, "{e}");
            assert_eq!(needs_copy(e, "video"), None, "{e}");
        }
        // A kind that doesn't fit the extension: no copy.
        assert_eq!(needs_copy("heic", "video"), None);
        assert_eq!(needs_copy("mov", "image"), None);
        assert_eq!(needs_copy("mov", "pdf"), None);
    }

    #[test]
    fn kinds_for_received_files() {
        assert_eq!(phone_kind("IMG_1.HEIC"), Some("image"));
        assert_eq!(phone_kind("a.bmp"), Some("image"));
        assert_eq!(phone_kind("VID_1.mov"), Some("video"));
        assert_eq!(phone_kind("a.jpg"), Some("image"));
        assert_eq!(phone_kind("a.gif"), Some("gif"));
        assert_eq!(phone_kind("a.mp4"), Some("video"));
        assert_eq!(phone_kind("a.exe"), None);
        // A normal import still doesn't take these.
        assert_eq!(import::kind_by_ext("IMG_1.heic"), None);
        assert_eq!(import::kind_by_ext("VID_1.mov"), None);
    }

    fn vault(t: &tempfile::TempDir) -> Arc<Session> {
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        Arc::new(s)
    }

    fn states(s: &Session, id: i64) -> (Option<String>, Option<String>, Option<String>, i64, i64, i64) {
        s.db()
            .query_row(
                "SELECT thumb_object_id, preview_object_id, tiny_object_id, faces_state, phash_state, clip_state FROM media WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap()
    }

    #[test]
    fn originals_are_kept_and_left_alone_by_background_passes() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let folder = library::create_folder(&s.db(), None, "Received from phone").unwrap();
        let heic = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic not really".to_vec();
        let id = add_original(&s, Some(folder), "IMG_0001.HEIC", &heic).unwrap();
        let (kind, ext): (String, String) = s.db().query_row("SELECT kind, ext FROM media WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((kind.as_str(), ext.as_str()), ("image", "heic"));
        assert_eq!(states(&s, id), (Some(String::new()), Some(String::new()), Some(String::new()), 1, -1, -1));
        let oid: String = s.db().query_row("SELECT object_id FROM media WHERE id = ?", [id], |r| r.get(0)).unwrap();
        assert_eq!(s.vault().read_object(ObjectKind::Media, &ObjectId::from_hex(&oid).unwrap()).unwrap().to_vec(), heic, "kept as it was");
        // The window lists it with a failed thumbnail: no decoding attempts.
        assert_eq!(library::get_item(&s.db(), id).unwrap().thumb, "failed");

        let mov = add_original(&s, Some(folder), "VID_0002.mov", b"\0\0\0\x14ftypqt  not really").unwrap();
        assert_eq!(s.db().query_row("SELECT kind FROM media WHERE id = ?", [mov], |r| r.get::<_, String>(0)).unwrap(), "video");
        // A normal picture is a normal import (thumbnails etc. made as usual).
        let png = add_original(&s, Some(folder), "a.png", b"\x89PNG\r\n\x1a\n0000IHDRfake").unwrap();
        assert_eq!(states(&s, png), (None, None, None, 0, 0, 0));
        assert!(add_original(&s, Some(folder), "a.exe", b"MZ").is_err());
    }

    #[test]
    fn finds_the_copy_by_link_or_by_name() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let folder = library::create_folder(&s.db(), None, "Phone").unwrap();
        let other = library::create_folder(&s.db(), None, "Other").unwrap();
        let orig = add_original(&s, Some(folder), "IMG_0001.HEIC", b"heic one").unwrap();
        assert_eq!(copy_for(&s.db(), orig).unwrap(), None);
        // Same name in another folder, or another kind: not its copy.
        import::add_bytes(&s, Some(other), "IMG_0001.jpg", b"\xff\xd8\xff other").unwrap();
        import::add_bytes(&s, Some(folder), "IMG_0001.mp4", b"video").unwrap();
        assert_eq!(copy_for(&s.db(), orig).unwrap(), None);
        let by_name = import::add_bytes(&s, Some(folder), "img_0001.JPG", b"\xff\xd8\xff mine").unwrap();
        assert_eq!(copy_for(&s.db(), orig).unwrap(), Some(by_name));
        // A recorded link wins; one in the trash doesn't count.
        let linked = import::add_bytes(&s, Some(folder), "renamed.jpg", b"\xff\xd8\xff linked").unwrap();
        library::tag_items(&s.db(), &[orig], &["sea".into()]).unwrap();
        s.db().execute("UPDATE media SET favourite = 1, weight = 3 WHERE id = ?", [orig]).unwrap();
        s.db().execute("INSERT INTO bookmarks(media_id, position_ms, note, created_at) VALUES (?, 1500, 'here', 1)", [orig]).unwrap();
        carry_over(&s.db(), orig, linked).unwrap();
        assert_eq!(copy_for(&s.db(), orig).unwrap(), Some(linked));
        let (fav, w): (i64, f64) = s.db().query_row("SELECT favourite, weight FROM media WHERE id = ?", [linked], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((fav, w), (1, 3.0));
        let bm: i64 = s.db().query_row("SELECT COUNT(*) FROM bookmarks WHERE media_id = ?", [linked], |r| r.get(0)).unwrap();
        assert_eq!(bm, 1);
        library::trash_items(&s.db(), &[linked]).unwrap();
        assert_eq!(copy_for(&s.db(), orig).unwrap(), Some(by_name));
        // Not a phone original: no copy to look for.
        assert_eq!(copy_for(&s.db(), by_name).unwrap(), None);
        assert_eq!(copy_for(&s.db(), 999_999).unwrap(), None);
    }

    #[test]
    fn nothing_to_do_and_stopping() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let png = import::add_bytes(&s, None, "a.png", b"\x89PNG\r\n\x1a\n0000IHDRfake").unwrap();
        let heic = add_original(&s, None, "b.heic", b"heic").unwrap();
        // Nothing that needs a copy: no tool needed, nothing reported.
        assert_eq!(make_copies(&s, &[png, 12345], &AtomicBool::new(false)), (0, vec![]));
        // Stopped before it starts: nothing done, nothing reported.
        assert_eq!(make_copies(&s, &[heic], &AtomicBool::new(true)), (0, vec![]));
    }

    /// ffmpeg for tests: MV_FFMPEG, or the one on PATH. None = skip.
    fn test_tool() -> Option<PathBuf> {
        if let Some(p) = std::env::var_os("MV_FFMPEG") {
            let p = PathBuf::from(p);
            return p.is_file().then_some(p);
        }
        let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.is_file()))
    }

    /// Non-secret test media made by ffmpeg straight into memory.
    fn make(ffmpeg: &Path, args: &[&str]) -> Vec<u8> {
        let o = Command::new(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-loglevel", "error"])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        o.stdout
    }

    fn object(s: &Session, id: i64) -> Vec<u8> {
        let oid: String = s.db().query_row("SELECT object_id FROM media WHERE id = ?", [id], |r| r.get(0)).unwrap();
        s.vault().read_object(ObjectKind::Media, &ObjectId::from_hex(&oid).unwrap()).unwrap().to_vec()
    }

    /// Real conversions with the ffmpeg on this machine (skipped without one).
    /// ffmpeg is told where it is through MV_FFMPEG (as the app finds it).
    #[test]
    fn makes_real_copies_next_to_the_originals() {
        let Some(ff) = test_tool() else {
            eprintln!("no ffmpeg: skipped");
            return;
        };
        // SAFETY: tests that read MV_FFMPEG all want this same value.
        unsafe { std::env::set_var("MV_FFMPEG", &ff) };
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let folder = library::create_folder(&s.db(), None, "Received from phone").unwrap();
        let bmp = make(&ff, &["-f", "lavfi", "-i", "testsrc=size=64x48", "-frames:v", "1", "-c:v", "bmp", "-f", "image2pipe", "pipe:1"]);
        let tif = make(&ff, &["-f", "lavfi", "-i", "testsrc=size=33x21", "-frames:v", "1", "-c:v", "tiff", "-f", "image2pipe", "pipe:1"]);
        let mov = make(&ff, &[
            "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-f", "lavfi", "-i", "sine=duration=1",
            "-c:v", "mjpeg", "-c:a", "pcm_s16le", "-shortest", "-movflags", "frag_keyframe+empty_moov", "-f", "mov", "pipe:1",
        ]);
        let mkv = make(&ff, &["-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-c:v", "mpeg4", "-f", "matroska", "pipe:1"]);
        let a = add_original(&s, Some(folder), "IMG_0001.BMP", &bmp).unwrap();
        let b = add_original(&s, Some(folder), "scan.tiff", &tif).unwrap();
        let c = add_original(&s, Some(folder), "VID_0003.MOV", &mov).unwrap();
        let d = add_original(&s, Some(folder), "clip.mkv", &mkv).unwrap();
        let broken = add_original(&s, Some(folder), "IMG_0005.heic", b"\0\0\0\x18ftypheic not a picture").unwrap();
        s.db().execute("UPDATE media SET favourite = 1, taken_at = 1600000000 WHERE id = ?", [c]).unwrap();
        library::tag_items(&s.db(), &[c], &["trip".into()]).unwrap();

        let (made, failed) = make_copies(&s, &[a, b, c, d, broken], &AtomicBool::new(false));
        assert_eq!(made, 4, "{failed:?}");
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert_eq!(failed[0].0, "IMG_0005.heic");

        let copy = |id| copy_for(&s.db(), id).unwrap().expect("a copy");
        let row = |id: i64| -> (String, String, Option<i64>, i64, i64) {
            s.db()
                .query_row("SELECT original_name, kind, folder_id, favourite, taken_at FROM media WHERE id = ?", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .unwrap()
        };
        let (ca, cb, cc, cd) = (copy(a), copy(b), copy(c), copy(d));
        assert_eq!(row(ca).0, "IMG_0001.jpg");
        assert_eq!(row(cb).0, "scan.jpg");
        assert_eq!(row(cc), ("VID_0003.mp4".into(), "video".into(), Some(folder), 1, 1600000000));
        assert_eq!(row(cd).0, "clip.mp4");
        assert_eq!(library::item_tags(&s.db(), cc).unwrap().own, vec!["trip".to_string()]);
        assert!(object(&s, ca).starts_with(&[0xff, 0xd8, 0xff]), "a JPEG");
        assert!(object(&s, cb).starts_with(&[0xff, 0xd8, 0xff]), "a JPEG");
        assert_eq!(&object(&s, cc)[4..8], b"ftyp", "an MP4");
        assert_eq!(&object(&s, cd)[4..8], b"ftyp", "an MP4");
        // The originals are untouched and stay.
        assert_eq!(object(&s, a), bmp);
        assert_eq!(object(&s, c), mov);
        assert_eq!(row(a).0, "IMG_0001.BMP");
        // Asked again (the same batch twice): nothing new.
        assert_eq!(make_copies(&s, &[a, b, c, d], &AtomicBool::new(false)), (0, vec![]));
        let n: i64 = s.db().query_row("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 9);
    }
}
