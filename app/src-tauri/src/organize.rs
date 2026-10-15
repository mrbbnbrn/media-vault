//! Organising the library: free copies and real copies, merging folders,
//! your own folder order, tag management, notes, "continue watching" and
//! where-should-this-go suggestions for quick sort.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use vault_core::{ObjectId, ObjectKind};

use crate::faces;
use crate::library::{self, Item, R};
use crate::session::Session;

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

/// The columns an item copy takes over (everything except id, object ids,
/// folder, name, the trash and the copy link).
const COPY_COLS: &str = "kind, ext, size, width, height, duration_ms, has_audio, sha256, imported_at, favourite, weight, \
    taken_at, file_mtime, phash, sharpness, phash_state, note, sketch";

fn copy_tags(conn: &Connection, from: i64, to: i64) -> R<()> {
    conn.execute("INSERT OR IGNORE INTO media_tags(media_id, tag_id) SELECT ?2, tag_id FROM media_tags WHERE media_id = ?1", params![from, to])
        .map_err(e)?;
    Ok(())
}

// ---- free copies ---------------------------------------------------------------------------

/// The original an item belongs to (itself if it is one).
fn original_of(conn: &Connection, id: i64) -> R<i64> {
    let c: Option<i64> = conn
        .query_row("SELECT copy_of FROM media WHERE id = ?", [id], |r| r.get(0))
        .optional()
        .map_err(e)?
        .ok_or("That item no longer exists.")?;
    Ok(c.unwrap_or(id))
}

/// "Free copy to…": new items in `folder` that share the stored files of
/// `ids` (no extra space). Returns the new ids.
pub fn free_copy(conn: &Connection, ids: &[i64], folder: Option<i64>) -> R<Vec<i64>> {
    let tx = conn.unchecked_transaction().map_err(e)?;
    let mut out = Vec::new();
    for &id in ids {
        let orig = original_of(&tx, id)?;
        tx.execute(
            &format!(
                "INSERT INTO media(object_id, thumb_object_id, preview_object_id, tiny_object_id, folder_id, original_name, copy_of, clip_state, faces_state, faces_model, {COPY_COLS}) \
                 SELECT object_id, thumb_object_id, preview_object_id, tiny_object_id, ?2, original_name, ?3, clip_state, faces_state, faces_model, {COPY_COLS} FROM media WHERE id = ?1"
            ),
            params![id, folder, orig],
        )
        .map_err(e)?;
        let new_id = tx.last_insert_rowid();
        copy_tags(&tx, id, new_id)?;
        // What the app already found out about the picture applies to the copy too.
        tx.execute("INSERT INTO clip(media_id, vec, f16) SELECT ?2, vec, f16 FROM clip WHERE media_id = ?1", params![id, new_id]).map_err(e)?;
        tx.execute(
            "INSERT INTO faces(media_id, frame_ms, x, y, w, h, score, descriptor, person_id, model, auto, named_at, hidden) \
             SELECT ?2, frame_ms, x, y, w, h, score, descriptor, person_id, model, auto, named_at, hidden FROM faces WHERE media_id = ?1",
            params![id, new_id],
        )
        .map_err(e)?;
        out.push(new_id);
    }
    tx.commit().map_err(e)?;
    Ok(out)
}

/// The other items sharing this item's stored file (original first).
pub fn copies_of(conn: &Connection, id: i64) -> R<Vec<Item>> {
    let obj: String = conn.query_row("SELECT object_id FROM media WHERE id = ?", [id], |r| r.get(0)).map_err(e)?;
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM media WHERE object_id = ? AND id <> ? AND deleted_at IS NULL ORDER BY copy_of IS NOT NULL, id")
        .map_err(e)?
        .query_map(params![obj, id], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    ids.into_iter().map(|i| library::get_item(conn, i)).collect()
}

/// Free copies (not in the trash) of these originals: (original, its copies).
pub fn free_copies_of(conn: &Connection, originals: &[i64]) -> R<Vec<(i64, Vec<Item>)>> {
    let mut out = Vec::new();
    for &o in originals {
        let ids: Vec<i64> = conn
            .prepare("SELECT id FROM media WHERE copy_of = ? AND deleted_at IS NULL ORDER BY id")
            .map_err(e)?
            .query_map([o], |r| r.get(0))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        if !ids.is_empty() {
            out.push((o, ids.into_iter().map(|i| library::get_item(conn, i)).collect::<R<Vec<_>>>()?));
        }
    }
    Ok(out)
}

/// Links before a promotion, so it can be undone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Links {
    pub items: Vec<(i64, Option<i64>)>,
}

/// Make the free copy `new` the original of `old`'s file: the other free
/// copies point at it, and `old` becomes a free copy of it (so if it comes
/// back from the trash there is still just one original).
pub fn promote(conn: &Connection, old: i64, new: i64) -> R<Links> {
    let obj: String = conn.query_row("SELECT object_id FROM media WHERE id = ?", [old], |r| r.get(0)).map_err(e)?;
    let before: Vec<(i64, Option<i64>)> = conn
        .prepare("SELECT id, copy_of FROM media WHERE object_id = ?")
        .map_err(e)?
        .query_map([&obj], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    if !before.iter().any(|(i, _)| *i == new) {
        return Err("That isn't a free copy of this item.".into());
    }
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute("UPDATE media SET copy_of = ?1 WHERE object_id = ?2 AND id <> ?1", params![new, obj]).map_err(e)?;
    tx.execute("UPDATE media SET copy_of = NULL WHERE id = ?", [new]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(Links { items: before })
}

pub fn restore_links(conn: &Connection, links: &Links) -> R<()> {
    let tx = conn.unchecked_transaction().map_err(e)?;
    for (id, c) in &links.items {
        tx.execute("UPDATE media SET copy_of = ? WHERE id = ?", params![c, id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(())
}

// ---- real copies (Ctrl+C / Ctrl+V) ------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Copied {
    pub items: Vec<i64>,
    pub folders: Vec<i64>,
}

/// Re-encrypt a stored file as a new, independent one.
fn duplicate_object(s: &Session, kind: ObjectKind, hex: &str) -> Result<String, String> {
    let id = ObjectId::from_hex(hex).map_err(|x| x.to_string())?;
    let reader = s.vault().open_object(kind, &id).map_err(|x| x.to_string())?;
    let (new, _) = s.vault().add_object(kind, reader).map_err(|x| x.to_string())?;
    Ok(new.to_hex())
}

fn copy_one(s: &Session, id: i64, folder: Option<i64>) -> Result<i64, String> {
    let (obj, thumb, preview, tiny): (String, Option<String>, Option<String>, Option<String>) = s
        .db()
        .query_row("SELECT object_id, thumb_object_id, preview_object_id, tiny_object_id FROM media WHERE id = ?", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(e)?;
    let new_obj = duplicate_object(s, ObjectKind::Media, &obj)?;
    let dup = |o: Option<String>| -> Option<String> {
        match o.as_deref() {
            Some("") => Some(String::new()),
            Some(x) => duplicate_object(s, ObjectKind::Thumbnail, x).ok(),
            None => None,
        }
    };
    let new_thumb = dup(thumb);
    let new_preview = dup(preview);
    let new_tiny = dup(tiny);
    let db = s.db();
    db.execute(
        &format!(
            "INSERT INTO media(object_id, thumb_object_id, preview_object_id, tiny_object_id, folder_id, original_name, {COPY_COLS}) \
             SELECT ?2, ?3, ?4, ?6, ?5, original_name, {COPY_COLS} FROM media WHERE id = ?1"
        ),
        params![id, new_obj, new_thumb, new_preview, folder, new_tiny],
    )
    .map_err(e)?;
    let new_id = db.last_insert_rowid();
    copy_tags(&db, id, new_id)?;
    Ok(new_id)
}

/// Real copies of items and folders (with everything inside) into `target`.
/// Folder names that are taken get " (2)". Undo = trash what was made.
pub fn copy_into(s: &Session, ids: &[i64], folders: &[i64], target: Option<i64>, progress: &mut dyn FnMut(usize, usize)) -> Result<Copied, String> {
    // Refuse copying a folder into itself.
    if let Some(t) = target {
        let inside = library::descendants(&s.db(), folders)?;
        if inside.contains(&t) {
            return Err("A folder can't be copied into itself.".into());
        }
    }
    let total = {
        let db = s.db();
        let all = library::descendants(&db, folders)?;
        let (ph, args) = library::id_list(&all);
        let n: i64 = if all.is_empty() {
            0
        } else {
            db.query_row(&format!("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND folder_id IN ({ph})"), params_from_iter(args), |r| r.get(0))
                .map_err(e)?
        };
        ids.len() + n as usize
    };
    let mut out = Copied::default();
    let mut done = 0;
    for &id in ids {
        out.items.push(copy_one(s, id, target)?);
        done += 1;
        progress(done, total);
    }
    for &f in folders {
        copy_folder(s, f, target, &mut out, &mut done, total, progress)?;
    }
    s.mark_dirty();
    Ok(out)
}

fn copy_folder(
    s: &Session,
    f: i64,
    parent: Option<i64>,
    out: &mut Copied,
    done: &mut usize,
    total: usize,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<(), String> {
    let (name, color, emoji): (String, Option<String>, Option<String>) = s
        .db()
        .query_row("SELECT name, color, emoji FROM folders WHERE id = ?", [f], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(e)?;
    let new_f = {
        let db = s.db();
        let free = library::free_name(&db, parent, &name, -1)?;
        let id = library::create_folder(&db, parent, &free)?;
        db.execute("UPDATE folders SET color = ?, emoji = ? WHERE id = ?", params![color, emoji, id]).map_err(e)?;
        db.execute("INSERT OR IGNORE INTO folder_tags(folder_id, tag_id) SELECT ?2, tag_id FROM folder_tags WHERE folder_id = ?1", params![f, id])
            .map_err(e)?;
        id
    };
    if parent.is_none() || !out.folders.iter().any(|x| Some(*x) == parent) {
        out.folders.push(new_f);
    }
    let (items, kids): (Vec<i64>, Vec<i64>) = {
        let db = s.db();
        let items = db
            .prepare("SELECT id FROM media WHERE folder_id = ? AND deleted_at IS NULL ORDER BY id")
            .map_err(e)?
            .query_map([f], |r| r.get(0))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        let kids = db
            .prepare("SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order, name COLLATE NOCASE")
            .map_err(e)?
            .query_map([f], |r| r.get(0))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        (items, kids)
    };
    for id in items {
        copy_one(s, id, Some(new_f))?;
        *done += 1;
        progress(*done, total);
    }
    for k in kids {
        copy_folder(s, k, Some(new_f), out, done, total, progress)?;
    }
    Ok(())
}

// ---- merging folders ------------------------------------------------------------------------

fn child_named(conn: &Connection, parent: i64, name: &str) -> R<Option<i64>> {
    library::find_child(conn, Some(parent), name)
}

/// Where each item of the merged folders ends up, keyed by destination folder.
fn plan_dest(conn: &Connection, src: i64, dst: i64, out: &mut HashMap<i64, Vec<i64>>) -> R<()> {
    let items: Vec<i64> = conn
        .prepare("SELECT id FROM media WHERE folder_id = ? AND deleted_at IS NULL")
        .map_err(e)?
        .query_map([src], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    out.entry(dst).or_default().extend(items);
    let kids: Vec<(i64, String)> = conn
        .prepare("SELECT id, name FROM folders WHERE parent_id = ? AND deleted_at IS NULL")
        .map_err(e)?
        .query_map([src], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    for (k, name) in kids {
        // A same-named folder in the destination merges; the others move as they are.
        match child_named(conn, dst, &name)? {
            Some(d) if d != k => plan_dest(conn, k, d, out)?,
            _ => {}
        }
    }
    Ok(())
}

fn check_merge(conn: &Connection, target: i64, sources: &[i64]) -> R<()> {
    if sources.is_empty() {
        return Err("Choose at least one other folder to merge.".into());
    }
    let below_target = library::descendants(conn, &[target])?;
    let below_sources = library::descendants(conn, sources)?;
    if sources.iter().any(|s| *s == target || below_target.contains(s)) || below_sources.contains(&target) {
        return Err("A folder can't be merged with a folder inside it.".into());
    }
    Ok(())
}

/// Groups of identical files (same content) that would end up in the same
/// folder after merging, best first. Empty = nothing to ask.
pub fn merge_plan(conn: &Connection, target: i64, sources: &[i64]) -> R<Vec<Vec<Item>>> {
    check_merge(conn, target, sources)?;
    let mut dest: HashMap<i64, Vec<i64>> = HashMap::new();
    // What's already in the target (and its subfolders) counts too.
    for f in library::descendants(conn, &[target])? {
        let items: Vec<i64> = conn
            .prepare("SELECT id FROM media WHERE folder_id = ? AND deleted_at IS NULL")
            .map_err(e)?
            .query_map([f], |r| r.get(0))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        dest.entry(f).or_default().extend(items);
    }
    for &s in sources {
        plan_dest(conn, s, target, &mut dest)?;
    }
    let mut groups = Vec::new();
    for (_, ids) in dest {
        let mut by_sha: HashMap<String, Vec<i64>> = HashMap::new();
        for id in ids {
            let sha: String = conn.query_row("SELECT sha256 FROM media WHERE id = ?", [id], |r| r.get(0)).map_err(e)?;
            by_sha.entry(sha).or_default().push(id);
        }
        for (_, g) in by_sha {
            let mut g: Vec<i64> = g.into_iter().collect::<HashSet<_>>().into_iter().collect();
            if g.len() > 1 {
                g.sort();
                let mut items = g.into_iter().map(|i| library::get_item(conn, i)).collect::<R<Vec<_>>>()?;
                crate::similar::rank_best(conn, &mut items)?;
                groups.push(items);
            }
        }
    }
    groups.sort_by(|a, b| b.len().cmp(&a.len()).then(a[0].id.cmp(&b[0].id)));
    Ok(groups)
}

/// Everything a merge changed, so it can be undone.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Merged {
    pub items: Vec<(i64, Option<i64>)>,
    pub folders: Vec<(i64, Option<i64>)>,
    /// Emptied folders that went to the trash.
    pub emptied: Vec<i64>,
    /// Identical files you chose to trash.
    pub trashed: Vec<i64>,
}

fn merge_into(conn: &Connection, src: i64, dst: i64, m: &mut Merged) -> R<()> {
    let items: Vec<i64> = conn
        .prepare("SELECT id FROM media WHERE folder_id = ? AND deleted_at IS NULL")
        .map_err(e)?
        .query_map([src], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    for id in items {
        conn.execute("UPDATE media SET folder_id = ? WHERE id = ?", params![dst, id]).map_err(e)?;
        m.items.push((id, Some(src)));
    }
    let kids: Vec<(i64, String)> = conn
        .prepare("SELECT id, name FROM folders WHERE parent_id = ? AND deleted_at IS NULL")
        .map_err(e)?
        .query_map([src], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    for (k, name) in kids {
        match child_named(conn, dst, &name)? {
            Some(d) if d != k => merge_into(conn, k, d, m)?,
            _ => {
                conn.execute("UPDATE folders SET parent_id = ? WHERE id = ?", params![dst, k]).map_err(e)?;
                m.folders.push((k, Some(src)));
            }
        }
    }
    library::trash_folder(conn, src)?;
    m.emptied.push(src);
    Ok(())
}

/// Merge `sources` into `target`; same-named subfolders merge too. `trash`
/// = identical files you chose not to keep.
pub fn merge(conn: &Connection, target: i64, sources: &[i64], trash: &[i64]) -> R<Merged> {
    check_merge(conn, target, sources)?;
    // (Not one transaction: the trash helpers use their own.)
    let mut m = Merged::default();
    for &s in sources {
        merge_into(conn, s, target, &mut m)?;
    }
    if !trash.is_empty() {
        library::trash_items(conn, trash)?;
        m.trashed = trash.to_vec();
    }
    Ok(m)
}

pub fn unmerge(conn: &Connection, m: &Merged) -> R<()> {
    let tx = conn;
    for f in m.emptied.iter().rev() {
        library::restore_folder(tx, *f)?;
    }
    for (f, p) in &m.folders {
        tx.execute("UPDATE folders SET parent_id = ? WHERE id = ?", params![p, f]).map_err(e)?;
    }
    for (i, f) in &m.items {
        tx.execute("UPDATE media SET folder_id = ? WHERE id = ?", params![f, i]).map_err(e)?;
    }
    if !m.trashed.is_empty() {
        library::restore_items(tx, &m.trashed)?;
    }
    Ok(())
}

// ---- your own folder order -----------------------------------------------------------------

/// Put these folders (siblings) in this order; returns the old order values.
pub fn set_order(conn: &Connection, ids: &[i64]) -> R<Vec<(i64, i64)>> {
    let tx = conn.unchecked_transaction().map_err(e)?;
    let mut before = Vec::new();
    for (k, id) in ids.iter().enumerate() {
        let old: i64 = tx.query_row("SELECT sort_order FROM folders WHERE id = ?", [id], |r| r.get(0)).map_err(e)?;
        before.push((*id, old));
        tx.execute("UPDATE folders SET sort_order = ? WHERE id = ?", params![k as i64 + 1, id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(before)
}

pub fn restore_order(conn: &Connection, before: &[(i64, i64)]) -> R<()> {
    for (id, o) in before {
        conn.execute("UPDATE folders SET sort_order = ? WHERE id = ?", params![o, id]).map_err(e)?;
    }
    Ok(())
}

// ---- tags -----------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub color: Option<String>,
    pub items: i64,
    pub folders: i64,
}

pub fn tag_list(conn: &Connection) -> R<Vec<TagInfo>> {
    conn.prepare(
        "SELECT t.name, t.color, (SELECT COUNT(*) FROM media_tags mt JOIN media m ON m.id = mt.media_id WHERE mt.tag_id = t.id AND m.deleted_at IS NULL), \
         (SELECT COUNT(*) FROM folder_tags ft WHERE ft.tag_id = t.id) FROM tags t ORDER BY t.name COLLATE NOCASE",
    )
    .map_err(e)?
    .query_map([], |r| Ok(TagInfo { name: r.get(0)?, color: r.get(1)?, items: r.get(2)?, folders: r.get(3)? }))
    .map_err(e)?
    .collect::<rusqlite::Result<_>>()
    .map_err(e)
}

/// Who had a tag, so deleting or merging it can be undone.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagUse {
    pub name: String,
    pub color: Option<String>,
    pub items: Vec<i64>,
    pub folders: Vec<i64>,
}

fn tag_use(conn: &Connection, name: &str) -> R<Option<(i64, TagUse)>> {
    let Some((id, real, color)) = conn
        .query_row("SELECT id, name, color FROM tags WHERE name = ? COLLATE NOCASE", [name], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(e)?
    else {
        return Ok(None);
    };
    let ids = |sql: &str| -> R<Vec<i64>> {
        conn.prepare(sql).map_err(e)?.query_map([id], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<_>>().map_err(e)
    };
    Ok(Some((
        id,
        TagUse {
            name: real,
            color,
            items: ids("SELECT media_id FROM media_tags WHERE tag_id = ?")?,
            folders: ids("SELECT folder_id FROM folder_tags WHERE tag_id = ?")?,
        },
    )))
}

/// Rename a tag; if the new name exists, the two are merged.
pub fn rename_tag(conn: &Connection, old: &str, new: &str) -> R<TagUse> {
    let new = new.trim().trim_start_matches('#').trim();
    if new.is_empty() {
        return Err("Give the tag a name.".into());
    }
    let (id, before) = tag_use(conn, old)?.ok_or("That tag doesn't exist any more.")?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    let other: Option<i64> = tx
        .query_row("SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id <> ?", params![new, id], |r| r.get(0))
        .optional()
        .map_err(e)?;
    if let Some(o) = other {
        tx.execute("INSERT OR IGNORE INTO media_tags(media_id, tag_id) SELECT media_id, ?2 FROM media_tags WHERE tag_id = ?1", params![id, o]).map_err(e)?;
        tx.execute("INSERT OR IGNORE INTO folder_tags(folder_id, tag_id) SELECT folder_id, ?2 FROM folder_tags WHERE tag_id = ?1", params![id, o]).map_err(e)?;
        tx.execute("DELETE FROM media_tags WHERE tag_id = ?", [id]).map_err(e)?;
        tx.execute("DELETE FROM folder_tags WHERE tag_id = ?", [id]).map_err(e)?;
        tx.execute("DELETE FROM tags WHERE id = ?", [id]).map_err(e)?;
    } else {
        tx.execute("UPDATE tags SET name = ? WHERE id = ?", params![new, id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(before)
}

pub fn delete_tag(conn: &Connection, name: &str) -> R<TagUse> {
    let (id, before) = tag_use(conn, name)?.ok_or("That tag doesn't exist any more.")?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute("DELETE FROM media_tags WHERE tag_id = ?", [id]).map_err(e)?;
    tx.execute("DELETE FROM folder_tags WHERE tag_id = ?", [id]).map_err(e)?;
    tx.execute("DELETE FROM tags WHERE id = ?", [id]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(before)
}

/// Undo a delete or rename: the tag (with its colour) is back on exactly
/// what had it. `current` = its name now (after a rename), if any.
pub fn restore_tag(conn: &Connection, u: &TagUse, current: Option<&str>) -> R<()> {
    let tx = conn.unchecked_transaction().map_err(e)?;
    if let Some(c) = current
        && let Some((cid, now)) = tag_use(&tx, c)?
    {
        // Take the tag off what only got it through the rename/merge.
        for i in now.items.iter().filter(|i| u.items.contains(i)) {
            tx.execute("DELETE FROM media_tags WHERE media_id = ? AND tag_id = ?", params![i, cid]).map_err(e)?;
        }
        for f in now.folders.iter().filter(|f| u.folders.contains(f)) {
            tx.execute("DELETE FROM folder_tags WHERE folder_id = ? AND tag_id = ?", params![f, cid]).map_err(e)?;
        }
        let left: i64 = tx
            .query_row("SELECT (SELECT COUNT(*) FROM media_tags WHERE tag_id = ?1) + (SELECT COUNT(*) FROM folder_tags WHERE tag_id = ?1)", [cid], |r| r.get(0))
            .map_err(e)?;
        if left == 0 {
            tx.execute("DELETE FROM tags WHERE id = ?", [cid]).map_err(e)?;
        }
    }
    tx.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", [&u.name]).map_err(e)?;
    let id: i64 = tx.query_row("SELECT id FROM tags WHERE name = ? COLLATE NOCASE", [&u.name], |r| r.get(0)).map_err(e)?;
    tx.execute("UPDATE tags SET name = ?, color = ? WHERE id = ?", params![u.name, u.color, id]).map_err(e)?;
    for i in &u.items {
        tx.execute("INSERT OR IGNORE INTO media_tags(media_id, tag_id) VALUES (?, ?)", params![i, id]).map_err(e)?;
    }
    for f in &u.folders {
        tx.execute("INSERT OR IGNORE INTO folder_tags(folder_id, tag_id) VALUES (?, ?)", params![f, id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(())
}

pub fn set_tag_color(conn: &Connection, name: &str, color: Option<&str>) -> R<Option<String>> {
    let c = color.filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()));
    let old: Option<String> = conn
        .query_row("SELECT color FROM tags WHERE name = ? COLLATE NOCASE", [name], |r| r.get(0))
        .optional()
        .map_err(e)?
        .flatten();
    conn.execute("UPDATE tags SET color = ? WHERE name = ? COLLATE NOCASE", params![c, name]).map_err(e)?;
    Ok(old)
}

// ---- notes ----------------------------------------------------------------------------------

/// Set a note on an item or folder; returns the old one (for undo).
pub fn set_note(conn: &Connection, folder: bool, id: i64, note: Option<&str>) -> R<Option<String>> {
    let table = if folder { "folders" } else { "media" };
    let note = note.map(str::trim).filter(|n| !n.is_empty());
    if note.is_some_and(|n| n.chars().count() > 5000) {
        return Err("That note is too long (5,000 characters at most).".into());
    }
    let old: Option<String> = conn
        .query_row(&format!("SELECT note FROM {table} WHERE id = ?"), [id], |r| r.get(0))
        .map_err(e)?;
    conn.execute(&format!("UPDATE {table} SET note = ? WHERE id = ?"), params![note, id]).map_err(e)?;
    Ok(old)
}

pub fn folder_note(conn: &Connection, id: i64) -> R<Option<String>> {
    conn.query_row("SELECT note FROM folders WHERE id = ?", [id], |r| r.get(0)).map_err(e)
}

// ---- continue watching ---------------------------------------------------------------------

pub fn continue_watching(conn: &Connection) -> R<Vec<Item>> {
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM media WHERE resume_ms IS NOT NULL AND deleted_at IS NULL ORDER BY IFNULL(last_viewed_at, 0) DESC LIMIT 200")
        .map_err(e)?
        .query_map([], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    ids.into_iter().map(|i| library::get_item(conn, i)).collect()
}

// ---- quick sort suggestions ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub folder: i64,
    /// "face" (a person recognised) or "look" (looks like that folder's pictures).
    pub reason: String,
    pub score: f32,
}

fn mean(vs: &[Vec<f32>]) -> Option<Vec<f32>> {
    let first = vs.first()?;
    let dim = first.len();
    let mut m = vec![0f32; dim];
    for v in vs.iter().filter(|v| v.len() == dim) {
        for (a, b) in m.iter_mut().zip(v) {
            *a += b;
        }
    }
    let n = m.iter().map(|x| x * x).sum::<f32>().sqrt();
    (n > 1e-6).then(|| m.iter().map(|x| x / n).collect())
}

/// Where this item probably belongs: person folders of recognised faces,
/// then folders whose pictures look like it (smart search). Best first.
pub fn suggest(conn: &Connection, item: i64) -> R<Vec<Suggestion>> {
    let here: Option<i64> = conn.query_row("SELECT folder_id FROM media WHERE id = ?", [item], |r| r.get(0)).map_err(e)?;
    let mut out: Vec<Suggestion> = Vec::new();
    // Faces: people recognised in it, else the person its faces are most like.
    for (p, score) in faces::person_matches(conn, item)? {
        out.push(Suggestion { folder: p, reason: "face".into(), score });
    }
    // Looks: compare with the average picture of each folder.
    // Vectors from memory (clip.rs keeps them all).
    let mine = crate::clip::with_index(conn, |idx| idx.vectors(item))?.unwrap_or_default();
    if let Some(me) = mean(&mine.chunks(crate::clip::DIM).map(|c| c.to_vec()).collect::<Vec<_>>()) {
        let folder_of: HashMap<i64, i64> = conn
            .prepare("SELECT id, folder_id FROM media WHERE deleted_at IS NULL AND folder_id IS NOT NULL AND id <> ?")
            .map_err(e)?
            .query_map([item], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
        let rows: Vec<(i64, Vec<f32>)> = crate::clip::with_index(conn, |idx| {
            idx.ids().filter_map(|id| Some((*folder_of.get(&id)?, idx.vectors(id)?))).collect()
        })?;
        let mut sums: HashMap<i64, Vec<Vec<f32>>> = HashMap::new();
        for (f, v) in rows {
            if Some(f) != here {
                // Videos have several vectors: their average stands for them.
                if let Some(m) = mean(&v.chunks(crate::clip::DIM).map(|c| c.to_vec()).collect::<Vec<_>>()) {
                    sums.entry(f).or_default().push(m);
                }
            }
        }
        let mut looks: Vec<(i64, f32)> = sums
            .into_iter()
            .filter(|(_, v)| v.len() >= 2)
            .filter_map(|(f, v)| mean(&v).map(|c| (f, me.iter().zip(&c).map(|(a, b)| a * b).sum::<f32>())))
            .collect();
        looks.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (f, s) in looks.into_iter().take(2).filter(|(_, s)| *s >= 0.78) {
            out.push(Suggestion { folder: f, reason: "look".into(), score: s });
        }
    }
    let mut seen = HashSet::new();
    out.retain(|s| Some(s.folder) != here && seen.insert(s.folder));
    out.truncate(4);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    fn add(c: &Connection, name: &str, folder: Option<i64>, obj: &str, sha: &str) -> i64 {
        c.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (?1, ?2, 'image', ?3, 'jpg', 1, ?4, 0, 't')",
            params![obj, folder, name, sha],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    #[test]
    fn free_copies_share_and_promote() {
        let c = db::create_empty().unwrap();
        let f = library::create_folder(&c, None, "F").unwrap();
        let a = add(&c, "a.jpg", None, "o1", "s1");
        library::tag_items(&c, &[a], &["sun".into()]).unwrap();
        let copies = free_copy(&c, &[a, a], Some(f)).unwrap();
        assert_eq!(copies.len(), 2);
        let it = library::get_item(&c, copies[0]).unwrap();
        assert_eq!((it.copy_of, it.linked, it.folder_id), (Some(a), true, Some(f)));
        assert!(library::get_item(&c, a).unwrap().linked);
        assert_eq!(library::item_tags(&c, copies[0]).unwrap().own, vec!["sun".to_string()]);
        // A free copy of a free copy points at the original.
        let c3 = free_copy(&c, &[copies[0]], None).unwrap()[0];
        assert_eq!(library::get_item(&c, c3).unwrap().copy_of, Some(a));
        assert_eq!(free_copies_of(&c, &[a]).unwrap()[0].1.len(), 3);
        // Deleting a free copy for good never frees the shared file.
        library::trash_items(&c, &[copies[1]]).unwrap();
        let o = library::delete_forever(&c, &[copies[1]]).unwrap();
        assert!(o.media.is_empty() && o.thumbs.is_empty());
        // Promote: copies[0] becomes the original; a becomes its copy.
        let links = promote(&c, a, copies[0]).unwrap();
        assert_eq!(library::get_item(&c, copies[0]).unwrap().copy_of, None);
        assert_eq!(library::get_item(&c, a).unwrap().copy_of, Some(copies[0]));
        assert_eq!(library::get_item(&c, c3).unwrap().copy_of, Some(copies[0]));
        restore_links(&c, &links).unwrap();
        assert_eq!(library::get_item(&c, copies[0]).unwrap().copy_of, Some(a));
        // Only when the last one goes is the file freed.
        library::trash_items(&c, &[a, copies[0], c3]).unwrap();
        let o = library::delete_forever(&c, &[a, copies[0], c3]).unwrap();
        assert_eq!(o.media, vec!["o1".to_string()]);
    }

    #[test]
    fn merge_asks_about_identical_files_and_undoes() {
        let c = db::create_empty().unwrap();
        let t = library::create_folder(&c, None, "Trips").unwrap();
        let s = library::create_folder(&c, None, "Trips old").unwrap();
        let t_rome = library::create_folder(&c, Some(t), "Rome").unwrap();
        let s_rome = library::create_folder(&c, Some(s), "Rome").unwrap();
        let s_paris = library::create_folder(&c, Some(s), "Paris").unwrap();
        let a = add(&c, "a.jpg", Some(t_rome), "o1", "same");
        let b = add(&c, "b.jpg", Some(s_rome), "o2", "same");
        let x = add(&c, "x.jpg", Some(s), "o3", "x");
        let plan = merge_plan(&c, t, &[s]).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].len(), 2);
        assert!(merge_plan(&c, t_rome, &[t]).is_err(), "not into its own subfolder");
        let m = merge(&c, t, &[s], &[b]).unwrap();
        assert_eq!(library::get_item(&c, x).unwrap().folder_id, Some(t));
        assert!(library::get_item(&c, b).unwrap().deleted_at.is_some());
        let paris = library::all_folders(&c).unwrap().into_iter().find(|f| f.id == s_paris).unwrap();
        assert_eq!(paris.parent_id, Some(t));
        assert!(!library::all_folders(&c).unwrap().iter().any(|f| f.id == s));
        unmerge(&c, &m).unwrap();
        assert_eq!(library::get_item(&c, x).unwrap().folder_id, Some(s));
        assert_eq!(library::get_item(&c, b).unwrap().folder_id, Some(s_rome));
        assert!(library::get_item(&c, b).unwrap().deleted_at.is_none());
        assert_eq!(library::get_item(&c, a).unwrap().folder_id, Some(t_rome));
        let all = library::all_folders(&c).unwrap();
        assert_eq!(all.iter().find(|f| f.id == s_paris).unwrap().parent_id, Some(s));
    }

    #[test]
    fn tags_rename_merge_delete_and_restore() {
        let c = db::create_empty().unwrap();
        let a = add(&c, "a.jpg", None, "o1", "1");
        let b = add(&c, "b.jpg", None, "o2", "2");
        library::tag_items(&c, &[a], &["beach".into()]).unwrap();
        library::tag_items(&c, &[b], &["sea".into()]).unwrap();
        set_tag_color(&c, "beach", Some("#ff0000")).unwrap();
        let before = rename_tag(&c, "beach", "Sea").unwrap();
        let list = tag_list(&c).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].items, 2);
        restore_tag(&c, &before, Some("Sea")).unwrap();
        let list = tag_list(&c).unwrap();
        assert_eq!(list.iter().map(|t| (t.name.as_str(), t.items)).collect::<Vec<_>>(), vec![("beach", 1), ("sea", 1)]);
        assert_eq!(list[0].color.as_deref(), Some("#ff0000"));
        let gone = delete_tag(&c, "sea").unwrap();
        assert_eq!(tag_list(&c).unwrap().len(), 1);
        restore_tag(&c, &gone, None).unwrap();
        assert_eq!(tag_list(&c).unwrap().len(), 2);
    }

    #[test]
    fn notes_order_and_continue_watching() {
        let c = db::create_empty().unwrap();
        let a = add(&c, "a.jpg", None, "o1", "1");
        assert_eq!(set_note(&c, false, a, Some(" sunset at the pier ")).unwrap(), None);
        let found = library::query_items(&c, &library::ItemFilter { names: vec!["PIER".into()], ..Default::default() }).unwrap();
        assert_eq!(found.len(), 1);
        let x = library::create_folder(&c, None, "X").unwrap();
        let y = library::create_folder(&c, None, "Y").unwrap();
        let before = set_order(&c, &[y, x]).unwrap();
        let names: Vec<String> = library::all_folders(&c).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["Y", "X"]);
        restore_order(&c, &before).unwrap();
        c.execute("UPDATE media SET resume_ms = 5000 WHERE id = ?", [a]).unwrap();
        assert_eq!(continue_watching(&c).unwrap().len(), 1);
    }
}
