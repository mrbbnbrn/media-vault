//! Media Vault desktop app: the bridge between the window (React UI) and the
//! vault core. All crypto happens here in Rust; the UI never sees keys.

mod access;
mod activity;
mod clip;
mod config;
mod engine;
mod exporter;
mod extras;
mod faces;
mod import;
mod integrity;
mod library;
mod meta;
mod protocol;
mod selftest;
mod session;
mod storage;

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
    selftest: Mutex<Option<selftest::SelfTestInfo>>,
    /// Cancel flags of running background tasks ("check", "export").
    tasks: Mutex<HashMap<&'static str, Arc<AtomicBool>>>,
    engine: engine::EngineInfo,
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
    let mut info = s.info();
    info.login = Some(access::on_unlock(&s));
    *inner.activity.lock().unwrap() = Activity::new(Instant::now());
    let s = Arc::new(s);
    if let Some(old) = inner.session.lock().unwrap().replace(s.clone()) {
        old.close();
    }
    start_background(s);
    if !selftest::enabled() {
        // The throwaway self-test vault is never remembered.
        let mut cfg = inner.config.lock().unwrap();
        cfg.add_vault(&info.path);
        cfg.last_vault = Some(info.path.clone());
        let _ = config::save(&inner.config_dir, &cfg);
    }
    info
}

/// Work that runs while a vault is open: empty old trash, find dates taken.
fn start_background(s: Arc<Session>) {
    let s2 = s.clone();
    std::thread::spawn(move || {
        let orphans = library::purge_trash(&s2.db(), library::TRASH_DAYS);
        if let Ok(o) = orphans
            && !o.media.is_empty()
        {
            s2.mark_dirty();
            if s2.save().is_ok() {
                import::remove_objects(&s2, &o);
            }
        }
    });
    meta::backfill(s);
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

/// A wrong password (or wrong recovery words) for a real vault is counted.
fn note_failure(path: &str) {
    access::record_failure(std::path::Path::new(path));
}

#[tauri::command]
async fn unlock(
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

#[tauri::command]
async fn unlock_with_recovery(
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

/// "Delete" puts things in the trash; they can be restored for 30 days.
#[tauri::command]
async fn delete_folder(state: State<'_, Shared>, id: i64) -> Result<i64, String> {
    edit_db(state.inner(), move |c| library::trash_folder(c, id)).await
}

#[tauri::command]
async fn delete_items(state: State<'_, Shared>, ids: Vec<i64>) -> Result<i64, String> {
    edit_db(state.inner(), move |c| library::trash_items(c, &ids)).await
}

#[tauri::command]
async fn restore_items(state: State<'_, Shared>, ids: Vec<i64>) -> Result<usize, String> {
    edit_db(state.inner(), move |c| library::restore_items(c, &ids)).await
}

#[tauri::command]
async fn restore_folder(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::restore_folder(c, id)).await
}

#[tauri::command]
async fn trash_view(state: State<'_, Shared>) -> Result<library::TrashView, String> {
    read_db(state.inner(), library::trash_view).await
}

#[tauri::command]
async fn delete_forever(state: State<'_, Shared>, ids: Vec<i64>) -> Result<usize, String> {
    delete_and_clean(state.inner(), move |c| library::delete_forever(c, &ids)).await
}

#[tauri::command]
async fn delete_folder_forever(state: State<'_, Shared>, id: i64) -> Result<usize, String> {
    delete_and_clean(state.inner(), move |c| {
        library::delete_folder_forever(c, id)
    })
    .await
}

#[tauri::command]
async fn empty_trash(state: State<'_, Shared>) -> Result<usize, String> {
    delete_and_clean(state.inner(), library::empty_trash).await
}

#[tauri::command]
async fn set_pinned(state: State<'_, Shared>, id: i64, on: bool) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::set_pinned(c, id, on)).await
}

#[tauri::command]
async fn set_folder_look(
    state: State<'_, Shared>,
    id: i64,
    color: Option<String>,
    emoji: Option<String>,
) -> Result<(), String> {
    edit_db(state.inner(), move |c| {
        library::set_folder_look(c, id, color.as_deref(), emoji.as_deref())
    })
    .await
}

#[tauri::command]
async fn library_stats(state: State<'_, Shared>) -> Result<extras::Stats, String> {
    read_db(state.inner(), extras::stats).await
}

#[tauri::command]
async fn mark_viewed(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| extras::mark_viewed(c, id)).await
}

#[tauri::command]
async fn random_journey(state: State<'_, Shared>) -> Result<Option<extras::Pick>, String> {
    read_db(state.inner(), extras::random_journey).await
}

#[tauri::command]
async fn todays_pick(state: State<'_, Shared>, day: i64) -> Result<Option<library::Item>, String> {
    read_db(state.inner(), move |c| extras::todays_pick(c, day)).await
}

#[tauri::command]
async fn folder_samples(state: State<'_, Shared>, folder: i64, n: i64) -> Result<Vec<i64>, String> {
    read_db(state.inner(), move |c| extras::folder_samples(c, folder, n)).await
}

#[tauri::command]
async fn bookmarks(state: State<'_, Shared>, media: i64) -> Result<Vec<extras::Bookmark>, String> {
    read_db(state.inner(), move |c| extras::bookmarks(c, media)).await
}

#[tauri::command]
async fn add_bookmark(
    state: State<'_, Shared>,
    media: i64,
    position_ms: i64,
    note: String,
) -> Result<i64, String> {
    edit_db(state.inner(), move |c| {
        extras::add_bookmark(c, media, position_ms, &note)
    })
    .await
}

#[tauri::command]
async fn update_bookmark(
    state: State<'_, Shared>,
    id: i64,
    position_ms: i64,
    note: String,
) -> Result<(), String> {
    edit_db(state.inner(), move |c| {
        extras::update_bookmark(c, id, position_ms, &note)
    })
    .await
}

#[tauri::command]
async fn delete_bookmark(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| extras::delete_bookmark(c, id)).await
}

/// Save something made in the app (a video frame, a GIF) into a folder.
#[tauri::command]
async fn add_file_bytes(
    state: State<'_, Shared>,
    folder: Option<i64>,
    name: String,
    data: Vec<u8>,
) -> Result<i64, String> {
    let s = sess(state.inner())?;
    blocking(move || import::add_bytes(&s, folder, &name, &data)).await
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
) -> Result<Vec<(String, Vec<i64>)>, String> {
    edit_db(state.inner(), move |c| library::tag_items(c, &ids, &tags)).await
}

#[tauri::command]
async fn untag_items(
    state: State<'_, Shared>,
    ids: Vec<i64>,
    tag: String,
) -> Result<Vec<i64>, String> {
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
            // A replaced thumbnail may show something else: analyse it again.
            if old.as_deref().is_some_and(|o: &str| !o.is_empty()) {
                let _ = clip::reset(&db, id);
            }
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

// ---- preview clips (a strip of small frames per video, made by the window) ----------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewTask {
    id: i64,
    duration_ms: Option<i64>,
}

/// Videos without a preview clip yet; `prefer` (those on screen) first.
#[tauri::command]
async fn previews_needed(state: State<'_, Shared>, limit: i64, prefer: Vec<i64>) -> Result<Vec<PreviewTask>, String> {
    read_db(state.inner(), move |c| {
        let e = |x: rusqlite::Error| x.to_string();
        let mut out: Vec<PreviewTask> = Vec::new();
        for id in prefer.iter().take(64) {
            if let Ok(t) = c.query_row(
                "SELECT id, duration_ms FROM media WHERE id = ? AND kind = 'video' AND preview_object_id IS NULL \
                 AND deleted_at IS NULL AND IFNULL(thumb_object_id, 'x') <> ''",
                [id],
                |r| Ok(PreviewTask { id: r.get(0)?, duration_ms: r.get(1)? }),
            ) {
                out.push(t);
            }
            if out.len() as i64 >= limit {
                return Ok(out);
            }
        }
        let mut st = c
            .prepare(
                "SELECT id, duration_ms FROM media WHERE kind = 'video' AND preview_object_id IS NULL AND deleted_at IS NULL \
                 AND thumb_object_id IS NOT NULL AND thumb_object_id <> '' ORDER BY id DESC LIMIT ?",
            )
            .map_err(e)?;
        for t in st
            .query_map([limit], |r| Ok(PreviewTask { id: r.get(0)?, duration_ms: r.get(1)? }))
            .map_err(e)?
            .flatten()
        {
            if out.len() as i64 >= limit {
                break;
            }
            if !out.iter().any(|x| x.id == t.id) {
                out.push(t);
            }
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
async fn save_preview(state: State<'_, Shared>, id: i64, data: Vec<u8>) -> Result<(), String> {
    let s = sess(state.inner())?;
    blocking(move || {
        let (pid, _) = s.vault().add_object(vault_core::ObjectKind::Thumbnail, &data[..]).map_err(|e| e.to_string())?;
        let old: Option<String> = {
            let db = s.db();
            let old = db.query_row("SELECT preview_object_id FROM media WHERE id = ?", [id], |r| r.get(0)).ok().flatten();
            db.execute("UPDATE media SET preview_object_id = ? WHERE id = ?", rusqlite::params![pid.to_hex(), id])
                .map_err(|e| e.to_string())?;
            // Smart search looks at the clip's moments too: analyse again.
            let _ = clip::reset(&db, id);
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

#[tauri::command]
async fn preview_failed(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| {
        c.execute("UPDATE media SET preview_object_id = '' WHERE id = ? AND preview_object_id IS NULL", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn cache_info(state: State<'_, Shared>) -> Result<storage::CacheInfo, String> {
    let s = sess(state.inner())?;
    blocking(move || storage::cache_info(&s)).await
}

// ---- small remembered UI state (per vault, encrypted) -------------------------------------

/// Remembered UI state for this vault: per-folder view settings, where you
/// left off. Kept in the library's settings table (encrypted like the rest).
#[tauri::command]
async fn ui_get(state: State<'_, Shared>, key: String) -> Result<Option<String>, String> {
    read_db(state.inner(), move |c| {
        Ok(c.query_row("SELECT value FROM settings WHERE key = ?", [format!("ui:{key}")], |r| r.get(0)).ok())
    })
    .await
}

#[tauri::command]
async fn ui_set(state: State<'_, Shared>, key: String, value: String) -> Result<(), String> {
    if key.len() > 64 || value.len() > 512 * 1024 {
        return Err("Too large.".into());
    }
    edit_db(state.inner(), move |c| {
        c.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [format!("ui:{key}"), value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn extract_folder(state: State<'_, Shared>, id: i64) -> Result<library::Extracted, String> {
    edit_db(state.inner(), move |c| library::extract_folder(c, id)).await
}

#[tauri::command]
async fn unextract_folder(state: State<'_, Shared>, id: i64, extracted: library::Extracted) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::unextract_folder(c, id, &extracted)).await
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

// ---- storage ------------------------------------------------------------------------

#[tauri::command]
async fn storage_info(state: State<'_, Shared>) -> Result<storage::StorageInfo, String> {
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
fn storage_task(app: AppHandle, state: State<'_, Shared>, task: String) -> Result<(), String> {
    let s = sess(&state)?;
    let inner = state.inner().clone();
    let task: &'static str = match task.as_str() {
        "convert" => "convert",
        "reclaim" => "reclaim",
        "deleteThumbs" => "deleteThumbs",
        "deletePreviews" => "deletePreviews",
        _ => return Err("Unknown task.".into()),
    };
    std::thread::spawn(move || {
        let _turn = inner.import_gate.lock().unwrap_or_else(|e| e.into_inner());
        let result = if task == "deleteThumbs" || task == "deletePreviews" {
            storage::delete_cache(&s, task == "deleteThumbs")
        } else if task == "convert" {
            storage::convert(&s, &mut |done, total| {
                let _ = app.emit("storage-progress", StorageProgress { task, done, total });
            })
            .map(|n| format!("{n} items moved into pack files."))
        } else {
            storage::reclaim(&s).map(|r| {
                format!(
                    "Freed {:.1} MB ({} items moved, {} pack files removed).",
                    r.reclaimed_bytes as f64 / 1e6,
                    r.moved,
                    r.packs_removed
                )
            })
        };
        let (ok, message) = match result {
            Ok(m) => (true, m),
            Err(e) => (false, e),
        };
        let _ = app.emit("storage-done", StorageDone { task, ok, message });
    });
    Ok(())
}

// ---- check for damage, export ------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskProgress {
    task: &'static str,
    done: usize,
    total: usize,
}

fn begin_task(inner: &Inner, name: &'static str) -> Result<Arc<AtomicBool>, String> {
    let mut t = inner.tasks.lock().unwrap();
    if t.contains_key(name) {
        return Err("That is already running.".into());
    }
    let c = Arc::new(AtomicBool::new(false));
    t.insert(name, c.clone());
    Ok(c)
}

/// Read every item in full to find damage. Reports "check-progress" and
/// finally "check-done" with the report.
#[tauri::command]
fn check_damage(app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    let s = sess(&state)?;
    let inner = state.inner().clone();
    let cancel = begin_task(&inner, "check")?;
    std::thread::spawn(move || {
        let _turn = inner.import_gate.lock().unwrap_or_else(|e| e.into_inner());
        let mut last = Instant::now();
        let r = integrity::run(&s, &cancel, &mut |done, total| {
            if last.elapsed() > Duration::from_millis(150) || done == total {
                last = Instant::now();
                let _ = app.emit("check-progress", TaskProgress { task: "check", done, total });
            }
        });
        inner.tasks.lock().unwrap().remove("check");
        let _ = app.emit("check-done", r.map_err(|e| e.to_string()));
    });
    Ok(())
}

#[tauri::command]
fn cancel_task(state: State<'_, Shared>, task: String) {
    if let Some(c) = state.tasks.lock().unwrap().get(task.as_str()) {
        c.store(true, Ordering::SeqCst);
    }
}

/// Write items out as ordinary (unencrypted) files. "export-progress", then "export-done".
#[tauri::command]
fn export_start(app: AppHandle, state: State<'_, Shared>, request: exporter::ExportRequest) -> Result<(), String> {
    let s = sess(&state)?;
    let inner = state.inner().clone();
    let cancel = begin_task(&inner, "export")?;
    std::thread::spawn(move || {
        let mut last = Instant::now();
        let done = exporter::run(&s, &request, &cancel, &mut |p| {
            if last.elapsed() > Duration::from_millis(150) || p.done == p.total {
                last = Instant::now();
                let _ = app.emit("export-progress", p);
            }
        });
        inner.tasks.lock().unwrap().remove("export");
        let _ = app.emit("export-done", done);
    });
    Ok(())
}

// ---- web engine --------------------------------------------------------------------

#[tauri::command]
fn engine_info(state: State<'_, Shared>) -> engine::EngineInfo {
    state.engine.clone()
}

#[tauri::command]
fn engine_started(state: State<'_, Shared>) {
    engine::started(&state.config_dir, &state.engine);
}

#[tauri::command]
fn engine_retry(state: State<'_, Shared>) {
    engine::retry(&state.config_dir);
}

// ---- face recognition -----------------------------------------------------------------

#[tauri::command]
async fn set_person_folder(state: State<'_, Shared>, folder: i64, on: bool) -> Result<(), String> {
    edit_db(state.inner(), move |c| faces::set_person(c, folder, on)).await
}

#[tauri::command]
async fn faces_queue(state: State<'_, Shared>, request: faces::ScanRequest) -> Result<usize, String> {
    edit_db(state.inner(), move |c| faces::queue(c, &request)).await
}

#[tauri::command]
async fn faces_needed(state: State<'_, Shared>, limit: i64) -> Result<Vec<faces::ScanTask>, String> {
    read_db(state.inner(), move |c| faces::needed(c, limit)).await
}

#[tauri::command]
async fn faces_save(state: State<'_, Shared>, media: i64, faces: Vec<faces::FaceIn>) -> Result<usize, String> {
    edit_db(state.inner(), move |c| faces::save(c, media, &faces)).await
}

#[tauri::command]
async fn faces_failed(state: State<'_, Shared>, media: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| faces::failed(c, media)).await
}

#[tauri::command]
async fn faces_status(state: State<'_, Shared>) -> Result<faces::ScanStatus, String> {
    read_db(state.inner(), faces::status).await
}

#[tauri::command]
async fn faces_review(state: State<'_, Shared>) -> Result<faces::Review, String> {
    read_db(state.inner(), faces::review).await
}

#[tauri::command]
async fn faces_accept(state: State<'_, Shared>, face_ids: Vec<i64>, person: i64) -> Result<faces::Accepted, String> {
    edit_db(state.inner(), move |c| faces::accept(c, &face_ids, person)).await
}

#[tauri::command]
async fn faces_reject(state: State<'_, Shared>, face_ids: Vec<i64>, person: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| faces::reject(c, &face_ids, person)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewPerson {
    folder: i64,
    accepted: faces::Accepted,
}

#[tauri::command]
async fn faces_new_person(
    state: State<'_, Shared>,
    name: String,
    parent: Option<i64>,
    face_ids: Vec<i64>,
) -> Result<NewPerson, String> {
    edit_db(state.inner(), move |c| {
        let (folder, accepted) = faces::new_person(c, &name, parent, &face_ids)?;
        Ok(NewPerson { folder, accepted })
    })
    .await
}

#[tauri::command]
async fn faces_of(state: State<'_, Shared>, media: i64) -> Result<Vec<faces::FaceBox>, String> {
    read_db(state.inner(), move |c| faces::faces_of(c, media)).await
}

#[tauri::command]
async fn faces_unsure(state: State<'_, Shared>, person: i64) -> Result<Vec<library::Item>, String> {
    read_db(state.inner(), move |c| faces::unsure_items(c, person)).await
}

// ---- smart search -----------------------------------------------------------------------

#[tauri::command]
async fn clip_needed(state: State<'_, Shared>, limit: i64) -> Result<Vec<clip::ClipTask>, String> {
    read_db(state.inner(), move |c| clip::needed(c, limit)).await
}

#[tauri::command]
async fn clip_save(state: State<'_, Shared>, media: i64, vec: Vec<f32>) -> Result<(), String> {
    edit_db(state.inner(), move |c| clip::save(c, media, &vec)).await
}

#[tauri::command]
async fn clip_failed(state: State<'_, Shared>, media: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| clip::failed(c, media)).await
}

#[tauri::command]
async fn clip_status(state: State<'_, Shared>) -> Result<clip::ClipStatus, String> {
    read_db(state.inner(), clip::status).await
}

#[tauri::command]
async fn smart_search(
    state: State<'_, Shared>,
    vec: Vec<f32>,
    folder: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<clip::Hit>, String> {
    read_db(state.inner(), move |c| clip::search(c, &vec, folder, limit.unwrap_or(300))).await
}

// ---- self-test ---------------------------------------------------------------------

#[tauri::command]
fn selftest_info(state: State<'_, Shared>) -> Option<selftest::SelfTestInfo> {
    state.selftest.lock().unwrap().clone()
}

#[tauri::command]
fn selftest_done(state: State<'_, Shared>, ok: bool, report: String) {
    if state.selftest.lock().unwrap().is_some() {
        std::process::exit(selftest::finish(ok, &report));
    }
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
        let mut told_failure = false;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let slept = sleep.tick(SystemTime::now());
            let Some(open) = inner.session.lock().unwrap().clone() else {
                continue;
            };
            // Save library edits shortly after they happen: once they settle
            // for a second, and at the latest 5 s after the first one (the
            // background analysis keeps changing things all the time).
            match open.save_if_settled(Duration::from_secs(1), Duration::from_secs(5)) {
                Ok(()) => told_failure = false,
                Err(e) => {
                    if !told_failure {
                        let _ = app.emit("save-failed", e);
                        told_failure = true;
                    }
                }
            }
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
    let engine = engine::prepare(&config_dir, cfg.builtin_engine);
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
        selftest: Mutex::new(None),
        tasks: Mutex::new(HashMap::new()),
        engine,
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
        .register_asynchronous_uri_scheme_protocol("models", |_ctx, req, responder| {
            std::thread::spawn(move || responder.respond(protocol::serve_models(&req)));
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
            if selftest::enabled() {
                match selftest::prepare(&inner.local) {
                    Ok((s, info)) => {
                        install_session(&inner, s);
                        *inner.selftest.lock().unwrap() = Some(info);
                    }
                    Err(e) => {
                        std::process::exit(selftest::finish(false, &format!("setup failed: {e}")))
                    }
                }
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_secs(480));
                    std::process::exit(selftest::finish(
                        false,
                        "timed out: the window never reported back",
                    ));
                });
            }
            start_watcher(app.handle().clone(), inner.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window: save the library first.
            if let WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed = event {
                let inner = window.app_handle().state::<Shared>().inner().clone();
                let open = inner.session.lock().unwrap().clone();
                if let Some(s) = open
                    && s.is_dirty()
                {
                    let _ = s.save();
                }
            }
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
            restore_items,
            restore_folder,
            trash_view,
            delete_forever,
            delete_folder_forever,
            empty_trash,
            set_pinned,
            set_folder_look,
            library_stats,
            mark_viewed,
            random_journey,
            todays_pick,
            folder_samples,
            bookmarks,
            add_bookmark,
            update_bookmark,
            delete_bookmark,
            add_file_bytes,
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
            previews_needed,
            save_preview,
            preview_failed,
            cache_info,
            ui_get,
            extract_folder,
            unextract_folder,
            ui_set,
            inspect_drop,
            check_archive_password,
            start_import,
            cancel_import,
            scan_local,
            selftest_info,
            storage_info,
            storage_task,
            selftest_done,
            check_damage,
            cancel_task,
            export_start,
            engine_info,
            engine_started,
            engine_retry,
            set_person_folder,
            faces_queue,
            faces_needed,
            faces_save,
            faces_failed,
            faces_status,
            faces_review,
            faces_accept,
            faces_reject,
            faces_new_person,
            faces_of,
            faces_unsure,
            clip_needed,
            clip_save,
            clip_failed,
            clip_status,
            smart_search,
        ])
        .build(tauri::generate_context!())
        .expect("Media Vault failed to start")
        .run(|app, event| {
            // However the app ends, unsaved library changes are written first.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                let inner = app.state::<Shared>().inner().clone();
                let open = inner.session.lock().unwrap().clone();
                if let Some(s) = open
                    && s.is_dirty()
                {
                    let _ = s.save();
                }
            }
        });
}
