//! Commands for smart search and look-alikes: the smart-search vectors made
//! by the window, searching with them, what the window shows first (focus),
//! the look-alike fingerprints, look-alike groups and exact copies.

use tauri::State;

use crate::{Shared, blocking, edit_db_derived, read_db, sess};
use crate::{analyse, binbody, clip, library, similar};

// ---- smart search -----------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn clip_needed(state: State<'_, Shared>, limit: i64) -> Result<Vec<clip::ClipTask>, String> {
    // While the native analysis pass runs with its model, it does them all.
    if analyse::window_skips_smart() {
        return Ok(Vec::new());
    }
    read_db(state.inner(), move |c| clip::needed(c, limit)).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FocusArgs {
    folder: Option<i64>,
    #[serde(default)]
    in_folder: bool,
    #[serde(default)]
    ids: Vec<i64>,
}

/// What the window shows: thumbnails, fingerprints, smart search and faces
/// are made for these first (focus.rs).
#[tauri::command]
pub(crate) fn set_focus(focus: Option<FocusArgs>) {
    crate::focus::set(focus.map(|f| crate::focus::Focus { folder: f.folder, in_folder: f.in_folder, ids: f.ids }));
    analyse::kick();
}

#[derive(serde::Deserialize)]
struct MediaArgs {
    media: i64,
}

/// Raw body: {media}, then the vectors as little-endian 32-bit floats (binbody.rs).
#[tauri::command]
pub(crate) async fn clip_save(state: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let (MediaArgs { media }, data) = binbody::request(&request)?;
    let vec = binbody::floats(data)?;
    edit_db_derived(state.inner(), move |c| clip::save(c, media, &vec)).await
}

#[tauri::command]
pub(crate) async fn clip_failed(state: State<'_, Shared>, media: i64) -> Result<(), String> {
    edit_db_derived(state.inner(), move |c| clip::failed(c, media)).await
}

#[tauri::command]
pub(crate) async fn clip_status(state: State<'_, Shared>) -> Result<clip::ClipStatus, String> {
    read_db(state.inner(), clip::status).await
}

#[tauri::command]
pub(crate) async fn smart_search(
    state: State<'_, Shared>,
    vec: Vec<f32>,
    folder: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<clip::Hit>, String> {
    read_db(state.inner(), move |c| clip::search(c, &vec, folder, limit.unwrap_or(300))).await
}

// ---- look-alikes -----------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn similar_needed(state: State<'_, Shared>, limit: i64) -> Result<Vec<similar::FpTask>, String> {
    // While the native analysis pass runs, it makes them all.
    if analyse::window_skips_prints() {
        return Ok(Vec::new());
    }
    read_db(state.inner(), move |c| similar::needed(c, limit)).await
}

#[tauri::command]
pub(crate) async fn similar_save(state: State<'_, Shared>, id: i64, hash: String, sharpness: f64) -> Result<(), String> {
    edit_db_derived(state.inner(), move |c| similar::save(c, id, &hash, sharpness)).await
}

#[tauri::command]
pub(crate) async fn similar_failed(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db_derived(state.inner(), move |c| similar::failed(c, id)).await
}

#[tauri::command]
pub(crate) async fn similar_status(state: State<'_, Shared>) -> Result<similar::FpStatus, String> {
    read_db(state.inner(), similar::status).await
}

#[tauri::command]
pub(crate) async fn similar_groups(
    state: State<'_, Shared>,
    level: String,
    smart: bool,
    folder: Option<i64>,
    videos: bool,
) -> Result<Vec<Vec<library::Item>>, String> {
    let s = sess(state.inner())?;
    blocking(move || {
        let data = similar::load(&s.db(), smart, folder)?;
        Ok(similar::group(data, similar::Level::parse(&level), smart, videos))
    })
    .await
}

#[tauri::command]
pub(crate) async fn similar_to(state: State<'_, Shared>, id: i64, smart: bool) -> Result<Vec<clip::Hit>, String> {
    read_db(state.inner(), move |c| similar::similar_to(c, id, smart, 300)).await
}

#[tauri::command]
pub(crate) async fn exact_groups(state: State<'_, Shared>, folder: Option<i64>) -> Result<Vec<Vec<library::Item>>, String> {
    read_db(state.inner(), move |c| similar::exact_groups(c, folder)).await
}
