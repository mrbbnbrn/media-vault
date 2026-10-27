//! Smaller commands that fit nowhere else: remembered UI state per vault,
//! the built-in web engine, duel mode's ratings, and the self-test.

use tauri::State;

use crate::{Shared, edit_db, edit_db_bg, read_db};
use crate::{duel, engine, selftest};

// ---- small remembered UI state (per vault, encrypted) -------------------------------------

/// Remembered UI state for this vault: per-folder view settings, where you
/// left off. Kept in the library's settings table (encrypted like the rest).
#[tauri::command]
pub(crate) async fn ui_get(state: State<'_, Shared>, key: String) -> Result<Option<String>, String> {
    read_db(state.inner(), move |c| {
        Ok(c.query_row("SELECT value FROM settings WHERE key = ?", [format!("ui:{key}")], |r| r.get(0)).ok())
    })
    .await
}

#[tauri::command]
pub(crate) async fn ui_set(state: State<'_, Shared>, key: String, value: String) -> Result<(), String> {
    if key.len() > 64 || value.len() > 512 * 1024 {
        return Err("Too large.".into());
    }
    edit_db_bg(state.inner(), move |c| {
        c.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [format!("ui:{key}"), value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

// ---- web engine --------------------------------------------------------------------

#[tauri::command]
pub(crate) fn engine_info(state: State<'_, Shared>) -> engine::EngineInfo {
    state.engine.clone()
}

#[tauri::command]
pub(crate) fn engine_started(state: State<'_, Shared>) {
    engine::started(&state.config_dir, &state.engine);
}

#[tauri::command]
pub(crate) fn engine_retry(state: State<'_, Shared>) {
    engine::retry(&state.config_dir);
}

// ---- duel mode (duel.rs) ------------------------------------------------------------------

/// Ratings (Elo, duel count, weight) of these items.
#[tauri::command]
pub(crate) async fn duel_ratings(state: State<'_, Shared>, ids: Vec<i64>) -> Result<Vec<duel::DuelState>, String> {
    read_db(state.inner(), move |c| duel::ratings(c, &ids)).await
}

/// `winner` was picked over `loser`: new ratings and weights for both.
#[tauri::command]
pub(crate) async fn duel_result(state: State<'_, Shared>, winner: i64, loser: i64) -> Result<duel::DuelOutcome, String> {
    edit_db(state.inner(), move |c| duel::result(c, winner, loser)).await
}

/// Undo: put items back as they were before a duel.
#[tauri::command]
pub(crate) async fn duel_restore(state: State<'_, Shared>, states: Vec<duel::DuelState>) -> Result<(), String> {
    edit_db(state.inner(), move |c| duel::restore(c, &states)).await
}

// ---- self-test ---------------------------------------------------------------------

#[tauri::command]
pub(crate) fn selftest_info(state: State<'_, Shared>) -> Option<selftest::SelfTestInfo> {
    state.selftest.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub(crate) fn selftest_done(state: State<'_, Shared>, ok: bool, report: String) {
    if state.selftest.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
        std::process::exit(selftest::finish(ok, &report));
    }
}
