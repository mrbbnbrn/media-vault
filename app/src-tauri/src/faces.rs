//! Face recognition, the library side. Faces are found and fingerprinted
//! fully offline by InsightFace buffalo_l (faceid.rs, the optional faces
//! pack; model 1). Faces found by the old built-in face-api (model 0, no
//! longer in the app) may still be stored until the pack scans them again.
//! This module stores them (inside the encrypted library) and
//! works out who is who (facegraph.rs):
//!  - faces very much like someone you confirmed are named automatically
//!    (listed as "recognised", easy to undo); less certain ones are asked;
//!  - everyone else is grouped ("Person 1 · 312 photos"), to be named once;
//!  - a person folder's owner is found among its photos ("Find me");
//!  - people who look the same are offered for merging.
//!
//! Naming faces never moves or changes files: a person's page and searches
//! show every photo they are recognised in. Moving is only ever offered.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::facegraph::{self as fg, Analysis, FaceMeta, Graph, PersonMeta};
use crate::faceid;
use crate::library::{self, Item, R};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

/// face-api fingerprints (model 0).
pub const DIM: usize = 128;
/// The old built-in face-api (its faces may still be stored).
#[cfg(test)]
pub const FACEAPI: i64 = 0;
/// InsightFace buffalo_l (the faces pack).
pub const ARCFACE: i64 = faceid::MODEL_ID;

fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

pub fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

pub fn distance(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f32>().sqrt()
}

fn now() -> i64 {
    library::now_secs()
}

/// Something holding the open library (the session, or a bare database in tests).
pub trait Lib {
    fn conn(&self) -> MutexGuard<'_, Connection>;
    /// Which vault (so remembered work is never mixed up between vaults).
    fn key(&self) -> String;
    /// Something was written that should be saved.
    fn changed(&self) {}
}

impl Lib for crate::session::Session {
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.db()
    }
    fn key(&self) -> String {
        self.vault().root().display().to_string()
    }
    fn changed(&self) {
        self.mark_dirty();
    }
}

impl Lib for Mutex<Connection> {
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.lock().unwrap_or_else(|x| x.into_inner())
    }
    fn key(&self) -> String {
        format!("mem:{:p}", self as *const _)
    }
}

// ---- queue and storage -----------------------------------------------------------------

/// Which items to scan: these ids, a folder (with subfolders) or everything.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    #[serde(default)]
    pub ids: Vec<i64>,
    #[serde(default)]
    pub folder: Option<i64>,
    #[serde(default)]
    pub all: bool,
    /// Scan again items that were already scanned.
    #[serde(default)]
    pub again: bool,
}

fn scannable_ids(conn: &Connection, req: &ScanRequest) -> R<Vec<i64>> {
    let items = if req.all {
        library::query_items(conn, &Default::default())?
    } else if let Some(f) = req.folder {
        library::query_items(conn, &library::ItemFilter { folder: Some(Some(f)), recursive: true, ..Default::default() })?
    } else {
        library::items_by_ids(conn, &req.ids)?
    };
    Ok(items.into_iter().filter(|i| matches!(i.kind.as_str(), "image" | "gif" | "video")).map(|i| i.id).collect())
}

/// Put items in the scan queue. Returns how many will be scanned.
pub fn queue(conn: &Connection, req: &ScanRequest) -> R<usize> {
    let ids = scannable_ids(conn, req)?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    let mut n = 0;
    for id in ids {
        let sql = if req.again {
            "UPDATE media SET faces_state = 2 WHERE id = ?"
        } else {
            "UPDATE media SET faces_state = 2 WHERE id = ? AND faces_state IN (0, 2)"
        };
        n += tx.execute(sql, [id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(n)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanTask {
    pub id: i64,
    pub kind: String,
    pub duration_ms: Option<i64>,
}

pub fn needed(conn: &Connection, limit: i64) -> R<Vec<ScanTask>> {
    conn.prepare(&format!("SELECT id, kind, duration_ms FROM media WHERE faces_state = 2 AND deleted_at IS NULL ORDER BY {}id LIMIT ?", crate::focus::order()))
        .map_err(e)?
        .query_map([limit], |r| Ok(ScanTask { id: r.get(0)?, kind: r.get(1)?, duration_ms: r.get(2)? }))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub queued: i64,
    pub scanned: i64,
    pub faces: i64,
    pub failed: i64,
}

pub fn status(conn: &Connection) -> R<ScanStatus> {
    let one = |sql: &str| -> R<i64> { conn.query_row(sql, [], |r| r.get(0)).map_err(e) };
    Ok(ScanStatus {
        queued: one("SELECT COUNT(*) FROM media WHERE faces_state = 2 AND deleted_at IS NULL")?,
        scanned: one("SELECT COUNT(*) FROM media WHERE faces_state = 1 AND deleted_at IS NULL")?,
        faces: one("SELECT COUNT(*) FROM faces f JOIN media m ON m.id = f.media_id WHERE m.deleted_at IS NULL")?,
        failed: one("SELECT COUNT(*) FROM media WHERE faces_state = -1 AND deleted_at IS NULL")?,
    })
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FaceIn {
    #[serde(default)]
    pub frame_ms: i64,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
    pub descriptor: Vec<f32>,
    /// Poor faces (poorfaces.rs): height in pixels of the picture looked at,
    /// sharpness of the face, how turned it is (degrees). None = not measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub px: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharp: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<f32>,
}

/// Overlap of two boxes given as [x, y, w, h] (parts of the picture).
fn box_iou(a: [f32; 4], b: [f32; 4]) -> f32 {
    let w = ((a[0] + a[2]).min(b[0] + b[2]) - a[0].max(b[0])).max(0.0);
    let h = ((a[1] + a[3]).min(b[1] + b[3]) - a[1].max(b[1])).max(0.0);
    let inter = w * h;
    let union = a[2] * a[3] + b[2] * b[3] - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

/// A face found before, and what you said about it.
struct OldFace {
    id: i64,
    model: i64,
    frame_ms: i64,
    rect: [f32; 4],
    desc: Vec<f32>,
    person: Option<i64>,
    auto: bool,
    named_at: Option<i64>,
    hidden: bool,
    rejects: Vec<i64>,
}

/// Store what was found in one item by `model`, replacing an earlier scan
/// (of either model) but keeping who was confirmed, "not this person" and
/// "not important": the same face found again (same place in the same
/// frame) carries them over.
pub fn save(conn: &Connection, media: i64, faces: &[FaceIn], model: i64) -> R<usize> {
    let want = fg::dim(model);
    let mut old: Vec<OldFace> = conn
        .prepare("SELECT id, model, frame_ms, x, y, w, h, descriptor, person_id, auto, named_at, hidden FROM faces WHERE media_id = ?")
        .map_err(e)?
        .query_map([media], |r| {
            Ok(OldFace {
                id: r.get(0)?,
                model: r.get(1)?,
                frame_ms: r.get(2)?,
                rect: [r.get::<_, f64>(3)? as f32, r.get::<_, f64>(4)? as f32, r.get::<_, f64>(5)? as f32, r.get::<_, f64>(6)? as f32],
                desc: from_blob(&r.get::<_, Vec<u8>>(7)?),
                person: r.get(8)?,
                auto: r.get::<_, i64>(9)? != 0,
                named_at: r.get(10)?,
                hidden: r.get::<_, i64>(11)? != 0,
                rejects: Vec::new(),
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    for o in old.iter_mut() {
        o.rejects = conn
            .prepare("SELECT folder_id FROM face_rejects WHERE face_id = ?")
            .map_err(e)?
            .query_map([o.id], |r| r.get(0))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)?;
    }
    // Poor faces: a face's height in the item's own pixels (the picture
    // looked at may have been made smaller first).
    let item_h: Option<f64> = conn.query_row("SELECT height FROM media WHERE id = ?", [media], |r| r.get(0)).optional().map_err(e)?.flatten();
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute("DELETE FROM faces WHERE media_id = ?", [media]).map_err(e)?;
    let mut used: HashSet<i64> = HashSet::new();
    let mut n = 0;
    for f in faces.iter().filter(|f| f.descriptor.len() == want && f.descriptor.iter().all(|v| v.is_finite())) {
        let rect = [f.x.clamp(0.0, 1.0), f.y.clamp(0.0, 1.0), f.w.clamp(0.0, 1.0), f.h.clamp(0.0, 1.0)];
        // The same face as before: same frame, mostly the same place (the two
        // models draw their boxes a little differently), or, with the same
        // model, the same fingerprint.
        let same = |o: &OldFace| -> f32 {
            if o.frame_ms != f.frame_ms {
                return 0.0;
            }
            let mut ov = box_iou(o.rect, rect);
            // Boxes of different models: the new box's centre inside the old
            // one, about the same size, counts as the same face.
            let (cx, cy) = (rect[0] + rect[2] / 2.0, rect[1] + rect[3] / 2.0);
            let ratio = (rect[2] * rect[3]) / (o.rect[2] * o.rect[3]).max(1e-6);
            if ov < 0.3 && cx > o.rect[0] && cx < o.rect[0] + o.rect[2] && cy > o.rect[1] && cy < o.rect[1] + o.rect[3] && (0.33..=3.0).contains(&ratio) {
                ov = 0.3;
            }
            let alike = o.model == model && o.desc.len() == want && fg::similarity(model, &o.desc, &f.descriptor) >= 0.8;
            if alike { ov.max(0.5) + 1.0 } else { ov }
        };
        let keep = old.iter().filter(|o| !used.contains(&o.id)).map(|o| (o, same(o))).filter(|(_, s)| *s >= 0.3).max_by(|a, b| a.1.total_cmp(&b.1)).map(|x| x.0);
        let (person, auto, named_at, hidden) = keep.map(|o| (o.person, o.auto, o.named_at, o.hidden)).unwrap_or((None, false, None, false));
        let px = item_h.filter(|v| *v > 0.0).map(|v| v * rect[3] as f64).or(f.px.map(|v| v as f64)).filter(|v| v.is_finite());
        let fin = |v: Option<f32>| v.filter(|x| x.is_finite());
        tx.execute(
            "INSERT INTO faces(media_id, frame_ms, x, y, w, h, score, descriptor, person_id, model, auto, named_at, hidden, px, sharp, turn) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                media, f.frame_ms, rect[0], rect[1], rect[2], rect[3], f.score, to_blob(&f.descriptor), person, model, auto as i64, named_at, hidden as i64,
                px, fin(f.sharp), fin(f.turn)
            ],
        )
        .map_err(e)?;
        let id = tx.last_insert_rowid();
        if let Some(o) = keep {
            used.insert(o.id);
            for p in &o.rejects {
                tx.execute("INSERT OR IGNORE INTO face_rejects(face_id, folder_id) VALUES (?, ?)", [id, *p]).map_err(e)?;
            }
        }
        n += 1;
    }
    tx.execute("UPDATE media SET faces_state = 1, faces_model = ? WHERE id = ?", [model, media]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(n)
}

pub fn failed(conn: &Connection, media: i64, model: i64) -> R<()> {
    conn.execute("UPDATE media SET faces_state = -1, faces_model = ? WHERE id = ?", [model, media]).map_err(e)?;
    Ok(())
}

pub fn set_person(conn: &Connection, folder: i64, on: bool) -> R<()> {
    conn.execute("UPDATE folders SET person = ? WHERE id = ?", params![on as i64, folder]).map_err(e)?;
    Ok(())
}

// ---- which model ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub native: faceid::EngineInfo,
    /// "buffalo_l" (InsightFace), or "none" without the faces pack (nothing is scanned).
    pub active: String,
    /// Items still to be scanned again with the new model.
    pub upgrade_left: i64,
    /// Items already scanned with the new model.
    pub upgraded: i64,
}

pub fn engine_status(conn: &Connection) -> R<EngineStatus> {
    let native = faceid::info();
    let one = |sql: &str| -> R<i64> { conn.query_row(sql, [], |r| r.get(0)).map_err(e) };
    Ok(EngineStatus {
        active: if native.available { "buffalo_l" } else { "none" }.into(),
        upgrade_left: one("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND faces_state = 2 AND faces_model = -1")?,
        upgraded: conn
            .query_row("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND faces_state IN (1, -1) AND faces_model = ?", [ARCFACE], |r| r.get(0))
            .map_err(e)?,
        native,
    })
}

/// The faces pack is there: everything scanned with the built-in model is
/// scanned again with the new one (once). Answers are carried over. While
/// waiting, `faces_model` is -1 ("to be scanned again").
pub fn upgrade(conn: &Connection) -> R<usize> {
    conn.execute(
        "UPDATE media SET faces_state = 2, faces_model = -1 WHERE deleted_at IS NULL AND kind IN ('image','gif','video') \
         AND faces_state IN (1, -1) AND faces_model = 0",
        [],
    )
    .map_err(e)
}

// ---- the analysis, kept between calls -----------------------------------------------------------

struct ModelState {
    graph: Graph,
    last: Option<(u64, Arc<Analysis>)>,
    /// `graph.version` when it was last saved in the library.
    saved_version: u64,
}

struct Cache {
    key: String,
    models: HashMap<i64, ModelState>,
    saved_at: Option<std::time::Instant>,
    /// A model's faces are all gone (its saved graph is to be removed).
    removed: bool,
}

/// The look-alike graphs are saved in the library (table face_graph) at most
/// this often while they change, and when the vault locks, so unlocking
/// doesn't compare every face with every other face again.
const SAVE_GRAPH_EVERY: std::time::Duration = std::time::Duration::from_secs(120);

/// Temporary (never saved) triggers noting faces whose fingerprint changed
/// (a face id can be used again after its face was deleted).
const FACES_DIRTY_SQL: &str = "CREATE TEMP TABLE IF NOT EXISTS faces_dirty (face_id INTEGER PRIMARY KEY); \
    CREATE TEMP TRIGGER IF NOT EXISTS faces_dirty_add AFTER INSERT ON main.faces BEGIN INSERT OR IGNORE INTO faces_dirty VALUES (NEW.id); END; \
    CREATE TEMP TRIGGER IF NOT EXISTS faces_dirty_change AFTER UPDATE OF descriptor, id, model ON main.faces BEGIN \
        INSERT OR IGNORE INTO faces_dirty VALUES (OLD.id); INSERT OR IGNORE INTO faces_dirty VALUES (NEW.id); END; \
    CREATE TEMP TRIGGER IF NOT EXISTS faces_dirty_remove AFTER DELETE ON main.faces BEGIN INSERT OR IGNORE INTO faces_dirty VALUES (OLD.id); END;";

fn has_faces_dirty(conn: &Connection) -> bool {
    conn.query_row("SELECT COUNT(*) FROM temp.sqlite_master WHERE name = 'faces_dirty_remove'", [], |r| r.get::<_, i64>(0)).unwrap_or(0) > 0
}

/// Faces whose fingerprint changed since the last call.
fn take_dirty(conn: &Connection) -> R<Vec<i64>> {
    let ids: Vec<i64> = conn
        .prepare("SELECT face_id FROM temp.faces_dirty")
        .map_err(e)?
        .query_map([], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    if !ids.is_empty() {
        conn.execute_batch("DELETE FROM temp.faces_dirty").map_err(e)?;
    }
    Ok(ids)
}

/// A model's graph from the library (or worked out anew): every fingerprint
/// read in one go, then only faces new since it was saved are compared.
fn load_graph(conn: &Connection, model: i64, present: &HashSet<i64>) -> R<Graph> {
    let mut current: HashMap<i64, Vec<f32>> = HashMap::with_capacity(present.len());
    let mut st = conn.prepare("SELECT id, descriptor FROM faces WHERE model = ?").map_err(e)?;
    for row in st.query_map([model], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))).map_err(e)? {
        let (id, b) = row.map_err(e)?;
        if present.contains(&id) {
            current.insert(id, from_blob(&b));
        }
    }
    let saved: Option<Vec<u8>> = conn.query_row("SELECT data FROM face_graph WHERE model = ?", [model], |r| r.get(0)).optional().map_err(e)?;
    let mut graph = saved.and_then(|b| Graph::from_bytes(model, &b, &mut current)).unwrap_or_else(|| Graph::new(model));
    let mut rest: Vec<(i64, Vec<f32>)> = current.into_iter().collect();
    rest.sort_unstable_by_key(|x| x.0);
    graph.add(rest);
    Ok(graph)
}

/// Save the graphs that changed into the library.
fn save_graphs(lib: &dyn Lib, cache: &mut Cache) -> R<()> {
    let conn = lib.conn();
    let tx = conn.unchecked_transaction().map_err(e)?;
    let models: Vec<i64> = cache.models.keys().copied().collect();
    tx.execute(&format!("DELETE FROM face_graph WHERE model NOT IN ({})", models.iter().map(|m| m.to_string()).chain(["-99".into()]).collect::<Vec<_>>().join(",")), [])
        .map_err(e)?;
    let mut saved = Vec::new();
    for (model, st) in cache.models.iter().filter(|(_, st)| st.graph.version != st.saved_version) {
        tx.execute("INSERT OR REPLACE INTO face_graph(model, data) VALUES (?, ?)", params![model, st.graph.to_bytes()]).map_err(e)?;
        saved.push(*model);
    }
    tx.commit().map_err(e)?;
    for m in saved {
        let st = cache.models.get_mut(&m).expect("listed above");
        st.saved_version = st.graph.version;
    }
    cache.saved_at = Some(std::time::Instant::now());
    cache.removed = false;
    lib.changed();
    Ok(())
}

fn graphs_unsaved(c: &Cache) -> bool {
    c.removed || c.models.values().any(|m| m.graph.version != m.saved_version)
}

/// Save the look-alike graphs now if they changed (the vault is locking).
/// Never waits: if they are being worked on right now, locking goes first
/// (what was saved before is used next time, plus the faces new since).
pub fn keep_graphs(lib: &dyn Lib) {
    let mut cache = match CACHE.try_lock() {
        Ok(c) => c,
        Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return,
    };
    if let Some(c) = cache.as_mut().filter(|c| c.key == lib.key() && graphs_unsaved(c)) {
        let _ = save_graphs(lib, c);
    }
}

/// Work out who is who in the background after unlocking (the graphs are
/// read from the library), so the People page is ready when it is opened.
pub fn warm(lib: &dyn Lib) -> R<()> {
    analyse_all(lib).map(|_| ())
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// Forget everything kept in memory (the vault locked).
pub fn forget_cache() {
    *CACHE.lock().unwrap_or_else(|x| x.into_inner()) = None;
}

/// Everything the analysis needs from the library (no fingerprints).
struct Facts {
    faces: HashMap<i64, Vec<FaceMeta>>,
    people: Vec<PersonMeta>,
    names: HashMap<i64, String>,
    rejects: HashSet<(i64, i64)>,
    not_same: HashSet<(i64, i64)>,
}

fn facts(conn: &Connection) -> R<Facts> {
    let mut faces: HashMap<i64, Vec<FaceMeta>> = HashMap::new();
    let mut st = conn
        .prepare(&format!(
            "SELECT f.id, f.media_id, m.folder_id, f.person_id, f.auto, f.hidden, m.kind, f.model, {} FROM faces f \
             JOIN media m ON m.id = f.media_id WHERE m.deleted_at IS NULL ORDER BY f.id",
            crate::poorfaces::poor_sql("f")
        ))
        .map_err(e)?;
    let rows = st
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(7)?,
                FaceMeta {
                    id: r.get(0)?,
                    media: r.get(1)?,
                    folder: r.get(2)?,
                    person: r.get(3)?,
                    auto: r.get::<_, i64>(4)? != 0,
                    hidden: r.get::<_, i64>(5)? != 0,
                    video: r.get::<_, String>(6)? == "video",
                    poor: r.get::<_, i64>(8)? != 0,
                },
            ))
        })
        .map_err(e)?;
    for row in rows {
        let (model, f) = row.map_err(e)?;
        faces.entry(model).or_default().push(f);
    }
    // The folder tree (light: no covers or counts).
    let folders: Vec<(i64, Option<i64>, String, bool)> = conn
        .prepare("SELECT id, parent_id, name, person FROM folders WHERE deleted_at IS NULL")
        .map_err(e)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let mut kids: HashMap<i64, Vec<i64>> = HashMap::new();
    for (id, parent, _, _) in &folders {
        if let Some(p) = parent {
            kids.entry(*p).or_default().push(*id);
        }
    }
    let mut people = Vec::new();
    let mut names = HashMap::new();
    for (id, _, name, _) in folders.iter().filter(|f| f.3) {
        let mut inside: HashSet<i64> = HashSet::from([*id]);
        let mut todo = vec![*id];
        while let Some(f) = todo.pop() {
            for k in kids.get(&f).into_iter().flatten() {
                if inside.insert(*k) {
                    todo.push(*k);
                }
            }
        }
        people.push(PersonMeta { id: *id, inside });
        names.insert(*id, name.clone());
    }
    let pairs = |sql: &str| -> R<HashSet<(i64, i64)>> {
        conn.prepare(sql)
            .map_err(e)?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(e)?
            .collect::<rusqlite::Result<_>>()
            .map_err(e)
    };
    Ok(Facts { faces, people, names, rejects: pairs("SELECT face_id, folder_id FROM face_rejects")?, not_same: pairs("SELECT a, b FROM face_not_same")? })
}

fn blobs(conn: &Connection, ids: &[i64]) -> R<Vec<(i64, Vec<f32>)>> {
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(500) {
        let sql = format!("SELECT id, descriptor FROM faces WHERE id IN ({})", vec!["?"; chunk.len()].join(","));
        let mut st = conn.prepare(&sql).map_err(e)?;
        let rows = st.query_map(params_from_iter(chunk.iter()), |r| Ok((r.get::<_, i64>(0)?, from_blob(&r.get::<_, Vec<u8>>(1)?)))).map_err(e)?;
        for r in rows {
            out.push(r.map_err(e)?);
        }
    }
    Ok(out)
}

fn fingerprint(model: i64, f: &Facts) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    model.hash(&mut h);
    for x in f.faces.get(&model).map(|v| &v[..]).unwrap_or(&[]) {
        (x.id, x.media, x.folder, if x.auto { None } else { x.person }, x.hidden, x.poor).hash(&mut h);
    }
    let mut people: Vec<(i64, Vec<i64>)> = f.people.iter().map(|p| {
        let mut v: Vec<i64> = p.inside.iter().copied().collect();
        v.sort_unstable();
        (p.id, v)
    }).collect();
    people.sort();
    people.hash(&mut h);
    let mut r: Vec<&(i64, i64)> = f.rejects.iter().collect();
    r.sort();
    r.hash(&mut h);
    let mut n: Vec<&(i64, i64)> = f.not_same.iter().collect();
    n.sort();
    n.hash(&mut h);
    h.finish()
}

/// One model's view of everyone.
pub struct ModelView {
    pub model: i64,
    pub analysis: Arc<Analysis>,
}

/// Bring the neighbour graphs up to date and analyse (only what changed is
/// recomputed). The library is locked only briefly, never during the maths.
fn analyse_all(lib: &dyn Lib) -> R<(Vec<ModelView>, Facts)> {
    let mut cache = CACHE.lock().unwrap_or_else(|x| x.into_inner());
    let key = lib.key();
    let (facts, dirty) = {
        let conn = lib.conn();
        if cache.as_ref().is_none_or(|c| c.key != key) || !has_faces_dirty(&conn) {
            conn.execute_batch(FACES_DIRTY_SQL).map_err(e)?;
            conn.execute_batch("DELETE FROM temp.faces_dirty").map_err(e)?;
            *cache = Some(Cache { key, models: HashMap::new(), saved_at: None, removed: false });
        }
        (facts(&conn)?, take_dirty(&conn)?)
    };
    let cache = cache.as_mut().expect("set above");
    let mut views = Vec::new();
    let mut models: Vec<i64> = facts.faces.keys().copied().collect();
    models.sort_unstable_by(|a, b| b.cmp(a));
    let before = cache.models.len();
    cache.models.retain(|m, _| models.contains(m));
    cache.removed |= cache.models.len() != before;
    let mut unsaved = cache.removed;
    for model in models {
        let metas = &facts.faces[&model];
        let present: HashSet<i64> = metas.iter().map(|f| f.id).collect();
        let st = match cache.models.entry(model) {
            std::collections::hash_map::Entry::Occupied(o) => o.into_mut(),
            std::collections::hash_map::Entry::Vacant(v) => {
                // Changes since it was saved count from 0 (none = nothing to save).
                v.insert(ModelState { graph: load_graph(&lib.conn(), model, &present)?, last: None, saved_version: 0 })
            }
        };
        st.graph.forget(&dirty);
        let missing = st.graph.sync(&present);
        if !missing.is_empty() {
            let loaded = blobs(&lib.conn(), &missing)?;
            st.graph.add(loaded);
        }
        unsaved |= st.graph.version != st.saved_version;
        // The analysis is worked out again when the facts or the graph changed.
        let fp = fingerprint(model, &facts) ^ st.graph.version.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        let analysis = match &st.last {
            Some((f, a)) if *f == fp => a.clone(),
            _ => {
                let a = Arc::new(fg::analyse(&st.graph, &fg::Input { faces: metas, people: &facts.people, rejects: &facts.rejects, not_same: &facts.not_same }));
                st.last = Some((fp, a.clone()));
                a
            }
        };
        views.push(ModelView { model, analysis });
    }
    if unsaved && cache.saved_at.is_none_or(|t| t.elapsed() >= SAVE_GRAPH_EVERY) {
        save_graphs(lib, cache)?;
    }
    Ok((views, facts))
}

/// Name faces automatically (and take back names that no longer fit; keep
/// "not important" people hidden). Returns how many faces changed.
fn apply(conn: &Connection, views: &[ModelView]) -> R<usize> {
    let t = now();
    let tx = conn.unchecked_transaction().map_err(e)?;
    let mut n = 0;
    for v in views {
        for &(face, person, _) in &v.analysis.auto_set {
            n += tx
                .execute(
                    "UPDATE faces SET person_id = ?1, auto = 1, named_at = ?2 WHERE id = ?3 AND hidden = 0 \
                     AND (person_id IS NULL OR (auto = 1 AND person_id <> ?1))",
                    params![person, t, face],
                )
                .map_err(e)?;
        }
        for &face in &v.analysis.auto_clear {
            n += tx.execute("UPDATE faces SET person_id = NULL, auto = 0, named_at = NULL WHERE id = ? AND auto = 1", [face]).map_err(e)?;
        }
        for &face in &v.analysis.hide {
            n += tx.execute("UPDATE faces SET hidden = 1 WHERE id = ? AND hidden = 0 AND (person_id IS NULL OR auto = 1)", [face]).map_err(e)?;
        }
    }
    tx.commit().map_err(e)?;
    Ok(n)
}

/// The automatic pass (after a scan batch, before showing People): returns
/// how many faces changed (the caller saves the library if any did).
pub fn refresh(lib: &dyn Lib) -> R<usize> {
    let (views, _) = analyse_all(lib)?;
    apply(&lib.conn(), &views)
}

// ---- what the People page shows ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub folder: i64,
    pub name: String,
    /// Faces you confirmed (it learns from these).
    pub known: usize,
    /// Faces named automatically.
    pub recognised: usize,
    /// Photos and videos showing them: in their folder, or recognised anywhere.
    pub photos: usize,
    /// Kept for older windows: always 0 now (group photos are suggested).
    pub unsure: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub face_id: i64,
    pub item: Item,
    pub frame_ms: i64,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// 0–100, higher = more alike.
    pub confidence: u32,
    /// Ticked by default (very likely the same person).
    pub sure: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerHint {
    pub photos: usize,
    pub samples: Vec<Suggestion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonGroup {
    pub person: Person,
    /// Unsure faces to tick, most alike first.
    pub suggestions: Vec<Suggestion>,
    pub suggestions_total: usize,
    /// Named automatically, newest first.
    pub recent: Vec<Suggestion>,
    pub recent_total: usize,
    /// "This looks like X in 46 photos" (few confirmed faces yet).
    pub owner: Option<OwnerHint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LooksLike {
    pub folder: i64,
    pub name: String,
    pub confidence: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownGroup {
    /// Stable while the group stays the same (its first face).
    pub key: i64,
    /// Faces in this group (their ids), for naming or hiding.
    pub face_ids: Vec<i64>,
    pub samples: Vec<Suggestion>,
    pub photos: usize,
    pub looks_like: Option<LooksLike>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeHint {
    pub a: i64,
    pub a_name: String,
    pub b: i64,
    pub b_name: String,
    pub confidence: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub people: Vec<PersonGroup>,
    pub unknown: Vec<UnknownGroup>,
    pub unknown_total: usize,
    pub hidden: Vec<UnknownGroup>,
    /// Faces too small, blurry or turned to be trusted, newest first (People → Poor faces).
    pub poor: Vec<PoorFace>,
    pub poor_total: usize,
    pub merges: Vec<MergeHint>,
    pub status: ScanStatus,
    pub engine: EngineStatus,
    /// Faces named automatically just now (the library needs saving).
    #[serde(skip)]
    pub changed: usize,
}

/// How much the People page shows (it asks for more as you scroll).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    /// Per person: how many suggestions.
    #[serde(default)]
    pub more: Vec<(i64, usize)>,
    /// Per person: how many recognised faces.
    #[serde(default)]
    pub recent: Vec<(i64, usize)>,
    /// How many unknown groups.
    #[serde(default)]
    pub groups: Option<usize>,
    /// How many poor faces.
    #[serde(default)]
    pub poor: Option<usize>,
}

/// A poor face (poorfaces.rs) and why it is one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoorFace {
    #[serde(flatten)]
    pub face: Suggestion,
    pub small: bool,
    pub blurry: bool,
    pub turned: bool,
}

const POOR: usize = 60;

/// Poor faces not marked "not important" (newest first, at most `n`):
/// (face, model, px, sharp, turn), and how many there are in all.
#[allow(clippy::type_complexity)]
fn poor_faces(conn: &Connection, n: usize) -> R<(Vec<(i64, i64, Option<f64>, Option<f64>, Option<f64>)>, usize)> {
    let poor = crate::poorfaces::poor_sql("f");
    let from = format!("FROM faces f JOIN media m ON m.id = f.media_id WHERE m.deleted_at IS NULL AND f.hidden = 0 AND {poor}");
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) {from}"), [], |r| r.get(0)).map_err(e)?;
    let rows = conn
        .prepare(&format!("SELECT f.id, f.model, f.px, f.sharp, f.turn {from} ORDER BY f.id DESC LIMIT ?"))
        .map_err(e)?
        .query_map([n as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    Ok((rows, total as usize))
}

const SUGGESTIONS: usize = 24;
const RECENT: usize = 12;
const GROUPS: usize = 24;
const SAMPLES: usize = 6;

/// 0–100 for people: 40 = barely suggested, 66 = ticked, 90 = named on its own.
pub fn confidence(model: i64, s: f32) -> u32 {
    let m = fg::metric(model);
    let top = m.auto.unwrap_or(m.sure + 0.1);
    (40.0 + 50.0 * (s - m.maybe) / (top - m.maybe)).clamp(1.0, 99.0).round() as u32
}

struct Shown {
    media: i64,
    frame_ms: i64,
    rect: [f32; 4],
}

fn face_places(conn: &Connection, ids: &[i64]) -> R<HashMap<i64, Shown>> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(500) {
        let sql = format!("SELECT id, media_id, frame_ms, x, y, w, h FROM faces WHERE id IN ({})", vec!["?"; chunk.len()].join(","));
        let mut st = conn.prepare(&sql).map_err(e)?;
        let rows = st
            .query_map(params_from_iter(chunk.iter()), |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    Shown {
                        media: r.get(1)?,
                        frame_ms: r.get(2)?,
                        rect: [r.get::<_, f64>(3)? as f32, r.get::<_, f64>(4)? as f32, r.get::<_, f64>(5)? as f32, r.get::<_, f64>(6)? as f32],
                    },
                ))
            })
            .map_err(e)?;
        for r in rows {
            let (id, s) = r.map_err(e)?;
            out.insert(id, s);
        }
    }
    Ok(out)
}

/// Turns (face, similarity, model) into what the window shows.
struct Builder {
    places: HashMap<i64, Shown>,
    items: HashMap<i64, Item>,
}

impl Builder {
    fn new(conn: &Connection, faces: &[i64]) -> R<Builder> {
        let places = face_places(conn, faces)?;
        let media: Vec<i64> = places.values().map(|p| p.media).collect::<HashSet<_>>().into_iter().collect();
        let items = library::items_by_ids(conn, &media)?.into_iter().map(|i| (i.id, i)).collect();
        Ok(Builder { places, items })
    }
    fn get(&self, face: i64, s: f32, model: i64) -> Option<Suggestion> {
        let p = self.places.get(&face)?;
        let item = self.items.get(&p.media)?.clone();
        Some(Suggestion {
            face_id: face,
            item,
            frame_ms: p.frame_ms,
            x: p.rect[0],
            y: p.rect[1],
            w: p.rect[2],
            h: p.rect[3],
            confidence: confidence(model, s),
            sure: s >= fg::metric(model).sure,
        })
    }
}

/// Faces of a group, one per photo, for showing.
fn one_per_photo(faces: &[(i64, f32)], places: &HashMap<i64, Shown>, n: usize) -> Vec<(i64, f32)> {
    let mut seen = HashSet::new();
    faces.iter().filter(|(f, _)| places.get(f).is_some_and(|p| seen.insert(p.media))).take(n).copied().collect()
}

fn person_counts(conn: &Connection, p: &PersonMeta) -> R<(usize, usize, usize)> {
    let known: i64 = conn.query_row("SELECT COUNT(*) FROM faces f JOIN media m ON m.id = f.media_id WHERE f.person_id = ? AND f.auto = 0 AND m.deleted_at IS NULL", [p.id], |r| r.get(0)).map_err(e)?;
    let auto: i64 = conn.query_row("SELECT COUNT(*) FROM faces f JOIN media m ON m.id = f.media_id WHERE f.person_id = ? AND f.auto = 1 AND m.deleted_at IS NULL", [p.id], |r| r.get(0)).map_err(e)?;
    let inside: Vec<i64> = p.inside.iter().copied().collect();
    let sql = format!(
        "SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND (folder_id IN ({}) OR id IN (SELECT media_id FROM faces WHERE person_id = ?))",
        vec!["?"; inside.len().max(1)].join(",")
    );
    let mut args: Vec<i64> = if inside.is_empty() { vec![-1] } else { inside };
    args.push(p.id);
    let photos: i64 = conn.query_row(&sql, params_from_iter(args.iter()), |r| r.get(0)).map_err(e)?;
    Ok((known as usize, auto as usize, photos as usize))
}

/// Everything the People page shows.
pub fn review(lib: &dyn Lib, req: &ReviewRequest) -> R<Review> {
    let (views, facts) = analyse_all(lib)?;
    let conn = lib.conn();
    let changed = apply(&conn, &views)?;
    let more: HashMap<i64, usize> = req.more.iter().copied().collect();
    let recent_n: HashMap<i64, usize> = req.recent.iter().copied().collect();
    let groups_n = req.groups.unwrap_or(GROUPS);

    // Which faces will be shown (to look them up once).
    let mut people: Vec<&PersonMeta> = facts.people.iter().collect();
    people.sort_by(|a, b| library::fold(&facts.names[&a.id]).cmp(&library::fold(&facts.names[&b.id])).then(a.id.cmp(&b.id)));
    let mut wanted: Vec<i64> = Vec::new();
    let mut sugg: HashMap<i64, Vec<(i64, f32, i64)>> = HashMap::new();
    for v in &views {
        for (p, list) in &v.analysis.suggestions {
            sugg.entry(*p).or_default().extend(list.iter().map(|(f, s)| (*f, *s, v.model)));
        }
    }
    // Recognised automatically: newest first.
    let mut recent: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    {
        let mut st = conn
            .prepare("SELECT f.person_id, f.id, f.model FROM faces f JOIN media m ON m.id = f.media_id WHERE f.auto = 1 AND f.person_id IS NOT NULL AND m.deleted_at IS NULL ORDER BY f.named_at DESC, f.id DESC")
            .map_err(e)?;
        let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))).map_err(e)?;
        for r in rows {
            let (p, f, m) = r.map_err(e)?;
            recent.entry(p).or_default().push((f, m));
        }
    }
    for p in &people {
        if let Some(l) = sugg.get(&p.id) {
            wanted.extend(l.iter().take(more.get(&p.id).copied().unwrap_or(SUGGESTIONS)).map(|x| x.0));
        }
        if let Some(l) = recent.get(&p.id) {
            wanted.extend(l.iter().take(recent_n.get(&p.id).copied().unwrap_or(RECENT)).map(|x| x.0));
        }
        for v in &views {
            if let Some(o) = v.analysis.owners.get(&p.id) {
                wanted.extend(o.faces.iter().take(3).map(|x| x.0));
            }
        }
    }
    let mut all_groups: Vec<(&fg::Group, i64)> = Vec::new();
    for v in &views {
        all_groups.extend(v.analysis.groups.iter().map(|g| (g, v.model)));
    }
    // Newer model first within the same size.
    all_groups.sort_by(|a, b| a.0.hidden.cmp(&b.0.hidden).then(b.0.photos.cmp(&a.0.photos)).then(b.1.cmp(&a.1)));
    let shown_groups: Vec<&(&fg::Group, i64)> = all_groups.iter().filter(|g| !g.0.hidden).take(groups_n).chain(all_groups.iter().filter(|g| g.0.hidden).take(100)).collect();
    for (g, _) in &shown_groups {
        wanted.extend(g.faces.iter().take(60).map(|x| x.0));
    }
    let (poor_rows, poor_total) = poor_faces(&conn, req.poor.unwrap_or(POOR))?;
    wanted.extend(poor_rows.iter().map(|x| x.0));
    let b = Builder::new(&conn, &wanted)?;

    let mut out_people = Vec::new();
    for p in &people {
        let (known, recognised, photos) = person_counts(&conn, p)?;
        let mut list = sugg.remove(&p.id).unwrap_or_default();
        list.sort_by(|a, b| b.2.cmp(&a.2).then(b.1.total_cmp(&a.1)));
        let total = list.len();
        let suggestions = list.iter().take(more.get(&p.id).copied().unwrap_or(SUGGESTIONS)).filter_map(|(f, s, m)| b.get(*f, *s, *m)).collect();
        let rec = recent.get(&p.id).map(|v| &v[..]).unwrap_or(&[]);
        let recent_list = rec
            .iter()
            .take(recent_n.get(&p.id).copied().unwrap_or(RECENT))
            .filter_map(|(f, m)| b.get(*f, fg::metric(*m).auto.unwrap_or(1.0), *m))
            .collect();
        let owner = views.iter().find_map(|v| {
            v.analysis.owners.get(&p.id).map(|o| OwnerHint { photos: o.photos, samples: o.faces.iter().take(3).filter_map(|(f, s)| b.get(*f, *s, v.model)).collect() })
        });
        out_people.push(PersonGroup {
            person: Person { folder: p.id, name: facts.names[&p.id].clone(), known, recognised, photos, unsure: 0 },
            suggestions,
            suggestions_total: total,
            recent: recent_list,
            recent_total: rec.len(),
            owner,
        });
    }
    let group = |g: &fg::Group, model: i64| -> UnknownGroup {
        let samples = one_per_photo(&g.faces, &b.places, SAMPLES).into_iter().filter_map(|(f, s)| b.get(f, s, model)).collect();
        UnknownGroup {
            key: g.faces.iter().map(|x| x.0).min().unwrap_or(0),
            face_ids: g.faces.iter().map(|x| x.0).collect(),
            samples,
            photos: g.photos,
            looks_like: g.looks_like.and_then(|(p, s)| facts.names.get(&p).map(|n| LooksLike { folder: p, name: n.clone(), confidence: confidence(model, s) })),
        }
    };
    let unknown = shown_groups.iter().filter(|g| !g.0.hidden).map(|g| group(g.0, g.1)).collect();
    let hidden = shown_groups.iter().filter(|g| g.0.hidden).map(|g| group(g.0, g.1)).collect();
    let rule = crate::poorfaces::rule();
    let poor = poor_rows
        .iter()
        .filter_map(|&(f, model, px, sharp, turn)| {
            let mut s = b.get(f, 0.0, model)?;
            (s.confidence, s.sure) = (0, false);
            Some(PoorFace { face: s, small: rule.small(px), blurry: rule.blurry(sharp), turned: rule.turned(turn) })
        })
        .collect();
    let mut merges = Vec::new();
    let mut seen = HashSet::new();
    for v in &views {
        for &(a, bb, s) in &v.analysis.merges {
            if seen.insert((a, bb)) {
                merges.push(MergeHint { a, a_name: facts.names[&a].clone(), b: bb, b_name: facts.names[&bb].clone(), confidence: confidence(v.model, s) });
            }
        }
    }
    Ok(Review {
        people: out_people,
        unknown,
        unknown_total: all_groups.iter().filter(|g| !g.0.hidden).count(),
        hidden,
        poor,
        poor_total,
        merges,
        status: status(&conn)?,
        engine: engine_status(&conn)?,
        changed,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerProposal {
    pub person: i64,
    pub name: String,
    /// One face per photo, most alike first.
    pub faces: Vec<Suggestion>,
}

/// "Find me in this folder": the person who recurs across a person
/// folder's photos (or, once some are confirmed, the faces most like them).
pub fn find_owner(lib: &dyn Lib, person: i64) -> R<Option<OwnerProposal>> {
    // Make sure the graphs are current.
    let (_, facts) = analyse_all(lib)?;
    let Some(name) = facts.names.get(&person).cloned() else {
        return Err("That person's folder no longer exists.".into());
    };
    let cache = CACHE.lock().unwrap_or_else(|x| x.into_inner());
    let Some(c) = cache.as_ref() else { return Ok(None) };
    let mut models: Vec<&i64> = c.models.keys().collect();
    models.sort_unstable_by(|a, b| b.cmp(a));
    for &model in models {
        let st = &c.models[&model];
        let metas = facts.faces.get(&model).map(|v| &v[..]).unwrap_or(&[]);
        let input = fg::Input { faces: metas, people: &facts.people, rejects: &facts.rejects, not_same: &facts.not_same };
        if let Some(o) = fg::find_owner(&st.graph, &input, person) {
            let conn = lib.conn();
            let ids: Vec<i64> = o.faces.iter().map(|x| x.0).collect();
            let b = Builder::new(&conn, &ids)?;
            let faces = o.faces.iter().filter_map(|(f, s)| b.get(*f, *s, model)).collect();
            return Ok(Some(OwnerProposal { person, name, faces }));
        }
    }
    Ok(None)
}

// ---- decisions --------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accepted {
    /// Faces named.
    pub named: usize,
    /// Kept for older windows: nothing is moved or tagged any more.
    pub moved: usize,
    pub tagged: usize,
}

fn person_name(conn: &Connection, person: i64) -> R<String> {
    conn.query_row("SELECT name FROM folders WHERE id = ? AND deleted_at IS NULL", [person], |r| r.get(0))
        .optional()
        .map_err(e)?
        .ok_or_else(|| "That person's folder no longer exists.".into())
}

/// "These faces are this person": confirmed (it learns from them). Files
/// are not moved or changed; the person's page shows them wherever they are.
pub fn accept(conn: &Connection, face_ids: &[i64], person: i64) -> R<Accepted> {
    person_name(conn, person)?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    let t = now();
    let mut n = 0;
    for fid in face_ids {
        n += tx.execute("UPDATE faces SET person_id = ?, auto = 0, named_at = ?, hidden = 0 WHERE id = ?", params![person, t, fid]).map_err(e)?;
        tx.execute("DELETE FROM face_rejects WHERE face_id = ? AND folder_id = ?", [*fid, person]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(Accepted { named: n, moved: 0, tagged: 0 })
}

/// "Not this person": never suggested or named as them again.
pub fn reject(conn: &Connection, face_ids: &[i64], person: i64) -> R<()> {
    let tx = conn.unchecked_transaction().map_err(e)?;
    for fid in face_ids {
        tx.execute("INSERT OR IGNORE INTO face_rejects(face_id, folder_id) VALUES (?, ?)", [*fid, person]).map_err(e)?;
        tx.execute("UPDATE faces SET person_id = NULL, auto = 0, named_at = NULL WHERE id = ? AND person_id = ?", [*fid, person]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(())
}

/// A new person from a group of faces: make their person folder, then name the faces.
pub fn new_person(conn: &Connection, name: &str, parent: Option<i64>, face_ids: &[i64]) -> R<(i64, Accepted)> {
    let id = library::create_folder(conn, parent, name)?;
    set_person(conn, id, true)?;
    let a = accept(conn, face_ids, id)?;
    Ok((id, a))
}

/// "Not important" (or show again): hidden faces are never suggested or
/// named; their group is listed under Hidden people.
pub fn hide(conn: &Connection, face_ids: &[i64], hidden: bool) -> R<usize> {
    let tx = conn.unchecked_transaction().map_err(e)?;
    let mut n = 0;
    for fid in face_ids {
        n += if hidden {
            tx.execute("UPDATE faces SET hidden = 1, person_id = NULL, auto = 0, named_at = NULL WHERE id = ? AND (person_id IS NULL OR auto = 1)", [*fid])
        } else {
            tx.execute("UPDATE faces SET hidden = 0 WHERE id = ?", [*fid])
        }
        .map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(n)
}

/// Two person folders are the same person: `other`'s faces (and "not this
/// person" answers) go to `keep`; `other` stays as an ordinary folder.
pub fn merge_people(conn: &Connection, keep: i64, other: i64) -> R<usize> {
    if keep == other {
        return Err("That's the same person.".into());
    }
    person_name(conn, keep)?;
    person_name(conn, other)?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    let n = tx.execute("UPDATE faces SET person_id = ? WHERE person_id = ?", [keep, other]).map_err(e)?;
    tx.execute("INSERT OR IGNORE INTO face_rejects(face_id, folder_id) SELECT face_id, ? FROM face_rejects WHERE folder_id = ?", [keep, other]).map_err(e)?;
    tx.execute("DELETE FROM face_rejects WHERE folder_id = ?", [other]).map_err(e)?;
    tx.execute("UPDATE folders SET person = 0 WHERE id = ?", [other]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(n)
}

/// "Not the same person": never offered for merging again.
pub fn not_same(conn: &Connection, a: i64, b: i64) -> R<()> {
    conn.execute("INSERT OR IGNORE INTO face_not_same(a, b) VALUES (?, ?)", [a.min(b), a.max(b)]).map_err(e)?;
    Ok(())
}

// ---- after an import --------------------------------------------------------------------------

/// Items imported since `since` (seconds): queued for face scanning when
/// face recognition is in use. Returns the pictures and videos imported.
pub fn after_import(conn: &Connection, since: i64) -> R<Vec<i64>> {
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM media WHERE deleted_at IS NULL AND imported_at >= ? AND kind IN ('image','gif','video') ORDER BY id")
        .map_err(e)?
        .query_map([since], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let in_use: i64 = conn.query_row("SELECT COUNT(*) FROM media WHERE faces_state <> 0", [], |r| r.get(0)).map_err(e)?;
    if in_use == 0 || ids.is_empty() {
        return Ok(Vec::new());
    }
    let tx = conn.unchecked_transaction().map_err(e)?;
    for id in &ids {
        tx.execute("UPDATE media SET faces_state = 2 WHERE id = ? AND faces_state = 0", [id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(ids)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortOffer {
    pub folder: i64,
    pub name: String,
    /// Items showing them that aren't in their folder yet.
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortOffers {
    /// Of these items, still waiting to be scanned.
    pub waiting: usize,
    /// Of these items (pictures, GIFs, videos), never scanned and not queued.
    pub unscanned: usize,
    pub offers: Vec<SortOffer>,
    #[serde(skip)]
    pub changed: usize,
}

/// Fewest items for "47 of these are Baran — put them in his folder?".
pub const SORT_MIN: usize = 3;

/// Of these (newly imported) items: who is in them, and which aren't in
/// that person's folder yet. Runs the automatic naming first.
pub fn sort_offers(lib: &dyn Lib, ids: &[i64]) -> R<SortOffers> {
    offers_for(lib, ids, SORT_MIN)
}

/// "Sort people into their folders": every recognised person with the items
/// showing them anywhere in the vault that aren't in their folder yet.
pub fn sort_all(lib: &dyn Lib) -> R<SortOffers> {
    let ids: Vec<i64> = {
        let conn = lib.conn();
        let mut st = conn
            .prepare("SELECT DISTINCT f.media_id FROM faces f JOIN media m ON m.id = f.media_id WHERE f.person_id IS NOT NULL AND f.hidden = 0 AND m.deleted_at IS NULL ORDER BY f.media_id")
            .map_err(e)?;
        let rows = st.query_map([], |r| r.get(0)).map_err(e)?;
        rows.collect::<rusqlite::Result<Vec<i64>>>().map_err(e)?
    };
    offers_for(lib, &ids, 1)
}

/// "Sort into person folders" for some items only (right-click on items) or one
/// folder and its subfolders (right-click on a folder, or inside it).
pub fn sort_scoped(lib: &dyn Lib, ids: &[i64], folder: Option<i64>) -> R<SortOffers> {
    let ids: Vec<i64> = match folder {
        Some(f) => {
            let conn = lib.conn();
            scannable_ids(&conn, &ScanRequest { folder: Some(f), ..Default::default() })?
        }
        None => ids.to_vec(),
    };
    offers_for(lib, &ids, 1)
}

fn offers_for(lib: &dyn Lib, ids: &[i64], min: usize) -> R<SortOffers> {
    let (views, facts) = analyse_all(lib)?;
    let conn = lib.conn();
    let changed = apply(&conn, &views)?;
    let items = library::items_by_ids(&conn, ids)?;
    let mut waiting = 0;
    let mut unscanned = 0;
    for chunk in ids.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND faces_state = 2 AND id IN ({marks})");
        waiting += conn.query_row(&sql, params_from_iter(chunk.iter()), |r| r.get::<_, i64>(0)).map_err(e)? as usize;
        let sql = format!("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL AND faces_state = 0 AND kind IN ('image', 'gif', 'video') AND id IN ({marks})");
        unscanned += conn.query_row(&sql, params_from_iter(chunk.iter()), |r| r.get::<_, i64>(0)).map_err(e)? as usize;
    }
    let mut offers = Vec::new();
    for p in &facts.people {
        let mut list: Vec<Item> = Vec::new();
        for it in &items {
            if it.folder_id.is_some_and(|f| p.inside.contains(&f)) {
                continue;
            }
            let has: i64 = conn.query_row("SELECT COUNT(*) FROM faces WHERE media_id = ? AND person_id = ?", [it.id, p.id], |r| r.get(0)).map_err(e)?;
            if has > 0 {
                list.push(it.clone());
            }
        }
        if list.len() >= min {
            offers.push(SortOffer { folder: p.id, name: facts.names[&p.id].clone(), items: list });
        }
    }
    offers.sort_by_key(|o| std::cmp::Reverse(o.items.len()));
    Ok(SortOffers { waiting, unscanned, offers, changed })
}

// ---- faces of items ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceBox {
    pub id: i64,
    pub frame_ms: i64,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub person: Option<i64>,
    /// Named automatically (not by you).
    pub auto: bool,
    /// Marked "not important" (only listed when asked for).
    pub hidden: bool,
    /// Too small, blurry or turned to be trusted (poorfaces.rs); the viewer
    /// shows these only when asked. Never set for a face you named.
    pub poor: bool,
}

/// Faces found in one item (for "which one is them?").
pub fn faces_of(conn: &Connection, media: i64) -> R<Vec<FaceBox>> {
    faces_of_with(conn, media, false)
}

/// Faces of one item, the "not important" ones too when `hidden` is set
/// (so one marked by mistake can be fixed).
pub fn faces_of_with(conn: &Connection, media: i64, hidden: bool) -> R<Vec<FaceBox>> {
    let sql = format!(
        "SELECT id, frame_ms, x, y, w, h, person_id, auto, hidden, {} FROM faces WHERE media_id = ?{} ORDER BY x",
        crate::poorfaces::poor_sql("faces"),
        if hidden { "" } else { " AND hidden = 0" }
    );
    conn.prepare(&sql)
        .map_err(e)?
        .query_map([media], |r| {
            Ok(FaceBox {
                id: r.get(0)?,
                frame_ms: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
                w: r.get(4)?,
                h: r.get(5)?,
                person: r.get(6)?,
                auto: r.get::<_, i64>(7)? != 0,
                hidden: r.get::<_, i64>(8)? != 0,
                poor: r.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)
}

/// "Reset and re-scan": forget every face found in these items (names,
/// "not important", "this isn't X" answers) and scan them again from
/// scratch. Returns how many faces were forgotten.
pub fn reset(conn: &Connection, media: &[i64]) -> R<usize> {
    let tx = conn.unchecked_transaction().map_err(e)?;
    let mut n = 0;
    for &m in media {
        tx.execute("DELETE FROM face_rejects WHERE face_id IN (SELECT id FROM faces WHERE media_id = ?1)", [m]).map_err(e)?;
        tx.execute(
            "DELETE FROM face_not_same WHERE a IN (SELECT id FROM faces WHERE media_id = ?1) OR b IN (SELECT id FROM faces WHERE media_id = ?1)",
            [m],
        )
        .map_err(e)?;
        n += tx.execute("DELETE FROM faces WHERE media_id = ?", [m]).map_err(e)?;
        tx.execute("UPDATE media SET faces_state = 2 WHERE id = ? AND kind IN ('image', 'gif', 'video')", [m]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(n)
}

/// Faces of many items at once (for face boxes on the grid), by item.
pub fn faces_of_many(conn: &Connection, media: &[i64]) -> R<Vec<(i64, Vec<FaceBox>)>> {
    let mut out = Vec::new();
    for &m in media.iter().take(2000) {
        let f = faces_of(conn, m)?;
        if !f.is_empty() {
            out.push((m, f));
        }
    }
    Ok(out)
}

/// Photos in a person's folder with several faces and no answer yet (older windows).
pub fn unsure_items(conn: &Connection, person: i64) -> R<Vec<Item>> {
    let folder_items = library::query_items(conn, &library::ItemFilter { folder: Some(Some(person)), recursive: true, ..Default::default() })?;
    let mut out = Vec::new();
    for it in folder_items {
        let faces = faces_of(conn, it.id)?;
        if faces.len() > 1 && !faces.iter().any(|f| f.person == Some(person)) {
            out.push(it);
        }
    }
    Ok(out)
}

/// Every person's average face (per model), from up to 200 of their faces
/// outside `except_media` (named by you first, then the newest).
fn person_centres(conn: &Connection, except_media: i64) -> R<Vec<(i64, i64, Vec<f32>)>> {
    let mut by: HashMap<(i64, i64), Vec<Vec<f32>>> = HashMap::new();
    // Poor faces named automatically don't teach (ones you named do).
    let mut st = conn
        .prepare(&format!(
            "SELECT f.person_id, f.model, f.descriptor FROM faces f JOIN folders d ON d.id = f.person_id JOIN media m ON m.id = f.media_id \
             WHERE d.person = 1 AND d.deleted_at IS NULL AND m.deleted_at IS NULL AND f.hidden = 0 AND f.media_id <> ? AND NOT {} ORDER BY f.auto, f.id DESC",
            crate::poorfaces::poor_sql("f")
        ))
        .map_err(e)?;
    let rows = st.query_map([except_media], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, from_blob(&r.get::<_, Vec<u8>>(2)?)))).map_err(e)?;
    for r in rows {
        let (p, m, d) = r.map_err(e)?;
        let v = by.entry((p, m)).or_default();
        if v.len() < 200 {
            v.push(d);
        }
    }
    Ok(by
        .into_iter()
        .filter_map(|((p, m), v)| fg::centroid(m, &v.iter().map(|x| &x[..]).collect::<Vec<_>>()).map(|c| (p, m, c)))
        .collect())
}

/// "Who is it?" for one face: how likely each person is (0–99, the same
/// scale as the People page), most likely first. Only people it looks at
/// least a little like are listed, and never one you said it isn't.
pub fn face_matches(conn: &Connection, face: i64) -> R<Vec<(i64, u32)>> {
    let Some((media, model, desc)) = conn
        .query_row("SELECT media_id, model, descriptor FROM faces WHERE id = ?", [face], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, from_blob(&r.get::<_, Vec<u8>>(2)?)))
        })
        .optional()
        .map_err(e)?
    else {
        return Ok(Vec::new());
    };
    let rejected: HashSet<i64> = conn
        .prepare("SELECT folder_id FROM face_rejects WHERE face_id = ?")
        .map_err(e)?
        .query_map([face], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let maybe = fg::metric(model).maybe;
    let mut out: Vec<(i64, u32)> = person_centres(conn, media)?
        .into_iter()
        .filter(|c| c.1 == model && c.2.len() == desc.len() && !rejected.contains(&c.0))
        .map(|c| (c.0, fg::similarity(model, &desc, &c.2)))
        .filter(|x| x.1 >= maybe)
        .map(|(p, sim)| (p, confidence(model, sim)))
        .collect();
    out.sort_by_key(|x| std::cmp::Reverse(x.1));
    Ok(out)
}

/// Quick sort: people recognised in an item (1.0), else the person its
/// faces are most like (their average face, same model only), best first.
pub fn person_matches(conn: &Connection, media: i64) -> R<Vec<(i64, f32)>> {
    let mine: Vec<(Option<i64>, i64, Vec<f32>)> = conn
        .prepare(&format!("SELECT f.person_id, f.model, f.descriptor FROM faces f WHERE f.media_id = ? AND f.hidden = 0 AND NOT {}", crate::poorfaces::poor_sql("f")))
        .map_err(e)?
        .query_map([media], |r| Ok((r.get(0)?, r.get(1)?, from_blob(&r.get::<_, Vec<u8>>(2)?))))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let mut out: Vec<(i64, f32)> = Vec::new();
    let unnamed: Vec<&(Option<i64>, i64, Vec<f32>)> = mine.iter().filter(|f| f.0.is_none()).collect();
    for f in &mine {
        if let Some(p) = f.0 {
            out.push((p, 1.0));
        }
    }
    if !unnamed.is_empty() {
        let centres = person_centres(conn, media)?;
        for (_, model, d) in unnamed {
            let best = centres
                .iter()
                .filter(|c| c.1 == *model && c.2.len() == d.len())
                .map(|c| (c.0, fg::similarity(*model, d, &c.2)))
                .max_by(|a, b| a.1.total_cmp(&b.1));
            if let Some((p, s)) = best.filter(|b| b.1 >= fg::metric(*model).maybe) {
                out.push((p, confidence(*model, s) as f32 / 100.0));
            }
        }
    }
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut seen = HashSet::new();
    out.retain(|x| seen.insert(x.0));
    Ok(out)
}

#[cfg(test)]
pub fn person_folders(conn: &Connection) -> R<Vec<i64>> {
    conn.prepare("SELECT id FROM folders WHERE person = 1 AND deleted_at IS NULL")
        .map_err(e)?
        .query_map([], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    fn add(conn: &Connection, folder: Option<i64>) -> i64 {
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (lower(hex(randomblob(16))), ?1, 'image', 'p.jpg', 'jpg', 1, 'h', 0, 't')",
            params![folder],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// An old (face-api) fingerprint near a person's base point.
    fn face(base: f32, wobble: f32) -> FaceIn {
        let mut d = vec![0.0f32; DIM];
        d[0] = base;
        d[1] = wobble;
        FaceIn { frame_ms: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.9, descriptor: d, ..Default::default() }
    }

    /// A new (ArcFace) fingerprint for person `p`, at a place in the picture.
    fn arc(p: usize, seed: u64, x: f32) -> FaceIn {
        let mut v = vec![0.0f32; 512];
        v[p * 5] = 1.0;
        let mut s = seed.wrapping_mul(2862933555777941757).wrapping_add(3037000493);
        for k in v.iter_mut() {
            s = s.wrapping_mul(2862933555777941757).wrapping_add(3037000493);
            *k += ((s >> 33) as f32 / (1u64 << 31) as f32 - 0.5) * 0.06;
        }
        crate::faceid_math::normalize(&mut v);
        FaceIn { frame_ms: 0, x, y: 0.12, w: 0.15, h: 0.2, score: 0.9, descriptor: v, ..Default::default() }
    }

    fn lib(c: Connection) -> Mutex<Connection> {
        Mutex::new(c)
    }

    #[test]
    fn old_model_learns_suggests_and_groups_strangers() {
        let l = lib(db::create_empty().unwrap());
        let (ayse, mehmet, a1, m1, both);
        {
            let c = l.conn();
            ayse = library::create_folder(&c, None, "Ayşe").unwrap();
            mehmet = library::create_folder(&c, None, "Mehmet").unwrap();
            set_person(&c, ayse, true).unwrap();
            set_person(&c, mehmet, true).unwrap();
            for w in [0.0, 0.05] {
                let m = add(&c, Some(ayse));
                save(&c, m, &[face(0.0, w)], FACEAPI).unwrap();
                let f = faces_of(&c, m).unwrap()[0].id;
                accept(&c, &[f], ayse).unwrap();
                let m = add(&c, Some(mehmet));
                save(&c, m, &[face(1.0, w)], FACEAPI).unwrap();
                let f = faces_of(&c, m).unwrap()[0].id;
                accept(&c, &[f], mehmet).unwrap();
            }
            a1 = add(&c, None);
            save(&c, a1, &[face(0.02, 0.1)], FACEAPI).unwrap();
            m1 = add(&c, None);
            save(&c, m1, &[face(0.98, 0.5)], FACEAPI).unwrap(); // a little less alike
            both = add(&c, None);
            save(&c, both, &[face(0.0, 0.0), face(1.0, 0.0)], FACEAPI).unwrap();
            for w in [0.0, 0.1, 0.2] {
                let s = add(&c, None);
                save(&c, s, &[face(3.0, w)], FACEAPI).unwrap();
            }
        }
        let r = review(&l, &ReviewRequest::default()).unwrap();
        let ga = r.people.iter().find(|g| g.person.folder == ayse).unwrap();
        let gm = r.people.iter().find(|g| g.person.folder == mehmet).unwrap();
        assert_eq!(ga.person.known, 2);
        assert!(ga.recent.is_empty(), "the old model never names on its own");
        assert_eq!(ga.suggestions.iter().map(|s| s.item.id).collect::<HashSet<_>>(), HashSet::from([a1, both]));
        assert!(ga.suggestions.iter().all(|s| s.sure));
        assert_eq!(gm.suggestions.iter().map(|s| s.item.id).collect::<HashSet<_>>(), HashSet::from([m1, both]));
        assert!(gm.suggestions.iter().any(|s| s.item.id == m1 && !s.sure), "less alike = suggested but not ticked");
        assert_eq!(r.unknown.len(), 1);
        assert_eq!(r.unknown[0].photos, 3);
        assert_eq!(r.engine.active, if faceid::available() { "buffalo_l" } else { "none" });

        // Accepting names the faces; nothing is moved or tagged.
        let fa: Vec<i64> = ga.suggestions.iter().map(|s| s.face_id).collect();
        let a = accept(&l.conn(), &fa, ayse).unwrap();
        assert_eq!((a.named, a.moved, a.tagged), (2, 0, 0));
        assert_eq!(library::get_item(&l.conn(), both).unwrap().folder_id, None);
        let fm: Vec<i64> = review(&l, &ReviewRequest::default()).unwrap().people.iter().find(|g| g.person.folder == mehmet).unwrap().suggestions.iter().map(|s| s.face_id).collect();
        accept(&l.conn(), &fm, mehmet).unwrap();
        // A person's page (and search) finds them everywhere.
        let found: HashSet<i64> = library::query_items(&l.conn(), &library::ItemFilter { people: vec![mehmet], ..Default::default() }).unwrap().into_iter().map(|i| i.id).collect();
        assert!(found.contains(&m1) && found.contains(&both), "{found:?}");
        let both_people = library::query_items(&l.conn(), &library::ItemFilter { people: vec![mehmet, ayse], ..Default::default() }).unwrap();
        assert_eq!(both_people.iter().map(|i| i.id).collect::<Vec<_>>(), vec![both]);
        let r = review(&l, &ReviewRequest::default()).unwrap();
        assert_eq!(r.people.iter().find(|g| g.person.folder == mehmet).unwrap().person.photos, 4);

        // "Not this person" sticks, even after scanning again.
        let s = add(&l.conn(), None);
        save(&l.conn(), s, &[face(0.03, 0.0)], FACEAPI).unwrap();
        let f = review(&l, &ReviewRequest::default()).unwrap().people.iter().find(|g| g.person.folder == ayse).unwrap().suggestions[0].face_id;
        reject(&l.conn(), &[f], ayse).unwrap();
        save(&l.conn(), s, &[face(0.03, 0.0)], FACEAPI).unwrap();
        assert!(review(&l, &ReviewRequest::default()).unwrap().people.iter().find(|g| g.person.folder == ayse).unwrap().suggestions.is_empty());

        // The stranger becomes a person.
        let ids = review(&l, &ReviewRequest::default()).unwrap().unknown[0].face_ids.clone();
        let (pid, acc) = new_person(&l.conn(), "Zeynep", None, &ids).unwrap();
        assert_eq!(acc.named, 3);
        assert!(person_folders(&l.conn()).unwrap().contains(&pid));
        assert_eq!(review(&l, &ReviewRequest::default()).unwrap().people.iter().find(|g| g.person.folder == pid).unwrap().person.photos, 3);
    }

    #[test]
    fn new_model_names_automatically_and_finds_the_folder_owner() {
        let l = lib(db::create_empty().unwrap());
        let (baran, elsewhere, group);
        {
            let c = l.conn();
            baran = library::create_folder(&c, None, "Baran").unwrap();
            set_person(&c, baran, true).unwrap();
            // His folder: him in every photo, friends in some (group photos).
            for k in 0..8u64 {
                let m = add(&c, Some(baran));
                let mut fs = vec![arc(0, k, 0.1)];
                if k % 2 == 0 {
                    fs.push(arc(1, 100 + k, 0.5));
                }
                save(&c, m, &fs, ARCFACE).unwrap();
            }
            elsewhere = add(&c, None);
            save(&c, elsewhere, &[arc(0, 50, 0.3)], ARCFACE).unwrap();
            group = add(&c, None);
            save(&c, group, &[arc(1, 60, 0.1), arc(0, 61, 0.6)], ARCFACE).unwrap();
        }
        // Nothing confirmed yet: "This looks like Baran in 8 photos".
        let r = review(&l, &ReviewRequest::default()).unwrap();
        let g = &r.people[0];
        assert_eq!(g.owner.as_ref().map(|o| o.photos), Some(8));
        assert!(g.recent.is_empty());
        let o = find_owner(&l, baran).unwrap().unwrap();
        assert_eq!(o.faces.len(), 8);
        assert!(o.faces.iter().all(|f| f.x < 0.2), "his face, not the friend's");
        // The friend (in five photos) is a group of their own.
        assert_eq!(r.unknown.len(), 1);
        assert_eq!(r.unknown[0].photos, 5);

        // Confirm once: from now on he is recognised everywhere by himself.
        let ids: Vec<i64> = o.faces.iter().map(|f| f.face_id).collect();
        accept(&l.conn(), &ids, baran).unwrap();
        let changed = refresh(&l).unwrap();
        assert_eq!(changed, 2, "him alone and in the group photo");
        let r = review(&l, &ReviewRequest::default()).unwrap();
        let g = &r.people[0];
        assert!(g.owner.is_none());
        assert_eq!(g.recent_total, 2);
        assert_eq!(g.person.photos, 10);
        assert_eq!(g.person.recognised, 2);
        let found: HashSet<i64> = library::query_items(&l.conn(), &library::ItemFilter { people: vec![baran], ..Default::default() }).unwrap().into_iter().map(|i| i.id).collect();
        assert!(found.contains(&elsewhere) && found.contains(&group));

        // Undo one: "not Baran" — it stays undone.
        let wrong = g.recent.iter().find(|s| s.item.id == group).unwrap().face_id;
        reject(&l.conn(), &[wrong], baran).unwrap();
        refresh(&l).unwrap();
        let r = review(&l, &ReviewRequest::default()).unwrap();
        assert_eq!(r.people[0].recent_total, 1);

        // Scanning again (e.g. the model is updated) keeps all of it.
        let c = l.conn();
        save(&c, group, &[arc(1, 60, 0.1), arc(0, 61, 0.61)], ARCFACE).unwrap();
        let again = faces_of(&c, group).unwrap();
        let his = again.iter().find(|f| f.x > 0.5).unwrap();
        assert_eq!(his.person, None);
        let rejected: i64 = c.query_row("SELECT COUNT(*) FROM face_rejects WHERE face_id = ? AND folder_id = ?", [his.id, baran], |r| r.get(0)).unwrap();
        assert_eq!(rejected, 1);
        drop(c);

        // Hiding a group, and showing it again.
        let r = review(&l, &ReviewRequest::default()).unwrap();
        let ids = r.unknown[0].face_ids.clone();
        hide(&l.conn(), &ids, true).unwrap();
        let r = review(&l, &ReviewRequest::default()).unwrap();
        assert!(r.unknown.is_empty());
        assert_eq!(r.hidden.len(), 1);
        hide(&l.conn(), &r.hidden[0].face_ids, false).unwrap();
        assert_eq!(review(&l, &ReviewRequest::default()).unwrap().unknown.len(), 1);
    }

    #[test]
    fn who_is_it_lists_the_likeliest_person_first() {
        let c = db::create_empty().unwrap();
        let ayse = library::create_folder(&c, None, "Ayşe").unwrap();
        let baran = library::create_folder(&c, None, "Baran").unwrap();
        set_person(&c, ayse, true).unwrap();
        set_person(&c, baran, true).unwrap();
        // Two known photos of each.
        for (p, who) in [(0, ayse), (1, baran)] {
            for seed in 0..2 {
                let m = add(&c, None);
                save(&c, m, &[arc(p, 10 * p as u64 + seed, 0.2)], ARCFACE).unwrap();
                let f = faces_of(&c, m).unwrap()[0].id;
                accept(&c, &[f], who).unwrap();
            }
        }
        // A new photo of Baran.
        let m = add(&c, None);
        save(&c, m, &[arc(1, 99, 0.4)], ARCFACE).unwrap();
        let f = faces_of(&c, m).unwrap()[0].id;
        let list = face_matches(&c, f).unwrap();
        assert_eq!(list.first().map(|x| x.0), Some(baran), "{list:?}");
        assert!(list.iter().all(|x| x.0 != ayse), "not like Ayşe at all: {list:?}");
        assert!(list[0].1 >= 66, "{list:?}");
        // Said it isn't Baran: not offered any more.
        reject(&c, &[f], baran).unwrap();
        assert!(face_matches(&c, f).unwrap().iter().all(|x| x.0 != baran));
        assert!(face_matches(&c, 123_456).unwrap().is_empty());
    }

    #[test]
    fn reset_forgets_every_face_and_scans_again() {
        let l = lib(db::create_empty().unwrap());
        let c = l.conn();
        let p = library::create_folder(&c, None, "P").unwrap();
        set_person(&c, p, true).unwrap();
        let m = add(&c, None);
        queue(&c, &ScanRequest { ids: vec![m], folder: None, all: false, again: false }).unwrap();
        let mut left = face(0.0, 0.0);
        left.x = 0.1;
        let mut right = face(2.0, 0.0);
        right.x = 0.6;
        save(&c, m, &[left.clone(), right.clone()], FACEAPI).unwrap();
        let f = faces_of(&c, m).unwrap();
        accept(&c, &[f[0].id], p).unwrap();
        hide(&c, &[f[1].id], true).unwrap();
        assert_eq!(faces_of(&c, m).unwrap().len(), 1);
        let all = faces_of_with(&c, m, true).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|x| x.hidden));
        assert_eq!(reset(&c, &[m]).unwrap(), 2);
        assert!(faces_of_with(&c, m, true).unwrap().is_empty());
        assert_eq!(needed(&c, 10).unwrap().len(), 1, "queued again");
        // Found again: nobody is named or hidden any more.
        save(&c, m, &[left, right], FACEAPI).unwrap();
        let again = faces_of_with(&c, m, true).unwrap();
        assert_eq!(again.len(), 2);
        assert!(again.iter().all(|x| x.person.is_none() && !x.hidden));
    }

    #[test]
    fn upgrading_to_the_new_model_keeps_answers() {
        let l = lib(db::create_empty().unwrap());
        let c = l.conn();
        let p = library::create_folder(&c, None, "P").unwrap();
        set_person(&c, p, true).unwrap();
        let q = library::create_folder(&c, None, "Q").unwrap();
        set_person(&c, q, true).unwrap();
        let m = add(&c, None);
        assert_eq!(queue(&c, &ScanRequest { ids: vec![m], folder: None, all: false, again: false }).unwrap(), 1);
        assert_eq!(needed(&c, 10).unwrap().len(), 1);
        let mut left = face(0.0, 0.0);
        left.x = 0.1;
        let mut right = face(2.0, 0.0);
        right.x = 0.6;
        save(&c, m, &[left, right], FACEAPI).unwrap();
        assert!(needed(&c, 10).unwrap().is_empty());
        let old = faces_of(&c, m).unwrap();
        accept(&c, &[old[0].id], p).unwrap();
        reject(&c, &[old[1].id], q).unwrap();
        hide(&c, &[old[1].id], true).unwrap();
        // Scanning again with the old model keeps who it was.
        assert_eq!(queue(&c, &ScanRequest { ids: vec![m], folder: None, all: false, again: false }).unwrap(), 0);
        // The faces pack arrives: everything is scanned again with the new model.
        assert_eq!(upgrade(&c).unwrap(), 1);
        assert_eq!(upgrade(&c).unwrap(), 0, "already waiting");
        assert_eq!(engine_status(&c).unwrap().upgrade_left, 1);
        // The new model draws slightly different boxes.
        save(&c, m, &[arc(0, 1, 0.12), arc(3, 2, 0.58)], ARCFACE).unwrap();
        assert_eq!(upgrade(&c).unwrap(), 0, "done once");
        let new = faces_of(&c, m).unwrap();
        assert_eq!(new.len(), 1, "the hidden one isn't listed");
        assert_eq!(new[0].person, Some(p));
        let (model, hidden): (i64, i64) = c.query_row("SELECT model, hidden FROM faces WHERE media_id = ? AND x > 0.5", [m], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((model, hidden), (ARCFACE, 1));
        let rej: i64 = c.query_row("SELECT COUNT(*) FROM face_rejects r JOIN faces f ON f.id = r.face_id WHERE f.media_id = ? AND r.folder_id = ?", [m, q], |r| r.get(0)).unwrap();
        assert_eq!(rej, 1);
        let fm: i64 = c.query_row("SELECT faces_model FROM media WHERE id = ?", [m], |r| r.get(0)).unwrap();
        assert_eq!(fm, ARCFACE);
        // Wrong lengths are refused.
        assert_eq!(save(&c, m, &[face(0.0, 0.0)], ARCFACE).unwrap(), 0);
        assert_eq!(status(&c).unwrap().faces, 0);
    }

    #[test]
    fn merging_people_and_sorting_after_an_import() {
        let l = lib(db::create_empty().unwrap());
        let (a, b, news);
        {
            let c = l.conn();
            a = library::create_folder(&c, None, "Anna").unwrap();
            b = library::create_folder(&c, None, "Anne").unwrap();
            set_person(&c, a, true).unwrap();
            set_person(&c, b, true).unwrap();
            for (k, folder) in [(1u64, a), (2, a), (3, b)] {
                let m = add(&c, Some(folder));
                save(&c, m, &[arc(2, k, 0.3)], ARCFACE).unwrap();
                let f = faces_of(&c, m).unwrap()[0].id;
                accept(&c, &[f], folder).unwrap();
            }
        }
        let r = review(&l, &ReviewRequest::default()).unwrap();
        assert_eq!(r.merges.len(), 1);
        assert_eq!((r.merges[0].a, r.merges[0].b), (a, b));
        not_same(&l.conn(), b, a).unwrap();
        assert!(review(&l, &ReviewRequest::default()).unwrap().merges.is_empty());
        merge_people(&l.conn(), a, b).unwrap();
        let r = review(&l, &ReviewRequest::default()).unwrap();
        assert_eq!(r.people.len(), 1);
        assert_eq!(r.people[0].person.known, 3);

        // An import: face scanning is in use, so the new items are queued.
        {
            let c = l.conn();
            c.execute("UPDATE media SET imported_at = 100", []).unwrap();
            let mut v = vec![];
            for _ in 0..4 {
                let m = add(&c, None);
                c.execute("UPDATE media SET imported_at = 500 WHERE id = ?", [m]).unwrap();
                v.push(m);
            }
            news = v;
            assert_eq!(after_import(&c, 400).unwrap(), news);
            assert_eq!(needed(&c, 10).unwrap().len(), 4);
        }
        let o = sort_offers(&l, &news).unwrap();
        assert_eq!(o.waiting, 4);
        assert!(o.offers.is_empty());
        {
            let c = l.conn();
            for (k, m) in news.iter().enumerate() {
                let fs = if k < 3 { vec![arc(2, 40 + k as u64, 0.4)] } else { vec![arc(4, 9, 0.4)] };
                save(&c, *m, &fs, ARCFACE).unwrap();
            }
        }
        let o = sort_offers(&l, &news).unwrap();
        assert_eq!(o.waiting, 0);
        assert_eq!(o.offers.len(), 1);
        assert_eq!(o.offers[0].folder, a);
        assert_eq!(o.offers[0].items.len(), 3);
        // "Sort people into their folders" finds the same, from the whole vault.
        let all = sort_all(&l).unwrap();
        assert_eq!(all.offers.len(), 1);
        assert_eq!(all.offers[0].folder, a);
        assert!(news[..3].iter().all(|m| all.offers[0].items.iter().any(|it| it.id == *m)));
        // …and for chosen items only (right-click), even a single one.
        let one = sort_scoped(&l, &news[..1], None).unwrap();
        assert_eq!((one.offers.len(), one.offers[0].items.len(), one.unscanned, one.waiting), (1, 1, 0, 0));
        assert!(sort_scoped(&l, &news[3..], None).unwrap().offers.is_empty());
        // Quick sort's suggestion for one of them.
        assert_eq!(person_matches(&l.conn(), news[0]).unwrap()[0].0, a);
        assert!(person_matches(&l.conn(), news[3]).unwrap().is_empty());
    }

    /// The whole thing with the real models on real photos (see faceid.rs
    /// real_faces for what is needed): a person folder with group photos,
    /// "find me", automatic naming elsewhere, grouping of strangers.
    /// MV_FACES=… MV_FACES_PHOTOS=… cargo test real_people -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_people() {
        let dir = std::path::PathBuf::from(std::env::var("MV_FACES_PHOTOS").expect("MV_FACES_PHOTOS"));
        let l = lib(db::create_empty().unwrap());
        let mut ids: HashMap<String, i64> = HashMap::new();
        let (baran, kit);
        {
            let c = l.conn();
            baran = library::create_folder(&c, None, "Baran").unwrap();
            set_person(&c, baran, true).unwrap();
            kit = library::create_folder(&c, None, "Kit").unwrap();
            set_person(&c, kit, true).unwrap();
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for n in &names {
            let Ok(img) = image::open(dir.join(n)) else { continue };
            let img = img.to_rgba8();
            let req = faceid::DetectRequest { width: img.width() as usize, height: img.height() as usize, frame_ms: 0 };
            let faces = faceid::detect_faces(&req, img.as_raw()).unwrap();
            // Baran's folder: his portraits and a photo with a friend; Kit's: one photo.
            let folder = if n.contains("obama") && !n.starts_with("test_") || n == "examples_two_people.jpg" {
                Some(baran)
            } else if n == "kit_harington_john1.jpeg" {
                Some(kit)
            } else {
                None
            };
            let c = l.conn();
            let m = add(&c, folder);
            save(&c, m, &faces, ARCFACE).unwrap();
            ids.insert(n.clone(), m);
        }
        let who = |m: i64, p: i64| -> bool {
            l.conn().query_row("SELECT COUNT(*) FROM faces WHERE media_id = ? AND person_id = ?", [m, p], |r| r.get::<_, i64>(0)).unwrap() > 0
        };
        let r = review(&l, &ReviewRequest::default()).unwrap();
        let g = r.people.iter().find(|g| g.person.folder == baran).unwrap();
        eprintln!("Baran owner: {:?}", g.owner.as_ref().map(|o| o.photos));
        let o = find_owner(&l, baran).unwrap().expect("owner of Baran's folder");
        for f in &o.faces {
            eprintln!("  owner face in {} ({}%)", names.iter().find(|n| ids[*n] == f.item.id).unwrap(), f.confidence);
        }
        assert_eq!(o.faces.len(), 5, "four portraits and the photo with a friend");
        assert!(!r.people.iter().find(|g| g.person.folder == kit).unwrap().owner.is_some(), "one photo isn't enough");
        for u in &r.unknown {
            let photos: Vec<&String> = u.samples.iter().map(|s| names.iter().find(|n| ids[*n] == s.item.id).unwrap()).collect();
            eprintln!("group of {} photos: {photos:?}", u.photos);
        }
        // Confirm once: then he is named in the other photos by himself.
        let faces: Vec<i64> = o.faces.iter().map(|f| f.face_id).collect();
        accept(&l.conn(), &faces, baran).unwrap();
        let n = refresh(&l).unwrap();
        eprintln!("named automatically: {n}");
        assert!(who(ids["test_obama1.jpg"], baran) && who(ids["test_obama_and_biden.jpg"], baran));
        for (name, m) in &ids {
            if !name.contains("obama") && !name.contains("two_people") {
                assert!(!who(*m, baran), "{name} isn't Baran");
            }
        }
        // Kit: name him once in his folder; the others are suggested (one confirmed face isn't enough to name on its own).
        let kf = faces_of(&l.conn(), ids["kit_harington_john1.jpeg"]).unwrap()[0].id;
        accept(&l.conn(), &[kf], kit).unwrap();
        let r = review(&l, &ReviewRequest::default()).unwrap();
        let gk = r.people.iter().find(|g| g.person.folder == kit).unwrap();
        let sugg: Vec<(&String, u32, bool)> = gk.suggestions.iter().map(|s| (names.iter().find(|n| ids[*n] == s.item.id).unwrap(), s.confidence, s.sure)).collect();
        eprintln!("Kit suggestions: {sugg:?}");
        assert_eq!(sugg.len(), 2);
        assert!(sugg.iter().all(|s| s.0.contains("john") && s.2));
        // Strangers: Biden (4 photos, one in Baran's folder) is a group of his own.
        let biden = r.unknown.iter().find(|u| u.samples.iter().any(|s| s.item.id == ids["biden_biden.jpg"])).expect("Biden's group");
        assert_eq!(biden.photos, 4);
        for u in &r.unknown {
            let photos: Vec<&String> = u.samples.iter().map(|s| names.iter().find(|n| ids[*n] == s.item.id).unwrap()).collect();
            eprintln!("group of {} photos: {photos:?}", u.photos);
        }
        // Accepting the group names all four, so Ayşe = Biden's page has them all.
        let (ayse, _) = new_person(&l.conn(), "Ayşe", None, &biden.face_ids).unwrap();
        let found = library::query_items(&l.conn(), &library::ItemFilter { people: vec![ayse, baran], ..Default::default() }).unwrap();
        let both: HashSet<i64> = found.iter().map(|i| i.id).collect();
        assert_eq!(both, HashSet::from([ids["examples_two_people.jpg"], ids["test_obama_and_biden.jpg"]]), "the two of them together");
        assert!(review(&l, &ReviewRequest::default()).unwrap().merges.is_empty());
    }

    // ---- poor faces tests (begin) ----
    fn poor(mut f: FaceIn, px: Option<f32>, sharp: Option<f32>, turn: Option<f32>) -> FaceIn {
        (f.px, f.sharp, f.turn) = (px, sharp, turn);
        f
    }

    #[test]
    fn poor_faces_are_never_named_or_learned_from_unless_you_name_them() {
        use crate::poorfaces::{PoorRule, set_test_rule};
        let strict = PoorRule { min_px: 40.0, min_sharp: 5.0, max_turn: 60.0 };
        set_test_rule(Some(strict));
        let l = lib(db::create_empty().unwrap());
        let (baran, ana, turned, small_kit, good_kit, strangers);
        {
            let c = l.conn();
            baran = library::create_folder(&c, None, "Baran").unwrap();
            set_person(&c, baran, true).unwrap();
            for k in 0..3u64 {
                let m = add(&c, None);
                save(&c, m, &[poor(arc(0, k, 0.2), Some(300.0), Some(80.0), Some(5.0))], ARCFACE).unwrap();
                accept(&c, &[faces_of(&c, m).unwrap()[0].id], baran).unwrap();
            }
            // Baran, but turned away.
            let m = add(&c, None);
            save(&c, m, &[poor(arc(0, 10, 0.2), Some(300.0), Some(80.0), Some(75.0))], ARCFACE).unwrap();
            turned = faces_of(&c, m).unwrap()[0].id;
            // Someone tiny in four photos (in Ana's folder: no owner is found from them).
            ana = library::create_folder(&c, None, "Ana").unwrap();
            set_person(&c, ana, true).unwrap();
            let mut v = Vec::new();
            for k in 0..4u64 {
                let m = add(&c, Some(ana));
                save(&c, m, &[poor(arc(2, 20 + k, 0.5), Some(18.0), None, None)], ARCFACE).unwrap();
                v.push(faces_of(&c, m).unwrap()[0].id);
            }
            strangers = v;
            // Kit: one blurry face, one fine one.
            let m = add(&c, None);
            save(&c, m, &[poor(arc(1, 30, 0.2), Some(200.0), Some(1.0), Some(3.0))], ARCFACE).unwrap();
            small_kit = faces_of(&c, m).unwrap()[0].id;
            let m = add(&c, None);
            save(&c, m, &[poor(arc(1, 31, 0.2), Some(200.0), Some(90.0), Some(3.0))], ARCFACE).unwrap();
            good_kit = faces_of(&c, m).unwrap()[0].id;
        }
        let measures = |id: i64| -> (Option<f64>, Option<f64>, Option<f64>) {
            l.conn().query_row("SELECT px, sharp, turn FROM faces WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap()
        };
        let person_of = |id: i64| -> (Option<i64>, bool) {
            l.conn().query_row("SELECT person_id, auto FROM faces WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0))).unwrap()
        };
        let before = measures(turned);

        // Never named automatically, suggested, grouped or offered as a folder owner.
        refresh(&l).unwrap();
        assert_eq!(person_of(turned), (None, false));
        let r = review(&l, &ReviewRequest::default()).unwrap();
        let gb = r.people.iter().find(|g| g.person.folder == baran).unwrap();
        assert!(gb.suggestions.iter().all(|s| s.face_id != turned) && gb.recent.is_empty());
        assert!(r.unknown.iter().all(|u| u.face_ids.iter().all(|f| !strangers.contains(f))), "tiny faces aren't a group");
        assert!(r.people.iter().find(|g| g.person.folder == ana).unwrap().owner.is_none());
        // They wait under Poor faces, with why.
        let ids: HashSet<i64> = r.poor.iter().map(|p| p.face.face_id).collect();
        assert_eq!(r.poor_total, 6);
        assert!(ids.contains(&turned) && ids.contains(&small_kit) && strangers.iter().all(|f| ids.contains(f)));
        let p = r.poor.iter().find(|p| p.face.face_id == turned).unwrap();
        assert!(p.turned && !p.small && !p.blurry);
        assert!(r.poor.iter().find(|p| p.face.face_id == small_kit).unwrap().blurry);
        // The viewer is told which faces are poor.
        let media_of = |id: i64| -> i64 { l.conn().query_row("SELECT media_id FROM faces WHERE id = ?", [id], |r| r.get(0)).unwrap() };
        // (Looked up first: the library is locked by one caller at a time.)
        let (m_turned, m_good, m_small) = (media_of(turned), media_of(good_kit), media_of(small_kit));
        assert!(faces_of_with(&l.conn(), m_turned, false).unwrap()[0].poor);
        assert!(!faces_of_with(&l.conn(), m_good, false).unwrap()[0].poor);
        // Quick sort doesn't go by a poor face either.
        assert!(person_matches(&l.conn(), m_turned).unwrap().is_empty());

        // Moving the sliders re-sorts at once: nothing stored changes but the name.
        set_test_rule(Some(PoorRule { max_turn: 90.0, ..strict }));
        refresh(&l).unwrap();
        assert_eq!(person_of(turned), (Some(baran), true), "now named automatically");
        assert_eq!(measures(turned), before);
        assert_eq!(review(&l, &ReviewRequest::default()).unwrap().poor_total, 5);
        assert!(!person_matches(&l.conn(), m_turned).unwrap().is_empty());
        set_test_rule(Some(strict));
        refresh(&l).unwrap();
        assert_eq!(person_of(turned), (None, false), "the automatic name is taken back");
        assert_eq!(measures(turned), before);

        // Named by you, a poor face counts: it isn't poor any more and teaches the app.
        assert!(face_matches(&l.conn(), good_kit).unwrap().is_empty(), "nobody known looks like Kit yet");
        let (kit, _) = new_person(&l.conn(), "Kit", None, &[small_kit]).unwrap();
        assert!(!faces_of_with(&l.conn(), m_small, false).unwrap()[0].poor);
        assert_eq!(face_matches(&l.conn(), good_kit).unwrap().first().map(|x| x.0), Some(kit));
        let r = review(&l, &ReviewRequest::default()).unwrap();
        assert!(r.poor.iter().all(|p| p.face.face_id != small_kit));
        assert_eq!(r.people.iter().find(|g| g.person.folder == kit).unwrap().person.known, 1);
        // You named it: stricter settings never take that away.
        set_test_rule(Some(PoorRule { min_sharp: 1000.0, ..strict }));
        refresh(&l).unwrap();
        assert_eq!(person_of(small_kit), (Some(kit), false));
        set_test_rule(None);
    }

    #[test]
    fn saving_keeps_poor_face_measures_in_the_items_own_pixels() {
        let c = db::create_empty().unwrap();
        let m = add(&c, None);
        c.execute("UPDATE media SET height = 2000 WHERE id = ?", [m]).unwrap();
        save(&c, m, &[poor(arc(0, 1, 0.2), Some(9.0), Some(12.5), Some(33.0))], ARCFACE).unwrap();
        let (px, sharp, turn): (f64, f64, f64) = c.query_row("SELECT px, sharp, turn FROM faces", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert!((px - 400.0).abs() < 0.01, "0.2 of 2000 px, not the smaller picture looked at: {px}");
        assert_eq!((sharp, turn), (12.5, 33.0));
        // Without the item's size, the height measured when found.
        let m = add(&c, None);
        save(&c, m, &[poor(arc(0, 2, 0.2), Some(9.0), None, None)], ARCFACE).unwrap();
        let px: f64 = c.query_row("SELECT px FROM faces WHERE media_id = ?", [m], |r| r.get(0)).unwrap();
        assert_eq!(px, 9.0);
        // A window that sends no measures (older) still saves.
        let j: FaceIn = serde_json::from_str(r#"{"x":0.1,"y":0.1,"w":0.2,"h":0.2,"score":0.9,"descriptor":[]}"#).unwrap();
        assert_eq!((j.px, j.sharp, j.turn), (None, None, None));
    }
    // ---- poor faces tests (end) ----

    #[test]
    fn confidence_scale() {
        assert_eq!(confidence(ARCFACE, fg::ARCFACE.maybe), 40);
        assert_eq!(confidence(ARCFACE, fg::ARCFACE.auto.unwrap()), 90);
        assert!(confidence(ARCFACE, fg::ARCFACE.sure) > 60);
        assert_eq!(confidence(ARCFACE, 2.0), 99);
        assert_eq!(confidence(FACEAPI, 1.0 - 0.55), 40);
        assert!((box_iou([0.0, 0.0, 0.5, 0.5], [0.25, 0.0, 0.5, 0.5]) - 1.0 / 3.0).abs() < 1e-6);
    }
}
