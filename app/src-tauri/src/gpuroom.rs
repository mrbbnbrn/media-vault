//! The 3D models (depth, subject outlines, background fill) and the upscaler
//! share the graphics card with each other, the analysis pass and the window.
//!
//! - **One at a time.** Only one of them runs at once (`turn`): two big models
//!   running together need twice the graphics memory at their peak, and fight
//!   the window for the card.
//! - **Make room before giving up on the card.** A model that fails on the
//!   graphics card (usually: not enough graphics memory with the others loaded)
//!   first frees the other kinds' models and tries the card again; only then
//!   does it run on the processor.
//! - **Back to the card.** A model that had to run on the processor tries the
//!   card again after a while, instead of staying slow until it is freed.
//! - **Keep what fits.** Nothing fails when the card's memory is full: Windows
//!   quietly moves part of it to the computer's memory, and every model (and
//!   the window, which draws on the same card) slows down 5–25×. So before a
//!   model loads, the others are freed — the least recently used first — until
//!   it fits (`fit`, from the card's own numbers: `card_memory`); after a run,
//!   if the card is full or the run took far longer than it does here at best,
//!   the others are freed too (`after`).
//! - **A log** of the last runs (device, waiting, loading and running times) for
//!   the timing panel (`models_log`).

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Depth,
    Subject,
    Fill,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Depth => "depth",
            Kind::Subject => "outline",
            Kind::Fill => "fill",
        }
    }
}

static TURN: Mutex<()> = Mutex::new(());

/// Wait for this model's turn on the graphics card (held while it loads and runs).
pub fn turn() -> MutexGuard<'static, ()> {
    TURN.lock().unwrap_or_else(|e| e.into_inner())
}

/// Free the other kinds' models (and the upscaler's), unless they are running right now.
pub fn make_room(keep: Kind) {
    if keep != Kind::Depth {
        crate::depth::unload();
    }
    if keep != Kind::Subject {
        crate::subject::unload();
    }
    if keep != Kind::Fill {
        crate::inpaint::unload();
    }
    crate::upscale::unload_if_idle();
}

// ---- keeping what fits on the graphics card ----------------------------------------------------

/// This app's use of the graphics card's memory and what Windows lets it use
/// (bytes), on the card it uses most. None where it can't be asked.
#[cfg(windows)]
pub fn card_memory() -> Option<(u64, u64)> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
    };
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut best: Option<(u64, u64)> = None;
        for i in 0..8 {
            let Ok(adapter) = factory.EnumAdapters1(i) else { break };
            let Ok(desc) = adapter.GetDesc1() else { continue };
            if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                continue;
            }
            let Ok(a3) = adapter.cast::<IDXGIAdapter3>() else { continue };
            let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
            if a3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info).is_err() || info.Budget == 0 {
                continue;
            }
            if best.is_none_or(|(used, _)| info.CurrentUsage > used) {
                best = Some((info.CurrentUsage, info.Budget));
            }
        }
        best
    }
}

#[cfg(not(windows))]
pub fn card_memory() -> Option<(u64, u64)> {
    None
}

/// Room a model needs that hasn't been measured yet (bytes).
const UNMEASURED_NEED: u64 = 2 << 30;
/// Use at most this share of what Windows lets the app use.
const FULL: f64 = 0.95;
/// What each model took on the card when it loaded and first ran (bytes; the
/// largest seen), kept on this PC (`gpu-fit.json` next to the settings: model
/// names and sizes only) so the 3D settings can warn before the first run.
static FOOTPRINT: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());
/// The last budget Windows gave the app on the card (bytes).
static LAST_BUDGET: Mutex<u64> = Mutex::new(0);
static STORE: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
/// The model each kind ran last (what is loaded when the kind is loaded).
static LAST_MODEL: Mutex<[Option<String>; 3]> = Mutex::new([None, None, None]);

#[derive(Debug, Default, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    budget_mb: u64,
    models: BTreeMap<String, u64>,
}

/// At start: where the sizes are kept, and the ones measured before.
pub fn load_store(config_dir: &std::path::Path) {
    let path = config_dir.join("gpu-fit.json");
    if let Some(st) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Stored>(&b).ok()) {
        let mut f = FOOTPRINT.lock().unwrap_or_else(|e| e.into_inner());
        for (k, mb) in st.models {
            f.insert(k, mb << 20);
        }
        *LAST_BUDGET.lock().unwrap_or_else(|e| e.into_inner()) = st.budget_mb << 20;
    }
    *STORE.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
}

fn save_store() {
    let Some(path) = STORE.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
    let st = Stored {
        budget_mb: *LAST_BUDGET.lock().unwrap_or_else(|e| e.into_inner()) >> 20,
        models: FOOTPRINT.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(k, v)| (k.clone(), v >> 20)).collect(),
    };
    if let Ok(b) = serde_json::to_vec_pretty(&st) {
        let _ = std::fs::write(path, b);
    }
}

fn budget_now() -> Option<u64> {
    let b = *LAST_BUDGET.lock().unwrap_or_else(|e| e.into_inner());
    (b > 0).then_some(b)
}

fn note_budget(card: Option<(u64, u64)>) {
    if let Some((_, b)) = card {
        let mut last = LAST_BUDGET.lock().unwrap_or_else(|e| e.into_inner());
        let changed = (*last >> 26) != (b >> 26); // (saved again when it moves by 64 MB or more)
        *last = b;
        drop(last);
        if changed {
            save_store();
        }
    }
}

/// This model needs more of the card than Windows lets the app use, even on its own:
/// it runs anyway (slower), and isn't freed for the others or they for it (reloading costs more).
pub fn too_big(model: &str) -> bool {
    let need = FOOTPRINT.lock().unwrap_or_else(|e| e.into_inner()).get(model).copied();
    match (need, budget_now()) {
        (Some(n), Some(b)) => !fits(0, n, b),
        _ => false,
    }
}

fn idx(k: Kind) -> usize {
    match k {
        Kind::Depth => 0,
        Kind::Subject => 1,
        Kind::Fill => 2,
    }
}

/// A model of this kind ran (it is what's loaded for the kind now).
fn ran(k: Kind, model: &str) {
    LAST_MODEL.lock().unwrap_or_else(|e| e.into_inner())[idx(k)] = Some(model.to_string());
}

fn loaded_too_big(k: Kind) -> bool {
    LAST_MODEL.lock().unwrap_or_else(|e| e.into_inner())[idx(k)].clone().is_some_and(|m| too_big(&m))
}

/// Another kind's model that doesn't fit on its own is loaded: the card is over
/// anyway, and freeing the small ones would only make them load again.
fn big_one_loaded(keep: Kind) -> bool {
    KINDS.into_iter().any(|k| k != keep && loaded(k) && loaded_too_big(k))
}

/// One model's room on the card, for the 3D settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fit {
    pub model: String,
    /// What it took on the card (MB).
    pub need_mb: u64,
    /// What Windows lets the app use on the card (MB).
    pub card_mb: u64,
    pub fits: bool,
}

#[tauri::command]
pub fn models_fit() -> Vec<Fit> {
    let Some(b) = budget_now() else { return Vec::new() };
    FOOTPRINT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(m, &n)| Fit { model: m.clone(), need_mb: n >> 20, card_mb: b >> 20, fits: fits(0, n, b) })
        .collect()
}
/// Each model's quickest run on the card here (ms), by model and size.
static BEST_MS: Mutex<BTreeMap<String, f64>> = Mutex::new(BTreeMap::new());

const KINDS: [Kind; 3] = [Kind::Depth, Kind::Subject, Kind::Fill];

fn loaded(k: Kind) -> bool {
    match k {
        Kind::Depth => crate::depth::loaded(),
        Kind::Subject => crate::subject::loaded(),
        Kind::Fill => crate::inpaint::loaded(),
    }
}

fn last_used(k: Kind) -> Option<Instant> {
    match k {
        Kind::Depth => crate::depth::last_used(),
        Kind::Subject => crate::subject::last_used(),
        Kind::Fill => crate::inpaint::last_used(),
    }
}

fn unload(k: Kind) {
    match k {
        Kind::Depth => crate::depth::unload(),
        Kind::Subject => crate::subject::unload(),
        Kind::Fill => crate::inpaint::unload(),
    }
}

/// The other kinds' loaded models, least recently used first.
fn others_loaded(keep: Kind) -> Vec<Kind> {
    let mut v: Vec<Kind> = KINDS.into_iter().filter(|&k| k != keep && loaded(k) && !loaded_too_big(k)).collect();
    v.sort_by_key(|&k| last_used(k));
    v
}

fn names(ks: &[Kind]) -> String {
    ks.iter().map(|k| k.name()).collect::<Vec<_>>().join(" and ")
}

/// Whether `used + need` fits in what Windows lets the app use.
pub fn fits(used: u64, need: u64, budget: u64) -> bool {
    (used + need) as f64 <= budget as f64 * FULL
}

/// A run is "far slower than at best here": three times as long and 0.4 s more.
pub fn far_slower(ms: f64, best: f64) -> bool {
    ms > best * 3.0 + 400.0
}

/// Before a model runs (holding its turn): if it isn't loaded and wouldn't fit
/// with the others, free them, the least recently used first, until it does.
/// Returns the card's memory before loading and a note for the log.
pub fn fit(keep: Kind, model: &str, is_loaded: bool) -> (Option<u64>, String) {
    let card = card_memory();
    note_budget(card);
    let Some((mut used, budget)) = card else { return (None, String::new()) };
    if is_loaded || too_big(model) || big_one_loaded(keep) {
        return (Some(used), String::new());
    }
    let need = FOOTPRINT.lock().unwrap_or_else(|e| e.into_inner()).get(model).copied().unwrap_or(UNMEASURED_NEED);
    let mut freed = Vec::new();
    for k in others_loaded(keep) {
        if fits(used, need, budget) {
            break;
        }
        unload(k);
        freed.push(k);
        used = card_memory().map(|m| m.0).unwrap_or(used);
    }
    let note = if freed.is_empty() { String::new() } else { format!("freed {} to fit", names(&freed)) };
    (Some(used), note)
}

/// After a run on the graphics card: note how much room the model took (when
/// it was just loaded) and its quickest time; if the card is full now, or the
/// run took far longer than it does here at best (the card's memory spilled
/// over), free the other models. `size_key` names the model and its input
/// size (None when the size changes from run to run). Returns a note and the
/// card's memory for the log.
pub fn after(keep: Kind, model: &str, size_key: Option<&str>, fresh: bool, before: Option<u64>, run: Duration) -> (String, Option<(u64, u64)>) {
    ran(keep, model);
    let mut card = card_memory();
    note_budget(card);
    if let (true, Some(b), Some((u, _))) = (fresh, before, card)
        && u > b
    {
        let mut f = FOOTPRINT.lock().unwrap_or_else(|e| e.into_inner());
        let old = f.get(model).copied().unwrap_or(0);
        // (Measured while others spilled over it can come out small: the largest is kept.)
        if u - b > old + (64 << 20) || (old == 0 && u > b) {
            f.insert(model.to_string(), (u - b).max(old));
            drop(f);
            save_store();
        }
    }
    let ms = run.as_secs_f64() * 1000.0;
    let mut slow = false;
    if let Some(k) = size_key {
        let mut best = BEST_MS.lock().unwrap_or_else(|e| e.into_inner());
        match best.get(k).copied() {
            Some(b) if far_slower(ms, b) => slow = !fresh,
            Some(b) if ms >= b => {}
            // (The first run after loading is slow on the card: not counted.)
            _ if !fresh => {
                best.insert(k.to_string(), ms);
            }
            _ => {}
        }
    }
    let full = card.is_some_and(|(u, b)| !fits(u, 0, b));
    if !(full || slow) {
        return (String::new(), card);
    }
    if too_big(model) {
        return ("too big for the graphics card on its own: runs slower".into(), card);
    }
    if big_one_loaded(keep) {
        return ("slower: a model too big for the graphics card is loaded".into(), card);
    }
    let others = others_loaded(keep);
    if others.is_empty() {
        return (if full { "the graphics card is full".into() } else { String::new() }, card);
    }
    others.iter().for_each(|&k| unload(k));
    card = card_memory().or(card);
    let why = if full { "the graphics card was full" } else { "ran slowly with the others loaded" };
    (format!("{why}: freed {}", names(&others)), card)
}

/// How long a model stays on the processor before trying the graphics card again.
const RETRY_GPU: Duration = Duration::from_secs(45);
static ON_CPU_SINCE: Mutex<BTreeMap<String, Instant>> = Mutex::new(BTreeMap::new());

/// This model had to run on the processor (from now).
pub fn fell_back(model: &str) {
    ON_CPU_SINCE.lock().unwrap_or_else(|e| e.into_inner()).entry(model.to_string()).or_insert_with(Instant::now);
}

/// This model runs on the graphics card again.
pub fn on_gpu(model: &str) {
    ON_CPU_SINCE.lock().unwrap_or_else(|e| e.into_inner()).remove(model);
}

/// A model loaded on the processor after a fall-back: time to try the graphics card again?
pub fn retry_gpu_due(model: &str) -> bool {
    let mut m = ON_CPU_SINCE.lock().unwrap_or_else(|e| e.into_inner());
    match m.get(model) {
        Some(t) if t.elapsed() >= RETRY_GPU => {
            // (Counted again from now if the card still fails.)
            m.insert(model.to_string(), Instant::now());
            true
        }
        _ => false,
    }
}

/// Where a model run is tried, in order.
pub fn attempts(try_gpu: bool) -> &'static [Device] {
    if try_gpu { &[Device::Gpu, Device::GpuAfterRoom, Device::Cpu] } else { &[Device::Cpu] }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    /// The graphics card, as things are.
    Gpu,
    /// The graphics card, after freeing the other models.
    GpuAfterRoom,
    Cpu,
}

impl Device {
    pub fn gpu(self) -> bool {
        self != Device::Cpu
    }
}

// ---- the log (timing panel) -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub kind: &'static str,
    pub model: String,
    /// "gpu" or "cpu".
    pub device: &'static str,
    /// Waiting for another model to finish (ms).
    pub wait_ms: f64,
    /// Loading the model (ms; 0 when it was loaded).
    pub load_ms: f64,
    /// Running it (ms).
    pub run_ms: f64,
    /// It needed room made on the graphics card first, or fell back to the processor.
    pub note: String,
    /// When it finished (ms since the Unix epoch).
    pub at: u64,
    /// The app's use of the graphics card's memory after it, and what Windows lets it use (MB).
    pub card_used_mb: Option<u64>,
    pub card_budget_mb: Option<u64>,
}

static LOG: Mutex<VecDeque<Run>> = Mutex::new(VecDeque::new());

#[allow(clippy::too_many_arguments)]
pub fn log(kind: Kind, model: &str, gpu: bool, wait: Duration, load_ms: f64, run: Duration, note: &str, card: Option<(u64, u64)>) {
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut l = LOG.lock().unwrap_or_else(|e| e.into_inner());
    l.push_back(Run {
        kind: kind.name(),
        model: model.to_string(),
        device: if gpu { "gpu" } else { "cpu" },
        wait_ms: wait.as_secs_f64() * 1000.0,
        load_ms,
        run_ms: run.as_secs_f64() * 1000.0,
        note: note.to_string(),
        at,
        card_used_mb: card.map(|c| c.0 >> 20),
        card_budget_mb: card.map(|c| c.1 >> 20),
    });
    while l.len() > 100 {
        l.pop_front();
    }
}

#[tauri::command]
pub fn models_log() -> Vec<Run> {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
}

/// The vault locked: forget the log and the fall-backs.
pub fn reset() {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).clear();
    *LAST_MODEL.lock().unwrap_or_else(|e| e.into_inner()) = [None, None, None];
    BEST_MS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    ON_CPU_SINCE.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_and_tries_the_card_again_later() {
        assert_eq!(attempts(true), &[Device::Gpu, Device::GpuAfterRoom, Device::Cpu]);
        assert_eq!(attempts(false), &[Device::Cpu]);
        fell_back("m-test");
        assert!(!retry_gpu_due("m-test"), "not straight away");
        ON_CPU_SINCE.lock().unwrap().insert("m-test".into(), Instant::now() - RETRY_GPU - Duration::from_secs(1));
        assert!(retry_gpu_due("m-test"));
        assert!(!retry_gpu_due("m-test"), "counted again from now");
        on_gpu("m-test");
        assert!(!retry_gpu_due("m-test"));
        log(Kind::Depth, "m-test", true, Duration::from_millis(5), 0.0, Duration::from_millis(300), "", Some((1 << 30, 8 << 30)));
        assert!(models_log().iter().any(|r| r.model == "m-test" && r.device == "gpu"));
    }

    #[test]
    fn what_fits_and_what_is_slow() {
        let gb = 1u64 << 30;
        assert!(fits(5 * gb, 2 * gb, 8 * gb));
        assert!(!fits(6 * gb, 2 * gb, 8 * gb), "over 95 %");
        assert!(!far_slower(900.0, 330.0));
        assert!(far_slower(2600.0, 330.0), "depth at 2.6 s where it ran 0.33 s");
        assert!(!far_slower(500.0, 84.0), "small times wobble");
        // The first run after loading never counts as the best (or as slow).
        let (note, _) = after(Kind::Fill, "t-model", Some("t-model@1"), true, None, Duration::from_millis(50));
        assert!(note.is_empty());
        assert!(BEST_MS.lock().unwrap().get("t-model@1").is_none());
        after(Kind::Fill, "t-model", Some("t-model@1"), false, None, Duration::from_millis(300));
        assert_eq!(BEST_MS.lock().unwrap().get("t-model@1").copied(), Some(300.0));
        after(Kind::Fill, "t-model", Some("t-model@1"), false, None, Duration::from_millis(200));
        assert_eq!(BEST_MS.lock().unwrap().get("t-model@1").copied(), Some(200.0));
        after(Kind::Fill, "t-model", Some("t-model@1"), false, None, Duration::from_millis(5000));
        assert_eq!(BEST_MS.lock().unwrap().get("t-model@1").copied(), Some(200.0), "a slow run isn't the best");
    }

    #[test]
    fn too_big_on_its_own() {
        let gb = 1u64 << 30;
        *LAST_BUDGET.lock().unwrap() = 7 * gb;
        FOOTPRINT.lock().unwrap().insert("t-huge".into(), 10 * gb + gb / 2);
        FOOTPRINT.lock().unwrap().insert("t-small".into(), gb);
        assert!(too_big("t-huge"));
        assert!(!too_big("t-small"));
        assert!(!too_big("t-unknown"));
        let f = models_fit();
        assert!(f.iter().any(|x| x.model == "t-huge" && !x.fits && x.need_mb == 10752 && x.card_mb == 7168));
        // A too-big model is never freed for the others.
        ran(Kind::Subject, "t-huge");
        assert!(loaded_too_big(Kind::Subject));
        ran(Kind::Subject, "t-small");
        assert!(!loaded_too_big(Kind::Subject));
    }

    #[test]
    fn one_at_a_time() {
        let a = turn();
        let started = Instant::now();
        let t = std::thread::spawn(move || {
            let _b = turn();
            started.elapsed()
        });
        std::thread::sleep(Duration::from_millis(80));
        drop(a);
        assert!(t.join().unwrap() >= Duration::from_millis(70));
    }
}
