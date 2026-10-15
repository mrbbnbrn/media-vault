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
    /// Best known date: when the photo/video was taken, else the original
    /// file's modified time, else when it was imported (seconds).
    pub taken_at: i64,
    pub views: i64,
    /// When it was put in the trash (ms), if it is there.
    pub deleted_at: Option<i64>,
    /// Videos: a small preview clip exists (for smooth grids).
    pub preview: bool,
    /// Videos: a tiny preview clip (a few seconds of small silent video) exists.
    pub tiny: bool,
    /// A free copy: the original's id (shares its stored file).
    pub copy_of: Option<i64>,
    /// Other items (originals or free copies) share this item's stored file.
    pub linked: bool,
    /// Your note.
    pub note: Option<String>,
    /// Videos: where you left off (ms).
    pub resume_ms: Option<i64>,
    /// A tiny colour sketch of the thumbnail, drawn until it loads (sketch.rs).
    pub sketch: Option<String>,
}

const ITEM_COLS: &str = "m.id, m.kind, m.original_name, m.ext, m.size, m.width, m.height, m.duration_ms, \
     m.favourite, m.weight, m.thumb_object_id, m.imported_at, m.folder_id, \
     COALESCE(NULLIF(m.taken_at, 0), NULLIF(m.file_mtime, 0), m.imported_at), m.views, m.deleted_at, \
     IFNULL(m.preview_object_id, '') <> '', m.copy_of, \
     EXISTS(SELECT 1 FROM media x WHERE x.object_id = m.object_id AND x.id <> m.id AND x.deleted_at IS NULL), \
     m.note, m.resume_ms, m.sketch, IFNULL(m.tiny_object_id, '') <> ''";

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
        taken_at: r.get(13)?,
        views: r.get(14)?,
        deleted_at: r.get(15)?,
        preview: r.get(16)?,
        copy_of: r.get(17)?,
        linked: r.get(18)?,
        note: r.get(19)?,
        resume_ms: r.get(20)?,
        sketch: r.get::<_, Option<String>>(21)?.filter(|s| !s.is_empty()),
        tiny: r.get(22)?,
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
    /// Kind of the cover item: a "video" or "gif" cover plays in the folders view.
    pub cover_kind: Option<String>,
    pub tags: Vec<String>,
    pub pinned: bool,
    /// Colour dot shown with the name ("#rrggbb").
    pub color: Option<String>,
    /// Emoji shown before the name.
    pub emoji: Option<String>,
    /// A person folder: face recognition learns this person from it.
    pub person: bool,
    /// Up to three pictures from inside (for stacked cards).
    pub samples: Vec<i64>,
    /// Your note.
    pub note: Option<String>,
    /// When the folder was made (seconds).
    pub created_at: i64,
    /// Size of everything inside, subfolders included (bytes).
    pub bytes: i64,
    /// Person folders: the face in the cover picture ([x, y, w, h] as parts of
    /// its width and height), so the round cover can be centred on it.
    pub cover_face: Option<[f32; 4]>,
}

struct FolderRow {
    note: Option<String>,
    created_at: i64,
    id: i64,
    parent: Option<i64>,
    name: String,
    cover: Option<i64>,
    pinned: bool,
    color: Option<String>,
    emoji: Option<String>,
    person: bool,
}

/// Every folder with counts, covers and tags, in tree order (parents before
/// children, siblings by sort order then name).
pub fn all_folders(conn: &Connection) -> R<Vec<FolderCard>> {
    let rows: Vec<FolderRow> = conn
        .prepare(
            "SELECT f.id, f.parent_id, f.name, m.id, f.pinned, f.color, f.emoji, f.person, f.note, f.created_at FROM folders f \
             LEFT JOIN media m ON m.id = f.cover_media_id AND m.deleted_at IS NULL \
             WHERE f.deleted_at IS NULL ORDER BY f.sort_order, f.name COLLATE NOCASE",
        )
        .map_err(e)?
        .query_map([], |r| {
            Ok(FolderRow {
                id: r.get(0)?,
                parent: r.get(1)?,
                name: r.get(2)?,
                cover: r.get(3)?,
                pinned: r.get::<_, i64>(4)? != 0,
                color: r.get(5)?,
                emoji: r.get(6)?,
                person: r.get::<_, i64>(7)? != 0,
                note: r.get(8)?,
                created_at: r.get(9)?,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;

    let mut direct: HashMap<i64, i64> = HashMap::new();
    let mut direct_bytes: HashMap<i64, i64> = HashMap::new();
    let mut first_thumb: HashMap<i64, i64> = HashMap::new();
    {
        let mut st = conn
            .prepare(
                "SELECT folder_id, COUNT(*), MIN(CASE WHEN thumb_object_id IS NOT NULL AND thumb_object_id <> '' \
                 AND kind = 'image' THEN id END), MIN(CASE WHEN thumb_object_id IS NOT NULL AND thumb_object_id <> '' THEN id END), \
                 IFNULL(SUM(size), 0) FROM media WHERE folder_id IS NOT NULL AND deleted_at IS NULL GROUP BY folder_id",
            )
            .map_err(e)?;
        let it = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(e)?;
        for row in it {
            let (f, n, img, any, bytes) = row.map_err(e)?;
            direct.insert(f, n);
            direct_bytes.insert(f, bytes);
            if let Some(t) = img.or(any) {
                first_thumb.insert(f, t);
            }
        }
    }
    // A few pictures per folder for stacked cards (pictures first).
    let mut samples: HashMap<i64, Vec<i64>> = HashMap::new();
    {
        let mut st = conn
            .prepare(
                "SELECT folder_id, id FROM media WHERE folder_id IS NOT NULL AND deleted_at IS NULL \
                 AND thumb_object_id IS NOT NULL AND thumb_object_id <> '' ORDER BY folder_id, kind <> 'image', id",
            )
            .map_err(e)?;
        for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))).map_err(e)? {
            let (f, id) = row.map_err(e)?;
            let v = samples.entry(f).or_default();
            if v.len() < 3 {
                v.push(id);
            }
        }
    }
    let person_covers = person_covers(conn)?;
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
    let mut total_bytes: HashMap<i64, i64> = HashMap::new();
    let mut cover_below: HashMap<i64, i64> = HashMap::new();
    for (id, _) in order.iter().rev() {
        let mut t = *direct.get(id).unwrap_or(&0);
        let mut b = *direct_bytes.get(id).unwrap_or(&0);
        let mut cov = first_thumb.get(id).copied();
        for k in children
            .get(&Some(*id))
            .map(|v| v.as_slice())
            .unwrap_or(&[])
        {
            t += total.get(k).copied().unwrap_or(0);
            b += total_bytes.get(k).copied().unwrap_or(0);
            if cov.is_none() {
                cov = cover_below.get(k).copied();
            }
        }
        total.insert(*id, t);
        total_bytes.insert(*id, b);
        if let Some(c) = cov {
            cover_below.insert(*id, c);
        }
        // Not enough pictures of its own: borrow from subfolders.
        let mut mine = samples.get(id).cloned().unwrap_or_default();
        for k in children.get(&Some(*id)).map(|v| v.as_slice()).unwrap_or(&[]) {
            for x in samples.get(k).cloned().unwrap_or_default() {
                if mine.len() < 3 && !mine.contains(&x) {
                    mine.push(x);
                }
            }
        }
        samples.insert(*id, mine);
    }

    let kinds: HashMap<i64, String> = {
        let mut st = conn.prepare("SELECT id, kind FROM media WHERE id IN (SELECT cover_media_id FROM folders) OR thumb_object_id IS NOT NULL").map_err(e)?;
        st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?
    };
    Ok(order
        .into_iter()
        .map(|(id, path)| {
            let r = by_id[&id];
            // Person folders without a chosen cover: the face most like that person.
            let cover = r
                .cover
                .or_else(|| if r.person { person_covers.get(&id).copied() } else { None })
                .or_else(|| cover_below.get(&id).copied());
            let cover_face = match cover {
                Some(c) if r.person && matches!(kinds.get(&c).map(String::as_str), Some("image") | Some("gif")) => cover_face(conn, c, id),
                _ => None,
            };
            FolderCard {
                cover_face,
                cover_kind: cover.and_then(|c| kinds.get(&c).cloned()),
                id,
                name: r.name.clone(),
                parent_id: r.parent,
                depth: path.len(),
                path,
                items: total.get(&id).copied().unwrap_or(0),
                direct_items: direct.get(&id).copied().unwrap_or(0),
                subfolders: children.get(&Some(id)).map(|v| v.len() as i64).unwrap_or(0),
                cover,
                tags: tags.remove(&id).unwrap_or_default(),
                pinned: r.pinned,
                color: r.color.clone(),
                emoji: r.emoji.clone(),
                person: r.person,
                samples: samples.remove(&id).unwrap_or_default(),
                note: r.note.clone(),
                created_at: r.created_at,
                bytes: total_bytes.get(&id).copied().unwrap_or(0),
            }
        })
        .collect())
}

/// The face to centre a person's round cover on: theirs, else the biggest one.
fn cover_face(conn: &Connection, media: i64, person: i64) -> Option<[f32; 4]> {
    conn.query_row(
        "SELECT x, y, w, h FROM faces WHERE media_id = ?1 AND w > 0 AND h > 0 \
         ORDER BY IFNULL(person_id = ?2, 0) DESC, w * h DESC LIMIT 1",
        [media, person],
        |r| Ok([r.get::<_, f64>(0)? as f32, r.get::<_, f64>(1)? as f32, r.get::<_, f64>(2)? as f32, r.get::<_, f64>(3)? as f32]),
    )
    .ok()
}

/// For each person folder: the picture whose face is closest to that
/// person's average face, preferring big, clear faces.
fn person_covers(conn: &Connection) -> R<HashMap<i64, i64>> {
    type Row = (i64, i64, f32, f32, Vec<u8>);
    let rows: Vec<Row> = conn
        .prepare(
            // At most 200 faces per person (confirmed ones first): people
            // recognised in thousands of photos stay quick.
            "SELECT person_id, media_id, w, score, descriptor FROM ( \
               SELECT f.person_id, f.media_id, f.w, f.score, f.descriptor, \
                      ROW_NUMBER() OVER (PARTITION BY f.person_id ORDER BY f.auto, f.id DESC) AS k \
               FROM faces f JOIN media m ON m.id = f.media_id JOIN folders d ON d.id = f.person_id \
               WHERE f.person_id IS NOT NULL AND m.deleted_at IS NULL AND d.person = 1 AND d.deleted_at IS NULL \
               AND m.thumb_object_id IS NOT NULL AND m.thumb_object_id <> '' AND m.kind = 'image' AND f.hidden = 0) \
             WHERE k <= 200",
        )
        .map_err(e)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    type Face = (i64, f32, f32, Vec<f32>);
    let mut by_person: HashMap<i64, Vec<Face>> = HashMap::new();
    for (p, m, w, sc, d) in rows {
        by_person.entry(p).or_default().push((m, w, sc, crate::faces::from_blob(&d)));
    }
    let mut out = HashMap::new();
    for (p, faces) in by_person {
        // Faces from the newer model (longer fingerprints) win while both exist.
        let dim = faces.iter().map(|f| f.3.len()).max().unwrap_or(0);
        let n = faces.iter().filter(|f| f.3.len() == dim).count() as f32;
        let mut avg = vec![0f32; dim];
        for f in faces.iter().filter(|f| f.3.len() == dim) {
            for (a, b) in avg.iter_mut().zip(&f.3) {
                *a += b / n;
            }
        }
        // Lower is better: like the person, big in the picture, confidently found.
        let best = faces
            .iter()
            .filter(|f| f.3.len() == dim)
            .map(|f| (f.0, crate::faces::distance(&f.3, &avg) - 0.25 * f.1.min(0.5) - 0.1 * f.2))
            .min_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((m, _)) = best {
            out.insert(p, m);
        }
    }
    Ok(out)
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
    /// File name contains each of these (case-insensitive).
    pub names: Vec<String>,
    /// List what is in the trash instead of what is not.
    pub trash: bool,
    /// Person folders: items in that folder (or below it), or confirmed by
    /// face recognition to show that person. Several = all of them.
    pub people: Vec<i64>,
}

mod double_option {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<i64>>, D::Error> {
        Ok(Some(Option::<i64>::deserialize(d)?))
    }
}

pub fn descendants(conn: &Connection, roots: &[i64]) -> R<Vec<i64>> {
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
    let mut wh: Vec<String> = vec![if f.trash {
        "m.deleted_at IS NOT NULL".into()
    } else {
        "m.deleted_at IS NULL".into()
    }];
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
        .filter(|k| ["image", "gif", "video", "text", "pdf"].contains(&k.as_str()))
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
    for p in &f.people {
        let inside = descendants(conn, &[*p])?;
        wh.push(format!(
            "(m.folder_id IN ({}) OR m.id IN (SELECT media_id FROM faces WHERE person_id = ?))",
            vec!["?"; inside.len()].join(",")
        ));
        args.extend(inside.into_iter().map(Value::Integer));
        args.push(Value::Integer(*p));
    }
    let sql = format!(
        "SELECT {ITEM_COLS} FROM media m WHERE {} ORDER BY m.imported_at DESC, m.id DESC",
        wh.join(" AND ")
    );
    let mut st = conn.prepare(&sql).map_err(e)?;
    let mut items = st
        .query_map(params_from_iter(args), item_row)
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    // Name search is done here rather than in SQL so that Turkish letters
    // match regardless of case (SQLite only folds A–Z).
    let names: Vec<String> = f
        .names
        .iter()
        .map(|n| fold(n.trim()))
        .filter(|n| !n.is_empty())
        .collect();
    if !names.is_empty() {
        items.retain(|i| names_match(i, &names));
    }
    Ok(items)
}

/// What a name search looks in: the file name and your note (folded).
/// Shared with "Why is this here?" (explain.rs) so the two can't drift apart.
pub fn name_haystack(i: &Item) -> String {
    fold(&format!("{} {}", i.name, i.note.as_deref().unwrap_or("")))
}

/// Does the item match every (already folded, non-empty) searched word?
pub fn names_match(i: &Item, folded: &[String]) -> bool {
    let n = name_haystack(i);
    folded.iter().all(|q| n.contains(q.as_str()))
}

/// Lower-case for searching: "İ", "I", "ı" and "i" all match each other.
pub fn fold(s: &str) -> String {
    s.to_lowercase().replace('\u{307}', "").replace('ı', "i")
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

/// Items (not in the trash) by id, in no particular order (face recognition).
pub fn items_by_ids(conn: &Connection, ids: &[i64]) -> R<Vec<Item>> {
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(500) {
        let sql = format!("SELECT {ITEM_COLS} FROM media m WHERE m.deleted_at IS NULL AND m.id IN ({})", vec!["?"; chunk.len()].join(","));
        let mut st = conn.prepare(&sql).map_err(e)?;
        let rows = st.query_map(params_from_iter(chunk.iter()), item_row).map_err(e)?;
        for r in rows {
            out.push(r.map_err(e)?);
        }
    }
    Ok(out)
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
    conn.query_row(
        "SELECT 1 FROM folders WHERE id = ? AND deleted_at IS NULL",
        [id],
        |_| Ok(()),
    )
    .optional()
    .map_err(e)
    .map(|o| o.is_some())
}

pub fn find_child(conn: &Connection, parent: Option<i64>, name: &str) -> R<Option<i64>> {
    conn.query_row(
        "SELECT id FROM folders WHERE IFNULL(parent_id, 0) = IFNULL(?1, 0) AND name = ?2 COLLATE NOCASE AND deleted_at IS NULL",
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
    // New folders go to the end of their level (in your own order).
    let last: i64 = conn
        .query_row(
            "SELECT IFNULL(MAX(sort_order), 0) FROM folders WHERE IFNULL(parent_id, 0) = IFNULL(?1, 0) AND deleted_at IS NULL",
            params![parent],
            |r| r.get(0),
        )
        .map_err(e)?;
    conn.execute(
        "INSERT INTO folders(parent_id, name, created_at, sort_order) VALUES (?1, ?2, ?3, ?4)",
        params![parent, name, now_secs(), last + 1],
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

/// Characters Windows doesn't allow in file names (exports use these names).
const BAD_CHARS: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// Check an item's new name (including its extension).
pub fn check_item_name(name: &str) -> R<String> {
    let n = name.trim();
    // Empty, or only an extension (".jpg").
    if n.is_empty() || (n.starts_with('.') && !n[1..].contains('.')) {
        return Err("Give it a name.".into());
    }
    if n.chars().count() > 200 {
        return Err(format!("“{n}” is too long."));
    }
    if let Some(c) = n.chars().find(|c| BAD_CHARS.contains(c) || c.is_control()) {
        return Err(format!("A name can't contain {c}"));
    }
    Ok(n.to_string())
}

/// Rename several folders and items at once. All or nothing: if one name
/// doesn't work, nothing is renamed. Folders can swap names with each other.
pub fn rename_many(conn: &Connection, folders: &[(i64, String)], items: &[(i64, String)]) -> R<()> {
    let tx = conn.unchecked_transaction().map_err(e)?;
    // Out of the way first, so A → B and B → A works.
    for (id, _) in folders {
        tx.execute("UPDATE folders SET name = ?1 WHERE id = ?2", params![format!("\u{1}rename{id}"), id]).map_err(e)?;
    }
    for (id, name) in folders {
        let name = check_name(name).map_err(|_| "Every folder needs a name.".to_string())?;
        if let Some(c) = name.chars().find(|c| BAD_CHARS.contains(c) || c.is_control()) {
            return Err(format!("A folder name can't contain {c}"));
        }
        rename_folder(&tx, *id, &name)?;
    }
    for (id, name) in items {
        let name = check_item_name(name)?;
        let n = tx.execute("UPDATE media SET original_name = ?1 WHERE id = ?2", params![name, id]).map_err(e)?;
        if n == 0 {
            return Err("One of the items no longer exists.".into());
        }
    }
    tx.commit().map_err(e)?;
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

/// Keep only the stored files no item uses any more (free copies share them).
/// Call after the rows are gone.
pub fn unused_only(conn: &Connection, o: Orphans) -> R<Orphans> {
    let used = |id: &str| -> R<bool> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM media WHERE object_id = ?1 OR thumb_object_id = ?1 OR preview_object_id = ?1 OR tiny_object_id = ?1)",
            [id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(e)
    };
    let mut out = Orphans::default();
    for m in o.media {
        if !used(&m)? && !out.media.contains(&m) {
            out.media.push(m);
        }
    }
    for t in o.thumbs {
        if !used(&t)? && !out.thumbs.contains(&t) {
            out.thumbs.push(t);
        }
    }
    Ok(out)
}

fn collect_orphans(conn: &Connection, where_sql: &str, args: &[Value]) -> R<Orphans> {
    let mut o = Orphans::default();
    let mut st = conn
        .prepare(&format!(
            "SELECT object_id, thumb_object_id, preview_object_id, tiny_object_id FROM media WHERE {where_sql}"
        ))
        .map_err(e)?;
    for row in st
        .query_map(params_from_iter(args.iter().cloned()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(e)?
    {
        let (m, t, p, tiny) = row.map_err(e)?;
        o.media.push(m);
        // Preview strips and tiny clips live with the thumbnails.
        for x in [t, p, tiny].into_iter().flatten().filter(|x| !x.is_empty()) {
            o.thumbs.push(x);
        }
    }
    Ok(o)
}

// ---- trash -------------------------------------------------------------------------------

pub const TRASH_DAYS: i64 = 30;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A fresh trash stamp. Everything deleted in one action shares a stamp, so
/// restoring a folder brings back exactly what was deleted with it.
fn next_stamp(conn: &Connection) -> R<i64> {
    let last: Option<i64> = conn
        .query_row(
            "SELECT MAX(x) FROM (SELECT MAX(deleted_at) AS x FROM media UNION ALL SELECT MAX(deleted_at) FROM folders)",
            [],
            |r| r.get(0),
        )
        .map_err(e)?;
    Ok(now_ms().max(last.unwrap_or(0) + 1))
}

/// Put a folder, its subfolders and everything in them in the trash.
pub fn trash_folder(conn: &Connection, id: i64) -> R<i64> {
    if !folder_exists(conn, id)? {
        return Err("That folder no longer exists.".into());
    }
    let stamp = next_stamp(conn)?;
    let all = descendants(conn, &[id])?;
    let (ph, args) = id_list(&all);
    let mut a = vec![Value::Integer(stamp)];
    a.extend(args);
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute(
        &format!(
            "UPDATE media SET deleted_at = ? WHERE deleted_at IS NULL AND folder_id IN ({ph})"
        ),
        params_from_iter(a.iter().cloned()),
    )
    .map_err(e)?;
    tx.execute(
        &format!("UPDATE folders SET deleted_at = ? WHERE deleted_at IS NULL AND id IN ({ph})"),
        params_from_iter(a),
    )
    .map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(stamp)
}

pub fn trash_items(conn: &Connection, ids: &[i64]) -> R<i64> {
    let stamp = next_stamp(conn)?;
    if ids.is_empty() {
        return Ok(stamp);
    }
    let (ph, mut args) = id_list(ids);
    args.insert(0, Value::Integer(stamp));
    conn.execute(
        &format!("UPDATE media SET deleted_at = ? WHERE deleted_at IS NULL AND id IN ({ph})"),
        params_from_iter(args),
    )
    .map_err(e)?;
    Ok(stamp)
}

/// Bring items back. Items whose folder is gone (or in the trash) come back
/// at the top level. Returns how many went to the top level that way.
pub fn restore_items(conn: &Connection, ids: &[i64]) -> R<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let (ph, args) = id_list(ids);
    let tx = conn.unchecked_transaction().map_err(e)?;
    let homeless = tx
        .execute(
            &format!(
                "UPDATE media SET folder_id = NULL WHERE id IN ({ph}) AND deleted_at IS NOT NULL AND folder_id IS NOT NULL \
                 AND folder_id NOT IN (SELECT id FROM folders WHERE deleted_at IS NULL)"
            ),
            params_from_iter(args.iter().cloned()),
        )
        .map_err(e)?;
    tx.execute(
        &format!("UPDATE media SET deleted_at = NULL WHERE id IN ({ph})"),
        params_from_iter(args),
    )
    .map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(homeless)
}

/// A free name for a folder coming back: "Name", else "Name (restored)", …
pub fn free_name(conn: &Connection, parent: Option<i64>, name: &str, except: i64) -> R<String> {
    let mut candidate = name.to_string();
    let mut n = 1;
    loop {
        match find_child(conn, parent, &candidate)? {
            Some(other) if other != except => {
                candidate = if n == 1 {
                    format!("{name} (restored)")
                } else {
                    format!("{name} (restored {n})")
                };
                n += 1;
            }
            _ => return Ok(candidate),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Extracted {
    /// Where everything went (None = top level).
    pub parent: Option<i64>,
    pub items: Vec<i64>,
    pub folders: Vec<i64>,
    /// Subfolders renamed because the parent already had one with that name: (id, old, new).
    pub renamed: Vec<(i64, String, String)>,
}

/// "Extract here": move everything inside a folder up into its parent. The
/// folder itself stays (empty); a subfolder whose name is taken in the
/// parent gets " (2)", " (3)", …
pub fn extract_folder(conn: &Connection, id: i64) -> R<Extracted> {
    let parent: Option<i64> = conn
        .query_row("SELECT parent_id FROM folders WHERE id = ? AND deleted_at IS NULL", [id], |r| r.get(0))
        .map_err(|_| "That folder doesn't exist any more.".to_string())?;
    let mut out = Extracted { parent, ..Default::default() };
    let tx = conn.unchecked_transaction().map_err(e)?;
    let kids: Vec<(i64, String)> = tx
        .prepare("SELECT id, name FROM folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE")
        .map_err(e)?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    for (kid, name) in kids {
        let mut candidate = name.clone();
        let mut n = 2;
        while find_child(&tx, parent, &candidate)?.is_some() {
            candidate = format!("{name} ({n})");
            n += 1;
        }
        tx.execute("UPDATE folders SET parent_id = ?, name = ? WHERE id = ?", params![parent, candidate, kid])
            .map_err(e)?;
        if candidate != name {
            out.renamed.push((kid, name, candidate));
        }
        out.folders.push(kid);
    }
    out.items = tx
        .prepare("SELECT id FROM media WHERE folder_id = ? AND deleted_at IS NULL")
        .map_err(e)?
        .query_map([id], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    tx.execute("UPDATE media SET folder_id = ? WHERE folder_id = ? AND deleted_at IS NULL", params![parent, id])
        .map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(out)
}

/// Undo "Extract here": everything goes back inside the folder, renamed
/// subfolders get their old names back.
pub fn unextract_folder(conn: &Connection, id: i64, x: &Extracted) -> R<()> {
    let tx = conn.unchecked_transaction().map_err(e)?;
    for f in &x.folders {
        tx.execute("UPDATE folders SET parent_id = ? WHERE id = ?", params![id, f]).map_err(e)?;
    }
    for (f, old, _) in &x.renamed {
        tx.execute("UPDATE folders SET name = ? WHERE id = ?", params![old, f]).map_err(e)?;
    }
    for m in &x.items {
        tx.execute("UPDATE media SET folder_id = ? WHERE id = ?", params![id, m]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(())
}

/// Bring a deleted folder back with everything that was deleted with it.
pub fn restore_folder(conn: &Connection, id: i64) -> R<()> {
    let (stamp, parent, name): (Option<i64>, Option<i64>, String) = conn
        .query_row(
            "SELECT deleted_at, parent_id, name FROM folders WHERE id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(e)?
        .ok_or("That folder no longer exists.")?;
    let Some(stamp) = stamp else {
        return Ok(());
    };
    // If the folder it was in is gone or still in the trash, it returns to the top level.
    let parent = match parent {
        Some(p) if folder_exists(conn, p)? => Some(p),
        _ => None,
    };
    let name = free_name(conn, parent, &name, id)?;
    let tree: Vec<i64> = descendants(conn, &[id])?;
    let (ph, args) = id_list(&tree);
    let mut a = vec![Value::Integer(stamp)];
    a.extend(args);
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute(
        "UPDATE folders SET parent_id = ?, name = ? WHERE id = ?",
        params![parent, name, id],
    )
    .map_err(e)?;
    tx.execute(
        &format!("UPDATE folders SET deleted_at = NULL WHERE deleted_at = ? AND id IN ({ph})"),
        params_from_iter(a.iter().cloned()),
    )
    .map_err(e)?;
    tx.execute(
        &format!("UPDATE media SET deleted_at = NULL WHERE deleted_at = ? AND folder_id IN ({ph})"),
        params_from_iter(a),
    )
    .map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashFolder {
    pub id: i64,
    pub name: String,
    /// Where it was, e.g. "People › Family".
    pub location: String,
    pub deleted_at: i64,
    pub items: i64,
    pub bytes: i64,
    pub cover: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashView {
    pub folders: Vec<TrashFolder>,
    /// Items deleted on their own (not as part of a deleted folder).
    pub items: Vec<Item>,
    pub total_items: i64,
    pub total_bytes: i64,
}

pub fn trash_view(conn: &Connection) -> R<TrashView> {
    let paths = vault_core::db::folder_paths(conn).map_err(|x| x.to_string())?;
    let roots: Vec<(i64, String, Option<i64>, i64)> = conn
        .prepare(
            "SELECT f.id, f.name, f.parent_id, f.deleted_at FROM folders f LEFT JOIN folders p ON p.id = f.parent_id \
             WHERE f.deleted_at IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NULL OR p.deleted_at <> f.deleted_at) \
             ORDER BY f.deleted_at DESC",
        )
        .map_err(e)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let mut folders = Vec::new();
    for (id, name, parent, stamp) in roots {
        let tree = descendants(conn, &[id])?;
        let (ph, args) = id_list(&tree);
        let mut a = vec![Value::Integer(stamp)];
        a.extend(args);
        let (items, bytes, cover): (i64, i64, Option<i64>) = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*), IFNULL(SUM(size), 0), MIN(CASE WHEN thumb_object_id <> '' THEN id END) FROM media \
                     WHERE deleted_at = ? AND folder_id IN ({ph})"
                ),
                params_from_iter(a),
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(e)?;
        folders.push(TrashFolder {
            id,
            name,
            location: parent
                .and_then(|p| paths.get(&p))
                .map(|v| v.join(" › "))
                .unwrap_or_else(|| "Top level".into()),
            deleted_at: stamp,
            items,
            bytes,
            cover,
        });
    }
    let items = conn
        .prepare(&format!(
            "SELECT {ITEM_COLS} FROM media m LEFT JOIN folders f ON f.id = m.folder_id \
             WHERE m.deleted_at IS NOT NULL AND (f.id IS NULL OR f.deleted_at IS NULL OR f.deleted_at <> m.deleted_at) \
             ORDER BY m.deleted_at DESC, m.id"
        ))
        .map_err(e)?
        .query_map([], item_row)
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)?;
    let (total_items, total_bytes) = conn
        .query_row(
            "SELECT COUNT(*), IFNULL(SUM(size), 0) FROM media WHERE deleted_at IS NOT NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(e)?;
    Ok(TrashView {
        folders,
        items,
        total_items,
        total_bytes,
    })
}

/// Remove folder rows that are in the trash and no longer hold anything.
fn drop_empty_trashed_folders(conn: &Connection) -> R<()> {
    loop {
        let n = conn
            .execute(
                "DELETE FROM folders WHERE deleted_at IS NOT NULL \
                 AND id NOT IN (SELECT folder_id FROM media WHERE folder_id IS NOT NULL) \
                 AND id NOT IN (SELECT parent_id FROM folders WHERE parent_id IS NOT NULL)",
                [],
            )
            .map_err(e)?;
        if n == 0 {
            return Ok(());
        }
    }
}

/// Delete items in the trash for good. Returns the encrypted files to remove.
pub fn delete_forever(conn: &Connection, ids: &[i64]) -> R<Orphans> {
    if ids.is_empty() {
        return Ok(Orphans::default());
    }
    let (ph, args) = id_list(ids);
    let w = format!("id IN ({ph}) AND deleted_at IS NOT NULL");
    let orphans = collect_orphans(conn, &w, &args)?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute(
        &format!("DELETE FROM media WHERE {w}"),
        params_from_iter(args),
    )
    .map_err(e)?;
    drop_empty_trashed_folders(&tx)?;
    tx.commit().map_err(e)?;
    unused_only(conn, orphans)
}

/// Delete a folder in the trash (and what was deleted with it) for good.
pub fn delete_folder_forever(conn: &Connection, id: i64) -> R<Orphans> {
    let stamp: Option<i64> = conn
        .query_row("SELECT deleted_at FROM folders WHERE id = ?", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(e)?
        .flatten();
    let Some(stamp) = stamp else {
        return Err("Only folders in the trash can be deleted for good.".into());
    };
    let tree = descendants(conn, &[id])?;
    let (ph, args) = id_list(&tree);
    let mut a = vec![Value::Integer(stamp)];
    a.extend(args.iter().cloned());
    let w = format!("deleted_at = ? AND folder_id IN ({ph})");
    let orphans = collect_orphans(conn, &w, &a)?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute(&format!("DELETE FROM media WHERE {w}"), params_from_iter(a))
        .map_err(e)?;
    // Items deleted earlier on their own stay in the trash; they come back at the top level.
    tx.execute(
        &format!("UPDATE media SET folder_id = NULL WHERE folder_id IN ({ph})"),
        params_from_iter(args.iter().cloned()),
    )
    .map_err(e)?;
    tx.execute(
        &format!(
            "UPDATE folders SET parent_id = NULL WHERE parent_id IN ({ph}) AND id NOT IN ({ph})"
        ),
        params_from_iter(args.iter().cloned().chain(args.iter().cloned())),
    )
    .map_err(e)?;
    tx.execute(
        &format!("UPDATE folders SET deleted_at = ?, parent_id = NULL WHERE id IN ({ph})"),
        params_from_iter(std::iter::once(Value::Integer(stamp)).chain(args.iter().cloned())),
    )
    .map_err(e)?;
    tx.execute(
        &format!("DELETE FROM folders WHERE id IN ({ph})"),
        params_from_iter(args),
    )
    .map_err(e)?;
    tx.commit().map_err(e)?;
    unused_only(conn, orphans)
}

pub fn empty_trash(conn: &Connection) -> R<Orphans> {
    let orphans = collect_orphans(conn, "deleted_at IS NOT NULL", &[])?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute("DELETE FROM media WHERE deleted_at IS NOT NULL", [])
        .map_err(e)?;
    tx.execute(
        "UPDATE folders SET parent_id = NULL WHERE deleted_at IS NOT NULL",
        [],
    )
    .map_err(e)?;
    tx.execute("DELETE FROM folders WHERE deleted_at IS NOT NULL", [])
        .map_err(e)?;
    tx.commit().map_err(e)?;
    unused_only(conn, orphans)
}

/// Remove things that have been in the trash longer than `days`.
pub fn purge_trash(conn: &Connection, days: i64) -> R<Orphans> {
    let cutoff = now_ms() - days * 86_400_000;
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM media WHERE deleted_at IS NOT NULL AND deleted_at < ?")
        .map_err(e)?
        .query_map([cutoff], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let mut o = delete_forever(conn, &ids)?;
    let old_roots: Vec<i64> = conn
        .prepare("SELECT id FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < ?")
        .map_err(e)?
        .query_map([cutoff], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    for f in old_roots {
        if let Ok(more) = delete_folder_forever(conn, f) {
            o.media.extend(more.media);
            o.thumbs.extend(more.thumbs);
        }
    }
    Ok(o)
}

// ---- folder look -----------------------------------------------------------------------

pub fn set_pinned(conn: &Connection, id: i64, on: bool) -> R<()> {
    conn.execute(
        "UPDATE folders SET pinned = ? WHERE id = ?",
        params![on as i64, id],
    )
    .map_err(e)?;
    Ok(())
}

fn clean_color(c: Option<&str>) -> Option<String> {
    let c = c?.trim();
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    ok.then(|| c.to_ascii_lowercase())
}

pub fn set_folder_look(
    conn: &Connection,
    id: i64,
    color: Option<&str>,
    emoji: Option<&str>,
) -> R<()> {
    let emoji = emoji
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(8).collect::<String>());
    conn.execute(
        "UPDATE folders SET color = ?, emoji = ? WHERE id = ?",
        params![clean_color(color), emoji, id],
    )
    .map_err(e)?;
    Ok(())
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

pub fn id_list(ids: &[i64]) -> (String, Vec<Value>) {
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

/// Returns, per tag, the items that didn't have it before (for undo).
pub fn tag_items(conn: &Connection, ids: &[i64], tags: &[String]) -> R<Vec<(String, Vec<i64>)>> {
    let mut out = Vec::new();
    for t in tags.iter().filter_map(|t| clean_tag(t)) {
        let tid = tag_id(conn, &t)?;
        let mut added = Vec::new();
        for id in ids {
            let n = conn
                .execute(
                    "INSERT OR IGNORE INTO media_tags(media_id, tag_id) VALUES (?, ?)",
                    [id, &tid],
                )
                .map_err(e)?;
            if n > 0 {
                added.push(*id);
            }
        }
        out.push((t, added));
    }
    Ok(out)
}

/// Returns the items that had the tag (for undo).
pub fn untag_items(conn: &Connection, ids: &[i64], tag: &str) -> R<Vec<i64>> {
    let mut had = Vec::new();
    for id in ids {
        let n = conn
            .execute(
                "DELETE FROM media_tags WHERE media_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
                params![id, tag.trim()],
            )
            .map_err(e)?;
        if n > 0 {
            had.push(*id);
        }
    }
    drop_unused_tags(conn)?;
    Ok(had)
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
    fn person_covers_carry_the_face() {
        let c = db::create_empty().unwrap();
        let alex = create_folder(&c, None, "Alex").unwrap();
        let trips = create_folder(&c, None, "Trips").unwrap();
        let p = add(&c, "p", Some(alex), "image");
        add(&c, "t", Some(trips), "image");
        let face = |media: i64, x: f64, w: f64, person: Option<i64>| {
            c.execute(
                "INSERT INTO faces(media_id, frame_ms, x, y, w, h, score, descriptor, person_id) VALUES (?1, 0, ?2, 0.25, ?3, ?3, 0.9, ?4, ?5)",
                params![media, x, w, vec![0u8; 512], person],
            )
            .unwrap();
        };
        face(p, 0.1, 0.4, None); // a bigger stranger
        face(p, 0.6, 0.2, Some(alex));
        let card = |id: i64| all_folders(&c).unwrap().into_iter().find(|f| f.id == id).unwrap();
        // Not a person folder yet: no face.
        assert_eq!(card(alex).cover_face, None);
        crate::faces::set_person(&c, alex, true).unwrap();
        let f = card(alex).cover_face.expect("face of the cover");
        assert!((f[0] - 0.6).abs() < 1e-6 && (f[2] - 0.2).abs() < 1e-6, "their own face, not the biggest: {f:?}");
        assert_eq!(card(trips).cover_face, None);
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
    fn trash_restore_and_delete_forever() {
        let c = db::create_empty().unwrap();
        let a = create_folder(&c, None, "A").unwrap();
        let b = create_folder(&c, Some(a), "B").unwrap();
        let x = add(&c, "x", Some(a), "image");
        let y = add(&c, "y", Some(b), "image");
        let early = add(&c, "early", Some(b), "image");
        let keep = add(&c, "z", None, "image");
        let live = |c: &Connection| {
            let mut v: Vec<i64> = query_items(c, &ItemFilter::default())
                .unwrap()
                .iter()
                .map(|i| i.id)
                .collect();
            v.sort();
            v
        };

        // One item deleted on its own first, then the whole folder.
        trash_items(&c, &[early]).unwrap();
        trash_folder(&c, a).unwrap();
        assert_eq!(live(&c), vec![keep]);
        assert!(all_folders(&c).unwrap().is_empty());
        let t = trash_view(&c).unwrap();
        assert_eq!(
            t.folders.len(),
            1,
            "only the deleted folder itself, not its subfolder"
        );
        assert_eq!(t.folders[0].items, 2, "items deleted with it");
        assert_eq!(
            t.items.iter().map(|i| i.id).collect::<Vec<_>>(),
            vec![early],
            "deleted on its own"
        );
        assert_eq!(t.total_items, 3);

        // A new folder may take the deleted one's name; restoring then renames.
        let a2 = create_folder(&c, None, "A").unwrap();
        restore_folder(&c, a).unwrap();
        let names: Vec<String> = all_folders(&c)
            .unwrap()
            .iter()
            .map(|f| f.name.clone())
            .collect();
        assert!(
            names.contains(&"A (restored)".to_string()) && names.contains(&"B".to_string()),
            "{names:?}"
        );
        assert_eq!(live(&c), vec![x, y, keep]);
        assert!(
            query_items(
                &c,
                &ItemFilter {
                    trash: true,
                    ..Default::default()
                }
            )
            .unwrap()
            .iter()
            .all(|i| i.id == early)
        );

        // Restoring an item whose folder is gone puts it at the top level.
        trash_folder(&c, a).unwrap();
        let o = delete_folder_forever(&c, a).unwrap();
        assert_eq!(o.media.len(), 2);
        restore_items(&c, &[early]).unwrap();
        assert_eq!(get_item(&c, early).unwrap().folder_id, None);
        let _ = a2;

        // Duplicate checks, names and empty trash.
        trash_items(&c, &[keep]).unwrap();
        let o = empty_trash(&c).unwrap();
        assert_eq!(o.media.len(), 1);
        assert_eq!(live(&c), vec![early]);
        assert_eq!(trash_view(&c).unwrap().total_items, 0);
        assert!(
            delete_forever(&c, &[early]).unwrap().media.is_empty(),
            "only things in the trash"
        );
    }

    #[test]
    fn old_trash_is_purged() {
        let c = db::create_empty().unwrap();
        let f = create_folder(&c, None, "Old").unwrap();
        add(&c, "a", Some(f), "image");
        let fresh = add(&c, "b", None, "image");
        trash_folder(&c, f).unwrap();
        trash_items(&c, &[fresh]).unwrap();
        c.execute("UPDATE folders SET deleted_at = 1000", [])
            .unwrap();
        c.execute("UPDATE media SET deleted_at = 1000 WHERE id <> ?", [fresh])
            .unwrap();
        let o = purge_trash(&c, TRASH_DAYS).unwrap();
        assert_eq!(o.media.len(), 1);
        assert_eq!(trash_view(&c).unwrap().total_items, 1);
        assert!(trash_view(&c).unwrap().folders.is_empty());
    }

    #[test]
    fn name_search_ignores_case_including_turkish() {
        let c = db::create_empty().unwrap();
        let a = add(&c, "İSTANBUL_2023.jpg", None, "image");
        let b = add(&c, "ırmak kenarı.jpg", None, "image");
        add(&c, "other.png", None, "image");
        let find = |q: &[&str]| {
            query_items(
                &c,
                &ItemFilter {
                    names: q.iter().map(|s| s.to_string()).collect(),
                    ..Default::default()
                },
            )
            .unwrap()
            .iter()
            .map(|i| i.id)
            .collect::<Vec<_>>()
        };
        assert_eq!(find(&["istanbul"]), vec![a]);
        assert_eq!(find(&["IRMAK"]), vec![b]);
        assert_eq!(find(&["jpg", "2023"]), vec![a]);
        assert!(find(&["%"]).is_empty());
    }

    #[test]
    fn pins_colours_and_emoji() {
        let c = db::create_empty().unwrap();
        let f = create_folder(&c, None, "Trips").unwrap();
        set_pinned(&c, f, true).unwrap();
        set_folder_look(&c, f, Some("#2EC4B6"), Some(" 🌊 ")).unwrap();
        let card = &all_folders(&c).unwrap()[0];
        assert!(card.pinned);
        assert_eq!(card.color.as_deref(), Some("#2ec4b6"));
        assert_eq!(card.emoji.as_deref(), Some("🌊"));
        set_folder_look(&c, f, Some("red; drop table"), None).unwrap();
        let card = &all_folders(&c).unwrap()[0];
        assert_eq!(card.color, None);
        assert_eq!(card.emoji, None);
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
        let added = tag_items(&c, &[m2, m3], &["#sunny ".into()]).unwrap();
        assert_eq!(added, vec![("sunny".to_string(), vec![m2, m3])]);
        assert_eq!(
            tag_items(&c, &[m2, m1], &["sunny".into()]).unwrap()[0].1,
            vec![m1]
        );
        assert_eq!(untag_items(&c, &[m1], "sunny").unwrap(), vec![m1]);
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
    #[test]
    fn renames_many_at_once_all_or_nothing() {
        let c = vault_core::db::create_empty().unwrap();
        let a = create_folder(&c, None, "A").unwrap();
        let b = create_folder(&c, None, "B").unwrap();
        let p = add(&c, "p.jpg", None, "image");
        // Swapping names works.
        rename_many(&c, &[(a, "B".into()), (b, "A".into())], &[(p, " Beach 01.jpg ".into())]).unwrap();
        assert_eq!(find_child(&c, None, "B").unwrap(), Some(a));
        assert_eq!(get_item(&c, p).unwrap().name, "Beach 01.jpg");
        // A bad name changes nothing.
        assert!(rename_many(&c, &[(a, "C".into())], &[(p, "x?.jpg".into())]).is_err());
        assert_eq!(find_child(&c, None, "B").unwrap(), Some(a));
        assert!(rename_many(&c, &[], &[(p, ".jpg".into())]).is_err());
        // Two folders can't end up with the same name.
        assert!(rename_many(&c, &[(a, "Same".into()), (b, "Same".into())], &[]).is_err());
        assert_eq!(find_child(&c, None, "A").unwrap(), Some(b));
    }

    #[test]
    fn extract_moves_everything_up_and_renames_clashes() {
        let c = vault_core::db::create_empty().unwrap();
        let trips = create_folder(&c, None, "Trips").unwrap();
        let beach = create_folder(&c, Some(trips), "Beach").unwrap();
        let day2 = create_folder(&c, Some(beach), "Day 2").unwrap();
        let _other_day2 = create_folder(&c, Some(trips), "Day 2").unwrap();
        let photo = add(&c, "p.jpg", Some(beach), "image");
        let x = extract_folder(&c, beach).unwrap();
        assert_eq!(x.parent, Some(trips));
        assert_eq!(x.items, vec![photo]);
        assert_eq!(x.renamed, vec![(day2, "Day 2".to_string(), "Day 2 (2)".to_string())]);
        assert_eq!(get_item(&c, photo).unwrap().folder_id, Some(trips));
        assert_eq!(find_child(&c, Some(trips), "Day 2 (2)").unwrap(), Some(day2));
        // Undo puts it all back.
        unextract_folder(&c, beach, &x).unwrap();
        assert_eq!(get_item(&c, photo).unwrap().folder_id, Some(beach));
        assert_eq!(find_child(&c, Some(beach), "Day 2").unwrap(), Some(day2));
    }

}
