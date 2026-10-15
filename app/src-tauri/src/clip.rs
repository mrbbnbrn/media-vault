//! Smart search, the library side. The window turns each item's thumbnail
//! into a 512-number "meaning" vector (fully offline, CLIP); a search turns
//! the typed words into the same kind of vector and the closest items win.
//! Vectors are stored inside the encrypted library as 16-bit floats (half
//! the size of 32-bit ones; scores move by about 0.0001, see the tests).
//!
//! Searching doesn't read the library: every vector is kept in memory, in
//! one block (see [`Index`]), loaded once after unlocking and kept up to date
//! through triggers that note which items' vectors changed.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::Serialize;
use vault_core::half;

use crate::library::{self, Item, R};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

pub const DIM: usize = 512;

/// A stored vector blob (16-bit floats when `f16`, else 32-bit) as 16-bit floats.
fn halves(b: &[u8], f16: bool) -> Vec<u16> {
    if f16 {
        b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
    } else {
        b.chunks_exact(4).map(|c| half::to_f16(f32::from_le_bytes([c[0], c[1], c[2], c[3]]))).collect()
    }
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
    conn.prepare(&format!(
        "SELECT id, kind, IFNULL(preview_object_id, '') <> '' FROM media WHERE clip_state = 0 AND deleted_at IS NULL AND thumb_object_id IS NOT NULL \
         AND kind IN ('image', 'gif', 'video') ORDER BY {}id DESC LIMIT ?",
        crate::focus::order()
    ))
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
    tx.execute("INSERT OR REPLACE INTO clip(media_id, vec, f16) VALUES (?, ?, 1)", params![media, half::f32s_to_f16_blob(&v)]).map_err(e)?;
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

// ---- every vector in memory ------------------------------------------------------------

/// One item's vectors: rows `start..start + n` of [`Index::data`]. `id` 0 = removed.
#[derive(Debug, Clone, Copy)]
struct Entry {
    id: i64,
    start: u32,
    n: u32,
}

/// All smart-search vectors of the open library in one block of 16-bit
/// floats (512 per row), with which item each row belongs to. Trashed items
/// are kept (they come back when restored) and skipped when scoring.
pub struct Index {
    /// The connection it belongs to (a new vault, a new index).
    conn: usize,
    entries: Vec<Entry>,
    pos: HashMap<i64, usize>,
    data: Vec<u16>,
    dead_rows: usize,
    /// Loading after unlocking: rows up to this media id are in (None = all).
    loaded_upto: Option<i64>,
}

static INDEX: Mutex<Option<Index>> = Mutex::new(None);

/// Forget the vectors kept in memory (the vault locked).
pub fn forget_index() {
    *INDEX.lock().unwrap_or_else(|x| x.into_inner()) = None;
}

fn conn_key(conn: &Connection) -> usize {
    conn as *const Connection as usize
}

/// Temporary (never saved) triggers that note every item whose vectors
/// change, however they change: saved, reset, copied, deleted with the item.
const DIRTY_SQL: &str = "CREATE TEMP TABLE IF NOT EXISTS clip_dirty (media_id INTEGER PRIMARY KEY); \
    CREATE TEMP TRIGGER IF NOT EXISTS clip_dirty_add AFTER INSERT ON main.clip BEGIN INSERT OR IGNORE INTO clip_dirty VALUES (NEW.media_id); END; \
    CREATE TEMP TRIGGER IF NOT EXISTS clip_dirty_change AFTER UPDATE ON main.clip BEGIN \
        INSERT OR IGNORE INTO clip_dirty VALUES (OLD.media_id); INSERT OR IGNORE INTO clip_dirty VALUES (NEW.media_id); END; \
    CREATE TEMP TRIGGER IF NOT EXISTS clip_dirty_remove AFTER DELETE ON main.clip BEGIN INSERT OR IGNORE INTO clip_dirty VALUES (OLD.media_id); END;";

fn has_dirty_table(conn: &Connection) -> bool {
    conn.query_row("SELECT COUNT(*) FROM temp.sqlite_master WHERE name = 'clip_dirty_remove'", [], |r| r.get::<_, i64>(0)).unwrap_or(0) > 0
}

/// Rows loaded at a time while warming up (the library is free in between).
const LOAD_BATCH: i64 = 2000;

impl Index {
    fn new(conn: &Connection) -> R<Index> {
        conn.execute_batch(DIRTY_SQL).map_err(e)?;
        conn.execute_batch("DELETE FROM temp.clip_dirty").map_err(e)?;
        Ok(Index { conn: conn_key(conn), entries: Vec::new(), pos: HashMap::new(), data: Vec::new(), dead_rows: 0, loaded_upto: Some(i64::MIN) })
    }

    fn remove(&mut self, id: i64) {
        if let Some(i) = self.pos.remove(&id) {
            self.entries[i].id = 0;
            self.dead_rows += self.entries[i].n as usize;
        }
    }

    fn put(&mut self, id: i64, rows: Vec<u16>) {
        self.remove(id);
        let n = rows.len() / DIM;
        if n == 0 || !rows.len().is_multiple_of(DIM) {
            return;
        }
        let start = (self.data.len() / DIM) as u32;
        self.data.extend_from_slice(&rows);
        self.pos.insert(id, self.entries.len());
        self.entries.push(Entry { id, start, n: n as u32 });
    }

    /// Load the next rows after `loaded_upto`; false when everything is in.
    fn load_more(&mut self, conn: &Connection, batch: i64) -> R<bool> {
        let Some(after) = self.loaded_upto else { return Ok(false) };
        let rows: Vec<(i64, Vec<u8>, bool)> = conn
            .prepare("SELECT media_id, vec, f16 FROM clip WHERE media_id > ? ORDER BY media_id LIMIT ?")
            .map_err(e)?
            .query_map(params![after, batch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        let more = rows.len() as i64 == batch;
        self.loaded_upto = if more { rows.last().map(|r| r.0) } else { None };
        for (id, b, f16) in rows {
            self.put(id, halves(&b, f16));
        }
        Ok(more)
    }

    /// Take in what changed since last time (and the rest, if still loading).
    fn catch_up(&mut self, conn: &Connection) -> R<()> {
        while self.load_more(conn, LOAD_BATCH * 10)? {}
        let changed: Vec<i64> = conn
            .prepare("SELECT media_id FROM temp.clip_dirty")
            .map_err(e)?
            .query_map([], |r| r.get(0))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        if changed.is_empty() {
            return Ok(());
        }
        conn.execute_batch("DELETE FROM temp.clip_dirty").map_err(e)?;
        let mut st = conn.prepare("SELECT vec, f16 FROM clip WHERE media_id = ?").map_err(e)?;
        for id in changed {
            match st.query_row([id], |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, bool>(1)?))) {
                Ok((b, f16)) => self.put(id, halves(&b, f16)),
                Err(rusqlite::Error::QueryReturnedNoRows) => self.remove(id),
                Err(x) => return Err(e(x)),
            }
        }
        if self.dead_rows > 4096 && self.dead_rows * 2 > self.data.len() / DIM {
            self.compact();
        }
        Ok(())
    }

    fn compact(&mut self) {
        let mut data = Vec::with_capacity(self.data.len() - self.dead_rows * DIM);
        let mut entries = Vec::with_capacity(self.pos.len());
        for en in self.entries.iter().filter(|x| x.id != 0) {
            let (s, n) = (en.start as usize * DIM, en.n as usize * DIM);
            entries.push(Entry { id: en.id, start: (data.len() / DIM) as u32, n: en.n });
            data.extend_from_slice(&self.data[s..s + n]);
        }
        self.pos = entries.iter().enumerate().map(|(i, x)| (x.id, i)).collect();
        self.entries = entries;
        self.data = data;
        self.dead_rows = 0;
    }

    fn rows(&self, en: &Entry) -> impl Iterator<Item = &[u16]> {
        let s = en.start as usize * DIM;
        self.data[s..s + en.n as usize * DIM].chunks_exact(DIM)
    }

    /// An item's vectors, one after another (None = not analysed).
    pub fn vectors(&self, id: i64) -> Option<Vec<f32>> {
        let en = self.entries[*self.pos.get(&id)?];
        Some(self.rows(&en).flatten().map(|h| half::from_f16(*h)).collect())
    }

    /// Every item with vectors (trashed ones too).
    pub fn ids(&self) -> impl Iterator<Item = i64> + '_ {
        self.entries.iter().filter(|x| x.id != 0).map(|x| x.id)
    }

    fn len(&self) -> usize {
        self.pos.len()
    }
}

/// Work with the up-to-date index (made on first use). Lock order: the
/// library first, then the index (the caller holds the library).
pub fn with_index<T>(conn: &Connection, f: impl FnOnce(&Index) -> T) -> R<T> {
    let mut guard = INDEX.lock().unwrap_or_else(|x| x.into_inner());
    if guard.as_ref().is_none_or(|i| i.conn != conn_key(conn)) || !has_dirty_table(conn) {
        *guard = Some(Index::new(conn)?);
    }
    let idx = guard.as_mut().expect("set above");
    idx.catch_up(conn)?;
    Ok(f(idx))
}

/// Load every vector into memory in the background after unlocking, a
/// batch at a time so the library stays free for the window. Returns how
/// many items have vectors.
pub fn warm(lib: &dyn crate::faces::Lib) -> R<usize> {
    loop {
        let conn = lib.conn();
        let mut guard = INDEX.lock().unwrap_or_else(|x| x.into_inner());
        if guard.as_ref().is_none_or(|i| i.conn != conn_key(&conn)) || !has_dirty_table(&conn) {
            *guard = Some(Index::new(&conn)?);
        }
        let idx = guard.as_mut().expect("set above");
        if !idx.load_more(&conn, LOAD_BATCH)? {
            idx.catch_up(&conn)?;
            return Ok(idx.len());
        }
        drop(guard);
        drop(conn);
        std::thread::yield_now();
    }
}

/// Trashed items (skipped when scoring).
fn trashed(conn: &Connection) -> R<HashSet<i64>> {
    conn.prepare("SELECT id FROM media WHERE deleted_at IS NOT NULL")
        .map_err(e)?
        .query_map([], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)
}

/// The lookup table for turning 16-bit floats into 32-bit ones.
fn f16_table() -> &'static [f32] {
    static T: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
    T.get_or_init(|| (0..=u16::MAX).map(half::from_f16).collect())
}

/// q · v for a row of 16-bit floats.
pub fn dot_f16(q: &[f32], v: &[u16]) -> f32 {
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("f16c") && std::arch::is_x86_feature_detected!("fma") && std::arch::is_x86_feature_detected!("avx") {
            // SAFETY: the processor has the features dot_f16c is compiled for (checked just above).
            return unsafe { dot_f16c(q, v) };
        }
    }
    dot_table(q, v)
}

fn dot_table(q: &[f32], v: &[u16]) -> f32 {
    let t = f16_table();
    let mut acc = [0f32; 8];
    let (cq, cv) = (q.chunks_exact(8), v.chunks_exact(8));
    let (rq, rv) = (cq.remainder(), cv.remainder());
    for (a, b) in cq.zip(cv) {
        for k in 0..8 {
            acc[k] += a[k] * t[b[k] as usize];
        }
    }
    acc.iter().sum::<f32>() + rq.iter().zip(rv).map(|(a, b)| a * t[*b as usize]).sum::<f32>()
}

/// The same with the processor's own conversion (F16C), 16 values at a time.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx,f16c,fma")]
fn dot_f16c(q: &[f32], v: &[u16]) -> f32 {
    use std::arch::x86_64::*;
    let n = q.len().min(v.len());
    let (mut a0, mut a1) = (_mm256_setzero_ps(), _mm256_setzero_ps());
    let mut i = 0;
    while i + 16 <= n {
        // SAFETY: i + 16 <= n, so all 16 values of both slices are in bounds
        // (unaligned loads are allowed).
        unsafe {
            let h0 = _mm_loadu_si128(v.as_ptr().add(i) as *const __m128i);
            let h1 = _mm_loadu_si128(v.as_ptr().add(i + 8) as *const __m128i);
            a0 = _mm256_fmadd_ps(_mm256_cvtph_ps(h0), _mm256_loadu_ps(q.as_ptr().add(i)), a0);
            a1 = _mm256_fmadd_ps(_mm256_cvtph_ps(h1), _mm256_loadu_ps(q.as_ptr().add(i + 8)), a1);
        }
        i += 16;
    }
    let mut out = [0f32; 8];
    // SAFETY: `out` holds exactly 8 floats.
    unsafe { _mm256_storeu_ps(out.as_mut_ptr(), _mm256_add_ps(a0, a1)) };
    out.iter().sum::<f32>() + dot_table(&q[i..n], &v[i..n])
}

/// How close each analysed (not deleted) item is to the query, best first.
/// `q` must be normalized. Shared with "Why is this here?" (explain.rs).
pub fn score_all(conn: &Connection, q: &[f32]) -> R<Vec<(i64, f32)>> {
    let gone = trashed(conn)?;
    let mut scored = with_index(conn, |idx| {
        idx.entries
            .iter()
            .filter(|en| en.id != 0 && !gone.contains(&en.id))
            .map(|en| (en.id, idx.rows(en).map(|r| dot_f16(q, r)).fold(f32::MIN, f32::max)))
            .collect::<Vec<_>>()
    })?;
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(scored)
}

/// CLIP scores sit close together; results keep what is near the best match.
pub const CUT_BELOW_BEST: f32 = 0.05;
/// ...but always at least this many results, so a search never looks broken.
pub const MIN_RESULTS: usize = 8;

/// The query as a unit vector, or the error smart search shows.
pub fn query_vector(query: &[f32]) -> R<Vec<f32>> {
    normalized(query).ok_or_else(|| "Smart search couldn't understand those words.".into())
}

/// The items closest in meaning to `query`, best first, optionally only
/// inside a folder (with its subfolders). Weak matches are left out, keeping
/// at least a few results so a search never looks broken.
pub fn search(conn: &Connection, query: &[f32], folder: Option<i64>, limit: usize) -> R<Vec<Hit>> {
    let q = query_vector(query)?;
    let scored = score_all(conn, &q)?;
    if scored.is_empty() {
        return Ok(Vec::new());
    }
    let best = scored[0].1;
    let cut = best - CUT_BELOW_BEST;
    // Inside a folder: only what is in it or below it.
    let inside: Option<HashSet<i64>> = match folder {
        Some(f) => {
            let folders = library::descendants(conn, &[f])?;
            let (list, args) = library::id_list(&folders);
            let ids = conn
                .prepare(&format!("SELECT id FROM media WHERE deleted_at IS NULL AND folder_id IN ({list})"))
                .map_err(e)?
                .query_map(rusqlite::params_from_iter(args), |r| r.get(0))
                .map_err(e)?
                .collect::<rusqlite::Result<_>>()
                .map_err(e)?;
            Some(ids)
        }
        None => None,
    };
    let mut picked: Vec<(i64, f32)> = Vec::new();
    for (id, score) in scored {
        if picked.len() >= limit || (score < cut && picked.len() >= MIN_RESULTS) {
            break;
        }
        if inside.as_ref().is_none_or(|s| s.contains(&id)) {
            picked.push((id, score));
        }
    }
    let ids: Vec<i64> = picked.iter().map(|p| p.0).collect();
    let mut by_id: HashMap<i64, Item> = library::items_by_ids(conn, &ids)?.into_iter().map(|i| (i.id, i)).collect();
    Ok(picked.into_iter().filter_map(|(id, score)| by_id.remove(&id).map(|item| Hit { item, score })).collect())
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
        // Restored from the trash: found again (the index kept its vectors).
        library::restore_items(&c, &[beach]).unwrap();
        assert_eq!(search(&c, &vec_at(0, 0, 0.0), None, 10).unwrap()[0].item.id, vid);
        assert!(search(&c, &vec_at(0, 0, 0.0), None, 10).unwrap().iter().any(|h| h.item.id == beach));
        // Deleted for good: its vectors go with it (cascade), and so from the index.
        c.execute("DELETE FROM media WHERE id = ?", [vid]).unwrap();
        assert_ne!(search(&c, &vec_at(0, 0, 0.0), None, 10).unwrap()[0].item.id, vid);
    }

    fn unit(mut v: Vec<f32>) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter_mut().for_each(|x| *x /= n);
        v
    }

    /// Like real CLIP vectors: clusters of similar pictures, scores packed together.
    fn realistic(n: usize, seed: u64) -> Vec<Vec<f32>> {
        let mut x = seed;
        let mut rnd = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 11) as f32 / (1u64 << 53) as f32 - 0.5
        };
        let common: Vec<f32> = (0..DIM).map(|_| rnd()).collect();
        let centres: Vec<Vec<f32>> = (0..40).map(|_| (0..DIM).map(|i| common[i] * 2.0 + rnd()).collect()).collect();
        (0..n).map(|k| unit(centres[k % 40].iter().map(|c| c + rnd() * 1.2).collect())).collect()
    }

    #[test]
    fn half_size_vectors_give_the_same_results() {
        let c = db::create_empty().unwrap();
        let vs = realistic(3000, 7);
        let mut ids = Vec::new();
        for v in &vs {
            let id = add(&c, None, "image");
            save(&c, id, v).unwrap();
            ids.push(id);
        }
        let (mut worst, mut same_top) = (0f32, 0usize);
        let queries = realistic(60, 99);
        for q in &queries {
            let got = score_all(&c, q).unwrap();
            let mut want: Vec<(i64, f32)> = ids.iter().zip(&vs).map(|(id, v)| (*id, v.iter().zip(q).map(|(a, b)| a * b).sum())).collect();
            want.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            let got_s: HashMap<i64, f32> = got.iter().copied().collect();
            for (id, s) in &want {
                worst = worst.max((got_s[id] - s).abs());
            }
            // The first results are the same ones (ties within the error aside).
            let top: HashSet<i64> = got.iter().take(50).map(|x| x.0).collect();
            let wtop: Vec<(i64, f32)> = want.iter().take(50).copied().collect();
            assert!(wtop.iter().all(|(id, s)| top.contains(id) || (s - want[49].1).abs() < 1e-3));
            same_top += (got.iter().take(50).map(|x| x.0).collect::<Vec<_>>() == wtop.iter().map(|x| x.0).collect::<Vec<_>>()) as usize;
        }
        eprintln!("16-bit vectors: largest score difference {worst:.6}; identical top-50 order in {same_top} of {} searches", queries.len());
        assert!(worst < 5e-4, "{worst}");
        // Both ways of converting agree.
        let q = &queries[0];
        let row: Vec<u16> = vs[0].iter().map(|x| half::to_f16(*x)).collect();
        assert!((dot_f16(q, &row) - dot_table(q, &row)).abs() < 1e-5);
    }
}
