//! The native analysis pass: "decode once, use four times".
//!
//! Each picture the app can read itself (JPEG, PNG, WebP, GIF: picture.rs)
//! is decrypted and decoded once, in memory, and from those pixels come its
//! thumbnail, its look-alike fingerprint, its smart-search vector (CLIP,
//! smartnative.rs, gathered from several pictures) and its faces (faceid.rs, with the
//! faces pack). Fingerprints and smart-search vectors of every item (videos
//! too) are made from its stored thumbnail (and a video's preview clip), as
//! the window made them. Nothing decrypted is ever written anywhere.
//!
//! It runs in the background while a vault is open (started by the window),
//! on low-priority threads (all cores but one), and can be stopped at any
//! time. Each step keeps its own state in the library (thumb_object_id,
//! phash_state, clip_state, faces_state), so a step that fails is retried or
//! marked exactly as before. What it can't do (videos, other picture
//! formats, a missing model) the window's loops still do; while this runs
//! they leave the rest to it (`window_*` below), so nothing is done twice.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use vault_core::{ObjectId, ObjectKind};
use zeroize::Zeroizing;

use crate::library::R;
use crate::picture::{self, Rgb};
use crate::session::Session;
use crate::{clip, faceid, faces, similar, smartnative};

/// Items looked at per round.
const ROUND: i64 = 16;
const KINDS: &str = "('image', 'gif', 'video')";
/// A video's preview clip: 8 × 6 small frames (previews.ts); smart search
/// also looks at frames 0, 12, 24 and 36 (smart.ts `embedVideo`).
const STRIP_COLS: f64 = 8.0;
const STRIP_ROWS: f64 = 6.0;
const STRIP_FRAMES: [usize; 4] = [0, 12, 24, 36];

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

// ---- what runs ----------------------------------------------------------------------------

/// What the window asked for.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// Settings → "Analyse pictures for smart search".
    pub smart: bool,
    /// People → "Pause scanning".
    #[serde(default)]
    pub faces_paused: bool,
}

struct Runner {
    session: Arc<Session>,
    stop: Arc<AtomicBool>,
}

static RUNNER: Mutex<Option<Runner>> = Mutex::new(None);
static OPTIONS: Mutex<Options> = Mutex::new(Options { smart: true, faces_paused: false });
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
/// Pictures this pass couldn't decode (left to the window until the app restarts).
static NOT_HERE: Mutex<BTreeSet<i64>> = Mutex::new(BTreeSet::new());
static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct Counts {
    items: AtomicU64,
    thumbs: AtomicU64,
    prints: AtomicU64,
    smart: AtomicU64,
    faces: AtomicU64,
}
static DONE: Counts = Counts {
    items: AtomicU64::new(0),
    thumbs: AtomicU64::new(0),
    prints: AtomicU64::new(0),
    smart: AtomicU64::new(0),
    faces: AtomicU64::new(0),
};

fn running() -> bool {
    RUNNER.lock().unwrap().as_ref().is_some_and(|r| !r.stop.load(Ordering::SeqCst) && !r.session.is_closed())
}

/// Which steps can be done here right now.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Caps {
    pub smart: bool,
    pub faces: bool,
}

fn caps() -> Caps {
    let o = *OPTIONS.lock().unwrap();
    Caps { smart: o.smart && smartnative::usable(), faces: !o.faces_paused && faceid::info().available }
}

/// SQL: a picture this pass decodes itself.
fn here_sql() -> String {
    let exts = picture::NATIVE_EXTS.iter().map(|x| format!("'{x}'")).collect::<Vec<_>>().join(", ");
    let not = NOT_HERE.lock().unwrap();
    let skip = if not.is_empty() {
        String::new()
    } else {
        format!(" AND id NOT IN ({})", not.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", "))
    };
    format!("(kind IN ('image', 'gif') AND lower(IFNULL(ext, '')) IN ({exts}){skip})")
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

/// Smart search: all made here while this runs with a working model.
pub fn window_skips_smart() -> bool {
    running() && caps().smart
}

/// Faces still for the window (videos, pictures only it can read).
pub fn window_faces(conn: &Connection, limit: i64) -> R<Vec<faces::ScanTask>> {
    if !(running() && faceid::info().available) {
        return faces::needed(conn, limit);
    }
    conn.prepare(&format!(
        "SELECT id, kind, duration_ms FROM media WHERE faces_state = 2 AND deleted_at IS NULL{} AND NOT {} ORDER BY {}id LIMIT ?",
        faces::off_sql(),
        here_sql(),
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
    kind: String,
    object: String,
    thumb: Option<String>,
    preview: Option<String>,
    make_thumb: bool,
    print: bool,
    smart: bool,
    faces: bool,
}

fn where_sql(here: &str) -> String {
    let off = faces::off_sql();
    format!(
        "((thumb_object_id IS NULL AND {here}) \
         OR (IFNULL(thumb_object_id, '') <> '' AND deleted_at IS NULL AND kind IN {KINDS} AND (phash_state = 0 OR (?1 AND clip_state = 0))) \
         OR (thumb_object_id = '' AND ?1 AND clip_state = 0 AND deleted_at IS NULL AND kind IN {KINDS}) \
         OR (?2 AND faces_state = 2 AND deleted_at IS NULL AND {here}{off}))"
    )
}

fn select(conn: &Connection, caps: Caps, limit: i64, only: Option<&[i64]>) -> R<Vec<Task>> {
    let here = here_sql();
    let off = faces::off_sql();
    let ids = only.map(|ids| format!(" AND id IN ({})", ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", "))).unwrap_or_default();
    let sql = format!(
        "SELECT id, kind, object_id, thumb_object_id, preview_object_id, \
           (thumb_object_id IS NULL AND {here}), \
           (phash_state = 0 AND deleted_at IS NULL AND kind IN {KINDS}), \
           (?1 AND clip_state = 0 AND deleted_at IS NULL AND kind IN {KINDS}), \
           (?2 AND faces_state = 2 AND deleted_at IS NULL AND {here}{off}) \
         FROM media WHERE {}{ids} ORDER BY {}id DESC LIMIT ?3",
        where_sql(&here),
        crate::focus::order()
    );
    conn.prepare(&sql)
        .map_err(e)?
        .query_map(params![caps.smart, caps.faces, limit], |r| {
            Ok(Task {
                id: r.get(0)?,
                kind: r.get(1)?,
                object: r.get(2)?,
                thumb: r.get(3)?,
                preview: r.get::<_, Option<String>>(4)?.filter(|p| !p.is_empty()),
                make_thumb: r.get(5)?,
                print: r.get(6)?,
                smart: r.get(7)?,
                faces: r.get(8)?,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)
}

/// How many items still have something to be done here.
fn left(conn: &Connection, caps: Caps) -> R<i64> {
    conn.query_row(&format!("SELECT COUNT(*) FROM media WHERE {}", where_sql(&here_sql())), params![caps.smart, caps.faces], |r| r.get(0))
        .map_err(e)
}

// ---- one item ---------------------------------------------------------------------------------

fn read(s: &Session, kind: ObjectKind, hex: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let id = ObjectId::from_hex(hex).map_err(|e| e.to_string())?;
    s.vault().read_object(kind, &id).map_err(|e| e.to_string())
}

/// A picture ready for the smart-search model.
struct ClipJob {
    id: i64,
    /// One or more 3 × 224 × 224 inputs, one after another.
    input: Vec<f32>,
    frames: usize,
}

/// What happened, for the self-test.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemReport {
    pub id: i64,
    pub thumb: bool,
    pub print: Option<String>,
    pub smart: bool,
    pub faces: Option<usize>,
    pub left_to_window: bool,
    pub ms: u64,
}

fn not_here(id: i64) {
    NOT_HERE.lock().unwrap().insert(id);
}

/// Everything for one item except the smart-search model run.
fn work(s: &Session, t: &Task, caps: Caps, emit: &dyn Fn(i64)) -> (Option<ClipJob>, ItemReport) {
    let start = Instant::now();
    let mut rep = ItemReport { id: t.id, ..Default::default() };
    let mut thumb_bytes: Option<Zeroizing<Vec<u8>>> = None;
    let mut thumb_id = t.thumb.clone();
    let (mut print, mut smart) = (t.print, t.smart && caps.smart);
    if t.make_thumb || (t.faces && caps.faces) {
        match read(s, ObjectKind::Media, &t.object).and_then(|b| picture::decode(&b)) {
            Err(_) => {
                not_here(t.id);
                rep.left_to_window = true;
            }
            Ok(pic) => {
                if t.make_thumb {
                    match picture::thumbnail(&pic) {
                        Ok((_, webp)) => match crate::store_thumb(s, t.id, &webp, Some(pic.w as i64), Some(pic.h as i64), None, false) {
                            Ok(()) => {
                                DONE.thumbs.fetch_add(1, Ordering::Relaxed);
                                rep.thumb = true;
                                emit(t.id);
                                thumb_bytes = Some(webp);
                                thumb_id = Some("new".into());
                                // A new thumbnail: its fingerprint and smart-search vector are made again.
                                let db = s.db();
                                if let Ok((p, c)) = db.query_row(
                                    &format!(
                                        "SELECT phash_state = 0 AND deleted_at IS NULL AND kind IN {KINDS}, clip_state = 0 AND deleted_at IS NULL AND kind IN {KINDS} FROM media WHERE id = ?"
                                    ),
                                    [t.id],
                                    |r| Ok((r.get::<_, bool>(0)?, r.get::<_, bool>(1)?)),
                                ) {
                                    print = p;
                                    smart = c && caps.smart;
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
                            s.mark_dirty();
                            DONE.faces.fetch_add(1, Ordering::Relaxed);
                            rep.faces = Some(n);
                        }
                        // The model itself failing: left as it is (scanned when it works again).
                        Err(_) if !faceid::info().available => {}
                        Err(_) => {
                            let _ = faces::failed(&s.db(), t.id, faces::ARCFACE);
                            s.mark_dirty();
                        }
                    }
                }
            }
        }
    }
    let mut job = None;
    if print || smart {
        let thumb = match (&thumb_bytes, thumb_id.as_deref()) {
            (Some(j), _) => picture::decode(j),
            (None, Some(hex)) if !hex.is_empty() => read(s, ObjectKind::Thumbnail, hex).and_then(|b| picture::decode(&b)),
            _ => Err("no thumbnail".into()),
        };
        match thumb {
            Ok(th) => {
                if print {
                    let (hash, sharp) = picture::fingerprint(&th);
                    let _ = similar::save(&s.db(), t.id, &hash, sharp);
                    s.mark_dirty();
                    DONE.prints.fetch_add(1, Ordering::Relaxed);
                    rep.print = Some(hash);
                }
                if smart {
                    job = Some(clip_job(s, t, &th));
                }
            }
            Err(_) => {
                let db = s.db();
                // An empty thumbnail (the window couldn't make one) isn't fingerprinted at all.
                if print && thumb_id.as_deref().is_some_and(|h| !h.is_empty()) {
                    let _ = similar::failed(&db, t.id);
                }
                if smart {
                    let _ = clip::failed(&db, t.id);
                }
                s.mark_dirty();
            }
        }
    }
    DONE.items.fetch_add(1, Ordering::Relaxed);
    rep.ms = start.elapsed().as_millis() as u64;
    (job, rep)
}

/// The thumbnail, and for videos with a preview clip four of its moments.
fn clip_job(s: &Session, t: &Task, thumb: &Rgb) -> ClipJob {
    let mut input = picture::clip_input(thumb, None);
    let mut frames = 1;
    if t.kind == "video"
        && let Some(p) = &t.preview
        && let Ok(strip) = read(s, ObjectKind::Thumbnail, p).and_then(|b| picture::decode(&b))
    {
        let (cw, ch) = (strip.w as f64 / STRIP_COLS, strip.h as f64 / STRIP_ROWS);
        for i in STRIP_FRAMES {
            let (x, y) = ((i % 8) as f64 * cw, (i / 8) as f64 * ch);
            input.extend(picture::clip_input(&strip, Some((x, y, cw, ch))));
            frames += 1;
        }
    }
    ClipJob { id: t.id, input, frames }
}

/// Run the smart-search model over the prepared pictures and store the
/// vectors; returns the items done.
fn finish_smart(s: &Session, jobs: Vec<ClipJob>) -> Vec<i64> {
    if jobs.is_empty() {
        return Vec::new();
    }
    let n: usize = jobs.iter().map(|j| j.frames).sum();
    let mut all = Vec::with_capacity(n * 3 * picture::CLIP_SIZE * picture::CLIP_SIZE);
    for j in &jobs {
        all.extend_from_slice(&j.input);
    }
    // A model that can't run: left as they are (the window takes over).
    let Ok(vecs) = smartnative::embed(&all, n) else { return Vec::new() };
    let mut k = 0;
    let db = s.db();
    let mut done = Vec::new();
    for j in &jobs {
        let v: Vec<f32> = vecs[k..k + j.frames].iter().flatten().copied().collect();
        k += j.frames;
        if clip::save(&db, j.id, &v).is_ok() {
            done.push(j.id);
        }
        DONE.smart.fetch_add(1, Ordering::Relaxed);
    }
    s.mark_dirty();
    done
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

/// One round: the tasks on all cores but one, then the smart-search model.
fn process(s: &Session, tasks: &[Task], caps: Caps, stop: &AtomicBool, emit: &(dyn Fn(i64) + Sync)) -> Vec<ItemReport> {
    let next = AtomicUsize::new(0);
    let jobs: Mutex<Vec<ClipJob>> = Mutex::new(Vec::new());
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
                    let (job, rep) = work(s, &tasks[i], caps, emit);
                    if let Some(j) = job {
                        jobs.lock().unwrap().push(j);
                    }
                    reports.lock().unwrap().push(rep);
                }
            });
        }
    });
    let mut reports = reports.into_inner().unwrap();
    if !stop.load(Ordering::SeqCst) && !s.is_closed() {
        let done = finish_smart(s, jobs.into_inner().unwrap());
        for r in reports.iter_mut() {
            r.smart = done.contains(&r.id);
        }
    }
    reports
}

fn sleep_until_woken(ms: u64) {
    let (m, cv) = &WAKE;
    let mut woken = m.lock().unwrap();
    if !*woken {
        woken = cv.wait_timeout(woken, Duration::from_millis(ms)).unwrap().0;
    }
    *woken = false;
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
            if named {
                named = false;
                if faces::refresh(&*s).unwrap_or(0) > 0 {
                    s.mark_dirty();
                }
            }
            sleep_until_woken(5000);
            continue;
        }
        BUSY.store(true, Ordering::SeqCst);
        let reports = process(&s, &tasks, c, &stop, &emit);
        send(true);
        if reports.iter().any(|r| r.faces.is_some_and(|n| n > 0)) {
            named = true;
        }
        // Name sure faces now and then while scanning (and at the end).
        if named && last_naming.elapsed() > Duration::from_secs(20) {
            last_naming = Instant::now();
            named = false;
            if faces::refresh(&*s).unwrap_or(0) > 0 {
                s.mark_dirty();
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    BUSY.store(false, Ordering::SeqCst);
}

/// Stop the pass (the vault locked): it ends after the item it is on.
pub fn stop() {
    if let Some(r) = RUNNER.lock().unwrap().take() {
        r.stop.store(true, Ordering::SeqCst);
    }
    NOT_HERE.lock().unwrap().clear();
    kick();
    smartnative::unload();
}

pub fn kick() {
    let (m, cv) = &WAKE;
    *m.lock().unwrap() = true;
    cv.notify_all();
}

/// Start the pass for this session (or just take the new options).
pub fn start(app: AppHandle, s: Arc<Session>, opts: Options) {
    *OPTIONS.lock().unwrap() = opts;
    let mut r = RUNNER.lock().unwrap();
    let same = r.as_ref().is_some_and(|r| Arc::ptr_eq(&r.session, &s) && !r.stop.load(Ordering::SeqCst));
    if !same {
        if let Some(old) = r.take() {
            old.stop.store(true, Ordering::SeqCst);
        }
        // Another vault: what couldn't be decoded there means nothing here.
        NOT_HERE.lock().unwrap().clear();
        let stop = Arc::new(AtomicBool::new(false));
        *r = Some(Runner { session: s.clone(), stop: stop.clone() });
        for c in [&DONE.items, &DONE.thumbs, &DONE.prints, &DONE.smart, &DONE.faces] {
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
    pub smart: u64,
    pub faces: u64,
    /// Items still with something to do here.
    pub left: i64,
    /// Faces are part of what is left.
    pub faces_left: i64,
}

fn status(s: &Session) -> R<AnalyseStatus> {
    let c = caps();
    let db = s.db();
    let left = if running() { left(&db, c)? } else { 0 };
    let faces_left = if running() && c.faces {
        db.query_row(&format!("SELECT COUNT(*) FROM media WHERE faces_state = 2 AND deleted_at IS NULL{} AND {}", faces::off_sql(), here_sql()), [], |r| r.get(0)).map_err(e)?
    } else {
        0
    };
    Ok(AnalyseStatus {
        running: running(),
        busy: BUSY.load(Ordering::SeqCst),
        done: DONE.items.load(Ordering::Relaxed),
        thumbs: DONE.thumbs.load(Ordering::Relaxed),
        prints: DONE.prints.load(Ordering::Relaxed),
        smart: DONE.smart.load(Ordering::Relaxed),
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
    tauri::async_runtime::spawn_blocking(move || status(&s)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn analyse_status(state: State<'_, crate::Shared>) -> Result<AnalyseStatus, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || status(&s)).await.map_err(|e| e.to_string())?
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
        if !matches!(kind.as_str(), "image" | "gif") || !picture::native_ext(&ext) || NOT_HERE.lock().unwrap().contains(&id) {
            return Ok(false);
        }
        let Ok(pic) = read(&s, ObjectKind::Media, &object).and_then(|b| picture::decode(&b)) else {
            not_here(id);
            return Ok(false);
        };
        let (_, webp) = picture::thumbnail(&pic)?;
        crate::store_thumb(&s, id, &webp, Some(pic.w as i64), Some(pic.h as i64), None, true)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Smart search's engine, for Settings.
#[tauri::command]
pub fn smart_engine() -> smartnative::SmartEngine {
    smartnative::info()
}

/// The self-test: everything this pass does, now, for these items.
#[tauri::command]
pub async fn analyse_now(state: State<'_, crate::Shared>, ids: Vec<i64>, smart: bool) -> Result<Vec<ItemReport>, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ItemReport>, String> {
        let c = Caps { smart: smart && smartnative::usable(), faces: faceid::info().available };
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
        let reps = process(&s, &tasks, caps, &AtomicBool::new(false), &|id| made.lock().unwrap().push(id));
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
        assert!(NOT_HERE.lock().unwrap().contains(&bad));
        assert!(select(&s.db(), caps, 10, Some(&[bad])).unwrap().is_empty());
        NOT_HERE.lock().unwrap().clear();
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
        c.execute("UPDATE media SET phash_state = 1, clip_state = 1 WHERE id = ?", [done]).unwrap();
        let ids = |t: Vec<Task>| t.into_iter().map(|t| t.id).collect::<Vec<_>>();
        let none = Caps::default();
        // Without smart search: thumbnails of pictures it reads, fingerprints of anything with a thumbnail.
        assert_eq!(ids(select(&c, none, 10, None).unwrap()), vec![vid_thumb, jpg]);
        let t = select(&c, none, 10, None).unwrap();
        assert!(t[1].make_thumb && !t[1].smart && t[0].print && !t[0].make_thumb);
        // Smart search too: the done picture still isn't picked.
        let smart = Caps { smart: true, faces: false };
        assert_eq!(ids(select(&c, smart, 10, None).unwrap()), vec![vid_thumb, jpg]);
        // Faces queued: only for pictures it reads.
        c.execute("UPDATE media SET faces_state = 2", []).unwrap();
        let both = Caps { smart: true, faces: true };
        assert_eq!(ids(select(&c, both, 10, None).unwrap()), vec![done, vid_thumb, jpg]);
        assert_eq!(left(&c, both).unwrap(), 3);
        // A picture it couldn't decode goes to the window.
        not_here(jpg);
        assert_eq!(ids(select(&c, none, 10, None).unwrap()), vec![vid_thumb]);
        assert!(here_sql().contains(&jpg.to_string()));
        NOT_HERE.lock().unwrap().clear();
        let _ = (heic, vid);
        // Only some ids (the self-test).
        assert_eq!(ids(select(&c, both, 10, Some(&[jpg])).unwrap()), vec![jpg]);
    }

    /// The whole pass on real pictures with the real smart-search model (and
    /// the faces pack when MV_FACES is set), timed, written as JSON for
    /// comparing with the window's results:
    /// MV_MODELS_DIR=<models> MV_ORT_DIR=<folder with libonnxruntime.so.*>
    /// MV_NATIVE_PICS=<pictures> MV_NATIVE_OUT=<out.json>
    /// cargo test real_pass -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_pass() {
        let dir = std::env::var("MV_NATIVE_PICS").expect("MV_NATIVE_PICS");
        assert!(smartnative::usable(), "{:?}", smartnative::info());
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        files.sort();
        let faces_on = faceid::info().available;
        let mut out = Vec::new();
        let mut inputs: Vec<f32> = Vec::new();
        let (mut t_decode, mut t_thumb, mut t_print, mut t_clip, mut t_faces, mut n) = (0u128, 0u128, 0u128, 0u128, 0u128, 0);
        // Warm the model up (loading isn't per picture).
        smartnative::embed(&vec![0.0; 3 * 224 * 224], 1).unwrap();
        for p in &files {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            if name == "strip.jpg" {
                continue;
            }
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
            let input = picture::clip_input(&back, None);
            let v = smartnative::embed(&input, 1).unwrap().remove(0);
            let cl = t.elapsed();
            let t = Instant::now();
            let nfaces = if faces_on {
                let (rgba, w, h) = picture::faces_input(&pic);
                faceid::faces_in(&rgba, w, h, 0).unwrap().len() as i64
            } else {
                -1
            };
            let fa = t.elapsed();
            eprintln!(
                "{name:34} {}×{} decode {d:?} thumb {th:?} print {pr:?} smart {cl:?} faces {nfaces} in {fa:?}",
                pic.w, pic.h
            );
            t_decode += d.as_micros();
            t_thumb += th.as_micros();
            t_print += pr.as_micros();
            t_clip += cl.as_micros();
            t_faces += fa.as_micros();
            n += 1;
            inputs.extend_from_slice(&input);
            out.push(serde_json::json!({ "name": name, "w": pic.w, "h": pic.h, "tw": thumb.w, "th": thumb.h, "hash": hash, "sharp": sharp,
                "emb": v, "jpeg": hex::encode(&*jpeg), "faces": nfaces }));
        }
        // Several pictures in one call give the same vectors as one at a time.
        let k = out.len().min(8);
        let batch = smartnative::embed(&inputs[..k * 3 * 224 * 224], k).unwrap();
        for (i, b) in batch.iter().enumerate() {
            let one: Vec<f32> = serde_json::from_value(out[i]["emb"].clone()).unwrap();
            let c: f32 = one.iter().zip(b).map(|(x, y)| x * y).sum();
            assert!(c > 0.9999, "batch differs: {c}");
        }
        let t = Instant::now();
        let _ = smartnative::embed(&inputs[..k * 3 * 224 * 224], k).unwrap();
        let per_batched = t.elapsed().as_micros() / k as u128;
        let n = n.max(1) as u128;
        eprintln!(
            "per picture (ms): decode {:.1}, thumbnail {:.1}, fingerprint {:.1}, smart {:.1} (8 in one call: {:.1} each), faces {:.1}; device {:?}",
            t_decode as f64 / n as f64 / 1000.0, t_thumb as f64 / n as f64 / 1000.0, t_print as f64 / n as f64 / 1000.0,
            t_clip as f64 / n as f64 / 1000.0, per_batched as f64 / 1000.0, t_faces as f64 / n as f64 / 1000.0, smartnative::info().device
        );
        // Strip cells (a video's preview clip), as the window cuts them.
        let strip = std::path::Path::new(&dir).join("strip.jpg");
        let mut cells = Vec::new();
        if strip.is_file() {
            let s = picture::decode(&std::fs::read(&strip).unwrap()).unwrap();
            let (cw, ch) = (s.w as f64 / STRIP_COLS, s.h as f64 / STRIP_ROWS);
            for i in STRIP_FRAMES {
                let inp = picture::clip_input(&s, Some(((i % 8) as f64 * cw, (i / 8) as f64 * ch, cw, ch)));
                cells.push(smartnative::embed(&inp, 1).unwrap().remove(0));
            }
        }
        // The whole pass in a real vault: one decode, everything stored.
        {
            let t = tempfile::tempdir().unwrap();
            let s = crate::session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap().0;
            let ids: Vec<i64> = files
                .iter()
                .filter(|p| !p.ends_with("strip.jpg"))
                .take(4)
                .map(|p| crate::import::add_bytes(&s, None, &p.file_name().unwrap().to_string_lossy(), &std::fs::read(p).unwrap()).unwrap())
                .collect();
            if faces_on {
                faces::queue(&s.db(), &faces::ScanRequest { ids: ids.clone(), folder: None, all: false, again: true }).unwrap();
            }
            let c = Caps { smart: true, faces: faces_on };
            let t0 = Instant::now();
            let tasks = select(&s.db(), c, 10, Some(&ids)).unwrap();
            let reps = process(&s, &tasks, c, &AtomicBool::new(false), &|_| {});
            eprintln!("pass over {} pictures in a vault: {:?} ({:?})", ids.len(), t0.elapsed(), reps);
            for id in &ids {
                let (cs, ps, fs): (i64, i64, i64) = s
                    .db()
                    .query_row("SELECT clip_state, phash_state, faces_state FROM media WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .unwrap();
                assert_eq!((cs, ps), (1, 1), "item {id}");
                assert!(reps.iter().any(|r| r.id == *id && r.smart));
                assert!(!faces_on || fs == 1, "faces of item {id}: {fs}");
            }
        }
        if let Ok(path) = std::env::var("MV_NATIVE_OUT") {
            std::fs::write(&path, serde_json::to_vec(&serde_json::json!({ "items": out, "strip": cells })).unwrap()).unwrap();
            let raw: Vec<u8> = inputs.iter().flat_map(|f| f.to_le_bytes()).collect();
            std::fs::write(format!("{path}.inputs.bin"), raw).unwrap();
        }
    }

    #[test]
    fn the_window_keeps_what_it_alone_can_do() {
        // Not running: the window does everything as before.
        assert_eq!(window_thumbs_sql(), "");
        assert!(!window_skips_prints() && !window_skips_smart());
        let c = db::create_empty().unwrap();
        let v = add(&c, "video", "mp4", None);
        c.execute("UPDATE media SET faces_state = 2", []).unwrap();
        assert_eq!(window_faces(&c, 5).unwrap().len(), 1);
        let _ = v;
    }
}
