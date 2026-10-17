//! Vaults without encryption: every item's file is an ordinary file under
//! `Files/`, in folders named like the vault's folders, with the item's own
//! name (a number is added to tell apart files with the same name; items in
//! the trash are in `Files/.trash/`). Free copies share their original's
//! file.
//!
//! The vault core keeps new files in `Files/.new/<id>`; [`arrange`] (run by
//! the watcher a moment after changes) moves each file to where it belongs
//! now — after an import, a move, a rename, the trash — and records it in
//! `plain_files`. Each move is recorded first (`prev` = where it was) and
//! saved, then made, then `prev` is cleared, so a crash in between never
//! loses a file: the core looks in both places.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use rusqlite::{Connection, params};
use vault_core::{ObjectId, PlainFile};

use crate::session::Session;

/// Where items in the trash are kept.
pub const TRASH_DIR: &str = ".trash";

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

/// One arrange at a time.
static RUNNING: Mutex<()> = Mutex::new(());
/// The library's change count when files were last arranged (nothing to do if it's the same).
static ARRANGED_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Like [`arrange`], but only if the library changed since last time (the watcher calls this every few seconds).
pub fn arrange_if_changed(s: &Session) -> Result<usize, String> {
    let now = s.changes();
    if ARRANGED_AT.load(std::sync::atomic::Ordering::SeqCst) == now {
        return Ok(0);
    }
    let n = arrange(s)?;
    // Its own changes don't count as new ones.
    ARRANGED_AT.store(if n == 0 { now } else { s.changes() }, std::sync::atomic::Ordering::SeqCst);
    Ok(n)
}

/// A name usable as a file or folder name on Windows (and not one of ours).
pub fn safe_part(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c })
        .collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() {
        s = "_".into();
    }
    if s.starts_with('.') {
        s.insert(0, '_');
    }
    let upper = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3",
        "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&upper.as_str()) {
        s.insert(0, '_');
    }
    // Long names are cut (whole characters), keeping the extension.
    if s.chars().count() > 120 {
        let (stem, ext) = split_ext(&s);
        let keep: String = stem.chars().take(110).collect();
        s = if ext.is_empty() { keep } else { format!("{keep}.{ext}") };
    }
    s
}

fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= 10 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

/// The file name for an item (its name, with its type's extension if the name lacks it).
fn file_name(original: &str, ext: &str) -> String {
    let mut n = original.to_string();
    if !ext.is_empty() && !n.to_lowercase().ends_with(&format!(".{}", ext.to_lowercase())) {
        n = format!("{n}.{ext}");
    }
    safe_part(&n)
}

/// "name (2).ext", "name (3).ext"…
fn numbered(name: &str, n: usize) -> String {
    let (stem, ext) = split_ext(name);
    if ext.is_empty() { format!("{stem} ({n})") } else { format!("{stem} ({n}).{ext}") }
}

/// Where every stored file should be now: object id (hex) → path relative to `Files/`.
/// `on_disk(path)`: something is already at that path (never chosen as a new place).
pub fn wanted(conn: &Connection, current: &HashMap<String, String>, on_disk: &dyn Fn(&str) -> bool) -> Result<HashMap<String, String>, String> {
    // Folder paths.
    let mut folders: HashMap<i64, (String, Option<i64>)> = HashMap::new();
    {
        let mut st = conn.prepare("SELECT id, name, parent_id FROM folders").map_err(e)?;
        for r in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?))).map_err(e)? {
            let (id, name, parent) = r.map_err(e)?;
            folders.insert(id, (name, parent));
        }
    }
    let mut dir_of: HashMap<Option<i64>, String> = HashMap::new();
    let mut folder_dir = |f: Option<i64>| -> String {
        if let Some(d) = dir_of.get(&f) {
            return d.clone();
        }
        let mut parts = Vec::new();
        let mut cur = f;
        let mut guard = 0;
        while let Some(id) = cur {
            let Some((name, parent)) = folders.get(&id) else { break };
            parts.push(safe_part(name));
            cur = *parent;
            guard += 1;
            if guard > 200 {
                break;
            }
        }
        parts.reverse();
        let d = parts.join("/");
        dir_of.insert(f, d.clone());
        d
    };
    // The item each file belongs to: the first one not in the trash (free copies share the file).
    let mut owners: Vec<(String, String, String)> = Vec::new(); // object, dir, name
    let mut seen = HashSet::new();
    {
        let mut st = conn
            .prepare("SELECT object_id, folder_id, original_name, ext, deleted_at IS NOT NULL FROM media ORDER BY deleted_at IS NOT NULL, id")
            .map_err(e)?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, bool>(4)?)))
            .map_err(e)?;
        for r in rows {
            let (obj, folder, name, ext, trashed) = r.map_err(e)?;
            if !seen.insert(obj.clone()) {
                continue;
            }
            let dir = if trashed { TRASH_DIR.to_string() } else { folder_dir(folder) };
            owners.push((obj, dir, file_name(&name, &ext)));
        }
    }
    let join = |dir: &str, name: &str| if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") };
    let mut out = HashMap::new();
    // Files already in the right folder under their name (or a numbered one) stay put.
    let mut kept: HashSet<String> = HashSet::new();
    let mut rest = Vec::new();
    for (obj, dir, name) in owners {
        if let Some(cur) = current.get(&obj) {
            let (cdir, cname) = cur.rsplit_once('/').unwrap_or(("", cur.as_str()));
            let fits = cname == name || cname_matches_number(cname, &name);
            if cdir == dir && fits && kept.insert(cur.to_lowercase()) {
                out.insert(obj, cur.clone());
                continue;
            }
        }
        rest.push((obj, dir, name));
    }
    // Every path a file is at now counts as taken (files that move are still there until they do).
    let mut taken: HashSet<String> = current.values().map(|c| c.to_lowercase()).collect();
    for (obj, dir, name) in rest {
        let mut n = 1;
        let mut p = join(&dir, &name);
        while taken.contains(&p.to_lowercase()) || on_disk(&p) {
            n += 1;
            p = join(&dir, &numbered(&name, n));
        }
        taken.insert(p.to_lowercase());
        out.insert(obj, p);
    }
    Ok(out)
}

/// "name (17).ext" for any number.
fn cname_matches_number(cname: &str, name: &str) -> bool {
    let (stem, ext) = split_ext(name);
    let (cstem, cext) = split_ext(cname);
    if cext != ext {
        return false;
    }
    cstem
        .strip_prefix(stem)
        .and_then(|r| r.strip_prefix(" ("))
        .and_then(|r| r.strip_suffix(')'))
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Put every file where it belongs now. How many moved.
pub fn arrange(s: &Session) -> Result<usize, String> {
    let Ok(_one) = RUNNING.try_lock() else { return Ok(0) };
    {
        let v = s.vault();
        if !(v.header().is_plain() || v.conversion() == Some("plain")) {
            return Ok(0);
        }
    }
    let (moves, gone) = {
        let db = s.db();
        let mut current: HashMap<String, String> = HashMap::new();
        {
            let mut st = db.prepare("SELECT object_id, path FROM plain_files").map_err(e)?;
            for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)? {
                let (o, p) = r.map_err(e)?;
                current.insert(o, p);
            }
        }
        let v = s.vault();
        let files = v.files_dir();
        let on_disk = |rel: &str| rel.split('/').fold(files.clone(), |p, part| p.join(part)).exists();
        let want = wanted(&db, &current, &on_disk)?;
        // Only files that exist (an encrypted object waiting to be converted isn't one yet).
        let moves: Vec<(String, Option<String>, String)> = want
            .iter()
            .filter(|(o, p)| current.get(*o) != Some(*p))
            .filter_map(|(o, p)| {
                let id = ObjectId::from_hex(o).ok()?;
                v.media_file(&id)?;
                Some((o.clone(), current.get(o).cloned(), p.clone()))
            })
            .collect();
        let gone: Vec<String> = current.keys().filter(|o| !want.contains_key(*o)).cloned().collect();
        (moves, gone)
    };
    if moves.is_empty() && gone.is_empty() {
        return Ok(0);
    }
    // 1. Record (with where each file is now), and save.
    {
        let db = s.db();
        let v = s.vault();
        for o in &gone {
            // No item uses it now (a rotation's old file kept for undoing it, or one about to be deleted):
            // back to .new under its id, where it's still found, then forgotten here.
            if let Ok(id) = ObjectId::from_hex(o)
                && v.media_file(&id).is_some()
            {
                let back = format!("{}/{o}", vault_core::vault::NEW_FILES_DIR);
                if let Err(err) = v.move_media_file(&id, &back) {
                    eprintln!("Couldn't put an unused file back in .new: {err}");
                    continue;
                }
                v.set_media_file(id, None);
            }
            db.execute("DELETE FROM plain_files WHERE object_id = ?", [o]).map_err(e)?;
        }
        for (o, cur, to) in &moves {
            let Ok(id) = ObjectId::from_hex(o) else { continue };
            let prev = cur.clone().unwrap_or_else(|| format!("{}/{o}", vault_core::vault::NEW_FILES_DIR));
            db.execute("INSERT OR REPLACE INTO plain_files(object_id, path, prev) VALUES (?1, ?2, ?3)", params![o, to, prev]).map_err(e)?;
            v.set_media_file(id, Some(PlainFile { path: to.clone(), prev: Some(prev) }));
        }
    }
    s.mark_dirty();
    s.save()?;
    // 2. Move, 3. forget where they were.
    let mut moved = 0;
    for (o, cur, to) in &moves {
        let Ok(id) = ObjectId::from_hex(o) else { continue };
        let r = s.vault().move_media_file(&id, to);
        let db = s.db();
        match r {
            Ok(()) => {
                db.execute("UPDATE plain_files SET prev = NULL WHERE object_id = ?", [o]).map_err(e)?;
                s.vault().set_media_file(id, Some(PlainFile { path: to.clone(), prev: None }));
                moved += 1;
            }
            Err(err) => {
                // Left where it was (e.g. something else has that name): tried again next time.
                eprintln!("Couldn't move a file to {to}: {err}");
                match cur {
                    Some(c) => {
                        db.execute("UPDATE plain_files SET path = ?2, prev = NULL WHERE object_id = ?1", params![o, c]).map_err(e)?;
                        s.vault().set_media_file(id, Some(PlainFile { path: c.clone(), prev: None }));
                    }
                    None => {
                        db.execute("DELETE FROM plain_files WHERE object_id = ?", [o]).map_err(e)?;
                        s.vault().set_media_file(id, None);
                    }
                }
            }
        }
    }
    s.mark_dirty();
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_made_safe_for_windows() {
        assert_eq!(safe_part("a/b:c?.jpg"), "a_b_c_.jpg");
        assert_eq!(safe_part("  trip.  "), "trip");
        assert_eq!(safe_part(".hidden"), "_.hidden");
        assert_eq!(safe_part("CON"), "_CON");
        assert_eq!(safe_part("con.txt"), "_con.txt");
        assert_eq!(safe_part(""), "_");
        assert_eq!(file_name("beach", "jpg"), "beach.jpg");
        assert_eq!(file_name("beach.JPG", "jpg"), "beach.JPG");
        assert_eq!(numbered("a.jpg", 2), "a (2).jpg");
        assert!(cname_matches_number("a (17).jpg", "a.jpg"));
        assert!(!cname_matches_number("a (x).jpg", "a.jpg"));
        let long = format!("{}.jpg", "x".repeat(300));
        let s = safe_part(&long);
        assert!(s.ends_with(".jpg") && s.chars().count() <= 120);
    }
}
