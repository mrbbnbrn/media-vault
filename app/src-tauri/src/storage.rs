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
                 SELECT 2, thumb_object_id FROM media WHERE thumb_object_id IS NOT NULL AND thumb_object_id <> ''",
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
        let o =
            library::delete_items(&s.db(), &gone.iter().map(|i| i.id).collect::<Vec<_>>()).unwrap();
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
