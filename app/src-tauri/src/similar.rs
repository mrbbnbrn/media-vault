//! Look-alikes: finding pictures that look the same (burst shots, the same
//! pose taken again, re-saved or resized copies), the same way as the
//! "similar photos" finder of the user's Baro Alarm app.
//!
//! The window makes a fingerprint of each thumbnail once: a 64-bit
//! perceptual hash (pHash) and a sharpness score. Two pictures are alike when
//! few bits differ. With smart search on, pictures can instead be compared by
//! what they show (their smart-search vectors).

use std::collections::HashMap;

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::clip::{self, Hit};
use crate::library::{self, Item, R};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FpTask {
    pub id: i64,
    pub kind: String,
}

const KINDS: &str = "('image', 'gif', 'video')";

/// Items whose fingerprint still has to be made (they need a thumbnail first).
pub fn needed(conn: &Connection, limit: i64) -> R<Vec<FpTask>> {
    conn.prepare(&format!(
        "SELECT id, kind FROM media WHERE phash_state = 0 AND deleted_at IS NULL AND IFNULL(thumb_object_id, '') <> '' \
         AND kind IN {KINDS} ORDER BY id DESC LIMIT ?"
    ))
    .map_err(e)?
    .query_map([limit], |r| Ok(FpTask { id: r.get(0)?, kind: r.get(1)? }))
    .map_err(e)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(e)
}

/// `hash` is the 64-bit fingerprint as 16 hex digits.
pub fn save(conn: &Connection, id: i64, hash: &str, sharpness: f64) -> R<()> {
    let Ok(h) = u64::from_str_radix(hash, 16) else {
        return failed(conn, id);
    };
    let sharp = if sharpness.is_finite() { sharpness.max(0.0) } else { 0.0 };
    conn.execute(
        "UPDATE media SET phash = ?1, sharpness = ?2, phash_state = 1 WHERE id = ?3",
        params![h as i64, sharp, id],
    )
    .map_err(e)?;
    Ok(())
}

pub fn failed(conn: &Connection, id: i64) -> R<()> {
    conn.execute("UPDATE media SET phash_state = -1 WHERE id = ?", [id]).map_err(e)?;
    Ok(())
}

/// A new thumbnail: make the fingerprint again.
pub fn reset(conn: &Connection, id: i64) -> R<()> {
    conn.execute("UPDATE media SET phash = NULL, sharpness = NULL, phash_state = 0 WHERE id = ?", [id]).map_err(e)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FpStatus {
    pub total: i64,
    pub done: i64,
}

pub fn status(conn: &Connection) -> R<FpStatus> {
    let one = |sql: &str| -> R<i64> { conn.query_row(sql, [], |r| r.get(0)).map_err(e) };
    Ok(FpStatus {
        total: one(&format!(
            "SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND kind IN {KINDS} AND IFNULL(thumb_object_id, 'x') <> ''"
        ))?,
        done: one(&format!("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND kind IN {KINDS} AND phash_state <> 0"))?,
    })
}

pub fn distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Strict, normal or loose: the most bits that may differ (as in Baro Alarm),
/// or how alike in meaning two pictures must be with smart search.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Strict,
    Normal,
    Loose,
}

impl Level {
    pub fn parse(s: &str) -> Level {
        match s {
            "strict" => Level::Strict,
            "loose" => Level::Loose,
            _ => Level::Normal,
        }
    }
    fn bits(self) -> u32 {
        match self {
            Level::Strict => 5,
            Level::Normal => 9,
            Level::Loose => 14,
        }
    }
    fn meaning(self) -> f32 {
        match self {
            Level::Strict => 0.95,
            Level::Normal => 0.92,
            Level::Loose => 0.88,
        }
    }
}

struct Fp {
    hash: u64,
    sharp: f64,
}

fn fingerprints(conn: &Connection) -> R<HashMap<i64, Fp>> {
    conn.prepare("SELECT id, phash, IFNULL(sharpness, 0) FROM media WHERE phash_state = 1 AND phash IS NOT NULL AND deleted_at IS NULL")
        .map_err(e)?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, Fp { hash: r.get::<_, i64>(1)? as u64, sharp: r.get(2)? })))
        .map_err(e)?
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(e)
}

/// One vector per item for comparing pictures with each other: the average
/// of its smart-search vectors (videos have several), unit length.
fn meanings(conn: &Connection) -> R<HashMap<i64, Vec<f32>>> {
    let rows = conn
        .prepare("SELECT c.media_id, c.vec FROM clip c JOIN media m ON m.id = c.media_id WHERE m.deleted_at IS NULL")
        .map_err(e)?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    let mut out = HashMap::new();
    for (id, b) in rows {
        let v: Vec<f32> = b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        if v.is_empty() || !v.len().is_multiple_of(clip::DIM) {
            continue;
        }
        let mut m = vec![0f32; clip::DIM];
        for chunk in v.chunks(clip::DIM) {
            for (a, b) in m.iter_mut().zip(chunk) {
                *a += b;
            }
        }
        let n = m.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > 1e-6 {
            m.iter_mut().for_each(|x| *x /= n);
            out.insert(id, m);
        }
    }
    Ok(out)
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// The best picture of a group first: favourite, then clearly bigger
/// (a resized copy loses; its compression noise can look "sharp"), then
/// sharpest, then the most pixels, then the most viewed, then the oldest.
fn best_first(items: &mut [Item], sharp: &HashMap<i64, f64>) {
    let s = |i: &Item| sharp.get(&i.id).copied().unwrap_or(0.0);
    let px = |i: &Item| i.width.unwrap_or(0) * i.height.unwrap_or(0);
    let clearly_bigger = |a: &Item, b: &Item| {
        let (pa, pb) = (px(a) as f64, px(b) as f64);
        if pa > pb * 1.15 {
            std::cmp::Ordering::Less
        } else if pb > pa * 1.15 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    };
    items.sort_by(|a, b| {
        b.favourite
            .cmp(&a.favourite)
            .then(clearly_bigger(a, b))
            .then(s(b).total_cmp(&s(a)))
            .then(px(b).cmp(&px(a)))
            .then(b.views.cmp(&a.views))
            .then(a.taken_at.cmp(&b.taken_at))
            .then(a.id.cmp(&b.id))
    });
}

fn find(p: &mut [usize], mut x: usize) -> usize {
    while p[x] != x {
        p[x] = p[p[x]];
        x = p[x];
    }
    x
}

/// What grouping needs, read from the library (so the slow part runs
/// without holding the library open for everyone else).
pub struct Data {
    items: Vec<Item>,
    fps: HashMap<i64, Fp>,
    means: HashMap<i64, Vec<f32>>,
}

pub fn load(conn: &Connection, smart: bool, folder: Option<i64>) -> R<Data> {
    Ok(Data {
        items: library::query_items(
            conn,
            &library::ItemFilter { folder: folder.map(Some), recursive: folder.is_some(), ..Default::default() },
        )?,
        fps: fingerprints(conn)?,
        means: if smart { meanings(conn)? } else { HashMap::new() },
    })
}

/// Groups of look-alikes, biggest group first, each with its best picture first.
///
/// Fingerprints: every pair within the limit is linked, so A~B and B~C put
/// A, B and C together (as in Baro Alarm). Smart search: each group is built
/// around one picture, so groups can't chain into one huge group.
pub fn group(data: Data, level: Level, smart: bool, videos: bool) -> Vec<Vec<Item>> {
    let Data { items, fps, means } = data;
    let sharp: HashMap<i64, f64> = fps.iter().map(|(id, f)| (*id, f.sharp)).collect();
    let wanted = |i: &Item| i.kind == "image" || i.kind == "gif" || (videos && i.kind == "video");
    let mut out: Vec<Vec<Item>> = Vec::new();
    if smart {
        let list: Vec<(Item, &Vec<f32>)> =
            items.into_iter().filter(|i| wanted(i)).filter_map(|i| means.get(&i.id).map(|v| (i, v))).collect();
        let t = level.meaning();
        let mut taken = vec![false; list.len()];
        for a in 0..list.len() {
            if taken[a] {
                continue;
            }
            let mut g = vec![a];
            for b in a + 1..list.len() {
                if !taken[b] && dot(list[a].1, list[b].1) >= t {
                    g.push(b);
                }
            }
            if g.len() > 1 {
                for &k in &g {
                    taken[k] = true;
                }
                out.push(g.into_iter().map(|k| list[k].0.clone()).collect());
            }
        }
    } else {
        let list: Vec<(Item, u64)> =
            items.into_iter().filter(|i| wanted(i)).filter_map(|i| fps.get(&i.id).map(|f| (i, f.hash))).collect();
        let max = level.bits();
        let mut parent: Vec<usize> = (0..list.len()).collect();
        for a in 0..list.len() {
            for b in a + 1..list.len() {
                if distance(list[a].1, list[b].1) <= max {
                    let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                    if ra != rb {
                        parent[rb] = ra;
                    }
                }
            }
        }
        let mut by_root: HashMap<usize, Vec<Item>> = HashMap::new();
        for (k, (item, _)) in list.into_iter().enumerate() {
            let r = find(&mut parent, k);
            by_root.entry(r).or_default().push(item);
        }
        out = by_root.into_values().filter(|g| g.len() > 1).collect();
    }
    for g in &mut out {
        best_first(g, &sharp);
    }
    out.sort_by(|a, b| b.len().cmp(&a.len()).then(a[0].id.cmp(&b[0].id)));
    out
}

#[cfg(test)]
fn groups(conn: &Connection, level: Level, smart: bool, folder: Option<i64>, videos: bool) -> R<Vec<Vec<Item>>> {
    Ok(group(load(conn, smart, folder)?, level, smart, videos))
}

/// Items that look like this one, most alike first (not including itself).
/// With `smart`, by what they show (falls back to the fingerprint if this
/// item hasn't been analysed for smart search yet).
pub fn similar_to(conn: &Connection, id: i64, smart: bool, limit: usize) -> R<Vec<Hit>> {
    let items = library::query_items(conn, &library::ItemFilter::default())?;
    let by_id: HashMap<i64, &Item> = items.iter().map(|i| (i.id, i)).collect();
    let visual = |i: &&&Item| i.kind == "image" || i.kind == "gif" || i.kind == "video";
    if smart {
        let means = meanings(conn)?;
        if let Some(q) = means.get(&id) {
            let mut scored: Vec<(i64, f32)> =
                means.iter().filter(|(k, _)| **k != id).map(|(k, v)| (*k, dot(q, v))).collect();
            scored.sort_by(|a, b| b.1.total_cmp(&a.1));
            // Unrelated pictures still score around 0.5–0.7; keep what is really
            // close, and near the best match.
            let cut = scored.first().map(|s| (s.1 - 0.10).max(0.72)).unwrap_or(1.0);
            let mut out = Vec::new();
            for (k, score) in scored {
                if out.len() >= limit || score < cut {
                    break;
                }
                if let Some(it) = by_id.get(&k).filter(visual) {
                    out.push(Hit { item: (*it).clone(), score });
                }
            }
            return Ok(out);
        }
    }
    let fps = fingerprints(conn)?;
    let Some(me) = fps.get(&id) else {
        return Err("This item doesn't have a fingerprint yet. It is made in the background; try again in a moment.".into());
    };
    let mut scored: Vec<(i64, u32)> = fps
        .iter()
        .filter(|(k, _)| **k != id)
        .map(|(k, f)| (*k, distance(me.hash, f.hash)))
        .filter(|(_, d)| *d <= 18)
        .collect();
    scored.sort_by_key(|&(k, d)| (d, k));
    Ok(scored
        .into_iter()
        .filter_map(|(k, d)| by_id.get(&k).filter(visual).map(|it| Hit { item: (*it).clone(), score: 1.0 - d as f32 / 64.0 }))
        .take(limit)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    fn add(conn: &Connection, name: &str, w: i64, fav: bool) -> i64 {
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id, width, height, favourite) \
             VALUES (lower(hex(randomblob(16))), NULL, 'image', ?1, 'jpg', 1, 'h', 0, 't', ?2, ?2, ?3)",
            params![name, w, fav as i64],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn groups_look_alikes_best_first() {
        let c = db::create_empty().unwrap();
        let a = add(&c, "a", 100, false);
        let b = add(&c, "b", 100, false);
        let cc = add(&c, "c", 100, false);
        let far = add(&c, "far", 100, false);
        let lone = add(&c, "lone", 100, false);
        assert_eq!(needed(&c, 10).unwrap().len(), 5);
        // a~b (4 bits), b~c (4 bits), a and c 8 bits apart: one group at "normal".
        save(&c, a, "0000000000000000", 10.0).unwrap();
        save(&c, b, "000000000000000f", 50.0).unwrap();
        save(&c, cc, "00000000000000ff", 20.0).unwrap();
        save(&c, far, "ffffffffffffffff", 1.0).unwrap();
        save(&c, lone, "zz", 1.0).unwrap(); // broken = failed
        assert!(needed(&c, 10).unwrap().is_empty());
        let st = status(&c).unwrap();
        assert_eq!((st.total, st.done), (5, 5));

        let g = groups(&c, Level::Normal, false, None, false).unwrap();
        assert_eq!(g.len(), 1);
        let ids: Vec<i64> = g[0].iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![b, cc, a], "sharpest first");
        // Strict: 4 bits is still within 5, so a~b~c still link.
        assert_eq!(groups(&c, Level::Strict, false, None, false).unwrap()[0].len(), 3);

        // A clearly bigger copy wins over a sharper-looking small one.
        c.execute("UPDATE media SET width = 400, height = 400 WHERE id = ?", [cc]).unwrap();
        assert_eq!(groups(&c, Level::Normal, false, None, false).unwrap()[0][0].id, cc);
        // A favourite wins over everything.
        c.execute("UPDATE media SET favourite = 1 WHERE id = ?", [a]).unwrap();
        assert_eq!(groups(&c, Level::Normal, false, None, false).unwrap()[0][0].id, a);

        let hits = similar_to(&c, a, false, 10).unwrap();
        assert_eq!(hits.iter().map(|h| h.item.id).collect::<Vec<_>>(), vec![b, cc]);

        reset(&c, a).unwrap();
        assert_eq!(needed(&c, 10).unwrap().len(), 1);
    }

    #[test]
    fn smart_groups_dont_chain() {
        let c = db::create_empty().unwrap();
        let ids: Vec<i64> = (0..3).map(|k| add(&c, &format!("p{k}"), 10, false)).collect();
        // p0·p1 and p1·p2 are alike, p0·p2 is not: smart groups are built around one picture.
        let v = |x: f32, y: f32| {
            let mut v = vec![0f32; clip::DIM];
            v[0] = x;
            v[1] = y;
            v
        };
        clip::save(&c, ids[0], &v(1.0, 0.0)).unwrap();
        clip::save(&c, ids[1], &v(0.96, 0.28)).unwrap();
        clip::save(&c, ids[2], &v(0.85, 0.53)).unwrap();
        let g = groups(&c, Level::Normal, true, None, false).unwrap();
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].len(), 2);
        let hits = similar_to(&c, ids[0], true, 10).unwrap();
        assert_eq!(hits[0].item.id, ids[1]);
    }
}
