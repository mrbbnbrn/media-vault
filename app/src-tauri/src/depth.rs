//! "3D photos": a depth map for a still picture, so the slideshow can move
//! it with gentle 2.5D parallax (the window draws the effect with WebGL).
//!
//! There can be several depth models, each an optional download that unzips
//! next to the app, and you pick one in Settings → 3D photos:
//!  - "Fast": Depth Anything V2 Small in `tools/depth` (no manifest; it is
//!    described below), fixed at 518 × 518.
//!  - "Balanced" and "Best": Depth Anything 3 Base / Mono Large, each in its
//!    own `tools/depth-<id>` folder with a `depth.json` describing it. They
//!    take pictures of any size (multiples of their patch size), so they
//!    have a "high detail" size as well as the standard one.
//!  - "Fast (half precision)": the same Depth Anything V2 Small in float16
//!    (`tools/depth-v2-small-fp16`, its depth.json says `"gpuOnly": true`).
//!    Half precision is only quicker (and only safe: the processor stalled on
//!    it before) on the graphics card, so it is used only when chosen and the
//!    graphics card works; otherwise Fast is used instead.
//!
//! All of them are run by ONNX Runtime on the graphics card (DirectML) or the
//! processor, exactly like the upscaler and face recognition.
//!
//! One model of this kind is kept loaded (another one of the same kind frees
//! it first), in this module's own slot (modelslot.rs): it stays loaded
//! alongside the depth, subject outline and background fill models, with its
//! own idle timer, and loading one of those never frees this one.
//!
//! The window decodes the picture in memory, scales it down to the model's
//! size and sends the pixels here; the depth map goes straight back (a few
//! hundred kilobytes) and is kept in the window's memory, or saved by the
//! window inside the vault, encrypted (derived.rs). Nothing is written
//! anywhere else.
//!
//! While developing: MV_DEPTH names a single pack folder, MV_DEPTH_DIR a
//! folder holding several pack folders. Without any pack pictures show as usual.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::modelslot::ModelSlot;
use crate::{faceid, upscale, upscale_img};

/// The Fast model's file (its pack has no manifest).
pub const MODEL_FILE: &str = "depth_anything_v2_vits.onnx";
/// Each new pack describes itself in this file.
pub const MANIFEST: &str = "depth.json";
/// Used when a fixed-size model doesn't say its size (the Fast export is 518 × 518).
const DEFAULT_SIDE: usize = 518;
/// The model is freed after this long without use.
const IDLE_UNLOAD: Duration = Duration::from_secs(90);
/// Biggest picture accepted from the window (it sends ~518–756 px).
const MAX_SIDE: usize = 2048;
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

// ---- the packs -------------------------------------------------------------------------------

/// What the model's output means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Output {
    /// Relative nearness: bigger = closer (Depth Anything V2).
    Nearness,
    /// Distance: bigger = farther (Depth Anything 3); turned into nearness first.
    Depth,
}

/// A pack's `depth.json` (the Fast pack's is built in: `Manifest::fast`).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub model: String,
    pub file: String,
    pub output: Output,
    /// Set for models that take any size that is a multiple of it; absent = fixed size.
    #[serde(default)]
    pub patch: Option<usize>,
    /// The picture size sent normally (fixed models: their only size)…
    #[serde(default)]
    pub standard_side: Option<usize>,
    /// …and with "High detail" (models of any size only).
    #[serde(default)]
    pub high_side: Option<usize>,
    #[serde(default = "imagenet_mean")]
    pub mean: [f32; 3],
    #[serde(default = "imagenet_std")]
    pub std: [f32; 3],
    #[serde(default)]
    pub licence: Option<String>,
    /// Only for the graphics card (half precision): never run on the processor;
    /// when the graphics card can't be used, Fast is used instead.
    #[serde(default)]
    pub gpu_only: bool,
}

fn imagenet_mean() -> [f32; 3] {
    IMAGENET_MEAN
}
fn imagenet_std() -> [f32; 3] {
    IMAGENET_STD
}

impl Manifest {
    /// The Fast pack (`tools/depth`), which came before manifests existed.
    pub fn fast() -> Self {
        Self {
            id: FAST.into(),
            name: "Fast".into(),
            model: "Depth Anything V2 Small".into(),
            file: MODEL_FILE.into(),
            output: Output::Nearness,
            patch: None,
            standard_side: Some(DEFAULT_SIDE),
            high_side: None,
            mean: IMAGENET_MEAN,
            std: IMAGENET_STD,
            licence: Some("Apache-2.0".into()),
            gpu_only: false,
        }
    }

    /// Takes pictures of any size (so "High detail" means something).
    pub fn dynamic(&self) -> bool {
        self.patch.is_some()
    }

    /// Reads and checks a `depth.json`: a broken or odd one is refused with a reason,
    /// so a bad download can't point the app at some other file or a silly size.
    pub fn parse(json: &[u8]) -> Result<Self, String> {
        let m: Manifest = serde_json::from_slice(json).map_err(|e| format!("its depth.json can't be read ({e})"))?;
        m.validate()?;
        Ok(m)
    }

    fn validate(&self) -> Result<(), String> {
        let id_ok = !self.id.is_empty() && self.id.len() <= 40 && self.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok {
            return Err("its depth.json has an odd id".into());
        }
        if self.name.trim().is_empty() || self.name.len() > 40 || self.model.len() > 80 {
            return Err("its depth.json has an odd name".into());
        }
        // Just a file name inside the pack: never a path somewhere else.
        let file_ok = !self.file.is_empty() && !self.file.contains(['/', '\\', ':']) && self.file != "." && self.file != ".." && self.file.ends_with(".onnx");
        if !file_ok {
            return Err("its depth.json names an odd model file".into());
        }
        let fine = |v: &[f32; 3], lo: f32| v.iter().all(|x| x.is_finite() && *x >= lo && *x <= 1.0);
        if !fine(&self.mean, 0.0) || !fine(&self.std, 1e-3) {
            return Err("its depth.json has odd colour settings".into());
        }
        let side_ok = |s: usize| (32..=MAX_SIDE).contains(&s);
        match self.patch {
            Some(p) => {
                if !(1..=64).contains(&p) {
                    return Err("its depth.json has an odd patch size".into());
                }
                let std = self.standard_side.ok_or("its depth.json doesn't give a standard size")?;
                let high = self.high_side.unwrap_or(std);
                if !side_ok(std) || !side_ok(high) || !std.is_multiple_of(p) || !high.is_multiple_of(p) || high < std {
                    return Err("its depth.json has odd sizes".into());
                }
            }
            None => {
                if self.standard_side.is_some_and(|s| !side_ok(s)) {
                    return Err("its depth.json has odd sizes".into());
                }
            }
        }
        Ok(())
    }
}

/// The models the app knows about, so the ones not installed can be offered
/// too: (id, name, model, download).
pub const FAST: &str = "v2-small";
/// Fast in half precision, for the graphics card only.
pub const FAST16: &str = "v2-small-fp16";
pub const BEST: &str = "da3-mono-large";
/// Models no longer offered: "Balanced" (Depth Anything 3 Base, build 42) had no sky
/// detection, so skies and back walls came out half-near — flatter than Fast. A
/// pack left installed is ignored (its folder can be deleted).
pub const RETIRED: [&str; 1] = ["da3-base"];
const KNOWN: [(&str, &str, &str, &str); 3] = [
    (FAST, "Fast", "Depth Anything V2 Small", "MediaVault-depth-windows.zip"),
    (FAST16, "Fast (half precision)", "Depth Anything V2 Small (half precision)", "MediaVault-depth-v2-small-fp16-windows.zip"),
    (BEST, "Best", "Depth Anything 3 Mono Large", "MediaVault-depth-da3-mono-large-windows.zip"),
];
/// When nothing is chosen (or the choice isn't installed): the best one there is.
/// (Fast (half precision) is never picked on its own: only when chosen.)
const PREFERENCE: [&str; 2] = [BEST, FAST];
/// When a graphics-card-only model is chosen but can't be used: Fast first.
const GPU_FALLBACK: [&str; 2] = [FAST, BEST];
const NO_GPU: &str = "Needs a graphics card that works with DirectML; Fast is used instead.";

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
    /// The graphics card can be tried (Windows, and DirectML is there).
    pub gpu: bool,
}

impl Pack {
    fn usable(&self) -> bool {
        self.problem.is_none() && (!self.manifest.gpu_only || self.gpu)
    }
}

/// The folder a known model's pack goes in: `depth` for Fast, `depth-<id>` for the others.
fn folder_name(id: &str) -> String {
    if id == FAST { "depth".into() } else { format!("depth-{id}") }
}

/// One folder → a pack (None when it isn't one at all).
fn read_pack(dir: &Path) -> Option<Pack> {
    if !dir.is_dir() {
        return None;
    }
    let size_bytes = std::fs::read_dir(dir).map(|r| r.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()).unwrap_or(0);
    let named = dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let manifest_path = dir.join(MANIFEST);
    let (manifest, problem) = if manifest_path.is_file() {
        match std::fs::read(&manifest_path).map_err(|e| e.to_string()).and_then(|b| Manifest::parse(&b)) {
            Ok(m) => (m, None),
            Err(e) => {
                // Still listed (by its folder's name), so Settings can say what's wrong.
                let id = named.strip_prefix("depth-").unwrap_or(&named).to_string();
                let mut m = Manifest::fast();
                m.id = id.clone();
                m.name = KNOWN.iter().find(|k| k.0 == id).map(|k| k.1.to_string()).unwrap_or(id);
                (m, Some(format!("The depth pack in this folder is damaged: {e}.")))
            }
        }
    } else if named == "depth" || dir.join(MODEL_FILE).is_file() {
        (Manifest::fast(), None)
    } else {
        return None;
    };
    let problem = problem.or_else(|| (!dir.join(&manifest.file).is_file()).then(|| "The depth pack is incomplete (the model is missing).".to_string()));
    Some(Pack { manifest, dir: dir.to_path_buf(), problem, runtime: None, size_bytes, gpu: false })
}

/// Every pack in `base` (folders `depth` and `depth-*`, or any folder with `any_name`),
/// plus the single pack folder `single`. Each gets its ONNX Runtime: its own,
/// else another depth pack's, else one of `others` (the upscaler and faces packs).
pub fn scan(base: Option<&Path>, any_name: bool, single: Option<&Path>, others: &[PathBuf]) -> Vec<Pack> {
    let mut packs: Vec<Pack> = Vec::new();
    let mut add = |p: Pack| {
        // The first folder with an id wins (a copy left beside it is ignored); retired models are left out.
        if !RETIRED.contains(&p.manifest.id.as_str()) && !packs.iter().any(|q| q.manifest.id == p.manifest.id) {
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
            if (any_name || name == "depth" || name.starts_with("depth-"))
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
            p.problem = Some("The depth pack is incomplete (onnxruntime is missing).".into());
        }
        p.gpu = cfg!(windows) && p.runtime.as_ref().is_some_and(|r| r.join("DirectML.dll").is_file());
    }
    packs
}

/// Where packs are looked for: (folder of pack folders, any folder name, single pack folder).
fn places() -> (Option<PathBuf>, bool, Option<PathBuf>) {
    let single = std::env::var_os("MV_DEPTH").map(PathBuf::from);
    if let Some(d) = std::env::var_os("MV_DEPTH_DIR") {
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
    let others: Vec<PathBuf> = [upscale::pack_dir(), faceid::pack_dir()].into_iter().flatten().collect();
    scan(base.as_deref(), any, single.as_deref(), &others)
}

/// The pack to use: the chosen one if it's ready, else the best one that is
/// (Fast first when the choice was a graphics-card-only model that can't run
/// here). A graphics-card-only model is never picked unless chosen.
pub fn choose<'a>(packs: &'a [Pack], wanted: &str) -> Option<&'a Pack> {
    let ready = |id: &str| packs.iter().find(|p| p.manifest.id == id && p.usable());
    if !wanted.is_empty()
        && let Some(p) = ready(wanted)
    {
        return Some(p);
    }
    let gpu_choice = packs.iter().any(|p| p.manifest.id == wanted && p.manifest.gpu_only) || wanted == FAST16;
    let order: &[&str] = if gpu_choice { &GPU_FALLBACK } else { &PREFERENCE };
    order.iter().find_map(|id| ready(id)).or_else(|| packs.iter().find(|p| p.usable() && !p.manifest.gpu_only))
}

/// "standard" or "high" (anything else is standard).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    Standard,
    High,
}

impl Detail {
    pub fn from_name(s: Option<&str>) -> Self {
        if s == Some("high") { Detail::High } else { Detail::Standard }
    }
    fn name(self) -> &'static str {
        match self {
            Detail::Standard => "standard",
            Detail::High => "high",
        }
    }
}

/// The square size a picture is sent at for this model and detail. Fixed-size
/// models keep their size (whatever the detail); the others use their
/// standard or high size, kept to a multiple of their patch.
pub fn input_side(m: &Manifest, detail: Detail) -> usize {
    match m.patch {
        None => m.standard_side.unwrap_or(DEFAULT_SIDE),
        Some(p) => {
            let p = p.max(1);
            let std = m.standard_side.unwrap_or(DEFAULT_SIDE);
            let s = if detail == Detail::High { m.high_side.unwrap_or(std) } else { std };
            let s = s.clamp(p, MAX_SIDE);
            (s / p).max(1) * p
        }
    }
}

// ---- what the window is told ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthInfo {
    pub available: bool,
    /// Why not, in one short sentence.
    pub problem: Option<String>,
    /// Where the pack is (or is looked for).
    pub folder: Option<String>,
    /// "gpu" or "cpu" (a guess until the model has run).
    pub device: Option<String>,
    pub device_known: bool,
    /// ONNX Runtime comes from another pack.
    pub shared_runtime: bool,
    /// The model in use (the chosen one, or the best installed when that isn't there).
    pub model: Option<String>,
    pub model_name: Option<String>,
    /// Pictures are sent at this size (square).
    pub input_side: usize,
    /// The detail actually used ("standard" for fixed-size models).
    pub detail: String,
    /// It takes any size (so "High detail" applies).
    pub dynamic: bool,
}

/// One row of Settings → 3D photos → Depth model.
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
    pub dynamic: bool,
    /// The download it comes in.
    pub zip: Option<String>,
    pub standard_side: usize,
    pub high_side: usize,
    pub licence: Option<String>,
    /// Graphics card only (half precision): Fast is used instead when it can't run.
    pub gpu_only: bool,
}

fn friendly(e: &str) -> String {
    e.replace("The upscaler", "3D photos").replace("the upscaler", "3D photos")
}

/// The known models (installed or not) and any other packs found, in the order
/// Fast, Fast (half precision), Best, others.
pub fn catalogue(packs: &[Pack], base: Option<&Path>) -> Vec<ModelEntry> {
    let broken = BROKEN.lock().unwrap().clone();
    let entry = |p: &Pack, zip: Option<&str>| ModelEntry {
        id: p.manifest.id.clone(),
        name: p.manifest.name.clone(),
        model: p.manifest.model.clone(),
        folder: Some(p.dir.display().to_string()),
        installed: true,
        problem: p
            .problem
            .clone()
            .or_else(|| broken.get(&p.manifest.id).cloned())
            .or_else(|| (p.manifest.gpu_only && !p.gpu).then(|| NO_GPU.to_string())),
        size_bytes: p.size_bytes,
        dynamic: p.manifest.dynamic(),
        zip: zip.map(String::from),
        standard_side: input_side(&p.manifest, Detail::Standard),
        high_side: input_side(&p.manifest, Detail::High),
        licence: p.manifest.licence.clone(),
        gpu_only: p.manifest.gpu_only,
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
                dynamic: false,
                zip: Some(zip.into()),
                standard_side: DEFAULT_SIDE,
                high_side: DEFAULT_SIDE,
                licence: Some("Apache-2.0".into()),
                gpu_only: id == FAST16,
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

/// What 3D photos will use for this choice (model id, "" = best installed; detail).
pub fn info(wanted: &str, detail: Detail) -> DepthInfo {
    let all = packs();
    let (base, _, single) = places();
    let fallback_folder = single.or_else(|| base.map(|b| b.join("depth"))).map(|d| d.display().to_string());
    let missing = |p: &str, folder: Option<String>| DepthInfo {
        available: false,
        problem: Some(p.into()),
        folder,
        device: None,
        device_known: false,
        shared_runtime: false,
        model: None,
        model_name: None,
        input_side: DEFAULT_SIDE,
        detail: Detail::Standard.name().into(),
        dynamic: false,
    };
    let broken = BROKEN.lock().unwrap().clone();
    let ready: Vec<Pack> = all.iter().filter(|p| !broken.contains_key(&p.manifest.id)).cloned().collect();
    let Some(pack) = choose(&ready, wanted) else {
        // Say what's wrong with the pack that's there, if there is one.
        let p = all.iter().find(|p| p.manifest.id == wanted).or_else(|| all.first());
        return match p {
            Some(p) => missing(&why_not(p, &broken), Some(p.dir.display().to_string())),
            None => missing("The depth pack isn't installed.", fallback_folder),
        };
    };
    let rt = pack.runtime.clone().unwrap_or_else(|| pack.dir.clone());
    let known = LAST_DEVICE.lock().unwrap().get(&pack.manifest.id).copied();
    let guess = if cfg!(windows) && rt.join("DirectML.dll").is_file() { "gpu" } else { "cpu" };
    let detail = if pack.manifest.dynamic() { detail } else { Detail::Standard };
    DepthInfo {
        available: true,
        problem: None,
        folder: Some(pack.dir.display().to_string()),
        device: Some(known.map(|g| if g { "gpu" } else { "cpu" }).unwrap_or(guess).into()),
        device_known: known.is_some(),
        shared_runtime: rt != pack.dir,
        model: Some(pack.manifest.id.clone()),
        model_name: Some(pack.manifest.name.clone()),
        input_side: input_side(&pack.manifest, detail),
        detail: detail.name().into(),
        dynamic: pack.manifest.dynamic(),
    }
}

// ---- the model ----------------------------------------------------------------------------

struct Loaded {
    session: ort::session::Session,
    /// Which model at which size: switching either loads afresh.
    key: (String, usize),
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

/// A fixed-size model's own input size (it may differ from what its pack says); `want` otherwise.
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

fn load(pack: &Pack, side: usize, gpu: bool) -> Result<Loaded, String> {
    let rt = pack.runtime.as_ref().ok_or("The depth pack is incomplete (onnxruntime is missing).")?;
    let env = upscale::start_runtime(rt).map_err(|e| friendly(&e))?;
    let session = upscale::open_session(env, &pack.dir.join(&pack.manifest.file), gpu).map_err(|e| friendly(&e))?;
    // Models of any size get exactly the size asked for; fixed ones keep their own.
    let side = if pack.manifest.dynamic() { (side, side) } else { session_side(&session, side) };
    let m = &pack.manifest;
    Ok(Loaded { session, key: (m.id.clone(), side.0), side, output: m.output, mean: m.mean, std: m.std, gpu })
}

/// Free the model now (the vault locked or the viewer closed).
pub fn unload() {
    MODEL.unload();
}

/// A model of this kind is loaded now.
pub fn loaded() -> bool {
    MODEL.is_loaded()
}

/// When the model was last used.
pub fn last_used() -> Option<Instant> {
    MODEL.last_used()
}

/// The key a pack and detail are loaded under (fixed-size models ignore the detail).
fn key_of(pack: &Pack, detail: Detail) -> (String, usize) {
    (pack.manifest.id.clone(), input_side(&pack.manifest, detail))
}

/// Run `f` with this model at this detail (on the graphics card when possible;
/// a failure there is tried once more on the processor). Only one model is
/// kept: another model or detail frees the one loaded first. `loaded_ms` is
/// set to how long loading took (0 when it was loaded already). A
/// graphics-card-only model never goes to the processor: when the graphics
/// card fails it is marked as not usable here (so Fast is chosen instead).
fn with_model<T>(pack: &Pack, detail: Detail, loaded_ms: &mut f64, f: &mut dyn FnMut(&mut Loaded) -> Result<T, String>) -> Result<T, String> {
    use crate::gpuroom::{self, Device, Kind};
    let try_gpu = pack.gpu;
    let gpu_only = pack.manifest.gpu_only;
    let id = pack.manifest.id.clone();
    let no_gpu = |e: &str| {
        let why = format!("{NO_GPU} ({e})");
        BROKEN.lock().unwrap().insert(id.clone(), why.clone());
        why
    };
    if gpu_only && !try_gpu {
        return Err(no_gpu("no graphics card here"));
    }
    let key = key_of(pack, detail);
    let side = key.1;
    // One model on the graphics card at a time (gpuroom.rs).
    let waited = Instant::now();
    let _turn = gpuroom::turn();
    let wait = waited.elapsed();
    let mut guard = MODEL.lock();
    if guard.as_ref().is_some_and(|l| l.key != key) {
        *guard = None; // a different model or size: free the old one first (they're big)
    }
    // On the processor since a fall-back: the graphics card again now and then.
    if try_gpu && guard.as_ref().is_some_and(|l| !l.gpu) && gpuroom::retry_gpu_due(&id) {
        *guard = None;
    }
    *loaded_ms = 0.0;
    // Keep what fits on the graphics card: free the others first if this one wouldn't.
    let (before, fit_note) = if try_gpu { gpuroom::fit(Kind::Depth, &id, guard.is_some()) } else { (None, String::new()) };
    let on_cpu = guard.as_ref().is_some_and(|l| !l.gpu);
    let order: &[Device] = if on_cpu { &[Device::Cpu] } else { gpuroom::attempts(try_gpu) };
    let mut note = fit_note;
    let mut last_err = String::from("3D photos couldn't run.");
    let mut load_failed = false;
    for &dev in order {
        if gpu_only && !dev.gpu() {
            break;
        }
        if dev == Device::GpuAfterRoom {
            // Not enough room on the graphics card with the other models loaded: free them, try again.
            gpuroom::make_room(Kind::Depth);
            note = if note.is_empty() { "made room on the graphics card".into() } else { format!("{note}; made room on the graphics card") };
        }
        if guard.is_none() {
            let start = Instant::now();
            match load(pack, side, dev.gpu()) {
                Ok(mut l) => {
                    l.key = key.clone();
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
                let ran = run.elapsed();
                LAST_DEVICE.lock().unwrap().insert(id.clone(), gpu);
                let mut card = None;
                if gpu {
                    gpuroom::on_gpu(&id);
                    let (n, c) = gpuroom::after(Kind::Depth, &id, Some(format!("{id}@{side}").as_str()), *loaded_ms > 0.0, before, ran);
                    card = c;
                    if !n.is_empty() {
                        note = if note.is_empty() { n } else { format!("{note}; {n}") };
                    }
                } else if try_gpu {
                    gpuroom::fell_back(&id);
                    note = if note.is_empty() { "on the processor (the graphics card failed)".into() } else { format!("{note}; on the processor") };
                }
                gpuroom::log(Kind::Depth, &id, gpu, wait, *loaded_ms, ran, &note, card);
                return Ok(v);
            }
            Err(e) => {
                *guard = None;
                last_err = e;
            }
        }
    }
    if gpu_only {
        return Err(no_gpu(&last_err));
    }
    if load_failed {
        BROKEN.lock().unwrap().insert(id.clone(), last_err.clone());
    }
    gpuroom::log(Kind::Depth, &id, false, wait, *loaded_ms, Duration::ZERO, &format!("didn't run: {last_err}"), gpuroom::card_memory());
    Err(last_err)
}

// ---- the maths (no model needed) --------------------------------------------------------------

/// RGBA (w × h) → the model's input: 1 × 3 × sh × sw, scaled smoothly and
/// normalised like the model was trained (its colour mean and spread).
pub fn model_input(rgba: &[u8], w: usize, h: usize, sw: usize, sh: usize, mean: &[f32; 3], std: &[f32; 3]) -> Vec<f32> {
    let rgb = Zeroizing::new(rgba.chunks_exact(4).flat_map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0]).collect::<Vec<f32>>());
    let small = Zeroizing::new(upscale_img::resize(&rgb, 3, w, h, sw, sh));
    let n = sw * sh;
    let mut out = vec![0.0f32; 3 * n];
    for i in 0..n {
        for c in 0..3 {
            out[c * n + i] = (small[i * 3 + c] - mean[c]) / std[c];
        }
    }
    out
}

/// Distance (bigger = farther) → nearness (bigger = closer), which is what
/// `finish` expects: minus the logarithm of the distance, so every doubling of
/// distance is the same step back. (1 / distance let the nearest thing take
/// almost the whole range: a car in front made the whole street one flat
/// black.) Odd values (not a number, infinite) become "unknown" and end up
/// far away; zero or negative distances count as the nearest there is.
pub fn depth_to_nearness(raw: &mut [f32]) {
    let far = raw.iter().copied().filter(|v| v.is_finite() && *v > 0.0).fold(0.0f32, f32::max);
    if far <= 0.0 {
        raw.iter_mut().for_each(|v| *v = f32::NAN);
        return;
    }
    // Nothing nearer than a thousandth of the farthest point: one stray pixel can't take over.
    let least = far * 1e-3;
    for v in raw.iter_mut() {
        *v = if v.is_finite() { -v.max(least).ln() } else { f32::NAN };
    }
}

/// Sliding maximum over `r` neighbours on each side, along rows (`step` 1)
/// or columns (`step` w).
fn max_line(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize, rows: bool) {
    let (lines, len) = if rows { (h, w) } else { (w, h) };
    let at = |line: usize, i: usize| if rows { line * w + i } else { i * w + line };
    for line in 0..lines {
        for i in 0..len {
            let lo = i.saturating_sub(r);
            let hi = (i + r).min(len - 1);
            let mut m = f32::MIN;
            for j in lo..=hi {
                m = m.max(src[at(line, j)]);
            }
            dst[at(line, i)] = m;
        }
    }
}

/// Box blur (average over `r` neighbours on each side, edges repeated), rows or columns.
fn blur_line(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize, rows: bool) {
    let (lines, len) = if rows { (h, w) } else { (w, h) };
    let at = |line: usize, i: usize| if rows { line * w + i } else { i * w + line };
    let k = (2 * r + 1) as f32;
    for line in 0..lines {
        let get = |i: isize| src[at(line, i.clamp(0, len as isize - 1) as usize)];
        let mut sum: f32 = (-(r as isize)..=r as isize).map(get).sum();
        for i in 0..len {
            dst[at(line, i)] = sum / k;
            sum += get(i as isize + r as isize + 1) - get(i as isize - r as isize);
        }
    }
}

/// The model's raw output (relative nearness: bigger = closer) → 0–255,
/// ready for the window:
///  - stretched between the 1st and 99th percentile (a few odd pixels don't matter),
///  - near things grown by a few pixels, so the stretching the effect needs
///    at their edges happens in the background, not on a face or an outline,
///  - softened, so edges stretch smoothly instead of tearing.
#[cfg_attr(not(test), allow(dead_code))]
pub fn finish(raw: &[f32], w: usize, h: usize) -> Vec<u8> {
    finish_soft(raw, w, h, 1.0)
}

/// [`finish`] with more or less softening: 1 = as designed, smaller = sharper
/// edges (more of a good model's detail shows, edges stretch a little more),
/// larger = softer. Held within 0.25–2.
pub fn finish_soft(raw: &[f32], w: usize, h: usize, soft: f32) -> Vec<u8> {
    let soft_k = if soft.is_finite() { soft.clamp(0.25, 2.0) } else { 1.0 };
    let n = w * h;
    if n == 0 || raw.len() != n {
        return Vec::new();
    }
    let mut sample: Vec<f32> = raw.iter().step_by((n / 20_000).max(1)).copied().filter(|v| v.is_finite()).collect();
    if sample.is_empty() {
        return vec![0; n];
    }
    sample.sort_by(f32::total_cmp);
    let lo = sample[sample.len() / 100];
    let hi = sample[(sample.len() * 99 / 100).min(sample.len() - 1)];
    let span = (hi - lo).max(1e-6);
    let mut a: Vec<f32> = raw.iter().map(|&v| if v.is_finite() { ((v - lo) / span).clamp(0.0, 1.0) } else { 0.0 }).collect();
    let mut b = vec![0.0f32; n];
    // Sizes relative to a 518-pixel map.
    let scale = w.max(h) as f32 / 518.0;
    let grow = ((3.0 * scale * soft_k).round() as usize).max(1);
    let soft = ((4.0 * scale * soft_k).round() as usize).max(1);
    max_line(&a, &mut b, w, h, grow, true);
    max_line(&b, &mut a, w, h, grow, false);
    for _ in 0..2 {
        blur_line(&a, &mut b, w, h, soft, true);
        blur_line(&b, &mut a, w, h, soft, false);
    }
    a.iter().map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8).collect()
}

/// A depth map: `w` × `h`, one byte per pixel, 255 = nearest.
#[derive(Debug, Clone)]
pub struct DepthMap {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

impl DepthMap {
    /// What the window receives: width and height (u32, little-endian), then the bytes.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + self.data.len());
        out.extend_from_slice(&(self.w as u32).to_le_bytes());
        out.extend_from_slice(&(self.h as u32).to_le_bytes());
        out.extend_from_slice(&self.data);
        out
    }
}

/// One picture through the loaded model.
fn run_once(m: &mut Loaded, rgba: &[u8], w: usize, h: usize, soft: f32) -> Result<DepthMap, String> {
    let (sh, sw) = m.side;
    let input = model_input(rgba, w, h, sw, sh, &m.mean, &m.std);
    let t = ort::value::Tensor::from_array(([1usize, 3, sh, sw], input)).map_err(|e| format!("3D photos couldn't run ({e})."))?;
    let out = m.session.run(ort::inputs![t]).map_err(|e| format!("3D photos couldn't run ({e})."))?;
    // Models with several outputs (depth plus confidence, say) name the depth one.
    let value = ["depth", "predicted_depth"].iter().find_map(|n| out.get(n)).unwrap_or(&out[0]);
    let (shape, v) = value.try_extract_tensor::<f32>().map_err(|e| format!("3D photos got something unexpected back ({e})."))?;
    let dims: Vec<i64> = shape.iter().copied().collect();
    let (oh, ow) = match dims.as_slice() {
        [.., oh, ow] if *oh > 0 && *ow > 0 => (*oh as usize, *ow as usize),
        _ => return Err("3D photos got something unexpected back.".into()),
    };
    if v.len() != oh * ow {
        return Err("3D photos got something unexpected back.".into());
    }
    let data = match m.output {
        Output::Nearness => finish_soft(v, ow, oh, soft),
        Output::Depth => {
            let mut near = v.to_vec();
            depth_to_nearness(&mut near);
            finish_soft(&near, ow, oh, soft)
        }
    };
    Ok(DepthMap { w: ow, h: oh, data })
}

fn pack_for(wanted: &str) -> Result<Pack, String> {
    let all = packs();
    let broken = BROKEN.lock().unwrap().clone();
    let ready: Vec<Pack> = all.iter().filter(|p| !broken.contains_key(&p.manifest.id)).cloned().collect();
    choose(&ready, wanted)
        .cloned()
        .ok_or_else(|| all.iter().find(|p| p.manifest.id == wanted).map(|p| why_not(p, &broken)).unwrap_or_else(|| "The depth pack isn't installed.".into()))
}

/// Why this pack can't be used, in one sentence.
fn why_not(p: &Pack, broken: &BTreeMap<String, String>) -> String {
    p.problem
        .clone()
        .or_else(|| broken.get(&p.manifest.id).cloned())
        .or_else(|| (p.manifest.gpu_only && !p.gpu).then(|| NO_GPU.to_string()))
        .unwrap_or_else(|| "The depth pack isn't installed.".into())
}

/// The depth of an RGBA picture, with the chosen model ("" = best installed) and detail.
pub fn estimate(rgba: &[u8], w: usize, h: usize, wanted: &str, detail: Detail, soft: f32) -> Result<DepthMap, String> {
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE || w.checked_mul(h).and_then(|p| p.checked_mul(4)) != Some(rgba.len()) {
        return Err("The picture didn't arrive whole.".into());
    }
    let pack = pack_for(wanted)?;
    let mut load_ms = 0.0;
    match with_model(&pack, detail, &mut load_ms, &mut |m| run_once(m, rgba, w, h, soft)) {
        // The graphics card couldn't run the half-precision model: Fast (or the best there is) instead.
        Err(e) if pack.manifest.gpu_only => match pack_for(wanted) {
            Ok(next) if next.manifest.id != pack.manifest.id => with_model(&next, detail, &mut load_ms, &mut |m| run_once(m, rgba, w, h, soft)),
            _ => Err(e),
        },
        r => r,
    }
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

/// A made-up picture with some shapes in it, so the speed test needs no real picture.
fn test_picture(side: usize) -> Vec<u8> {
    let mut px = vec![0u8; side * side * 4];
    for y in 0..side {
        for x in 0..side {
            let i = (y * side + x) * 4;
            let inside = (x as isize - side as isize / 2).pow(2) + (y as isize - side as isize / 2).pow(2) < (side as isize / 4).pow(2);
            px[i] = (x * 255 / side) as u8;
            px[i + 1] = (y * 255 / side) as u8;
            px[i + 2] = if inside { 220 } else { 60 };
            px[i + 3] = 255;
        }
    }
    px
}

/// Time this model at this detail: three runs on a made-up picture, the first
/// a warm-up (graphics cards are slow the first time). It goes through the
/// same lock as the viewer, so it simply waits its turn.
pub fn benchmark(id: &str, detail: Detail) -> Result<Benchmark, String> {
    let all = packs();
    let pack = all.iter().find(|p| p.manifest.id == id).ok_or("That depth model isn't installed.")?;
    if let Some(p) = &pack.problem {
        return Err(p.clone());
    }
    let side = input_side(&pack.manifest, detail);
    let picture = test_picture(side);
    let mut load_ms = 0.0;
    let mut device = false;
    let ms = with_model(pack, detail, &mut load_ms, &mut |m| {
        device = m.gpu;
        run_once(m, &picture, side, side, 1.0)?;
        let start = Instant::now();
        for _ in 0..2 {
            run_once(m, &picture, side, side, 1.0)?;
        }
        Ok(start.elapsed().as_secs_f64() * 1000.0 / 2.0)
    })?;
    Ok(Benchmark { ms, device: if device { "gpu" } else { "cpu" }.into(), load_ms, side })
}

// ---- commands -------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthRequest {
    pub width: usize,
    pub height: usize,
    /// The chosen model ("" or absent = best installed) and detail.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub detail: Option<String>,
    /// Edge softening (1 = as designed; smaller = sharper). Absent = 1.
    #[serde(default)]
    pub soft: Option<f32>,
}

/// Body: 4 bytes (little-endian) of JSON length, the request as JSON, then RGBA.
fn split_body(body: &[u8]) -> Result<(DepthRequest, &[u8]), String> {
    let bad = || "The picture didn't arrive whole.".to_string();
    let n = u32::from_le_bytes(body.get(..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?) as usize;
    let json = body.get(4..4 + n).ok_or_else(bad)?;
    let req: DepthRequest = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    Ok((req, &body[4 + n..]))
}

/// Which model 3D photos will use for this choice, whether it's there, graphics card or processor.
#[tauri::command]
pub async fn depth_info(model: Option<String>, detail: Option<String>) -> Result<DepthInfo, String> {
    let wanted = model.unwrap_or_default();
    let detail = Detail::from_name(detail.as_deref());
    tauri::async_runtime::spawn_blocking(move || info(&wanted, detail)).await.map_err(|e| e.to_string())
}

/// Every depth model, installed or not (Settings → 3D photos).
#[tauri::command]
pub async fn depth_models() -> Result<Vec<ModelEntry>, String> {
    tauri::async_runtime::spawn_blocking(models).await.map_err(|e| e.to_string())
}

/// The depth map of the picture the window sends (see `DepthMap::to_bytes`).
#[tauri::command]
pub async fn depth_estimate(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The picture didn't arrive.".into());
    };
    let (req, rgba) = split_body(body)?;
    let rgba = Zeroizing::new(rgba.to_vec());
    let detail = Detail::from_name(req.detail.as_deref());
    let map = tauri::async_runtime::spawn_blocking(move || estimate(&rgba, req.width, req.height, &req.model, detail, req.soft.unwrap_or(1.0))).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(map.to_bytes()))
}

/// Settings → 3D photos → Test speed.
#[tauri::command]
pub async fn depth_benchmark(id: String, detail: Option<String>) -> Result<Benchmark, String> {
    let detail = Detail::from_name(detail.as_deref());
    tauri::async_runtime::spawn_blocking(move || benchmark(&id, detail)).await.map_err(|e| e.to_string())?
}

/// The viewer closed: free the model's memory.
#[tauri::command]
pub async fn depth_forget() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(unload).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test pack that takes any size (id "da3-test").
    const BAL: &str = "da3-test";
    const DA3: &str = r#"{"id":"da3-test","name":"Balanced","model":"Depth Anything 3 Base","file":"model.onnx","output":"depth","patch":14,"standardSide":518,"highSide":756,"mean":[0.485,0.456,0.406],"std":[0.229,0.224,0.225],"licence":"Apache-2.0"}"#;

    /// A pack folder: `files` are created empty; `manifest` written as depth.json when given.
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
        DA3.replace("da3-test", id).replace("Balanced", name)
    }

    #[test]
    fn bodies_split() {
        let json = br#"{"width":2,"height":1}"#;
        let mut body = (json.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(json);
        body.extend_from_slice(&[1, 2, 3, 255, 4, 5, 6, 255]);
        let (r, px) = split_body(&body).unwrap();
        assert_eq!((r.width, r.height, px.len(), r.model.as_str(), r.detail), (2, 1, 8, "", None));
        assert!(split_body(&body[..6]).is_err());
        assert!(split_body(&[]).is_err());
        // With a model and detail.
        let json = br#"{"width":1,"height":1,"model":"da3-base","detail":"high","soft":0.5}"#;
        let mut body = (json.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(json);
        body.extend_from_slice(&[0, 0, 0, 255]);
        let (r, _) = split_body(&body).unwrap();
        assert_eq!((r.model.as_str(), Detail::from_name(r.detail.as_deref())), ("da3-base", Detail::High));
        assert_eq!(r.soft, Some(0.5));
    }

    #[test]
    fn less_softening_keeps_edges_steeper() {
        // A near square on a far background, at the models' usual size.
        let (w, h) = (518, 518);
        let raw: Vec<f32> = (0..w * h).map(|i| if (160..360).contains(&(i % w)) && (160..360).contains(&(i / w)) { 1.0 } else { 0.0 }).collect();
        let steepest = |d: &[u8]| (1..w).map(|x| (d[259 * w + x] as i32 - d[259 * w + x - 1] as i32).abs()).max().unwrap();
        let (sharp, normal, soft) = (finish_soft(&raw, w, h, 0.25), finish_soft(&raw, w, h, 1.0), finish_soft(&raw, w, h, 2.0));
        assert_eq!(normal, finish(&raw, w, h));
        assert!(steepest(&sharp) > steepest(&normal) && steepest(&normal) >= steepest(&soft), "{} {} {}", steepest(&sharp), steepest(&normal), steepest(&soft));
        // Odd values are held in range.
        assert_eq!(finish_soft(&raw, w, h, f32::NAN), normal);
        assert_eq!(finish_soft(&raw, w, h, 0.0), sharp);
    }

    #[test]
    fn broken_pictures_are_refused_before_any_model() {
        assert!(estimate(&[0; 7], 1, 1, "", Detail::Standard, 1.0).is_err());
        assert!(estimate(&[], 0, 0, "", Detail::Standard, 1.0).is_err());
        assert!(estimate(&vec![0; 4 * 4096], 4096, 1, "", Detail::Standard, 1.0).is_err());
    }

    #[test]
    fn input_is_planar_and_normalised() {
        // A 2 × 1 picture: white, black → 1 × 3 × 1 × 2.
        let x = model_input(&[255, 255, 255, 255, 0, 0, 0, 255], 2, 1, 2, 1, &IMAGENET_MEAN, &IMAGENET_STD);
        assert_eq!(x.len(), 6);
        assert!((x[0] - (1.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]).abs() < 1e-5);
        assert!((x[1] - (0.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]).abs() < 1e-5);
        assert!((x[4] - (1.0 - IMAGENET_MEAN[2]) / IMAGENET_STD[2]).abs() < 1e-5);
        // A pack's own colour settings are used.
        let y = model_input(&[255, 255, 255, 255], 1, 1, 1, 1, &[0.5; 3], &[0.5; 3]);
        assert!(y.iter().all(|v| (v - 1.0).abs() < 1e-5));
    }

    #[test]
    fn finish_stretches_grows_near_things_and_softens() {
        // Far background (0) with a near square (10) in the middle.
        let (w, h) = (64, 64);
        let raw: Vec<f32> = (0..w * h).map(|i| if (24..40).contains(&(i % w)) && (24..40).contains(&(i / w)) { 10.0 } else { 0.0 }).collect();
        let d = finish(&raw, w, h);
        assert_eq!(d.len(), w * h);
        assert_eq!(d[32 * w + 32], 255, "the middle of the near square is nearest");
        assert_eq!(d[2 * w + 2], 0, "the far corner stays far");
        // Grown: just outside the square is still fairly near.
        assert!(d[32 * w + 23] > 128, "{}", d[32 * w + 23]);
        // Soft: no hard jump anywhere along a row.
        let row = &d[32 * w..33 * w];
        assert!(row.windows(2).all(|p| (p[0] as i32 - p[1] as i32).abs() < 90), "{row:?}");
        // Odd values don't break it.
        assert_eq!(finish(&[f32::NAN; 4], 2, 2).len(), 4);
        assert!(finish(&[1.0; 3], 2, 2).is_empty());
    }

    #[test]
    fn distance_becomes_nearness_and_finishes_the_same_way() {
        let mut v = vec![1.0, 2.0, 4.0, f32::NAN, f32::INFINITY, 0.0, -3.0];
        depth_to_nearness(&mut v);
        assert_eq!(v[0], 0.0);
        assert!((v[0] - v[1] - std::f32::consts::LN_2).abs() < 1e-6 && (v[1] - v[2] - std::f32::consts::LN_2).abs() < 1e-6, "each doubling = the same step back");
        assert!(v[3].is_nan() && v[4].is_nan(), "odd values become unknown");
        // Zero and below: the nearest allowed (−ln(4 × 0.001)), not infinite.
        let nearest = -(4.0f32 * 1e-3).ln();
        assert!((v[5] - nearest).abs() < 1e-4 && (v[6] - nearest).abs() < 1e-4, "{v:?}");
        // Nothing usable at all: everything unknown, and finish still gives a (flat) map.
        let mut z = vec![0.0, f32::NAN];
        depth_to_nearness(&mut z);
        assert!(z.iter().all(|x| x.is_nan()));
        assert_eq!(finish(&z, 2, 1), vec![0, 0]);

        // A near square at distance 1 on a background at distance 10: the same map as from nearness.
        let (w, h) = (64, 64);
        let inside = |i: usize| (24..40).contains(&(i % w)) && (24..40).contains(&(i / w));
        let mut dist: Vec<f32> = (0..w * h).map(|i| if inside(i) { 1.0 } else { 10.0 }).collect();
        depth_to_nearness(&mut dist);
        let d = finish(&dist, w, h);
        assert_eq!(d[32 * w + 32], 255, "the near square is nearest");
        assert_eq!(d[2 * w + 2], 0, "the background is far");
        let near: Vec<f32> = (0..w * h).map(|i| if inside(i) { 0.0 } else { -(10.0f32.ln()) }).collect();
        assert_eq!(d, finish(&near, w, h));
    }

    #[test]
    fn maps_go_out_with_their_size() {
        let b = DepthMap { w: 3, h: 2, data: vec![1, 2, 3, 4, 5, 6] }.to_bytes();
        assert_eq!(&b[..8], &[3, 0, 0, 0, 2, 0, 0, 0]);
        assert_eq!(&b[8..], &[1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn manifests_are_read_and_checked() {
        let m = Manifest::parse(DA3.as_bytes()).unwrap();
        assert_eq!((m.id.as_str(), m.name.as_str(), m.file.as_str(), m.output, m.patch), ("da3-test", "Balanced", "model.onnx", Output::Depth, Some(14)));
        assert_eq!((m.standard_side, m.high_side, m.licence.as_deref()), (Some(518), Some(756), Some("Apache-2.0")));
        assert!(m.dynamic());
        // Colour settings may be left out: ImageNet's.
        let short = r#"{"id":"x","name":"X","model":"M","file":"m.onnx","output":"nearness","patch":14,"standardSide":518}"#;
        let s = Manifest::parse(short.as_bytes()).unwrap();
        assert_eq!((s.mean, s.std, s.high_side), (IMAGENET_MEAN, IMAGENET_STD, None));
        // Refused: not JSON, a path for the file, an odd id, sizes not a multiple of the patch, a zero spread, an unknown output.
        for bad in [
            "not json".to_string(),
            DA3.replace("model.onnx", "..\\\\..\\\\evil.onnx"),
            DA3.replace("model.onnx", "model.exe"),
            DA3.replace("da3-test", "DA3 base!"),
            DA3.replace("756", "750"),
            DA3.replace("\"highSide\":756", "\"highSide\":504"),
            DA3.replace("\"patch\":14", "\"patch\":0"),
            DA3.replace("[0.229,0.224,0.225]", "[0,0.224,0.225]"),
            DA3.replace("\"depth\"", "\"height\""),
            DA3.replace("\"standardSide\":518,", ""),
        ] {
            assert!(Manifest::parse(bad.as_bytes()).is_err(), "{bad}");
        }
        // The built-in Fast description is valid by its own rules.
        assert!(Manifest::fast().validate().is_ok());
    }

    #[test]
    fn input_side_fixed_vs_any_size() {
        let fast = Manifest::fast();
        assert_eq!((input_side(&fast, Detail::Standard), input_side(&fast, Detail::High)), (518, 518), "fixed models ignore the detail");
        let da3 = Manifest::parse(DA3.as_bytes()).unwrap();
        assert_eq!((input_side(&da3, Detail::Standard), input_side(&da3, Detail::High)), (518, 756));
        // No high size: high is the standard one. Always a multiple of the patch.
        let mut m = da3.clone();
        m.high_side = None;
        assert_eq!(input_side(&m, Detail::High), 518);
        m.patch = Some(16);
        m.standard_side = Some(520);
        assert_eq!(input_side(&m, Detail::Standard) % 16, 0);
        assert_eq!(Detail::from_name(Some("high")), Detail::High);
        assert_eq!(Detail::from_name(Some("ultra")), Detail::Standard);
        assert_eq!(Detail::from_name(None), Detail::Standard);
    }

    #[test]
    fn several_pack_folders_are_found_and_checked() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        let rt = runtime_file();
        // Fast: the old pack, no manifest, with the runtime.
        make_pack(base, "depth", None, &[MODEL_FILE, rt]);
        // Balanced: its own runtime.
        make_pack(base, "depth-da3-test", Some(DA3), &["model.onnx", rt]);
        // Best: no runtime of its own (borrows Fast's).
        make_pack(base, "depth-da3-mono-large", Some(&manifest_for(BEST, "Best")), &["model.onnx"]);
        // Model missing; manifest damaged; a folder that isn't a depth pack; one not named depth-* at all.
        make_pack(base, "depth-nomodel", Some(&manifest_for("nomodel", "Empty")), &[rt]);
        make_pack(base, "depth-damaged", Some("{ nope"), &["model.onnx"]);
        make_pack(base, "upscaler", None, &[rt]);
        make_pack(base, "other", Some(&manifest_for("other", "Other")), &["model.onnx", rt]);
        make_pack(base, "depth-da3-base", Some(&manifest_for("da3-base", "Balanced")), &["model.onnx", rt]);

        let packs = scan(Some(base), false, None, &[]);
        let ids: Vec<&str> = packs.iter().map(|p| p.manifest.id.as_str()).collect();
        // Sorted by folder name ("depth" < "depth-da3-mono-large" < "depth-da3-test" < "depth-damaged" < "depth-nomodel");
        // the retired Balanced pack is left out.
        assert_eq!(ids, [FAST, BEST, BAL, "damaged", "nomodel"], "{ids:?}");
        let by = |id: &str| packs.iter().find(|p| p.manifest.id == id).unwrap();
        assert!(by(FAST).problem.is_none() && by(FAST).runtime.as_deref() == Some(&*base.join("depth")));
        assert!(by(BAL).problem.is_none() && by(BAL).runtime.as_deref() == Some(&*base.join("depth-da3-test")));
        assert!(by(BEST).problem.is_none(), "{:?}", by(BEST).problem);
        assert!(by(BEST).runtime.as_deref().is_some_and(|r| r != base.join("depth-da3-mono-large")), "borrowed from another depth pack");
        assert!(by("nomodel").problem.as_deref().unwrap().contains("model is missing"));
        assert!(by("damaged").problem.as_deref().unwrap().contains("damaged"));
        assert!(by(FAST).size_bytes >= 2);

        // MV_DEPTH_DIR-style: any folder name counts.
        let any = scan(Some(base), true, None, &[]);
        assert!(any.iter().any(|p| p.manifest.id == "other"));
        assert!(!any.iter().any(|p| p.dir.ends_with("upscaler")), "a folder without a model isn't a pack");
    }

    #[test]
    fn runtime_comes_from_the_other_packs_last() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path().join("tools");
        std::fs::create_dir_all(&base).unwrap();
        make_pack(&base, "depth-da3-test", Some(DA3), &["model.onnx"]);
        // No runtime anywhere: reported.
        let p = scan(Some(&base), false, None, &[]);
        assert!(p[0].problem.as_deref().unwrap().contains("onnxruntime"));
        // The upscaler's (outside the depth packs) will do.
        let up = make_pack(t.path(), "upscaler", None, &[runtime_file()]);
        let p = scan(Some(&base), false, None, std::slice::from_ref(&up));
        assert!(p[0].problem.is_none());
        assert_eq!(p[0].runtime.as_deref(), Some(up.as_path()));
        // A single pack folder (MV_DEPTH) comes first and is found without a base folder.
        let single = make_pack(t.path(), "mine", None, &[MODEL_FILE, runtime_file()]);
        let p = scan(None, false, Some(&single), &[]);
        assert_eq!((p.len(), p[0].manifest.id.as_str()), (1, FAST));
    }

    #[test]
    fn the_choice_falls_back_to_the_best_installed() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        let rt = runtime_file();
        make_pack(base, "depth", None, &[MODEL_FILE, rt]);
        make_pack(base, "depth-da3-test", Some(DA3), &["model.onnx", rt]);
        let packs = scan(Some(base), false, None, &[]);
        let pick = |w: &str| choose(&packs, w).map(|p| p.manifest.id.clone());
        assert_eq!(pick("").as_deref(), Some(FAST), "nothing chosen: the best there is");
        assert_eq!(pick(BAL).as_deref(), Some(BAL), "the choice when it's there");
        assert_eq!(pick(BEST).as_deref(), Some(FAST), "Best isn't installed: the next best");
        assert_eq!(pick("nonsense").as_deref(), Some(FAST));
        assert_eq!(pick("da3-base").as_deref(), Some(FAST), "the retired Balanced: the best there is");
        // With Best there too, it wins.
        make_pack(base, "depth-da3-mono-large", Some(&manifest_for(BEST, "Best")), &["model.onnx"]);
        let packs = scan(Some(base), false, None, &[]);
        assert_eq!(choose(&packs, "").map(|p| p.manifest.id.as_str()), Some(BEST));
        // A broken one is skipped.
        let mut packs = packs;
        packs.iter_mut().find(|p| p.manifest.id == BEST).unwrap().problem = Some("broken".into());
        assert_eq!(choose(&packs, BEST).map(|p| p.manifest.id.as_str()), Some(FAST));
        // Nothing usable: nothing.
        assert!(choose(&[], "").is_none());
    }

    #[test]
    fn the_catalogue_lists_every_known_model() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        make_pack(base, "depth-da3-test", Some(DA3), &["model.onnx", runtime_file()]);
        make_pack(base, "depth-extra", Some(&manifest_for("extra", "Extra")), &["model.onnx", runtime_file()]);
        let packs = scan(Some(base), false, None, &[]);
        let list = catalogue(&packs, Some(base));
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, [FAST, FAST16, BEST, BAL, "extra"]);
        let fast = &list[0];
        assert!(!fast.installed && !fast.dynamic && fast.zip.as_deref() == Some("MediaVault-depth-windows.zip"));
        assert!(fast.problem.as_deref().unwrap().contains("MediaVault-depth-windows.zip"));
        assert!(fast.folder.as_deref().unwrap().ends_with("depth"));
        let half = &list[1];
        assert!(!half.installed && half.gpu_only && half.zip.as_deref() == Some("MediaVault-depth-v2-small-fp16-windows.zip"));
        assert_eq!((half.name.as_str(), half.standard_side), ("Fast (half precision)", 518));
        assert!(half.folder.as_deref().unwrap().ends_with("depth-v2-small-fp16"));
        let bal = &list[3];
        assert!(bal.installed && bal.problem.is_none() && bal.dynamic && bal.size_bytes > 0);
        assert_eq!((bal.standard_side, bal.high_side), (518, 756));
        assert!(!list[2].installed && list[2].folder.as_deref().unwrap().ends_with("depth-da3-mono-large"));
        assert!(!list[2].dynamic && list[2].high_side == DEFAULT_SIDE, "the published Best is fixed-size");
        assert!(!list[0].gpu_only && !list[2].gpu_only);
        let j = serde_json::to_value(half).unwrap();
        assert_eq!(j.get("gpuOnly"), Some(&serde_json::Value::Bool(true)));
    }

    /// The half-precision pack's depth.json (as depthmodels.yml writes it).
    const HALF: &str = r#"{"id":"v2-small-fp16","name":"Fast (half precision)","model":"Depth Anything V2 Small (half precision)","file":"model.onnx","output":"nearness","standardSide":518,"licence":"Apache-2.0","gpuOnly":true}"#;

    #[test]
    fn half_precision_is_for_the_graphics_card_only() {
        let m = Manifest::parse(HALF.as_bytes()).unwrap();
        assert!(m.gpu_only && !m.dynamic());
        assert_eq!(input_side(&m, Detail::High), 518);
        assert!(!Manifest::parse(DA3.as_bytes()).unwrap().gpu_only, "absent = any device");
        assert!(!Manifest::fast().gpu_only);

        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        let rt = runtime_file();
        make_pack(base, "depth", None, &[MODEL_FILE, rt]);
        make_pack(base, "depth-v2-small-fp16", Some(HALF), &["model.onnx"]);
        let mut packs = scan(Some(base), false, None, &[]);
        let half = |p: &mut Vec<Pack>| p.iter_mut().find(|p| p.manifest.id == FAST16).unwrap().gpu = true;
        let pick = |p: &[Pack], w: &str| choose(p, w).map(|p| p.manifest.id.clone());
        // No graphics card (as on this test machine): choosing it gives Fast; Automatic is Fast.
        assert!(!packs.iter().any(|p| p.gpu), "only Windows with DirectML.dll tries the graphics card");
        assert_eq!(pick(&packs, FAST16).as_deref(), Some(FAST));
        assert_eq!(pick(&packs, "").as_deref(), Some(FAST));
        // With a graphics card: used when chosen, but Automatic still never picks it.
        half(&mut packs);
        assert_eq!(pick(&packs, FAST16).as_deref(), Some(FAST16));
        assert_eq!(pick(&packs, "").as_deref(), Some(FAST));
        assert_eq!(pick(&packs, BEST).as_deref(), Some(FAST), "Best not installed: the next best, not the half one");
        // Even when it's the only pack there: only when chosen.
        let only: Vec<Pack> = packs.iter().filter(|p| p.manifest.id == FAST16).cloned().collect();
        assert_eq!(pick(&only, FAST16).as_deref(), Some(FAST16));
        assert_eq!(pick(&only, ""), None);
        // Chosen but unusable, with Best installed too: Fast comes first (Automatic still prefers Best).
        make_pack(base, "depth-da3-mono-large", Some(&manifest_for(BEST, "Best")), &["model.onnx"]);
        let packs = scan(Some(base), false, None, &[]);
        assert_eq!(pick(&packs, FAST16).as_deref(), Some(FAST));
        assert_eq!(pick(&packs, "").as_deref(), Some(BEST));
        // Settings says why it isn't used.
        let list = catalogue(&packs, Some(base));
        let e = list.iter().find(|e| e.id == FAST16).unwrap();
        assert!(e.installed && e.gpu_only && e.problem.as_deref().unwrap().contains("graphics card"), "{:?}", e.problem);
        assert!(why_not(packs.iter().find(|p| p.manifest.id == FAST16).unwrap(), &BTreeMap::new()).contains("graphics card"));
    }

    #[test]
    fn the_test_picture_is_whole() {
        let p = test_picture(14);
        assert_eq!(p.len(), 14 * 14 * 4);
        assert!(p.chunks_exact(4).all(|px| px[3] == 255));
    }

    /// The real thing, when a pack is around (writes the depth maps as PNGs, test output only):
    /// MV_DEPTH=<folder> (or MV_DEPTH_DIR=<folder of packs>) MV_DEPTH_MODEL=<id> MV_DEPTH_DETAIL=high
    /// MV_DEPTH_TEST=<a.jpg,b.png,...> MV_DEPTH_OUT=/tmp/depth-shots cargo test real_depth -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_depth() {
        let list = std::env::var("MV_DEPTH_TEST").expect("MV_DEPTH_TEST");
        let wanted = std::env::var("MV_DEPTH_MODEL").unwrap_or_default();
        let detail = Detail::from_name(std::env::var("MV_DEPTH_DETAIL").ok().as_deref());
        let out = PathBuf::from(std::env::var("MV_DEPTH_OUT").unwrap_or_else(|_| std::env::temp_dir().display().to_string()));
        std::fs::create_dir_all(&out).unwrap();
        let i = info(&wanted, detail);
        eprintln!("model {:?} at {} px ({:?})", i.model, i.input_side, i.problem);
        for p in list.split(',') {
            let img = image::open(p).unwrap().to_rgba8();
            // Like the window: scaled to the model's square size first.
            let s = i.input_side as u32;
            let (w, h) = img.dimensions();
            let small = image::imageops::resize(&img, s, s, image::imageops::FilterType::Triangle);
            let start = Instant::now();
            let soft = std::env::var("MV_DEPTH_SOFT").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);
            let map = estimate(small.as_raw(), s as usize, s as usize, &wanted, detail, soft).unwrap();
            eprintln!("{p}: {}x{} depth in {:?}", map.w, map.h, start.elapsed());
            // Back to the picture's shape, for looking at.
            let grey = image::GrayImage::from_raw(map.w as u32, map.h as u32, map.data.clone()).unwrap();
            let grey = image::imageops::resize(&grey, w, h, image::imageops::FilterType::Triangle);
            let name = Path::new(p).file_stem().unwrap().to_string_lossy().to_string();
            grey.save(out.join(format!("{name}-depth.png"))).unwrap();
            assert!(map.data.iter().any(|&v| v > 200) && map.data.iter().any(|&v| v < 60));
        }
        if let Some(id) = i.model {
            let b = benchmark(&id, detail).unwrap();
            eprintln!("speed test: {b:?}");
        }
    }
}
