//! Putting a library backup back (Settings → Storage → Library backups).
//!
//! The vault keeps up to 5 earlier copies of the library (meta-backups/).
//! Putting one back: the library as it is now is saved and kept as a backup
//! first, the chosen copy is decrypted in memory only, and it takes the open
//! library's place. The encrypted files in the packs are never touched:
//! where every one of them is (the pack index) is carried over from the
//! library as it is now, so nothing goes missing and nothing is deleted.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use vault_core::db::{self, Connection};
use vault_core::pack::IndexChange;

use crate::session::{friendly, Session};
use crate::{blocking, sess, Shared};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackup {
    /// The file's name in meta-backups/ (what to give back to put it back).
    pub name: String,
    /// When it was made (milliseconds since 1970).
    pub at_ms: u64,
    pub bytes: u64,
}

/// When a backup was made, from its name (meta-<ms>.db.enc).
fn made_at(p: &Path) -> Option<u64> {
    p.file_name()?.to_str()?.strip_prefix("meta-")?.strip_suffix(".db.enc")?.parse().ok()
}

/// The library backups, newest first.
pub fn list(s: &Session) -> Result<Vec<LibraryBackup>, String> {
    let mut out: Vec<LibraryBackup> = s
        .vault()
        .db_backups()
        .map_err(friendly)?
        .iter()
        .filter_map(|p| {
            Some(LibraryBackup {
                name: p.file_name()?.to_str()?.to_string(),
                at_ms: made_at(p)?,
                bytes: std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
            })
        })
        .collect();
    out.reverse();
    Ok(out)
}

/// Copy where every encrypted file is (and, for a vault without encryption,
/// where its ordinary files are) from the library now into the one put back.
fn carry_over(now: &Connection, back: &Connection) -> Result<(), String> {
    let e = |x: rusqlite::Error| x.to_string();
    let index = db::load_index(now).map_err(friendly)?;
    back.execute("DELETE FROM objects WHERE kind IN (1, 2)", []).map_err(e)?;
    let puts: Vec<IndexChange> = index.into_iter().map(|(id, l)| IndexChange::Put(id, l)).collect();
    db::apply_index_changes(back, &puts).map_err(friendly)?;
    let plain = db::load_plain_files(now).map_err(friendly)?;
    let has_plain = |c: &Connection| {
        c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'plain_files'", [], |r| r.get::<_, i64>(0))
            .map(|n| n > 0)
    };
    if has_plain(back).map_err(e)? {
        let tx = back.unchecked_transaction().map_err(e)?;
        tx.execute("DELETE FROM plain_files", []).map_err(e)?;
        for (id, f) in &plain {
            tx.execute(
                "INSERT OR REPLACE INTO plain_files(object_id, path, prev) VALUES (?1, ?2, ?3)",
                rusqlite::params![id.to_hex(), f.path, f.prev],
            )
            .map_err(e)?;
        }
        tx.commit().map_err(e)?;
    }
    Ok(())
}

/// Put the backup called `name` back in place of the open library.
pub fn restore(s: &Session, name: &str) -> Result<(), String> {
    if s.vault().conversion().is_some() {
        return Err("The vault's encryption is being changed. Try again once that has finished.".into());
    }
    let path: PathBuf = s
        .vault()
        .db_backups()
        .map_err(friendly)?
        .into_iter()
        .find(|p| p.file_name().and_then(|n| n.to_str()) == Some(name))
        .ok_or("That backup isn't there any more.")?;
    // Decrypted in memory only, and checked before anything changes.
    let bytes = s.vault().read_db_backup(&path).map_err(|_| "That backup is damaged, so it can't be put back.".to_string())?;
    let back = db::deserialize(&bytes).map_err(|_| "That backup is damaged, so it can't be put back.".to_string())?;
    drop(bytes);

    // No other save may run meanwhile (or land afterwards with the old library).
    let _saves = s.hold_saves();
    let mut lib = s.db();
    // 1. The library as it is now is saved, so it is the newest backup in a moment.
    let changes = s.vault().drain_index_changes();
    if let Err(err) = db::apply_index_changes(&lib, &changes) {
        s.vault().restore_index_changes(changes);
        return Err(format!("Couldn't save the library first: {}", friendly(err)));
    }
    let now_bytes = db::serialize(&lib).map_err(friendly)?;
    s.vault()
        .save_db_spaced(&now_bytes, std::time::Duration::from_secs(600))
        .map_err(|err| format!("Couldn't save the library first: {}", friendly(err)))?;
    drop(now_bytes);
    // 2. The backup keeps every encrypted file where it is now.
    carry_over(&lib, &back)?;
    let back_bytes = db::serialize(&back).map_err(friendly)?;
    // 3. Saved without a gap: the library as it was a moment ago becomes a backup first.
    s.vault().save_db(&back_bytes).map_err(|err| format!("Couldn't put the backup back: {}", friendly(err)))?;
    // 4. The open library is the backup from now on (the old one is closed by dropping it).
    let old = std::mem::replace(&mut *lib, back);
    drop(lib);
    drop(old);
    drop(_saves);
    // Work that follows changes looks again.
    s.mark_dirty();
    Ok(())
}

#[tauri::command]
pub async fn library_backups(state: State<'_, Shared>) -> Result<Vec<LibraryBackup>, String> {
    let s = sess(&state)?;
    blocking(move || list(&s)).await
}

#[tauri::command]
pub async fn restore_library_backup(state: State<'_, Shared>, name: String) -> Result<(), String> {
    let s = sess(&state)?;
    blocking(move || {
        // Nothing worked out from the library now stays in memory (faces, smart search, pictures).
        crate::analyse::stop();
        crate::faces::forget_cache();
        crate::facecrops::forget();
        crate::clip::forget_index();
        crate::protocol::forget_cache();
        restore(&s, &name)?;
        crate::protocol::forget_cache();
        // Read again in the background, like after unlocking.
        let s2 = s.clone();
        std::thread::spawn(move || {
            if !s2.is_closed() {
                let _ = crate::clip::warm(&*s2);
            }
            if !s2.is_closed() {
                let _ = crate::faces::warm(&*s2);
            }
        });
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session;
    use vault_core::ObjectKind;

    fn names(s: &Session) -> Vec<String> {
        s.db().prepare("SELECT name FROM folders ORDER BY name").unwrap().query_map([], |r| r.get(0)).unwrap().flatten().collect()
    }

    #[test]
    fn a_backup_can_be_put_back_and_the_library_now_is_kept() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        s.db().execute("INSERT INTO folders(id, name, created_at) VALUES (1, 'Old', 0)", []).unwrap();
        s.save().unwrap();
        // A backup with "Old" in it (saved without waiting the usual 10 minutes).
        let b = db::serialize(&s.db()).unwrap();
        s.vault().save_db(&b).unwrap();
        let first = list(&s).unwrap();
        assert!(!first.is_empty());
        let chosen = first[0].name.clone();

        // Changes since then: a new folder, and a new encrypted file.
        s.db().execute("INSERT INTO folders(id, name, created_at) VALUES (2, 'New', 0)", []).unwrap();
        let (obj, _) = s.vault().add_object(ObjectKind::Media, &[7u8; 5000][..]).unwrap();
        s.mark_dirty();

        restore(&s, &chosen).unwrap();
        assert_eq!(names(&s), vec!["Old".to_string()], "the library is back to how it was");
        // The library as it was just before is kept as the newest backup.
        let after = list(&s).unwrap();
        let newest = s.vault().read_db_backup(&s.vault().root().join(vault_core::vault::BACKUP_DIR).join(&after[0].name)).unwrap();
        let kept = db::deserialize(&newest).unwrap();
        let n: i64 = kept.query_row("SELECT COUNT(*) FROM folders WHERE name = 'New'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // The new encrypted file is still there and still found.
        assert_eq!(&s.vault().read_object(ObjectKind::Media, &obj).unwrap()[..], &[7u8; 5000][..]);

        // Saved for good: opening the vault again shows the restored library.
        s.save().unwrap();
        let root = s.vault().root().to_path_buf();
        s.close();
        s.release();
        drop(s);
        let s = session::unlock(root.to_str().unwrap(), "long enough pw").unwrap();
        assert_eq!(names(&s), vec!["Old".to_string()]);
        assert_eq!(&s.vault().read_object(ObjectKind::Media, &obj).unwrap()[..], &[7u8; 5000][..]);

        // Only a backup's own name works.
        assert!(restore(&s, "../vault.json").is_err());
        assert!(restore(&s, "meta-000000000000001.db.enc").is_err());
    }
}
