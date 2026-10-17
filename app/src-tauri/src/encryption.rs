//! Turning a vault's encryption off or on (Settings → Vault & password).
//!
//! The vault core does the work object by object ([`vault_core::Vault::convert_one`]);
//! this runs it in the background with progress, saves the library every
//! batch (so a crash or a stop never loses anything: the vault reads both
//! kinds while it's half done, and the job carries on when asked again), then
//! reclaims the space of the old copies and finishes. Removing encryption
//! asks for the current password (when there is one); adding it asks for a
//! new password, or none, and shows a new recovery key once.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use vault_core::ObjectKind;

use crate::session::{self, Session, SessionInfo};

/// One conversion at a time.
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Asked to stop (it pauses; the vault stays readable and carries on later).
static STOP: AtomicBool = AtomicBool::new(false);

/// Objects converted between two saves of the library (and at most this many bytes).
const BATCH: usize = 64;
const BATCH_BYTES: u64 = 512 << 20;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    to: String,
    done: usize,
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Done {
    to: String,
    ok: bool,
    /// Stopped by hand (it carries on next time).
    stopped: bool,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub session: SessionInfo,
    /// The new recovery key (adding encryption only), shown once.
    pub words: Vec<String>,
}

/// Convert everything still to be converted, then finish. Stops early (and
/// returns Ok(false)) when asked to.
pub fn run(s: &Session, gate: &std::sync::Mutex<()>, mut progress: impl FnMut(usize, usize)) -> Result<bool, String> {
    let to = s.vault().conversion().map(str::to_string);
    let Some(to) = to else { return Ok(true) };
    let todo = s.vault().conversion_todo().map_err(session::friendly)?;
    let total = todo.len();
    progress(0, total);
    let mut i = 0;
    while i < total {
        if STOP.load(Ordering::SeqCst) || s.is_closed() {
            return Ok(false);
        }
        let mut later = Vec::new();
        let mut converted_files = Vec::new();
        let mut bytes = 0u64;
        let start = i;
        while i < total && i - start < BATCH && bytes < BATCH_BYTES {
            let (kind, id) = todo[i];
            bytes += s.vault().object_location(kind, &id).map(|l| l.2).unwrap_or(0);
            let r = s.vault().convert_one(kind, &id).map_err(session::friendly)?;
            if let Some(p) = r.remove_after_save {
                later.push(p);
            }
            if kind == ObjectKind::Media && to == "encrypted" {
                converted_files.push(id);
            }
            i += 1;
        }
        // The new copies are recorded before the old ones go.
        s.mark_dirty();
        s.save()?;
        {
            let v = s.vault();
            for p in &later {
                v.remove_converted(p).map_err(session::friendly)?;
            }
        }
        // Packs emptied by now go at once (the space isn't needed twice over).
        if to == "plain" {
            let _turn = gate.lock().unwrap_or_else(|e| e.into_inner());
            crate::storage::reclaim_emptied(s)?;
        }
        if !converted_files.is_empty() {
            let db = s.db();
            for id in &converted_files {
                let _ = db.execute("DELETE FROM plain_files WHERE object_id = ?", [id.to_hex()]);
                s.vault().set_media_file(*id, None);
            }
            drop(db);
            s.mark_dirty();
        }
        progress(i, total);
    }
    // Everything converted: the old copies' space is reclaimed (never during an import), then it's final.
    {
        let _turn = gate.lock().unwrap_or_else(|e| e.into_inner());
        crate::storage::reclaim_all_deleted(s)?;
    }
    s.vault_mut().finish_conversion().map_err(session::friendly)?;
    if to == "encrypted" {
        let _ = s.db().execute("DELETE FROM plain_files", []);
    }
    s.mark_dirty();
    s.save()?;
    if to == "plain" {
        crate::plainfiles::arrange(s)?;
        s.save()?;
    }
    Ok(true)
}

fn start(app: AppHandle, inner: crate::Shared, s: Arc<Session>) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    STOP.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let to = s.vault().conversion().unwrap_or("").to_string();
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let r = run(&s, &inner.import_gate, |done, total| {
            if done == 0 || done == total || last.elapsed().as_millis() >= 250 {
                last = std::time::Instant::now();
                let _ = app.emit("encryption-progress", Progress { to: to.clone(), done, total });
            }
        });
        RUNNING.store(false, Ordering::SeqCst);
        let done = match r {
            Ok(true) => Done {
                to: to.clone(),
                ok: true,
                stopped: false,
                message: if to == "plain" {
                    "The vault isn't encrypted any more: your files are ordinary files in its Files folder.".into()
                } else {
                    "The vault is encrypted now.".into()
                },
            },
            Ok(false) => Done { to: to.clone(), ok: false, stopped: true, message: "Paused. It carries on when you press Continue (or next time the vault opens).".into() },
            Err(e) => Done { to: to.clone(), ok: false, stopped: false, message: format!("It stopped: {e} Nothing is lost; press Continue to try again.") },
        };
        let _ = app.emit("encryption-done", done);
    });
}

/// Remove the encryption (asks for the current password, when there is one).
#[tauri::command]
pub async fn encryption_off(app: AppHandle, state: State<'_, crate::Shared>, current: Option<String>) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    crate::blocking(move || {
        let s = crate::sess(&inner)?;
        if s.vault().conversion().is_some() || RUNNING.load(Ordering::SeqCst) {
            return Err("The vault is already being changed.".into());
        }
        if s.vault().header().is_plain() {
            return Err("This vault isn't encrypted.".into());
        }
        if s.has_password() {
            let root = s.vault().root().to_path_buf();
            session::verify_password(&root, current.as_deref().unwrap_or(""))?;
        }
        s.save()?;
        s.vault_mut().begin_plain().map_err(session::friendly)?;
        let info = s.info();
        start(app, inner.clone(), s);
        Ok(info)
    })
    .await
}

/// Encrypt a vault without encryption: with a new password, or none. Returns the new recovery key (shown once).
#[tauri::command]
pub async fn encryption_on(app: AppHandle, state: State<'_, crate::Shared>, password: Option<String>) -> Result<Started, String> {
    let inner = state.inner().clone();
    crate::blocking(move || {
        let s = crate::sess(&inner)?;
        if s.vault().conversion().is_some() || RUNNING.load(Ordering::SeqCst) {
            return Err("The vault is already being changed.".into());
        }
        if !s.vault().header().is_plain() {
            return Err("This vault is already encrypted.".into());
        }
        if let Some(pw) = &password {
            session::check_password(pw)?;
        }
        s.save()?;
        let phrase = s.vault_mut().begin_encrypted(password.as_deref()).map_err(session::friendly)?;
        let words = phrase.words().iter().map(|w| w.to_string()).collect();
        let info = s.info();
        start(app, inner.clone(), s);
        Ok(Started { session: info, words })
    })
    .await
}

/// Carry on with a change that was paused or interrupted.
#[tauri::command]
pub async fn encryption_continue(app: AppHandle, state: State<'_, crate::Shared>) -> Result<bool, String> {
    let inner = state.inner().clone();
    crate::blocking(move || {
        let s = crate::sess(&inner)?;
        if s.vault().conversion().is_none() {
            return Ok(false);
        }
        start(app, inner.clone(), s);
        Ok(true)
    })
    .await
}

/// Pause the change (it carries on later).
#[tauri::command]
pub fn encryption_stop() {
    STOP.store(true, Ordering::SeqCst);
}

/// Open the vault's Files folder (a vault without encryption) in Explorer.
#[tauri::command]
pub fn open_files_folder(state: State<'_, crate::Shared>) -> Result<(), String> {
    let s = crate::sess(&state)?;
    let dir = s.vault().files_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer").arg(&dir).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
    }
    Ok(())
}

/// True while a change is running.
#[tauri::command]
pub fn encryption_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{import, library};
    use vault_core::ObjectId;

    fn job(path: &std::path::Path) -> import::Job {
        import::Job { id: 1, paths: vec![path.display().to_string()], target: None, password: None, archive_folder: true }
    }

    fn files_under(dir: &std::path::Path) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.extend(files_under(&p).into_iter().map(|x| format!("{}/{x}", e.file_name().to_string_lossy())));
                } else {
                    out.push(e.file_name().to_string_lossy().into_owned());
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn a_vault_is_made_plain_arranged_into_folders_and_encrypted_again() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        let src = t.path().join("Holiday");
        std::fs::create_dir_all(src.join("Day 1")).unwrap();
        std::fs::write(src.join("a.jpg"), vec![1u8; 50_000]).unwrap();
        std::fs::write(src.join("Day 1").join("b.png"), vec![2u8; 60_000]).unwrap();
        std::fs::write(src.join("Day 1").join("c.png"), vec![3u8; 70_000]).unwrap();
        let r = import::run(&s, &job(&src), &AtomicBool::new(false), &mut |_| {});
        assert_eq!(r.imported, 3);
        s.save().unwrap();
        let gate = std::sync::Mutex::new(());
        // Off.
        s.vault_mut().begin_plain().unwrap();
        assert!(run(&s, &gate, |_, _| {}).unwrap());
        assert!(s.vault().header().is_plain());
        let files = s.vault().files_dir();
        assert_eq!(files_under(&files), vec!["Holiday/Day 1/b.png", "Holiday/Day 1/c.png", "Holiday/a.jpg"]);
        assert_eq!(std::fs::read(files.join("Holiday").join("a.jpg")).unwrap(), vec![1u8; 50_000]);
        // Renamed, moved and trashed items follow; a name clash gets a number.
        let items = library::query_items(&s.db(), &library::ItemFilter::default()).unwrap();
        let id_of = |n: &str| items.iter().find(|i| i.name == n).unwrap().id;
        s.db().execute("UPDATE media SET original_name = 'b.png' WHERE id = ?", [id_of("c.png")]).unwrap();
        library::trash_items(&s.db(), &[id_of("a.jpg")]).unwrap();
        crate::plainfiles::arrange(&s).unwrap();
        assert_eq!(files_under(&files), vec![".trash/a.jpg", "Holiday/Day 1/b (2).png", "Holiday/Day 1/b.png"]);
        // Arranging again changes nothing.
        assert_eq!(crate::plainfiles::arrange(&s).unwrap(), 0);
        // Reopened: still found.
        s.save().unwrap();
        let path = s.vault().root().display().to_string();
        let obj: String = s.db().query_row("SELECT object_id FROM media WHERE id = ?", [id_of("c.png")], |r| r.get(0)).unwrap();
        drop(s);
        let s = session::open_without_password(&path).unwrap();
        assert_eq!(s.vault().read_object(ObjectKind::Media, &ObjectId::from_hex(&obj).unwrap()).unwrap()[..], vec![3u8; 70_000][..]);
        // Deleted for good: its file goes.
        let o = library::delete_forever(&s.db(), &[id_of("a.jpg")]).unwrap();
        crate::import::remove_objects(&s, &o);
        crate::plainfiles::arrange(&s).unwrap();
        assert_eq!(files_under(&files), vec!["Holiday/Day 1/b (2).png", "Holiday/Day 1/b.png"]);
        // On again, without a password.
        let phrase = s.vault_mut().begin_encrypted(None).unwrap();
        assert_eq!(phrase.words().len(), 24);
        assert!(run(&s, &gate, |_, _| {}).unwrap());
        assert!(!files.exists());
        assert!(!s.vault().header().plain);
        assert_eq!(s.vault().read_object(ObjectKind::Media, &ObjectId::from_hex(&obj).unwrap()).unwrap()[..], vec![3u8; 70_000][..]);
        let n: i64 = s.db().query_row("SELECT COUNT(*) FROM plain_files", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn a_vault_made_without_encryption_imports_ordinary_files() {
        let t = tempfile::tempdir().unwrap();
        let s = session::create_plain(t.path().to_str().unwrap(), "P", vault_core::KdfParams::TEST_ONLY).unwrap();
        assert!(!s.info().encrypted && !s.info().has_password);
        let src = t.path().join("Cats");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("tom.jpg"), b"not really a cat").unwrap();
        import::run(&s, &job(&src), &AtomicBool::new(false), &mut |_| {});
        crate::plainfiles::arrange(&s).unwrap();
        assert_eq!(std::fs::read(s.vault().files_dir().join("Cats").join("tom.jpg")).unwrap(), b"not really a cat");
    }
}
