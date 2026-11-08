//! Media Vault desktop app: the bridge between the window (React UI) and the
//! vault core. All crypto happens here in Rust; the UI never sees keys.

mod access;
mod previewsoff; // "Don't make preview clips here" (folders)
mod encryption; // turning a vault's encryption off or on
mod plainfiles; // vaults without encryption: ordinary files in folders
mod activity;
mod banner; // folder banners
// The native analysis pass: decode each picture once for its thumbnail,
// fingerprint and faces (picture.rs).
mod analyse;
mod picture;
// Beat detection from the computer's own sound (analysis is plain Rust; the
// capture side is Windows-only).
#[cfg_attr(not(windows), allow(dead_code))]
mod beats;
mod beatlisten;
#[cfg_attr(not(windows), allow(dead_code))]
mod beatloop;
#[cfg(test)]
mod beats_music_tests;
#[cfg(test)]
mod bench_tests;
mod binbody;
#[cfg(windows)]
mod loopback_win;
// Hiding the windows from screenshots and screen sharing.
mod nocapture;
mod config;
// "3D photos": depth maps for gentle parallax in slideshows (the optional depth pack).
mod depth;
// "Subject outlines": a mask of the picture's subject (the optional BiRefNet packs).
mod subject;
// "Background fill": paints in behind a moving subject (the optional MI-GAN / LaMa packs).
mod inpaint;
// One loaded model per kind (depth, subject, fill), each in its own slot, freed when idle.
mod modelslot;
mod onnxmodel; // what the depth, subject and fill models share: loading on the best device, the graphics card's turn
// Saved depth maps and outlines of still pictures, encrypted in the vault (schema v18).
mod derived;
// Duel mode: pick the better of two; Elo ratings set the slideshow weights.
mod duel;
mod engine;
mod exporter;
mod extras;
mod faces;
mod facecrops; // a person's faces cut out: face wall, best faces, time-lapse
mod focus;
// Native face recognition (optional pack: tools/faces): InsightFace buffalo_l.
mod faceid;
mod faceid_math;
mod facegraph;
// Poor faces: too small, blurry or turned to be trusted (judged from Settings → Faces).
mod poorfaces;
// The vault's size by month (Statistics chart, Settings sparkline).
mod growth;
mod import;
mod integrity;
mod library;
mod meta;
mod protocol;
mod rotate;
mod riverfaces; // the faces river
mod selftest;
mod session;
mod share7z;
mod organize;
mod similar;
mod sketch;
mod storage;
mod restore; // putting a library backup back
mod throttle;
mod diskspace; // free space on the vault's drive (one clear message when it is full)
mod util; // small helpers shared by many modules
mod userbusy; // background work waits while you use the window
mod diaglog; // diagnostics.log: steps and sizes only, written straight to disk
mod crashguard; // the window's processes ending (a black window): load the page again
mod gpuroom; // the 3D models share the graphics card: one at a time, make room, back to the card
// Thumbnail pages: a folder's thumbnails in a few encrypted objects (derived, a cache).
mod thumbpages;
// Removing camera info, location and dates from files that leave the vault.
mod stripmeta;
mod videotool;
// The offline AI upscaler in the viewer (optional pack: tools/upscaler).
mod upscale;
mod upscale_img;
mod winshell;
mod transfer; // Wi-Fi transfer with the phone (MVTP/1)
mod windowstate;
// "Why is this here?" for search results, and the slot machine's data.
mod explain;
mod slots;
// The window's commands, by area (lib.rs keeps the shared parts and the list).
mod cmd_faces;
mod cmd_library;
mod cmd_media;
mod cmd_misc;
mod cmd_similar;
mod cmd_vault;
#[cfg(test)]
mod folder_order_tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use vault_core::KdfParams;

use activity::{Activity, LockReason, SleepDetector};
use config::AppConfig;
use session::{Session, SessionInfo};

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
    // The phone hears about it first (and nothing more is received).
    transfer::stop();
    let taken = inner.session.lock().unwrap_or_else(|e| e.into_inner()).take();
    let was_open = taken.is_some();
    upscale::cancel();
    upscale::forget_all();
    if let Some(s) = &taken {
        // The face look-alike graph goes into the library (saved just below).
        faces::keep_graphs(&**s);
    }
    faces::forget_cache();
    facecrops::forget();
    focus::set(None);
    faceid::unload();
    analyse::stop();
    userbusy::reset();
    gpuroom::reset();
    protocol::forget_cache();
    library::forget_cache();
    depth::unload();
    subject::unload();
    inpaint::unload();
    if let Some(s) = taken {
        s.close(); // background work stops promptly
        // Again, now that it is closed: whatever a request still running put back.
        protocol::forget_cache();
        // Twice when needed: files replaced since the last save are removed
        // after the first, which the second records.
        for _ in 0..2 {
            if s.is_dirty() {
                let _ = s.save();
            }
        }
        // Background work may still hold it for a moment: the vault can be opened again meanwhile.
        s.release();
        drop(s); // the last reference wipes the keys
    }
    if was_open {
        let _ = app.emit("vault-locked", reason.as_str());
        winshell::on_lock(app);
    }
    beatlisten::stop(app);
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

fn install_session(inner: &Shared, s: Session) -> SessionInfo {
    let mut info = s.info();
    info.login = Some(access::on_unlock(&s));
    *inner.activity.lock().unwrap_or_else(|e| e.into_inner()) = Activity::new(Instant::now());
    let s = Arc::new(s);
    if let Some(old) = inner.session.lock().unwrap_or_else(|e| e.into_inner()).replace(s.clone()) {
        old.close();
        if old.is_dirty() {
            let _ = old.save();
        }
        old.release();
    }
    // Nothing decrypted from another vault stays in memory.
    protocol::forget_cache();
    library::forget_cache();
    start_background(inner.clone(), s.clone());
    transfer::start(inner, s);
    if !selftest::enabled() {
        // The throwaway self-test vault is never remembered.
        let mut cfg = inner.config.lock().unwrap_or_else(|e| e.into_inner());
        cfg.add_vault(&info.path);
        cfg.last_vault = Some(info.path.clone());
        let _ = config::save(&inner.config_dir, &cfg);
    }
    info
}

/// Work that runs while a vault is open: empty old trash, find dates taken.
fn start_background(inner: Shared, s: Arc<Session>) {
    let s2 = s.clone();
    std::thread::spawn(move || {
        let orphans = library::purge_trash(&s2.db(), library::TRASH_DAYS);
        if let Ok(o) = orphans
            && !o.media.is_empty()
        {
            s2.mark_dirty();
            if s2.save().is_ok() {
                import::remove_objects(&s2, &o);
                cmd_library::reclaim_soon(inner, s2.clone());
            }
        }
        // Files kept for undoing rotations last time (the undo list is new now).
        let _ = rotate::clean_retired(&s2);
        // The kept folder counts are checked once per unlock (put right if ever wrong).
        if let Ok(false) = vault_core::db::check_folder_stats(&s2.db()) {
            s2.mark_dirty();
        }
    });
    // The grid comes first: the heavy part (the face look-alike graphs) is
    // read just after, in the background, a batch at a time so the library
    // stays free for the window.
    let s3 = s.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        if !s3.is_closed() {
            let _ = faces::warm(&*s3);
        }
    });
    sketch::backfill(s.clone());
    thumbpages::start(s.clone());
    meta::backfill(s);
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// ---- library (the helpers every command module uses) ----------------------------------

/// Run `f` on the library, noting in diagnostics.log when the command
/// waited long for it (another part of the app held it) or ran long.
fn timed_db<F: FnOnce(&rusqlite::Connection) -> R, R>(s: &Session, f: F) -> R {
    let t0 = Instant::now();
    let db = s.db();
    let waited = t0.elapsed();
    let t1 = Instant::now();
    let out = f(&db);
    drop(db);
    diaglog::library_time(diaglog::command_name::<F>(), waited, t1.elapsed());
    out
}

/// Run a read-only library query off the UI thread.
async fn read_db<T: Send + 'static>(
    inner: &Shared,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let s = sess(inner)?;
    blocking(move || timed_db(&s, f)).await
}

/// Run a library edit made by you; it is saved (encrypted) right away.
async fn edit_db<T: Send + 'static>(
    inner: &Shared,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let s = sess(inner)?;
    blocking(move || {
        let out = timed_db(&s, f)?;
        s.mark_dirty();
        s.save_soon();
        Ok(out)
    })
    .await
}

/// A library change from background work (analysis, scans, view counts):
/// saved with the next regular save (within a few seconds).
async fn edit_db_bg<T: Send + 'static>(
    inner: &Shared,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let s = sess(inner)?;
    blocking(move || {
        let out = timed_db(&s, f)?;
        s.mark_dirty();
        Ok(out)
    })
    .await
}

/// A change from background work that can always be made again (thumbnail
/// failures, fingerprints, face scans): saved with your
/// next edit, or within a minute (session::BACKGROUND_SAVE_EVERY).
async fn edit_db_derived<T: Send + 'static>(
    inner: &Shared,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let s = sess(inner)?;
    blocking(move || {
        let out = timed_db(&s, f)?;
        s.mark_dirty_bg();
        Ok(out)
    })
    .await
}

// ---- background tasks ----------------------------------------------------------------

/// Start the background task `name` (one of each at a time): its cancel flag.
fn begin_task(inner: &Inner, name: &'static str) -> Result<Arc<AtomicBool>, String> {
    let mut t = inner.tasks.lock().unwrap_or_else(|e| e.into_inner());
    if t.contains_key(name) {
        return Err("That is already running.".into());
    }
    let c = Arc::new(AtomicBool::new(false));
    t.insert(name, c.clone());
    Ok(c)
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
        let mut backoff = session::SaveBackoff::default();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let slept = sleep.tick(SystemTime::now());
            let Some(open) = inner.session.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
                continue;
            };
            // Save your library edits shortly after they happen: once they
            // settle for a second, and at the latest 5 s after the first one.
            // While you are using the window, at the latest after 20 s: saving
            // holds the library for a moment, and thumbnails would wait for it.
            // What background work alone changed (all of which can be made
            // again) is saved at most once a minute, or with your next edit.
            let max_wait = if userbusy::busy() { 20 } else { 5 };
            // After a failed save, the next try waits longer each time (2 s, 5 s, 15 s, then a minute).
            let tried = backoff
                .due(Instant::now())
                .then(|| open.save_if_settled(Duration::from_secs(1), Duration::from_secs(max_wait), session::BACKGROUND_SAVE_EVERY));
            match tried {
                None => {} // waiting for the next try
                Some(Ok(())) => {
                    backoff.ok();
                    // A vault without encryption: files follow their items (moves, renames, the trash).
                    if let Err(e) = plainfiles::arrange_if_changed(&open) {
                        eprintln!("Couldn't put files in their folders: {e}");
                    }
                }
                Some(Err(e)) => {
                    // The vault's folder itself is gone: its drive was removed or disconnected.
                    let gone = !open.vault().root().is_dir();
                    if backoff.failed(Instant::now()) {
                        if gone {
                            let msg = "The vault's drive isn't there any more (was it unplugged or disconnected?). Connect it again and saving carries on by itself.";
                            let _ = app.emit("vault-gone", msg);
                            let _ = app.emit("save-failed", msg);
                        } else {
                            let _ = app.emit("save-failed", e);
                        }
                    }
                }
            }
            // A vault without a password never locks by itself (opening it
            // again asks nothing); closing it by hand and the panic key still work.
            let auto_lock = open.has_password();
            drop(open);
            if !auto_lock {
                continue;
            }
            let lock = inner.config.lock().unwrap_or_else(|e| e.into_inner()).lock.clone();
            let reason = if lock.on_system_lock && slept {
                Some(LockReason::Sleep)
            } else if lock.on_system_lock && windows_session_locked() {
                Some(LockReason::SystemLocked)
            } else {
                inner.activity.lock().unwrap_or_else(|e| e.into_inner()).check(Instant::now(), &lock)
            };
            if let Some(r) = reason {
                lock_now(&app, &inner, r);
            }
        }
    });
}

/// Save the open library now (the window is closing or has died).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn save_open(app: &AppHandle) {
    let inner = app.state::<Shared>().inner().clone();
    let open = inner.session.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(s) = open {
        for _ in 0..2 {
            if s.is_dirty() {
                let _ = s.save();
            }
        }
    }
}

// ---- entry point -----------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_dir = config::config_dir();
    let cfg = config::load(&config_dir);
    diaglog::init(&config_dir);
    gpuroom::load_store(&config_dir);
    poorfaces::set_rule(&cfg.poor_faces);
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
        // Local "job finished" toasts (no network).
        .plugin(tauri_plugin_notification::init())
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
        .manage(beatlisten::BeatListener::default())
        // Every window (the main one and any opened later) is hidden from
        // screenshots and screen sharing when the setting is on.
        .on_page_load(|webview, _| {
            let app = webview.app_handle();
            nocapture::apply(&webview.window(), nocapture::enabled(app));
        })
        .register_asynchronous_uri_scheme_protocol("vault", |ctx, req, responder| {
            let inner = ctx.app_handle().state::<Shared>().inner().clone();
            // A few worker threads answer them all (protocol::run).
            protocol::run(move || {
                let s = inner.session.lock().unwrap_or_else(|e| e.into_inner()).clone();
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
            transfer::set_app(app.handle().clone());
            // The window starts hidden: put it back where it was, then show it.
            windowstate::restore(app.handle(), &inner.config_dir);
            // The panic key is a convenience; if another program owns the
            // shortcut the app still works.
            let _ = app.global_shortcut().register(panic_shortcut());
            if selftest::enabled() {
                match selftest::prepare(&inner.local) {
                    Ok((s, info)) => {
                        install_session(&inner, s);
                        *inner.selftest.lock().unwrap_or_else(|e| e.into_inner()) = Some(info);
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
            for (_, w) in app.webview_windows() {
                crashguard::watch(app.handle(), &w);
            }
            let block = inner.config.lock().unwrap_or_else(|e| e.into_inner()).block_capture;
            nocapture::apply_all(app.handle(), block);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Remember the window's size, place and maximised state.
            let dir = window.app_handle().state::<Shared>().inner().config_dir.clone();
            windowstate::on_event(window, event, &dir);
            // Closing the window: save the library first.
            if let WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed = event {
                diaglog::note(&format!("window '{}': {}", window.label(), if matches!(event, WindowEvent::Destroyed) { "destroyed" } else { "closing" }));
                let inner = window.app_handle().state::<Shared>().inner().clone();
                let open = inner.session.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let Some(s) = open
                    && s.is_dirty()
                {
                    let _ = s.save();
                }
            }
            if let WindowEvent::Resized(_) = event {
                let app = window.app_handle();
                let inner = app.state::<Shared>().inner().clone();
                let on_min = inner.config.lock().unwrap_or_else(|e| e.into_inner()).lock.on_minimize;
                let has_password = inner.session.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.has_password());
                if on_min && has_password && window.is_minimized().unwrap_or(false) {
                    lock_now(app, &inner, LockReason::Minimized);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            transfer::transfer_status,
            transfer::transfer_pair_start,
            transfer::transfer_pair_confirm,
            transfer::transfer_pair_cancel,
            transfer::transfer_forget,
            transfer::transfer_send,
            transfer::transfer_cancel,
            cmd_vault::get_state,
            cmd_vault::vault_sizes,
            cmd_vault::save_config,
            cmd_vault::add_vault,
            cmd_vault::forget_vault,
            cmd_vault::create_vault,
            cmd_vault::unlock,
            cmd_vault::unlock_with_recovery,
            cmd_vault::open_vault,
            cmd_vault::turn_password_off,
            cmd_vault::set_password,
            cmd_vault::set_new_password,
            cmd_vault::change_password,
            cmd_vault::reset_recovery,
            cmd_vault::lock_vault,
            cmd_vault::report_activity,
            userbusy::set_user_busy,
            gpuroom::models_log,
            gpuroom::models_fit,
            diaglog::diag_note,
            cmd_library::library_folders,
            cmd_library::library_page,
            cmd_library::move_folders,
            cmd_library::delete_folders,
            cmd_library::restore_folders,
            cmd_library::folder_view,
            cmd_library::query_items,
            cmd_library::get_item,
            cmd_library::create_folder,
            cmd_library::rename_folder,
            cmd_library::rename_many,
            cmd_library::move_folder,
            cmd_library::delete_folder,
            cmd_library::delete_items,
            cmd_library::restore_items,
            cmd_library::restore_folder,
            cmd_library::trash_view,
            cmd_library::delete_forever,
            cmd_library::delete_folder_forever,
            cmd_library::empty_trash,
            cmd_library::set_pinned,
            cmd_library::set_folder_look,
            cmd_library::library_stats,
            cmd_library::mark_viewed,
            cmd_library::random_journey,
            cmd_library::todays_pick,
            cmd_library::folder_samples,
            cmd_library::bookmarks,
            cmd_library::add_bookmark,
            cmd_library::update_bookmark,
            cmd_library::delete_bookmark,
            cmd_media::add_file_bytes,
            cmd_library::move_items,
            cmd_library::set_favourite,
            cmd_library::set_weight,
            cmd_library::set_cover,
            cmd_library::set_cover_frame,
            cmd_library::folder_banner,
            cmd_library::set_banner,
            cmd_faces::river_faces,
            cmd_library::all_tags,
            cmd_library::item_tags,
            cmd_library::tag_items,
            cmd_library::untag_items,
            cmd_library::tag_folder,
            cmd_library::untag_folder,
            cmd_library::list_named,
            cmd_library::save_named,
            cmd_library::delete_named,
            cmd_media::thumbs_needed,
            cmd_media::thumbs_to_sharpen,
            cmd_media::thumbs_to_webp,
            cmd_media::count_to_sharpen,
            cmd_media::newest_item_id,
            cmd_media::save_thumb,
            cmd_media::thumb_failed,
            cmd_media::previews_needed,
            cmd_media::save_preview,
            cmd_media::preview_failed,
            cmd_media::save_tiny,
            cmd_media::tiny_failed,
            cmd_media::make_tiny_with_tool,
            cmd_vault::cache_info,
            cmd_misc::ui_get,
            transfer::playable::playable_copy,
            cmd_vault::save_now,
            cmd_vault::data_info,
            cmd_vault::delete_data,
            cmd_vault::smart_data_delete,
            restore::library_backups,
            restore::restore_library_backup,
            cmd_library::extract_folder,
            cmd_library::unextract_folder,
            cmd_misc::ui_set,
            cmd_media::inspect_drop,
            cmd_media::check_archive_password,
            cmd_media::start_import,
            cmd_media::cancel_import,
            cmd_media::scan_local,
            cmd_misc::selftest_info,
            cmd_vault::storage_info,
            cmd_vault::storage_task,
            cmd_misc::selftest_done,
            cmd_vault::check_damage,
            cmd_vault::cancel_task,
            cmd_media::export_start,
            cmd_media::share_7z_start,
            cmd_misc::engine_info,
            cmd_misc::engine_started,
            cmd_misc::engine_retry,
            cmd_faces::set_person_folder,
            cmd_faces::faces_queue,
            cmd_faces::faces_needed,
            cmd_faces::faces_left,
            cmd_faces::faces_save,
            cmd_faces::faces_failed,
            cmd_faces::faces_status,
            cmd_faces::faces_review,
            cmd_faces::faces_accept,
            cmd_faces::faces_reject,
            cmd_faces::faces_new_person,
            cmd_faces::faces_of,
            cmd_faces::faces_reset,
            cmd_faces::faces_folder_off,
            cmd_faces::faces_off_folders,
            cmd_faces::faces_stop,
            cmd_faces::faces_delete_folder,
            cmd_faces::faces_delete_items,
            cmd_faces::faces_matches,
            cmd_faces::faces_unsure,
            cmd_faces::faces_of_many,
            cmd_faces::faces_auto,
            cmd_faces::faces_engine,
            cmd_faces::faces_upgrade,
            cmd_faces::faces_find_owner,
            cmd_faces::faces_hide,
            cmd_faces::faces_merge_people,
            cmd_faces::faces_not_same,
            cmd_faces::faces_after_import,
            cmd_faces::faces_sort_offers,
            cmd_faces::faces_sort_all,
            faceid::faces_detect,
            faceid::faces_points,
            // a person's faces cut out (facecrops.rs)
            facecrops::face_crops_list,
            facecrops::face_crops_measure,
            facecrops::face_crops_stop,
            // the native analysis pass (analyse.rs)
            analyse::analyse_start,
            analyse::analyse_status,
            analyse::analyse_kick,
            analyse::analyse_thumb,
            analyse::analyse_now,
            cmd_library::set_resume,
            cmd_similar::set_focus,
            cmd_faces::person_item_ids,
            cmd_similar::similar_needed,
            cmd_similar::similar_save,
            cmd_similar::similar_failed,
            cmd_similar::similar_status,
            cmd_similar::similar_groups,
            cmd_similar::similar_to,
            cmd_library::free_copy,
            cmd_library::item_copies,
            cmd_library::free_copies_of,
            cmd_library::promote_copy,
            cmd_library::restore_links,
            cmd_library::copy_into,
            cmd_library::merge_plan,
            cmd_library::merge_folders,
            cmd_library::unmerge_folders,
            cmd_library::set_folder_order,
            cmd_library::restore_folder_order,
            cmd_library::tag_list,
            cmd_library::rename_tag,
            cmd_library::delete_tag,
            cmd_library::restore_tag,
            cmd_library::set_tag_color,
            cmd_library::set_note,
            cmd_library::folder_note,
            cmd_library::continue_watching,
            cmd_library::suggest_folders,
            cmd_similar::exact_groups,
            // video tool
            cmd_media::video_tool_info,
            cmd_media::convert_start,
            cmd_media::animation_start,
            cmd_media::cut_start,
            cmd_media::add_copy_bytes,
            beatlisten::beats_supported,
            beatlisten::beats_start,
            beatlisten::beats_stop,
            beatlisten::beats_status,
            // Windows Explorer: drag out, copy/paste (winshell.rs)
            winshell::drag_out,
            winshell::clipboard_put_files,
            winshell::clipboard_clear_ours,
            winshell::clipboard_read,
            // duel mode (duel.rs)
            cmd_misc::duel_ratings,
            cmd_misc::duel_result,
            cmd_misc::duel_restore,
            // why is this here? (explain.rs) and the slot machine (slots.rs)
            explain::explain_match,
            slots::slot_machine_data,
            // background jobs, vault growth
            cmd_media::background_left,
            cmd_media::previews_folder_off,
            cmd_media::previews_off_folders,
            cmd_media::previews_delete_folders,
            cmd_vault::vault_growth,
            // offline AI upscaler (upscale.rs)
            upscale::upscale_info,
            upscale::upscale_start,
            upscale::upscale_cancel,
            upscale::upscale_save,
            cmd_media::rotate_picture,
            cmd_media::rotate_replace,
            cmd_media::rotate_video,
            cmd_media::rotate_undo,
            upscale::upscale_forget,
            // 3D photos (depth.rs)
            depth::depth_info,
            depth::depth_models,
            depth::depth_estimate,
            depth::depth_benchmark,
            depth::depth_forget,
            // Subject outlines (subject.rs)
            subject::subject_info,
            subject::subject_models,
            subject::subject_estimate,
            subject::subject_benchmark,
            subject::subject_forget,
            // Background fill (inpaint.rs)
            inpaint::inpaint_info,
            inpaint::inpaint_models,
            inpaint::inpaint_estimate,
            inpaint::inpaint_benchmark,
            inpaint::inpaint_forget,
            // Saved depth maps and outlines (derived.rs)
            derived::derived_get,
            derived::derived_put,
            derived::derived_clear,
            derived::derived_stats,
            derived::derived_have,
            derived::derived_summary,
            derived::derived_remove,
            derived::faces_split,
            encryption::encryption_off,
            encryption::encryption_on,
            encryption::encryption_continue,
            encryption::encryption_stop,
            encryption::encryption_running,
            encryption::open_files_folder,
        ])
        .build(tauri::generate_context!())
        .expect("Media Vault failed to start")
        .run(|app, event| {
            // However the app ends, unsaved library changes are written first.
            if let tauri::RunEvent::Exit = event {
                winshell::on_exit();
            }
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                beatlisten::stop(app);
                let inner = app.state::<Shared>().inner().clone();
                let open = inner.session.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let Some(s) = open
                    && s.is_dirty()
                {
                    let _ = s.save();
                }
            }
        });
}
