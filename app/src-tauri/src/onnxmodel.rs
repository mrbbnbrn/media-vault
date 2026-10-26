//! What the 3D photo, subject outline and background fill models (depth.rs,
//! subject.rs, inpaint.rs) share: running one with its turn on the graphics
//! card, loading it on the best device that works (the graphics card, the
//! graphics card again after making room, then the processor), noting how it
//! went (gpuroom.rs) and remembering a model that can't start at all.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::gpuroom::{self, Device, Kind};
use crate::modelslot::ModelSlot;

/// Whether a model with this ONNX Runtime folder can try the graphics card
/// (Windows with DirectML.dll next to the runtime).
pub fn can_use_gpu(runtime: Option<&Path>) -> bool {
    cfg!(windows) && runtime.is_some_and(|r| r.join("DirectML.dll").is_file())
}

/// Settings' "graphics card" or "processor" before a model has run: a guess.
pub fn device_guess(runtime: &Path) -> &'static str {
    if can_use_gpu(Some(runtime)) { "gpu" } else { "cpu" }
}

/// The dimensions of a model's first input (-1 or 0 = any size).
pub fn input_dims(session: &ort::session::Session) -> Vec<i64> {
    session
        .inputs()
        .first()
        .and_then(|i| i.dtype().tensor_shape())
        .map(|s| s.iter().copied().collect())
        .unwrap_or_default()
}

/// The model's own input size (height, width) when it is fixed; `want` otherwise.
pub fn session_side(session: &ort::session::Session, want: usize) -> (usize, usize) {
    let dims = input_dims(session);
    let pick = |v: Option<&i64>| v.copied().filter(|&d| d > 0).map(|d| d as usize).unwrap_or(want);
    if dims.len() == 4 { (pick(dims.get(2)), pick(dims.get(3))) } else { (want, want) }
}

/// A loaded model: which one it is (another loads afresh) and where it runs.
pub trait LoadedModel {
    type Key: PartialEq;
    fn key(&self) -> &Self::Key;
    fn gpu(&self) -> bool;
}

/// Each kind of model's own records, shown in Settings.
pub struct Records {
    /// Graphics card (true) or processor, per model, once it has run.
    pub last_device: &'static Mutex<BTreeMap<String, bool>>,
    /// Models whose runtime or file couldn't start at all, per model.
    pub broken: &'static Mutex<BTreeMap<String, String>>,
}

/// One run of a model, as the module asks for it.
pub struct Run<'a, K> {
    pub kind: Kind,
    /// The model's id (records and the graphics card's notes go by it).
    pub id: &'a str,
    /// Which model (and size): the one in the slot is used only if it matches.
    pub key: &'a K,
    /// What gpuroom.rs measures this model under (None: not measured).
    pub measured_as: Option<&'a str>,
    pub try_gpu: bool,
    /// Only on the graphics card (never the processor): how to say it couldn't (and note it).
    pub gpu_only: Option<&'a dyn Fn(&str) -> String>,
    /// Said when nothing worked and nothing more is known.
    pub failed: &'a str,
}

/// Run `f` with the model loaded (by `load(on the graphics card?)`), one
/// model on the graphics card at a time. `loaded_ms`: time spent loading.
pub fn with_model<L, T>(
    slot: &'static ModelSlot<L>,
    records: &Records,
    run: &Run<'_, L::Key>,
    load: &mut dyn FnMut(bool) -> Result<L, String>,
    loaded_ms: &mut f64,
    f: &mut dyn FnMut(&mut L) -> Result<T, String>,
) -> Result<T, String>
where
    L: LoadedModel + Send + 'static,
{
    let (kind, id, try_gpu) = (run.kind, run.id, run.try_gpu);
    // One model on the graphics card at a time (gpuroom.rs).
    let waited = Instant::now();
    let _turn = gpuroom::turn();
    let wait = waited.elapsed();
    let mut guard = slot.lock();
    if guard.as_ref().is_some_and(|l| l.key() != run.key) {
        *guard = None; // a different model (or size): free the old one first (they're big)
    }
    // On the processor since a fall-back: the graphics card again now and then.
    if try_gpu && guard.as_ref().is_some_and(|l| !l.gpu()) && gpuroom::retry_gpu_due(id) {
        *guard = None;
    }
    *loaded_ms = 0.0;
    // Keep what fits on the graphics card: free the others first if this one wouldn't.
    let (before, fit_note) = if try_gpu { gpuroom::fit(kind, id, guard.is_some()) } else { (None, String::new()) };
    let on_cpu = guard.as_ref().is_some_and(|l| !l.gpu());
    let order: &[Device] = if on_cpu { &[Device::Cpu] } else { gpuroom::attempts(try_gpu) };
    let mut note = fit_note;
    let mut last_err = run.failed.to_string();
    let mut load_failed = false;
    for &dev in order {
        if run.gpu_only.is_some() && !dev.gpu() {
            break;
        }
        if dev == Device::GpuAfterRoom {
            // Not enough room on the graphics card with the other models loaded: free them, try again.
            gpuroom::make_room(kind);
            note = if note.is_empty() { "made room on the graphics card".into() } else { format!("{note}; made room on the graphics card") };
        }
        if guard.is_none() {
            let start = Instant::now();
            match load(dev.gpu()) {
                Ok(l) => {
                    *loaded_ms += start.elapsed().as_secs_f64() * 1000.0;
                    *guard = Some(l);
                }
                Err(e) => {
                    last_err = e;
                    load_failed = true;
                    continue;
                }
            }
        }
        load_failed = false;
        let loaded = guard.as_mut().expect("loaded above");
        let gpu = loaded.gpu();
        let started = Instant::now();
        match f(loaded) {
            Ok(v) => {
                let ran = started.elapsed();
                records.last_device.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), gpu);
                let mut card = None;
                if gpu {
                    gpuroom::on_gpu(id);
                    let (n, c) = gpuroom::after(kind, id, run.measured_as, *loaded_ms > 0.0, before, ran);
                    card = c;
                    if !n.is_empty() {
                        note = if note.is_empty() { n } else { format!("{note}; {n}") };
                    }
                } else if try_gpu {
                    gpuroom::fell_back(id);
                    note = if note.is_empty() { "on the processor (the graphics card failed)".into() } else { format!("{note}; on the processor") };
                }
                gpuroom::log(kind, id, gpu, wait, *loaded_ms, ran, &note, card);
                return Ok(v);
            }
            Err(e) => {
                *guard = None;
                last_err = e;
            }
        }
    }
    if let Some(no_gpu) = run.gpu_only {
        return Err(no_gpu(&last_err));
    }
    if load_failed {
        records.broken.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), last_err.clone());
    }
    gpuroom::log(kind, id, false, wait, *loaded_ms, Duration::ZERO, &format!("didn't run: {last_err}"), gpuroom::card_memory());
    Err(last_err)
}
