//! "Background fill" (inpainting): paints in the part of a picture under a
//! mask with what is likely behind it, so the window can move the subject of
//! a 3D photo without a hole or a smeared copy of its edge showing behind it.
//!
//! Like 3D photos (depth.rs) and subject outlines (subject.rs), the models
//! are optional downloads that unzip next to the app, each in its own
//! `tools/inpaint-<id>` folder with an `inpaint.json` describing it:
//!  - "MI-GAN": MI-GAN 512 (Picsart AI Research, MIT; small and fast), `inpaint-migan`,
//!  - "LaMa": big-lama (Samsung AI Center, Apache-2.0; bigger, better on large areas), `inpaint-lama`.
//!
//! Without a pack the window uses its own simple fill ("Simple"). With
//! nothing chosen, LaMa is used when it's there, else MI-GAN.
//!
//! Both are run by ONNX Runtime on the graphics card (DirectML) or the
//! processor; ONNX Runtime comes from the pack itself or any other pack
//! (background fill, depth, subject outline, upscaler, faces). Both models take
//! a fixed 512 × 512 square (fp32): `image` 1 × 3 × 512 × 512 RGB 0–1 and
//! `mask` 1 × 1 × 512 × 512 (1 = fill), and give back `result`, the model's
//! picture of the whole square (RGB 0–1). The pixels outside the mask are kept
//! exactly; the model's are blended in with a soft edge (the blend of MI-GAN's
//! own pipeline, which .github/scripts/inpaint_export.py checks against).
//!
//! One model of this kind is kept loaded (the other one frees it first), in
//! this module's own slot (modelslot.rs): it stays loaded alongside the depth
//! and subject outline models, with its own idle timer, and loading one of
//! those never frees this one.
//!
//! The window decodes the picture in memory, scales it to the model's square
//! size and sends the pixels and the mask here; the filled picture goes
//! straight back and is kept in the window's memory only. Nothing is written
//! anywhere.
//!
//! While developing: MV_INPAINT names a single pack folder, MV_INPAINT_DIR a
//! folder holding several pack folders.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::modelslot::ModelSlot;
use crate::{depth, faceid, subject, upscale, upscale_img};

/// Each pack describes itself in this file.
pub const MANIFEST: &str = "inpaint.json";
/// Both models' input size, used when a pack or model doesn't say.
const DEFAULT_SIDE: usize = 512;
/// The model is freed after this long without use.
const IDLE_UNLOAD: Duration = Duration::from_secs(90);
/// Biggest picture accepted from the window.
const MAX_SIDE: usize = 2048;

// ---- the packs -------------------------------------------------------------------------------

/// A pack's `inpaint.json`.
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
    #[serde(default)]
    pub licence: Option<String>,
}

fn default_side() -> usize {
    DEFAULT_SIDE
}

impl Manifest {
    /// Stands in for a pack whose `inpaint.json` is missing or broken (so it can still be listed).
    fn placeholder(id: &str) -> Self {
        let known = KNOWN.iter().find(|k| k.0 == id);
        Self {
            id: id.into(),
            name: known.map(|k| k.1.to_string()).unwrap_or_else(|| id.into()),
            model: known.map(|k| k.2.to_string()).unwrap_or_default(),
            file: "model.onnx".into(),
            side: DEFAULT_SIDE,
            licence: None,
        }
    }

    /// Reads and checks an `inpaint.json`: a broken or odd one is refused with a reason,
    /// so a bad download can't point the app at some other file or a silly size.
    pub fn parse(json: &[u8]) -> Result<Self, String> {
        let m: Manifest = serde_json::from_slice(json).map_err(|e| format!("its inpaint.json can't be read ({e})"))?;
        m.validate()?;
        Ok(m)
    }

    fn validate(&self) -> Result<(), String> {
        let id_ok = !self.id.is_empty() && self.id.len() <= 40 && self.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok {
            return Err("its inpaint.json has an odd id".into());
        }
        if self.name.trim().is_empty() || self.name.len() > 40 || self.model.len() > 80 {
            return Err("its inpaint.json has an odd name".into());
        }
        // Just a file name inside the pack: never a path somewhere else.
        let file_ok = !self.file.is_empty() && !self.file.contains(['/', '\\', ':']) && self.file != "." && self.file != ".." && self.file.ends_with(".onnx");
        if !file_ok {
            return Err("its inpaint.json names an odd model file".into());
        }
        if !(64..=MAX_SIDE).contains(&self.side) {
            return Err("its inpaint.json has an odd size".into());
        }
        Ok(())
    }
}

pub const MIGAN: &str = "migan";
pub const LAMA: &str = "lama";
/// The models the app knows about, so the ones not installed can be offered
/// too: (id, name, model, download, licence).
const KNOWN: [(&str, &str, &str, &str, &str); 2] = [
    (MIGAN, "MI-GAN", "MI-GAN 512 (Places2)", "MediaVault-inpaint-migan-windows.zip", "MIT"),
    (LAMA, "LaMa", "big-lama", "MediaVault-inpaint-lama-windows.zip", "Apache-2.0"),
];
/// When nothing is chosen (or the choice isn't installed): the best one there is.
const PREFERENCE: [&str; 2] = [LAMA, MIGAN];
const NOT_INSTALLED: &str = "The background fill pack isn't installed.";

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
    format!("inpaint-{id}")
}

/// One folder → a pack (None when it isn't one at all). An `inpaint-*` folder
/// without a usable `inpaint.json` is still listed, with what's wrong.
fn read_pack(dir: &Path) -> Option<Pack> {
    if !dir.is_dir() {
        return None;
    }
    let named = dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let manifest_path = dir.join(MANIFEST);
    let id_from_folder = || named.strip_prefix("inpaint-").unwrap_or(&named).to_string();
    let (manifest, problem) = if manifest_path.is_file() {
        match std::fs::read(&manifest_path).map_err(|e| e.to_string()).and_then(|b| Manifest::parse(&b)) {
            Ok(m) => (m, None),
            Err(e) => (Manifest::placeholder(&id_from_folder()), Some(format!("The background fill pack in this folder is damaged: {e}."))),
        }
    } else if named.starts_with("inpaint-") {
        (Manifest::placeholder(&id_from_folder()), Some("The background fill pack is incomplete (inpaint.json is missing).".to_string()))
    } else {
        return None;
    };
    let size_bytes = std::fs::read_dir(dir).map(|r| r.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()).unwrap_or(0);
    let problem = problem.or_else(|| (!dir.join(&manifest.file).is_file()).then(|| "The background fill pack is incomplete (the model is missing).".to_string()));
    Some(Pack { manifest, dir: dir.to_path_buf(), problem, runtime: None, size_bytes })
}

/// Every pack in `base` (folders `inpaint-*`, or any folder with an `inpaint.json`
/// when `any_name`), plus the single pack folder `single`. Each gets its ONNX
/// Runtime: its own, else another background fill pack's, else one of `others`
/// (the depth, subject outline, upscaler and faces packs).
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
            if (name.starts_with("inpaint-") || (any_name && d.join(MANIFEST).is_file()))
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
            p.problem = Some("The background fill pack is incomplete (onnxruntime is missing).".into());
        }
    }
    packs
}

/// Where packs are looked for: (folder of pack folders, any folder name, single pack folder).
fn places() -> (Option<PathBuf>, bool, Option<PathBuf>) {
    let single = std::env::var_os("MV_INPAINT").map(PathBuf::from);
    if let Some(d) = std::env::var_os("MV_INPAINT_DIR") {
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
    // ONNX Runtime may come from any other pack: depth and subject outline packs first, then the upscaler and faces.
    let mut others: Vec<PathBuf> = depth::packs().into_iter().filter_map(|p| p.runtime).collect();
    others.extend(subject::packs().into_iter().filter_map(|p| p.runtime));
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
pub struct InpaintInfo {
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
    /// Pictures (and masks) are sent at this size (square).
    pub input_side: usize,
}

/// One row of the background fill model list in Settings.
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
    e.replace("The upscaler", "Background fill").replace("the upscaler", "background fill")
}

/// The known models (installed or not) and any other packs found, in the order MI-GAN, LaMa, others.
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
        .map(|&(id, name, model, zip, licence)| match packs.iter().find(|p| p.manifest.id == id) {
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
                licence: Some(licence.into()),
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

/// What background fill will use for this choice (model id, "" = best installed).
pub fn info(wanted: &str) -> InpaintInfo {
    let all = packs();
    let (base, _, single) = places();
    let fallback_folder = single.or_else(|| base.map(|b| b.join(folder_name(MIGAN)))).map(|d| d.display().to_string());
    let missing = |p: &str, folder: Option<String>| InpaintInfo {
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
    InpaintInfo {
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
    /// The size pictures go into the model at.
    side: usize,
    gpu: bool,
}

/// This module's own slot: kept loaded alongside the other kinds of model (modelslot.rs).
static MODEL: ModelSlot<Loaded> = ModelSlot::new(IDLE_UNLOAD);
/// Graphics card (true) or processor, per model, once it has run.
static LAST_DEVICE: Mutex<BTreeMap<String, bool>> = Mutex::new(BTreeMap::new());
/// Models whose runtime or file couldn't start at all (shown in Settings), per model.
static BROKEN: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

/// The model's own (square) input size when it is fixed; `want` otherwise.
fn session_side(session: &ort::session::Session, want: usize) -> usize {
    let dims: Vec<i64> = session
        .inputs()
        .first()
        .and_then(|i| i.dtype().tensor_shape())
        .map(|s| s.iter().copied().collect())
        .unwrap_or_default();
    match dims.as_slice() {
        [_, _, h, w] if *h > 0 && h == w => *h as usize,
        _ => want,
    }
}

fn load(pack: &Pack, gpu: bool) -> Result<Loaded, String> {
    let rt = pack.runtime.as_ref().ok_or("The background fill pack is incomplete (onnxruntime is missing).")?;
    let env = upscale::start_runtime(rt).map_err(|e| friendly(&e))?;
    let session = upscale::open_session(env, &pack.dir.join(&pack.manifest.file), gpu).map_err(|e| friendly(&e))?;
    let side = session_side(&session, pack.manifest.side);
    Ok(Loaded { session, key: pack.manifest.id.clone(), side, gpu })
}

/// Free the model now (the vault locked or the viewer closed).
pub fn unload() {
    MODEL.unload();
}

/// A background fill model is loaded now.
#[cfg(test)]
pub fn loaded() -> bool {
    MODEL.is_loaded()
}

/// Run `f` with this model (on the graphics card when possible; a failure
/// there is tried once more on the processor). One model of this kind is
/// kept; the depth and subject outline models stay as they are.
/// `loaded_ms` is set to how long loading took (0 when it was loaded already).
fn with_model<T>(pack: &Pack, loaded_ms: &mut f64, f: &mut dyn FnMut(&mut Loaded) -> Result<T, String>) -> Result<T, String> {
    let try_gpu = cfg!(windows) && pack.runtime.as_ref().is_some_and(|r| r.join("DirectML.dll").is_file());
    let key = pack.manifest.id.clone();
    let mut guard = MODEL.lock();
    if guard.as_ref().is_some_and(|l| l.key != key) {
        *guard = None; // the other fill model: free it first
    }
    *loaded_ms = 0.0;
    for attempt in 0..2 {
        if guard.is_none() {
            let first = attempt == 0 && try_gpu;
            let start = Instant::now();
            let loaded = match load(pack, first) {
                Ok(l) => Ok(l),
                Err(_) if first => load(pack, false),
                Err(e) => Err(e),
            };
            match loaded {
                Ok(l) => {
                    *loaded_ms += start.elapsed().as_secs_f64() * 1000.0;
                    *guard = Some(l);
                }
                Err(e) => {
                    BROKEN.lock().unwrap().insert(pack.manifest.id.clone(), e.clone());
                    return Err(e);
                }
            }
        }
        let loaded = guard.as_mut().expect("loaded above");
        let gpu = loaded.gpu;
        match f(loaded) {
            Ok(v) => {
                LAST_DEVICE.lock().unwrap().insert(pack.manifest.id.clone(), gpu);
                return Ok(v);
            }
            Err(_) if gpu && attempt == 0 => {
                *guard = None; // next round: the processor
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err("Background fill couldn't run.".into())
}

// ---- the maths (no model needed) --------------------------------------------------------------

/// A filled picture: `w` × `h`, RGBA.
#[derive(Debug, Clone)]
pub struct Filled {
    pub w: usize,
    pub h: usize,
    pub rgba: Zeroizing<Vec<u8>>,
}

impl Filled {
    /// What the window receives: width and height (u32, little-endian), then RGBA.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + self.rgba.len());
        out.extend_from_slice(&(self.w as u32).to_le_bytes());
        out.extend_from_slice(&(self.h as u32).to_le_bytes());
        out.extend_from_slice(&self.rgba);
        out
    }
}

/// Mask bytes → 1 (fill) or 0 (keep): 128 and up fills.
fn fill_of(mask: &[u8]) -> Vec<f32> {
    mask.iter().map(|&m| if m >= 128 { 1.0 } else { 0.0 }).collect()
}

/// Nearest-neighbour scaling of a one-channel mask (keeps it 0/1).
fn resize_nearest(src: &[f32], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
    if sw == dw && sh == dh {
        return src.to_vec();
    }
    let mut out = vec![0.0f32; dw * dh];
    for y in 0..dh {
        let sy = ((y as f64 + 0.5) * sh as f64 / dh as f64) as usize;
        for x in 0..dw {
            let sx = ((x as f64 + 0.5) * sw as f64 / dw as f64) as usize;
            out[y * dw + x] = src[sy.min(sh - 1) * sw + sx.min(sw - 1)];
        }
    }
    out
}

/// How much of the original to keep at each pixel (1 = all of it): the kept
/// area grown by one pixel (3 × 3 maximum), then softened (5 × 5 Gaussian,
/// sigma 1, mirrored at the edges). MI-GAN's own pipeline blends exactly so.
pub fn keep_weights(fill: &[f32], w: usize, h: usize) -> Vec<f32> {
    let n = w * h;
    if n == 0 || fill.len() != n {
        return Vec::new();
    }
    let keep: Vec<f32> = fill.iter().map(|f| 1.0 - f).collect();
    // Grown: the most kept of the 3 × 3 around (outside the picture doesn't count).
    let mut grown = vec![0.0f32; n];
    for y in 0..h {
        for x in 0..w {
            let mut m = 0.0f32;
            for yy in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                    m = m.max(keep[yy * w + xx]);
                }
            }
            grown[y * w + x] = m;
        }
    }
    // Softened: separable Gaussian, edges mirrored (…, 2, 1, [0, 1, 2, …]).
    let g: Vec<f32> = (0..5).map(|k| (-((k as f32 - 2.0).powi(2)) / 2.0).exp()).collect();
    let sum: f32 = g.iter().sum();
    let g: Vec<f32> = g.iter().map(|v| v / sum).collect();
    let mirror = |i: isize, len: usize| -> usize {
        let len = len as isize;
        if len == 1 {
            return 0;
        }
        let mut i = i;
        while i < 0 || i >= len {
            i = if i < 0 { -i } else { 2 * (len - 1) - i };
        }
        i as usize
    };
    let mut rows = vec![0.0f32; n];
    for y in 0..h {
        for x in 0..w {
            rows[y * w + x] = (0..5).map(|k| g[k] * grown[y * w + mirror(x as isize + k as isize - 2, w)]).sum();
        }
    }
    let mut out = vec![0.0f32; n];
    for y in 0..h {
        for x in 0..w {
            out[y * w + x] = (0..5).map(|k| g[k] * rows[mirror(y as isize + k as isize - 2, h) * w + x]).sum::<f32>().clamp(0.0, 1.0);
        }
    }
    out
}

/// The picture with the model's picture (`pred`, interleaved RGB 0–1, same
/// size) blended in where the mask says; alpha is kept as it was.
pub fn composite(rgba: &[u8], fill: &[f32], pred: &[f32], w: usize, h: usize) -> Zeroizing<Vec<u8>> {
    let keep = keep_weights(fill, w, h);
    let mut out = Zeroizing::new(rgba.to_vec());
    for i in 0..w * h {
        let k = keep[i];
        if k >= 1.0 {
            continue;
        }
        for c in 0..3 {
            let v = rgba[i * 4 + c] as f32 * k + pred[i * 3 + c].clamp(0.0, 1.0) * 255.0 * (1.0 - k);
            out[i * 4 + c] = v.round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// One picture (and its mask, as 0/1 per pixel) through the loaded model: the
/// model's picture at w × h (interleaved RGB 0–1).
fn run_once(m: &mut Loaded, rgba: &[u8], fill: &[f32], w: usize, h: usize) -> Result<Zeroizing<Vec<f32>>, String> {
    let s = m.side;
    let rgb = Zeroizing::new(rgba.chunks_exact(4).flat_map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0]).collect::<Vec<f32>>());
    let small = Zeroizing::new(upscale_img::resize(&rgb, 3, w, h, s, s));
    let small_fill = resize_nearest(fill, w, h, s, s);
    let n = s * s;
    let mut planar = vec![0.0f32; 3 * n];
    for i in 0..n {
        for c in 0..3 {
            planar[c * n + i] = small[i * 3 + c].clamp(0.0, 1.0);
        }
    }
    let err = |e: &dyn std::fmt::Display| format!("Background fill couldn't run ({e}).");
    let image = ort::value::Tensor::from_array(([1usize, 3, s, s], planar)).map_err(|e| err(&e))?;
    let mask = ort::value::Tensor::from_array(([1usize, 1, s, s], small_fill)).map_err(|e| err(&e))?;
    let out = m.session.run(ort::inputs!["image" => image, "mask" => mask]).map_err(|e| err(&e))?;
    let (shape, v) = out[0].try_extract_tensor::<f32>().map_err(|e| format!("Background fill got something unexpected back ({e})."))?;
    let dims: Vec<i64> = shape.iter().copied().collect();
    if dims.as_slice() != [1, 3, s as i64, s as i64] || v.len() != 3 * n {
        return Err("Background fill got something unexpected back.".into());
    }
    let mut inter = Zeroizing::new(vec![0.0f32; 3 * n]);
    for i in 0..n {
        for c in 0..3 {
            inter[i * 3 + c] = if v[c * n + i].is_finite() { v[c * n + i] } else { 0.0 };
        }
    }
    Ok(Zeroizing::new(upscale_img::resize(&inter, 3, s, s, w, h)))
}

fn pack_for(wanted: &str) -> Result<Pack, String> {
    let all = packs();
    let broken = BROKEN.lock().unwrap().clone();
    let ready: Vec<Pack> = all.iter().filter(|p| !broken.contains_key(&p.manifest.id)).cloned().collect();
    choose(&ready, wanted).cloned().ok_or_else(|| {
        all.iter().find(|p| p.manifest.id == wanted).and_then(|p| p.problem.clone().or_else(|| broken.get(&p.manifest.id).cloned())).unwrap_or_else(|| NOT_INSTALLED.into())
    })
}

/// Checks a picture and its mask as the window sends them.
fn check_input(rgba: &[u8], mask: &[u8], w: usize, h: usize) -> Result<(), String> {
    let n = w.checked_mul(h);
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE || n.and_then(|p| p.checked_mul(4)) != Some(rgba.len()) || n != Some(mask.len()) {
        return Err("The picture didn't arrive whole.".into());
    }
    Ok(())
}

/// The RGBA picture with the masked part (mask byte 128 and up) filled in, by
/// the chosen model ("" = best installed). Nothing to fill: the picture as it is.
pub fn estimate(rgba: &[u8], mask: &[u8], w: usize, h: usize, wanted: &str) -> Result<Filled, String> {
    check_input(rgba, mask, w, h)?;
    let fill = fill_of(mask);
    if !fill.iter().any(|&f| f > 0.0) {
        return Ok(Filled { w, h, rgba: Zeroizing::new(rgba.to_vec()) });
    }
    let pack = pack_for(wanted)?;
    let mut load_ms = 0.0;
    let pred = with_model(&pack, &mut load_ms, &mut |m| run_once(m, rgba, &fill, w, h))?;
    Ok(Filled { w, h, rgba: composite(rgba, &fill, &pred, w, h) })
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

/// A made-up picture (stripes and a disc) and a mask over its middle, so the speed test needs no real picture.
fn test_picture(side: usize) -> (Vec<u8>, Vec<u8>) {
    let mut px = vec![0u8; side * side * 4];
    let mut mask = vec![0u8; side * side];
    for y in 0..side {
        for x in 0..side {
            let i = y * side + x;
            let (dx, dy) = (x as isize - side as isize / 2, y as isize - side as isize / 2);
            let inside = dx * dx + dy * dy < (side as isize / 4).pow(2);
            px[i * 4] = if inside { 200 } else { ((x / 16) % 2 * 90 + 60) as u8 };
            px[i * 4 + 1] = (y * 200 / side) as u8 + 30;
            px[i * 4 + 2] = if inside { 40 } else { 150 };
            px[i * 4 + 3] = 255;
            mask[i] = if inside { 255 } else { 0 };
        }
    }
    (px, mask)
}

/// Time this model: three runs on a made-up picture, the first a warm-up
/// (graphics cards are slow the first time). It goes through the same lock as
/// the viewer, so it simply waits its turn.
pub fn benchmark(id: &str) -> Result<Benchmark, String> {
    let all = packs();
    let pack = all.iter().find(|p| p.manifest.id == id).ok_or("That background fill model isn't installed.")?;
    if let Some(p) = &pack.problem {
        return Err(p.clone());
    }
    let side = pack.manifest.side;
    let (picture, mask) = test_picture(side);
    let fill = fill_of(&mask);
    let mut load_ms = 0.0;
    let mut device = false;
    let ms = with_model(pack, &mut load_ms, &mut |m| {
        device = m.gpu;
        run_once(m, &picture, &fill, side, side)?;
        let start = Instant::now();
        for _ in 0..2 {
            run_once(m, &picture, &fill, side, side)?;
        }
        Ok(start.elapsed().as_secs_f64() * 1000.0 / 2.0)
    })?;
    Ok(Benchmark { ms, device: if device { "gpu" } else { "cpu" }.into(), load_ms, side })
}

// ---- commands -------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintRequest {
    pub width: usize,
    pub height: usize,
    /// The chosen model ("" or absent = best installed).
    #[serde(default)]
    pub model: String,
}

/// Body: 4 bytes (little-endian) of JSON length, the request as JSON, then RGBA
/// (w × h × 4), then the mask (w × h, 255 = fill). Returns the request, RGBA and mask.
fn split_body(body: &[u8]) -> Result<(InpaintRequest, &[u8], &[u8]), String> {
    let bad = || "The picture didn't arrive whole.".to_string();
    let n = u32::from_le_bytes(body.get(..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?) as usize;
    let json = body.get(4..4usize.checked_add(n).ok_or_else(bad)?).ok_or_else(bad)?;
    let req: InpaintRequest = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    let rest = &body[4 + n..];
    let px = req.width.checked_mul(req.height).filter(|&p| p > 0 && p <= MAX_SIDE * MAX_SIDE).ok_or_else(bad)?;
    if rest.len() != px * 5 {
        return Err(bad());
    }
    let (rgba, mask) = rest.split_at(px * 4);
    Ok((req, rgba, mask))
}

/// Which model background fill will use for this choice, whether it's there, graphics card or processor.
#[tauri::command]
pub async fn inpaint_info(model: Option<String>) -> Result<InpaintInfo, String> {
    let wanted = model.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || info(&wanted)).await.map_err(|e| e.to_string())
}

/// Every background fill model, installed or not.
#[tauri::command]
pub async fn inpaint_models() -> Result<Vec<ModelEntry>, String> {
    tauri::async_runtime::spawn_blocking(models).await.map_err(|e| e.to_string())
}

/// The picture the window sends with its masked part filled in (see `Filled::to_bytes`).
#[tauri::command]
pub async fn inpaint_estimate(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The picture didn't arrive.".into());
    };
    let (req, rgba, mask) = split_body(body)?;
    let rgba = Zeroizing::new(rgba.to_vec());
    let mask = Zeroizing::new(mask.to_vec());
    let filled = tauri::async_runtime::spawn_blocking(move || estimate(&rgba, &mask, req.width, req.height, &req.model)).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(filled.to_bytes()))
}

/// Settings → Test speed.
#[tauri::command]
pub async fn inpaint_benchmark(id: String) -> Result<Benchmark, String> {
    tauri::async_runtime::spawn_blocking(move || benchmark(&id)).await.map_err(|e| e.to_string())?
}

/// The viewer closed: free the model's memory.
#[tauri::command]
pub async fn inpaint_forget() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(unload).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MI: &str = r#"{"id":"migan","name":"MI-GAN","model":"MI-GAN 512 (Places2)","file":"model.onnx","side":512,"licence":"MIT"}"#;

    /// A pack folder: `files` are created with a byte in them; `manifest` written as inpaint.json when given.
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
        MI.replace("\"migan\"", &format!("\"{id}\"")).replace("\"MI-GAN\"", &format!("\"{name}\""))
    }

    fn body(json: &[u8], px: &[u8]) -> Vec<u8> {
        let mut b = (json.len() as u32).to_le_bytes().to_vec();
        b.extend_from_slice(json);
        b.extend_from_slice(px);
        b
    }

    #[test]
    fn bodies_split() {
        // 2 × 1: RGBA then the mask.
        let b = body(br#"{"width":2,"height":1}"#, &[1, 2, 3, 255, 4, 5, 6, 255, 0, 255]);
        let (r, px, m) = split_body(&b).unwrap();
        assert_eq!((r.width, r.height, r.model.as_str(), px.len(), m), (2, 1, "", 8, &[0u8, 255][..]));
        let b = body(br#"{"width":1,"height":1,"model":"lama"}"#, &[0, 0, 0, 255, 255]);
        assert_eq!(split_body(&b).unwrap().0.model, LAMA);
        // Missing or extra bytes, a length past the end, a silly size: refused.
        assert!(split_body(&body(br#"{"width":2,"height":1}"#, &[0; 9])).is_err(), "mask short");
        assert!(split_body(&body(br#"{"width":2,"height":1}"#, &[0; 11])).is_err(), "too much");
        assert!(split_body(&body(br#"{"width":0,"height":1}"#, &[])).is_err());
        assert!(split_body(&body(br#"{"width":100000,"height":100000}"#, &[])).is_err());
        assert!(split_body(&[255, 255, 255, 255, b'{']).is_err());
        assert!(split_body(&[]).is_err());
    }

    #[test]
    fn broken_pictures_are_refused_and_nothing_to_fill_needs_no_model() {
        assert!(estimate(&[0; 7], &[0], 1, 1, "").is_err());
        assert!(estimate(&[0; 4], &[0, 0], 1, 1, "").is_err(), "mask the wrong size");
        assert!(estimate(&[], &[], 0, 0, "").is_err());
        assert!(estimate(&vec![0; 4 * 4096], &vec![0; 4096], 4096, 1, "").is_err());
        // An empty mask (nothing at or above 128): the picture comes back as it was, no pack needed.
        let px = [10, 20, 30, 255, 40, 50, 60, 128];
        let f = estimate(&px, &[0, 127], 2, 1, "nonsense").unwrap();
        assert_eq!((f.w, f.h, &f.rgba[..]), (2, 1, &px[..]));
    }

    #[test]
    fn the_blend_keeps_the_outside_and_softens_the_edge() {
        let (w, h) = (24, 20);
        // A 12 × 12 hole in the middle.
        let mut fill = vec![0.0f32; w * h];
        for y in 4..16 {
            for x in 6..18 {
                fill[y * w + x] = 1.0;
            }
        }
        let k = keep_weights(&fill, w, h);
        assert_eq!(k.len(), w * h);
        assert!((k[0] - 1.0).abs() < 1e-6 && (k[(h - 1) * w + w - 1] - 1.0).abs() < 1e-6, "far away: all kept");
        assert!(k[10 * w + 12] < 1e-3, "the middle of the hole: all model");
        // The hole's outer ring is mostly kept (the kept area grew by one pixel), then it softens inwards.
        assert!(k[4 * w + 12] > 0.4 && k[5 * w + 12] < k[4 * w + 12] && k[6 * w + 12] < k[5 * w + 12], "{} {} {}", k[4 * w + 12], k[5 * w + 12], k[6 * w + 12]);
        assert!(k.iter().all(|v| (0.0..=1.0).contains(v)));
        // Composite: outside untouched (alpha too), inside the model's colour.
        let rgba: Vec<u8> = (0..w * h).flat_map(|i| [100, 110, 120, (i % 256) as u8]).collect();
        let pred = vec![1.0f32; w * h * 3];
        let out = composite(&rgba, &fill, &pred, w, h);
        assert_eq!(&out[..4], &rgba[..4]);
        let mid = (10 * w + 12) * 4;
        assert_eq!(&out[mid..mid + 4], &[255, 255, 255, rgba[mid + 3]]);
        assert!(out.chunks_exact(4).zip(rgba.chunks_exact(4)).all(|(a, b)| a[3] == b[3]), "alpha kept");
        // Odd sizes don't break it.
        assert!(keep_weights(&[1.0], 1, 1).len() == 1 && keep_weights(&[1.0; 3], 2, 2).is_empty());
        assert_eq!(keep_weights(&[1.0, 0.0], 2, 1).len(), 2);
    }

    #[test]
    fn masks_scale_without_greys() {
        let m = vec![0.0, 1.0, 1.0, 0.0];
        let big = resize_nearest(&m, 2, 2, 4, 4);
        assert_eq!(big.len(), 16);
        assert!(big.iter().all(|v| *v == 0.0 || *v == 1.0));
        assert_eq!((big[0], big[3], big[12]), (0.0, 1.0, 1.0));
        assert_eq!(resize_nearest(&big, 4, 4, 2, 2), m);
        assert_eq!(fill_of(&[0, 127, 128, 255]), vec![0.0, 0.0, 1.0, 1.0]);
    }

    #[test]
    fn filled_pictures_go_out_with_their_size() {
        let b = Filled { w: 1, h: 2, rgba: Zeroizing::new(vec![1, 2, 3, 4, 5, 6, 7, 8]) }.to_bytes();
        assert_eq!(&b[..8], &[1, 0, 0, 0, 2, 0, 0, 0]);
        assert_eq!(&b[8..], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn manifests_are_read_and_checked() {
        let m = Manifest::parse(MI.as_bytes()).unwrap();
        assert_eq!((m.id.as_str(), m.name.as_str(), m.file.as_str(), m.side, m.licence.as_deref()), (MIGAN, "MI-GAN", "model.onnx", 512, Some("MIT")));
        let short = Manifest::parse(br#"{"id":"x","name":"X","model":"M","file":"m.onnx"}"#).unwrap();
        assert_eq!((short.side, short.licence), (512, None));
        for bad in [
            "not json".to_string(),
            MI.replace("model.onnx", "..\\\\..\\\\evil.onnx"),
            MI.replace("model.onnx", "a/model.onnx"),
            MI.replace("model.onnx", "model.exe"),
            MI.replace("\"migan\"", "\"MI GAN!\""),
            MI.replace("512", "16"),
            MI.replace("512", "9000"),
            MI.replace("\"MI-GAN\"", "\"  \""),
        ] {
            assert!(Manifest::parse(bad.as_bytes()).is_err(), "{bad}");
        }
        assert!(Manifest::placeholder(LAMA).validate().is_ok());
        assert_eq!(Manifest::placeholder(LAMA).name, "LaMa");
    }

    #[test]
    fn pack_folders_are_found_and_checked() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        let rt = runtime_file();
        make_pack(base, "inpaint-migan", Some(MI), &["model.onnx", rt]);
        make_pack(base, "inpaint-lama", Some(&manifest_for(LAMA, "LaMa")), &["model.onnx"]);
        make_pack(base, "inpaint-nomodel", Some(&manifest_for("nomodel", "Empty")), &[rt]);
        make_pack(base, "inpaint-damaged", Some("{ nope"), &["model.onnx"]);
        make_pack(base, "inpaint-bare", None, &["model.onnx"]);
        make_pack(base, "subject-birefnet", None, &["model.onnx", rt]);
        make_pack(base, "other", Some(&manifest_for("other", "Other")), &["model.onnx", rt]);

        let packs = scan(Some(base), false, None, &[]);
        let ids: Vec<&str> = packs.iter().map(|p| p.manifest.id.as_str()).collect();
        assert_eq!(ids, ["bare", "damaged", LAMA, MIGAN, "nomodel"], "{ids:?}");
        let by = |id: &str| packs.iter().find(|p| p.manifest.id == id).unwrap();
        assert!(by(MIGAN).problem.is_none() && by(MIGAN).runtime.as_deref() == Some(&*base.join("inpaint-migan")));
        assert_eq!(by(LAMA).runtime.as_deref(), Some(&*base.join("inpaint-migan")), "borrowed from the other fill pack");
        assert!(by("nomodel").problem.as_deref().unwrap().contains("model is missing"));
        assert!(by("damaged").problem.as_deref().unwrap().contains("damaged"));
        assert!(by("bare").problem.as_deref().unwrap().contains("inpaint.json is missing"));
        let any = scan(Some(base), true, None, &[]);
        assert!(any.iter().any(|p| p.manifest.id == "other"));
        assert!(!any.iter().any(|p| p.dir.ends_with("subject-birefnet")));
    }

    #[test]
    fn runtime_comes_from_the_other_packs_last() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path().join("tools");
        std::fs::create_dir_all(&base).unwrap();
        make_pack(&base, "inpaint-migan", Some(MI), &["model.onnx"]);
        assert!(scan(Some(&base), false, None, &[])[0].problem.as_deref().unwrap().contains("onnxruntime"));
        let dp = make_pack(&base, "depth", None, &[runtime_file()]);
        let p = scan(Some(&base), false, None, std::slice::from_ref(&dp));
        assert!(p[0].problem.is_none());
        assert_eq!(p[0].runtime.as_deref(), Some(dp.as_path()));
        let single = make_pack(t.path(), "mine", Some(&manifest_for("mine", "Mine")), &["model.onnx", runtime_file()]);
        let p = scan(None, false, Some(&single), &[]);
        assert_eq!((p.len(), p[0].manifest.id.as_str()), (1, "mine"));
    }

    #[test]
    fn the_choice_falls_back_to_the_best_installed() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        make_pack(base, "inpaint-migan", Some(MI), &["model.onnx", runtime_file()]);
        let packs = scan(Some(base), false, None, &[]);
        let pick = |p: &[Pack], w: &str| choose(p, w).map(|p| p.manifest.id.clone());
        assert_eq!(pick(&packs, "").as_deref(), Some(MIGAN), "LaMa not installed: MI-GAN");
        assert_eq!(pick(&packs, LAMA).as_deref(), Some(MIGAN));
        make_pack(base, "inpaint-lama", Some(&manifest_for(LAMA, "LaMa")), &["model.onnx"]);
        let mut packs = scan(Some(base), false, None, &[]);
        assert_eq!(pick(&packs, "").as_deref(), Some(LAMA), "nothing chosen: LaMa");
        assert_eq!(pick(&packs, MIGAN).as_deref(), Some(MIGAN));
        packs.iter_mut().find(|p| p.manifest.id == LAMA).unwrap().problem = Some("broken".into());
        assert_eq!(pick(&packs, "").as_deref(), Some(MIGAN));
        assert!(choose(&[], "").is_none());
    }

    #[test]
    fn the_catalogue_lists_every_known_model() {
        let t = tempfile::tempdir().unwrap();
        let base = t.path();
        make_pack(base, "inpaint-migan", Some(MI), &["model.onnx", runtime_file()]);
        make_pack(base, "inpaint-extra", Some(&manifest_for("extra", "Extra")), &["model.onnx", runtime_file()]);
        let list = catalogue(&scan(Some(base), false, None, &[]), Some(base));
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, [MIGAN, LAMA, "extra"]);
        assert!(list[0].installed && list[0].problem.is_none() && list[0].zip.as_deref() == Some("MediaVault-inpaint-migan-windows.zip"));
        let lama = &list[1];
        assert!(!lama.installed && lama.zip.as_deref() == Some("MediaVault-inpaint-lama-windows.zip"));
        assert!(lama.problem.as_deref().unwrap().contains("MediaVault-inpaint-lama-windows.zip"));
        assert!(lama.folder.as_deref().unwrap().ends_with("inpaint-lama"));
        assert_eq!((lama.name.as_str(), lama.input_side, lama.licence.as_deref()), ("LaMa", 512, Some("Apache-2.0")));
        let j = serde_json::to_value(&list[0]).unwrap();
        for k in ["id", "name", "model", "folder", "installed", "problem", "sizeBytes", "zip", "inputSide", "licence"] {
            assert!(j.get(k).is_some(), "{k}");
        }
        let none = catalogue(&[], None);
        assert_eq!(none.len(), 2);
        assert!(none.iter().all(|e| !e.installed && e.folder.is_none()));
        assert_eq!(none[0].licence.as_deref(), Some("MIT"));
    }

    #[test]
    fn info_and_benchmark_speak_camel_case() {
        let i = InpaintInfo { available: false, problem: None, folder: None, device: None, device_known: false, model: None, model_name: None, input_side: 512 };
        let j = serde_json::to_value(&i).unwrap();
        for k in ["available", "problem", "folder", "device", "deviceKnown", "model", "modelName", "inputSide"] {
            assert!(j.get(k).is_some(), "{k}");
        }
        let b = serde_json::to_value(Benchmark { ms: 1.0, device: "cpu".into(), load_ms: 2.0, side: 512 }).unwrap();
        for k in ["ms", "device", "loadMs", "side"] {
            assert!(b.get(k).is_some(), "{k}");
        }
    }

    #[test]
    fn the_test_picture_is_whole() {
        let (p, m) = test_picture(32);
        assert_eq!((p.len(), m.len()), (32 * 32 * 4, 32 * 32));
        assert!(m.contains(&255) && m.contains(&0));
    }

    /// The real thing, when a pack is around (writes the filled pictures as PNGs, test output only):
    /// MV_INPAINT=<folder> (or MV_INPAINT_DIR=<folder of packs>) MV_INPAINT_MODEL=<id>
    /// MV_INPAINT_TEST=<a.jpg,b.png,...> MV_INPAINT_OUT=/tmp/inpaint-shots cargo test real_inpaint -- --ignored --nocapture
    /// The mask is a centred ellipse (MV_INPAINT_MASK=<a mask picture> uses that instead, white = fill).
    #[test]
    #[ignore]
    fn real_inpaint() {
        let list = std::env::var("MV_INPAINT_TEST").expect("MV_INPAINT_TEST");
        let wanted = std::env::var("MV_INPAINT_MODEL").unwrap_or_default();
        let out = PathBuf::from(std::env::var("MV_INPAINT_OUT").unwrap_or_else(|_| std::env::temp_dir().display().to_string()));
        std::fs::create_dir_all(&out).unwrap();
        let i = info(&wanted);
        eprintln!("model {:?} at {} px ({:?})", i.model, i.input_side, i.problem);
        let tag = i.model.clone().unwrap_or_default();
        let s = i.input_side as u32;
        for p in list.split(',') {
            let img = image::open(p).unwrap().to_rgba8();
            // Like the window: scaled to the model's square size first.
            let small = image::imageops::resize(&img, s, s, image::imageops::FilterType::Triangle);
            let mask: Vec<u8> = match std::env::var("MV_INPAINT_MASK") {
                Ok(m) => image::imageops::resize(&image::open(m).unwrap().to_luma8(), s, s, image::imageops::FilterType::Nearest).into_raw(),
                Err(_) => (0..s * s)
                    .map(|k| {
                        let (x, y) = ((k % s) as f64 / s as f64 - 0.5, (k / s) as f64 / s as f64 - 0.5);
                        if (x / 0.2).powi(2) + (y / 0.28).powi(2) < 1.0 { 255 } else { 0 }
                    })
                    .collect(),
            };
            let start = Instant::now();
            let filled = estimate(small.as_raw(), &mask, s as usize, s as usize, &wanted).unwrap();
            eprintln!("{p}: {}x{} filled in {:?}", filled.w, filled.h, start.elapsed());
            let name = Path::new(p).file_stem().unwrap().to_string_lossy().to_string();
            // The input with the hole shown in magenta, and the result.
            let mut holed = small.clone();
            for (px, m) in holed.pixels_mut().zip(&mask) {
                if *m >= 128 {
                    *px = image::Rgba([255, 0, 255, 255]);
                }
            }
            holed.save(out.join(format!("{name}-{tag}-hole.png"))).unwrap();
            let pic = image::RgbaImage::from_raw(filled.w as u32, filled.h as u32, filled.rgba.to_vec()).unwrap();
            pic.save(out.join(format!("{name}-{tag}-filled.png"))).unwrap();
            // Outside the mask (and away from its soft edge) the picture is untouched; inside it changed.
            let keep = keep_weights(&fill_of(&mask), s as usize, s as usize);
            for (k, (a, b)) in keep.iter().zip(small.as_raw().chunks_exact(4).zip(filled.rgba.chunks_exact(4))) {
                if *k >= 1.0 {
                    assert_eq!(a, b);
                }
            }
            assert!(small.as_raw() != &filled.rgba[..]);
        }
        if let Some(id) = i.model {
            let b = benchmark(&id).unwrap();
            eprintln!("speed test: {b:?}");
        }
    }

    /// Depth, subject outline and background fill models loaded together (each in its own slot):
    /// MV_DEPTH=… MV_SUBJECT=… MV_INPAINT=… cargo test real_models_together -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_models_together() {
        let (px, mask) = test_picture(256);
        depth::estimate(&px, 256, 256, "", depth::Detail::Standard, 1.0).unwrap();
        subject::estimate(&px, 256, 256, "").unwrap();
        estimate(&px, &mask, 256, 256, "").unwrap();
        assert!(depth::loaded() && subject::loaded() && loaded(), "all three stay loaded");
        // Loading one again (or using it) frees none of the others.
        estimate(&px, &mask, 256, 256, "").unwrap();
        assert!(depth::loaded() && subject::loaded() && loaded());
        unload();
        assert!(depth::loaded() && subject::loaded() && !loaded(), "freeing one frees only that one");
        depth::unload();
        subject::unload();
    }
}
