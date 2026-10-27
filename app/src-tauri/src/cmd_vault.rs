//! Commands for vaults themselves: the start screen's vault list, creating
//! and opening vaults, unlocking (with the password or the recovery words),
//! setting, changing and removing the password, locking, idle time, saving
//! now, and Settings. Also the vault's storage (pack files, reclaiming space,
//! the cache and saved data, the size by month) and checking for damage.

use std::sync::atomic::Ordering;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::activity::{Activity, LockReason};
use crate::config::AppConfig;
use crate::session::{SessionInfo, VaultEntry};
use crate::{Shared, begin_task, blocking, install_session, lock_now, read_db, sess, with_session};
use crate::{access, config, growth, integrity, library, nocapture, poorfaces, session, storage, throttle};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppStateDto {
    config: AppConfig,
    vaults: Vec<VaultEntry>,
    session: Option<SessionInfo>,
    min_password_chars: usize,
}

#[tauri::command]
pub(crate) async fn get_state(state: State<'_, Shared>) -> Result<AppStateDto, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let config = inner.config.lock().unwrap_or_else(|e| e.into_inner()).clone();
        // Sizes take a while to add up: the window asks for them afterwards (vault_sizes).
        let vaults = config
            .vaults
            .iter()
            .map(|v| session::describe_quick(&v.path))
            .collect();
        let session = inner.session.lock().unwrap_or_else(|e| e.into_inner()).clone().map(|s| s.info());
        Ok(AppStateDto {
            config,
            vaults,
            session,
            min_password_chars: session::MIN_PASSWORD_CHARS,
        })
    })
    .await
}

/// The size of each vault in the list (adding up their files), for the
/// start screen after it has shown the list. Vaults that aren't there: none.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultSize {
    path: String,
    size_bytes: Option<u64>,
}

#[tauri::command]
pub(crate) async fn vault_sizes(state: State<'_, Shared>) -> Result<Vec<VaultSize>, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let paths: Vec<String> = inner.config.lock().unwrap_or_else(|e| e.into_inner()).vaults.iter().map(|v| v.path.clone()).collect();
        Ok(paths
            .into_iter()
            .map(|path| {
                let size_bytes = session::describe(&path).size_bytes;
                VaultSize { path, size_bytes }
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub(crate) fn save_config(
    app: AppHandle,
    state: State<'_, Shared>,
    config: AppConfig,
) -> Result<AppConfig, String> {
    let mut cfg = state.config.lock().unwrap_or_else(|e| e.into_inner());
    let mut next = config.sanitized();
    next.vaults = cfg.vaults.clone(); // vault list is only changed through its own commands
    next.last_vault = cfg.last_vault.clone();
    config::save(&state.config_dir, &next).map_err(|e| format!("Couldn't save settings: {e}"))?;
    nocapture::apply_all(&app, next.block_capture);
    poorfaces::set_rule(&next.poor_faces); // poor faces re-sorted at once
    *cfg = next.clone();
    Ok(next)
}

#[tauri::command]
pub(crate) fn add_vault(state: State<'_, Shared>, path: String) -> Result<VaultEntry, String> {
    let entry = session::describe(&path);
    if entry.status != "ready" {
        return Err(format!(
            "{path} is not a Media Vault folder. Choose the folder that contains vault.json."
        ));
    }
    let mut cfg = state.config.lock().unwrap_or_else(|e| e.into_inner());
    cfg.add_vault(&path);
    config::save(&state.config_dir, &cfg).map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
pub(crate) fn forget_vault(state: State<'_, Shared>, path: String) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap_or_else(|e| e.into_inner());
    cfg.forget_vault(&path);
    config::save(&state.config_dir, &cfg).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Created {
    session: SessionInfo,
    words: Vec<String>,
}

#[tauri::command]
pub(crate) async fn create_vault(
    state: State<'_, Shared>,
    parent: String,
    name: String,
    // None = a vault without a password.
    password: Option<String>,
    // false = a vault without encryption (no password, ordinary files).
    encrypt: Option<bool>,
) -> Result<Created, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let (s, words) = match password {
            _ if encrypt == Some(false) => (session::create_plain(&parent, &name, inner.kdf)?, Vec::new()),
            Some(pw) => session::create(&parent, &name, &pw, inner.kdf)?,
            None => session::create_without_password(&parent, &name, inner.kdf)?,
        };
        Ok(Created {
            session: install_session(&inner, s),
            words,
        })
    })
    .await
}

/// A wrong password (or wrong recovery words) for a real vault is counted.
fn note_failure(path: &str) {
    access::record_failure(std::path::Path::new(path));
}

#[tauri::command]
pub(crate) async fn unlock(
    state: State<'_, Shared>,
    path: String,
    password: String,
) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let s = session::unlock(&path, &password).inspect_err(|_| note_failure(&path))?;
        Ok(install_session(&inner, s))
    })
    .await
}

/// Open a vault that has no password (from the vault list, by hand).
#[tauri::command]
pub(crate) async fn open_vault(state: State<'_, Shared>, path: String) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let s = session::open_without_password(&path)?;
        Ok(install_session(&inner, s))
    })
    .await
}

#[tauri::command]
pub(crate) async fn unlock_with_recovery(
    state: State<'_, Shared>,
    path: String,
    words: String,
) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let s = session::unlock_with_recovery(&path, &words).inspect_err(|_| note_failure(&path))?;
        Ok(install_session(&inner, s))
    })
    .await
}

/// After unlocking with the recovery key: set a new password (no old one needed).
#[tauri::command]
pub(crate) async fn set_new_password(
    state: State<'_, Shared>,
    password: String,
) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || {
        session::check_password(&password)?;
        with_session(&inner, |s| {
            if !s.needs_new_password() {
                return Err("Use “Change password” in Settings instead.".into());
            }
            s.vault_mut()
                .change_password(&password)
                .map_err(session::friendly)?;
            s.set_needs_new_password(false);
            Ok(s.info())
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn change_password(
    state: State<'_, Shared>,
    current: String,
    password: String,
) -> Result<(), String> {
    let inner = state.inner().clone();
    blocking(move || {
        session::check_password(&password)?;
        let root = with_session(&inner, |s| Ok(s.vault().root().to_path_buf()))?;
        session::verify_password(&root, &current)?;
        with_session(&inner, |s| {
            s.vault_mut()
                .change_password(&password)
                .map_err(session::friendly)
        })
    })
    .await
}

/// Remove the password (asks for the current one first). Only vault.json
/// changes: the vault then opens without asking, for anyone with the folder.
#[tauri::command]
pub(crate) async fn turn_password_off(state: State<'_, Shared>, current: String) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let root = with_session(&inner, |s| {
            if !s.has_password() {
                return Err("This vault already has no password.".into());
            }
            Ok(s.vault().root().to_path_buf())
        })?;
        session::verify_password(&root, &current)?;
        with_session(&inner, |s| {
            s.vault_mut().turn_password_off().map_err(session::friendly)?;
            s.set_needs_new_password(false);
            Ok(s.info())
        })
    })
    .await
}

/// Give a vault without a password one (the unprotected key is removed).
#[tauri::command]
pub(crate) async fn set_password(state: State<'_, Shared>, password: String) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || {
        session::check_password(&password)?;
        with_session(&inner, |s| {
            if s.has_password() {
                return Err("This vault already has a password. Use “Change password” instead.".into());
            }
            s.vault_mut().change_password(&password).map_err(session::friendly)?;
            // Idle time counts from now, not from when the vault was opened.
            *inner.activity.lock().unwrap_or_else(|e| e.into_inner()) = Activity::new(Instant::now());
            Ok(s.info())
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn reset_recovery(state: State<'_, Shared>, current: String) -> Result<Vec<String>, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let (root, has_password) =
            with_session(&inner, |s| Ok((s.vault().root().to_path_buf(), s.has_password())))?;
        // A vault without a password has nothing to check (it opens for anyone).
        if has_password {
            session::verify_password(&root, &current)?;
        }
        with_session(&inner, |s| {
            let phrase = s.vault_mut().reset_recovery().map_err(session::friendly)?;
            Ok(phrase.words().iter().map(|w| w.to_string()).collect())
        })
    })
    .await
}

#[tauri::command]
pub(crate) fn lock_vault(app: AppHandle, state: State<'_, Shared>) {
    lock_now(&app, &state, LockReason::Manual);
}

/// The UI calls this on mouse/keyboard use ("input") and every 10 s while
/// anything is playing ("playing").
#[tauri::command]
pub(crate) fn report_activity(state: State<'_, Shared>, kind: String) {
    let now = Instant::now();
    let mut a = state.activity.lock().unwrap_or_else(|e| e.into_inner());
    match kind.as_str() {
        "playing" => a.playing(now),
        _ => a.input(now),
    }
}

/// Ctrl+S: save everything now.
#[tauri::command]
pub(crate) async fn save_now(state: State<'_, Shared>) -> Result<(), String> {
    let s = sess(state.inner())?;
    blocking(move || if s.is_dirty() { s.save() } else { Ok(()) }).await
}

#[tauri::command]
pub(crate) async fn cache_info(state: State<'_, Shared>) -> Result<storage::CacheInfo, String> {
    let s = sess(state.inner())?;
    blocking(move || storage::cache_info(&s)).await
}

#[tauri::command]
pub(crate) async fn data_info(state: State<'_, Shared>) -> Result<storage::DataInfo, String> {
    let s = sess(state.inner())?;
    blocking(move || storage::data_info(&s)).await
}

#[tauri::command]
pub(crate) async fn delete_data(state: State<'_, Shared>, what: String) -> Result<String, String> {
    let s = sess(state.inner())?;
    blocking(move || storage::delete_data(&s, &what)).await
}

// ---- storage ------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn storage_info(state: State<'_, Shared>) -> Result<storage::StorageInfo, String> {
    let s = sess(state.inner())?;
    blocking(move || storage::info(&s)).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageProgress {
    task: &'static str,
    done: usize,
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageDone {
    task: &'static str,
    ok: bool,
    message: String,
}

/// Convert separate files into packs, or reclaim space. Runs in the
/// background (never at the same time as an import) and reports progress.
#[tauri::command]
pub(crate) fn storage_task(app: AppHandle, state: State<'_, Shared>, task: String) -> Result<(), String> {
    let s = sess(&state)?;
    let inner = state.inner().clone();
    let task: &'static str = match task.as_str() {
        "convert" => "convert",
        "reclaim" => "reclaim",
        "deleteThumbs" => "deleteThumbs",
        "deletePreviews" => "deletePreviews",
        _ => return Err("Unknown task.".into()),
    };
    // One at a time; cancel_task("storage") stops moving files into packs or
    // reclaiming space (safely, between files), as does locking the vault.
    let cancel = begin_task(&inner, "storage")?;
    std::thread::spawn(move || {
        let _turn = inner.import_gate.lock().unwrap_or_else(|e| e.into_inner());
        let result = if s.is_closed() || cancel.load(Ordering::SeqCst) {
            Err("Stopped.".to_string())
        } else if task == "deleteThumbs" || task == "deletePreviews" {
            storage::delete_cache(&s, task == "deleteThumbs")
        } else if task == "convert" {
            let mut t = throttle::Throttle::new();
            storage::convert(&s, &mut |done, total| {
                if t.ready(done >= total) {
                    let _ = app.emit("storage-progress", StorageProgress { task, done, total });
                }
            }, &cancel)
            .map(|n| format!("{n} items moved into pack files."))
        } else {
            storage::reclaim_until(&s, &cancel).map(|r| {
                format!(
                    "Freed {:.1} MB ({} items moved, {} pack files removed).",
                    r.reclaimed_bytes as f64 / 1e6,
                    r.moved,
                    r.packs_removed
                )
            })
        };
        inner.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove("storage");
        let (ok, message) = match result {
            Ok(m) => (true, m),
            Err(e) => (false, e),
        };
        let _ = app.emit("storage-done", StorageDone { task, ok, message });
    });
    Ok(())
}

// ---- check for damage, stopping a task ----------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskProgress {
    task: &'static str,
    done: usize,
    total: usize,
}

/// Read every item in full to find damage. Reports "check-progress" and
/// finally "check-done" with the report.
#[tauri::command]
pub(crate) fn check_damage(app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    let s = sess(&state)?;
    let inner = state.inner().clone();
    let cancel = begin_task(&inner, "check")?;
    std::thread::spawn(move || {
        let _turn = inner.import_gate.lock().unwrap_or_else(|e| e.into_inner());
        let mut t = throttle::Throttle::new();
        let r = integrity::run(&s, &cancel, &mut |done, total| {
            if t.ready(done == total) {
                let _ = app.emit("check-progress", TaskProgress { task: "check", done, total });
            }
        });
        inner.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove("check");
        let _ = app.emit("check-done", r.map_err(|e| e.to_string()));
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_task(state: State<'_, Shared>, task: String) {
    if let Some(c) = state.tasks.lock().unwrap_or_else(|e| e.into_inner()).get(task.as_str()) {
        c.store(true, Ordering::SeqCst);
    }
}

// ---- vault growth ------------------------------------------------------------------

/// Stored size by the month things were added (growth.rs).
#[tauri::command]
pub(crate) async fn vault_growth(state: State<'_, Shared>) -> Result<growth::Growth, String> {
    read_db(state.inner(), |c| growth::growth(c, library::now_secs())).await
}
