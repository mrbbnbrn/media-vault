//! The vault side of a transfer: what to offer, how to answer an offer, and
//! putting a received item into the library (§9–§11 of the protocol).
//! No sockets here; `conn.rs` drives these.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use super::mvtp::{Answer, AnswerOne, Mark, Offer, OfferFolder, OfferItem, ans};
use crate::import::ext_of;
use crate::library::now_secs;

/// Kinds this vault stores from a phone.
pub const KINDS: &[&str] = &["image", "gif", "video"];

// ---- names (§10, r2) --------------------------------------------------------

fn clean_text(s: &str, bad: &[char]) -> String {
    s.chars()
        .filter(|c| !c.is_control() && !bad.contains(c))
        .collect::<String>()
        .trim()
        .to_string()
}

fn cut_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// A received folder name: trimmed, no control characters, max 120 characters.
/// Characters Windows doesn't allow in file names are left out too, because
/// exports use folder names.
pub fn clean_folder_name(name: &str) -> String {
    let n = clean_text(name, &['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
    let n = cut_chars(&n, 120).trim().to_string();
    if n.is_empty() { "Folder".into() } else { n }
}

/// A received item name: trimmed, no control characters or slashes, max 200
/// characters keeping the extension, empty → "file" (r2).
pub fn clean_item_name(name: &str) -> String {
    let n = clean_text(name, &['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
    if n.is_empty() || n == "." {
        return "file".into();
    }
    if n.chars().count() <= 200 {
        return n;
    }
    match n.rfind('.') {
        Some(dot) if n.len() - dot <= 12 && dot > 0 => {
            let ext = &n[dot..];
            let stem = cut_chars(&n[..dot], 200 - ext.chars().count());
            format!("{}{ext}", stem.trim_end())
        }
        _ => cut_chars(&n, 200),
    }
}

pub fn mime_of(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "3gp" => "video/3gpp",
        "avi" => "video/x-msvideo",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" | "srt" | "vtt" | "nfo" | "ini" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

// ---- sending: what to offer --------------------------------------------------

/// One item to send: its library row and what goes in the offer.
pub struct Outgoing {
    #[allow(dead_code)] // kept for logs and later use
    pub media_id: i64,
    pub object_id: String,
    pub item: OfferItem,
}

/// Everything the user picked, ready to offer: the folder tree and items.
pub struct Outbox {
    pub folders: Vec<OfferFolder>,
    pub items: Vec<Outgoing>,
}

/// Items in these folders and all folders under them (not in the trash).
fn items_under(conn: &Connection, folders: &[i64]) -> Result<Vec<i64>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut todo: Vec<i64> = folders.to_vec();
    while let Some(f) = todo.pop() {
        if !seen.insert(f) {
            continue;
        }
        let mut st = conn
            .prepare_cached("SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL")
            .map_err(|e| e.to_string())?;
        todo.extend(st.query_map([f], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.flatten());
        let mut st = conn
            .prepare_cached("SELECT id FROM media WHERE folder_id = ? AND deleted_at IS NULL ORDER BY id")
            .map_err(|e| e.to_string())?;
        out.extend(st.query_map([f], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.flatten());
    }
    Ok(out)
}

fn own_tags(conn: &Connection, sql: &str, id: i64) -> Vec<String> {
    conn.prepare_cached(sql)
        .and_then(|mut st| st.query_map([id], |r| r.get::<_, String>(0)).map(|r| r.flatten().collect()))
        .unwrap_or_default()
}

/// Build what to offer for these items and folders (folders count with
/// everything under them). Items are numbered from `first_ref`.
pub fn outbox(conn: &Connection, media: &[i64], folders: &[i64], first_ref: u32) -> Result<Outbox, String> {
    let mut ids: Vec<i64> = Vec::new();
    let mut seen = HashSet::new();
    for id in media.iter().copied().chain(items_under(conn, folders)?) {
        if seen.insert(id) {
            ids.push(id);
        }
    }
    let mut out_folders: Vec<OfferFolder> = Vec::new();
    // Library folder id → offer number.
    let mut fno: HashMap<i64, i64> = HashMap::new();
    let mut items = Vec::new();
    let mut next_ref = first_ref;
    for id in ids {
        type Row = (String, Option<i64>, String, String, i64, Option<i64>, Option<i64>, Option<i64>, String, Option<i64>, bool);
        let row: Option<Row> = conn
            .query_row(
                "SELECT object_id, folder_id, kind, original_name, size, width, height, duration_ms, sha256, taken_at, favourite \
                 FROM media WHERE id = ? AND deleted_at IS NULL",
                [id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                        r.get::<_, i64>(10)? != 0,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((object_id, folder, kind, name, size, w, h, dur, sha, taken, fav)) = row else { continue };
        // The folder path, from the top down; each folder numbered once.
        let mut path = Vec::new();
        let mut cur = folder;
        while let Some(f) = cur {
            if fno.contains_key(&f) {
                break;
            }
            let (name, parent): (String, Option<i64>) = conn
                .query_row("SELECT name, parent_id FROM folders WHERE id = ?", [f], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?;
            path.push((f, name));
            cur = parent;
        }
        for (f, name) in path.into_iter().rev() {
            let parent: Option<i64> = conn
                .query_row("SELECT parent_id FROM folders WHERE id = ?", [f], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let n = out_folders.len() as i64;
            out_folders.push(OfferFolder {
                f: n,
                parent: parent.and_then(|p| fno.get(&p).copied()).unwrap_or(-1),
                name,
                tags: own_tags(
                    conn,
                    "SELECT t.name FROM folder_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.folder_id = ? ORDER BY t.name",
                    f,
                ),
            });
            fno.insert(f, n);
        }
        let ext = ext_of(&name);
        let marks = if kind == "video" {
            conn.prepare_cached("SELECT position_ms, note FROM bookmarks WHERE media_id = ? ORDER BY position_ms")
                .and_then(|mut st| {
                    st.query_map([id], |r| Ok(Mark { ms: r.get(0)?, note: r.get(1)? })).map(|r| r.flatten().collect())
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        items.push(Outgoing {
            media_id: id,
            object_id,
            item: OfferItem {
                i: next_ref,
                sha256: sha.to_ascii_lowercase(),
                name,
                size: size.max(0) as u64,
                kind,
                mime: mime_of(&ext).into(),
                w: w.unwrap_or(0),
                h: h.unwrap_or(0),
                dur_ms: dur.unwrap_or(0),
                // Seconds in the library; 0 or none = unknown.
                taken: taken.filter(|t| *t > 0).map(|t| t * 1000),
                fav,
                tags: own_tags(
                    conn,
                    "SELECT t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = ? ORDER BY t.name",
                    id,
                ),
                marks,
                folder: folder.and_then(|f| fno.get(&f).copied()).unwrap_or(-1),
            },
        });
        next_ref = next_ref.wrapping_add(1);
    }
    Ok(Outbox { folders: out_folders, items })
}

// ---- receiving: answering an offer --------------------------------------------

/// Answer an offer: want / have (same file anywhere in the vault) / cant
/// (a kind this vault doesn't take) / nospace (§9.2).
pub fn answer(conn: &Connection, offer: &Offer, free: Option<u64>) -> Answer {
    let mut budget = free.map(|f| f.saturating_sub(256 << 20));
    let mut wanted_sha = HashSet::new();
    let answers = offer
        .items
        .iter()
        .map(|it| {
            let a = if !KINDS.contains(&it.kind.as_str()) || !valid_sha(&it.sha256) {
                ans::CANT
            } else if !wanted_sha.insert(it.sha256.to_ascii_lowercase()) || have(conn, &it.sha256) {
                ans::HAVE
            } else if budget.is_some_and(|b| b < it.size) {
                ans::NOSPACE
            } else {
                if let Some(b) = budget.as_mut() {
                    *b -= it.size;
                }
                ans::WANT
            };
            AnswerOne { i: it.i, a: a.into() }
        })
        .collect();
    Answer { offer: offer.offer, answers }
}

pub fn valid_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The same file (same SHA-256) anywhere in the vault, not in the trash?
/// (The library keeps hashes in lowercase hex.)
pub fn have(conn: &Connection, sha: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM media WHERE sha256 = ?1 AND deleted_at IS NULL LIMIT 1",
        [sha.to_ascii_lowercase()],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

// ---- receiving: the folder tree ------------------------------------------------

/// Turns an offer's folder numbers into library folders under the landing
/// folder, made only when an item actually arrives there (§10).
#[derive(Default)]
pub struct Tree {
    folders: HashMap<i64, OfferFolder>,
    made: HashMap<i64, i64>,
}

impl Tree {
    pub fn add(&mut self, folders: &[OfferFolder]) {
        for f in folders {
            self.folders.insert(f.f, f.clone());
        }
    }

    /// The library folder for offer folder `f` (−1 = the landing folder itself).
    pub fn folder(&mut self, conn: &Connection, landing: i64, f: i64) -> Result<i64, String> {
        if f < 0 {
            return Ok(landing);
        }
        if let Some(id) = self.made.get(&f) {
            return Ok(*id);
        }
        // Walk up to a known one (guarding against loops in a bad offer).
        let mut chain = Vec::new();
        let mut cur = f;
        while cur >= 0 && !self.made.contains_key(&cur) {
            if chain.contains(&cur) || chain.len() > 64 {
                return Err("bad folder tree".into());
            }
            chain.push(cur);
            cur = self.folders.get(&cur).map(|x| x.parent).ok_or("unknown folder")?;
        }
        let mut parent = if cur < 0 { landing } else { self.made[&cur] };
        for k in chain.into_iter().rev() {
            let of = &self.folders[&k];
            let id = crate::library::get_or_create_folder(conn, Some(parent), &clean_folder_name(&of.name))?;
            if !of.tags.is_empty() {
                crate::library::tag_folder(conn, id, &of.tags)?;
            }
            self.made.insert(k, id);
            parent = id;
        }
        Ok(parent)
    }
}

/// Record a received, already stored item. Returns the new media id.
pub fn insert_received(
    conn: &Connection,
    folder: i64,
    object_id: &str,
    it: &OfferItem,
    sha_hex: &str,
    size: u64,
) -> Result<i64, String> {
    let name = clean_item_name(&it.name);
    let ext = ext_of(&name);
    let kind = if KINDS.contains(&it.kind.as_str()) { it.kind.as_str() } else { "image" };
    let now = now_secs();
    // ms → s; none = when it arrived (r2).
    let taken = it.taken.filter(|t| *t > 0).map(|t| t / 1000).unwrap_or(now);
    let pos = |v: i64| (v > 0).then_some(v);
    conn.execute(
        "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, width, height, duration_ms, sha256, imported_at, taken_at, favourite) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            object_id,
            folder,
            kind,
            name,
            ext,
            size as i64,
            pos(it.w),
            pos(it.h),
            pos(it.dur_ms),
            sha_hex,
            now,
            taken,
            it.fav as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    // A format this app can't show (HEIC, MOV…): background passes leave it
    // alone; a playable copy is made after the batch.
    if super::playable::needs_copy(&ext, kind).is_some() {
        super::playable::mark_unshowable(conn, id).map_err(|e| e.to_string())?;
    }
    if !it.tags.is_empty() {
        crate::library::tag_items(conn, &[id], &it.tags)?;
    }
    if kind == "video" {
        for m in it.marks.iter().take(500) {
            if m.ms >= 0 {
                crate::extras::add_bookmark(conn, id, m.ms, &cut_chars(&m.note, 500))?;
            }
        }
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        vault_core::db::create_empty().unwrap()
    }

    fn item(i: u32, sha: &str, kind: &str, folder: i64) -> OfferItem {
        OfferItem {
            i,
            sha256: sha.into(),
            name: format!("f{i}.jpg"),
            size: 10,
            kind: kind.into(),
            mime: String::new(),
            w: 4,
            h: 3,
            dur_ms: 0,
            taken: Some(1_751_371_200_000),
            fav: true,
            tags: vec!["deniz".into()],
            marks: vec![],
            folder,
        }
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_item_name("  a/b\\c\u{7}.jpg "), "abc.jpg");
        assert_eq!(clean_item_name(""), "file");
        let long = format!("{}.heic", "x".repeat(300));
        let c = clean_item_name(&long);
        assert_eq!(c.chars().count(), 200);
        assert!(c.ends_with(".heic"));
        assert_eq!(clean_folder_name("  "), "Folder");
        assert_eq!(clean_folder_name("Tatil: 2026"), "Tatil 2026");
        assert_eq!(clean_folder_name(&"y".repeat(300)).chars().count(), 120);
    }

    #[test]
    fn answers() {
        let c = db();
        let sha_have = "aa".repeat(32);
        c.execute(
            "INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('o1','image','x.jpg','jpg',1,?1,1)",
            [&sha_have],
        )
        .unwrap();
        let offer = Offer {
            offer: 3,
            last: true,
            folders: vec![],
            items: vec![
                item(1, &"bb".repeat(32), "image", -1),
                item(2, &sha_have.to_ascii_uppercase(), "video", -1),
                item(3, &"cc".repeat(32), "pdf", -1),
                item(4, &"bb".repeat(32), "image", -1), // twice in one offer
                item(5, "nothex", "image", -1),
            ],
        };
        let a = answer(&c, &offer, None);
        let got: Vec<&str> = a.answers.iter().map(|x| x.a.as_str()).collect();
        assert_eq!(got, ["want", "have", "cant", "have", "cant"]);
        let small = answer(&c, &offer, Some((256 << 20) + 5));
        assert_eq!(small.answers[0].a, "nospace");
    }

    #[test]
    fn tree_and_insert() {
        let c = db();
        let landing = super::super::store::landing_folder(&c).unwrap();
        let mut t = Tree::default();
        t.add(&[
            OfferFolder { f: 0, parent: -1, name: "Tatil".into(), tags: vec!["yaz".into()] },
            OfferFolder { f: 1, parent: 0, name: "Bodrum 2026".into(), tags: vec![] },
        ]);
        let f = t.folder(&c, landing, 1).unwrap();
        let mut it = item(7, &"dd".repeat(32), "video", 1);
        it.marks = vec![Mark { ms: 12_000, note: "intro".into() }];
        let id = insert_received(&c, f, "obj", &it, &"dd".repeat(32), 10).unwrap();
        // Path: landing / Tatil / Bodrum 2026, with the folder tag on Tatil.
        let (parent, name): (i64, String) =
            c.query_row("SELECT parent_id, name FROM folders WHERE id = ?", [f], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(name, "Bodrum 2026");
        let (gp, pname): (i64, String) =
            c.query_row("SELECT parent_id, name FROM folders WHERE id = ?", [parent], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((gp, pname.as_str()), (landing, "Tatil"));
        let ftags: i64 = c.query_row("SELECT COUNT(*) FROM folder_tags WHERE folder_id = ?", [parent], |r| r.get(0)).unwrap();
        assert_eq!(ftags, 1);
        let (taken, fav): (i64, i64) =
            c.query_row("SELECT taken_at, favourite FROM media WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((taken, fav), (1_751_371_200, 1));
        let marks: i64 = c.query_row("SELECT COUNT(*) FROM bookmarks WHERE media_id = ?", [id], |r| r.get(0)).unwrap();
        assert_eq!(marks, 1);
        // The same folder again is reused, and a bad parent loop is refused.
        assert_eq!(t.folder(&c, landing, 1).unwrap(), f);
        let mut bad = Tree::default();
        bad.add(&[
            OfferFolder { f: 0, parent: 1, name: "a".into(), tags: vec![] },
            OfferFolder { f: 1, parent: 0, name: "b".into(), tags: vec![] },
        ]);
        assert!(bad.folder(&c, landing, 0).is_err());
        // No date: the time it arrived.
        let mut it2 = item(8, &"ee".repeat(32), "image", -1);
        it2.taken = None;
        let id2 = insert_received(&c, landing, "obj2", &it2, &"ee".repeat(32), 10).unwrap();
        let t2: i64 = c.query_row("SELECT taken_at FROM media WHERE id = ?", [id2], |r| r.get(0)).unwrap();
        assert!(t2 > 1_700_000_000);
    }

    #[test]
    fn outbox_paths_tags_and_marks() {
        let c = db();
        let top = crate::library::get_or_create_folder(&c, None, "Trips").unwrap();
        let sub = crate::library::get_or_create_folder(&c, Some(top), "Bodrum").unwrap();
        crate::library::tag_folder(&c, top, &["summer".into()]).unwrap();
        c.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, taken_at, favourite) \
             VALUES ('o1', ?1, 'video', 'clip.mp4', 'mp4', 99, ?2, 1, 1700000000, 1)",
            params![sub, "AB".repeat(32)],
        )
        .unwrap();
        let mid = c.last_insert_rowid();
        crate::library::tag_items(&c, &[mid], &["sea".into()]).unwrap();
        crate::extras::add_bookmark(&c, mid, 1500, "here").unwrap();
        // Picking the top folder sends everything under it.
        let ob = outbox(&c, &[], &[top], 10).unwrap();
        assert_eq!(ob.items.len(), 1);
        let it = &ob.items[0].item;
        assert_eq!(it.i, 10);
        assert_eq!(it.sha256, "ab".repeat(32));
        assert_eq!(it.taken, Some(1_700_000_000_000));
        assert_eq!(it.tags, vec!["sea".to_string()]);
        assert_eq!(it.marks, vec![Mark { ms: 1500, note: "here".into() }]);
        assert!(it.fav);
        assert_eq!(it.mime, "video/mp4");
        assert_eq!(ob.folders.len(), 2);
        assert_eq!((ob.folders[0].name.as_str(), ob.folders[0].parent), ("Trips", -1));
        assert_eq!(ob.folders[0].tags, vec!["summer".to_string()]);
        assert_eq!((ob.folders[1].name.as_str(), ob.folders[1].parent), ("Bodrum", 0));
        assert_eq!(it.folder, 1);
        // Picking the item itself still sends its whole folder path.
        let ob2 = outbox(&c, &[mid], &[], 0).unwrap();
        assert_eq!(ob2.folders.len(), 2);
    }
}
