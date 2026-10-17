//! "Subject outlines": a mask of the picture's subject (the people, animals or
//! things in front), so the window can lift them off the background, light
//! them, or move them on their own. 255 = subject, 0 = background.
//!
//! Like 3D photos (depth.rs), the models are optional downloads that unzip
//! next to the app, each in its own `tools/subject-<id>` folder with a
//! `subject.json` describing it:
//!  - "Fast": BiRefNet lite (`subject-birefnet-lite`),
//!  - "Best": BiRefNet (`subject-birefnet`).
//!
//! Both are run by ONNX Runtime on the graphics card (DirectML) or the
//! processor; ONNX Runtime comes from the pack itself or any other pack
//! (subject, depth, upscaler, faces).
//!
//! One model of this kind is kept loaded (another one of the same kind frees
//! it first), in this module's own slot (modelslot.rs): it stays loaded
//! alongside the depth, subject outline and background fill models, with its
//! own idle timer, and loading one of those never frees this one.
//!
//! The window decodes the picture in memory, scales it to the model's square
//! size and sends the pixels here; the mask goes straight back and is kept in
//! the window's memory, or saved by the window inside the vault, encrypted
//! (derived.rs). Nothing is written anywhere else.
//!
//! While developing: MV_SUBJECT names a single pack folder, MV_SUBJECT_DIR a
//! folder holding several pack folders.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::modelslot::ModelSlot;
use crate::{depth, faceid, upscale};

/// Each pack describes itself in this file.
pub const MANIFEST: &str = "subject.json";
/// BiRefNet's input size, used when a pack or model doesn't say.
const DEFAULT_SIDE: usize = 1024;
/// The model is freed after this long without use.
const IDLE_UNLOAD: Duration = Duration::from_secs(90);
/// Biggest picture accepted from the window.
const MAX_SIDE: usize = 2048;
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

// ---- the packs -------------------------------------------------------------------------------

/// What the model's output means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Output {
    /// Raw scores (BiRefNet): a sigmoid turns them into 0–1.
    Logits,
    /// Already 0–1.
    Probability,
}

/// A pack's `subject.json`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub model: String,
    pub file: String,
    /// The square size pictures are sent at.
    #[serde(default = "default_side")]
    pub side: usize,
    #[serde(default = "imagenet_mean")]
    pub mean: [f32; 3],
    #[serde(default = "imagenet_std")]
    pub std: [f32; 3],
    #[serde(default)]
    pub licence: Option<String>,
    #[serde(default = "default_output")]
    pub output: Output,
}

fn default_side() -> usize {
    DEFAULT_SIDE
}
fn imagenet_mean() -> [f32; 3] {
    IMAGENET_MEAN
}
fn imagenet_std() -> [f32; 3] {
    IMAGENET_STD
}
fn default_output() -> Output {
    Output::Logits
}

impl Manifest {
    /// Stands in for a pack whose `subject.json` is missing or broken (so it can still be listed).
    fn placeholder(id: &str) -> Self {
        Self {
            id: id.into(),
            name: KNOWN.iter().find(|k| k.0 == id).map(|k| k.1.to_string()).unwrap_or_else(|| id.into()),
            model: KNOWN.iter().find(|k| k.0 == id).map(|k| k.2.to_string()).unwrap_or_default(),
            file: "model.onnx".into(),
            side: DEFAULT_SIDE,
            mean: IMAGENET_MEAN,
            std: IMAGENET_STD,
            licence: None,
            output: Output::Logits,
        }
    }

    /// Reads and checks a `subject.json`: a broken or odd one is refused with a reason,
    /// so a bad download can't point the app at some other file or a silly size.
    pub fn parse(json: &[u8]) -> Result<Self, String> {
        let m: Manifest = serde_json::from_slice(json).map_err(|e| format!("its subject.json can't be read ({e})"))?;
        m.validate()?;
        Ok(m)
    }

    fn validate(&self) -> Result<(), String> {
        let id_ok = !self.id.is_empty() && self.id.len() <= 40 && self.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok {
            return Err("its subject.json has an odd id".into());
        }
        if self.name.trim().is_empty() || self.name.len() > 40 || self.model.len() > 80 {
            return Err("its subject.json has an odd name".into());
        }
        // Just a file name inside the pack: never a path somewhere else.
        let file_ok = !self.file.is_empty() && !self.file.contains(['/', '\\', ':']) && self.file != "." && self.file != ".." && self.file.ends_with(".onnx");
        if !file_ok {
            return Err("its subject.json names an odd model file".into());
        }
        let fine = |v: &[f32; 3], lo: f32| v.iter().all(|x| x.is_finite() && *x >= lo && *x <= 1.0);
        if !fine(&self.mean, 0.0) || !fine(&self.std, 1e-3) {
            return Err("its subject.json has odd colour settings".into());
        }
        if !(32..=MAX_SIDE).contains(&self.side) {
            return Err("its subject.json has an odd size".into());
        }
        Ok(())
    }
}

pub const FAST: &str = "birefnet-lite";
pub const BEST: &str = "birefnet";
/// The models the app knows about, so the ones not installed can be offered
/// too: (id, name, model, download).
const KNOWN: [(&str, &str, &str, &str); 2] = [
    (FAST, "Fast", "BiRefNet lite", "MediaVault-subject-birefnet-lite-windows.zip"),
    (BEST, "Best", "BiRefNet", "MediaVault-subject-birefnet-windows.zip"),
];
/// When nothing is chosen (or the choice isn't installed): the best one there is.
const PREFERENCE: [&str; 2] = [BEST, FAST];
const NOT_INSTALLED: &str = "The subject outline pack isn't installed.";

/// An installed (or half-installed) pack.
#[derive(Debug, Clone)]
pub struct Pack {
    pub manifest: Manifest,
    pub dir: PathBuf,
    /// Why it can't be used, in a few words (None = ready).
    pub problem: Option<String>,
    /// Where its ONNX Runtime comes from.
    pub runtime: Option<PathBuf>,
    pub size_bytes: u64,
}

impl Pack {
    fn usable(&self) -> bool {
        self.problem.is_none()
    }
}

/// The folder a model's pack goes in.
fn folder_name(id: &str) -> String {
    format!("subject-{id}")
}

/// One folder → a pack (None when it isn't one at all). A `subject-*` folder
/// without a usable `subject.json` is still listed, with what's wrong.
fn read_pack(dir: &Path) -> Option<Pack> {
    if !dir.is_dir() {
        return None;
    }
    let named = dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let manifest_path = dir.join(MANIFEST);
    let id_from_folder = || named.strip_prefix("subject-").unwrap_or(&named).to_string();
    let (manifest, problem) = if manifest_path.is_file() {
        match std::fs::read(&manifest_path).map_err(|e| e.to_string()).and_then(|b| Manifest::parse(&b)) {
            Ok(m) => (m, None),
            Err(e) => (Manifest::placeholder(&id_from_folder()), Some(format!("The subject outline pack in this folder is damaged: {e}."))),
        }
    } else if named.starts_with("subject-") {
        (Manifest::placeholder(&id_from_folder()), Some("The subject outline pack is incomplete (subject.json is missing).".to_string()))
    } else {
        return None;
    };
    let size_bytes = std::fs::read_dir(dir).map(|r| r.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()).unwrap_or(0);
    let problem = problem.or_else(|| (!dir.join(&manifest.file).is_file()).then(|| "The subject outline pack is incomplete (the model is missing).".to_string()));
    Some(Pack { manifest, dir: dir.to_path_buf(), problem, runtime: None, size_bytes })
}

/// Every pack in `base` (folders `subject-*`, or any folder with a `subject.json`
/// when `any_name`), plus the single pack folder `single`. Each gets its ONNX
/// Runtime: its own, else another subject pack's, else one of `others` (the
/// depth, upscaler and faces packs).
pub fn scan(base: Option<&Path>, any_name: bool, single: Option<&Path>, others: &[PathBuf]) -> Vec<Pack> {
    let mut packs: Vec<Pack> = Vec::new();
    let mut add = |p: Pack| {
        // The first folder with an id wins (a copy left beside it is ignored).
        if !packs.iter().any(|q| q.manifest.id == p.manifest.id) {
            packs.push(p);
        }
    };
    if let Some(p) = single.and_then(read_pack) {
        add(p);
    }
    if let Some(base) = base {
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(base)
            .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        dirs.sort();
        for d in dirs {
            let name = d.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if (name.starts_with("subject-") || (any_name && d.join(MANIFEST).is_file()))
                && let Some(p) = read_pack(&d)
            {
                add(p);
            }
        }
    }
    let own: Vec<PathBuf> = packs.iter().filter(|p| upscale::runtime_in(&p.dir).is_some()).map(|p| p.dir.clone()).collect();
    for p in &mut packs {
        p.runtime = if upscale::runtime_in(&p.dir).is_some() {
            Some(p.dir.clone())
        } else {
            own.iter().chain(others.iter()).find(|d| upscale::runtime_in(d).is_some()).cloned()
        };
        if p.problem.is_none() && p.runtime.is_none() {
            p.problem = Some("The subject outline pack is incomplete (onnxruntime is missing).".into());
        }
    }
    packs
}

/// Where packs are looked for: (folder of pack folders, any folder name, single pack folder).
fn places() -> (Option<PathBuf>, bool, Option<PathBuf>) {
    let single = std::env::var_os("MV_SUBJECT").map(PathBuf::from);
    if let Some(d) = std::env::var_os("MV_SUBJECT_DIR") {
        return (Some(PathBuf::from(d)), true, single);
    }
    if single.is_some() {
        return (None, false, single);
    }
    (std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("tools"))), false, None)
}

/// The packs installed now (looked at afresh each time: unzipping one needs no restart).
pub fn packs() -> Vec<Pack> {
    let (base, any, single) = places();
    // ONNX Runtime may come from any other pack: the depth packs first, then the upscaler and faces.
    let mut others: Vec<PathBuf> = depth::packs().into_iter().filter_map(|p| p.runtime).collect();
    others.extend([upscale::pack_dir(), faceid::pack_dir()].into_iter().flatten());
    scan(base.as_deref(), any, single.as_deref(), &others)
}

/// The pack to use: the chosen one if it's ready, else the best one that is.
pub fn choose<'a>(packs: &'a [Pack], wanted: &str) -> Option<&'a Pack> {
    let ready = |id: &str| packs.iter().find(|p| p.manifest.id == id && p.usable());
    if !wanted.is_empty()
        && let Some(p) = ready(wanted)
    {
        return Some(p);
    }
    PREFERENCE.iter().find_map(|id| ready(id)).or_else(|| packs.iter().find(|p| p.usable()))
}

// ---- what the window is told ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectInfo {
    pub available: bool,
    /// Why not, in one short sentence.
    pub problem: Option<String>,
    /// Where the pack is (or is looked for).
    pub folder: Option<String>,
    /// "gpu" or "cpu" (a guess until the model has run).
    pub device: Option<String>,
    pub device_known: bool,
    /// The model in use (the chosen one, or the best installed when that isn't there).
    pub model: Option<String>,
    pub model_name: Option<String>,
    /// Pictures are sent at this size (square).
    pub input_side: usize,
}

/// One row of the subject model list in Settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub model: String,
    /// Where the pack is, or where it goes.
    pub folder: Option<String>,
    /// Its folder is there.
    pub installed: bool,
    /// Why it can't be used (None = ready).
    pub problem: Option<String>,
    pub size_bytes: u64,
    /// The download it comes in.
    pub zip: Option<String>,
    pub input_side: usize,
    pub licence: Option<String>,
}

fn friendly(e: &str) -> String {
    e.replace("The upscaler", "Subject outlines").replace("the upscaler", "subject outlines")
}

/// The known models (installed or not) and any other packs found, in the order Fast, Best, others.
pub fn catalogue(packs: &[Pack], base: Option<&Path>) -> Vec<ModelEntry> {
    let broken = BROKEN.lock().unwrap().clone();
    let entry = |p: &Pack, zip: Option<&str>| ModelEntry {
        id: p.manifest.id.clone(),
        name: p.manifest.name.clone(),
        model: p.manifest.model.clone(),
        folder: Some(p.dir.display().to_string()),
        installed: true,
        problem: p.problem.clone().or_else(|| broken.get(&p.manifest.id).cloned()),
        size_bytes: p.size_bytes,
        zip: zip.map(String::from),
        input_side: p.manifest.side,
        licence: p.manifest.licence.clone(),
    };
    let mut out: Vec<ModelEntry> = KNOWN
        .iter()
        .map(|&(id, name, model, zip)| match packs.iter().find(|p| p.manifest.id == id) {
            Some(p) => entry(p, Some(zip)),
            None => ModelEntry {
                id: id.into(),
                name: name.into(),
                model: model.into(),
                folder: base.map(|b| b.join(folder_name(id)).display().to_string()),
                installed: false,
                problem: Some(format!("Not installed: get {zip} from the Releases page and unzip it next to the app.")),
                size_bytes: 0,
                zip: Some(zip.into()),
                input_side: DEFAULT_SIDE,
                licence: Some("MIT".into()),
            },
        })
        .collect();
    out.extend(packs.iter().filter(|p| !KNOWN.iter().any(|k| k.0 == p.manifest.id)).map(|p| entry(p, None)));
    out
}

pub fn models() -> Vec<ModelEntry> {
    let (base, _, _) = places();
    catalogue(&packs(), base.as_deref())
}

/// What subject outlines will use for this choice (model id, "" = best installed).
pub fn info(wanted: &str) -> SubjectInfo {
    let all = packs();
    let (base, _, single) = places();
    let fallback_folder = single.or_else(|| base.map(|b| b.join(folder_name(BEST)))).map(|d| d.display().to_string());
    let missing = |p: &str, folder: Option<String>| SubjectInfo {
        available: false,
        problem: Some(p.into()),
        folder,
        device: None,
        device_known: false,
        model: None,
        model_name: None,
        input_side: DEFAULT_SIDE,
    };
    let broken = BROKEN.lock().unwrap().clone();
    let ready: Vec<Pack> = all.iter().filter(|p| !broken.contains_key(&p.manifest.id)).cloned().collect();
    let Some(pack) = choose(&ready, wanted) else {
        // Say what's wrong with the pack that's there, if there is one.
        let p = all.iter().find(|p| p.manifest.id == wanted).or_else(|| all.first());
        return match p {
            Some(p) => missing(p.problem.as_deref().or(broken.get(&p.manifest.id).map(String::as_str)).unwrap_or(NOT_INSTALLED), Some(p.dir.display().to_string())),
            None => missing(NOT_INSTALLED, fallback_folder),
        };
    };
    let rt = pack.runtime.clone().unwrap_or_else(|| pack.dir.clone());
    let known = LAST_DEVICE.lock().unwrap().get(&pack.manifest.id).copied();
    let guess = if cfg!(windows) && rt.join("DirectML.dll").is_file() { "gpu" } else { "cpu" };
    SubjectInfo {
        available: true,
        problem: None,
        folder: Some(pack.dir.display().to_string()),
        device: Some(known.map(|g| if g { "gpu" } else { "cpu" }).unwrap_or(guess).into()),
        device_known: known.is_some(),
        model: Some(pack.manifest.id.clone()),
        model_name: Some(pack.manifest.name.clone()),
        input_side: pack.manifest.side,
    }
}

// ---- the model ----------------------------------------------------------------------------

struct Loaded {
    session: ort::session::Session,
    /// Which model: another one loads afresh.
    key: String,
    /// The size pictures go into the model at (height, width).
    side: (usize, usize),
    output: Output,
    mean: [f32; 3],
    std: [f32; 3],
    gpu: bool,
}

/// This module's own slot: kept loaded alongside the other kinds of model (modelslot.rs).
static MODEL: ModelSlot<Loaded> = ModelSlot::new(IDLE_UNLOAD);
/// Graphics card (true) or processor, per model, once it has run.
static LAST_DEVICE: Mutex<BTreeMap<String, bool>> = Mutex::new(BTreeMap::new());
/// Models whose runtime or file couldn't start at all (shown in Settings), per model.
static BROKEN: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

/// The model's own input size when it is fixed; `want` otherwise.
fn session_side(session: &ort::session::Session, want: usize) -> (usize, usize) {
    let dims: Vec<i64> = session
        .inputs()
        .first()
        .and_then(|i| i.dtype().tensor_shape())
        .map(|s| s.iter().copied().collect())
        .unwrap_or_default();
    let pick = |v: Option<&i64>| v.copied().filter(|&d| d > 0).map(|d| d as usize).unwrap_or(want);
    if dims.len() == 4 { (pick(dims.get(2)), pick(dims.get(3))) } else { (want, want) }
}

/// The model on the graphics card (exactly like the upscaler's), or on the
/// processor without ONNX Runtime's memory pool: at 1024 px a picture needs a
/// few GB while it runs, and without the pool that is given back afterwards
/// instead of being held for as long as the model stays loaded.
fn open_session(env: &ort::environment::Environment, path: &Path, gpu: bool) -> Result<ort::session::Session, String> {
    if gpu {
        return upscale::open_session(env, path, true).map_err(|e| friendly(&e));
    }
    let err = |e: &dyn std::fmt::Display| format!("Subject outlines couldn't load their model ({e}).");
    let b = ort::session::Session::builder(env).map_err(|e| err(&e))?;
    let b = b.with_memory_pattern(false).map_err(|e| err(&e))?;
    // Half the cores (its threads run at normal priority; the window and videos keep the rest).
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let b = b.with_intra_threads((cores / 2).max(1)).map_err(|e| err(&e))?;
    let mut b = b.with_execution_providers([ort::ep::CPU::default().with_arena_allocator(false).build()]).map_err(|e| err(&e))?;
    b.commit_from_file(path).map_err(|e| err(&e))
}

fn load(pack: &Pack, gpu: bool) -> Result<Loaded, String> {
    let rt = pack.runtime.as_ref().ok_or("The subject outline pack is incomplete (onnxruntime is missing).")?;
    let env = upscale::start_runtime(rt).map_err(|e| friendly(&e))?;
    let session = open_session(env, &pack.dir.join(&pack.manifest.file), gpu)?;
    let m = &pack.manifest;
    let side = session_side(&session, m.side);
    Ok(Loaded { session, key: m.id.clone(), side, output: m.output, mean: m.mean, std: m.std, gpu })
}

/// Free the model now (the vault locked or the viewer closed).
pub fn unload() {
    MODEL.unload();
}

/// A model of this kind is loaded now.
#[cfg(test)]
pub fn loaded() -> bool {
    MODEL.is_loaded()
}

/// Run `f` with this model (on the graphics card when possible; a failure
/// there is tried once more on the processor). Only one model is kept.
/// `loaded_ms` is set to how long loading took (0 when it was loaded already).
fn with_model<T>(pack: &Pack, loaded_ms: &mut f64, f: &mut dyn FnMut(&mut Loaded) -> Result<T, String>) -> Result<T, String> {
    use crate::gpuroom::{self, Device, Kind};
    let try_gpu = cfg!(windows) && pack.runtime.as_ref().is_some_and(|r| r.join("DirectML.dll").is_file());
    let key = pack.manifest.id.clone();
    // One model on the graphics card at a time (gpuroom.rs).
    let waited = Instant::now();
    let _turn = gpuroom::turn();
    let wait = waited.elapsed();
    let mut guard = MODEL.lock();
    if guard.as_ref().is_some_and(|l| l.key != key) {
        *guard = None; // a different model: free the old one first (they're big)
    }
    // On the processor since a fall-back: the graphics card again now and then.
    if try_gpu && guard.as_ref().is_some_and(|l| !l.gpu) && gpuroom::retry_gpu_due(&key) {
        *guard = None;
    }
    *loaded_ms = 0.0;
    let on_cpu = guard.as_ref().is_some_and(|l| !l.gpu);
    let order: &[Device] = if on_cpu { &[Device::Cpu] } else { gpuroom::attempts(try_gpu) };
    let mut note = String::new();
    let mut last_err = String::from("Subject outlines couldn't run.");
    let mut load_failed = false;
    for &dev in order {
        if dev == Device::GpuAfterRoom {
            // Not enough room on the graphics card with the other models loaded: free them, try again.
            gpuroom::make_room(Kind::Subject);
            note = "made room on the graphics card".into();
        }
        if guard.is_none() {
            let start = Instant::now();
            match load(pack, dev.gpu()) {
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
        let gpu = loaded.gpu;
        let run = Instant::now();
        match f(loaded) {
            Ok(v) => {
                LAST_DEVICE.lock().unwrap().insert(key.clone(), gpu);
                if gpu {
                    gpuroom::on_gpu(&key);
                } else if try_gpu {
                    gpuroom::fell_back(&key);
                    note = if note.is_empty() { "on the processor (the graphics card failed)".into() } else { format!("{note}; on the processor") };
                }
                gpuroom::log(Kind::Subject, &key, gpu, wait, *loaded_ms, run.elapsed(), &note);
                return Ok(v);
            }
            Err(e) => {
                *guard = None;
                last_err = e;
            }
        }
    }
    if load_failed {
        BROKEN.lock().unwrap().insert(key.clone(), last_err.clone());
    }
    Err(last_err)
}

// ---- the maths (no model needed) --------------------------------------------------------------

/// The model's raw output (`output` says what it is) → 0–255, 255 = subject:
///  - scores go through a sigmoid; probabilities are kept in 0–1; odd values count as background,
///  - near-certain values are made certain (a faint haze over the background goes, the subject is solid),
///  - single stray pixels (a lone speck in the background, a pinhole in the subject) are filled
///    in from their neighbours. Nothing is blurred, so hair and fine edges stay as they are.
pub fn to_mask(raw: &[f32], w: usize, h: usize, output: Output) -> Vec<u8> {
    let n = w * h;
    if n == 0 || raw.len() != n {
        return Vec::new();
    }
    let to_u8 = |v: f32| -> u8 {
        let p = match output {
            Output::Logits => 1.0 / (1.0 + (-v.clamp(-60.0, 60.0)).exp()),
            Output::Probability => v,
        };
        if !p.is_finite() {
            return 0;
        }
        let b = (p.clamp(0.0, 1.0) * 255.0).round() as u8;
        match b {
            0..=3 => 0,
            252..=255 => 255,
            b => b,
        }
    };
    let m: Vec<u8> = raw.iter().map(|&v| to_u8(v)).collect();
    clean_specks(&m, w, h)
}

/// A pixel unlike all of its 8 neighbours, which all agree (all background or
/// all subject), takes their value. Edges and thin strands (which have
/// neighbours along them) are left alone.
fn clean_specks(m: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = m.to_vec();
    if w < 3 || h < 3 {
        return out;
    }
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let v = m[y * w + x];
            let mut all_zero = true;
            let mut all_full = true;
            for dy in 0..3 {
                for dx in 0..3 {
                    if dy == 1 && dx == 1 {
                        continue;
                    }
                    let q = m[(y + dy - 1) * w + x + dx - 1];
                    all_zero &= q == 0;
                    all_full &= q == 255;
                }
            }
            if all_zero && v != 0 {
                out[y * w + x] = 0;
            } else if all_full && v != 255 {
                out[y * w + x] = 255;
            }
        }
    }
    out
}

/// A mask: `w` × `h`, one byte per pixel, 255 = subject.
#[derive(Debug, Clone)]
pub struct Mask {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

impl Mask {
    /// What the window receives: width and height (u32, little-endian), then the bytes.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + self.data.len());
        out.extend_from_slice(&(self.w as u32).to_le_bytes());
        out.extend_from_slice(&(self.h as u32).to_le_bytes());
        out.extend_from_slice(&self.data);
        out
    }
}

/// Of the model's outputs (h × w each), the one to use: the biggest (the
/// finest), the last of equals (BiRefNet's finest map comes last).
fn finest(sizes: &[(usize, usize)]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, &(h, w)) in sizes.iter().enumerate() {
        if h == 0 || w == 0 {
            continue;
        }
        if best.is_none_or(|b| h * w >= sizes[b].0 * sizes[b].1) {
            best = Some(i);
        }
    }
    best
}

/// One picture through the loaded model.
fn run_once(m: &mut Loaded, rgba: &[u8], w: usize, h: usize) -> Result<Mask, String> {
    let (sh, sw) = m.side;
    let input = depth::model_input(rgba, w, h, sw, sh, &m.mean, &m.std);
    let t = ort::value::Tensor::from_array(([1usize, 3, sh, sw], input)).map_err(|e| format!("Subject outlines couldn't run ({e})."))?;
    let out = m.session.run(ort::inputs![t]).map_err(|e| format!("Subject outlines couldn't run ({e})."))?;
    let odd = || "Subject outlines got something unexpected back.".to_string();
    // Every float output with a picture's shape (… × h × w); then the finest one.
    let size_of = |i: usize| -> (usize, usize) {
        let Ok((shape, v)) = out[i].try_extract_tensor::<f32>() else { return (0, 0) };
        match shape.iter().copied().collect::<Vec<i64>>().as_slice() {
            [.., oh, ow] if *oh > 0 && *ow > 0 && v.len() == (*oh * *ow) as usize => (*oh as usize, *ow as usize),
            _ => (0, 0),
        }
    };
    let sizes: Vec<(usize, usize)> = (0..out.len()).map(size_of).collect();
    let pick = finest(&sizes).ok_or_else(odd)?;
    let (oh, ow) = sizes[pick];
    let (_, v) = out[pick].try_extract_tensor::<f32>().map_err(|e| format!("Subject outlines got something unexpected back ({e})."))?;
    let data = to_mask(v, ow, oh, m.output);
    Ok(Mask { w: ow, h: oh, data })
}

fn pack_for(wanted: &str) -> Result<Pack, String> {
    let all = packs();
    let broken = BROKEN.lock().unwrap().clone();
    let ready: Vec<Pack> = all.iter().filter(|p| !broken.contains_key(&p.manifest.id)).cloned().collect();
    choose(&ready, wanted).cloned().ok_or_else(|| {
        all.iter().find(|p| p.manifest.id == wanted).and_then(|p| p.problem.clone().or_else(|| broken.get(&p.manifest.id).cloned())).unwrap_or_else(|| NOT_INSTALLED.into())
    })
}

/// The subject mask of an RGBA picture, with the chosen model ("" = best installed).
pub fn estimate(rgba: &[u8], w: usize, h: usize, wanted: &str) -> Result<Mask, String> {
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE || w.checked_mul(h).and_then(|p| p.checked_mul(4)) != Some(rgba.len()) {
        return Err("The picture didn't arrive whole.".into());
    }
    let pack = pack_for(wanted)?;
    let mut load_ms = 0.0;
    with_model(&pack, &mut load_ms, &mut |m| run_once(m, rgba, w, h))
}

/// The result of a speed test.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Benchmark {
    /// Average time per picture (ms), the warm-up run not counted.
    pub ms: f64,
    /// "gpu" or "cpu".
    pub device: String,
    /// How long loading the model took (ms; 0 if it was loaded already).
    pub load_ms: f64,
    pub side: usize,
}

/// A made-up picture (a bright disc on a soft background), so the speed test needs no real picture.
fn test_picture(side: usize) -> Vec<u8> {
    let mut px = vec![0u8; side * side * 4];
    for y in 0..side {
        for x in 0..side {
            let i = (y * side + x) * 4;
            let inside = (x as isize - side as isize / 2).pow(2) + (y as isize - side as isize / 2).pow(2) < (side as isize / 4).pow(2);
            px[i] = if inside { 210 } else { (x * 120 / side) as u8 + 60 };
            px[i + 1] = if inside { 40 } else { (y * 120 / side) as u8 + 60 };
            px[i + 2] = if inside { 30 } else { 150 };
            px[i + 3] = 255;
        }
    }
    px
}

/// Time this model: three runs on a made-up picture, the first a warm-up
/// (graphics cards are slow the first time). It goes through the same lock as
/// the viewer, so it simply waits its turn.
pub fn benchmark(id: &str) -> Result<Benchmark, String> {
    let all = packs();
    let pack = all.iter().find(|p| p.manifest.id == id).ok_or("That subject outline model isn't installed.")?;
    if let Some(p) = &pack.problem {
        return Err(p.clone());
    }
    let side = pack.manifest.side;
    let picture = test_picture(side);
    let mut load_ms = 0.0;
    let mut device = false;
    let ms = with_model(pack, &mut load_ms, &mut |m| {
        device = m.gpu;
        run_once(m, &picture, side, side)?;
        let start = Instant::now();
        for _ in 0..2 {
            run_once(m, &picture, side, side)?;
        }
        Ok(start.elapsed().as_secs_f64() * 1000.0 / 2.0)
    })?;
    Ok(Benchmark { ms, device: if device { "gpu" } else { "cpu" }.into(), load_ms, side })
}

// ---- commands -------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectRequest {
    pub width: usize,
    pub height: usize,
    /// The chosen model ("" or absent = best installed).
    #[serde(default)]
    pub model: String,
}

/// Body: 4 bytes (little-endian) of JSON length, the request as JSON, then RGBA.
fn split_body(body: &[u8]) -> Result<(SubjectRequest, &[u8]), String> {
    let bad = || "The picture didn't arrive whole.".to_string();
    let n = u32::from_le_bytes(body.get(..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?) as usize;
    let json = body.get(4..4usize.checked_add(n).ok_or_else(bad)?).ok_or_else(bad)?;
    let req: SubjectRequest = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    Ok((req, &body[4 + n..]))
}

/// Which model subject outlines will use for this choice, whether it's there, graphics card or processor.
#[tauri::command]
pub async fn subject_info(model: Option<String>) -> Result<SubjectInfo, String> {
    let wanted = model.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || info(&wanted)).await.map_err(|e| e.to_string())
}

/// Every subject outline model, installed or not.
#[tauri::command]
pub async fn subject_models() -> Result<Vec<ModelEntry>, String> {
    tauri::async_runtime::spawn_blocking(models).await.map_err(|e| e.to_string())
}

/// The subject mask of the picture the window sends (see `Mask::to_bytes`).
#[tauri::command]
pub async fn subject_estimate(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The picture didn't arrive.".into());
    };
    let (req, rgba) = split_body(body)?;
    let rgba = Zeroizing::new(rgba.to_vec());
    let mask = tauri::async_runtime::spawn_blocking(move || estimate(&rgba, req.width, req.height, &req.model)).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(mask.to_bytes()))
}

/// Settings → Test speed.
#[tauri::command]
pub async fn subject_benchmark(id: String) -> Result<Benchmark, String> {
    tauri::async_runtime::spawn_blocking(move || benchmark(&id)).await.map_err(|e| e.to_string())?
}

/// The viewer closed: free the model's memory.
#[tauri::command]
pub async fn subject_forget() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(unload).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LITE: &str = r#"{"id":"birefnet-lite","name":"Fast","model":"BiRefNet lite","file":"model.onnx","side":1024,"mean":[0.485,0.456,0.406],"std":[0.229,0.224,0.225],"licence":"MIT","output":"logits"}"#;

    /// A pack folder: `files` are created with a byte in them; `manifest` written as subject.json when given.
    fn make_pack(base: &Path, name: &str, manifest: Option<&str>, files: &[&str]) -> PathBuf {
        let d = base.join(name);
        std::fs::create_dir_all(&d).unwrap();
        if let Some(m) = manifest {
            std::fs::write(d.join(MANIFEST), m).unwrap();
        }
        for f in files {
            std::fs::write(d.join(f), b"x").unwrap();
        }
        d
    }

    fn runtime_file() -> &'static str {
        if cfg!(windows) { "onnxruntime.dll" } else { "libonnxruntime.so.1.29.0" }
    }

    fn manifest_for(id: &str, name: &str) -> String {
        LITE.replace("birefnet-lite", id).replace("\"Fast\"", &format!("\"{name}\""))
    }

    fn body(json: &[u8], px: &[u8]) -> Vec<u8> {
        let mut b = (json.len() as u32).to_le_bytes().to_vec();
        b.extend_from_slice(json);
        b.extend_from_slice(px);
        b
    }

    #[test]
    fn bodies_split() {
        let b = body(br#"{"width":2,"height":1}"#, &[1, 2, 3, 255, 4, 5, 6, 255]);
        let (r, px) = split_body(&b).unwrap();
        assert_eq!((r.width, r.height, px.len(), r.model.as_str()), (2, 1, 8, ""));
        assert!(split_body(&b[..6]).is_err());
        assert!(split_body(&[]).is_err());
        assert!(split_body(&[255, 255, 255, 255, b'{']).is_err(), "a length past the end");
        let b = body(br#"{"width":1,"height":1,"model":"birefnet"}"#, &[0, 0, 0, 255]);
        let (r, px) = split_body(&b).unwrap();
        assert_eq!((r.model.as_str(), px.len()), (BEST, 4));
    }

    #[test]
    fn broken_pictures_are_refused_before_any_model() {
        assert!(estimate(&[0; 7], 1, 1, "").is_err());
        assert!(estimate(&[], 0, 0, "").is_err());
        assert!(estimate(&vec![0; 4 * 4096], 4096, 1, "").is_err());
    }

    #[test]
    fn scores_and_probabilities_become_masks() {
        // Logits: 0 → half, big → subject, very negative → background; odd values → background.
        let m = to_mask(&[0.0, 20.0, -20.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY], 6, 1, Output::Logits);
        assert_eq!(m, vec![128, 255, 0, 0, 255, 0]);
        // A logit of 2 is about 0.88.
        assert_eq!(to_mask(&[2.0], 1, 1, Output::Logits), vec![225]);
        // Probabilities are taken as they are (held in 0–1); near-certain values snap.
        let p = to_mask(&[0.5, 1.0, 0.0, 1.7, -0.3, 0.995, 0.005, f32::NAN], 8, 1, Output::Probability);
        assert_eq!(p, vec![128, 255, 0, 255, 0, 255, 0, 0]);
        // Wrong sizes give nothing.
        assert!(to_mask(&[1.0; 3], 2, 2, Output::Logits).is_empty());
        assert!(to_mask(&[], 0, 0, Output::Logits).is_empty());
    }

    #[test]
    fn specks_go_but_edges_and_strands_stay() {
        let (w, h) = (16, 16);
        // A solid square subject with a pinhole, a lone speck in the background, and a 1-px strand.
        let mut raw = vec![0.0f32; w * h];
        for y in 4..12 {
            for x in 4..12 {
                raw[y * w + x] = 1.0;
            }
        }
        raw[7 * w + 7] = 0.2; // pinhole
        raw[w + 14] = 0.9; // speck
        for y in 1..4 {
            raw[y * w + 6] = 0.7; // a hair sticking up from the square
        }
        let m = to_mask(&raw, w, h, Output::Probability);
        assert_eq!(m[7 * w + 7], 255, "the pinhole is filled");
        assert_eq!(m[w + 14], 0, "the speck is gone");
        assert!((1..4).all(|y| m[y * w + 6] == 179), "the strand stays as it was");
        assert_eq!((m[4 * w + 4], m[3 * w + 4], m[4 * w + 3]), (255, 0, 0), "edges stay hard where they were hard");
        assert_eq!(m[0], 0);
    }

    #[test]
    fn the_finest_output_is_used() {
        assert_eq!(finest(&[(256, 256), (1024, 1024), (512, 512)]), Some(1));
        assert_eq!(finest(&[(1024, 1024), (1024, 1024)]), Some(1), "the last of equals");
        assert_eq!(finest(&[(0, 5)]), None);
        assert_eq!(finest(&[]), None);
    }

    #[test]
    fn masks_go_out_with_their_size() {
        let b = Mask { w: 3, h: 2, data: vec![1, 2, 3, 4, 5, 6] }.to_bytes();
        assert_eq!(&b[..8], &[3, 0, 0, 0, 2, 0, 0, 0]);
        assert_eq!(&b[8..], &[1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn manifests_are_read_and_checked() {
        let m = Manifest::parse(LITE.as_bytes()).unwrap();
        assert_eq!((m.id.as_str(), m.name.as_str(), m.model.as_str(), m.file.as_str()), (FAST, "Fast", "BiRefNet lite", "model.onnx"));
        assert_eq!((m.side, m.output, m.licence.as_deref()), (1024, Output::Logits, Some("MIT")));
        // Size, colours and output may be left out: 1024, ImageNet's, scores.
        let short = r#"{"id":"x","name":"X","model":"M","file":"m.onnx"}"#;
        let s = Manifest::parse(short.as_bytes()).unwrap();
        assert_eq!((s.side, s.mean, s.std, s.output, s.licence), (1024, IMAGENET_MEAN, IMAGENET_STD, Output::Logits, None));
        let p = Manifest::parse(LITE.replace("logits", "probability").as_bytes()).unwrap();
        assert_eq!(p.output, Output::Probability);
        for bad in [
            "not json".to_string(),
            LITE.replace("model.onnx", "..\\\\..\\\\evil.onnx"),
            LITE.replace("model.onnx", "a/model.onnx"),
            LITE.replace("model.onnx", "model.exe"),
            LITE.replace("birefnet-lite", "BiRefNet Lite!"),
            LITE.replace("1024", "16"),
            LITE.replace("1024", "9000"),
            LITE.replace("[0.229,0.224,0.225]", "[0,0.224,0.225]"),
            LITE.replace("[0.485,0.456,0.406]", "[0.485,0.456,7]"),
            LITE.replace("\"logits\"", "\"depth\""),
            LITE.replace("\"Fast\"", "\"  \""),
        ] {
            assert!(Manifest::parse(bad.as_bytes()).is_err(), "{bad}");
        }
        assert!(Manifest::placeholder(BEST).validate().is_ok());
        assert_eq!(Manifest::placeholder(BEST).name, "Best");
    }

    #[test]
    fn pack_folders_are_found_and_checked() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        let rt = runtime_file();
        make_pack(base, "subject-birefnet-lite", Some(LITE), &["model.onnx", rt]);
        // Best: no runtime of its own (borrows Fast's).
        make_pack(base, "subject-birefnet", Some(&manifest_for(BEST, "Best")), &["model.onnx"]);
        // Model missing; manifest damaged; manifest missing; not a subject folder; one not named subject-* at all.
        make_pack(base, "subject-nomodel", Some(&manifest_for("nomodel", "Empty")), &[rt]);
        make_pack(base, "subject-damaged", Some("{ nope"), &["model.onnx"]);
        make_pack(base, "subject-bare", None, &["model.onnx"]);
        make_pack(base, "depth", None, &["depth_anything_v2_vits.onnx", rt]);
        make_pack(base, "other", Some(&manifest_for("other", "Other")), &["model.onnx", rt]);

        let packs = scan(Some(base), false, None, &[]);
        let ids: Vec<&str> = packs.iter().map(|p| p.manifest.id.as_str()).collect();
        assert_eq!(ids, ["bare", BEST, FAST, "damaged", "nomodel"], "{ids:?}");
        let by = |id: &str| packs.iter().find(|p| p.manifest.id == id).unwrap();
        assert!(by(FAST).problem.is_none() && by(FAST).runtime.as_deref() == Some(&*base.join("subject-birefnet-lite")));
        assert!(by(BEST).problem.is_none(), "{:?}", by(BEST).problem);
        assert_eq!(by(BEST).runtime.as_deref(), Some(&*base.join("subject-birefnet-lite")), "borrowed from another subject pack");
        assert!(by("nomodel").problem.as_deref().unwrap().contains("model is missing"));
        assert!(by("damaged").problem.as_deref().unwrap().contains("damaged"));
        assert!(by("bare").problem.as_deref().unwrap().contains("subject.json is missing"));
        assert!(by(FAST).size_bytes >= 3);

        // MV_SUBJECT_DIR-style: any folder with a subject.json counts, others don't.
        let any = scan(Some(base), true, None, &[]);
        assert!(any.iter().any(|p| p.manifest.id == "other"));
        assert!(!any.iter().any(|p| p.dir.ends_with("depth")), "a folder without subject.json isn't a pack");
    }

    #[test]
    fn runtime_comes_from_the_other_packs_last() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path().join("tools");
        std::fs::create_dir_all(&base).unwrap();
        make_pack(&base, "subject-birefnet-lite", Some(LITE), &["model.onnx"]);
        // No runtime anywhere: reported.
        let p = scan(Some(&base), false, None, &[]);
        assert!(p[0].problem.as_deref().unwrap().contains("onnxruntime"));
        // A depth (or upscaler, faces) pack's will do.
        let dp = make_pack(&base, "depth", None, &[runtime_file()]);
        let p = scan(Some(&base), false, None, std::slice::from_ref(&dp));
        assert!(p[0].problem.is_none());
        assert_eq!(p[0].runtime.as_deref(), Some(dp.as_path()));
        // A single pack folder (MV_SUBJECT) comes first and is found without a base folder.
        let single = make_pack(t.path(), "mine", Some(&manifest_for("mine", "Mine")), &["model.onnx", runtime_file()]);
        let p = scan(None, false, Some(&single), &[]);
        assert_eq!((p.len(), p[0].manifest.id.as_str()), (1, "mine"));
        // …and wins over a copy with the same id in the base folder.
        let lite_single = make_pack(t.path(), "lite-copy", Some(LITE), &["model.onnx", runtime_file()]);
        let p = scan(Some(&base), false, Some(&lite_single), std::slice::from_ref(&dp));
        assert_eq!((p.len(), p[0].dir.as_path()), (1, lite_single.as_path()));
    }

    #[test]
    fn the_choice_falls_back_to_the_best_installed() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        let rt = runtime_file();
        make_pack(base, "subject-birefnet-lite", Some(LITE), &["model.onnx", rt]);
        make_pack(base, "subject-extra", Some(&manifest_for("extra", "Extra")), &["model.onnx", rt]);
        let packs = scan(Some(base), false, None, &[]);
        let pick = |w: &str| choose(&packs, w).map(|p| p.manifest.id.clone());
        assert_eq!(pick("").as_deref(), Some(FAST), "nothing chosen, Best not installed: Fast");
        assert_eq!(pick("extra").as_deref(), Some("extra"), "the choice when it's there");
        assert_eq!(pick(BEST).as_deref(), Some(FAST), "Best isn't installed: the next best");
        assert_eq!(pick("nonsense").as_deref(), Some(FAST));
        // With Best there too, it wins when nothing is chosen.
        make_pack(base, "subject-birefnet", Some(&manifest_for(BEST, "Best")), &["model.onnx"]);
        let mut packs = scan(Some(base), false, None, &[]);
        assert_eq!(choose(&packs, "").map(|p| p.manifest.id.as_str()), Some(BEST));
        assert_eq!(choose(&packs, FAST).map(|p| p.manifest.id.as_str()), Some(FAST));
        // A broken one is skipped.
        packs.iter_mut().find(|p| p.manifest.id == BEST).unwrap().problem = Some("broken".into());
        assert_eq!(choose(&packs, BEST).map(|p| p.manifest.id.as_str()), Some(FAST));
        assert_eq!(choose(&packs, "").map(|p| p.manifest.id.as_str()), Some(FAST));
        // Nothing usable: nothing.
        assert!(choose(&[], "").is_none());
    }

    #[test]
    fn the_catalogue_lists_every_known_model() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        make_pack(base, "subject-birefnet-lite", Some(&LITE.replace("1024", "512")), &["model.onnx", runtime_file()]);
        make_pack(base, "subject-extra", Some(&manifest_for("extra", "Extra")), &["model.onnx", runtime_file()]);
        let packs = scan(Some(base), false, None, &[]);
        let list = catalogue(&packs, Some(base));
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, [FAST, BEST, "extra"]);
        let fast = &list[0];
        assert!(fast.installed && fast.problem.is_none() && fast.size_bytes > 0);
        assert_eq!((fast.input_side, fast.zip.as_deref(), fast.name.as_str()), (512, Some("MediaVault-subject-birefnet-lite-windows.zip"), "Fast"));
        let best = &list[1];
        assert!(!best.installed && best.zip.as_deref() == Some("MediaVault-subject-birefnet-windows.zip"));
        assert!(best.problem.as_deref().unwrap().contains("MediaVault-subject-birefnet-windows.zip"));
        assert!(best.folder.as_deref().unwrap().ends_with("subject-birefnet"));
        assert_eq!((best.input_side, best.name.as_str(), best.model.as_str()), (DEFAULT_SIDE, "Best", "BiRefNet"));
        assert!(list[2].zip.is_none() && list[2].installed);
        // camelCase for the window.
        let j = serde_json::to_value(&list[0]).unwrap();
        for k in ["id", "name", "model", "folder", "installed", "problem", "sizeBytes", "zip", "inputSide", "licence"] {
            assert!(j.get(k).is_some(), "{k}");
        }
        // Without any pack: both known models, not installed.
        let none = catalogue(&[], None);
        assert_eq!(none.len(), 2);
        assert!(none.iter().all(|e| !e.installed && e.folder.is_none()));
    }

    #[test]
    fn info_and_benchmark_speak_camel_case() {
        let i = SubjectInfo { available: false, problem: None, folder: None, device: None, device_known: false, model: None, model_name: None, input_side: 1024 };
        let j = serde_json::to_value(&i).unwrap();
        for k in ["available", "problem", "folder", "device", "deviceKnown", "model", "modelName", "inputSide"] {
            assert!(j.get(k).is_some(), "{k}");
        }
        let b = serde_json::to_value(Benchmark { ms: 1.0, device: "cpu".into(), load_ms: 2.0, side: 1024 }).unwrap();
        for k in ["ms", "device", "loadMs", "side"] {
            assert!(b.get(k).is_some(), "{k}");
        }
    }

    #[test]
    fn the_test_picture_is_whole() {
        let p = test_picture(16);
        assert_eq!(p.len(), 16 * 16 * 4);
        assert!(p.chunks_exact(4).all(|px| px[3] == 255));
    }

    /// The real thing, when a pack is around (writes the masks as PNGs, test output only):
    /// MV_SUBJECT=<folder> (or MV_SUBJECT_DIR=<folder of packs>) MV_SUBJECT_MODEL=<id>
    /// MV_SUBJECT_TEST=<a.jpg,b.png,...> MV_SUBJECT_OUT=/tmp/subject-shots cargo test real_subject -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_subject() {
        let list = std::env::var("MV_SUBJECT_TEST").expect("MV_SUBJECT_TEST");
        let wanted = std::env::var("MV_SUBJECT_MODEL").unwrap_or_default();
        let out = PathBuf::from(std::env::var("MV_SUBJECT_OUT").unwrap_or_else(|_| std::env::temp_dir().display().to_string()));
        std::fs::create_dir_all(&out).unwrap();
        let i = info(&wanted);
        eprintln!("model {:?} at {} px ({:?})", i.model, i.input_side, i.problem);
        let tag = i.model.clone().unwrap_or_default();
        for p in list.split(',') {
            let img = image::open(p).unwrap().to_rgba8();
            // Like the window: scaled to the model's square size first.
            let s = i.input_side as u32;
            let (w, h) = img.dimensions();
            let small = image::imageops::resize(&img, s, s, image::imageops::FilterType::Triangle);
            let start = Instant::now();
            let mask = estimate(small.as_raw(), s as usize, s as usize, &wanted).unwrap();
            let share = mask.data.iter().filter(|&&v| v >= 128).count() as f64 / mask.data.len() as f64;
            eprintln!("{p}: {}x{} mask in {:?} ({:.0}% subject)", mask.w, mask.h, start.elapsed(), share * 100.0);
            // Back to the picture's shape, for looking at.
            let grey = image::GrayImage::from_raw(mask.w as u32, mask.h as u32, mask.data.clone()).unwrap();
            let grey = image::imageops::resize(&grey, w, h, image::imageops::FilterType::Triangle);
            let name = Path::new(p).file_stem().unwrap().to_string_lossy().to_string();
            grey.save(out.join(format!("{name}-{tag}-mask.png"))).unwrap();
            assert!(mask.data.contains(&255) && mask.data.contains(&0));
        }
        if let Some(id) = i.model {
            let b = benchmark(&id).unwrap();
            eprintln!("speed test: {b:?}");
        }
    }
}
