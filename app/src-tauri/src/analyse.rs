//! The native analysis pass: "decode once, use it for everything".
//!
//! Each picture the app can read itself (JPEG, PNG, WebP, GIF: picture.rs)
//! is decrypted and decoded once, in memory, and from those pixels come its
//! thumbnail and its faces (faceid.rs, with the faces pack). The look-alike
//! fingerprint of every item (videos too) is made from its stored
//! thumbnail, as the window made it. Nothing decrypted is ever written anywhere.
//!
//! It runs in the background while a vault is open (started by the window),
//! on low-priority threads (all cores but one), and can be stopped at any
//! time. Each step keeps its own state in the library (thumb_object_id,
//! phash_state, faces_state), so a step that fails is retried or
//! marked exactly as before. What it can't do (videos, other picture
//! formats, a missing faces pack) the window's loops still do; while this runs
//! they leave the rest to it (`window_*` below), so nothing is done twice.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use vault_core::{ObjectId, ObjectKind};
use zeroize::Zeroizing;

use crate::library::R;
use crate::picture;
use crate::session::Session;
use crate::{faceid, faces, similar};

/// Items looked at per round.
const ROUND: i64 = 16;
const KINDS: &str = "('image', 'gif', 'video')";

use crate::util::sql_err as e;

// ---- what runs ----------------------------------------------------------------------------

/// What the window asked for.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// People → "Pause scanning".
    #[serde(default)]
    pub faces_paused: bool,
}

struct Runner {
    session: Arc<Session>,
    stop: Arc<AtomicBool>,
}

static RUNNER: Mutex<Option<Runner>> = Mutex::new(None);
static OPTIONS: Mutex<Options> = Mutex::new(Options { faces_paused: false });
static WAKE: crate::util::Wake = crate::util::Wake::new();
/// Pictures this pass couldn't decode (left to the window until the app restarts).
static NOT_HERE: Mutex<BTreeSet<i64>> = Mutex::new(BTreeSet::new());
static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct Counts {
    items: AtomicU64,
    thumbs: AtomicU64,
    prints: AtomicU64,
    faces: AtomicU64,
}
static DONE: Counts = Counts {
    items: AtomicU64::new(0),
    thumbs: AtomicU64::new(0),
    prints: AtomicU64::new(0),
    faces: AtomicU64::new(0),
};

fn running() -> bool {
    RUNNER.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|r| !r.stop.load(Ordering::SeqCst) && !r.session.is_closed())
}

/// Which steps can be done here right now.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Caps {
    pub faces: bool,
}

fn caps() -> Caps {
    let o = *OPTIONS.lock().unwrap_or_else(|e| e.into_inner());
    Caps { faces: !o.faces_paused && faceid::info().available }
}

/// `here_sql` as last made (made again only when NOT_HERE changes, so the
/// queries using it keep the same text and stay prepared).
static HERE_SQL: Mutex<Option<String>> = Mutex::new(None);

/// SQL: a picture this pass decodes itself.
fn here_sql() -> String {
    let mut kept = HERE_SQL.lock().unwrap_or_else(|x| x.into_inner());
    if let Some(s) = kept.as_ref() {
        return s.clone();
    }
    let exts = picture::NATIVE_EXTS.iter().map(|x| format!("'{x}'")).collect::<Vec<_>>().join(", ");
    let not: Vec<i64> = NOT_HERE.lock().unwrap_or_else(|x| x.into_inner()).iter().copied().collect();
    let skip = if not.is_empty() { String::new() } else { format!(" AND id NOT IN ({})", crate::util::id_list(&not)) };
    let sql = format!("(kind IN ('image', 'gif') AND lower(IFNULL(ext, '')) IN ({exts}){skip})");
    *kept = Some(sql.clone());
    sql
}

/// Everything that couldn't be decoded is tried here again (another vault, or locked).
fn forget_not_here() {
    NOT_HERE.lock().unwrap_or_else(|x| x.into_inner()).clear();
    *HERE_SQL.lock().unwrap_or_else(|x| x.into_inner()) = None;
}

// ---- what the window's loops leave to this pass ----------------------------------------------

/// Thumbnails: extra SQL for `thumbs_needed` (" AND NOT (…)" while this runs).
pub fn window_thumbs_sql() -> String {
    if running() { format!(" AND NOT {}", here_sql()) } else { String::new() }
}

/// Fingerprints are all made here while this runs.
pub fn window_skips_prints() -> bool {
    running()
}

/// The window's part of the face scan queue (" AND NOT (…)" while this runs with the faces pack).
fn window_faces_sql() -> String {
    if running() && faceid::info().available { format!(" AND NOT {}", here_sql()) } else { String::new() }
}

/// How many items the window still has to scan for faces (its scan job's "left").
pub fn window_faces_left(conn: &Connection) -> R<i64> {
    conn.prepare_cached(&format!(
        "SELECT COUNT(*) FROM media WHERE faces_state = 2 AND deleted_at IS NULL{}{}",
        faces::off_sql(),
        window_faces_sql()
    ))
    .map_err(e)?
    .query_row([], |r| r.get(0))
    .map_err(e)
}

/// Faces still for the window (videos, pictures only it can read).
pub fn window_faces(conn: &Connection, limit: i64) -> R<Vec<faces::ScanTask>> {
    if !(running() && faceid::info().available) {
        return faces::needed(conn, limit);
    }
    conn.prepare_cached(&format!(
        "SELECT id, kind, duration_ms FROM media WHERE faces_state = 2 AND deleted_at IS NULL{}{} ORDER BY {}id LIMIT ?",
        faces::off_sql(),
        window_faces_sql(),
        crate::focus::order()
    ))
    .map_err(e)?
    .query_map([limit], |r| Ok(faces::ScanTask { id: r.get(0)?, kind: r.get(1)?, duration_ms: r.get(2)? }))
    .map_err(e)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(e)
}

// ---- choosing the work ----------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Task {
    id: i64,
    object: String,
    thumb: Option<String>,
    make_thumb: bool,
    print: bool,
    faces: bool,
}

/// The ids with something to do here: one part per step, each reading only
/// the items waiting for that step (the partial indexes in db.rs, "speed
/// indexes"), instead of one big OR that has to look at every item.
/// ?1 = faces on.
fn todo_sql(here: &str) -> String {
    let off = faces::off_sql();
    format!(
        "SELECT id AS qid FROM media WHERE thumb_object_id IS NULL AND {here} \
         UNION SELECT id FROM media WHERE phash_state = 0 AND IFNULL(thumb_object_id, '') <> '' AND deleted_at IS NULL AND kind IN {KINDS} \
         UNION SELECT id FROM media WHERE ?1 AND faces_state = 2 AND deleted_at IS NULL AND {here}{off}"
    )
}

fn select_sql(only: Option<&[i64]>) -> String {
    let here = here_sql();
    let off = faces::off_sql();
    let ids = only.map(|ids| format!(" WHERE m.id IN ({})", crate::util::id_list(ids))).unwrap_or_default();
    // The waiting ids first (CROSS JOIN keeps them first), then their rows.
    format!(
        "SELECT m.id, m.object_id, m.thumb_object_id, \
           (m.thumb_object_id IS NULL AND {here}), \
           (m.phash_state = 0 AND m.deleted_at IS NULL AND m.kind IN {KINDS}), \
           (?1 AND m.faces_state = 2 AND m.deleted_at IS NULL AND {here}{off}) \
         FROM ({}) AS q CROSS JOIN media AS m ON m.id = q.qid{ids} ORDER BY {}m.id DESC LIMIT ?2",
        todo_sql(&here),
        crate::focus::order()
    )
}

fn select(conn: &Connection, caps: Caps, limit: i64, only: Option<&[i64]>) -> R<Vec<Task>> {
    // The text only changes with what is on screen, so the prepared query is kept.
    conn.prepare_cached(&select_sql(only))
        .map_err(e)?
        .query_map(params![caps.faces, limit], |r| {
            Ok(Task {
                id: r.get(0)?,
                object: r.get(1)?,
                thumb: r.get(2)?,
                make_thumb: r.get(3)?,
                print: r.get(4)?,
                faces: r.get(5)?,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)
}

/// How many items still have something to be done here.
fn left(conn: &Connection, caps: Caps) -> R<i64> {
    conn.prepare_cached(&format!("SELECT COUNT(*) FROM ({})", todo_sql(&here_sql())))
        .map_err(e)?
        .query_row(params![caps.faces], |r| r.get(0))
        .map_err(e)
}

// ---- one item ---------------------------------------------------------------------------------

fn read(s: &Session, kind: ObjectKind, hex: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let id = ObjectId::from_hex(hex).map_err(|e| e.to_string())?;
    s.vault().read_object(kind, &id).map_err(|e| e.to_string())
}

/// What happened, for the self-test.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemReport {
    pub id: i64,
    pub thumb: bool,
    pub print: Option<String>,
    pub faces: Option<usize>,
    pub left_to_window: bool,
    pub ms: u64,
}

fn not_here(id: i64) {
    if NOT_HERE.lock().unwrap_or_else(|x| x.into_inner()).insert(id) {
        *HERE_SQL.lock().unwrap_or_else(|x| x.into_inner()) = None;
    }
}

/// Everything for one item.
fn work(s: &Session, t: &Task, caps: Caps, emit: &dyn Fn(i64)) -> ItemReport {
    let start = Instant::now();
    let mut rep = ItemReport { id: t.id, ..Default::default() };
    let mut thumb_bytes: Option<Zeroizing<Vec<u8>>> = None;
    let mut thumb_id = t.thumb.clone();
    let mut print = t.print;
    if t.make_thumb || (t.faces && caps.faces) {
        match read(s, ObjectKind::Media, &t.object).and_then(|b| picture::decode(&b)) {
            Err(_) => {
                not_here(t.id);
                rep.left_to_window = true;
            }
            Ok(pic) => {
                if t.make_thumb {
                    match picture::thumbnail(&pic) {
                        Ok((_, webp)) => match crate::cmd_media::store_thumb(s, t.id, &webp, Some(pic.w as i64), Some(pic.h as i64), None, false) {
                            Ok(()) => {
                                DONE.thumbs.fetch_add(1, Ordering::Relaxed);
                                rep.thumb = true;
                                emit(t.id);
                                thumb_bytes = Some(webp);
                                thumb_id = Some("new".into());
                                // A new thumbnail: its fingerprint is made again.
                                let db = s.db();
                                if let Ok(p) = db.query_row(
                                    &format!("SELECT phash_state = 0 AND deleted_at IS NULL AND kind IN {KINDS} FROM media WHERE id = ?"),
                                    [t.id],
                                    |r| r.get::<_, bool>(0),
                                ) {
                                    print = p;
                                }
                            }
                            Err(_) => {
                                not_here(t.id);
                                rep.left_to_window = true;
                            }
                        },
                        Err(_) => {
                            not_here(t.id);
                            rep.left_to_window = true;
                        }
                    }
                }
                if t.faces && caps.faces {
                    let (rgba, w, h) = picture::faces_input(&pic);
                    drop(pic);
                    match faceid::faces_in(&rgba, w, h, 0) {
                        Ok(found) => {
                            let n = faces::save(&s.db(), t.id, &found, faces::ARCFACE).unwrap_or(0);
                            s.mark_dirty_bg();
                            DONE.faces.fetch_add(1, Ordering::Relaxed);
                            rep.faces = Some(n);
                        }
                        // The model itself failing: left as it is (scanned when it works again).
                        Err(_) if !faceid::info().available => {}
                        Err(_) => {
                            let _ = faces::failed(&s.db(), t.id, faces::ARCFACE);
                            s.mark_dirty_bg();
                        }
                    }
                }
            }
        }
    }
    if print {
        let thumb = match (&thumb_bytes, thumb_id.as_deref()) {
            (Some(j), _) => picture::decode(j),
            (None, Some(hex)) if !hex.is_empty() => read(s, ObjectKind::Thumbnail, hex).and_then(|b| picture::decode(&b)),
            _ => Err("no thumbnail".into()),
        };
        match thumb {
            Ok(th) => {
                let (hash, sharp) = picture::fingerprint(&th);
                let _ = similar::save(&s.db(), t.id, &hash, sharp);
                s.mark_dirty_bg();
                DONE.prints.fetch_add(1, Ordering::Relaxed);
                rep.print = Some(hash);
            }
            Err(_) => {
                // An empty thumbnail (the window couldn't make one) isn't fingerprinted at all.
                if thumb_id.as_deref().is_some_and(|h| !h.is_empty()) {
                    let _ = similar::failed(&s.db(), t.id);
                    s.mark_dirty_bg();
                }
            }
        }
    }
    DONE.items.fetch_add(1, Ordering::Relaxed);
    rep.ms = start.elapsed().as_millis() as u64;
    rep
}

/// Background threads are polite: lower priority (and on Windows lower disk priority too).
pub(crate) fn polite_thread() {
    #[cfg(windows)]
    // SAFETY: only changes the calling thread's own scheduling priority.
    unsafe {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
        SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}

fn workers() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).saturating_sub(1).clamp(1, 6)
}

/// One round: the tasks on all cores but one.
fn process(s: &Session, tasks: &[Task], caps: Caps, stop: &AtomicBool, emit: &(dyn Fn(i64) + Sync)) -> Vec<ItemReport> {
    let next = AtomicUsize::new(0);
    let reports: Mutex<Vec<ItemReport>> = Mutex::new(Vec::new());
    std::thread::scope(|sc| {
        for _ in 0..workers().min(tasks.len()) {
            sc.spawn(|| {
                polite_thread();
                loop {
                    // While you are using the window, wait between items (userbusy.rs).
                    crate::userbusy::give_way(&|| stop.load(Ordering::SeqCst) || s.is_closed());
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= tasks.len() || stop.load(Ordering::SeqCst) || s.is_closed() {
                        break;
                    }
                    let rep = work(s, &tasks[i], caps, emit);
                    reports.lock().unwrap_or_else(|e| e.into_inner()).push(rep);
                }
            });
        }
    });
    reports.into_inner().unwrap_or_else(|e| e.into_inner())
}

fn sleep_until_woken(ms: u64) {
    WAKE.sleep(ms);
}

fn run_loop(app: AppHandle, s: Arc<Session>, stop: Arc<AtomicBool>) {
    polite_thread();
    // New thumbnails go to the window in batches, at most about ten times a second.
    let pending: Mutex<(Vec<i64>, crate::throttle::Throttle)> = Mutex::new((Vec::new(), crate::throttle::Throttle::new()));
    let send = |force: bool| {
        let mut p = pending.lock().unwrap_or_else(|x| x.into_inner());
        if !p.0.is_empty() && p.1.ready(force) {
            let ids = std::mem::take(&mut p.0);
            let _ = app.emit("analyse-thumb", ids);
        }
    };
    let emit = |id: i64| {
        pending.lock().unwrap_or_else(|x| x.into_inner()).0.push(id);
        send(false);
    };
    let mut last_naming = Instant::now();
    let mut named = false;
    // How far it got, after every round (and when it runs out of work), so the
    // window needn't keep asking. `fresh`: count what is left again.
    let tell = |fresh: bool, nothing_left: bool| {
        if nothing_left {
            let _ = note_count(&s, caps(), true);
        }
        if let Ok(st) = status(&s, fresh && !nothing_left) {
            let _ = app.emit("analyse-status", st);
        }
    };
    let mut idle = true;
    while !stop.load(Ordering::SeqCst) && !s.is_closed() {
        let c = caps();
        let tasks = select(&s.db(), c, ROUND, None).unwrap_or_default();
        // Poor faces: faces found before they were measured, a few pictures
        // at a time when there's nothing else to do (names are kept).
        if tasks.is_empty() && c.faces && crate::poorfaces::measure_round(&s, &here_sql()) > 0 {
            named = true; // auto-names of faces now known to be poor are taken back
            continue;
        }
        if tasks.is_empty() {
            BUSY.store(false, Ordering::SeqCst);
            if !idle {
                idle = true;
                tell(false, true);
            }
            if named {
                named = false;
                if faces::refresh(&*s).unwrap_or(0) > 0 {
                    s.mark_dirty_bg();
                }
            }
            sleep_until_woken(5000);
            continue;
        }
        BUSY.store(true, Ordering::SeqCst);
        // New work after a rest (an import): count what is left again.
        let woke = std::mem::replace(&mut idle, false);
        let reports = process(&s, &tasks, c, &stop, &emit);
        send(true);
        tell(woke, false);
        if reports.iter().any(|r| r.faces.is_some_and(|n| n > 0)) {
            named = true;
        }
        // Name sure faces now and then while scanning (and at the end).
        if named && last_naming.elapsed() > Duration::from_secs(20) {
            last_naming = Instant::now();
            named = false;
            if faces::refresh(&*s).unwrap_or(0) > 0 {
                s.mark_dirty_bg();
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    BUSY.store(false, Ordering::SeqCst);
}

/// Stop the pass (the vault locked): it ends after the item it is on.
pub fn stop() {
    if let Some(r) = RUNNER.lock().unwrap_or_else(|e| e.into_inner()).take() {
        r.stop.store(true, Ordering::SeqCst);
    }
    forget_not_here();
    *COUNTED.lock().unwrap_or_else(|x| x.into_inner()) = None;
    kick();
}

pub fn kick() {
    WAKE.wake();
}

/// Start the pass for this session (or just take the new options).
pub fn start(app: AppHandle, s: Arc<Session>, opts: Options) {
    *OPTIONS.lock().unwrap_or_else(|e| e.into_inner()) = opts;
    let mut r = RUNNER.lock().unwrap_or_else(|e| e.into_inner());
    let same = r.as_ref().is_some_and(|r| Arc::ptr_eq(&r.session, &s) && !r.stop.load(Ordering::SeqCst));
    if !same {
        if let Some(old) = r.take() {
            old.stop.store(true, Ordering::SeqCst);
        }
        // Another vault: what couldn't be decoded there means nothing here.
        forget_not_here();
        *COUNTED.lock().unwrap_or_else(|x| x.into_inner()) = None;
        let stop = Arc::new(AtomicBool::new(false));
        *r = Some(Runner { session: s.clone(), stop: stop.clone() });
        for c in [&DONE.items, &DONE.thumbs, &DONE.prints, &DONE.faces] {
            c.store(0, Ordering::SeqCst);
        }
        let _ = std::thread::Builder::new().name("analyse".into()).spawn(move || run_loop(app, s, stop));
    }
    drop(r);
    kick();
}

// ---- commands -------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyseStatus {
    pub running: bool,
    /// Working right now (not waiting for new items).
    pub busy: bool,
    /// Items done since the pass started, and per step.
    pub done: u64,
    pub thumbs: u64,
    pub prints: u64,
    pub faces: u64,
    /// Items still with something to do here.
    pub left: i64,
    /// Faces are part of what is left.
    pub faces_left: i64,
}

/// What is left, as last counted: counting holds the library, so it is
/// done at most every `RECOUNT` (or when asked for a fresh count) and in
/// between worked out from the items done since.
struct Counted {
    at: Instant,
    caps: Caps,
    done: u64,
    faces_done: u64,
    left: i64,
    faces_left: i64,
}
static COUNTED: Mutex<Option<Counted>> = Mutex::new(None);
const RECOUNT: Duration = Duration::from_secs(30);

fn count_left(s: &Session, c: Caps) -> R<(i64, i64)> {
    let db = s.db();
    let left = left(&db, c)?;
    let faces_left = if c.faces {
        db.prepare_cached(&format!("SELECT COUNT(*) FROM media WHERE faces_state = 2 AND deleted_at IS NULL{} AND {}", faces::off_sql(), here_sql()))
            .map_err(e)?
            .query_row([], |r| r.get(0))
            .map_err(e)?
    } else {
        0
    };
    Ok((left, faces_left))
}

/// Remember a count (`nothing_left`: the pass just found nothing to do, so nothing is counted).
fn note_count(s: &Session, c: Caps, nothing_left: bool) -> R<(i64, i64)> {
    let (left, faces_left) = if nothing_left { (0, 0) } else { count_left(s, c)? };
    *COUNTED.lock().unwrap_or_else(|x| x.into_inner()) = Some(Counted {
        at: Instant::now(),
        caps: c,
        done: DONE.items.load(Ordering::Relaxed),
        faces_done: DONE.faces.load(Ordering::Relaxed),
        left,
        faces_left,
    });
    Ok((left, faces_left))
}

/// `fresh`: count now (otherwise the last count, less what was done since,
/// unless it is older than `RECOUNT`).
fn status(s: &Session, fresh: bool) -> R<AnalyseStatus> {
    let c = caps();
    let (left, faces_left) = if !running() {
        (0, 0)
    } else {
        let kept = COUNTED.lock().unwrap_or_else(|x| x.into_inner()).as_ref().and_then(|k| {
            (!fresh && k.caps == c && k.at.elapsed() < RECOUNT).then(|| {
                let done = DONE.items.load(Ordering::Relaxed).saturating_sub(k.done) as i64;
                let faces = DONE.faces.load(Ordering::Relaxed).saturating_sub(k.faces_done) as i64;
                ((k.left - done).max(0), (k.faces_left - faces).max(0))
            })
        });
        match kept {
            Some(k) => k,
            None => note_count(s, c, false)?,
        }
    };
    Ok(AnalyseStatus {
        running: running(),
        busy: BUSY.load(Ordering::SeqCst),
        done: DONE.items.load(Ordering::Relaxed),
        thumbs: DONE.thumbs.load(Ordering::Relaxed),
        prints: DONE.prints.load(Ordering::Relaxed),
        faces: DONE.faces.load(Ordering::Relaxed),
        left,
        faces_left,
    })
}

/// Start (or update) the background pass while a vault is open.
#[tauri::command]
pub async fn analyse_start(app: AppHandle, state: State<'_, crate::Shared>, options: Options) -> Result<AnalyseStatus, String> {
    let s = crate::sess(&state)?;
    start(app, s.clone(), options);
    tauri::async_runtime::spawn_blocking(move || status(&s, true)).await.map_err(|e| e.to_string())?
}

/// The same as the "analyse-status" event sent after every round (the
/// window only asks now and then, in case it missed one). Cheap: what is
/// left was counted at most `RECOUNT` ago.
#[tauri::command]
pub async fn analyse_status(state: State<'_, crate::Shared>) -> Result<AnalyseStatus, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || status(&s, false)).await.map_err(|e| e.to_string())?
}

/// New items (an import): look now instead of in a few seconds.
#[tauri::command]
pub fn analyse_kick() {
    kick();
}

/// Remake one thumbnail here (the "sharper thumbnails" job). False when the
/// window has to do it (a video, a picture only it can read).
#[tauri::command]
pub async fn analyse_thumb(state: State<'_, crate::Shared>, id: i64) -> Result<bool, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let row: Option<(String, String, String)> = s
            .db()
            .query_row("SELECT kind, IFNULL(ext, ''), object_id FROM media WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .ok();
        let Some((kind, ext, object)) = row else { return Ok(false) };
        if !matches!(kind.as_str(), "image" | "gif") || !picture::native_ext(&ext) || NOT_HERE.lock().unwrap_or_else(|e| e.into_inner()).contains(&id) {
            return Ok(false);
        }
        let Ok(pic) = read(&s, ObjectKind::Media, &object).and_then(|b| picture::decode(&b)) else {
            not_here(id);
            return Ok(false);
        };
        let (_, webp) = picture::thumbnail(&pic)?;
        crate::cmd_media::store_thumb(&s, id, &webp, Some(pic.w as i64), Some(pic.h as i64), None, true)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The self-test: everything this pass does, now, for these items.
#[tauri::command]
pub async fn analyse_now(state: State<'_, crate::Shared>, ids: Vec<i64>) -> Result<Vec<ItemReport>, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ItemReport>, String> {
        let c = Caps { faces: faceid::info().available };
        let tasks = select(&s.db(), c, ids.len().max(1) as i64, Some(&ids))?;
        let out = process(&s, &tasks, c, &AtomicBool::new(false), &|_| {});
        s.mark_dirty();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    fn add(c: &Connection, kind: &str, ext: &str, thumb: Option<&str>) -> i64 {
        c.execute(
            "INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (lower(hex(randomblob(16))), ?1, 'x', ?2, 1, 'h', 0, ?3)",
            params![kind, ext, thumb],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    /// NOT_HERE is shared: tests that use it take turns.
    static TURN: Mutex<()> = Mutex::new(());

    #[test]
    fn one_decode_makes_the_thumbnail_and_fingerprint() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let t = tempfile::tempdir().unwrap();
        let s = crate::session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap().0;
        let img = image::RgbImage::from_fn(1200, 800, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        let mut jpg = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img).write_to(&mut jpg, image::ImageFormat::Jpeg).unwrap();
        let good = crate::import::add_bytes(&s, None, "photo.jpg", &jpg.into_inner()).unwrap();
        let bad = crate::import::add_bytes(&s, None, "broken.jpg", b"not really a jpeg at all").unwrap();
        let caps = Caps::default();
        let tasks = select(&s.db(), caps, 10, Some(&[good, bad])).unwrap();
        assert_eq!(tasks.len(), 2);
        let made = Mutex::new(Vec::new());
        let reps = process(&s, &tasks, caps, &AtomicBool::new(false), &|id| made.lock().unwrap_or_else(|e| e.into_inner()).push(id));
        assert_eq!(made.into_inner().unwrap(), vec![good], "grids hear about the new thumbnail");
        let (thumb, w, h, ps): (String, i64, i64, i64) = s
            .db()
            .query_row("SELECT thumb_object_id, width, height, phash_state FROM media WHERE id = ?", [good], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap();
        assert_eq!((w, h, ps), (1200, 800, 1));
        let back = picture::decode(&read(&s, ObjectKind::Thumbnail, &thumb).unwrap()).unwrap();
        assert_eq!((back.w, back.h), (640, 427));
        let r = reps.iter().find(|r| r.id == good).unwrap();
        assert!(r.thumb && r.print.is_some() && !r.left_to_window);
        // The broken one is left to the window, which then sees it again.
        assert!(reps.iter().find(|r| r.id == bad).unwrap().left_to_window);
        let thumb_bad: Option<String> = s.db().query_row("SELECT thumb_object_id FROM media WHERE id = ?", [bad], |r| r.get(0)).unwrap();
        assert_eq!(thumb_bad, None);
        assert!(NOT_HERE.lock().unwrap_or_else(|e| e.into_inner()).contains(&bad));
        assert!(select(&s.db(), caps, 10, Some(&[bad])).unwrap().is_empty());
        forget_not_here();
        // Nothing left to do for the good one.
        assert!(select(&s.db(), caps, 10, Some(&[good])).unwrap().is_empty());
    }

    #[test]
    fn picks_what_it_can_do_and_leaves_the_rest() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let c = db::create_empty().unwrap();
        let jpg = add(&c, "image", "JPG", None);
        let heic = add(&c, "image", "heic", None);
        let vid = add(&c, "video", "mp4", None);
        let vid_thumb = add(&c, "video", "mp4", Some("aa"));
        let done = add(&c, "image", "png", Some("bb"));
        c.execute("UPDATE media SET phash_state = 1 WHERE id = ?", [done]).unwrap();
        let ids = |t: Vec<Task>| t.into_iter().map(|t| t.id).collect::<Vec<_>>();
        let none = Caps::default();
        // Thumbnails of pictures it reads, fingerprints of anything with a thumbnail; the done picture isn't picked.
        assert_eq!(ids(select(&c, none, 10, None).unwrap()), vec![vid_thumb, jpg]);
        let t = select(&c, none, 10, None).unwrap();
        assert!(t[1].make_thumb && t[0].print && !t[0].make_thumb);
        // Faces queued: only for pictures it reads.
        c.execute("UPDATE media SET faces_state = 2", []).unwrap();
        let both = Caps { faces: true };
        assert_eq!(ids(select(&c, both, 10, None).unwrap()), vec![done, vid_thumb, jpg]);
        assert_eq!(left(&c, both).unwrap(), 3);
        // A picture it couldn't decode goes to the window.
        not_here(jpg);
        assert_eq!(ids(select(&c, none, 10, None).unwrap()), vec![vid_thumb]);
        assert!(here_sql().contains(&jpg.to_string()));
        forget_not_here();
        let _ = (heic, vid);
        // Only some ids (the self-test).
        assert_eq!(ids(select(&c, both, 10, Some(&[jpg])).unwrap()), vec![jpg]);
    }

    /// The whole pass on real pictures (with the faces pack when MV_FACES is
    /// set), timed, written as JSON for comparing with the window's results:
    /// MV_NATIVE_PICS=<pictures> MV_NATIVE_OUT=<out.json>
    /// cargo test real_pass -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_pass() {
        let dir = std::env::var("MV_NATIVE_PICS").expect("MV_NATIVE_PICS");
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        files.sort();
        let faces_on = faceid::info().available;
        let mut out = Vec::new();
        let (mut t_decode, mut t_thumb, mut t_print, mut t_faces, mut n) = (0u128, 0u128, 0u128, 0u128, 0);
        for p in &files {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            let bytes = std::fs::read(p).unwrap();
            let t = Instant::now();
            let pic = picture::decode(&bytes).unwrap();
            let d = t.elapsed();
            let t = Instant::now();
            let (thumb, jpeg) = picture::thumbnail(&pic).unwrap();
            let back = picture::decode(&jpeg).unwrap();
            let th = t.elapsed();
            let t = Instant::now();
            let (hash, sharp) = picture::fingerprint(&back);
            let pr = t.elapsed();
            let t = Instant::now();
            let nfaces = if faces_on {
                let (rgba, w, h) = picture::faces_input(&pic);
                faceid::faces_in(&rgba, w, h, 0).unwrap().len() as i64
            } else {
                -1
            };
            let fa = t.elapsed();
            eprintln!("{name:34} {}×{} decode {d:?} thumb {th:?} print {pr:?} faces {nfaces} in {fa:?}", pic.w, pic.h);
            t_decode += d.as_micros();
            t_thumb += th.as_micros();
            t_print += pr.as_micros();
            t_faces += fa.as_micros();
            n += 1;
            out.push(serde_json::json!({ "name": name, "w": pic.w, "h": pic.h, "tw": thumb.w, "th": thumb.h, "hash": hash, "sharp": sharp,
                "jpeg": hex::encode(&*jpeg), "faces": nfaces }));
        }
        let n = n.max(1) as u128;
        eprintln!(
            "per picture (ms): decode {:.1}, thumbnail {:.1}, fingerprint {:.1}, faces {:.1}",
            t_decode as f64 / n as f64 / 1000.0, t_thumb as f64 / n as f64 / 1000.0, t_print as f64 / n as f64 / 1000.0,
            t_faces as f64 / n as f64 / 1000.0
        );
        // The whole pass in a real vault: one decode, everything stored.
        {
            let t = tempfile::tempdir().unwrap();
            let s = crate::session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap().0;
            let ids: Vec<i64> = files
                .iter()
                .take(4)
                .map(|p| crate::import::add_bytes(&s, None, &p.file_name().unwrap().to_string_lossy(), &std::fs::read(p).unwrap()).unwrap())
                .collect();
            if faces_on {
                faces::queue(&s.db(), &faces::ScanRequest { ids: ids.clone(), folder: None, all: false, again: true }).unwrap();
            }
            let c = Caps { faces: faces_on };
            let t0 = Instant::now();
            let tasks = select(&s.db(), c, 10, Some(&ids)).unwrap();
            let reps = process(&s, &tasks, c, &AtomicBool::new(false), &|_| {});
            eprintln!("pass over {} pictures in a vault: {:?} ({:?})", ids.len(), t0.elapsed(), reps);
            for id in &ids {
                let (ps, fs): (i64, i64) = s
                    .db()
                    .query_row("SELECT phash_state, faces_state FROM media WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .unwrap();
                assert_eq!(ps, 1, "item {id}");
                assert!(!faces_on || fs == 1, "faces of item {id}: {fs}");
            }
        }
        if let Ok(path) = std::env::var("MV_NATIVE_OUT") {
            std::fs::write(&path, serde_json::to_vec(&serde_json::json!({ "items": out })).unwrap()).unwrap();
        }
    }

    /// How SQLite runs a query, and that it never reads every item.
    pub(crate) fn assert_no_full_scan(c: &Connection, sql: &str, index: &str) {
        let mut st = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let args = vec![rusqlite::types::Value::Integer(1); st.parameter_count()];
        let plan: Vec<String> = st.query_map(rusqlite::params_from_iter(args), |r| r.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        let p = plan.join(" | ");
        assert!(p.contains(index), "{index} not used: {sql}\n{p}");
        for step in &plan {
            let whole = (step == "SCAN media" || step == "SCAN m" || step.starts_with("SCAN media ") || step.starts_with("SCAN m "))
                && !step.contains("INDEX");
            assert!(!whole, "reads every item: {step}\n{sql}\n{p}");
        }
    }

    #[test]
    fn the_queues_read_only_what_is_waiting() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let c = db::create_empty().unwrap();
        // Something on screen and a picture it couldn't read: the SQL still uses the indexes.
        crate::focus::set(Some(crate::focus::Focus { folder: Some(999_999), in_folder: true, ids: vec![999_998] }));
        not_here(999_997);
        let all = select_sql(None).replace("?3", "5");
        assert_no_full_scan(&c, &all, "media_need_thumb");
        for index in ["media_need_print", "media_faces_queued"] {
            assert_no_full_scan(&c, &all, index);
        }
        let left = format!("SELECT COUNT(*) FROM ({})", todo_sql(&here_sql()));
        assert_no_full_scan(&c, &left, "media_need_print");
        assert_no_full_scan(&c, &faces::needed_sql().replace('?', "5"), "media_faces_queued");
        assert_no_full_scan(&c, &crate::cmd_media::thumbs_needed_sql().replace('?', "5"), "media_need_thumb");
        assert_no_full_scan(&c, crate::sketch::BACKFILL_SQL, "media_need_sketch");
        assert_no_full_scan(&c, crate::meta::BACKFILL_SQL, "media_need_taken");
        crate::focus::set(None);
        forget_not_here();
    }

    #[test]
    fn the_window_keeps_what_it_alone_can_do() {
        // Not running: the window does everything as before.
        assert_eq!(window_thumbs_sql(), "");
        assert!(!window_skips_prints());
        let c = db::create_empty().unwrap();
        let v = add(&c, "video", "mp4", None);
        c.execute("UPDATE media SET faces_state = 2", []).unwrap();
        assert_eq!(window_faces(&c, 5).unwrap().len(), 1);
        assert_eq!(window_faces_left(&c).unwrap(), 1);
        let _ = v;
    }
}
