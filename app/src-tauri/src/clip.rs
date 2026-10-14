//! Smart search, the library side. The window turns each item's thumbnail
//! into a 512-number "meaning" vector (fully offline, CLIP); a search turns
//! the typed words into the same kind of vector and the closest items win.
//! Vectors are stored inside the encrypted library.

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::library::{self, Item, R};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

pub const DIM: usize = 512;

fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn normalized(v: &[f32]) -> Option<Vec<f32>> {
    if v.len() != DIM || !v.iter().all(|x| x.is_finite()) {
        return None;
    }
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n <= 1e-6 {
        return None;
    }
    Some(v.iter().map(|x| x / n).collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTask {
    pub id: i64,
    pub kind: String,
    /// Videos: a preview clip exists, so several moments can be analysed.
    pub preview: bool,
}

/// Items that still need analysing (they need a thumbnail first).
pub fn needed(conn: &Connection, limit: i64) -> R<Vec<ClipTask>> {
    conn.prepare(
        "SELECT id, kind, IFNULL(preview_object_id, '') <> '' FROM media WHERE clip_state = 0 AND deleted_at IS NULL AND thumb_object_id IS NOT NULL \
         AND kind IN ('image', 'gif', 'video') ORDER BY id DESC LIMIT ?",
    )
    .map_err(e)?
    .query_map([limit], |r| Ok(ClipTask { id: r.get(0)?, kind: r.get(1)?, preview: r.get(2)? }))
    .map_err(e)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(e)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipStatus {
    /// Pictures and videos that can be searched this way.
    pub total: i64,
    pub done: i64,
    pub failed: i64,
}

pub fn status(conn: &Connection) -> R<ClipStatus> {
    let one = |sql: &str| -> R<i64> { conn.query_row(sql, [], |r| r.get(0)).map_err(e) };
    Ok(ClipStatus {
        total: one("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND kind IN ('image', 'gif', 'video')")?,
        done: one("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND clip_state = 1")?,
        failed: one("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND clip_state = -1")?,
    })
}

/// Up to this many vectors per item (videos: the thumbnail plus moments
/// from its preview clip). The best-matching one counts.
pub const MAX_VECTORS: usize = 8;

pub fn save(conn: &Connection, media: i64, vec: &[f32]) -> R<()> {
    if vec.is_empty() || !vec.len().is_multiple_of(DIM) || vec.len() / DIM > MAX_VECTORS {
        return failed(conn, media);
    }
    let mut v = Vec::with_capacity(vec.len());
    for chunk in vec.chunks(DIM) {
        match normalized(chunk) {
            Some(n) => v.extend(n),
            None => return failed(conn, media),
        }
    }
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute("INSERT OR REPLACE INTO clip(media_id, vec) VALUES (?, ?)", params![media, to_blob(&v)]).map_err(e)?;
    tx.execute("UPDATE media SET clip_state = 1 WHERE id = ?", [media]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(())
}

pub fn failed(conn: &Connection, media: i64) -> R<()> {
    conn.execute("UPDATE media SET clip_state = -1 WHERE id = ?", [media]).map_err(e)?;
    Ok(())
}

/// When a thumbnail is made again the item is analysed again too.
pub fn reset(conn: &Connection, media: i64) -> R<()> {
    conn.execute("UPDATE media SET clip_state = 0 WHERE id = ?", [media]).map_err(e)?;
    conn.execute("DELETE FROM clip WHERE media_id = ?", [media]).map_err(e)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub item: Item,
    pub score: f32,
}

/// The items closest in meaning to `query`, best first, optionally only
/// inside a folder (with its subfolders). Weak matches are left out, keeping
/// at least a few results so a search never looks broken.
pub fn search(conn: &Connection, query: &[f32], folder: Option<i64>, limit: usize) -> R<Vec<Hit>> {
    let Some(q) = normalized(query) else {
        return Err("Smart search couldn't understand those words.".into());
    };
    let mut scored: Vec<(i64, f32)> = conn
        .prepare("SELECT c.media_id, c.vec FROM clip c JOIN media m ON m.id = c.media_id WHERE m.deleted_at IS NULL")
        .map_err(e)?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map_err(e)?
        .filter_map(|r| r.ok())
        .map(|(id, b)| {
            let v = from_blob(&b);
            let best = v
                .chunks(DIM)
                .map(|c| c.iter().zip(&q).map(|(a, b)| a * b).sum::<f32>())
                .fold(f32::MIN, f32::max);
            (id, best)
        })
        .collect();
    if scored.is_empty() {
        return Ok(Vec::new());
    }
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    // CLIP scores sit close together; keep what is near the best match.
    let best = scored[0].1;
    let cut = best - 0.05;
    let items = library::query_items(
        conn,
        &library::ItemFilter { folder: folder.map(Some), recursive: folder.is_some(), ..Default::default() },
    )?;
    let by_id: std::collections::HashMap<i64, Item> = items.into_iter().map(|i| (i.id, i)).collect();
    let mut out = Vec::new();
    for (id, score) in scored {
        if out.len() >= limit || (score < cut && out.len() >= 8) {
            break;
        }
        if let Some(item) = by_id.get(&id) {
            out.push(Hit { item: item.clone(), score });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    fn add(conn: &Connection, folder: Option<i64>, kind: &str) -> i64 {
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, 'p.jpg', 'jpg', 1, 'h', 0, 't')",
            params![folder, kind],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn vec_at(i: usize, j: usize, mix: f32) -> Vec<f32> {
        let mut v = vec![0.0; DIM];
        v[i] = 1.0;
        v[j] += mix;
        v
    }

    #[test]
    fn indexes_and_finds_closest_first() {
        let c = db::create_empty().unwrap();
        let f = library::create_folder(&c, None, "F").unwrap();
        let beach = add(&c, None, "image");
        let beach2 = add(&c, Some(f), "video");
        let cat = add(&c, None, "image");
        let txt = add(&c, None, "text");
        assert_eq!(needed(&c, 10).unwrap().len(), 3, "text isn't analysed");
        save(&c, beach, &vec_at(0, 1, 0.1)).unwrap();
        save(&c, beach2, &vec_at(0, 1, 0.5)).unwrap();
        save(&c, cat, &vec_at(2, 1, 0.0)).unwrap();
        assert!(needed(&c, 10).unwrap().is_empty());
        save(&c, txt, &[1.0, 2.0]).unwrap(); // wrong size = failed, not stored
        assert_eq!(status(&c).unwrap().done, 3);

        let hits = search(&c, &vec_at(0, 0, 0.0), None, 10).unwrap();
        assert_eq!(hits.iter().map(|h| h.item.id).collect::<Vec<_>>(), vec![beach, beach2, cat]);
        let inside = search(&c, &vec_at(0, 0, 0.0), Some(f), 10).unwrap();
        assert_eq!(inside.iter().map(|h| h.item.id).collect::<Vec<_>>(), vec![beach2]);
        library::trash_items(&c, &[beach]).unwrap();
        assert_eq!(search(&c, &vec_at(0, 0, 0.0), None, 1).unwrap()[0].item.id, beach2);
        // A video with several moments: the best one counts.
        let vid = add(&c, None, "video");
        let mut both = vec_at(5, 6, 0.0);
        both.extend(vec_at(0, 2, 0.0));
        save(&c, vid, &both).unwrap();
        let h = search(&c, &vec_at(0, 0, 0.0), None, 10).unwrap();
        assert_eq!(h[0].item.id, vid, "its second moment matches exactly");
        save(&c, vid, &vec![0.5; DIM * 9]).unwrap(); // too many vectors: refused
        reset(&c, cat).unwrap();
        assert_eq!(needed(&c, 10).unwrap().len(), 1);
    }
}
