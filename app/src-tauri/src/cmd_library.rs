//! Commands for the library itself: folders and items (making, renaming,
//! moving, the trash and deleting for good), favourites, weights, covers and
//! banners, bookmarks, tags and saved searches, notes, the player's resume
//! point, and organising (free and real copies, merging folders, folder
//! order, tag management, folder suggestions). Space freed by deleting for
//! good is reclaimed here too (reclaim_soon).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{Shared, blocking, edit_db, edit_db_bg, read_db, sess};
use crate::{analyse, banner, extras, import, library, organize, session, storage, throttle};

#[tauri::command]
pub(crate) async fn library_folders(state: State<'_, Shared>) -> Result<Vec<library::FolderCard>, String> {
    read_db(state.inner(), library::all_folders).await
}

/// What the library needs to show a page, in one call instead of three: every
/// folder card, every tag, and (for a folder page) its items. With
/// `focus_here`, background work also does this folder's items first (what
/// set_focus would do in a fourth call).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryPage {
    folders: Vec<library::FolderCard>,
    tags: Vec<library::TagCount>,
    items: Option<Vec<library::Item>>,
}

#[tauri::command]
pub(crate) async fn library_page(state: State<'_, Shared>, filter: Option<library::ItemFilter>, focus_here: Option<bool>) -> Result<LibraryPage, String> {
    let page = read_db(state.inner(), move |c| {
        let items = match &filter {
            Some(f) => Some(library::query_items(c, f)?),
            None => None,
        };
        let folder = filter.as_ref().and_then(|f| f.folder.flatten());
        Ok((LibraryPage { folders: library::all_folders(c)?, tags: library::all_tags(c)?, items }, folder))
    })
    .await?;
    let (page, folder) = page;
    if focus_here.unwrap_or(false)
        && let Some(items) = &page.items
    {
        crate::focus::set(Some(crate::focus::Focus { folder, in_folder: true, ids: items.iter().take(300).map(|i| i.id).collect() }));
        analyse::kick();
    }
    Ok(page)
}

/// How far a batch got: the first `done` steps happened; `error` is why the
/// next one couldn't (None = all done).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchDone {
    done: usize,
    error: Option<String>,
}

/// Several folders moved at once (each to its own new parent), one save. Stops
/// at the first one that can't move; the ones before it stay moved.
#[tauri::command]
pub(crate) async fn move_folders(state: State<'_, Shared>, moves: Vec<(i64, Option<i64>)>) -> Result<BatchDone, String> {
    edit_db(state.inner(), move |c| {
        for (i, (id, parent)) in moves.into_iter().enumerate() {
            if let Err(e) = library::move_folder(c, id, parent) {
                return Ok(BatchDone { done: i, error: Some(e) });
            }
        }
        Ok(BatchDone { done: usize::MAX, error: None })
    })
    .await
}

/// Several folders to the trash at once, one save. Returns how many items went with them.
#[tauri::command]
pub(crate) async fn delete_folders(state: State<'_, Shared>, ids: Vec<i64>) -> Result<i64, String> {
    edit_db(state.inner(), move |c| {
        let mut n = 0;
        for id in ids {
            n += library::trash_folder(c, id)?;
        }
        Ok(n)
    })
    .await
}

/// Several folders back from the trash at once, one save.
#[tauri::command]
pub(crate) async fn restore_folders(state: State<'_, Shared>, ids: Vec<i64>) -> Result<(), String> {
    edit_db(state.inner(), move |c| {
        for id in ids {
            library::restore_folder(c, id)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn folder_view(
    state: State<'_, Shared>,
    folder: Option<i64>,
) -> Result<library::FolderView, String> {
    read_db(state.inner(), move |c| library::folder_view(c, folder)).await
}

#[tauri::command]
pub(crate) async fn query_items(
    state: State<'_, Shared>,
    filter: library::ItemFilter,
) -> Result<Vec<library::Item>, String> {
    read_db(state.inner(), move |c| library::query_items(c, &filter)).await
}

#[tauri::command]
pub(crate) async fn get_item(state: State<'_, Shared>, id: i64) -> Result<library::Item, String> {
    read_db(state.inner(), move |c| library::get_item(c, id)).await
}

#[tauri::command]
pub(crate) async fn create_folder(
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
pub(crate) async fn rename_folder(state: State<'_, Shared>, id: i64, name: String) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::rename_folder(c, id, &name)).await
}

#[tauri::command]
pub(crate) async fn rename_many(state: State<'_, Shared>, folders: Vec<(i64, String)>, items: Vec<(i64, String)>) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::rename_many(c, &folders, &items)).await
}

#[tauri::command]
pub(crate) async fn move_folder(state: State<'_, Shared>, id: i64, parent: Option<i64>) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::move_folder(c, id, parent)).await
}

/// Deletions are saved right away, before the encrypted files are removed,
/// so a crash can never leave the library pointing at missing files.
async fn delete_and_clean(
    inner: &Shared,
    f: impl FnOnce(&rusqlite::Connection) -> Result<library::Orphans, String> + Send + 'static,
) -> Result<usize, String> {
    let s = sess(inner)?;
    let s2 = s.clone();
    let n = blocking(move || {
        let orphans = f(&s.db())?;
        s.mark_dirty();
        s.save()?;
        import::remove_objects(&s, &orphans);
        Ok::<_, String>((orphans.media.len(), !orphans.media.is_empty() || !orphans.thumbs.is_empty()))
    })
    .await?;
    if n.1 {
        reclaim_soon(inner.clone(), s2);
    }
    Ok(n.0)
}

/// A reclaim is waiting to run (several deletions in a row share one).
static RECLAIM_PENDING: AtomicBool = AtomicBool::new(false);

/// With "Reclaim space automatically" on: a few seconds after deleting for
/// good, the packs holding deleted files are rewritten in the background
/// (never during an import), so nothing of them stays in the vault folder.
pub(crate) fn reclaim_soon(inner: Shared, s: Arc<session::Session>) {
    if !inner.config.lock().unwrap_or_else(|e| e.into_inner()).auto_reclaim || RECLAIM_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        let _turn = inner.import_gate.lock().unwrap_or_else(|e| e.into_inner());
        RECLAIM_PENDING.store(false, Ordering::SeqCst);
        if !s.is_closed()
            && let Err(err) = storage::reclaim_all_deleted(&s)
        {
            eprintln!("Reclaiming space after deleting didn't finish: {err}");
        }
    });
}

/// "Delete" puts things in the trash; they can be restored for 30 days.
#[tauri::command]
pub(crate) async fn delete_folder(state: State<'_, Shared>, id: i64) -> Result<i64, String> {
    edit_db(state.inner(), move |c| library::trash_folder(c, id)).await
}

#[tauri::command]
pub(crate) async fn delete_items(state: State<'_, Shared>, ids: Vec<i64>) -> Result<i64, String> {
    edit_db(state.inner(), move |c| library::trash_items(c, &ids)).await
}

#[tauri::command]
pub(crate) async fn restore_items(state: State<'_, Shared>, ids: Vec<i64>) -> Result<usize, String> {
    edit_db(state.inner(), move |c| library::restore_items(c, &ids)).await
}

#[tauri::command]
pub(crate) async fn restore_folder(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::restore_folder(c, id)).await
}

#[tauri::command]
pub(crate) async fn trash_view(state: State<'_, Shared>) -> Result<library::TrashView, String> {
    read_db(state.inner(), library::trash_view).await
}

#[tauri::command]
pub(crate) async fn delete_forever(state: State<'_, Shared>, ids: Vec<i64>) -> Result<usize, String> {
    delete_and_clean(state.inner(), move |c| library::delete_forever(c, &ids)).await
}

#[tauri::command]
pub(crate) async fn delete_folder_forever(state: State<'_, Shared>, id: i64) -> Result<usize, String> {
    delete_and_clean(state.inner(), move |c| {
        library::delete_folder_forever(c, id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn empty_trash(state: State<'_, Shared>) -> Result<usize, String> {
    delete_and_clean(state.inner(), library::empty_trash).await
}

#[tauri::command]
pub(crate) async fn set_pinned(state: State<'_, Shared>, id: i64, on: bool) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::set_pinned(c, id, on)).await
}

#[tauri::command]
pub(crate) async fn set_folder_look(
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
pub(crate) async fn library_stats(state: State<'_, Shared>) -> Result<extras::Stats, String> {
    read_db(state.inner(), extras::stats).await
}

#[tauri::command]
pub(crate) async fn mark_viewed(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db_bg(state.inner(), move |c| extras::mark_viewed(c, id)).await
}

#[tauri::command]
pub(crate) async fn random_journey(state: State<'_, Shared>) -> Result<Option<extras::Pick>, String> {
    read_db(state.inner(), extras::random_journey).await
}

#[tauri::command]
pub(crate) async fn todays_pick(state: State<'_, Shared>, day: i64) -> Result<Option<library::Item>, String> {
    read_db(state.inner(), move |c| extras::todays_pick(c, day)).await
}

#[tauri::command]
pub(crate) async fn folder_samples(state: State<'_, Shared>, folder: i64, n: i64) -> Result<Vec<i64>, String> {
    read_db(state.inner(), move |c| extras::folder_samples(c, folder, n)).await
}

#[tauri::command]
pub(crate) async fn bookmarks(state: State<'_, Shared>, media: i64) -> Result<Vec<extras::Bookmark>, String> {
    read_db(state.inner(), move |c| extras::bookmarks(c, media)).await
}

#[tauri::command]
pub(crate) async fn add_bookmark(
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
pub(crate) async fn update_bookmark(
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
pub(crate) async fn delete_bookmark(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| extras::delete_bookmark(c, id)).await
}

#[tauri::command]
pub(crate) async fn move_items(
    state: State<'_, Shared>,
    ids: Vec<i64>,
    folder: Option<i64>,
) -> Result<usize, String> {
    edit_db(state.inner(), move |c| library::move_items(c, &ids, folder)).await
}

#[tauri::command]
pub(crate) async fn set_favourite(state: State<'_, Shared>, ids: Vec<i64>, on: bool) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::set_favourite(c, &ids, on)).await
}

#[tauri::command]
pub(crate) async fn set_weight(state: State<'_, Shared>, ids: Vec<i64>, weight: f64) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::set_weight(c, &ids, weight)).await
}

#[tauri::command]
pub(crate) async fn set_cover(
    state: State<'_, Shared>,
    folder: i64,
    media: Option<i64>,
) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::set_cover(c, folder, media)).await
}

// ---- cover framing (begin) ----
/// The hand-set framing of a folder's cover; `pos` None = automatic again.
#[tauri::command]
pub(crate) async fn set_cover_frame(state: State<'_, Shared>, folder: i64, media: Option<i64>, pos: Option<library::CoverPos>) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::set_cover_frame(c, folder, media, pos)).await
}
// ---- cover framing (end) ----

// ---- folder banners (begin) ----
#[tauri::command]
pub(crate) async fn folder_banner(state: State<'_, Shared>, folder: i64) -> Result<Option<banner::Banner>, String> {
    read_db(state.inner(), move |c| banner::get(c, folder)).await
}

#[tauri::command]
pub(crate) async fn set_banner(state: State<'_, Shared>, folder: i64, media: Option<i64>, y: Option<f64>) -> Result<(), String> {
    edit_db(state.inner(), move |c| banner::set(c, folder, media, y)).await
}
// ---- folder banners (end) ----

#[tauri::command]
pub(crate) async fn all_tags(state: State<'_, Shared>) -> Result<Vec<library::TagCount>, String> {
    read_db(state.inner(), library::all_tags).await
}

#[tauri::command]
pub(crate) async fn item_tags(state: State<'_, Shared>, id: i64) -> Result<library::ItemTags, String> {
    read_db(state.inner(), move |c| library::item_tags(c, id)).await
}

#[tauri::command]
pub(crate) async fn tag_items(
    state: State<'_, Shared>,
    ids: Vec<i64>,
    tags: Vec<String>,
) -> Result<Vec<(String, Vec<i64>)>, String> {
    edit_db(state.inner(), move |c| library::tag_items(c, &ids, &tags)).await
}

#[tauri::command]
pub(crate) async fn untag_items(
    state: State<'_, Shared>,
    ids: Vec<i64>,
    tag: String,
) -> Result<Vec<i64>, String> {
    edit_db(state.inner(), move |c| library::untag_items(c, &ids, &tag)).await
}

#[tauri::command]
pub(crate) async fn tag_folder(
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
pub(crate) async fn untag_folder(state: State<'_, Shared>, folder: i64, tag: String) -> Result<(), String> {
    edit_db(state.inner(), move |c| {
        library::untag_folder(c, folder, &tag)
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_named(state: State<'_, Shared>, kind: String) -> Result<Vec<library::Named>, String> {
    read_db(state.inner(), move |c| library::list_named(c, &kind)).await
}

#[tauri::command]
pub(crate) async fn save_named(
    state: State<'_, Shared>,
    kind: String,
    item: library::Named,
) -> Result<i64, String> {
    edit_db(state.inner(), move |c| library::save_named(c, &kind, &item)).await
}

#[tauri::command]
pub(crate) async fn delete_named(state: State<'_, Shared>, kind: String, id: i64) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::delete_named(c, &kind, id)).await
}

#[tauri::command]
pub(crate) async fn extract_folder(state: State<'_, Shared>, id: i64) -> Result<library::Extracted, String> {
    edit_db(state.inner(), move |c| library::extract_folder(c, id)).await
}

#[tauri::command]
pub(crate) async fn unextract_folder(state: State<'_, Shared>, id: i64, extracted: library::Extracted) -> Result<(), String> {
    edit_db(state.inner(), move |c| library::unextract_folder(c, id, &extracted)).await
}

/// Where a video was left off (None = from the start). Background save.
#[tauri::command]
pub(crate) async fn set_resume(state: State<'_, Shared>, id: i64, ms: Option<i64>) -> Result<(), String> {
    edit_db_bg(state.inner(), move |c| {
        c.execute("UPDATE media SET resume_ms = ?1 WHERE id = ?2", rusqlite::params![ms.filter(|m| *m > 0), id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

// ---- organising: free copies, real copies, merging, order, tags, notes ---------------------

#[tauri::command]
pub(crate) async fn free_copy(state: State<'_, Shared>, ids: Vec<i64>, folder: Option<i64>) -> Result<Vec<i64>, String> {
    edit_db(state.inner(), move |c| organize::free_copy(c, &ids, folder)).await
}

#[tauri::command]
pub(crate) async fn item_copies(state: State<'_, Shared>, id: i64) -> Result<Vec<library::Item>, String> {
    read_db(state.inner(), move |c| organize::copies_of(c, id)).await
}

#[tauri::command]
pub(crate) async fn free_copies_of(state: State<'_, Shared>, ids: Vec<i64>) -> Result<Vec<(i64, Vec<library::Item>)>, String> {
    read_db(state.inner(), move |c| organize::free_copies_of(c, &ids)).await
}

#[tauri::command]
pub(crate) async fn promote_copy(state: State<'_, Shared>, old: i64, new: i64) -> Result<organize::Links, String> {
    edit_db(state.inner(), move |c| organize::promote(c, old, new)).await
}

#[tauri::command]
pub(crate) async fn restore_links(state: State<'_, Shared>, links: organize::Links) -> Result<(), String> {
    edit_db(state.inner(), move |c| organize::restore_links(c, &links)).await
}

/// Real copies (Ctrl+C / Ctrl+V). "copy-progress" {done, total} while it works.
#[tauri::command]
pub(crate) async fn copy_into(
    app: AppHandle,
    state: State<'_, Shared>,
    ids: Vec<i64>,
    folders: Vec<i64>,
    target: Option<i64>,
) -> Result<organize::Copied, String> {
    let s = sess(state.inner())?;
    blocking(move || {
        let mut t = throttle::Throttle::new();
        let out = organize::copy_into(&s, &ids, &folders, target, &mut |done, total| {
            if t.ready(done == total) {
                let _ = app.emit("copy-progress", (done, total));
            }
        })?;
        s.save_soon();
        Ok(out)
    })
    .await
}

#[tauri::command]
pub(crate) async fn merge_plan(state: State<'_, Shared>, target: i64, sources: Vec<i64>) -> Result<Vec<Vec<library::Item>>, String> {
    read_db(state.inner(), move |c| organize::merge_plan(c, target, &sources)).await
}

#[tauri::command]
pub(crate) async fn merge_folders(state: State<'_, Shared>, target: i64, sources: Vec<i64>, trash: Vec<i64>) -> Result<organize::Merged, String> {
    edit_db(state.inner(), move |c| organize::merge(c, target, &sources, &trash)).await
}

#[tauri::command]
pub(crate) async fn unmerge_folders(state: State<'_, Shared>, merged: organize::Merged) -> Result<(), String> {
    edit_db(state.inner(), move |c| organize::unmerge(c, &merged)).await
}

#[tauri::command]
pub(crate) async fn set_folder_order(state: State<'_, Shared>, ids: Vec<i64>) -> Result<Vec<(i64, i64)>, String> {
    edit_db(state.inner(), move |c| organize::set_order(c, &ids)).await
}

#[tauri::command]
pub(crate) async fn restore_folder_order(state: State<'_, Shared>, before: Vec<(i64, i64)>) -> Result<(), String> {
    edit_db(state.inner(), move |c| organize::restore_order(c, &before)).await
}

#[tauri::command]
pub(crate) async fn tag_list(state: State<'_, Shared>) -> Result<Vec<organize::TagInfo>, String> {
    read_db(state.inner(), organize::tag_list).await
}

#[tauri::command]
pub(crate) async fn rename_tag(state: State<'_, Shared>, old: String, new: String) -> Result<organize::TagUse, String> {
    edit_db(state.inner(), move |c| organize::rename_tag(c, &old, &new)).await
}

#[tauri::command]
pub(crate) async fn delete_tag(state: State<'_, Shared>, name: String) -> Result<organize::TagUse, String> {
    edit_db(state.inner(), move |c| organize::delete_tag(c, &name)).await
}

#[tauri::command]
pub(crate) async fn restore_tag(state: State<'_, Shared>, before: organize::TagUse, current: Option<String>) -> Result<(), String> {
    edit_db(state.inner(), move |c| organize::restore_tag(c, &before, current.as_deref())).await
}

#[tauri::command]
pub(crate) async fn set_tag_color(state: State<'_, Shared>, name: String, color: Option<String>) -> Result<Option<String>, String> {
    edit_db(state.inner(), move |c| organize::set_tag_color(c, &name, color.as_deref())).await
}

#[tauri::command]
pub(crate) async fn set_note(state: State<'_, Shared>, folder: bool, id: i64, note: Option<String>) -> Result<Option<String>, String> {
    edit_db(state.inner(), move |c| organize::set_note(c, folder, id, note.as_deref())).await
}

#[tauri::command]
pub(crate) async fn folder_note(state: State<'_, Shared>, id: i64) -> Result<Option<String>, String> {
    read_db(state.inner(), move |c| organize::folder_note(c, id)).await
}

#[tauri::command]
pub(crate) async fn continue_watching(state: State<'_, Shared>) -> Result<Vec<library::Item>, String> {
    read_db(state.inner(), organize::continue_watching).await
}

#[tauri::command]
pub(crate) async fn suggest_folders(state: State<'_, Shared>, item: i64) -> Result<Vec<organize::Suggestion>, String> {
    read_db(state.inner(), move |c| organize::suggest(c, item)).await
}
