//! Deleting folders but keeping favourites and free copies (asked by the
//! user, 2026-11-27). Before folders go to the trash the window asks how many
//! "protected" items they hold: favourites, free copies (items with `copy_of`,
//! even when what they were copied from is gone) and originals that have a
//! free copy anywhere (not in the trash). When there are some, the user picks
//! "Keep them" or "Delete all" (library.rs `trash_folder`, as before).
//!
//! Keep them: everything else in the folders (and their subfolders) goes to
//! the trash with ONE stamp; the protected items stay where they are, and so
//! do the folders holding them (directly or deeper) with their own folder
//! chain. Subfolders with nothing kept go to the trash with the same stamp
//! (whole, so the trash shows and restores them as folders). A chosen folder
//! with nothing kept in it goes whole too. Undo (`untrash_stamp`) brings
//! back exactly what that stamp took.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params, params_from_iter, types::Value};
use serde::Serialize;
use tauri::State;

use crate::library::{self, R};
use crate::util::sql_err as e;
use crate::{Shared, edit_db, read_db};

/// What the folders hold that "Keep them" would keep (an item can be several of these; `total` counts it once).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Protected {
    pub favourites: i64,
    pub copies: i64,
    /// Originals with a free copy somewhere (not in the trash).
    pub originals: i64,
    pub total: i64,
}

/// What "Keep them" did: the stamp (for undo), how many items and folders went to the trash, how many items stayed.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptTrash {
    pub stamp: i64,
    pub items: i64,
    pub folders: i64,
    pub kept: i64,
    /// The folders that went to the trash (the window leaves them if one is open).
    pub gone: Vec<i64>,
}

/// The folders under `roots` (themselves included) that aren't in the trash, with their parents.
fn live_tree(conn: &Connection, roots: &[i64]) -> R<Vec<(i64, Option<i64>)>> {
    let all = library::descendants(conn, roots)?;
    let (ph, args) = library::id_list(&all);
    conn.prepare(&format!("SELECT id, parent_id FROM folders WHERE deleted_at IS NULL AND id IN ({ph})"))
        .map_err(e)?
        .query_map(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)
}

/// One live item in those folders: id, folder, favourite, free copy, original with a free copy.
struct Row {
    id: i64,
    folder: i64,
    fav: bool,
    copy: bool,
    original: bool,
}

impl Row {
    fn kept(&self) -> bool {
        self.fav || self.copy || self.original
    }
}

fn rows(conn: &Connection, folders: &[i64]) -> R<Vec<Row>> {
    if folders.is_empty() {
        return Ok(Vec::new());
    }
    let (ph, args) = library::id_list(folders);
    conn.prepare(&format!(
        "SELECT m.id, m.folder_id, IFNULL(m.favourite, 0) <> 0, m.copy_of IS NOT NULL, \
         EXISTS(SELECT 1 FROM media c WHERE c.copy_of = m.id AND c.deleted_at IS NULL) \
         FROM media m WHERE m.deleted_at IS NULL AND m.folder_id IN ({ph})"
    ))
    .map_err(e)?
    .query_map(params_from_iter(args), |r| Ok(Row { id: r.get(0)?, folder: r.get(1)?, fav: r.get(2)?, copy: r.get(3)?, original: r.get(4)? }))
    .map_err(e)?
    .collect::<rusqlite::Result<_>>()
    .map_err(e)
}

/// How many favourites and free copies (and originals with free copies) these folders hold, subfolders included.
pub fn protected_in(conn: &Connection, roots: &[i64]) -> R<Protected> {
    if roots.is_empty() {
        return Ok(Protected::default());
    }
    let tree = live_tree(conn, roots)?;
    let ids: Vec<i64> = tree.iter().map(|(id, _)| *id).collect();
    let mut p = Protected::default();
    for r in rows(conn, &ids)? {
        p.favourites += r.fav as i64;
        p.copies += r.copy as i64;
        p.originals += (r.original && !r.copy) as i64;
        p.total += r.kept() as i64;
    }
    Ok(p)
}

/// "Keep them": the folders' other items (and subfolders with nothing kept) to the trash with one stamp.
pub fn trash_keeping(conn: &Connection, roots: &[i64]) -> R<KeptTrash> {
    let tree = live_tree(conn, roots)?;
    if tree.is_empty() {
        return Err("That folder no longer exists.".into());
    }
    let parent: HashMap<i64, Option<i64>> = tree.iter().copied().collect();
    let ids: Vec<i64> = tree.iter().map(|(id, _)| *id).collect();
    let items = rows(conn, &ids)?;
    // The folders that stay: each kept item's folder and its chain up to the chosen folder.
    let chosen: HashSet<i64> = roots.iter().copied().collect();
    let mut stay: HashSet<i64> = HashSet::new();
    for r in items.iter().filter(|r| r.kept()) {
        let mut f = Some(r.folder);
        while let Some(id) = f {
            if !parent.contains_key(&id) || !stay.insert(id) || chosen.contains(&id) {
                break;
            }
            f = parent.get(&id).copied().flatten();
        }
    }
    let stamp = library::next_stamp(conn)?;
    let mut out = KeptTrash { stamp, ..Default::default() };
    let tx = conn.unchecked_transaction().map_err(e)?;
    {
        let mut st = tx.prepare("UPDATE media SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL").map_err(e)?;
        for r in &items {
            if r.kept() {
                out.kept += 1;
            } else {
                out.items += st.execute(params![stamp, r.id]).map_err(e)? as i64;
            }
        }
        let mut st = tx.prepare("UPDATE folders SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL").map_err(e)?;
        for id in ids.iter().filter(|id| !stay.contains(id)) {
            if st.execute(params![stamp, id]).map_err(e)? > 0 {
                out.folders += 1;
                out.gone.push(*id);
            }
        }
    }
    tx.commit().map_err(e)?;
    Ok(out)
}

/// Undo of `trash_keeping`: what that stamp took under these folders comes back (a subfolder whose
/// name was taken meanwhile gets " (restored)").
pub fn untrash_stamp(conn: &Connection, roots: &[i64], stamp: i64) -> R<()> {
    if roots.is_empty() {
        return Ok(());
    }
    let all = library::descendants(conn, roots)?;
    let (ph, args) = library::id_list(&all);
    let mut a = vec![Value::Integer(stamp)];
    a.extend(args);
    let back: Vec<(i64, Option<i64>, String)> = conn
        .prepare(&format!("SELECT id, parent_id, name FROM folders WHERE deleted_at = ? AND id IN ({ph})"))
        .map_err(e)?
        .query_map(params_from_iter(a.iter().cloned()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let coming: HashSet<i64> = back.iter().map(|(id, _, _)| *id).collect();
    let tx = conn.unchecked_transaction().map_err(e)?;
    // The top of each part that comes back: a free name next to what is there now.
    for (id, p, name) in back.iter().filter(|(_, p, _)| !p.is_some_and(|p| coming.contains(&p))) {
        let free = library::free_name(&tx, *p, name, *id)?;
        if &free != name {
            tx.execute("UPDATE folders SET name = ? WHERE id = ?", params![free, id]).map_err(e)?;
        }
    }
    tx.execute(&format!("UPDATE folders SET deleted_at = NULL WHERE deleted_at = ? AND id IN ({ph})"), params_from_iter(a.iter().cloned()))
        .map_err(e)?;
    tx.execute(&format!("UPDATE media SET deleted_at = NULL WHERE deleted_at = ? AND folder_id IN ({ph})"), params_from_iter(a))
        .map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(())
}

/// How many favourites and free copies these folders hold (asked before deleting them).
#[tauri::command]
pub(crate) async fn folders_protected(state: State<'_, Shared>, ids: Vec<i64>) -> Result<Protected, String> {
    read_db(state.inner(), move |c| protected_in(c, &ids)).await
}

/// Delete these folders but keep their favourites and free copies (and the folders holding them).
#[tauri::command]
pub(crate) async fn delete_folders_keeping(state: State<'_, Shared>, ids: Vec<i64>) -> Result<KeptTrash, String> {
    edit_db(state.inner(), move |c| trash_keeping(c, &ids)).await
}

/// Undo of "Keep them": what went to the trash with that stamp under these folders comes back.
#[tauri::command]
pub(crate) async fn restore_trashed(state: State<'_, Shared>, ids: Vec<i64>, stamp: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| untrash_stamp(c, &ids, stamp)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{create_folder, trash_view};
    use vault_core::db;

    fn add(conn: &Connection, name: &str, folder: Option<i64>) -> i64 {
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (lower(hex(randomblob(16))), ?1, 'image', ?2, 'jpg', 10, 'h', 0, 'thumb')",
            params![folder, name],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn gone(c: &Connection, id: i64) -> bool {
        c.query_row("SELECT deleted_at IS NOT NULL FROM media WHERE id = ?", [id], |r| r.get(0)).unwrap()
    }

    fn folder_gone(c: &Connection, id: i64) -> bool {
        c.query_row("SELECT deleted_at IS NOT NULL FROM folders WHERE id = ?", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn keep_mode_keeps_favourites_copies_and_their_folders() {
        let c = db::create_empty().unwrap();
        let top = create_folder(&c, None, "Trip").unwrap();
        let day1 = create_folder(&c, Some(top), "Day 1").unwrap();
        let deep = create_folder(&c, Some(day1), "Beach").unwrap();
        let day2 = create_folder(&c, Some(top), "Day 2").unwrap();
        let empty = create_folder(&c, Some(day2), "Empty").unwrap();
        let elsewhere = create_folder(&c, None, "Elsewhere").unwrap();
        let plain = add(&c, "plain", Some(top));
        let fav = add(&c, "fav", Some(deep));
        c.execute("UPDATE media SET favourite = 1 WHERE id = ?", [fav]).unwrap();
        let other = add(&c, "other", Some(deep));
        let d2 = add(&c, "d2", Some(day2));
        // An original here with a free copy outside, and a free copy here of something outside.
        let original = add(&c, "original", Some(day1));
        let outside_copy = add(&c, "copy outside", Some(elsewhere));
        c.execute("UPDATE media SET copy_of = ? WHERE id = ?", [original, outside_copy]).unwrap();
        let outside = add(&c, "outside", Some(elsewhere));
        let copy_here = add(&c, "copy here", Some(top));
        c.execute("UPDATE media SET copy_of = ? WHERE id = ?", [outside, copy_here]).unwrap();
        // A copy whose original was deleted for good is still a copy the user made.
        let orphan = add(&c, "orphan copy", Some(day2));
        c.execute("UPDATE media SET copy_of = 999999 WHERE id = ?", [orphan]).unwrap();

        let p = protected_in(&c, &[top]).unwrap();
        assert_eq!(p, Protected { favourites: 1, copies: 2, originals: 1, total: 4 });
        assert_eq!(protected_in(&c, &[elsewhere]).unwrap(), Protected { favourites: 0, copies: 1, originals: 1, total: 2 });

        let k = trash_keeping(&c, &[top]).unwrap();
        assert_eq!((k.items, k.kept, k.folders), (3, 4, 1));
        for id in [plain, other, d2] {
            assert!(gone(&c, id), "{id}");
        }
        for id in [fav, original, copy_here, orphan, outside, outside_copy] {
            assert!(!gone(&c, id), "{id}");
        }
        for f in [top, day1, deep, day2] {
            assert!(!folder_gone(&c, f), "{f} stays");
        }
        assert!(folder_gone(&c, empty), "nothing kept in it");
        assert_eq!(k.gone, vec![empty]);
        // The trash shows the emptied subfolder as a folder and the rest as items.
        let t = trash_view(&c).unwrap();
        assert_eq!(t.folders.iter().map(|f| f.id).collect::<Vec<_>>(), vec![empty]);
        assert_eq!(t.items.len(), 3);

        // Undo brings back exactly that.
        let before_other = add(&c, "trashed before", Some(day2));
        library::trash_items(&c, &[before_other]).unwrap();
        untrash_stamp(&c, &[top], k.stamp).unwrap();
        for id in [plain, other, d2] {
            assert!(!gone(&c, id), "{id}");
        }
        assert!(!folder_gone(&c, empty));
        assert!(gone(&c, before_other), "deleted another time: stays in the trash");
    }

    #[test]
    fn several_folders_one_stamp_and_a_folder_with_nothing_kept_goes_whole() {
        let c = db::create_empty().unwrap();
        let a = create_folder(&c, None, "A").unwrap();
        let b = create_folder(&c, None, "B").unwrap();
        let b1 = create_folder(&c, Some(b), "B1").unwrap();
        let fav = add(&c, "fav", Some(a));
        c.execute("UPDATE media SET favourite = 1 WHERE id = ?", [fav]).unwrap();
        let x = add(&c, "x", Some(a));
        let y = add(&c, "y", Some(b1));
        let k = trash_keeping(&c, &[a, b]).unwrap();
        assert_eq!((k.items, k.kept, k.folders), (2, 1, 2));
        assert!(!folder_gone(&c, a) && folder_gone(&c, b) && folder_gone(&c, b1));
        let stamps: HashSet<i64> = c
            .prepare("SELECT deleted_at FROM media WHERE id IN (?1, ?2) UNION SELECT deleted_at FROM folders WHERE id IN (?3, ?4)")
            .unwrap()
            .query_map(params![x, y, b, b1], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(stamps, HashSet::from([k.stamp]));
        // B can be brought back from the trash on its own, as a folder.
        library::restore_folder(&c, b).unwrap();
        assert!(!folder_gone(&c, b1) && !gone(&c, y));
        // Undo of the rest.
        untrash_stamp(&c, &[a, b], k.stamp).unwrap();
        assert!(!gone(&c, x));
    }

    #[test]
    fn a_name_taken_meanwhile_is_kept_apart_on_undo() {
        let c = db::create_empty().unwrap();
        let a = create_folder(&c, None, "A").unwrap();
        let sub = create_folder(&c, Some(a), "Sub").unwrap();
        let fav = add(&c, "fav", Some(a));
        c.execute("UPDATE media SET favourite = 1 WHERE id = ?", [fav]).unwrap();
        add(&c, "s", Some(sub));
        let k = trash_keeping(&c, &[a]).unwrap();
        assert!(folder_gone(&c, sub));
        let again = create_folder(&c, Some(a), "Sub").unwrap();
        untrash_stamp(&c, &[a], k.stamp).unwrap();
        let name: String = c.query_row("SELECT name FROM folders WHERE id = ?", [sub], |r| r.get(0)).unwrap();
        assert_eq!(name, "Sub (restored)");
        assert!(!folder_gone(&c, again));
        assert_eq!(protected_in(&c, &[]).unwrap(), Protected::default());
    }
}
