//! Wi-Fi transfer with the phone (the hidden vault in Baro Alarm).
//!
//! - `mvtp`: the shared protocol (MVTP/1, claude/transfer-protocol.md), with its test vectors.
//! - `store`: what is remembered inside the vault (identity, paired phones, landing folder).
//! - `items`: the library side (what to offer, answering, recording received items).
//! - `server`: listening, pairing, the handshake; `conn`: one connected phone.

pub mod conn;
pub mod items;
pub mod mvtp;
pub mod playable;
pub mod server;
pub mod store;
#[cfg(test)]
mod tests_e2e;

use std::sync::{Arc, OnceLock};
use std::time::Instant;

use tauri::{AppHandle, Emitter};

use crate::session::Session;
use crate::{Shared, sess};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Called once at startup.
pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// A vault was unlocked: the transfer starts (it listens only once a phone is paired).
pub fn start(inner: &Shared, s: Arc<Session>) {
    let weak = Arc::downgrade(inner);
    server::on_unlock(
        s,
        server::Hooks {
            emit: Box::new(|name, v| {
                if let Some(app) = APP.get() {
                    let _ = app.emit(name, v);
                }
            }),
            keep_awake: Box::new(move || {
                if let Some(inner) = weak.upgrade() {
                    inner.activity.lock().unwrap_or_else(|e| e.into_inner()).playing(Instant::now());
                }
            }),
            playable: Box::new(playable_copies),
        },
        server::Ports::default(),
    );
}

/// Playable copies of received formats this app can't show (the original
/// stays). Returns how many were made and what failed.
fn playable_copies(s: &Arc<Session>, ids: &[i64]) -> (usize, Vec<(String, String)>) {
    playable::make_copies(s, ids, &std::sync::atomic::AtomicBool::new(false))
}

/// The vault is locking.
pub fn stop() {
    server::on_lock();
}

// ---- commands ---------------------------------------------------------------------

#[tauri::command]
pub(crate) fn transfer_status() -> server::Status {
    server::status()
}

#[tauri::command]
pub(crate) fn transfer_pair_start(state: tauri::State<'_, Shared>) -> Result<(), String> {
    sess(state.inner())?;
    server::pair_start()
}

#[tauri::command]
pub(crate) fn transfer_pair_confirm(yes: bool) -> Result<(), String> {
    server::pair_confirm(yes)
}

#[tauri::command]
pub(crate) fn transfer_pair_cancel() -> Result<(), String> {
    server::pair_cancel()
}

#[tauri::command]
pub(crate) async fn transfer_forget(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || server::forget(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub(crate) struct Queued {
    items: usize,
}

#[tauri::command]
pub(crate) async fn transfer_send(media: Vec<i64>, folders: Vec<i64>) -> Result<Queued, String> {
    tauri::async_runtime::spawn_blocking(move || server::send(&media, &folders).map(|items| Queued { items }))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn transfer_cancel() -> Result<(), String> {
    server::cancel()
}
