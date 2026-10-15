//! Storage housekeeping: how many files the vault uses, converting vaults
//! from the one-file-per-item layout to pack files, and reclaiming the space
//! left inside packs by deleted items.

use std::path::Path;

use serde::Serialize;
use vault_core::{ObjectId, ObjectKind};

use crate::session::Session;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    /// Every file in the vault folder (what a backup has to copy).
    pub files: usize,
    pub total_bytes: u64,
    pub pack_files: usize,
    /// Unused space inside packs (deleted items), freed by "reclaim space".
    pub reclaimable_bytes: u64,
    /// Items still stored as separate files (vaults from the first version).
    pub loose_objects: usize,
}

fn walk(dir: &Path, files: &mut usize, bytes: &mut u64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(&e.path(), files, bytes),
            Ok(_) => {
                *files += 1;
                *bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
            Err(_) => {}
        }
    }
}

pub fn info(s: &Session) -> Result<StorageInfo, String> {
    let v = s.vault();
    let (mut files, mut total_bytes) = (0, 0);
    walk(v.root(), &mut files, &mut total_bytes);
    let usage = v.pack_usage().map_err(|e| e.to_string())?;
    let loose = v
        .loose_objects(ObjectKind::Media)
        .map_err(|e| e.to_string())?
        .len()
        + v.loose_objects(ObjectKind::Thumbnail)
            .map_err(|e| e.to_string())?
            .len();
    Ok(StorageInfo {
        files,
        total_bytes,
        pack_files: usage.len(),
        reclaimable_bytes: usage
            .iter()
            .map(|u| u.size.saturating_sub(u.live_bytes))
            .sum(),
        loose_objects: loose,
    })
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub thumbs: usize,
    pub thumb_bytes: u64,
    pub previews: usize,
    pub preview_bytes: u64,
}

fn cache_ids(s: &Session, column: &str) -> Result<Vec<(i64, ObjectId)>, String> {
    let db = s.db();
    let mut st = db
        .prepare(&format!("SELECT id, {column} FROM media WHERE {column} IS NOT NULL AND {column} <> ''"))
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter_map(|(id, h)| ObjectId::from_hex(&h).ok().map(|o| (id, o)))
        .collect();
    Ok(rows)
}

/// How many thumbnails and preview clips there are, and the space they take.
pub fn cache_info(s: &Session) -> Result<CacheInfo, String> {
    let size = |ids: &[(i64, ObjectId)]| -> u64 {
        let v = s.vault();
        ids.iter().filter_map(|(_, o)| v.object_location(ObjectKind::Thumbnail, o)).map(|(_, _, len)| len).sum()
    };
    let t = cache_ids(s, "thumb_object_id")?;
    // "Preview clips" are both kinds: frame strips and tiny clips.
    let p = cache_ids(s, "preview_object_id")?;
    let tiny = cache_ids(s, "tiny_object_id")?;
    Ok(CacheInfo { thumbs: t.len(), thumb_bytes: size(&t), previews: p.len().max(tiny.len()), preview_bytes: size(&p) + size(&tiny) })
}

/// Delete every thumbnail (they are made again as needed) or every preview
/// clip, then give the space back.
pub fn delete_cache(s: &Session, thumbs: bool) -> Result<String, String> {
    let columns: &[&str] = if thumbs { &["thumb_object_id"] } else { &["preview_object_id", "tiny_object_id"] };
    let mut ids = Vec::new();
    for column in columns {
        ids.extend(cache_ids(s, column)?);
    }
    {
        let db = s.db();
        for column in columns {
            db.execute(&format!("UPDATE media SET {column} = NULL WHERE {column} IS NOT NULL"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    // Free copies share them: each stored file once.
    ids.sort_by_key(|(_, o)| o.to_hex());
    ids.dedup_by_key(|(_, o)| o.to_hex());
    s.mark_dirty();
    s.save().map_err(|e| e.to_string())?;
    let v = s.vault();
    for (_, o) in &ids {
        let _ = v.delete_object(ObjectKind::Thumbnail, o);
    }
    drop(v);
    let freed = reclaim(s).map(|r| r.reclaimed_bytes).unwrap_or(0);
    Ok(format!(
        "Deleted {} {}; {:.1} MB freed.{}",
        ids.len(),
        if thumbs { "thumbnails" } else { "preview clips" },
        freed as f64 / 1e6,
        if thumbs { " Thumbnails are made again in the background as you browse." } else { "" }
    ))
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    /// Faces found by face recognition and the space their data takes.
    pub faces: i64,
    pub face_bytes: u64,
    /// Items analysed for smart search.
    pub clip_items: i64,
    pub clip_bytes: u64,
    /// Copies of the library kept in meta-backups/.
    pub backups: usize,
    pub backup_bytes: u64,
    /// The library itself (unencrypted size).
    pub library_bytes: u64,
}

pub fn data_info(s: &Session) -> Result<DataInfo, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let mut d = DataInfo::default();
    {
        let db = s.db();
        (d.faces, d.face_bytes) = db
            .query_row("SELECT COUNT(*), IFNULL(SUM(length(descriptor)) + COUNT(*) * 64, 0) FROM faces", [], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?.max(0) as u64))
            })
            .map_err(e)?;
        (d.clip_items, d.clip_bytes) = db
            .query_row("SELECT COUNT(*), IFNULL(SUM(length(vec)) + COUNT(*) * 16, 0) FROM clip", [], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?.max(0) as u64))
            })
            .map_err(e)?;
        let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).map_err(e)?;
        let size: i64 = db.query_row("PRAGMA page_size", [], |r| r.get(0)).map_err(e)?;
        d.library_bytes = (pages * size).max(0) as u64;
    }
    let backups = s.vault().db_backups().map_err(|x| x.to_string())?;
    d.backups = backups.len();
    d.backup_bytes = backups.iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
    Ok(d)
}

/// Delete face-recognition data, smart-search data or the library backups.
/// Your folders, person folders and files are not touched.
pub fn delete_data(s: &Session, what: &str) -> Result<String, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let msg = match what {
        "faces" => {
            let db = s.db();
            let n: i64 = db.query_row("SELECT COUNT(*) FROM faces", [], |r| r.get(0)).map_err(e)?;
            db.execute_batch("DELETE FROM face_rejects; DELETE FROM faces; DELETE FROM face_not_same; UPDATE media SET faces_state = 0, faces_model = 0; VACUUM;")
                .map_err(e)?;
            format!("Deleted {n} faces. Person folders stay; scan again to find faces.")
        }
        "clip" => {
            let db = s.db();
            let n: i64 = db.query_row("SELECT COUNT(*) FROM clip", [], |r| r.get(0)).map_err(e)?;
            db.execute_batch("DELETE FROM clip; UPDATE media SET clip_state = 0; VACUUM;").map_err(e)?;
            format!("Deleted smart-search data for {n} items.")
        }
        "backups" => {
            let list = s.vault().db_backups().map_err(|x| x.to_string())?;
            let mut freed = 0u64;
            for p in &list {
                freed += std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(p);
            }
            return Ok(format!("Deleted {} library backups ({:.1} MB). A new one is made with the next change.", list.len(), freed as f64 / 1e6));
        }
        _ => return Err("Unknown data.".into()),
    };
    s.mark_dirty();
    s.save()?;
    Ok(msg)
}

/// Move items stored as separate files into packs. Safe to interrupt: the
/// separate files are only deleted after the packed copies are verified and
/// the library recording them has been saved.
pub fn convert(s: &Session, progress: &mut dyn FnMut(usize, usize)) -> Result<usize, String> {
    let n = s
        .vault()
        .pack_loose_objects(progress)
        .map_err(|e| e.to_string())?;
    s.mark_dirty();
    s.save()?;
    s.vault_mut()
        .remove_packed_loose_files()
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// Every encrypted file the library refers to must be findable before any
/// pack is rewritten; otherwise reclaiming space is refused.
fn check_all_present(s: &Session) -> Result<(), String> {
    let ids: Vec<(ObjectKind, String)> = {
        let db = s.db();
        let mut st = db
            .prepare(
                "SELECT 1, object_id FROM media UNION ALL \
                 SELECT 2, thumb_object_id FROM media WHERE thumb_object_id IS NOT NULL AND thumb_object_id <> '' UNION ALL \
                 SELECT 2, preview_object_id FROM media WHERE preview_object_id IS NOT NULL AND preview_object_id <> '' UNION ALL \
                 SELECT 2, tiny_object_id FROM media WHERE tiny_object_id IS NOT NULL AND tiny_object_id <> ''",
            )
            .map_err(|e| e.to_string())?;
        st.query_map([], |r| {
            Ok((
                if r.get::<_, i64>(0)? == 1 {
                    ObjectKind::Media
                } else {
                    ObjectKind::Thumbnail
                },
                r.get::<_, String>(1)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?
    };
    let v = s.vault();
    let mut missing = 0;
    for (kind, hex) in ids {
        let Ok(id) = ObjectId::from_hex(&hex) else {
            continue;
        };
        if !v.is_packed(&id) && v.open_object(kind, &id).is_err() {
            missing += 1;
        }
    }
    if missing > 0 {
        return Err(format!(
            "{missing} item(s) can't be found, so nothing was rewritten. Run “Check for damage” or keep a backup before trying again."
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimReport {
    pub moved: usize,
    pub reclaimed_bytes: u64,
    pub packs_removed: usize,
}

/// Rewrite packs that are at least 20% unused space.
pub fn reclaim(s: &Session) -> Result<ReclaimReport, String> {
    s.save()?;
    check_all_present(s)?;
    let plan = s.vault().compact(0.2).map_err(|e| e.to_string())?;
    s.mark_dirty();
    // The new locations must be saved before the old packs are deleted.
    s.save()?;
    s.vault().finish_compact(&plan).map_err(|e| e.to_string())?;
    Ok(ReclaimReport {
        moved: plan.moved,
        reclaimed_bytes: plan.reclaimed_bytes,
        packs_removed: plan.retired.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{import, library, session};
    use std::sync::atomic::AtomicBool;

    #[test]
    fn thumbnails_and_preview_clips_can_be_counted_and_deleted() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        let src = t.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..3 {
            std::fs::write(src.join(format!("{i}.mp4")), vec![i as u8 + 1; 50_000]).unwrap();
        }
        import::run(
            &s,
            &import::Job { id: 1, paths: vec![src.display().to_string()], target: None, password: None, archive_folder: true },
            &AtomicBool::new(false),
            &mut |_| {},
        );
        let ids: Vec<i64> = s.db().prepare("SELECT id FROM media").unwrap().query_map([], |r| r.get(0)).unwrap().flatten().collect();
        for id in &ids {
            let (th, _) = s.vault().add_object(ObjectKind::Thumbnail, &[1u8; 4000][..]).unwrap();
            let (pv, _) = s.vault().add_object(ObjectKind::Thumbnail, &[2u8; 20_000][..]).unwrap();
            s.db().execute("UPDATE media SET thumb_object_id = ?, preview_object_id = ? WHERE id = ?", rusqlite::params![th.to_hex(), pv.to_hex(), id]).unwrap();
        }
        s.save().unwrap();
        let c = cache_info(&s).unwrap();
        assert_eq!((c.thumbs, c.previews), (3, 3));
        assert!(c.preview_bytes >= 60_000 && c.thumb_bytes >= 12_000);
        assert!(library::query_items(&s.db(), &Default::default()).unwrap().iter().all(|i| i.preview));

        delete_cache(&s, false).unwrap();
        let c = cache_info(&s).unwrap();
        assert_eq!((c.thumbs, c.previews), (3, 0));
        assert!(library::query_items(&s.db(), &Default::default()).unwrap().iter().all(|i| !i.preview));
        // The videos themselves are untouched.
        check_all_present(&s).unwrap();
        delete_cache(&s, true).unwrap();
        assert_eq!(cache_info(&s).unwrap().thumbs, 0);
        check_all_present(&s).unwrap();
    }

    #[test]
    fn face_and_smart_search_data_and_backups_can_be_deleted() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        s.db()
            .execute_batch(
                "INSERT INTO folders(id, name, created_at, person) VALUES (1, 'Ayşe', 0, 1);
                 INSERT INTO media(id, object_id, kind, original_name, ext, size, sha256, imported_at, faces_state, clip_state)
                   VALUES (1, 'aa', 'image', 'a.jpg', 'jpg', 1, 'h', 0, 1, 1);",
            )
            .unwrap();
        s.db().execute("INSERT INTO faces(media_id, x, y, w, h, score, descriptor, person_id) VALUES (1, 0, 0, 1, 1, 0.9, ?, 1)", [vec![0u8; 512]]).unwrap();
        s.db().execute("INSERT INTO clip(media_id, vec) VALUES (1, ?)", [vec![0u8; 2048]]).unwrap();
        s.save().unwrap();
        s.save().unwrap(); // a backup copy exists now
        let d = data_info(&s).unwrap();
        assert_eq!((d.faces, d.clip_items), (1, 1));
        assert!(d.face_bytes >= 512 && d.clip_bytes >= 2048 && d.backups >= 1 && d.library_bytes > 0);

        delete_data(&s, "faces").unwrap();
        delete_data(&s, "clip").unwrap();
        delete_data(&s, "backups").unwrap();
        let d = data_info(&s).unwrap();
        assert_eq!((d.faces, d.clip_items, d.backups), (0, 0, 0));
        let (person, fs, cs): (i64, i64, i64) = s
            .db()
            .query_row("SELECT f.person, m.faces_state, m.clip_state FROM folders f, media m", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!((person, fs, cs), (1, 0, 0), "person folders stay; items can be scanned again");
        assert!(delete_data(&s, "everything").is_err());
    }

    #[test]
    fn delete_then_reclaim_keeps_the_rest_intact() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(
            t.path().to_str().unwrap(),
            "V",
            "long enough pw",
            vault_core::KdfParams::TEST_ONLY,
        )
        .unwrap();
        let src = t.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..12 {
            std::fs::write(src.join(format!("{i:02}.jpg")), vec![i as u8; 200_000 + i]).unwrap();
        }
        let r = import::run(
            &s,
            &import::Job {
                id: 1,
                paths: vec![src.display().to_string()],
                target: None,
                password: None,
                archive_folder: true,
            },
            &AtomicBool::new(false),
            &mut |_| {},
        );
        assert_eq!(r.imported, 12);
        let before = info(&s).unwrap();
        assert_eq!(before.loose_objects, 0);
        assert!(before.files < 20, "{} files", before.files);

        let items = library::query_items(&s.db(), &library::ItemFilter::default()).unwrap();
        let (gone, kept): (Vec<_>, Vec<_>) = items.iter().partition(|i| i.name.as_str() < "09");
        let gone_ids: Vec<i64> = gone.iter().map(|i| i.id).collect();
        library::trash_items(&s.db(), &gone_ids).unwrap();
        let o = library::delete_forever(&s.db(), &gone_ids).unwrap();
        s.save().unwrap();
        import::remove_objects(&s, &o);
        assert!(info(&s).unwrap().reclaimable_bytes > 1_500_000);

        let rep = reclaim(&s).unwrap();
        assert!(rep.reclaimed_bytes > 1_500_000);
        assert!(info(&s).unwrap().total_bytes < before.total_bytes / 2);

        // Reopen: everything kept is still there and intact.
        let path = s.info().path;
        drop(s);
        let s = session::unlock(&path, "long enough pw").unwrap();
        for k in kept {
            let obj: String = s
                .db()
                .query_row("SELECT object_id FROM media WHERE id = ?", [k.id], |r| {
                    r.get(0)
                })
                .unwrap();
            let bytes = s
                .vault()
                .read_object(ObjectKind::Media, &ObjectId::from_hex(&obj).unwrap())
                .unwrap();
            assert_eq!(bytes.len() as i64, k.size);
        }
    }
}
