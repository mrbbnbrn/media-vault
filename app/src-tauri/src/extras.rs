//! Smaller library features: statistics, view counts, random picks
//! (random journey, today's pick), folder card samples and video bookmarks.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::library::{self, Item, R};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

// ---- statistics ------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KindStat {
    pub kind: String,
    pub items: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderStat {
    pub id: Option<i64>,
    pub name: String,
    pub items: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthStat {
    /// "2026-10"
    pub month: String,
    pub items: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub items: i64,
    pub bytes: i64,
    pub folders: i64,
    pub tags: i64,
    pub favourites: i64,
    pub never_viewed: i64,
    pub total_views: i64,
    pub trash_items: i64,
    pub trash_bytes: i64,
    pub by_kind: Vec<KindStat>,
    /// Top-level folders (everything inside counted), biggest first.
    pub by_folder: Vec<FolderStat>,
    /// Imports per month, oldest first.
    pub by_month: Vec<MonthStat>,
    pub most_viewed: Vec<Item>,
}

pub fn stats(conn: &Connection) -> R<Stats> {
    let one = |sql: &str| -> R<i64> { conn.query_row(sql, [], |r| r.get(0)).map_err(e) };
    let (items, bytes): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), IFNULL(SUM(size), 0) FROM media WHERE deleted_at IS NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(e)?;
    let (trash_items, trash_bytes): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), IFNULL(SUM(size), 0) FROM media WHERE deleted_at IS NOT NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(e)?;
    let by_kind = conn
        .prepare(
            "SELECT kind, COUNT(*), IFNULL(SUM(size), 0) FROM media WHERE deleted_at IS NULL GROUP BY kind ORDER BY 3 DESC",
        )
        .map_err(e)?
        .query_map([], |r| {
            Ok(KindStat {
                kind: r.get(0)?,
                items: r.get(1)?,
                bytes: r.get(2)?,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;

    // Sum each folder's own items, then roll them up to the top-level folder.
    let folders = library::all_folders(conn)?;
    let mut own: std::collections::HashMap<Option<i64>, (i64, i64)> = Default::default();
    {
        let mut st = conn
            .prepare("SELECT folder_id, COUNT(*), IFNULL(SUM(size), 0) FROM media WHERE deleted_at IS NULL GROUP BY folder_id")
            .map_err(e)?;
        for row in st
            .query_map([], |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(e)?
        {
            let (f, n, b) = row.map_err(e)?;
            own.insert(f, (n, b));
        }
    }
    let mut by_folder: Vec<FolderStat> = folders
        .iter()
        .filter(|f| f.parent_id.is_none())
        .map(|top| {
            let (mut n, mut b) = (0, 0);
            for f in folders
                .iter()
                .filter(|f| f.id == top.id || f.path.iter().any(|c| c.id == top.id))
            {
                if let Some((a, c)) = own.get(&Some(f.id)) {
                    n += a;
                    b += c;
                }
            }
            FolderStat {
                id: Some(top.id),
                name: top.name.clone(),
                items: n,
                bytes: b,
            }
        })
        .collect();
    if let Some((n, b)) = own.get(&None).copied().filter(|(n, _)| *n > 0) {
        by_folder.push(FolderStat {
            id: None,
            name: "Top level".into(),
            items: n,
            bytes: b,
        });
    }
    by_folder.sort_by_key(|f| std::cmp::Reverse(f.bytes));

    let by_month = conn
        .prepare(
            "SELECT strftime('%Y-%m', imported_at, 'unixepoch'), COUNT(*), IFNULL(SUM(size), 0) FROM media \
             WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1",
        )
        .map_err(e)?
        .query_map([], |r| {
            Ok(MonthStat {
                month: r.get(0)?,
                items: r.get(1)?,
                bytes: r.get(2)?,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;

    let mut most_viewed = library::query_items(conn, &Default::default())?;
    most_viewed.retain(|i| i.views > 0);
    most_viewed.sort_by(|a, b| b.views.cmp(&a.views).then(b.id.cmp(&a.id)));
    most_viewed.truncate(12);

    Ok(Stats {
        items,
        bytes,
        folders: one("SELECT COUNT(*) FROM folders WHERE deleted_at IS NULL")?,
        tags: one("SELECT COUNT(*) FROM tags")?,
        favourites: one("SELECT COUNT(*) FROM media WHERE favourite = 1 AND deleted_at IS NULL")?,
        never_viewed: one("SELECT COUNT(*) FROM media WHERE views = 0 AND deleted_at IS NULL")?,
        total_views: one("SELECT IFNULL(SUM(views), 0) FROM media WHERE deleted_at IS NULL")?,
        trash_items,
        trash_bytes,
        by_kind,
        by_folder,
        by_month,
        most_viewed,
    })
}

pub fn mark_viewed(conn: &Connection, id: i64) -> R<()> {
    conn.execute(
        "UPDATE media SET views = views + 1, last_viewed_at = ? WHERE id = ?",
        params![library::now_secs(), id],
    )
    .map_err(e)?;
    Ok(())
}

// ---- random picks ----------------------------------------------------------------------

/// Small deterministic generator (xorshift*), so "today's pick" stays the
/// same all day without storing anything.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn seeded_now() -> Self {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(1);
        Rng::new(t)
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Pick an index with probability proportional to its weight (0 = never).
pub fn weighted_index(weights: &[f64], rng: &mut Rng) -> Option<usize> {
    let total: f64 = weights.iter().filter(|w| **w > 0.0).sum();
    if total <= 0.0 {
        return None;
    }
    let mut x = rng.unit() * total;
    for (i, w) in weights.iter().enumerate() {
        if *w <= 0.0 {
            continue;
        }
        if x < *w {
            return Some(i);
        }
        x -= w;
    }
    weights.iter().rposition(|w| *w > 0.0)
}

/// Candidates for picks: pictures, GIFs and videos that can be shown.
fn pickable(conn: &Connection) -> R<Vec<(i64, Option<i64>, f64)>> {
    conn.prepare(
        "SELECT id, folder_id, weight FROM media WHERE deleted_at IS NULL AND kind IN ('image', 'gif', 'video') \
         AND thumb_object_id IS NOT NULL AND thumb_object_id <> '' ORDER BY id",
    )
    .map_err(e)?
    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
    .map_err(e)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(e)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub folder: Option<i64>,
    pub item: i64,
}

/// Random journey: a random folder (each folder equally likely), then a
/// random item in it.
pub fn random_journey(conn: &Connection) -> R<Option<Pick>> {
    let all = pickable(conn)?;
    let mut folders: Vec<Option<i64>> = all.iter().map(|(_, f, _)| *f).collect();
    folders.sort();
    folders.dedup();
    let mut rng = Rng::seeded_now();
    let Some(folder) = folders
        .get((rng.next() % folders.len().max(1) as u64) as usize)
        .copied()
    else {
        return Ok(None);
    };
    let inside: Vec<i64> = all
        .iter()
        .filter(|(_, f, _)| *f == folder)
        .map(|(i, _, _)| *i)
        .collect();
    let item = inside[(rng.next() % inside.len() as u64) as usize];
    Ok(Some(Pick { folder, item }))
}

/// Today's pick: weighted random, the same all day (local day number).
pub fn todays_pick(conn: &Connection, day: i64) -> R<Option<Item>> {
    let all = pickable(conn)?;
    let weights: Vec<f64> = all.iter().map(|(_, _, w)| *w).collect();
    let mut rng = Rng::new(day as u64 ^ 0x0005_EED0_FDA7);
    rng.next();
    match weighted_index(&weights, &mut rng) {
        Some(i) => library::get_item(conn, all[i].0).map(Some),
        None => Ok(None),
    }
}

/// A few items from inside a folder (and its subfolders) for the living
/// folder card, in random order.
pub fn folder_samples(conn: &Connection, folder: i64, n: i64) -> R<Vec<i64>> {
    let items = library::query_items(
        conn,
        &library::ItemFilter {
            folder: Some(Some(folder)),
            recursive: true,
            ..Default::default()
        },
    )?;
    let mut ids: Vec<i64> = items
        .into_iter()
        .filter(|i| i.thumb == "ok")
        .map(|i| i.id)
        .collect();
    let mut rng = Rng::seeded_now();
    for i in (1..ids.len()).rev() {
        let j = (rng.next() % (i as u64 + 1)) as usize;
        ids.swap(i, j);
    }
    ids.truncate(n.max(0) as usize);
    Ok(ids)
}

// ---- bookmarks -------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: i64,
    pub position_ms: i64,
    pub note: String,
}

pub fn bookmarks(conn: &Connection, media: i64) -> R<Vec<Bookmark>> {
    conn.prepare(
        "SELECT id, position_ms, note FROM bookmarks WHERE media_id = ? ORDER BY position_ms, id",
    )
    .map_err(e)?
    .query_map([media], |r| {
        Ok(Bookmark {
            id: r.get(0)?,
            position_ms: r.get(1)?,
            note: r.get(2)?,
        })
    })
    .map_err(e)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(e)
}

fn clean_note(note: &str) -> String {
    note.trim().chars().take(500).collect()
}

pub fn add_bookmark(conn: &Connection, media: i64, position_ms: i64, note: &str) -> R<i64> {
    let exists: Option<i64> = conn
        .query_row("SELECT 1 FROM media WHERE id = ?", [media], |r| r.get(0))
        .optional()
        .map_err(e)?;
    if exists.is_none() {
        return Err("That item no longer exists.".into());
    }
    conn.execute(
        "INSERT INTO bookmarks(media_id, position_ms, note, created_at) VALUES (?, ?, ?, ?)",
        params![
            media,
            position_ms.max(0),
            clean_note(note),
            library::now_secs()
        ],
    )
    .map_err(e)?;
    Ok(conn.last_insert_rowid())
}

pub fn update_bookmark(conn: &Connection, id: i64, position_ms: i64, note: &str) -> R<()> {
    conn.execute(
        "UPDATE bookmarks SET position_ms = ?, note = ? WHERE id = ?",
        params![position_ms.max(0), clean_note(note), id],
    )
    .map_err(e)?;
    Ok(())
}

pub fn delete_bookmark(conn: &Connection, id: i64) -> R<()> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?", [id])
        .map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    fn add(conn: &Connection, folder: Option<i64>, weight: f64) -> i64 {
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id, weight) \
             VALUES (lower(hex(randomblob(16))), ?1, 'image', 'x.jpg', 'jpg', 100, 'h', 0, 't', ?2)",
            params![folder, weight],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn weighted_pick_follows_weights() {
        let mut rng = Rng::new(7);
        let w = [1.0, 0.0, 4.0];
        let mut counts = [0; 3];
        for _ in 0..50_000 {
            counts[weighted_index(&w, &mut rng).unwrap()] += 1;
        }
        assert_eq!(counts[1], 0);
        let ratio = counts[2] as f64 / counts[0] as f64;
        assert!((3.6..4.4).contains(&ratio), "{ratio}");
        assert!(weighted_index(&[0.0, 0.0], &mut rng).is_none());
    }

    #[test]
    fn todays_pick_is_stable_for_a_day_and_skips_weight_zero() {
        let c = db::create_empty().unwrap();
        let never = add(&c, None, 0.0);
        for _ in 0..20 {
            add(&c, None, 1.0);
        }
        let a = todays_pick(&c, 20_000).unwrap().unwrap();
        assert_eq!(todays_pick(&c, 20_000).unwrap().unwrap().id, a.id);
        let picks: std::collections::HashSet<i64> = (0..40)
            .map(|d| todays_pick(&c, 20_000 + d).unwrap().unwrap().id)
            .collect();
        assert!(picks.len() > 5, "different days give different picks");
        assert!(!picks.contains(&never));
    }

    #[test]
    fn stats_views_bookmarks_and_journey() {
        let c = db::create_empty().unwrap();
        let f = library::create_folder(&c, None, "People").unwrap();
        let sub = library::create_folder(&c, Some(f), "Ayşe").unwrap();
        let a = add(&c, Some(sub), 1.0);
        let b = add(&c, None, 1.0);
        mark_viewed(&c, a).unwrap();
        mark_viewed(&c, a).unwrap();
        let s = stats(&c).unwrap();
        assert_eq!(s.items, 2);
        assert_eq!(s.never_viewed, 1);
        assert_eq!(s.most_viewed[0].id, a);
        assert_eq!(s.most_viewed[0].views, 2);
        assert_eq!(
            s.by_folder.iter().find(|x| x.id == Some(f)).unwrap().items,
            1,
            "subfolders roll up"
        );
        assert!(s.by_folder.iter().any(|x| x.id.is_none()));

        let bm = add_bookmark(&c, a, 61_500, "  the good part ").unwrap();
        add_bookmark(&c, a, 1_000, "").unwrap();
        let list = bookmarks(&c, a).unwrap();
        assert_eq!(
            list.iter().map(|x| x.position_ms).collect::<Vec<_>>(),
            vec![1_000, 61_500]
        );
        assert_eq!(list[1].note, "the good part");
        update_bookmark(&c, bm, 62_000, "edited").unwrap();
        delete_bookmark(&c, list[0].id).unwrap();
        assert_eq!(bookmarks(&c, a).unwrap().len(), 1);

        for _ in 0..20 {
            let p = random_journey(&c).unwrap().unwrap();
            assert!(p.item == a && p.folder == Some(sub) || p.item == b && p.folder.is_none());
        }
        assert_eq!(folder_samples(&c, f, 5).unwrap(), vec![a]);
    }
}
