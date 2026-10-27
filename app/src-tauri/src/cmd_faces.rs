//! Commands for face recognition: person folders, the scan queue and its
//! results from the window, the People page (review, naming, accepting and
//! rejecting faces, new people, merging), sorting people into their folders,
//! the faces of an item, the faces river, and each person's items.

use serde::Serialize;
use tauri::State;

use crate::{Shared, blocking, edit_db, edit_db_bg, edit_db_derived, read_db, sess};
use crate::{analyse, faces, library, riverfaces};

// ---- face recognition -----------------------------------------------------------------

#[tauri::command]
pub(crate) async fn set_person_folder(state: State<'_, Shared>, folder: i64, on: bool) -> Result<(), String> {
    edit_db(state.inner(), move |c| faces::set_person(c, folder, on)).await
}

#[tauri::command]
pub(crate) async fn faces_queue(state: State<'_, Shared>, request: faces::ScanRequest) -> Result<usize, String> {
    edit_db(state.inner(), move |c| faces::queue(c, &request)).await
}

/// "Disable / Enable face search for this folder" (folder right-click).
#[tauri::command]
pub(crate) async fn faces_folder_off(state: State<'_, Shared>, folder: i64, off: bool) -> Result<usize, String> {
    let n = edit_db(state.inner(), move |c| faces::set_folder_off(c, folder, off)).await?;
    analyse::kick();
    Ok(n)
}

/// The folders where face search was turned off (for the folder menus).
#[tauri::command]
pub(crate) async fn faces_off_folders(state: State<'_, Shared>) -> Result<Vec<i64>, String> {
    read_db(state.inner(), faces::off_folders).await
}

/// "Stop face search": everything waiting leaves the queue.
#[tauri::command]
pub(crate) async fn faces_stop(state: State<'_, Shared>) -> Result<usize, String> {
    edit_db(state.inner(), faces::stop).await
}

/// "Delete face data…" for a folder and everything inside it.
#[tauri::command]
pub(crate) async fn faces_delete_folder(state: State<'_, Shared>, folder: i64) -> Result<usize, String> {
    edit_db(state.inner(), move |c| faces::delete_folder_faces(c, folder)).await
}

/// "Delete face data…" for a selection of items.
#[tauri::command]
pub(crate) async fn faces_delete_items(state: State<'_, Shared>, ids: Vec<i64>) -> Result<usize, String> {
    edit_db(state.inner(), move |c| faces::delete_item_faces(c, &ids)).await
}

#[tauri::command]
pub(crate) async fn faces_needed(state: State<'_, Shared>, limit: i64) -> Result<Vec<faces::ScanTask>, String> {
    // Pictures the native analysis pass reads are left to it (analyse.rs).
    read_db(state.inner(), move |c| analyse::window_faces(c, limit)).await
}

/// How many of those are left (counted, not listed).
#[tauri::command]
pub(crate) async fn faces_left(state: State<'_, Shared>) -> Result<i64, String> {
    read_db(state.inner(), analyse::window_faces_left).await
}

#[tauri::command]
pub(crate) async fn faces_save(state: State<'_, Shared>, media: i64, faces: Vec<faces::FaceIn>, model: Option<i64>) -> Result<usize, String> {
    edit_db_derived(state.inner(), move |c| faces::save(c, media, &faces, model.unwrap_or(faces::ARCFACE))).await
}

#[tauri::command]
pub(crate) async fn faces_failed(state: State<'_, Shared>, media: i64, model: Option<i64>) -> Result<(), String> {
    edit_db_derived(state.inner(), move |c| faces::failed(c, media, model.unwrap_or(faces::ARCFACE))).await
}

#[tauri::command]
pub(crate) async fn faces_status(state: State<'_, Shared>) -> Result<faces::ScanStatus, String> {
    read_db(state.inner(), faces::status).await
}

/// Everything the People page shows (names sure faces automatically first).
#[tauri::command]
pub(crate) async fn faces_review(state: State<'_, Shared>, request: Option<faces::ReviewRequest>) -> Result<faces::Review, String> {
    let s = sess(state.inner())?;
    blocking(move || {
        let r = faces::review(&*s, &request.unwrap_or_default())?;
        if r.changed > 0 {
            s.mark_dirty_bg(); // automatic names only
        }
        Ok(r)
    })
    .await
}

/// The automatic naming pass (the scanner calls it now and then).
#[tauri::command]
pub(crate) async fn faces_auto(state: State<'_, Shared>) -> Result<usize, String> {
    let s = sess(state.inner())?;
    blocking(move || {
        let n = faces::refresh(&*s)?;
        if n > 0 {
            s.mark_dirty_bg(); // automatic names only
        }
        Ok(n)
    })
    .await
}

/// Which face model is used, the faces pack, and the rescan with the new model.
#[tauri::command]
pub(crate) async fn faces_engine(state: State<'_, Shared>) -> Result<faces::EngineStatus, String> {
    read_db(state.inner(), faces::engine_status).await
}

/// The faces pack is there: scan everything again with it (once).
#[tauri::command]
pub(crate) async fn faces_upgrade(state: State<'_, Shared>) -> Result<usize, String> {
    edit_db_bg(state.inner(), faces::upgrade).await
}

/// "Find me in this folder".
#[tauri::command]
pub(crate) async fn faces_find_owner(state: State<'_, Shared>, person: i64) -> Result<Option<faces::OwnerProposal>, String> {
    let s = sess(state.inner())?;
    blocking(move || faces::find_owner(&*s, person)).await
}

/// "Not important" (hidden = true) or show again.
#[tauri::command]
pub(crate) async fn faces_hide(state: State<'_, Shared>, face_ids: Vec<i64>, hidden: bool) -> Result<usize, String> {
    edit_db(state.inner(), move |c| faces::hide(c, &face_ids, hidden)).await
}

#[tauri::command]
pub(crate) async fn faces_merge_people(state: State<'_, Shared>, keep: i64, other: i64) -> Result<usize, String> {
    edit_db(state.inner(), move |c| faces::merge_people(c, keep, other)).await
}

#[tauri::command]
pub(crate) async fn faces_not_same(state: State<'_, Shared>, a: i64, b: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| faces::not_same(c, a, b)).await
}

/// After an import: queue the new pictures for face scanning (if face
/// recognition is in use). Returns them.
#[tauri::command]
pub(crate) async fn faces_after_import(state: State<'_, Shared>, since: i64) -> Result<Vec<i64>, String> {
    edit_db_bg(state.inner(), move |c| faces::after_import(c, since)).await
}

/// "47 of these are Baran — put them in his folder?"
#[tauri::command]
pub(crate) async fn faces_sort_offers(state: State<'_, Shared>, ids: Vec<i64>) -> Result<faces::SortOffers, String> {
    let s = sess(state.inner())?;
    blocking(move || {
        let r = faces::sort_offers(&*s, &ids)?;
        if r.changed > 0 {
            s.mark_dirty_bg(); // automatic names only
        }
        Ok(r)
    })
    .await
}

/// "Sort people into their folders": every person and the photos of them outside their folder.
#[tauri::command]
pub(crate) async fn faces_sort_all(state: State<'_, Shared>, ids: Option<Vec<i64>>, folder: Option<i64>) -> Result<faces::SortOffers, String> {
    let s = sess(state.inner())?;
    blocking(move || {
        // Only these items, or one folder and its subfolders; nothing given = the whole vault.
        let r = if ids.is_some() || folder.is_some() { faces::sort_scoped(&*s, &ids.unwrap_or_default(), folder)? } else { faces::sort_all(&*s)? };
        if r.changed > 0 {
            s.mark_dirty_bg(); // automatic names only
        }
        Ok(r)
    })
    .await
}

#[tauri::command]
pub(crate) async fn faces_accept(state: State<'_, Shared>, face_ids: Vec<i64>, person: i64) -> Result<faces::Accepted, String> {
    edit_db(state.inner(), move |c| faces::accept(c, &face_ids, person)).await
}

#[tauri::command]
pub(crate) async fn faces_reject(state: State<'_, Shared>, face_ids: Vec<i64>, person: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| faces::reject(c, &face_ids, person)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewPerson {
    folder: i64,
    accepted: faces::Accepted,
}

#[tauri::command]
pub(crate) async fn faces_new_person(
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
pub(crate) async fn faces_of(state: State<'_, Shared>, media: i64, hidden: Option<bool>) -> Result<Vec<faces::FaceBox>, String> {
    read_db(state.inner(), move |c| faces::faces_of_with(c, media, hidden.unwrap_or(false))).await
}

/// "Who is it?": the people this face most likely is, with how likely (0–99).
#[tauri::command]
pub(crate) async fn faces_matches(state: State<'_, Shared>, face: i64) -> Result<Vec<(i64, u32)>, String> {
    read_db(state.inner(), move |c| faces::face_matches(c, face)).await
}

/// "Reset and re-scan" the faces of these items (viewer right-click).
#[tauri::command]
pub(crate) async fn faces_reset(state: State<'_, Shared>, media: Vec<i64>) -> Result<usize, String> {
    let n = edit_db(state.inner(), move |c| faces::reset(c, &media)).await?;
    analyse::kick();
    Ok(n)
}

#[tauri::command]
pub(crate) async fn faces_of_many(state: State<'_, Shared>, media: Vec<i64>) -> Result<Vec<(i64, Vec<faces::FaceBox>)>, String> {
    read_db(state.inner(), move |c| faces::faces_of_many(c, &media)).await
}

#[tauri::command]
pub(crate) async fn faces_unsure(state: State<'_, Shared>, person: i64) -> Result<Vec<library::Item>, String> {
    read_db(state.inner(), move |c| faces::unsure_items(c, person)).await
}

// ---- faces river (begin) ----
#[tauri::command]
pub(crate) async fn river_faces(state: State<'_, Shared>, people: Vec<i64>) -> Result<Vec<riverfaces::RiverFace>, String> {
    read_db(state.inner(), move |c| riverfaces::list(c, &people)).await
}
// ---- faces river (end) ----

// ---- each person's items -------------------------------------------------------------

/// Per person folder, the ids of the items showing them (as `query_items`
/// with `people: [id]`), all in one call instead of one call per person.
#[tauri::command]
pub(crate) async fn person_item_ids(state: State<'_, Shared>, people: Vec<i64>) -> Result<Vec<(i64, Vec<i64>)>, String> {
    read_db(state.inner(), move |c| {
        people
            .iter()
            .take(64)
            .map(|&p| {
                let items = library::query_items(c, &library::ItemFilter { people: vec![p], ..Default::default() })?;
                Ok((p, items.into_iter().map(|i| i.id).collect()))
            })
            .collect()
    })
    .await
}
