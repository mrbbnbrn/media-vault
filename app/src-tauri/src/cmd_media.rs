//! Commands that make or move media: files saved from the window, thumbnails
//! and preview clips (frame strips, tiny clips), importing, playing files
//! outside the vault, exporting, sharing as an encrypted .7z, the video tool
//! (convert, animations, cuts), copies made in the picture editor, saving a
//! rotation, and what background thumbnail work is still left. The tests of
//! storing thumbnails and preview clips are at the end.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::session::Session;
use crate::{Shared, begin_task, blocking, edit_db_derived, read_db, sess};
use crate::{analyse, binbody, exporter, focus, import, picture, protocol, rotate, share7z, similar, sketch, throttle, thumbpages, videotool};

#[derive(serde::Deserialize)]
struct FileBytesArgs {
    folder: Option<i64>,
    name: String,
}

/// Save something made in the app (a video frame, a GIF) into a folder.
/// Raw body: {folder, name}, then the file (binbody.rs).
#[tauri::command]
pub(crate) async fn add_file_bytes(state: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<i64, String> {
    let s = sess(state.inner())?;
    let (FileBytesArgs { folder, name }, data) = binbody::request(&request)?;
    let data = zeroize::Zeroizing::new(data.to_vec());
    blocking(move || {
        let id = import::add_bytes(&s, folder, &name, &data)?;
        s.save_soon();
        Ok(id)
    })
    .await
}

// ---- thumbnails (made by the window from decrypted media, in memory) ----------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThumbTask {
    id: i64,
    kind: String,
}

/// Items without a thumbnail, on screen first (reads only those: db.rs "speed indexes").
pub(crate) fn thumbs_needed_sql() -> String {
    format!(
        "SELECT id, kind FROM media WHERE thumb_object_id IS NULL{} ORDER BY {}id LIMIT ?",
        analyse::window_thumbs_sql(),
        focus::order()
    )
}

#[tauri::command]
pub(crate) async fn thumbs_needed(state: State<'_, Shared>, limit: i64) -> Result<Vec<ThumbTask>, String> {
    read_db(state.inner(), move |c| {
        // Pictures the native analysis pass reads are left to it (analyse.rs).
        let mut st = c.prepare_cached(&thumbs_needed_sql()).map_err(|e| e.to_string())?;
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbArgs {
    id: i64,
    #[serde(default)]
    width: Option<i64>,
    #[serde(default)]
    height: Option<i64>,
    #[serde(default)]
    duration_ms: Option<i64>,
    #[serde(default)]
    sharper: Option<bool>,
}

/// A thumbnail made by the window. Raw body: the other arguments, then the
/// picture (binbody.rs), so it isn't sent as a JSON list of numbers.
#[tauri::command]
pub(crate) async fn save_thumb(state: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let s = sess(state.inner())?;
    let (a, data): (ThumbArgs, &[u8]) = binbody::request(&request)?;
    let data = zeroize::Zeroizing::new(data.to_vec());
    blocking(move || store_thumb(&s, a.id, &data, a.width, a.height, a.duration_ms, a.sharper.unwrap_or(false))).await
}

#[derive(serde::Deserialize)]
struct IdArgs {
    id: i64,
}

/// Store a new thumbnail for an item (from the window, or made natively by
/// the analysis pass). `same_picture`: a sharper copy of the same picture,
/// so its look-alike fingerprint stays valid.
pub(crate) fn store_thumb(
    s: &Session,
    id: i64,
    data: &[u8],
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<i64>,
    same_picture: bool,
) -> Result<(), String> {
    {
        // The colour sketch shown while the thumbnail loads (sketch.rs).
        let sketch = sketch::sketch_from_encoded(data).unwrap_or_default();
        let (tid, _) = s.vault().add_object(vault_core::ObjectKind::Thumbnail, data).map_err(|e| e.to_string())?;
        let stored = (|| -> Result<Option<String>, String> {
            let db = s.db();
            let old = db.query_row("SELECT thumb_object_id FROM media WHERE id = ?", [id], |r| r.get(0)).ok().flatten();
            db.execute(
                // Free copies share the stored file, so they share the thumbnail too.
                "UPDATE media SET thumb_object_id = ?1, width = COALESCE(?2, width), height = COALESCE(?3, height), \
                 duration_ms = COALESCE(?4, duration_ms), sketch = ?6 WHERE object_id = (SELECT object_id FROM media WHERE id = ?5)",
                rusqlite::params![tid.to_hex(), width, height, duration_ms, id, sketch],
            )
            .map_err(|e| e.to_string())?;
            // A replaced thumbnail may show something else: analyse it again.
            if !same_picture {
                let _ = similar::reset(&db, id);
            }
            Ok(old)
        })();
        let old = match stored {
            Ok(old) => old,
            Err(err) => {
                // Not recorded: the new file isn't left behind.
                let _ = s.vault().delete_object(vault_core::ObjectKind::Thumbnail, &tid);
                return Err(err);
            }
        };
        s.mark_dirty_bg();
        retire_thumbnail(s, old);
        Ok(())
    }
}

/// A replaced thumbnail, frame strip or tiny clip goes: thumbnail pages
/// holding a copy of it at once (no copy left behind), the file itself once
/// the library no longer pointing at it is saved.
fn retire_thumbnail(s: &Session, old: Option<String>) {
    if let Some(o) = old.filter(|o| !o.is_empty())
        && let Ok(oid) = vault_core::ObjectId::from_hex(&o)
    {
        thumbpages::drop_pages_holding(s, &[oid]);
        s.delete_after_save(vault_core::ObjectKind::Thumbnail, oid);
    }
}

/// Older thumbnails (made smaller, before sharper thumbnails) still to remake:
/// items with a thumbnail and an id in `after < id <= upto`, oldest first.
#[tauri::command]
pub(crate) async fn thumbs_to_sharpen(state: State<'_, Shared>, after: i64, upto: i64, limit: i64) -> Result<Vec<ThumbTask>, String> {
    read_db(state.inner(), move |c| {
        let mut st = c
            .prepare(
                "SELECT id, kind FROM media WHERE id > ?1 AND id <= ?2 AND thumb_object_id IS NOT NULL AND thumb_object_id != '' \
                 AND kind IN ('image', 'gif', 'video') AND (copy_of IS NULL) ORDER BY id LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let v = st
            .query_map([after, upto, limit], |r| Ok(ThumbTask { id: r.get(0)?, kind: r.get(1)? }))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        Ok(v)
    })
    .await
}

/// How many older thumbnails are still to remake.
#[tauri::command]
pub(crate) async fn count_to_sharpen(state: State<'_, Shared>, after: i64, upto: i64) -> Result<i64, String> {
    read_db(state.inner(), move |c| {
        c.query_row(
            "SELECT COUNT(*) FROM media WHERE id > ?1 AND id <= ?2 AND thumb_object_id IS NOT NULL AND thumb_object_id != '' \
             AND kind IN ('image', 'gif', 'video') AND (copy_of IS NULL)",
            [after, upto],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToWebp {
    tasks: Vec<ThumbTask>,
    /// Looked at everything up to this item id.
    next: i64,
}

/// Older JPEG thumbnails to make again as WebP (smaller): items in
/// `after < id <= upto` whose thumbnail is a JPEG (found from its first
/// bytes), oldest first. Looks at no more than a few hundred items per call.
#[tauri::command]
pub(crate) async fn thumbs_to_webp(state: State<'_, Shared>, after: i64, upto: i64, limit: i64) -> Result<ToWebp, String> {
    let s = sess(state.inner())?;
    blocking(move || {
        let rows: Vec<(i64, String, String)> = {
            let db = s.db();
            let mut st = db
                .prepare(
                    "SELECT id, kind, thumb_object_id FROM media WHERE id > ?1 AND id <= ?2 AND thumb_object_id IS NOT NULL AND thumb_object_id != '' \
                     AND kind IN ('image', 'gif', 'video') AND (copy_of IS NULL) ORDER BY id LIMIT 300",
                )
                .map_err(|e| e.to_string())?;
            st.query_map([after, upto], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?
        };
        let mut out = ToWebp { tasks: Vec::new(), next: if rows.is_empty() { upto } else { after } };
        for (id, kind, hex) in rows {
            if out.tasks.len() as i64 >= limit {
                break;
            }
            out.next = id;
            let Ok(oid) = vault_core::ObjectId::from_hex(&hex) else { continue };
            let mut head = [0u8; 3];
            let jpeg = s
                .vault()
                .open_object(vault_core::ObjectKind::Thumbnail, &oid)
                .and_then(|mut r| Ok(std::io::Read::read_exact(&mut r, &mut head)?))
                .is_ok()
                && picture::image_mime(&head) == Some("image/jpeg");
            if jpeg {
                out.tasks.push(ThumbTask { id, kind });
            }
        }
        Ok(out)
    })
    .await
}

/// The newest item id (where remaking older thumbnails stops).
#[tauri::command]
pub(crate) async fn newest_item_id(state: State<'_, Shared>) -> Result<i64, String> {
    read_db(state.inner(), |c| c.query_row("SELECT COALESCE(MAX(id), 0) FROM media", [], |r| r.get(0)).map_err(|e| e.to_string())).await
}

/// The window couldn't decode this file (e.g. an unsupported video codec).
#[tauri::command]
pub(crate) async fn thumb_failed(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db_derived(state.inner(), move |c| {
        c.execute(
            "UPDATE media SET thumb_object_id = '' WHERE id = ? AND thumb_object_id IS NULL",
            [id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

// ---- preview clips (made by the window, or by the video tool) -----------------------------
// Two kinds per video: the frame strip (one picture holding 48 small frames — WebP, older ones JPEG — for
// flip-books and seek-bar previews) and the tiny clip (a silent
// ~240p video of a few seconds that grid tiles play straight away). Both are
// stored encrypted with the thumbnails. NULL = not made yet, '' = couldn't be.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewTask {
    id: i64,
    duration_ms: Option<i64>,
    /// The frame strip is still missing.
    need_strip: bool,
    /// The tiny clip is still missing.
    need_tiny: bool,
}

const PREVIEW_TASK_COLS: &str = "id, duration_ms, preview_object_id IS NULL, tiny_object_id IS NULL";
const PREVIEW_TASK_WHERE: &str = "kind = 'video' AND (preview_object_id IS NULL OR tiny_object_id IS NULL) \
     AND deleted_at IS NULL AND thumb_object_id IS NOT NULL AND thumb_object_id <> ''";

fn preview_task(r: &rusqlite::Row) -> rusqlite::Result<PreviewTask> {
    Ok(PreviewTask { id: r.get(0)?, duration_ms: r.get(1)?, need_strip: r.get(2)?, need_tiny: r.get(3)? })
}

/// Videos still missing a frame strip or a tiny clip; `prefer` (those on screen) first.
#[tauri::command]
pub(crate) async fn previews_needed(state: State<'_, Shared>, limit: i64, prefer: Vec<i64>) -> Result<Vec<PreviewTask>, String> {
    read_db(state.inner(), move |c| {
        let e = |x: rusqlite::Error| x.to_string();
        let mut out: Vec<PreviewTask> = Vec::new();
        for id in prefer.iter().take(64) {
            if let Ok(t) = c.query_row(
                &format!("SELECT {PREVIEW_TASK_COLS} FROM media WHERE id = ? AND {PREVIEW_TASK_WHERE}"),
                [id],
                preview_task,
            ) {
                out.push(t);
            }
            if out.len() as i64 >= limit {
                return Ok(out);
            }
        }
        let mut st = c
            .prepare(&format!("SELECT {PREVIEW_TASK_COLS} FROM media WHERE {PREVIEW_TASK_WHERE} ORDER BY id DESC LIMIT ?"))
            .map_err(e)?;
        for t in st.query_map([limit], preview_task).map_err(e)?.flatten() {
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

/// Store a preview object for an item (and its free copies), replacing the old one.
fn store_preview_object(s: &Session, id: i64, column: &str, data: &[u8]) -> Result<(), String> {
    let (pid, _) = s.vault().add_object(vault_core::ObjectKind::Thumbnail, data).map_err(|e| e.to_string())?;
    let stored = (|| -> Result<Option<String>, String> {
        let db = s.db();
        let old = db.query_row(&format!("SELECT {column} FROM media WHERE id = ?"), [id], |r| r.get(0)).ok().flatten();
        db.execute(
            &format!("UPDATE media SET {column} = ?1 WHERE object_id = (SELECT object_id FROM media WHERE id = ?2)"),
            rusqlite::params![pid.to_hex(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(old)
    })();
    let old = match stored {
        Ok(old) => old,
        Err(err) => {
            let _ = s.vault().delete_object(vault_core::ObjectKind::Thumbnail, &pid);
            return Err(err);
        }
    };
    s.mark_dirty_bg();
    retire_thumbnail(s, old);
    Ok(())
}

/// Raw body: {id}, then the frame strip (binbody.rs).
#[tauri::command]
pub(crate) async fn save_preview(state: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let s = sess(state.inner())?;
    let (IdArgs { id }, data) = binbody::request(&request)?;
    let data = zeroize::Zeroizing::new(data.to_vec());
    blocking(move || {
        let strip = picture::strip_as_webp(&data);
        store_preview_object(&s, id, "preview_object_id", strip.as_deref().map_or(&data[..], |v| &v[..]))
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_failed(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db_derived(state.inner(), move |c| {
        c.execute("UPDATE media SET preview_object_id = '' WHERE id = ? AND preview_object_id IS NULL", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

/// A tiny clip made by the window (WebM or MP4 bytes). Raw body: {id}, then
/// the clip (binbody.rs).
#[tauri::command]
pub(crate) async fn save_tiny(state: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let (IdArgs { id }, data) = binbody::request(&request)?;
    if protocol::tiny_mime(data).is_none() {
        return Err("That isn't a WebM or MP4 video.".into());
    }
    let data = zeroize::Zeroizing::new(data.to_vec());
    let s = sess(state.inner())?;
    blocking(move || store_preview_object(&s, id, "tiny_object_id", &data)).await
}

#[tauri::command]
pub(crate) async fn tiny_failed(state: State<'_, Shared>, id: i64) -> Result<(), String> {
    edit_db_derived(state.inner(), move |c| {
        c.execute("UPDATE media SET tiny_object_id = '' WHERE id = ? AND tiny_object_id IS NULL", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

/// Make the tiny clip with the video tool (when it is installed): pieces of
/// `piece` seconds starting at `starts`. Ok(false) = no video tool here (the
/// window makes it instead). Nothing touches the disk (videotool.rs).
#[tauri::command]
pub(crate) async fn make_tiny_with_tool(state: State<'_, Shared>, id: i64, starts: Vec<f64>, piece: f64) -> Result<bool, String> {
    let Some(tool) = videotool::tool_path() else {
        return Ok(false);
    };
    let s = sess(state.inner())?;
    blocking(move || {
        let bytes = videotool::make_tiny(&s, &tool, id, &starts, piece)?;
        store_preview_object(&s, id, "tiny_object_id", &bytes)?;
        Ok(true)
    })
    .await
}

// ---- import ------------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn inspect_drop(paths: Vec<String>) -> Result<import::DropSummary, String> {
    blocking(move || Ok(import::inspect(&paths))).await
}

#[tauri::command]
pub(crate) async fn check_archive_password(path: String, password: String) -> Result<(), String> {
    blocking(move || import::check_password(&path, &password)).await
}

#[tauri::command]
pub(crate) fn start_import(
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
    inner.imports.lock().unwrap_or_else(|e| e.into_inner()).insert(id, cancel.clone());
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
            // import.rs already sends at most about ten a second.
            let _ = app.emit("import-progress", p);
        });
        inner.imports.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        let _ = app.emit("import-done", &report);
    });
    Ok(id)
}

#[tauri::command]
pub(crate) fn cancel_import(state: State<'_, Shared>, job: u64) {
    if let Some(c) = state.imports.lock().unwrap_or_else(|e| e.into_inner()).get(&job) {
        c.store(true, Ordering::SeqCst);
    }
}

// ---- playing files outside the vault ------------------------------------------------------

#[tauri::command]
pub(crate) async fn scan_local(
    state: State<'_, Shared>,
    paths: Vec<String>,
) -> Result<protocol::LocalSet, String> {
    let inner = state.inner().clone();
    blocking(move || protocol::scan_local(&inner.local, &paths)).await
}

// ---- export ------------------------------------------------------------------------------

/// Write items out as ordinary (unencrypted) files. "export-progress", then "export-done".
#[tauri::command]
pub(crate) fn export_start(app: AppHandle, state: State<'_, Shared>, mut request: exporter::ExportRequest) -> Result<(), String> {
    let s = sess(&state)?;
    request.strip = state.config.lock().unwrap_or_else(|e| e.into_inner()).strip_metadata;
    let inner = state.inner().clone();
    let cancel = begin_task(&inner, "export")?;
    std::thread::spawn(move || {
        let mut t = throttle::Throttle::new();
        let done = exporter::run(&s, &request, &cancel, &mut |p| {
            if t.ready(p.done == p.total) {
                let _ = app.emit("export-progress", p);
            }
        });
        inner.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove("export");
        let _ = app.emit("export-done", done);
    });
    Ok(())
}

// ---- share as encrypted .7z --------------------------------------------------------

/// Put items and folders into a password-protected .7z. "share-progress"
/// (same shape as export progress), then "share-done". Cancel with task "share".
#[tauri::command]
pub(crate) fn share_7z_start(app: AppHandle, state: State<'_, Shared>, mut request: share7z::ShareRequest) -> Result<(), String> {
    let s = sess(&state)?;
    request.strip = state.config.lock().unwrap_or_else(|e| e.into_inner()).strip_metadata;
    let inner = state.inner().clone();
    let cancel = begin_task(&inner, "share")?;
    std::thread::spawn(move || {
        let mut t = throttle::Throttle::new();
        let done = share7z::run(&s, &request, &cancel, &mut |p| {
            if t.ready(p.done == p.total) {
                let _ = app.emit("share-progress", p);
            }
        });
        inner.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove("share");
        let _ = app.emit("share-done", done);
    });
    Ok(())
}

// ---- video tool (ffmpeg): convert, animation from pictures ---------------------------

#[tauri::command]
pub(crate) async fn video_tool_info() -> Result<videotool::ToolInfo, String> {
    blocking(|| Ok(videotool::info())).await
}

/// Run a video-tool job in the background: "<task>-progress", then "<task>-done".
fn video_task<D: Serialize + Clone + 'static>(
    app: AppHandle,
    state: State<'_, Shared>,
    task: &'static str,
    job: impl FnOnce(&Arc<Session>, &std::path::Path, &AtomicBool, &mut dyn FnMut(&videotool::ToolProgress)) -> D + Send + 'static,
) -> Result<(), String> {
    let tool = videotool::tool_path()
        .ok_or("The video tool isn't here. It comes with the full Media Vault package (tools\\ffmpeg.exe next to the app).")?;
    let s = sess(&state)?;
    let inner = state.inner().clone();
    let cancel = begin_task(&inner, task)?;
    std::thread::spawn(move || {
        let mut t = throttle::Throttle::new();
        let done = job(&s, &tool, &cancel, &mut |p| {
            if t.ready(p.done == p.total) {
                let _ = app.emit(&format!("{task}-progress"), p);
            }
        });
        inner.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove(task);
        let _ = app.emit(&format!("{task}-done"), done);
    });
    Ok(())
}

/// Convert items into new items. "convert-progress", then "convert-done".
#[tauri::command]
pub(crate) fn convert_start(app: AppHandle, state: State<'_, Shared>, request: videotool::ConvertRequest) -> Result<(), String> {
    video_task(app, state, "convert", move |s, tool, cancel, progress| {
        videotool::run_convert(s, tool, &request, cancel, progress)
    })
}

/// Make a GIF or MP4 from pictures. "animation-progress", then "animation-done".
#[tauri::command]
pub(crate) fn animation_start(app: AppHandle, state: State<'_, Shared>, request: videotool::AnimationRequest) -> Result<(), String> {
    video_task(app, state, "animation", move |s, tool, cancel, progress| {
        videotool::run_animation(s, tool, &request, cancel, progress)
    })
}

/// Save part of a video as a new MP4 (with its sound) next to it. "cut-progress", then "cut-done".
#[tauri::command]
pub(crate) fn cut_start(app: AppHandle, state: State<'_, Shared>, request: videotool::CutRequest) -> Result<(), String> {
    video_task(app, state, "cut", move |s, tool, cancel, progress| videotool::run_cut(s, tool, &request, cancel, progress))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyBytesArgs {
    from: i64,
    name: String,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedCopy {
    id: i64,
    /// An identical item was already there and is used instead (nothing new to undo).
    reused: bool,
}

/// Save a new picture made from item `from` in the window (the picture editor's
/// "Save as copy") next to it, with its date taken and tags. The original is
/// never changed. Raw body: {from, name, width, height}, then the file (binbody.rs).
#[tauri::command]
pub(crate) async fn add_copy_bytes(state: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<SavedCopy, String> {
    let s = sess(state.inner())?;
    let (CopyBytesArgs { from, name, width, height }, data) = binbody::request(&request)?;
    let data = zeroize::Zeroizing::new(data.to_vec());
    blocking(move || {
        let size = width.zip(height).filter(|(w, h)| *w > 0 && *h > 0);
        let (id, reused) = videotool::save_copy(&s, from, &name, &data, size)?;
        s.save_soon();
        Ok(SavedCopy { id, reused })
    })
    .await
}

// ---- saving a rotation from the viewer (rotate.rs) ------------------------------------

/// A JPEG: losslessly, by its EXIF orientation.
#[tauri::command]
pub(crate) async fn rotate_picture(state: State<'_, Shared>, item: i64, quarter: u8) -> Result<rotate::Turned, String> {
    let s = sess(state.inner())?;
    blocking(move || rotate::turn_jpeg_item(&s, item, quarter)).await
}

/// PNG, WebP, GIF: the window sends the turned file (length, JSON, bytes).
#[tauri::command]
pub(crate) async fn rotate_replace(state: State<'_, Shared>, request: tauri::ipc::Request<'_>) -> Result<rotate::Turned, String> {
    let s = sess(state.inner())?;
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The rotated picture didn't arrive.".into());
    };
    let (req, bytes) = rotate::split_body(body)?;
    let bytes = zeroize::Zeroizing::new(bytes.to_vec());
    blocking(move || {
        if !matches!(rotate::item_ext(&s, req.item_id)?.as_str(), "png" | "webp" | "gif") {
            return Err("Only PNG, WebP and GIF pictures are saved this way.".into());
        }
        rotate::replace(&s, req.item_id, &bytes, req.quarter, req.lossless)
    })
    .await
}

/// A video: only its rotation changes (needs the video tool).
#[tauri::command]
pub(crate) async fn rotate_video(state: State<'_, Shared>, item: i64, quarter: u8) -> Result<rotate::Turned, String> {
    let tool = videotool::tool_path().ok_or(
        "Saving a video's rotation needs the video tool, which isn't installed. It comes with the full Media Vault package (tools\\ffmpeg.exe next to the app).",
    )?;
    let s = sess(state.inner())?;
    blocking(move || videotool::rotate_video(&s, &tool, item, quarter)).await
}

/// Ctrl+Z: the file from before the rotation comes back.
#[tauri::command]
pub(crate) async fn rotate_undo(state: State<'_, Shared>, turned: rotate::Turned) -> Result<(), String> {
    let s = sess(state.inner())?;
    blocking(move || rotate::undo(&s, &turned)).await
}

// ---- background jobs ------------------------------------------------------------------

/// Thumbnails and preview clips still to make (for the background-jobs ring).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundLeft {
    thumbs: i64,
    previews: i64,
}

#[tauri::command]
pub(crate) async fn background_left(state: State<'_, Shared>) -> Result<BackgroundLeft, String> {
    read_db(state.inner(), |c| {
        let one = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string());
        Ok(BackgroundLeft {
            // The window's share (the native analysis pass counts its own).
            thumbs: one(&format!("SELECT COUNT(*) FROM media WHERE thumb_object_id IS NULL{}", analyse::window_thumbs_sql()))?,
            previews: one(&format!("SELECT COUNT(*) FROM media WHERE {PREVIEW_TASK_WHERE}"))?,
        })
    })
    .await
}

#[cfg(test)]
mod store_tests {
    use super::*;
    use crate::session;
    use vault_core::{KdfParams, ObjectId, ObjectKind};

    fn vault(t: &std::path::Path) -> Session {
        session::create(t.to_str().unwrap(), "V", "long enough pw", KdfParams::TEST_ONLY).unwrap().0
    }

    fn thumb_of(s: &Session, id: i64) -> ObjectId {
        let hex: String = s.db().query_row("SELECT thumb_object_id FROM media WHERE id = ?", [id], |r| r.get(0)).unwrap();
        ObjectId::from_hex(&hex).unwrap()
    }

    #[test]
    fn a_replaced_thumbnail_goes_after_the_save() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let id = import::add_bytes(&s, None, "a.png", &[0x89, b'P', b'N', b'G', 1, 2, 3]).unwrap();
        store_thumb(&s, id, b"first thumbnail", None, None, None, false).unwrap();
        let first = thumb_of(&s, id);
        store_thumb(&s, id, b"second thumbnail", None, None, None, false).unwrap();
        assert_ne!(thumb_of(&s, id), first);
        // Still there until the library that no longer points at it is saved.
        let stored = |o: &ObjectId| s.vault().list_objects(ObjectKind::Thumbnail).unwrap().contains(o);
        assert!(stored(&first));
        s.save().unwrap();
        assert!(!stored(&first));
        assert!(stored(&thumb_of(&s, id)));
    }

    #[test]
    fn files_not_recorded_are_not_left_behind() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let id = import::add_bytes(&s, None, "a.png", &[0x89, b'P', b'N', b'G', 1, 2, 3]).unwrap();
        let count = |k: ObjectKind| s.vault().list_objects(k).unwrap().len();
        let (media, thumbs) = (count(ObjectKind::Media), count(ObjectKind::Thumbnail));
        // The library refuses the change (as a full or damaged library would).
        s.db()
            .execute_batch(
                "CREATE TEMP TRIGGER no_insert BEFORE INSERT ON main.media BEGIN SELECT RAISE(ABORT, 'refused'); END; \
                 CREATE TEMP TRIGGER no_update BEFORE UPDATE ON main.media BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();
        assert!(import::add_bytes(&s, None, "b.png", &[0x89, b'P', b'N', b'G', 9, 9]).is_err());
        assert!(store_thumb(&s, id, b"a thumbnail", None, None, None, false).is_err());
        assert!(store_preview_object(&s, id, "tiny_object_id", b"a clip").is_err());
        assert_eq!((count(ObjectKind::Media), count(ObjectKind::Thumbnail)), (media, thumbs));
    }
}
