//! Media Vault desktop app: the bridge between the window (React UI) and the
//! vault core. All crypto happens here in Rust; the UI never sees keys.

mod activity;
mod config;
mod session;

use std::path::PathBuf;
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
    session: Mutex<Option<Session>>,
    activity: Mutex<Activity>,
    kdf: KdfParams,
}

type Shared = Arc<Inner>;

fn panic_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyL)
}

/// Wipe the open vault from memory and tell the UI. Safe to call any time.
fn lock_now(app: &AppHandle, inner: &Inner, reason: LockReason) {
    let was_open = inner.session.lock().unwrap().take().is_some(); // drop = zeroize keys
    if was_open {
        let _ = app.emit("vault-locked", reason.as_str());
    }
    if reason == LockReason::PanicKey
        && let Some(w) = app.get_webview_window("main") {
            let _ = w.minimize();
        }
}

fn with_session<T>(inner: &Inner, f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    let mut guard = inner.session.lock().unwrap();
    let s = guard.as_mut().ok_or_else(|| "The vault is locked.".to_string())?;
    f(s)
}

fn install_session(inner: &Inner, s: Session) -> SessionInfo {
    let info = s.info();
    *inner.activity.lock().unwrap() = Activity::new(Instant::now());
    *inner.session.lock().unwrap() = Some(s);
    let mut cfg = inner.config.lock().unwrap();
    cfg.add_vault(&info.path);
    cfg.last_vault = Some(info.path.clone());
    let _ = config::save(&inner.config_dir, &cfg);
    info
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
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
        let vaults = config.vaults.iter().map(|v| session::describe(&v.path)).collect();
        let session = inner.session.lock().unwrap().as_ref().map(|s| s.info());
        Ok(AppStateDto { config, vaults, session, min_password_chars: session::MIN_PASSWORD_CHARS })
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
        return Err(format!("{path} is not a Media Vault folder. Choose the folder that contains vault.json."));
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
async fn create_vault(state: State<'_, Shared>, parent: String, name: String, password: String) -> Result<Created, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let (s, words) = session::create(&parent, &name, &password, inner.kdf)?;
        Ok(Created { session: install_session(&inner, s), words })
    })
    .await
}

#[tauri::command]
async fn unlock(state: State<'_, Shared>, path: String, password: String) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || Ok(install_session(&inner, session::unlock(&path, &password)?))).await
}

#[tauri::command]
async fn unlock_with_recovery(state: State<'_, Shared>, path: String, words: String) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || Ok(install_session(&inner, session::unlock_with_recovery(&path, &words)?))).await
}

/// After unlocking with the recovery key: set a new password (no old one needed).
#[tauri::command]
async fn set_new_password(state: State<'_, Shared>, password: String) -> Result<SessionInfo, String> {
    let inner = state.inner().clone();
    blocking(move || {
        session::check_password(&password)?;
        with_session(&inner, |s| {
            if !s.needs_new_password {
                return Err("Use “Change password” in Settings instead.".into());
            }
            s.vault.change_password(&password).map_err(session::friendly)?;
            s.needs_new_password = false;
            Ok(s.info())
        })
    })
    .await
}

#[tauri::command]
async fn change_password(state: State<'_, Shared>, current: String, password: String) -> Result<(), String> {
    let inner = state.inner().clone();
    blocking(move || {
        session::check_password(&password)?;
        let root = with_session(&inner, |s| Ok(s.vault.root().to_path_buf()))?;
        session::verify_password(&root, &current)?;
        with_session(&inner, |s| s.vault.change_password(&password).map_err(session::friendly))
    })
    .await
}

#[tauri::command]
async fn reset_recovery(state: State<'_, Shared>, current: String) -> Result<Vec<String>, String> {
    let inner = state.inner().clone();
    blocking(move || {
        let root = with_session(&inner, |s| Ok(s.vault.root().to_path_buf()))?;
        session::verify_password(&root, &current)?;
        with_session(&inner, |s| {
            let phrase = s.vault.reset_recovery().map_err(session::friendly)?;
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

// ---- background watcher ---------------------------------------------------------

#[cfg(windows)]
fn windows_session_locked() -> bool {
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, DESKTOP_SWITCHDESKTOP, OpenInputDesktop};
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
            if inner.session.lock().unwrap().is_none() {
                continue;
            }
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
        ])
        .run(tauri::generate_context!())
        .expect("Media Vault failed to start");
}
