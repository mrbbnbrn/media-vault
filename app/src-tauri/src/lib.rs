//! Media Vault desktop app: the bridge between the window (React UI) and the
//! vault core. All crypto happens here in Rust; the UI never sees keys.

mod activity;
mod config;
mod import;
mod library;
mod protocol;
mod session;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use vault_core::KdfParams;

use activity::{Activity, LockReason, SleepDetector};
use config::AppConfig;
use session::{Session, SessionInfo, VaultEntry};

pub struct Inner {
    config_dir: PathBuf,
    config: Mutex<AppConfig>,
    session: Mutex<Option<Arc<Session>>>,
    activity: Mutex<Activity>,
    kdf: KdfParams,
    /// Folders the user dropped onto a player (outside-vault playback).
    local: protocol::LocalAccess,
    /// Cancel flags of queued/running import jobs.
    imports: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    /// Imports run one at a time; later drops wait their turn.
    import_gate: Mutex<()>,
    next_job: AtomicU64,
}

type Shared = Arc<Inner>;

fn panic_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyL)
}

/// Wipe the open vault from memory and tell the UI. Safe to call any time.
fn lock_now(app: &AppHandle, inner: &Inner, reason: LockReason) {
    let taken = inner.session.lock().unwrap().take();
    let was_open = taken.is_some();
    if let Some(s) = taken {
        s.close(); // background work stops promptly
        if s.is_dirty() {
            let _ = s.save();
        }
        drop(s); // the last reference wipes the keys
    }
    if was_open {
        let _ = app.emit("vault-locked", reason.as_str());
    }
    if reason == LockReason::PanicKey
        && let Some(w) = app.get_webview_window("main")
    {
        let _ = w.minimize();
    }
}

fn sess(inner: &Inner) -> Result<Arc<Session>, String> {
    inner
        .session
        .lock()
        .unwrap()
        .clone()
        .filter(|s| !s.is_closed())
        .ok_or_else(|| "The vault is locked.".to_string())
}

fn with_session<T>(
    inner: &Inner,
    f: impl FnOnce(&Session) -> Result<T, String>,
) -> Result<T, String> {
    let s = sess(inner)?;
    f(&s)
}

fn install_session(inner: &Inner, s: Session) -> SessionInfo {
    let info = s.info();
    *inner.activity.lock().unwrap() = Activity::new(Instant::now());
    if let Some(old) = inner.session.lock().unwrap().replace(Arc::new(s)) {
        old.close();
    }
    let mut cfg = inner.config.lock().unwrap();
    cfg.add_vault(&info.path);
    cfg.last_vault = Some(info.path.clone());
    let _ = config::save(&inner.config_dir, &cfg);
    info
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// ---- commands -------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStateDto {
    config: AppConfig,
    vaults: Vec<VaultEntry>,
    session: Option<SessionInfo>,
    min_password_chars: usize,
}

#[tauri::command]
async fn get_state(state: State<'_, Shared>) -> Result<AppStateDto, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let config = inner.config.lock().unwrap().clone();
        let vaults = config
            .vaults
            .iter()
            .map(|v| session::describe(&v.path))
            .collect();
        let session = inner.session.lock().unwrap().clone().map(|s| s.info());
        Ok(AppStateDto {
            config,
            vaults,
            session,
            min_password_chars: session::MIN_PASSWORD_CHARS,
        })
    })
    .await
}

#[tauri::command]
fn save_config(state: State<'_, Shared>, config: AppConfig) -> Result<AppConfig, String> {
    let mut cfg = state.config.lock().unwrap();
    let mut next = config.sanitized();
    next.vaults = cfg.vaults.clone(); // vault list is only changed through its own commands
    next.last_vault = cfg.last_vault.clone();
    config::save(&state.config_dir, &next).map_err(|e| format!("Couldn't save settings: {e}"))?;
    *cfg = next.clone();
    Ok(next)
}

#[tauri::command]
fn add_vault(state: State<'_, Shared>, path: String) -> Result<VaultEntry, String> {
    let entry = session::describe(&path);
    if entry.status != "ready" {
        return Err(format!(
            "{path} is not a Media Vault folder. Choose the folder that contains vault.json."
        ));
    }
    let mut cfg = state.config.lock().unwrap();
    cfg.add_vault(&path);
    config::save(&state.config_dir, &cfg).map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
fn forget_vault(state: State<'_, Shared>, path: String) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.forget_vault(&path);
    config::save(&state.config_dir, &cfg).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    session: SessionInfo,
    words: Vec<String>,
}

#[tauri::command]
async fn create_vault(
    state: State<'_, Shared>,
    parent: String,
    name: String,
    password: String,
) -> Result<Created, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let (s, words) = session::create(&parent, &name, &password, inner.kdf)?;
        Ok(Created {
            session: install_session(&inner, s),
            words,
        })
    })
    .await
}

#[tauri::command]
async fn unlock(
    state: State<'_, Shared>,
    path: String,
    password: String,
) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || Ok(install_session(&inner, session::unlock(&path, &password)?))).await
}

#[tauri::command]
async fn unlock_with_recovery(
    state: State<'_, Shared>,
    path: String,
    words: String,
) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || {
        Ok(install_session(
            &inner,
            session::unlock_with_recovery(&path, &words)?,
        ))
    })
    .await
}

/// After unlocking with the recovery key: set a new password (no old one needed).
#[tauri::command]
async fn set_new_password(
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
async fn change_password(
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

#[tauri::command]
async fn reset_recovery(state: State<'_, Shared>, current: String) -> Result<Vec<String>, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let root = with_session(&inner, |s| Ok(s.vault().root().to_path_buf()))?;
        session::verify_password(&root, &current)?;
        with_session(&inner, |s| {
            let phrase = s.vault_mut().reset_recovery().map_err(session::friendly)?;
            Ok(phrase.words().iter().map(|w| w.to_string()).collect())
        })
    })
    .await
}

#[tauri::command]
fn lock_vault(app: AppHandle, state: State<'_, Shared>) {
    lock_now(&app, &state, LockReason::Manual);
}

/// The UI calls this on mouse/keyboard use ("input") and every 10 s while
/// anything is playing ("playing").
#[tauri::command]
fn report_activity(state: State<'_, Shared>, kind: String) {
    let now = Instant::now();
    let mut a = state.activity.lock().unwrap();
    match kind.as_str() {
        "playing" => a.playing(now),
        _ => a.input(now),
    }
}

// ---- library ---------------------------------------------------------------------

/// Run a read-only library query off the UI thread.
async fn read_db<T: Send + 'static>(
    inner: &Shared,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let s = sess(inner)?;
    blocking(move || f(&s.db())).await
}

/// Run a library edit; the change is saved (encrypted) a moment later.
async fn edit_db<T: Send + 'static>(
    inner: &Shared,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let s = sess(inner)?;
    blocking(move || {
        let out = f(&s.db())?;
        s.mark_dirty();
        Ok(out)
    })
    .await
}

#[tauri::command]
async fn library_folders(state: State<'_, Shared>) -> Result<Vec<library::FolderCard>, String> {
    read_db(state.inner(), library::all_folders).await
}

#[tauri::command]
async fn folder_view(
    state: State<'_, Shared>,
    folder: Option<i64>,
) -> Result<library::FolderView, String> {
    read_db(state.inner(), move |c| library::folder_view(c, folder)).await
}

#[tauri::command]
async fn query_items(
    state: State<'_, Shared>,
    filter: library::ItemFilter,
) -> Result<Vec<library::Item>, String> {
    read_db(state.inner(), move |c| library::query_items(c, &filter)).await
}

#[tauri::command]
async fn get_item(state: State<'_, Shared>, id: i64) -> Result<library::Item, String> {
    read_db(state.inner(), move |c| library::get_item(c, id)).await
}

#[tauri::command]
async fn create_folder(
    state: State<'_, Shared>,
    parent: Option<i64>,
    name: String,
) -> Result<i64, String> {
    edit_db(state.inner(), move |c| {
        library::create_folder(c, parent, &name)
    })
    .await
}

#[tauri::command]
async fn rename_folder(state: State<'_, Shared>, id: i64, name: String) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::rename_folder(c, id, &name)).await
}

#[tauri::command]
async fn move_folder(state: State<'_, Shared>, id: i64, parent: Option<i64>) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::move_folder(c, id, parent)).await
}

/// Deletions are saved right away, before the encrypted files are removed,
/// so a crash can never leave the library pointing at missing files.
async fn delete_and_clean(
    inner: &Shared,
    f: impl FnOnce(&rusqlite::Connection) -> Result<library::Orphans, String> + Send + 'static,
) -> Result<usize, String> {
    let s = sess(inner)?;
    blocking(move || {
        let orphans = f(&s.db())?;
        s.mark_dirty();
        s.save()?;
        import::remove_objects(&s, &orphans);
        Ok(orphans.media.len())
    })
    .await
}

#[tauri::command]
async fn delete_folder(state: State<'_, Shared>, id: i64) -> Result<usize, String> {
    delete_and_clean(state.inner(), move |c| library::delete_folder(c, id)).await
}

#[tauri::command]
async fn delete_items(state: State<'_, Shared>, ids: Vec<i64>) -> Result<usize, String> {
    delete_and_clean(state.inner(), move |c| library::delete_items(c, &ids)).await
}

#[tauri::command]
async fn move_items(
    state: State<'_, Shared>,
    ids: Vec<i64>,
    folder: Option<i64>,
) -> Result<usize, String> {
    edit_db(state.inner(), move |c| library::move_items(c, &ids, folder)).await
}

#[tauri::command]
async fn set_favourite(state: State<'_, Shared>, ids: Vec<i64>, on: bool) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::set_favourite(c, &ids, on)).await
}

#[tauri::command]
async fn set_weight(state: State<'_, Shared>, ids: Vec<i64>, weight: f64) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::set_weight(c, &ids, weight)).await
}

#[tauri::command]
async fn set_cover(
    state: State<'_, Shared>,
    folder: i64,
    media: Option<i64>,
) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::set_cover(c, folder, media)).await
}

#[tauri::command]
async fn all_tags(state: State<'_, Shared>) -> Result<Vec<library::TagCount>, String> {
    read_db(state.inner(), library::all_tags).await
}

#[tauri::command]
async fn item_tags(state: State<'_, Shared>, id: i64) -> Result<library::ItemTags, String> {
    read_db(state.inner(), move |c| library::item_tags(c, id)).await
}

#[tauri::command]
async fn tag_items(
    state: State<'_, Shared>,
    ids: Vec<i64>,
    tags: Vec<String>,
) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::tag_items(c, &ids, &tags)).await
}

#[tauri::command]
async fn untag_items(state: State<'_, Shared>, ids: Vec<i64>, tag: String) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::untag_items(c, &ids, &tag)).await
}

#[tauri::command]
async fn tag_folder(
    state: State<'_, Shared>,
    folder: i64,
    tags: Vec<String>,
) -> Result<(), String> {
    edit_db(state.inner(), move |c| {
        library::tag_folder(c, folder, &tags)
    })
    .await
}

#[tauri::command]
async fn untag_folder(state: State<'_, Shared>, folder: i64, tag: String) -> Result<(), String> {
    edit_db(state.inner(), move |c| {
        library::untag_folder(c, folder, &tag)
    })
    .await
}

#[tauri::command]
async fn list_named(state: State<'_, Shared>, kind: String) -> Result<Vec<library::Named>, String> {
    read_db(state.inner(), move |c| library::list_named(c, &kind)).await
}

#[tauri::command]
async fn save_named(
    state: State<'_, Shared>,
    kind: String,
    item: library::Named,
) -> Result<i64, String> {
    edit_db(state.inner(), move |c| library::save_named(c, &kind, &item)).await
}

#[tauri::command]
async fn delete_named(state: State<'_, Shared>, kind: String, id: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::delete_named(c, &kind, id)).await
}

// ---- thumbnails (made by the window from decrypted media, in memory) ----------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbTask {
    id: i64,
    kind: String,
}

#[tauri::command]
async fn thumbs_needed(state: State<'_, Shared>, limit: i64) -> Result<Vec<ThumbTask>, String> {
    read_db(state.inner(), move |c| {
        let mut st = c
            .prepare("SELECT id, kind FROM media WHERE thumb_object_id IS NULL ORDER BY id LIMIT ?")
            .map_err(|e| e.to_string())?;
        let v = st
            .query_map([limit], |r| {
                Ok(ThumbTask {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        Ok(v)
    })
    .await
}

#[tauri::command]
async fn save_thumb(
    state: State<'_, Shared>,
    id: i64,
    data: Vec<u8>,
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<i64>,
) -> Result<(), String> {
    let s = sess(state.inner())?;
    blocking(move || {
        let (tid, _) = s.vault().add_object(vault_core::ObjectKind::Thumbnail, &data[..]).map_err(|e| e.to_string())?;
        let old: Option<String> = {
            let db = s.db();
            let old = db.query_row("SELECT thumb_object_id FROM media WHERE id = ?", [id], |r| r.get(0)).ok().flatten();
            db.execute(
                "UPDATE media SET thumb_object_id = ?1, width = COALESCE(?2, width), height = COALESCE(?3, height), \
                 duration_ms = COALESCE(?4, duration_ms) WHERE id = ?5",
                rusqlite::params![tid.to_hex(), width, height, duration_ms, id],
            )
            .map_err(|e| e.to_string())?;
            old
        };
        if let Some(o) = old.filter(|o| !o.is_empty())
            && let Ok(oid) = vault_core::ObjectId::from_hex(&o)
        {
            let _ = s.vault().delete_object(vault_core::ObjectKind::Thumbnail, &oid);
        }
        s.mark_dirty();
        Ok(())
    })
    .await
}

/// The window couldn't decode this file (e.g. an unsupported video codec).
#[tauri::command]
async fn thumb_failed(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| {
        c.execute(
            "UPDATE media SET thumb_object_id = '' WHERE id = ? AND thumb_object_id IS NULL",
            [id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

// ---- import ------------------------------------------------------------------------------

#[tauri::command]
async fn inspect_drop(paths: Vec<String>) -> Result<import::DropSummary, String> {
    blocking(move || Ok(import::inspect(&paths))).await
}

#[tauri::command]
async fn check_archive_password(path: String, password: String) -> Result<(), String> {
    blocking(move || import::check_password(&path, &password)).await
}

#[tauri::command]
fn start_import(
    app: AppHandle,
    state: State<'_, Shared>,
    paths: Vec<String>,
    target: Option<i64>,
    password: Option<String>,
    archive_folder: Option<bool>,
) -> Result<u64, String> {
    let s = sess(&state)?;
    let inner = state.inner().clone();
    let id = inner.next_job.fetch_add(1, Ordering::SeqCst) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    inner.imports.lock().unwrap().insert(id, cancel.clone());
    std::thread::spawn(move || {
        let _turn = inner.import_gate.lock().unwrap_or_else(|e| e.into_inner());
        let job = import::Job {
            id,
            paths,
            target,
            password,
            archive_folder: archive_folder.unwrap_or(true),
        };
        let report = import::run(&s, &job, &cancel, &mut |p| {
            let _ = app.emit("import-progress", p);
        });
        inner.imports.lock().unwrap().remove(&id);
        let _ = app.emit("import-done", &report);
    });
    Ok(id)
}

#[tauri::command]
fn cancel_import(state: State<'_, Shared>, job: u64) {
    if let Some(c) = state.imports.lock().unwrap().get(&job) {
        c.store(true, Ordering::SeqCst);
    }
}

// ---- playing files outside the vault ------------------------------------------------------

#[tauri::command]
async fn scan_local(
    state: State<'_, Shared>,
    paths: Vec<String>,
) -> Result<protocol::LocalSet, String> {
    let inner = state.inner().clone();
    blocking(move || protocol::scan_local(&inner.local, &paths)).await
}

// ---- background watcher ---------------------------------------------------------

#[cfg(windows)]
fn windows_session_locked() -> bool {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_SWITCHDESKTOP, OpenInputDesktop,
    };
    // When the workstation is locked, the input desktop can't be opened.
    unsafe {
        let h = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if h.is_null() {
            true
        } else {
            CloseDesktop(h);
            false
        }
    }
}

#[cfg(not(windows))]
fn windows_session_locked() -> bool {
    false
}

fn start_watcher(app: AppHandle, inner: Shared) {
    std::thread::spawn(move || {
        let mut sleep = SleepDetector::new(SystemTime::now());
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let slept = sleep.tick(SystemTime::now());
            let Some(open) = inner.session.lock().unwrap().clone() else {
                continue;
            };
            // Save library edits shortly after they happen.
            let _ = open.save_if_settled(Duration::from_secs(1));
            drop(open);
            let lock = inner.config.lock().unwrap().lock.clone();
            let reason = if lock.on_system_lock && slept {
                Some(LockReason::Sleep)
            } else if lock.on_system_lock && windows_session_locked() {
                Some(LockReason::SystemLocked)
            } else {
                inner.activity.lock().unwrap().check(Instant::now(), &lock)
            };
            if let Some(r) = reason {
                lock_now(&app, &inner, r);
            }
        }
    });
}

// ---- entry point -----------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_dir = config::config_dir();
    let cfg = config::load(&config_dir);
    let inner: Shared = Arc::new(Inner {
        config_dir,
        config: Mutex::new(cfg),
        session: Mutex::new(None),
        activity: Mutex::new(Activity::new(Instant::now())),
        kdf: KdfParams::STANDARD,
        local: protocol::LocalAccess::default(),
        imports: Mutex::new(HashMap::new()),
        import_gate: Mutex::new(()),
        next_job: AtomicU64::new(0),
    });

    let panic = panic_shortcut();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &panic && event.state() == ShortcutState::Pressed {
                        let inner = app.state::<Shared>().inner().clone();
                        lock_now(app, &inner, LockReason::PanicKey);
                    }
                })
                .build(),
        )
        .manage(inner.clone())
        .register_asynchronous_uri_scheme_protocol("vault", |ctx, req, responder| {
            let inner = ctx.app_handle().state::<Shared>().inner().clone();
            std::thread::spawn(move || {
                let s = inner.session.lock().unwrap().clone();
                responder.respond(protocol::serve_vault(s.as_deref(), &req));
            });
        })
        .register_asynchronous_uri_scheme_protocol("local", |ctx, req, responder| {
            let inner = ctx.app_handle().state::<Shared>().inner().clone();
            std::thread::spawn(move || {
                responder.respond(protocol::serve_local(&inner.local, &req))
            });
        })
        .setup(move |app| {
            // The panic key is a convenience; if another program owns the
            // shortcut the app still works.
            let _ = app.global_shortcut().register(panic_shortcut());
            start_watcher(app.handle().clone(), inner.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(_) = event {
                let app = window.app_handle();
                let inner = app.state::<Shared>().inner().clone();
                let on_min = inner.config.lock().unwrap().lock.on_minimize;
                if on_min && window.is_minimized().unwrap_or(false) {
                    lock_now(app, &inner, LockReason::Minimized);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_config,
            add_vault,
            forget_vault,
            create_vault,
            unlock,
            unlock_with_recovery,
            set_new_password,
            change_password,
            reset_recovery,
            lock_vault,
            report_activity,
            library_folders,
            folder_view,
            query_items,
            get_item,
            create_folder,
            rename_folder,
            move_folder,
            delete_folder,
            delete_items,
            move_items,
            set_favourite,
            set_weight,
            set_cover,
            all_tags,
            item_tags,
            tag_items,
            untag_items,
            tag_folder,
            untag_folder,
            list_named,
            save_named,
            delete_named,
            thumbs_needed,
            save_thumb,
            thumb_failed,
            inspect_drop,
            check_archive_password,
            start_import,
            cancel_import,
            scan_local,
        ])
        .run(tauri::generate_context!())
        .expect("Media Vault failed to start");
}
