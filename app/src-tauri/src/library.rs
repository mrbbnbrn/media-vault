//! Library queries and edits: folders, items, tags, favourites, weights,
//! covers, presets and layouts. Plain functions over the SQLite connection,
//! so they are easy to test.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

pub type R<T> = Result<T, String>;

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub ext: String,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub favourite: bool,
    pub weight: f64,
    /// "ok", "pending" (not made yet) or "failed" (the file can't be shown).
    pub thumb: String,
    pub imported_at: i64,
    pub folder_id: Option<i64>,
}

const ITEM_COLS: &str = "m.id, m.kind, m.original_name, m.ext, m.size, m.width, m.height, m.duration_ms, \
     m.favourite, m.weight, m.thumb_object_id, m.imported_at, m.folder_id";

fn item_row(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    let thumb: Option<String> = r.get(10)?;
    Ok(Item {
        id: r.get(0)?,
        kind: r.get(1)?,
        name: r.get(2)?,
        ext: r.get(3)?,
        size: r.get(4)?,
        width: r.get(5)?,
        height: r.get(6)?,
        duration_ms: r.get(7)?,
        favourite: r.get::<_, i64>(8)? != 0,
        weight: r.get(9)?,
        thumb: match thumb.as_deref() {
            None => "pending",
            Some("") => "failed",
            Some(_) => "ok",
        }
        .into(),
        imported_at: r.get(11)?,
        folder_id: r.get(12)?,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Crumb {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderCard {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    /// Ancestors, top first (not including this folder).
    pub path: Vec<Crumb>,
    pub depth: usize,
    /// Items in this folder and everything below it.
    pub items: i64,
    pub direct_items: i64,
    pub subfolders: i64,
    /// Media id whose thumbnail is the folder's cover.
    pub cover: Option<i64>,
    pub tags: Vec<String>,
}

struct FolderRow {
    id: i64,
    parent: Option<i64>,
    name: String,
    cover: Option<i64>,
}

/// Every folder with counts, covers and tags, in tree order (parents before
/// children, siblings by sort order then name).
pub fn all_folders(conn: &Connection) -> R<Vec<FolderCard>> {
    let rows: Vec<FolderRow> = conn
        .prepare("SELECT id, parent_id, name, cover_media_id FROM folders ORDER BY sort_order, name COLLATE NOCASE")
        .map_err(e)?
        .query_map([], |r| Ok(FolderRow { id: r.get(0)?, parent: r.get(1)?, name: r.get(2)?, cover: r.get(3)? }))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;

    let mut direct: HashMap<i64, i64> = HashMap::new();
    let mut first_thumb: HashMap<i64, i64> = HashMap::new();
    {
        let mut st = conn
            .prepare(
                "SELECT folder_id, COUNT(*), MIN(CASE WHEN thumb_object_id IS NOT NULL AND thumb_object_id <> '' \
                 AND kind = 'image' THEN id END), MIN(CASE WHEN thumb_object_id IS NOT NULL AND thumb_object_id <> '' THEN id END) \
                 FROM media WHERE folder_id IS NOT NULL GROUP BY folder_id",
            )
            .map_err(e)?;
        let it = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                ))
            })
            .map_err(e)?;
        for row in it {
            let (f, n, img, any) = row.map_err(e)?;
            direct.insert(f, n);
            if let Some(t) = img.or(any) {
                first_thumb.insert(f, t);
            }
        }
    }
    let mut tags: HashMap<i64, Vec<String>> = HashMap::new();
    {
        let mut st = conn
            .prepare("SELECT ft.folder_id, t.name FROM folder_tags ft JOIN tags t ON t.id = ft.tag_id ORDER BY t.name COLLATE NOCASE")
            .map_err(e)?;
        for row in st
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(e)?
        {
            let (f, t) = row.map_err(e)?;
            tags.entry(f).or_default().push(t);
        }
    }

    let by_id: HashMap<i64, &FolderRow> = rows.iter().map(|r| (r.id, r)).collect();
    let mut children: HashMap<Option<i64>, Vec<i64>> = HashMap::new();
    for r in &rows {
        // A parent that no longer exists is treated as top level.
        let p = r.parent.filter(|p| by_id.contains_key(p));
        children.entry(p).or_default().push(r.id);
    }

    // Depth-first walk: produces tree order and lets us sum counts bottom-up.
    let mut order: Vec<(i64, Vec<Crumb>)> = Vec::new();
    let mut stack: Vec<(i64, Vec<Crumb>)> = children
        .get(&None)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .rev()
        .map(|id| (id, Vec::new()))
        .collect();
    let mut seen = HashSet::new();
    while let Some((id, path)) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        let mut child_path = path.clone();
        child_path.push(Crumb {
            id,
            name: by_id[&id].name.clone(),
        });
        if let Some(kids) = children.get(&Some(id)) {
            for k in kids.iter().rev() {
                stack.push((*k, child_path.clone()));
            }
        }
        order.push((id, path));
    }

    let mut total: HashMap<i64, i64> = HashMap::new();
    let mut cover_below: HashMap<i64, i64> = HashMap::new();
    for (id, _) in order.iter().rev() {
        let mut t = *direct.get(id).unwrap_or(&0);
        let mut cov = first_thumb.get(id).copied();
        for k in children
            .get(&Some(*id))
            .map(|v| v.as_slice())
            .unwrap_or(&[])
        {
            t += total.get(k).copied().unwrap_or(0);
            if cov.is_none() {
                cov = cover_below.get(k).copied();
            }
        }
        total.insert(*id, t);
        if let Some(c) = cov {
            cover_below.insert(*id, c);
        }
    }

    Ok(order
        .into_iter()
        .map(|(id, path)| {
            let r = by_id[&id];
            FolderCard {
                id,
                name: r.name.clone(),
                parent_id: r.parent,
                depth: path.len(),
                path,
                items: total.get(&id).copied().unwrap_or(0),
                direct_items: direct.get(&id).copied().unwrap_or(0),
                subfolders: children.get(&Some(id)).map(|v| v.len() as i64).unwrap_or(0),
                cover: r.cover.or_else(|| cover_below.get(&id).copied()),
                tags: tags.remove(&id).unwrap_or_default(),
            }
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderView {
    pub folder: Option<FolderCard>,
    pub subfolders: Vec<FolderCard>,
    pub items: Vec<Item>,
}

pub fn folder_view(conn: &Connection, folder: Option<i64>) -> R<FolderView> {
    let all = all_folders(conn)?;
    let this = match folder {
        Some(id) => Some(
            all.iter()
                .find(|f| f.id == id)
                .cloned()
                .ok_or("That folder no longer exists.")?,
        ),
        None => None,
    };
    let subfolders = all.into_iter().filter(|f| f.parent_id == folder).collect();
    let items = query_items(
        conn,
        &ItemFilter {
            folder: Some(folder),
            ..Default::default()
        },
    )?;
    Ok(FolderView {
        folder: this,
        subfolders,
        items,
    })
}

/// Which items to list. `folder: Some(None)` means "top level".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ItemFilter {
    #[serde(with = "double_option")]
    pub folder: Option<Option<i64>>,
    /// Include everything below `folder` (or below each of `folders`).
    pub recursive: bool,
    /// Several folders at once (slideshow sources). Combined with `folder` as OR.
    pub folders: Vec<i64>,
    /// All of these tags (direct or inherited from a folder).
    pub tags: Vec<String>,
    pub favourites_only: bool,
    /// "image", "gif", "video"; empty = all kinds.
    pub kinds: Vec<String>,
    /// Imported within the last N days.
    pub recent_days: Option<i64>,
}

mod double_option {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<i64>>, D::Error> {
        Ok(Some(Option::<i64>::deserialize(d)?))
    }
}

fn descendants(conn: &Connection, roots: &[i64]) -> R<Vec<i64>> {
    let mut out: Vec<i64> = roots.to_vec();
    let mut kids: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut st = conn
        .prepare("SELECT id, parent_id FROM folders WHERE parent_id IS NOT NULL")
        .map_err(e)?;
    for row in st
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_err(e)?
    {
        let (id, p) = row.map_err(e)?;
        kids.entry(p).or_default().push(id);
    }
    let mut seen: HashSet<i64> = out.iter().copied().collect();
    let mut i = 0;
    while i < out.len() {
        if let Some(k) = kids.get(&out[i]) {
            for c in k {
                if seen.insert(*c) {
                    out.push(*c);
                }
            }
        }
        i += 1;
    }
    Ok(out)
}

pub fn query_items(conn: &Connection, f: &ItemFilter) -> R<Vec<Item>> {
    let mut wh: Vec<String> = Vec::new();
    let mut args: Vec<Value> = Vec::new();

    let mut folder_ids: Vec<i64> = f.folders.clone();
    let mut include_top = false;
    match f.folder {
        Some(Some(id)) => folder_ids.push(id),
        Some(None) => include_top = true,
        None => {}
    }
    if f.recursive && !folder_ids.is_empty() {
        folder_ids = descendants(conn, &folder_ids)?;
    }
    if include_top && f.recursive {
        // Top level + everything = the whole library: no folder condition.
    } else if include_top || !folder_ids.is_empty() || f.folder.is_some() || !f.folders.is_empty() {
        let mut parts = Vec::new();
        if include_top {
            parts.push("m.folder_id IS NULL".to_string());
        }
        if !folder_ids.is_empty() {
            parts.push(format!(
                "m.folder_id IN ({})",
                vec!["?"; folder_ids.len()].join(",")
            ));
            args.extend(folder_ids.iter().map(|i| Value::Integer(*i)));
        }
        if parts.is_empty() {
            parts.push("0".into());
        }
        wh.push(format!("({})", parts.join(" OR ")));
    }
    if f.favourites_only {
        wh.push("m.favourite = 1".into());
    }
    let kinds: Vec<&String> = f
        .kinds
        .iter()
        .filter(|k| ["image", "gif", "video"].contains(&k.as_str()))
        .collect();
    if !kinds.is_empty() {
        wh.push(format!("m.kind IN ({})", vec!["?"; kinds.len()].join(",")));
        args.extend(kinds.iter().map(|k| Value::Text((*k).clone())));
    }
    if let Some(d) = f.recent_days {
        wh.push("m.imported_at >= ?".into());
        args.push(Value::Integer(now_secs() - d * 86_400));
    }
    if !f.tags.is_empty() {
        let names: Vec<&str> = f.tags.iter().map(|s| s.as_str()).collect();
        let ids = vault_core::db::search_by_tags(conn, &names).map_err(|x| x.to_string())?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        wh.push(format!("m.id IN ({})", vec!["?"; ids.len()].join(",")));
        args.extend(ids.into_iter().map(Value::Integer));
    }
    let sql = format!(
        "SELECT {ITEM_COLS} FROM media m {} ORDER BY m.imported_at DESC, m.id DESC",
        if wh.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", wh.join(" AND "))
        }
    );
    let mut st = conn.prepare(&sql).map_err(e)?;
    let items = st
        .query_map(params_from_iter(args), item_row)
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    Ok(items)
}

pub fn get_item(conn: &Connection, id: i64) -> R<Item> {
    conn.query_row(
        &format!("SELECT {ITEM_COLS} FROM media m WHERE m.id = ?"),
        [id],
        item_row,
    )
    .optional()
    .map_err(e)?
    .ok_or_else(|| "That item no longer exists.".into())
}

// ---- folders ------------------------------------------------------------------------

pub fn check_name(name: &str) -> R<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Give the folder a name.".into());
    }
    if n.chars().count() > 200 {
        return Err("That name is too long.".into());
    }
    Ok(n.to_string())
}

fn folder_exists(conn: &Connection, id: i64) -> R<bool> {
    conn.query_row("SELECT 1 FROM folders WHERE id = ?", [id], |_| Ok(()))
        .optional()
        .map_err(e)
        .map(|o| o.is_some())
}

pub fn find_child(conn: &Connection, parent: Option<i64>, name: &str) -> R<Option<i64>> {
    conn.query_row(
        "SELECT id FROM folders WHERE IFNULL(parent_id, 0) = IFNULL(?1, 0) AND name = ?2 COLLATE NOCASE",
        params![parent, name.trim()],
        |r| r.get(0),
    )
    .optional()
    .map_err(e)
}

pub fn create_folder(conn: &Connection, parent: Option<i64>, name: &str) -> R<i64> {
    let name = check_name(name)?;
    if let Some(p) = parent
        && !folder_exists(conn, p)?
    {
        return Err("The parent folder no longer exists.".into());
    }
    if find_child(conn, parent, &name)?.is_some() {
        return Err(format!("There is already a folder called “{name}” here."));
    }
    conn.execute(
        "INSERT INTO folders(parent_id, name, created_at) VALUES (?1, ?2, ?3)",
        params![parent, name, now_secs()],
    )
    .map_err(e)?;
    Ok(conn.last_insert_rowid())
}

/// Find a child folder by name (case-insensitive) or create it. Used by import
/// so dropping the same folder twice merges into one.
pub fn get_or_create_folder(conn: &Connection, parent: Option<i64>, name: &str) -> R<i64> {
    let name = check_name(name)?;
    match find_child(conn, parent, &name)? {
        Some(id) => Ok(id),
        None => create_folder(conn, parent, &name),
    }
}

pub fn rename_folder(conn: &Connection, id: i64, name: &str) -> R<()> {
    let name = check_name(name)?;
    let parent: Option<i64> = conn
        .query_row("SELECT parent_id FROM folders WHERE id = ?", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(e)?
        .ok_or("That folder no longer exists.")?;
    if let Some(other) = find_child(conn, parent, &name)?
        && other != id
    {
        return Err(format!("There is already a folder called “{name}” here."));
    }
    conn.execute(
        "UPDATE folders SET name = ? WHERE id = ?",
        params![name, id],
    )
    .map_err(e)?;
    Ok(())
}

pub fn move_folder(conn: &Connection, id: i64, new_parent: Option<i64>) -> R<()> {
    if let Some(p) = new_parent {
        if descendants(conn, &[id])?.contains(&p) {
            return Err("A folder can't be moved inside itself.".into());
        }
        if !folder_exists(conn, p)? {
            return Err("The target folder no longer exists.".into());
        }
    }
    let name: String = conn
        .query_row("SELECT name FROM folders WHERE id = ?", [id], |r| r.get(0))
        .optional()
        .map_err(e)?
        .ok_or("That folder no longer exists.")?;
    if let Some(other) = find_child(conn, new_parent, &name)?
        && other != id
    {
        return Err(format!("The target already has a folder called “{name}”."));
    }
    conn.execute(
        "UPDATE folders SET parent_id = ? WHERE id = ?",
        params![new_parent, id],
    )
    .map_err(e)?;
    Ok(())
}

/// Encrypted files that must be removed from disk after rows are deleted.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Orphans {
    pub media: Vec<String>,
    pub thumbs: Vec<String>,
}

fn collect_orphans(conn: &Connection, where_sql: &str, args: &[Value]) -> R<Orphans> {
    let mut o = Orphans::default();
    let mut st = conn
        .prepare(&format!(
            "SELECT object_id, thumb_object_id FROM media WHERE {where_sql}"
        ))
        .map_err(e)?;
    for row in st
        .query_map(params_from_iter(args.iter().cloned()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(e)?
    {
        let (m, t) = row.map_err(e)?;
        o.media.push(m);
        if let Some(t) = t.filter(|t| !t.is_empty()) {
            o.thumbs.push(t);
        }
    }
    Ok(o)
}

/// Delete a folder, its subfolders and every item in them from the vault.
pub fn delete_folder(conn: &Connection, id: i64) -> R<Orphans> {
    let all = descendants(conn, &[id])?;
    let ph = vec!["?"; all.len()].join(",");
    let args: Vec<Value> = all.iter().map(|i| Value::Integer(*i)).collect();
    let orphans = collect_orphans(conn, &format!("folder_id IN ({ph})"), &args)?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute(
        &format!("UPDATE folders SET cover_media_id = NULL WHERE id IN ({ph})"),
        params_from_iter(args.iter().cloned()),
    )
    .map_err(e)?;
    tx.execute(
        &format!("DELETE FROM media WHERE folder_id IN ({ph})"),
        params_from_iter(args.iter().cloned()),
    )
    .map_err(e)?;
    // Children first so the parent_id references never dangle.
    for f in all.iter().rev() {
        tx.execute("DELETE FROM folders WHERE id = ?", [f])
            .map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(orphans)
}

pub fn set_cover(conn: &Connection, folder: i64, media: Option<i64>) -> R<()> {
    conn.execute(
        "UPDATE folders SET cover_media_id = ? WHERE id = ?",
        params![media, folder],
    )
    .map_err(e)?;
    Ok(())
}

// ---- items ---------------------------------------------------------------------------

fn id_list(ids: &[i64]) -> (String, Vec<Value>) {
    (
        vec!["?"; ids.len()].join(","),
        ids.iter().map(|i| Value::Integer(*i)).collect(),
    )
}

pub fn move_items(conn: &Connection, ids: &[i64], folder: Option<i64>) -> R<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    if let Some(f) = folder
        && !folder_exists(conn, f)?
    {
        return Err("The target folder no longer exists.".into());
    }
    let (ph, mut args) = id_list(ids);
    args.insert(0, folder.map(Value::Integer).unwrap_or(Value::Null));
    conn.execute(
        &format!("UPDATE media SET folder_id = ? WHERE id IN ({ph})"),
        params_from_iter(args),
    )
    .map_err(e)
}

pub fn delete_items(conn: &Connection, ids: &[i64]) -> R<Orphans> {
    if ids.is_empty() {
        return Ok(Orphans::default());
    }
    let (ph, args) = id_list(ids);
    let orphans = collect_orphans(conn, &format!("id IN ({ph})"), &args)?;
    conn.execute(
        &format!("DELETE FROM media WHERE id IN ({ph})"),
        params_from_iter(args),
    )
    .map_err(e)?;
    Ok(orphans)
}

pub fn set_favourite(conn: &Connection, ids: &[i64], on: bool) -> R<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let (ph, mut args) = id_list(ids);
    args.insert(0, Value::Integer(on as i64));
    conn.execute(
        &format!("UPDATE media SET favourite = ? WHERE id IN ({ph})"),
        params_from_iter(args),
    )
    .map_err(e)?;
    Ok(())
}

pub const MAX_WEIGHT: f64 = 1000.0;

pub fn set_weight(conn: &Connection, ids: &[i64], weight: f64) -> R<()> {
    if !weight.is_finite() || !(0.0..=MAX_WEIGHT).contains(&weight) {
        return Err(format!("Weight must be between 0 and {MAX_WEIGHT}."));
    }
    if ids.is_empty() {
        return Ok(());
    }
    let (ph, mut args) = id_list(ids);
    args.insert(0, Value::Real(weight));
    conn.execute(
        &format!("UPDATE media SET weight = ? WHERE id IN ({ph})"),
        params_from_iter(args),
    )
    .map_err(e)?;
    Ok(())
}

// ---- tags ------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    pub items: i64,
    pub folders: i64,
}

pub fn all_tags(conn: &Connection) -> R<Vec<TagCount>> {
    let mut st = conn
        .prepare(
            "SELECT t.name, (SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = t.id), \
             (SELECT COUNT(*) FROM folder_tags ft WHERE ft.tag_id = t.id) FROM tags t ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(e)?;
    let v = st
        .query_map([], |r| {
            Ok(TagCount {
                name: r.get(0)?,
                items: r.get(1)?,
                folders: r.get(2)?,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    Ok(v)
}

fn clean_tag(t: &str) -> Option<String> {
    let t: String = t
        .trim()
        .trim_start_matches('#')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!t.is_empty() && t.chars().count() <= 80).then_some(t)
}

fn tag_id(conn: &Connection, name: &str) -> R<i64> {
    conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", [name])
        .map_err(e)?;
    conn.query_row("SELECT id FROM tags WHERE name = ?", [name], |r| r.get(0))
        .map_err(e)
}

fn drop_unused_tags(conn: &Connection) -> R<()> {
    conn.execute(
        "DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM media_tags) AND id NOT IN (SELECT tag_id FROM folder_tags)",
        [],
    )
    .map_err(e)?;
    Ok(())
}

pub fn tag_items(conn: &Connection, ids: &[i64], tags: &[String]) -> R<()> {
    for t in tags.iter().filter_map(|t| clean_tag(t)) {
        let tid = tag_id(conn, &t)?;
        for id in ids {
            conn.execute(
                "INSERT OR IGNORE INTO media_tags(media_id, tag_id) VALUES (?, ?)",
                [id, &tid],
            )
            .map_err(e)?;
        }
    }
    Ok(())
}

pub fn untag_items(conn: &Connection, ids: &[i64], tag: &str) -> R<()> {
    for id in ids {
        conn.execute(
            "DELETE FROM media_tags WHERE media_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
            params![id, tag.trim()],
        )
        .map_err(e)?;
    }
    drop_unused_tags(conn)
}

pub fn tag_folder(conn: &Connection, folder: i64, tags: &[String]) -> R<()> {
    for t in tags.iter().filter_map(|t| clean_tag(t)) {
        let tid = tag_id(conn, &t)?;
        conn.execute(
            "INSERT OR IGNORE INTO folder_tags(folder_id, tag_id) VALUES (?, ?)",
            [folder, tid],
        )
        .map_err(e)?;
    }
    Ok(())
}

pub fn untag_folder(conn: &Connection, folder: i64, tag: &str) -> R<()> {
    conn.execute(
        "DELETE FROM folder_tags WHERE folder_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
        params![folder, tag.trim()],
    )
    .map_err(e)?;
    drop_unused_tags(conn)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemTags {
    /// Put on the item itself (removable here).
    pub own: Vec<String>,
    /// Inherited from a folder above it, with that folder's name.
    pub inherited: Vec<(String, String)>,
}

pub fn item_tags(conn: &Connection, id: i64) -> R<ItemTags> {
    let own = conn
        .prepare("SELECT t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = ? ORDER BY t.name COLLATE NOCASE")
        .map_err(e)?
        .query_map([id], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(e)?;
    let mut inherited = Vec::new();
    let mut folder: Option<i64> = conn
        .query_row("SELECT folder_id FROM media WHERE id = ?", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(e)?
        .flatten();
    let mut guard = 0;
    while let Some(f) = folder {
        let (name, parent): (String, Option<i64>) = conn
            .query_row(
                "SELECT name, parent_id FROM folders WHERE id = ?",
                [f],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(e)?;
        let mut st = conn.prepare("SELECT t.name FROM folder_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.folder_id = ?").map_err(e)?;
        for t in st.query_map([f], |r| r.get::<_, String>(0)).map_err(e)? {
            inherited.push((t.map_err(e)?, name.clone()));
        }
        folder = parent;
        guard += 1;
        if guard > 1000 {
            break;
        }
    }
    Ok(ItemTags { own, inherited })
}

// ---- presets & layouts (named JSON blobs) ----------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub id: Option<i64>,
    pub name: String,
    pub settings: serde_json::Value,
}

fn named_table(kind: &str) -> R<&'static str> {
    match kind {
        "preset" => Ok("presets"),
        "layout" => Ok("layouts"),
        _ => Err("Unknown kind.".into()),
    }
}

pub fn list_named(conn: &Connection, kind: &str) -> R<Vec<Named>> {
    let t = named_table(kind)?;
    let mut st = conn
        .prepare(&format!(
            "SELECT id, name, settings_json FROM {t} ORDER BY name COLLATE NOCASE"
        ))
        .map_err(e)?;
    let v = st
        .query_map([], |r| {
            let json: String = r.get(2)?;
            Ok(Named {
                id: Some(r.get(0)?),
                name: r.get(1)?,
                settings: serde_json::from_str(&json).unwrap_or(serde_json::Value::Null),
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    Ok(v)
}

pub fn save_named(conn: &Connection, kind: &str, n: &Named) -> R<i64> {
    let t = named_table(kind)?;
    let name = n.name.trim();
    if name.is_empty() {
        return Err("Give it a name.".into());
    }
    let json = serde_json::to_string(&n.settings).map_err(|x| x.to_string())?;
    let clash: Option<i64> = conn
        .query_row(&format!("SELECT id FROM {t} WHERE name = ?"), [name], |r| {
            r.get(0)
        })
        .optional()
        .map_err(e)?;
    match (n.id, clash) {
        (_, Some(c)) if Some(c) != n.id => {
            conn.execute(
                &format!("UPDATE {t} SET settings_json = ? WHERE id = ?"),
                params![json, c],
            )
            .map_err(e)?;
            if let Some(old) = n.id {
                conn.execute(&format!("DELETE FROM {t} WHERE id = ?"), [old])
                    .map_err(e)?;
            }
            Ok(c)
        }
        (Some(id), _) => {
            conn.execute(
                &format!("UPDATE {t} SET name = ?, settings_json = ? WHERE id = ?"),
                params![name, json, id],
            )
            .map_err(e)?;
            Ok(id)
        }
        (None, _) => {
            conn.execute(
                &format!("INSERT INTO {t}(name, settings_json) VALUES (?, ?)"),
                params![name, json],
            )
            .map_err(e)?;
            Ok(conn.last_insert_rowid())
        }
    }
}

pub fn delete_named(conn: &Connection, kind: &str, id: i64) -> R<()> {
    let t = named_table(kind)?;
    conn.execute(&format!("DELETE FROM {t} WHERE id = ?"), [id])
        .map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    fn add(conn: &Connection, name: &str, folder: Option<i64>, kind: &str) -> i64 {
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, 'jpg', 10, 'h', 0, 'thumb')",
            params![folder, kind, name],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn folder_tree_counts_and_covers() {
        let c = db::create_empty().unwrap();
        let people = create_folder(&c, None, "People").unwrap();
        let alex = create_folder(&c, Some(people), "Alex").unwrap();
        let sam = create_folder(&c, Some(people), "Sam").unwrap();
        let trips = create_folder(&c, None, "Trips").unwrap();
        let a1 = add(&c, "a1", Some(alex), "image");
        add(&c, "a2", Some(alex), "video");
        add(&c, "s1", Some(sam), "image");
        add(&c, "top", None, "image");

        let all = all_folders(&c).unwrap();
        let names: Vec<_> = all
            .iter()
            .map(|f| (f.name.as_str(), f.depth, f.items))
            .collect();
        assert_eq!(
            names,
            vec![
                ("People", 0, 3),
                ("Alex", 1, 2),
                ("Sam", 1, 1),
                ("Trips", 0, 0)
            ]
        );
        assert_eq!(
            all[0].cover,
            Some(a1),
            "cover falls back to the first picture below"
        );
        assert_eq!(all[3].cover, None);
        assert_eq!(
            all[1].path,
            vec![Crumb {
                id: people,
                name: "People".into()
            }]
        );

        set_cover(&c, people, Some(add(&c, "chosen", Some(sam), "image"))).unwrap();
        assert_ne!(all_folders(&c).unwrap()[0].cover, Some(a1));

        let v = folder_view(&c, Some(people)).unwrap();
        assert_eq!(v.subfolders.len(), 2);
        assert!(v.items.is_empty());
        assert_eq!(folder_view(&c, None).unwrap().items.len(), 1);
        let _ = trips;
    }

    #[test]
    fn folder_names_moves_and_cycles() {
        let c = db::create_empty().unwrap();
        let a = create_folder(&c, None, "A").unwrap();
        let b = create_folder(&c, Some(a), "B").unwrap();
        assert!(
            create_folder(&c, None, "a").is_err(),
            "names are unique ignoring case"
        );
        assert!(create_folder(&c, None, "  ").is_err());
        assert_eq!(get_or_create_folder(&c, None, "a").unwrap(), a);
        assert!(move_folder(&c, a, Some(b)).is_err(), "no cycles");
        move_folder(&c, b, None).unwrap();
        assert!(rename_folder(&c, b, "A").is_err());
        rename_folder(&c, b, "Bee").unwrap();
    }

    #[test]
    fn delete_folder_returns_files_to_remove() {
        let c = db::create_empty().unwrap();
        let a = create_folder(&c, None, "A").unwrap();
        let b = create_folder(&c, Some(a), "B").unwrap();
        add(&c, "x", Some(a), "image");
        add(&c, "y", Some(b), "image");
        let keep = add(&c, "z", None, "image");
        let o = delete_folder(&c, a).unwrap();
        assert_eq!(o.media.len(), 2);
        assert_eq!(o.thumbs.len(), 2);
        assert!(all_folders(&c).unwrap().is_empty());
        assert_eq!(
            query_items(&c, &ItemFilter::default())
                .unwrap()
                .iter()
                .map(|i| i.id)
                .collect::<Vec<_>>(),
            vec![keep]
        );
    }

    #[test]
    fn filters_tags_favourites_weights() {
        let c = db::create_empty().unwrap();
        let alex = create_folder(&c, None, "Alex").unwrap();
        let sub = create_folder(&c, Some(alex), "Beach").unwrap();
        let m1 = add(&c, "1", Some(alex), "image");
        let m2 = add(&c, "2", Some(sub), "video");
        let m3 = add(&c, "3", None, "gif");
        tag_folder(&c, alex, &["Alex".into()]).unwrap();
        tag_items(&c, &[m2, m3], &["#sunny ".into()]).unwrap();
        set_favourite(&c, &[m1, m3], true).unwrap();
        set_weight(&c, &[m2], 5.0).unwrap();
        assert!(set_weight(&c, &[m2], -1.0).is_err());

        let ids = |f: ItemFilter| {
            query_items(&c, &f)
                .unwrap()
                .iter()
                .map(|i| i.id)
                .collect::<HashSet<_>>()
        };
        assert_eq!(
            ids(ItemFilter {
                tags: vec!["alex".into()],
                ..Default::default()
            }),
            HashSet::from([m1, m2])
        );
        assert_eq!(
            ids(ItemFilter {
                tags: vec!["alex".into(), "sunny".into()],
                ..Default::default()
            }),
            HashSet::from([m2])
        );
        assert_eq!(
            ids(ItemFilter {
                favourites_only: true,
                ..Default::default()
            }),
            HashSet::from([m1, m3])
        );
        assert_eq!(
            ids(ItemFilter {
                folder: Some(Some(alex)),
                recursive: true,
                ..Default::default()
            }),
            HashSet::from([m1, m2])
        );
        assert_eq!(
            ids(ItemFilter {
                folder: Some(Some(alex)),
                ..Default::default()
            }),
            HashSet::from([m1])
        );
        assert_eq!(
            ids(ItemFilter {
                kinds: vec!["gif".into()],
                ..Default::default()
            }),
            HashSet::from([m3])
        );
        assert_eq!(get_item(&c, m2).unwrap().weight, 5.0);

        let t = item_tags(&c, m2).unwrap();
        assert_eq!(t.own, vec!["sunny"]);
        assert_eq!(t.inherited, vec![("Alex".to_string(), "Alex".to_string())]);
        untag_items(&c, &[m2, m3], "sunny").unwrap();
        assert_eq!(all_tags(&c).unwrap().len(), 1, "unused tags are removed");
    }

    #[test]
    fn named_presets() {
        let c = db::create_empty().unwrap();
        let id = save_named(
            &c,
            "preset",
            &Named {
                id: None,
                name: "Calm".into(),
                settings: serde_json::json!({"imageSeconds": 6}),
            },
        )
        .unwrap();
        save_named(
            &c,
            "preset",
            &Named {
                id: Some(id),
                name: "Calm 2".into(),
                settings: serde_json::json!({}),
            },
        )
        .unwrap();
        assert_eq!(list_named(&c, "preset").unwrap()[0].name, "Calm 2");
        delete_named(&c, "preset", id).unwrap();
        assert!(list_named(&c, "preset").unwrap().is_empty());
        assert!(list_named(&c, "bogus").is_err());
    }
}
