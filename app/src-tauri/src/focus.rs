//! What the window is showing (the open folder and the items on screen), so
//! background work (thumbnails, fingerprints, smart search, faces; the
//! native analysis pass and the window's own loops) does those first.

use std::sync::Mutex;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Focus {
    /// The open folder (None = the top level).
    pub folder: Option<i64>,
    /// Whether a folder is open at all (search results, People: only `ids`).
    pub in_folder: bool,
    /// Items on screen.
    pub ids: Vec<i64>,
}

/// At most this many items on screen are put first.
const MAX_IDS: usize = 400;

static FOCUS: Mutex<Option<Focus>> = Mutex::new(None);

pub fn set(f: Option<Focus>) {
    *FOCUS.lock().unwrap_or_else(|x| x.into_inner()) = f.map(|mut f| {
        f.ids.truncate(MAX_IDS);
        f
    });
}

/// The start of an ORDER BY over media rows ("…, " or nothing): items on
/// screen first, then the rest of the open folder.
pub fn order() -> String {
    order_for(FOCUS.lock().unwrap_or_else(|x| x.into_inner()).as_ref())
}

pub fn order_for(f: Option<&Focus>) -> String {
    let Some(f) = f else { return String::new() };
    let mut parts = Vec::new();
    if !f.ids.is_empty() {
        // Only numbers go into the SQL.
        let list = f.ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        parts.push(format!("WHEN id IN ({list}) THEN 0"));
    }
    if f.in_folder {
        parts.push(format!("WHEN IFNULL(folder_id, 0) = {} THEN 1", f.folder.unwrap_or(0)));
    }
    if parts.is_empty() {
        return String::new();
    }
    format!("CASE {} ELSE 2 END, ", parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn items_on_screen_then_the_folder_come_first() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE media(id INTEGER PRIMARY KEY, folder_id INTEGER); \
             INSERT INTO media VALUES (1, NULL), (2, 5), (3, 5), (4, 7), (5, NULL), (6, 7);",
        )
        .unwrap();
        let ids = |f: Option<&Focus>| -> Vec<i64> {
            c.prepare(&format!("SELECT id FROM media ORDER BY {}id DESC", order_for(f)))
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        assert_eq!(ids(None), vec![6, 5, 4, 3, 2, 1]);
        let f = Focus { folder: Some(5), in_folder: true, ids: vec![4] };
        assert_eq!(ids(Some(&f)), vec![4, 3, 2, 6, 5, 1]);
        let top = Focus { folder: None, in_folder: true, ids: vec![] };
        assert_eq!(ids(Some(&top)), vec![5, 1, 6, 4, 3, 2]);
        let search = Focus { folder: None, in_folder: false, ids: vec![2, 6] };
        assert_eq!(ids(Some(&search)), vec![6, 2, 5, 4, 3, 1]);
        assert_eq!(order_for(Some(&Focus::default())), "");
    }
}
