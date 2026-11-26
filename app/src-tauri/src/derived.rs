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
//!
//! Videos and GIFs keep prepared 3D (kind "track", video3d.ts): an index
//! ("MV3I", model `<tag>.i`) and the frames' 3D data in pieces ("MV3S", model
//! `<tag>.s<n>`), where the tag names the models and settings they were made
//! with. Counted and deleted per tag, apart from the pictures' maps.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::State;
use vault_core::{ObjectId, ObjectKind};
use zeroize::Zeroizing;

use crate::session::Session;

/// The kinds of saved map: depth maps and outlines (one byte per pixel), and
/// the 3D picture layers made from them (plate.ts): Layered 3D's background
/// plate ("plate") and the subject's own layer ("fore"), kept as what differs
/// from the picture itself, packed (layerpack.ts; starts with "MVL1").
/// "track": a video's or GIF's prepared 3D (see above).
pub const KINDS: [&str; 5] = ["depth", "outline", "plate", "fore", "track"];
/// `clear` with this: every kind of still pictures, not the videos' and GIFs' tracks.
pub const PICTURE_KINDS: &str = "pictures";
/// A packed layer at most (a 1600 px plate is a few MB at worst).
const MAX_LAYER: usize = 64 << 20;
/// Biggest map accepted (the estimate commands give at most 2048 × 2048).
const MAX_SIDE: u32 = 4096;

use crate::util::sql_err as e;

fn check_kind(kind: &str) -> Result<(), String> {
    if KINDS.contains(&kind) { Ok(()) } else { Err("Only depth maps, outlines and 3D layers can be saved.".into()) }
}

/// A model id as the packs use them: a short name of a-z, 0-9 and "-".
fn check_model(model: &str) -> Result<(), String> {
    // As the window names them: model, size and softness, e.g. `da3-mono-large@518~0.5`;
    // layers join what they were made from with "_" (`…@518~1_birefnet@1024_e0.70_lama`).
    let ok = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '@' | '~' | '.' | '_');
    if !model.is_empty() && model.len() <= 160 && model.chars().all(ok) {
        Ok(())
    } else {
        Err("That isn't a model name.".into())
    }
}

/// What is saved, by kind: a map (as the estimate commands give it) or a packed layer.
fn check_data(kind: &str, bytes: &[u8]) -> Result<(), String> {
    if kind == "track" {
        return if bytes.len() >= 8 && bytes.len() <= MAX_LAYER && (bytes.starts_with(b"MV3S") || bytes.starts_with(b"MV3I")) {
            Ok(())
        } else {
            Err("The prepared 3D didn't arrive whole.".into())
        };
    }
    if kind == "plate" || kind == "fore" {
        return if bytes.len() >= 16 && bytes.len() <= MAX_LAYER && bytes.starts_with(b"MVL1") {
            Ok(())
        } else {
            Err("The 3D layer didn't arrive whole.".into())
        };
    }
    check_map(bytes)
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

/// The item's stored file, when it can keep this kind (pictures: maps and layers;
/// videos and GIFs: tracks), else why not.
fn picture_source(conn: &Connection, item: i64, what: &str) -> Result<String, String> {
    let row: Option<(String, String)> =
        conn.query_row("SELECT kind, object_id FROM media WHERE id = ?", [item], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?;
    match row {
        None => Err("That item isn't there any more.".into()),
        Some((kind, _)) if what == "track" && kind != "video" && kind != "gif" => Err("Only videos and GIFs keep prepared 3D.".into()),
        Some((kind, _)) if what != "track" && kind != "image" => Err("Only still pictures keep depth maps and outlines.".into()),
        Some((_, source)) => Ok(source),
    }
}

/// A track's tag: its model name without the piece (`<tag>.i`, `<tag>.s12` → `<tag>`).
pub fn track_tag(model: &str) -> &str {
    model.rsplit_once('.').map(|(t, _)| t).unwrap_or(model)
}

use crate::util::now_ms;

/// Save (or replace) an item's map of this kind made by this model.
pub fn put(s: &Session, item: i64, kind: &str, model: &str, bytes: &[u8]) -> Result<(), String> {
    check_kind(kind)?;
    check_model(model)?;
    check_data(kind, bytes)?;
    picture_source(&s.db(), item, kind)?;
    let (oid, _) = s.vault().add_object(ObjectKind::Thumbnail, bytes).map_err(|x| x.to_string())?;
    let stored = (|| -> Result<Option<String>, String> {
        let db = s.db();
        // Looked at again now that the object is written (the item may have gone meanwhile).
        let source = picture_source(&db, item, kind)?;
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
            s.mark_dirty_bg(); // made again at any time
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
    Ok(s.vault().read_object(ObjectKind::Thumbnail, &id).ok().filter(|b| check_data(kind, b).is_ok()))
}

/// Remove every saved map (of one kind, of all the pictures' kinds with
/// `PICTURE_KINDS`, or everything); how many there were.
pub fn clear(s: &Session, kind: Option<&str>) -> Result<u64, String> {
    let (which, args): (&str, Vec<String>) = match kind {
        None => ("1 = 1", vec![]),
        Some(PICTURE_KINDS) => ("kind <> 'track'", vec![]),
        Some(k) => {
            check_kind(k)?;
            ("kind = ?1", vec![k.to_string()])
        }
    };
    let ids: Vec<String> = {
        let db = s.db();
        let ids: Vec<String> = db
            .prepare(&format!("SELECT object_id FROM derived WHERE {which}"))
            .map_err(e)?
            .query_map(rusqlite::params_from_iter(args.iter()), |r| r.get(0))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        db.execute(&format!("DELETE FROM derived WHERE {which}"), rusqlite::params_from_iter(args.iter())).map_err(e)?;
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

// ---- More layers, removed 2026-11-27 ---------------------------------------------------------------

/// Set (to the number deleted) once the saved More layers of this library were deleted.
pub const MORE_LAYERS_GONE: &str = "cleanup:morelayers-2026-11";

/// Whether a saved plate's tag is one of More layers' layers (the look was
/// removed 2026-11-27 at the user's request). Shape (looklayers.ts, all three
/// generations: no suffix, `r2`, `r3`):
/// `<model>@<side>~<soft>_<outline@side | nomask>_e<edges>_m<3|4><s|m|b>_<fill>_l<n><key>[r2|r3]_<j>`.
/// Layered 3D / Lift-off (`<depth>_<outline>_e<edges>[_<fill>]`) and Border
/// fill (`<depth>_b<size>_<fill>`) never have the `_m<d><s|m|b>_…_l<d>…_<d>` tail.
/// The window has the same test (derived.ts `isMoreLayersTag`).
pub fn is_more_layers_tag(tag: &str) -> bool {
    // The depth tag first: `<model>@<digits>~<digits and dots>_`.
    let Some((model, rest)) = tag.split_once('@') else { return false };
    if model.is_empty() {
        return false;
    }
    let Some((side, rest)) = rest.split_once('~') else { return false };
    if side.is_empty() || !side.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let Some((soft, rest)) = rest.split_once('_') else { return false };
    if soft.is_empty() || !soft.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return false;
    }
    // From the end: `_<j>` (one digit), then `_l<n><key>`, `_<fill>`, `_m<max><cut>`, and `<outline>_e<edges>`.
    let parts: Vec<&str> = rest.rsplitn(5, '_').collect();
    let [j, l, fill, m, head] = parts[..] else { return false };
    if j.len() != 1 || !j.as_bytes()[0].is_ascii_digit() {
        return false;
    }
    let lb = l.as_bytes();
    if lb.len() < 2 || lb[0] != b'l' || !lb[1].is_ascii_digit() || !lb[2..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        return false;
    }
    if fill.is_empty() || !fill.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return false;
    }
    let mb = m.as_bytes();
    if mb.len() != 3 || mb[0] != b'm' || !mb[1].is_ascii_digit() || !matches!(mb[2], b's' | b'm' | b'b') {
        return false;
    }
    // The outline is a subject tag or "nomask" (never empty).
    let Some((outline, edges)) = head.rsplit_once("_e") else { return false };
    !outline.is_empty() && !edges.is_empty() && edges.bytes().all(|b| b.is_ascii_digit() || b == b'.')
}

/// Delete every saved More layers layer (rows first and the library saved,
/// then their encrypted objects, like `clear`); how many went. Other plates
/// (Layered 3D, Lift-off, Border fill) stay.
pub fn clear_more_layers(s: &Session) -> Result<u64, String> {
    let rows: Vec<(i64, String, String)> = {
        let db = s.db();
        let mut st = db.prepare("SELECT media_id, model, object_id FROM derived WHERE kind = 'plate'").map_err(e)?;
        let all: Vec<(i64, String, String)> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        all.into_iter().filter(|(_, model, _)| is_more_layers_tag(model)).collect()
    };
    if rows.is_empty() {
        return Ok(0);
    }
    let gone: Vec<String> = {
        let db = s.db();
        let tx = db.unchecked_transaction().map_err(e)?;
        for (item, model, _) in &rows {
            tx.execute("DELETE FROM derived WHERE media_id = ?1 AND kind = 'plate' AND model = ?2", params![item, model]).map_err(e)?;
        }
        // Only objects nothing else points at any more.
        let mut gone = Vec::new();
        for (_, _, oid) in &rows {
            let used: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM derived WHERE object_id = ?1) OR EXISTS(SELECT 1 FROM media WHERE object_id = ?1)",
                    [oid],
                    |r| r.get(0),
                )
                .map_err(e)?;
            if !used {
                gone.push(oid.clone());
            }
        }
        tx.commit().map_err(e)?;
        gone
    };
    // Saved first, then the files go (a crash can't leave rows pointing at nothing).
    s.mark_dirty();
    s.save()?;
    let v = s.vault();
    for id in gone.iter().filter_map(|h| ObjectId::from_hex(h).ok()) {
        let _ = v.delete_object(ObjectKind::Thumbnail, &id);
    }
    Ok(rows.len() as u64)
}

/// Once per library, after unlocking: More layers' saved layers are deleted
/// (the user asked for that when the look was removed). Marked done in the
/// library's settings (`MORE_LAYERS_GONE`); Some(count) when it ran now, None
/// when it was done before.
pub fn clear_more_layers_once(s: &Session) -> Result<Option<u64>, String> {
    let done: bool = s
        .db()
        .query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)", [MORE_LAYERS_GONE], |r| r.get(0))
        .map_err(e)?;
    if done {
        return Ok(None);
    }
    let n = clear_more_layers(s)?;
    s.db()
        .execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![MORE_LAYERS_GONE, n.to_string()],
        )
        .map_err(e)?;
    s.mark_dirty_bg();
    Ok(Some(n))
}

/// What is saved for some items, per kind and model (a model saved at other
/// settings is another line: its name carries the size and softening).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedGroup {
    pub kind: String,
    pub model: String,
    /// Pictures with a map of this kind and model.
    pub count: u64,
    pub bytes: u64,
}

/// Item ids in groups small enough for one statement.
const CHUNK: usize = 500;

use crate::util::placeholders as in_list;

/// What is saved for these items, by kind and model (kinds in order, then models by name).
/// Tracks are one line per tag (all its pieces), counting videos and GIFs.
pub fn summary(conn: &Connection, items: &[i64]) -> Result<Vec<DerivedGroup>, String> {
    let mut acc: std::collections::BTreeMap<(String, String), (u64, u64)> = std::collections::BTreeMap::new();
    let mut tracks: std::collections::BTreeMap<String, (std::collections::HashSet<i64>, u64)> = std::collections::BTreeMap::new();
    for part in items.chunks(CHUNK) {
        let mut st = conn
            .prepare(&format!("SELECT kind, model, COUNT(*), IFNULL(SUM(bytes), 0) FROM derived WHERE kind <> 'track' AND media_id IN ({}) GROUP BY kind, model", in_list(part.len())))
            .map_err(e)?;
        let rows = st
            .query_map(rusqlite::params_from_iter(part.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)))
            .map_err(e)?;
        for row in rows {
            let (kind, model, n, b) = row.map_err(e)?;
            let a = acc.entry((kind, model)).or_default();
            a.0 += n as u64;
            a.1 += b as u64;
        }
        let mut st = conn
            .prepare(&format!("SELECT model, media_id, bytes FROM derived WHERE kind = 'track' AND media_id IN ({})", in_list(part.len())))
            .map_err(e)?;
        let rows = st
            .query_map(rusqlite::params_from_iter(part.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
            .map_err(e)?;
        for row in rows {
            let (model, item, b) = row.map_err(e)?;
            let a = tracks.entry(track_tag(&model).to_string()).or_default();
            a.0.insert(item);
            a.1 += b as u64;
        }
    }
    for (tag, (its, bytes)) in tracks {
        acc.insert(("track".to_string(), tag), (its.len() as u64, bytes));
    }
    let mut out: Vec<DerivedGroup> = acc.into_iter().map(|((kind, model), (count, bytes))| DerivedGroup { kind, model, count, bytes }).collect();
    out.sort_by_key(|g| (KINDS.iter().position(|k| *k == g.kind).unwrap_or(9), g.model.clone()));
    Ok(out)
}

/// Remove these items' saved maps of the chosen kinds and models; how many maps went.
/// For tracks the model is the tag (as `summary` gives it): all its pieces go.
/// Saved before the encrypted objects are removed (a crash can't leave rows pointing at nothing).
pub fn remove(s: &Session, items: &[i64], which: &[(String, String)]) -> Result<u64, String> {
    for (k, m) in which {
        check_kind(k)?;
        check_model(m)?;
    }
    if items.is_empty() || which.is_empty() {
        return Ok(0);
    }
    let mut gone: Vec<String> = Vec::new();
    {
        let db = s.db();
        let tx = db.unchecked_transaction().map_err(e)?;
        for (k, m) in which {
            for part in items.chunks(CHUNK) {
                let mut args: Vec<rusqlite::types::Value> = vec![k.clone().into(), m.clone().into()];
                args.extend(part.iter().map(|i| rusqlite::types::Value::Integer(*i)));
                let same = if k == "track" { "substr(model, 1, length(?2) + 1) = ?2 || '.'" } else { "model = ?2" };
                let w = format!("kind = ?1 AND {same} AND media_id IN ({})", (3..3 + part.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(","));
                {
                    let mut st = tx.prepare(&format!("SELECT object_id FROM derived WHERE {w}")).map_err(e)?;
                    for r in st.query_map(rusqlite::params_from_iter(args.iter()), |r| r.get::<_, String>(0)).map_err(e)? {
                        gone.push(r.map_err(e)?);
                    }
                }
                tx.execute(&format!("DELETE FROM derived WHERE {w}"), rusqlite::params_from_iter(args.iter())).map_err(e)?;
            }
        }
        tx.commit().map_err(e)?;
    }
    if gone.is_empty() {
        return Ok(0);
    }
    s.mark_dirty();
    s.save()?;
    let v = s.vault();
    for id in gone.iter().filter_map(|h| ObjectId::from_hex(h).ok()) {
        let _ = v.delete_object(ObjectKind::Thumbnail, &id);
    }
    Ok(gone.len() as u64)
}

/// Pictures sorted by what the face scan found (for "only pictures with
/// faces" and "only pictures without faces"). A hidden face still counts as
/// a face; a poor face (Settings → Faces) doesn't count as a good one.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceSplit {
    /// At least one face that isn't poor (or is hidden).
    pub with_faces: Vec<i64>,
    /// Scanned, and no face at all.
    pub no_faces: Vec<i64>,
    /// Scanned, and only poor faces.
    pub only_poor: Vec<i64>,
    /// Not scanned for faces (yet), or the scan failed: never counted as faceless.
    pub unscanned: Vec<i64>,
}

pub fn face_split(conn: &Connection, items: &[i64]) -> Result<FaceSplit, String> {
    let mut out = FaceSplit::default();
    let good = format!("(f.hidden <> 0 OR NOT {})", crate::poorfaces::poor_sql("f"));
    for part in items.chunks(CHUNK) {
        let sql = format!(
            "SELECT m.id, m.faces_state, \
             (SELECT COUNT(*) FROM faces f WHERE f.media_id = m.id), \
             (SELECT COUNT(*) FROM faces f WHERE f.media_id = m.id AND {good}) \
             FROM media m WHERE m.id IN ({})",
            in_list(part.len())
        );
        let mut st = conn.prepare(&sql).map_err(e)?;
        let rows = st
            .query_map(rusqlite::params_from_iter(part.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)))
            .map_err(e)?;
        for row in rows {
            let (id, state, all, ok) = row.map_err(e)?;
            if ok > 0 {
                out.with_faces.push(id);
            } else if state != 1 {
                out.unscanned.push(id);
            } else if all == 0 {
                out.no_faces.push(id);
            } else {
                out.only_poor.push(id);
            }
        }
    }
    Ok(out)
}

/// The items that have a usable saved map of this kind for this model.
pub fn have(conn: &Connection, kind: &str, model: &str) -> Result<Vec<i64>, String> {
    check_kind(kind)?;
    check_model(model)?;
    let mut st = conn
        .prepare("SELECT d.media_id FROM derived d JOIN media m ON m.id = d.media_id WHERE d.kind = ?1 AND d.model = ?2 AND d.source = m.object_id")
        .map_err(e)?;
    let ids = st.query_map(params![kind, model], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<_>>().map_err(e)?;
    Ok(ids)
}

/// How many maps are saved and the space they take.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedStats {
    pub depth_count: u64,
    pub depth_bytes: u64,
    pub outline_count: u64,
    pub outline_bytes: u64,
    /// The 3D layers (background plates and subject layers together).
    pub layer_count: u64,
    pub layer_bytes: u64,
    /// Videos and GIFs with prepared 3D (any tag), and the space all of it takes.
    pub track_count: u64,
    pub track_bytes: u64,
}

pub fn stats(conn: &Connection) -> Result<DerivedStats, String> {
    let mut out = DerivedStats::default();
    let (n, bytes): (i64, i64) = conn
        .query_row("SELECT COUNT(DISTINCT media_id), IFNULL(SUM(bytes), 0) FROM derived WHERE kind = 'track'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?;
    (out.track_count, out.track_bytes) = (n as u64, bytes as u64);
    let mut st = conn.prepare("SELECT kind, COUNT(*), IFNULL(SUM(bytes), 0) FROM derived GROUP BY kind").map_err(e)?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))).map_err(e)?;
    for row in rows {
        let (kind, n, bytes) = row.map_err(e)?;
        match kind.as_str() {
            "depth" => (out.depth_count, out.depth_bytes) = (n as u64, bytes as u64),
            "outline" => (out.outline_count, out.outline_bytes) = (n as u64, bytes as u64),
            "plate" | "fore" => {
                out.layer_count += n as u64;
                out.layer_bytes += bytes as u64;
            }
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

/// These pictures sorted by what the face scan found.
#[tauri::command]
pub async fn faces_split(state: State<'_, crate::Shared>, items: Vec<i64>) -> Result<FaceSplit, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || face_split(&s.db(), &items)).await.map_err(|x| x.to_string())?
}

/// What is saved for these items, by kind and model ("Delete 3D data…").
#[tauri::command]
pub async fn derived_summary(state: State<'_, crate::Shared>, items: Vec<i64>) -> Result<Vec<DerivedGroup>, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || summary(&s.db(), &items)).await.map_err(|x| x.to_string())?
}

/// Remove these items' saved maps of the chosen kinds and models; the space is then reclaimed (when that's on).
#[tauri::command]
pub async fn derived_remove(state: State<'_, crate::Shared>, items: Vec<i64>, which: Vec<(String, String)>) -> Result<u64, String> {
    let s = crate::sess(&state)?;
    let s2 = s.clone();
    let n = tauri::async_runtime::spawn_blocking(move || remove(&s, &items, &which)).await.map_err(|x| x.to_string())??;
    if n > 0 {
        crate::cmd_library::reclaim_soon(state.inner().clone(), s2);
    }
    Ok(n)
}

/// Which items already have a saved map of this kind for this model (so background work can skip them).
#[tauri::command]
pub async fn derived_have(state: State<'_, crate::Shared>, kind: String, model: String) -> Result<Vec<i64>, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || have(&s.db(), &kind, &model)).await.map_err(|x| x.to_string())?
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
            DerivedStats { depth_count: 3, depth_bytes: (8 + 12) + (8 + 4) + (8 + 1), outline_count: 1, outline_bytes: 8 + 25, ..Default::default() }
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
    fn videos_and_gifs_keep_tracks_apart_from_pictures() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let pic = item(&s, "image");
        let vid = item(&s, "video");
        let gif = item(&s, "gif");
        let piece = |n: usize| {
            let mut b = b"MV3S".to_vec();
            b.extend(std::iter::repeat_n(1u8, n));
            b
        };
        let tag = "v2-small@518~1_birefnet@1024_e0.00_simple_w768_f1";
        put(&s, vid, "track", &format!("{tag}.i"), b"MV3I{\"v\":1}").unwrap();
        put(&s, vid, "track", &format!("{tag}.s0"), &piece(10)).unwrap();
        put(&s, vid, "track", &format!("{tag}.s1"), &piece(20)).unwrap();
        put(&s, gif, "track", &format!("{tag}.s0"), &piece(5)).unwrap();
        put(&s, vid, "track", "other.s0", &piece(4)).unwrap();
        put(&s, pic, "depth", "v2-small", &map(2, 2, 1)).unwrap();
        // Pictures can't keep tracks, videos can't keep maps, and a track is whole.
        assert!(put(&s, pic, "track", "x.s0", &piece(1)).is_err());
        assert!(put(&s, vid, "depth", "v2-small", &map(2, 2, 1)).is_err());
        assert!(put(&s, vid, "track", "x.s0", b"MVL1abcdefgh").is_err());
        assert_eq!(&get(&s, vid, "track", &format!("{tag}.s1")).unwrap().unwrap()[..], &piece(20)[..]);
        let st = stats(&s.db()).unwrap();
        assert_eq!((st.track_count, st.depth_count), (2, 1));
        assert_eq!(st.track_bytes, 11 + 14 + 24 + 9 + 8);
        // One line per tag, counting videos and GIFs.
        let sum = summary(&s.db(), &[vid, gif, pic]).unwrap();
        let tr: Vec<_> = sum.iter().filter(|g| g.kind == "track").map(|g| (g.model.as_str(), g.count)).collect();
        assert_eq!(tr, vec![("other", 1), (tag, 2)]);
        // Removing a tag takes all its pieces (not another tag that starts the same way).
        put(&s, vid, "track", &format!("{tag}x.s0"), &piece(4)).unwrap();
        assert_eq!(remove(&s, &[vid], &[("track".into(), tag.into())]).unwrap(), 3);
        assert!(get(&s, gif, "track", &format!("{tag}.s0")).unwrap().is_some(), "other items keep theirs");
        assert!(get(&s, vid, "track", &format!("{tag}x.s0")).unwrap().is_some());
        // The pictures' clear leaves tracks; the tracks' clear leaves pictures.
        assert_eq!(clear(&s, Some(PICTURE_KINDS)).unwrap(), 1);
        assert_eq!(stats(&s.db()).unwrap().track_count, 2);
        assert_eq!(clear(&s, Some("track")).unwrap(), 3);
        assert_eq!(stats(&s.db()).unwrap(), DerivedStats::default());
        assert_eq!(track_tag("a~0.5_e0.70.s12"), "a~0.5_e0.70");
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
    fn the_names_the_window_uses_are_accepted_and_have_lists_them() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let a = item(&s, "image");
        let b = item(&s, "image");
        // depth.ts depthTag and subject.ts subjectTag.
        put(&s, a, "depth", "da3-mono-large@518~0.5", &map(2, 2, 1)).unwrap();
        put(&s, b, "depth", "v2-small-fp16@518~1", &map(2, 2, 1)).unwrap();
        put(&s, a, "outline", "birefnet-lite@1024", &map(2, 2, 255)).unwrap();
        assert!(get(&s, a, "depth", "da3-mono-large@518~0.5").unwrap().is_some());
        assert_eq!(have(&s.db(), "depth", "da3-mono-large@518~0.5").unwrap(), vec![a]);
        assert_eq!(have(&s.db(), "outline", "birefnet-lite@1024").unwrap(), vec![a]);
        assert!(have(&s.db(), "depth", "v2-small@518~1").unwrap().is_empty());
        for bad in ["", "a/b", "a\\b", "A", "x y", &"a".repeat(161)] {
            assert!(put(&s, a, "depth", bad, &map(2, 2, 1)).is_err(), "{bad:?}");
        }
        assert_eq!(stats(&s.db()).unwrap().depth_count, 2);
    }

    #[test]
    fn some_maps_of_some_items_are_summed_up_and_removed() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let (a, b, c) = (item(&s, "image"), item(&s, "image"), item(&s, "image"));
        for id in [a, b, c] {
            put(&s, id, "depth", "da3-mono-large@518~0.5", &map(2, 2, 1)).unwrap();
            put(&s, id, "outline", "birefnet@1024", &map(3, 3, 255)).unwrap();
        }
        put(&s, a, "depth", "da3-mono-large@518~1", &map(4, 4, 1)).unwrap();
        put(&s, a, "depth", "v2-small@518~1", &map(2, 2, 1)).unwrap();
        let g = summary(&s.db(), &[a, b]).unwrap();
        let line = |k: &str, m: &str| g.iter().find(|x| x.kind == k && x.model == m).map(|x| (x.count, x.bytes));
        assert_eq!(g.len(), 4, "{g:?}");
        assert_eq!(g[0].kind, "depth", "depth first");
        assert_eq!(g.last().unwrap().kind, "outline");
        assert_eq!(line("depth", "da3-mono-large@518~0.5"), Some((2, 24)));
        assert_eq!(line("depth", "da3-mono-large@518~1"), Some((1, 24)), "the same model at other settings is its own line");
        assert_eq!(line("outline", "birefnet@1024"), Some((2, 34)));
        // Many ids (more than one statement's worth) are fine.
        let many: Vec<i64> = (10_000..11_200).chain([c]).collect();
        assert_eq!(summary(&s.db(), &many).unwrap().iter().map(|x| x.count).sum::<u64>(), 2);
        // Remove Best's sharper depth maps of a and b only.
        let before = thumbs(&s);
        let n = remove(&s, &[a, b], &[("depth".into(), "da3-mono-large@518~0.5".into())]).unwrap();
        assert_eq!(n, 2);
        assert_eq!(thumbs(&s), before - 2, "their files go");
        assert!(get(&s, a, "depth", "da3-mono-large@518~0.5").unwrap().is_none());
        assert!(get(&s, c, "depth", "da3-mono-large@518~0.5").unwrap().is_some(), "other items keep theirs");
        assert!(get(&s, a, "outline", "birefnet@1024").unwrap().is_some(), "other kinds stay");
        assert!(get(&s, a, "depth", "da3-mono-large@518~1").unwrap().is_some(), "other settings stay");
        assert_eq!(remove(&s, &[a], &[]).unwrap(), 0);
        assert!(remove(&s, &[a], &[("thumbs".into(), "x".into())]).is_err());
        assert!(remove(&s, &[a], &[("depth".into(), "../x".into())]).is_err());
        // Survives reopening.
        s.save().unwrap();
        let path = s.vault().root().display().to_string();
        drop(s);
        let s = crate::session::unlock(&path, "long enough pw").unwrap();
        assert_eq!(summary(&s.db(), &[a, b, c]).unwrap().iter().map(|x| x.count).sum::<u64>(), 3 + 1 + 2);
    }

    #[test]
    fn pictures_are_sorted_by_the_faces_found() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        crate::poorfaces::set_test_rule(Some(crate::poorfaces::PoorRule { min_px: 40.0, min_sharp: 0.0, max_turn: 90.0 }));
        let ids: Vec<i64> = (0..6).map(|_| item(&s, "image")).collect();
        let db = s.db();
        db.execute("UPDATE media SET faces_state = 1 WHERE id <> ?", [ids[5]]).unwrap();
        let face = |m: i64, px: f64, hidden: i64| {
            db.execute("INSERT INTO faces(media_id, x, y, w, h, score, descriptor, px, hidden) VALUES (?1, 0, 0, 1, 1, 1, x'00', ?2, ?3)", params![m, px, hidden]).unwrap();
        };
        face(ids[0], 200.0, 0); // a good face
        face(ids[1], 10.0, 0); // only a poor (tiny) face
        // ids[2]: scanned, nothing found
        face(ids[3], 10.0, 1); // a hidden face counts, even a poor one
        face(ids[4], 10.0, 0);
        face(ids[4], 300.0, 0); // poor and good: has faces
        // ids[5]: never scanned (even with a face row it isn't "faceless")
        let sp = face_split(&db, &ids).unwrap();
        assert_eq!(sp.with_faces, vec![ids[0], ids[3], ids[4]]);
        assert_eq!(sp.only_poor, vec![ids[1]]);
        assert_eq!(sp.no_faces, vec![ids[2]]);
        assert_eq!(sp.unscanned, vec![ids[5]]);
        crate::poorfaces::set_test_rule(None);
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

    #[test]
    fn layers_are_kept_packed() {
        assert!(check_data("plate", b"MVL1\x01\0\0\0\x01\0\0\0\0\0\0\0rest").is_ok());
        assert!(check_data("fore", b"nope, not packed").is_err());
        assert!(check_data("depth", b"MVL1\x01\0\0\0\x01\0\0\0\0\0\0\0").is_err(), "a map is one byte per pixel");
        assert!(check_model("da3-mono-large@518~1_birefnet@1024_e0.70_lama").is_ok());
        assert!(check_kind("plate").is_ok() && check_kind("fore").is_ok());
    }

    /// More layers' tags (looklayers.ts layersTag + layerTag), all three generations.
    const MORE_LAYERS: [&str; 6] = [
        "da3-mono-large@518~1_birefnet-lite@1024_e0.70_m4m_simple_l3abc_1",
        "da3-mono-large@518~1_nomask_e0.00_m3s_migan_l2x_0",
        "v2-small@518~0.5_birefnet@1024_e0.35_m4b_lama_l41k2f9r2_3",
        "da3-mono-large@518~1_nomask_e0.00_m3s_migan_l2xr3_1",
        "depth-anything-v2-base@770~1.25_birefnet-hr@2048_e1.00_m3m_simple_l3zzr3_2",
        "da3-mono-large@518~1_birefnet-lite@1024_e0.70_m4m_big-lama-2_l2qr3_0",
    ];
    /// Layered 3D / Lift-off plates and subject layers (plate.ts layerTags), Border fill (looklayers.ts borderTag),
    /// depth maps and outlines: none is More layers.
    const OTHERS: [&str; 9] = [
        "da3-mono-large@518~1_birefnet-lite@1024_e0.70_lama",
        "da3-mono-large@518~1_birefnet-lite@1024_e0.70_simple",
        "da3-mono-large@518~1_birefnet-lite@1024_e0.00",
        "v2-small@518~0.5_birefnet@1024_e0.35_migan",
        "da3-mono-large@518~1_b8_lama",
        "v2-small@518~0.5_b15_simple",
        "da3-mono-large@518~1",
        "birefnet-lite@1024",
        "da3-mono-large@518~1_birefnet-lite@1024_e0.70_simple_w768_f1_v2",
    ];

    #[test]
    fn more_layers_tags_are_told_apart() {
        for t in MORE_LAYERS {
            assert!(is_more_layers_tag(t), "{t}");
            assert!(check_model(t).is_ok(), "{t}");
        }
        for t in OTHERS {
            assert!(!is_more_layers_tag(t), "{t}");
        }
        for t in ["", "@518~1_nomask_e0.00_m3s_migan_l2x_0", "x@518~1_nomask_e0.00_m3s_migan_l2x_10", "x@518~1_nomask_e0.00_m5x_migan_l2x_0", "x@518~1_e0.00_m3s_migan_l2x_0"] {
            assert!(!is_more_layers_tag(t), "{t}");
        }
    }

    #[test]
    fn saved_more_layers_are_deleted_once_and_other_plates_stay() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let a = item(&s, "image");
        let b = item(&s, "image");
        let layer = b"MVL1\x01\0\0\0\x01\0\0\0\0\0\0\0rest";
        for (i, tag) in MORE_LAYERS.iter().enumerate() {
            put(&s, if i % 2 == 0 { a } else { b }, "plate", tag, layer).unwrap();
        }
        for tag in &OTHERS[..6] {
            put(&s, a, "plate", tag, layer).unwrap();
        }
        put(&s, a, "fore", "da3-mono-large@518~1_birefnet-lite@1024_e0.70", layer).unwrap();
        put(&s, a, "depth", "da3-mono-large@518~1", &map(2, 2, 1)).unwrap();
        assert_eq!(thumbs(&s), 6 + 6 + 2);
        assert_eq!(clear_more_layers_once(&s).unwrap(), Some(6));
        assert_eq!(thumbs(&s), 6 + 2, "only More layers' objects went");
        for tag in &OTHERS[..6] {
            assert!(get(&s, a, "plate", tag).unwrap().is_some(), "{tag} stays");
        }
        assert!(get(&s, a, "fore", "da3-mono-large@518~1_birefnet-lite@1024_e0.70").unwrap().is_some());
        assert!(get(&s, b, "plate", MORE_LAYERS[1]).unwrap().is_none());
        // Done once: a later save of that shape (an older window) isn't touched again.
        put(&s, a, "plate", MORE_LAYERS[0], layer).unwrap();
        assert_eq!(clear_more_layers_once(&s).unwrap(), None);
        assert!(get(&s, a, "plate", MORE_LAYERS[0]).unwrap().is_some());
        // Itself it still finds them.
        assert_eq!(clear_more_layers(&s).unwrap(), 1);
    }
}
