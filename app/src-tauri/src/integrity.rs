//! "Check for damage": read every encrypted item, thumbnail and database copy
//! in full. AES-GCM authenticates every chunk, so any changed or missing
//! byte is found. Damaged thumbnails are simply made again; damaged items are
//! listed so the user can decide what to do.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use vault_core::{ObjectId, ObjectKind};

use crate::session::Session;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Damaged {
    pub id: i64,
    pub name: String,
    /// "People › Alex", or "Top level".
    pub location: String,
    pub in_trash: bool,
    /// What went wrong, in plain words.
    pub problem: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub items_checked: usize,
    pub bytes_checked: u64,
    pub damaged: Vec<Damaged>,
    /// Thumbnails that were damaged and will be made again.
    pub thumbs_redone: usize,
    pub backups_ok: usize,
    pub backups_bad: Vec<String>,
    pub cancelled: bool,
    pub seconds: f64,
}

fn plain(e: &vault_core::Error) -> String {
    let s = e.to_string();
    if s.contains("not found") || s.contains("No such file") || s.contains("missing") {
        "its encrypted data is missing".into()
    } else {
        "its encrypted data is damaged".into()
    }
}

/// id, object, thumbnail, name, folder, size, in trash
type Row = (i64, String, Option<String>, String, Option<i64>, i64, bool);

/// Run the whole check. `progress(done, total)` is called as it goes.
pub fn run(s: &Session, cancel: &AtomicBool, progress: &mut dyn FnMut(usize, usize)) -> Result<Report, String> {
    let started = std::time::Instant::now();
    let rows: Vec<Row> = {
        let db = s.db();
        let mut st = db
            .prepare("SELECT id, object_id, thumb_object_id, original_name, folder_id, size, deleted_at IS NOT NULL FROM media ORDER BY id")
            .map_err(|e| e.to_string())?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?
    };
    let paths = vault_core::db::folder_paths(&s.db()).map_err(|e| e.to_string())?;
    let mut report = Report::default();
    let total = rows.len();
    let mut redo: Vec<i64> = Vec::new();
    for (i, (id, obj, thumb, name, folder, size, in_trash)) in rows.into_iter().enumerate() {
        if cancel.load(Ordering::SeqCst) || s.is_closed() {
            report.cancelled = true;
            break;
        }
        let res = ObjectId::from_hex(&obj)
            .map_err(|e| plain(&e))
            .and_then(|oid| s.vault().verify_object(ObjectKind::Media, &oid).map_err(|e| plain(&e)));
        if let Err(problem) = res {
            report.damaged.push(Damaged {
                id,
                name,
                location: folder
                    .and_then(|f| paths.get(&f))
                    .map(|p| p.join(" › "))
                    .unwrap_or_else(|| "Top level".into()),
                in_trash,
                problem,
            });
        } else {
            report.bytes_checked += size.max(0) as u64;
        }
        if let Some(t) = thumb.filter(|t| !t.is_empty())
            && ObjectId::from_hex(&t)
                .ok()
                .and_then(|oid| s.vault().verify_object(ObjectKind::Thumbnail, &oid).err().map(|_| ()))
                .is_some()
        {
            redo.push(id);
        }
        report.items_checked += 1;
        progress(i + 1, total);
    }
    // Damaged thumbnails are made again by the window in the background.
    if !redo.is_empty() {
        let db = s.db();
        for id in &redo {
            let _ = db.execute("UPDATE media SET thumb_object_id = NULL WHERE id = ?", [id]);
        }
        drop(db);
        s.mark_dirty();
        report.thumbs_redone = redo.len();
    }
    // Every database backup must still open.
    let v = s.vault();
    let backups = v.db_backups().map_err(|e| e.to_string())?;
    for b in backups {
        match v.verify_db_file(&b) {
            Ok(()) => report.backups_ok += 1,
            Err(_) => report
                .backups_bad
                .push(b.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        }
    }
    report.seconds = started.elapsed().as_secs_f64();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{import, session};
    use std::io::{Seek, SeekFrom, Write};

    #[test]
    fn finds_a_damaged_item_and_remakes_damaged_thumbnails() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        let src = t.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..4 {
            std::fs::write(src.join(format!("{i}.jpg")), vec![i as u8 + 1; 300_000]).unwrap();
        }
        import::run(
            &s,
            &import::Job { id: 1, paths: vec![src.display().to_string()], target: None, password: None, archive_folder: true },
            &AtomicBool::new(false),
            &mut |_| {},
        );
        // A thumbnail for one item.
        let thumb = s.vault().add_object(ObjectKind::Thumbnail, &[7u8; 5000][..]).unwrap().0;
        s.db().execute("UPDATE media SET thumb_object_id = ? WHERE original_name = '1.jpg'", [thumb.to_hex()]).unwrap();
        s.save().unwrap();

        let clean = run(&s, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        assert_eq!(clean.items_checked, 4);
        assert!(clean.damaged.is_empty());
        assert!(clean.backups_ok >= 1);

        // Flip one byte in the middle of item 2.jpg and inside the thumbnail.
        let corrupt = |kind: ObjectKind, hex: &str| {
            let (path, off, len) = s.vault().object_location(kind, &ObjectId::from_hex(hex).unwrap()).unwrap();
            let mut f = std::fs::OpenOptions::new().read(true).write(true).open(path).unwrap();
            f.seek(SeekFrom::Start(off + len / 2)).unwrap();
            f.write_all(&[0x5A]).unwrap();
        };
        let obj: String = s.db().query_row("SELECT object_id FROM media WHERE original_name = '2.jpg'", [], |r| r.get(0)).unwrap();
        corrupt(ObjectKind::Media, &obj);
        corrupt(ObjectKind::Thumbnail, &thumb.to_hex());

        let r = run(&s, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        assert_eq!(r.damaged.len(), 1);
        assert_eq!(r.damaged[0].name, "2.jpg");
        assert_eq!(r.damaged[0].location, "src");
        assert_eq!(r.thumbs_redone, 1);
        let t: Option<String> = s.db().query_row("SELECT thumb_object_id FROM media WHERE original_name = '1.jpg'", [], |r| r.get(0)).unwrap();
        assert!(t.is_none(), "the damaged thumbnail will be made again");
    }
}
