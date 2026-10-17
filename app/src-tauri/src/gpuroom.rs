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
}

static LOG: Mutex<VecDeque<Run>> = Mutex::new(VecDeque::new());

#[allow(clippy::too_many_arguments)]
pub fn log(kind: Kind, model: &str, gpu: bool, wait: Duration, load_ms: f64, run: Duration, note: &str) {
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
    });
    while l.len() > 60 {
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
        log(Kind::Depth, "m-test", true, Duration::from_millis(5), 0.0, Duration::from_millis(300), "");
        assert!(models_log().iter().any(|r| r.model == "m-test" && r.device == "gpu"));
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
