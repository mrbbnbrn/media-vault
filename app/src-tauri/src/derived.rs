//! Saved depth maps and subject outlines: what the depth and subject outline
//! models made for a still picture, kept inside the vault so it needn't be
//! made again (the models take seconds; reading this back takes milliseconds).
//!
//! Each one is stored exactly as the estimate commands return it (width u32
//! LE, height u32 LE, one byte per pixel) as an encrypted object kept with the
//! thumbnails, one per item, kind ('depth' or 'outline') and model, in the
//! library's `derived` table (schema v18). Nothing decrypted touches the disk.
//!
//! Only still pictures (kind image) have them. They are derived data: deleting
//! an item for good (or emptying the trash) removes its saved maps with its
//! other files (library.rs), Settings can clear them all, and a picture that
//! was rotated (it has a new file) no longer counts its old maps.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::State;
use vault_core::{ObjectId, ObjectKind};
use zeroize::Zeroizing;

use crate::session::Session;

/// The kinds of saved map.
pub const KINDS: [&str; 2] = ["depth", "outline"];
/// Biggest map accepted (the estimate commands give at most 2048 × 2048).
const MAX_SIDE: u32 = 4096;

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

fn check_kind(kind: &str) -> Result<(), String> {
    if KINDS.contains(&kind) { Ok(()) } else { Err("Only depth maps and outlines can be saved.".into()) }
}

/// A model id as the packs use them: a short name of a-z, 0-9 and "-".
fn check_model(model: &str) -> Result<(), String> {
    if model.len() <= 40 && model.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        Ok(())
    } else {
        Err("That isn't a model name.".into())
    }
}

/// The map as the estimate commands give it: 8 bytes of size, then one byte per pixel.
fn check_map(bytes: &[u8]) -> Result<(), String> {
    let bad = || "The map didn't arrive whole.".to_string();
    let w = u32::from_le_bytes(bytes.get(..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?);
    let h = u32::from_le_bytes(bytes.get(4..8).ok_or_else(bad)?.try_into().map_err(|_| bad())?);
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE || bytes.len() as u64 != 8 + w as u64 * h as u64 {
        return Err(bad());
    }
    Ok(())
}

/// The item's stored file, when it is a still picture (else why not).
fn picture_source(conn: &Connection, item: i64) -> Result<String, String> {
    let row: Option<(String, String)> =
        conn.query_row("SELECT kind, object_id FROM media WHERE id = ?", [item], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?;
    match row {
        None => Err("That item isn't there any more.".into()),
        Some((kind, _)) if kind != "image" => Err("Only still pictures keep depth maps and outlines.".into()),
        Some((_, source)) => Ok(source),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Save (or replace) an item's map of this kind made by this model.
pub fn put(s: &Session, item: i64, kind: &str, model: &str, bytes: &[u8]) -> Result<(), String> {
    check_kind(kind)?;
    check_model(model)?;
    check_map(bytes)?;
    picture_source(&s.db(), item)?;
    let (oid, _) = s.vault().add_object(ObjectKind::Thumbnail, bytes).map_err(|x| x.to_string())?;
    let stored = (|| -> Result<Option<String>, String> {
        let db = s.db();
        // Looked at again now that the object is written (the item may have gone meanwhile).
        let source = picture_source(&db, item)?;
        let old: Option<String> = db
            .query_row("SELECT object_id FROM derived WHERE media_id = ?1 AND kind = ?2 AND model = ?3", params![item, kind, model], |r| r.get(0))
            .optional()
            .map_err(e)?;
        db.execute(
            "INSERT OR REPLACE INTO derived(media_id, kind, model, object_id, source, bytes, made_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![item, kind, model, oid.to_hex(), source, bytes.len() as i64, now_ms()],
        )
        .map_err(e)?;
        Ok(old)
    })();
    match stored {
        Ok(old) => {
            if let Some(id) = old.and_then(|o| ObjectId::from_hex(&o).ok()) {
                let _ = s.vault().delete_object(ObjectKind::Thumbnail, &id);
            }
            s.mark_dirty();
            Ok(())
        }
        Err(err) => {
            let _ = s.vault().delete_object(ObjectKind::Thumbnail, &oid);
            Err(err)
        }
    }
}

/// An item's saved map of this kind made by this model, exactly as it was
/// saved (None: nothing saved, or saved for the picture before it was rotated).
pub fn get(s: &Session, item: i64, kind: &str, model: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    check_kind(kind)?;
    check_model(model)?;
    let hex: Option<String> = s
        .db()
        .query_row(
            "SELECT d.object_id FROM derived d JOIN media m ON m.id = d.media_id \
             WHERE d.media_id = ?1 AND d.kind = ?2 AND d.model = ?3 AND d.source = m.object_id",
            params![item, kind, model],
            |r| r.get(0),
        )
        .optional()
        .map_err(e)?;
    let Some(id) = hex.and_then(|h| ObjectId::from_hex(&h).ok()) else {
        return Ok(None);
    };
    // A map that can't be read (damaged) counts as not saved: it is simply made again.
    Ok(s.vault().read_object(ObjectKind::Thumbnail, &id).ok().filter(|b| check_map(b).is_ok()))
}

/// Remove every saved map (of one kind, or all); how many there were.
pub fn clear(s: &Session, kind: Option<&str>) -> Result<u64, String> {
    if let Some(k) = kind {
        check_kind(k)?;
    }
    let ids: Vec<String> = {
        let db = s.db();
        let ids: Vec<String> = db
            .prepare("SELECT object_id FROM derived WHERE ?1 IS NULL OR kind = ?1")
            .map_err(e)?
            .query_map([kind], |r| r.get(0))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        db.execute("DELETE FROM derived WHERE ?1 IS NULL OR kind = ?1", [kind]).map_err(e)?;
        ids
    };
    if ids.is_empty() {
        return Ok(0);
    }
    // Saved first, then the files go (a crash can't leave rows pointing at nothing).
    s.mark_dirty();
    s.save()?;
    let v = s.vault();
    for id in ids.iter().filter_map(|h| ObjectId::from_hex(h).ok()) {
        let _ = v.delete_object(ObjectKind::Thumbnail, &id);
    }
    Ok(ids.len() as u64)
}

/// How many maps are saved and the space they take.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedStats {
    pub depth_count: u64,
    pub depth_bytes: u64,
    pub outline_count: u64,
    pub outline_bytes: u64,
}

pub fn stats(conn: &Connection) -> Result<DerivedStats, String> {
    let mut out = DerivedStats::default();
    let mut st = conn.prepare("SELECT kind, COUNT(*), IFNULL(SUM(bytes), 0) FROM derived GROUP BY kind").map_err(e)?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))).map_err(e)?;
    for row in rows {
        let (kind, n, bytes) = row.map_err(e)?;
        match kind.as_str() {
            "depth" => (out.depth_count, out.depth_bytes) = (n as u64, bytes as u64),
            "outline" => (out.outline_count, out.outline_bytes) = (n as u64, bytes as u64),
            _ => {}
        }
    }
    Ok(out)
}

// ---- commands -------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PutArgs {
    item: i64,
    kind: String,
    #[serde(default)]
    model: String,
}

/// An item's saved map (raw bytes, as `depth_estimate` / `subject_estimate` gave
/// it); an empty body when nothing is saved.
#[tauri::command]
pub async fn derived_get(state: State<'_, crate::Shared>, item: i64, kind: String, model: String) -> Result<tauri::ipc::Response, String> {
    let s = crate::sess(&state)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || get(&s, item, &kind, &model)).await.map_err(|x| x.to_string())??;
    Ok(tauri::ipc::Response::new(bytes.map(|b| b.to_vec()).unwrap_or_default()))
}

/// Save a map. Raw body: 4 bytes JSON length (LE), {item, kind, model}, then the
/// map exactly as the estimate command returned it.
#[tauri::command]
pub async fn derived_put(state: State<'_, crate::Shared>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let s = crate::sess(&state)?;
    let (args, bytes): (PutArgs, &[u8]) = crate::binbody::request(&request)?;
    let bytes = Zeroizing::new(bytes.to_vec());
    tauri::async_runtime::spawn_blocking(move || put(&s, args.item, &args.kind, &args.model, &bytes)).await.map_err(|x| x.to_string())?
}

/// Remove the saved maps (of one kind: "depth" or "outline"; none = all). Returns how many.
#[tauri::command]
pub async fn derived_clear(state: State<'_, crate::Shared>, kind: Option<String>) -> Result<u64, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || clear(&s, kind.as_deref())).await.map_err(|x| x.to_string())?
}

/// How many maps are saved and the space they take (Settings).
#[tauri::command]
pub async fn derived_stats(state: State<'_, crate::Shared>) -> Result<DerivedStats, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || stats(&s.db())).await.map_err(|x| x.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library;

    fn vault(t: &std::path::Path) -> Session {
        crate::session::create(t.to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap().0
    }

    /// An item of this kind with a stored file; its id.
    fn item(s: &Session, kind: &str) -> i64 {
        let (oid, _) = s.vault().add_object(ObjectKind::Media, &b"not really a file"[..]).unwrap();
        s.db()
            .execute(
                "INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES (?1, ?2, 'a', 'jpg', 17, 'h', 0)",
                params![oid.to_hex(), kind],
            )
            .unwrap();
        s.db().last_insert_rowid()
    }

    fn map(w: u32, h: u32, fill: u8) -> Vec<u8> {
        let mut b = w.to_le_bytes().to_vec();
        b.extend_from_slice(&h.to_le_bytes());
        b.extend(std::iter::repeat_n(fill, (w * h) as usize));
        b
    }

    fn thumbs(s: &Session) -> usize {
        s.vault().list_objects(ObjectKind::Thumbnail).unwrap().len()
    }

    #[test]
    fn maps_are_saved_read_back_replaced_and_counted() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let a = item(&s, "image");
        let b = item(&s, "image");
        assert!(get(&s, a, "depth", "v2-small").unwrap().is_none(), "nothing saved yet");
        put(&s, a, "depth", "v2-small", &map(4, 3, 7)).unwrap();
        put(&s, a, "outline", "birefnet", &map(5, 5, 255)).unwrap();
        put(&s, a, "depth", "da3-mono-large", &map(2, 2, 1)).unwrap();
        put(&s, b, "depth", "v2-small", &map(1, 1, 9)).unwrap();
        assert!(s.is_dirty());
        assert_eq!(&get(&s, a, "depth", "v2-small").unwrap().unwrap()[..], &map(4, 3, 7)[..], "exactly as saved");
        assert_eq!(&get(&s, a, "outline", "birefnet").unwrap().unwrap()[..], &map(5, 5, 255)[..]);
        assert!(get(&s, a, "outline", "birefnet-lite").unwrap().is_none(), "kept per model");
        assert_eq!(thumbs(&s), 4);
        // Replacing one removes the old object.
        put(&s, a, "depth", "v2-small", &map(4, 3, 8)).unwrap();
        assert_eq!(get(&s, a, "depth", "v2-small").unwrap().unwrap()[8], 8);
        assert_eq!(thumbs(&s), 4);
        assert_eq!(
            stats(&s.db()).unwrap(),
            DerivedStats { depth_count: 3, depth_bytes: (8 + 12) + (8 + 4) + (8 + 1), outline_count: 1, outline_bytes: 8 + 25 }
        );
        let j = serde_json::to_value(stats(&s.db()).unwrap()).unwrap();
        for k in ["depthCount", "depthBytes", "outlineCount", "outlineBytes"] {
            assert!(j.get(k).is_some(), "{k}");
        }
        // Survives saving and opening the vault again.
        s.save().unwrap();
        let path = s.vault().root().display().to_string();
        drop(s);
        let s = crate::session::unlock(&path, "long enough pw").unwrap();
        assert_eq!(&get(&s, b, "depth", "v2-small").unwrap().unwrap()[..], &map(1, 1, 9)[..]);
        // Clearing one kind, then the rest.
        assert_eq!(clear(&s, Some("outline")).unwrap(), 1);
        assert!(get(&s, a, "outline", "birefnet").unwrap().is_none());
        assert_eq!(thumbs(&s), 3);
        assert_eq!(clear(&s, None).unwrap(), 3);
        assert_eq!((stats(&s.db()).unwrap(), thumbs(&s)), (DerivedStats::default(), 0));
        assert_eq!(clear(&s, None).unwrap(), 0);
        assert!(clear(&s, Some("thumbs")).is_err());
    }

    #[test]
    fn only_still_pictures_and_whole_maps_are_kept() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let pic = item(&s, "image");
        for kind in ["gif", "video", "text", "pdf"] {
            let other = item(&s, kind);
            let err = put(&s, other, "depth", "v2-small", &map(2, 2, 0)).unwrap_err();
            assert!(err.contains("still pictures"), "{kind}: {err}");
        }
        assert!(put(&s, 9999, "depth", "v2-small", &map(2, 2, 0)).is_err(), "no such item");
        assert!(put(&s, pic, "height", "v2-small", &map(2, 2, 0)).is_err(), "unknown kind");
        assert!(put(&s, pic, "depth", "..\\evil", &map(2, 2, 0)).is_err(), "odd model name");
        assert!(get(&s, pic, "depth", "A B").is_err());
        let mut short = map(3, 3, 0);
        short.pop();
        assert!(put(&s, pic, "depth", "v2-small", &short).is_err(), "a byte missing");
        assert!(put(&s, pic, "depth", "v2-small", &map(0, 0, 0)).is_err());
        assert!(put(&s, pic, "depth", "v2-small", &[1, 0, 0]).is_err());
        assert!(put(&s, pic, "depth", "v2-small", &map(5000, 1, 0)).is_err(), "silly size");
        assert_eq!(thumbs(&s), 0, "nothing refused was stored");
        assert_eq!(stats(&s.db()).unwrap(), DerivedStats::default());
    }

    #[test]
    fn a_new_file_for_the_picture_makes_its_old_maps_not_count() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let pic = item(&s, "image");
        put(&s, pic, "depth", "v2-small", &map(2, 2, 3)).unwrap();
        // As a rotation does: the item now has another stored file.
        s.db().execute("UPDATE media SET object_id = 'rotated' WHERE id = ?", [pic]).unwrap();
        assert!(get(&s, pic, "depth", "v2-small").unwrap().is_none());
        // Saved again for the new file: counts again (and the old object is gone).
        put(&s, pic, "depth", "v2-small", &map(2, 2, 4)).unwrap();
        assert_eq!(get(&s, pic, "depth", "v2-small").unwrap().unwrap()[8], 4);
        assert_eq!(thumbs(&s), 1);
    }

    #[test]
    fn deleting_for_good_and_emptying_the_trash_remove_saved_maps() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let a = item(&s, "image");
        let b = item(&s, "image");
        let c = item(&s, "image");
        for id in [a, b, c] {
            put(&s, id, "depth", "v2-small", &map(2, 2, 1)).unwrap();
            put(&s, id, "outline", "birefnet", &map(2, 2, 255)).unwrap();
        }
        assert_eq!(thumbs(&s), 6);
        // In the trash: still kept (it can come back).
        library::trash_items(&s.db(), &[a, b]).unwrap();
        assert_eq!(stats(&s.db()).unwrap().depth_count, 3);
        // Deleted for good: its rows and its objects go.
        let o = library::delete_forever(&s.db(), &[a]).unwrap();
        assert_eq!(o.thumbs.len(), 2, "{o:?}");
        crate::import::remove_objects(&s, &o);
        assert_eq!((stats(&s.db()).unwrap().depth_count, thumbs(&s)), (2, 4));
        assert!(get(&s, a, "depth", "v2-small").unwrap().is_none());
        // Emptying the trash: the same.
        let o = library::empty_trash(&s.db()).unwrap();
        crate::import::remove_objects(&s, &o);
        assert_eq!((stats(&s.db()).unwrap().depth_count, thumbs(&s)), (1, 2));
        assert!(get(&s, c, "outline", "birefnet").unwrap().is_some(), "the item not deleted keeps its maps");
    }
}
