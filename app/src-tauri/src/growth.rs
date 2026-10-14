//! How the vault grew: stored size by the month things were added, for the
//! chart on the Statistics page and the sparkline in Settings → Storage.
//!
//! Counted per stored file: free copies share one file, so they count once
//! (at the month the file first came in). Items in the trash still take
//! space until the trash is emptied, so they count too; what was deleted for
//! good is gone from the library and from the history.

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::library::R;

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrowthMonth {
    /// "2026-10" (local time)
    pub month: String,
    /// Files added that month and their size.
    pub items: i64,
    pub bytes: i64,
    /// Everything stored at the end of that month.
    pub total_items: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Growth {
    /// Oldest first, every month up to this one (gaps filled with zeros).
    pub months: Vec<GrowthMonth>,
    pub total_items: i64,
    pub total_bytes: i64,
    /// Added in the last 30 days.
    pub last30_items: i64,
    pub last30_bytes: i64,
    /// Of the total, what is only in the trash.
    pub trash_items: i64,
    pub trash_bytes: i64,
}

/// At most this many months are listed (older ones are summed into the start).
const MAX_MONTHS: usize = 240;

fn parse_month(m: &str) -> Option<(i32, u32)> {
    let (y, mo) = m.split_once('-')?;
    Some((y.parse().ok()?, mo.parse().ok()?))
}

fn next_month((y, m): (i32, u32)) -> (i32, u32) {
    if m >= 12 { (y + 1, 1) } else { (y, m + 1) }
}

pub fn growth(conn: &Connection, now: i64) -> R<Growth> {
    // One row per stored file: when it first came in, its size, and whether
    // every item using it is in the trash.
    const FILES: &str = "SELECT object_id, MIN(imported_at) AS first, MAX(size) AS size, \
                         MIN(deleted_at IS NOT NULL) AS trashed FROM media GROUP BY object_id";
    let since = now - 30 * 86_400;
    let mut st = conn
        .prepare(&format!(
            "SELECT strftime('%Y-%m', first, 'unixepoch', 'localtime') AS m, COUNT(*), IFNULL(SUM(size), 0), \
             IFNULL(SUM(first >= ?1), 0), IFNULL(SUM(CASE WHEN first >= ?1 THEN size ELSE 0 END), 0), \
             IFNULL(SUM(trashed), 0), IFNULL(SUM(CASE WHEN trashed THEN size ELSE 0 END), 0) \
             FROM ({FILES}) GROUP BY m ORDER BY m"
        ))
        .map_err(e)?;
    let rows = st
        .query_map(params![since], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    let this_month: String = conn
        .query_row("SELECT strftime('%Y-%m', ?1, 'unixepoch', 'localtime')", [now], |r| r.get(0))
        .map_err(e)?;

    let mut g = Growth { months: Vec::new(), total_items: 0, total_bytes: 0, last30_items: 0, last30_bytes: 0, trash_items: 0, trash_bytes: 0 };
    let mut added: Vec<((i32, u32), i64, i64)> = Vec::new();
    for (m, n, b, n30, b30, tn, tb) in rows {
        g.total_items += n;
        g.total_bytes += b;
        g.last30_items += n30;
        g.last30_bytes += b30;
        g.trash_items += tn;
        g.trash_bytes += tb;
        if let Some(k) = m.as_deref().and_then(parse_month) {
            added.push((k, n, b));
        }
    }
    let Some(&(first, ..)) = added.first() else { return Ok(g) };
    let last = parse_month(&this_month).unwrap_or(first).max(added.last().map_or(first, |a| a.0));

    let mut all = Vec::new();
    let (mut ti, mut tb) = (0, 0);
    let mut at = first;
    let mut k = 0;
    while at <= last {
        let (mut n, mut b) = (0, 0);
        while k < added.len() && added[k].0 == at {
            n += added[k].1;
            b += added[k].2;
            k += 1;
        }
        ti += n;
        tb += b;
        all.push(GrowthMonth { month: format!("{:04}-{:02}", at.0, at.1), items: n, bytes: b, total_items: ti, total_bytes: tb });
        at = next_month(at);
    }
    let skip = all.len().saturating_sub(MAX_MONTHS);
    g.months = all.split_off(skip);
    Ok(g)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    /// Mid-month, so no time zone can move it to another month.
    fn ts(y: i32, m: u32) -> i64 {
        let days_from_civil = |y: i32, m: u32, d: u32| -> i64 {
            let y = if m <= 2 { y - 1 } else { y } as i64;
            let era = y.div_euclid(400);
            let yoe = y - era * 400;
            let m = m as i64;
            let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
            let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
            era * 146_097 + doe - 719_468
        };
        days_from_civil(y, m, 15) * 86_400 + 12 * 3600
    }

    fn add(c: &Connection, obj: &str, size: i64, at: i64, copy_of: Option<i64>, deleted: bool) -> i64 {
        c.execute(
            "INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at, copy_of, deleted_at) \
             VALUES (?1, 'image', 'x.jpg', 'jpg', ?2, 'h', ?3, ?4, ?5)",
            params![obj, size, at, copy_of, deleted.then_some(at + 10)],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    #[test]
    fn grows_by_month_counting_shared_files_once_with_gaps_filled() {
        let c = db::create_empty().unwrap();
        let now = ts(2026, 4) + 5 * 86_400; // 20 April 2026
        let a = add(&c, "a", 1_000, ts(2026, 1), None, false);
        add(&c, "b", 500, ts(2026, 1), None, false);
        // A free copy made later shares a's file: it doesn't add space.
        add(&c, "a", 1_000, ts(2026, 3), Some(a), false);
        add(&c, "c", 2_000, ts(2026, 3), None, true); // in the trash: still on disk
        add(&c, "d", 4_000, now - 86_400, None, false); // yesterday
        let g = growth(&c, now).unwrap();
        let months: Vec<&str> = g.months.iter().map(|m| m.month.as_str()).collect();
        assert_eq!(months, ["2026-01", "2026-02", "2026-03", "2026-04"]);
        let per: Vec<(i64, i64, i64, i64)> = g.months.iter().map(|m| (m.items, m.bytes, m.total_items, m.total_bytes)).collect();
        assert_eq!(per, [(2, 1_500, 2, 1_500), (0, 0, 2, 1_500), (1, 2_000, 3, 3_500), (1, 4_000, 4, 7_500)]);
        assert_eq!((g.total_items, g.total_bytes), (4, 7_500));
        assert_eq!((g.last30_items, g.last30_bytes), (1, 4_000));
        assert_eq!((g.trash_items, g.trash_bytes), (1, 2_000));
    }

    #[test]
    fn a_file_in_the_trash_with_a_live_copy_is_not_trash_and_empty_vault_is_fine() {
        let c = db::create_empty().unwrap();
        let now = ts(2026, 6);
        assert_eq!(growth(&c, now).unwrap().months, vec![]);
        let a = add(&c, "a", 300, ts(2025, 11), None, true);
        add(&c, "a", 300, ts(2025, 11), Some(a), false);
        let g = growth(&c, now).unwrap();
        assert_eq!((g.total_items, g.trash_items), (1, 0));
        assert_eq!(g.months.first().unwrap().month, "2025-11");
        assert_eq!(g.months.last().unwrap().month, "2026-06", "runs up to this month");
        assert_eq!(g.months.len(), 8);
        assert!(g.months.iter().all(|m| m.total_bytes == 300));
    }

    #[test]
    fn very_old_dates_are_folded_into_the_start() {
        let c = db::create_empty().unwrap();
        add(&c, "old", 10, ts(1990, 1), None, false);
        add(&c, "new", 20, ts(2026, 1), None, false);
        let g = growth(&c, ts(2026, 2)).unwrap();
        assert_eq!(g.months.len(), MAX_MONTHS);
        assert_eq!(g.months[0].total_bytes, 10, "the old file is in the running total");
        assert_eq!(g.months.last().unwrap().total_bytes, 30);
        assert_eq!(next_month((2025, 12)), (2026, 1));
        assert_eq!(parse_month("2026-07"), Some((2026, 7)));
    }
}
