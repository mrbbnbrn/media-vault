//! "Don't make preview clips here": folders whose videos get no preview
//! clips (frame strips and tiny clips), subfolders included. Kept as a list
//! of folder ids in the library's settings (no new columns), like face
//! search off per folder (faces.rs). Clips already made stay; Settings →
//! Storage can delete them.

use rusqlite::{Connection, OptionalExtension, params};

use crate::library;

type R<T> = Result<T, String>;

const OFF_KEY: &str = "previews_off_folders";

/// The folders where preview clips were turned off (not their subfolders).
pub fn off_folders(conn: &Connection) -> R<Vec<i64>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?", [OFF_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(raw.and_then(|j| serde_json::from_str::<Vec<i64>>(&j).ok()).unwrap_or_default())
}

/// " AND IFNULL(folder_id, -1) NOT IN (…)" for the preview queue: those
/// folders and everything inside them (empty when clips are made everywhere).
pub fn off_sql(conn: &Connection) -> R<String> {
    let roots = off_folders(conn)?;
    if roots.is_empty() {
        return Ok(String::new());
    }
    let tree = library::descendants(conn, &roots)?;
    Ok(format!(" AND IFNULL(folder_id, -1) NOT IN ({})", crate::util::id_list(&tree)))
}

/// Turn preview clips off (or on again) for these folders.
pub fn set_off(conn: &Connection, folders: &[i64], off: bool) -> R<()> {
    let mut list = off_folders(conn)?;
    list.retain(|f| !folders.contains(f));
    if off {
        list.extend_from_slice(folders);
    }
    list.sort_unstable();
    list.dedup();
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![OFF_KEY, serde_json::to_string(&list).map_err(|x| x.to_string())?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    #[test]
    fn off_folders_and_their_subfolders_are_left_out() {
        let c = db::create_empty().unwrap();
        let top = library::create_folder(&c, None, "Top").unwrap();
        let sub = library::create_folder(&c, Some(top), "Sub").unwrap();
        let other = library::create_folder(&c, None, "Other").unwrap();
        assert_eq!(off_sql(&c).unwrap(), "");
        set_off(&c, &[top], true).unwrap();
        let sql = off_sql(&c).unwrap();
        assert!(sql.contains(&top.to_string()) && sql.contains(&sub.to_string()) && !sql.contains(&format!(" {other}")), "{sql}");
        set_off(&c, &[top, other], true).unwrap();
        assert_eq!(off_folders(&c).unwrap(), vec![top, other]);
        set_off(&c, &[top], false).unwrap();
        assert_eq!(off_folders(&c).unwrap(), vec![other]);
    }
}
