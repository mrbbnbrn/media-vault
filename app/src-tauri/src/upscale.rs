//! The offline AI upscaler: makes a picture 4 times bigger in the viewer.
//!
//! Two models, run by ONNX Runtime on the graphics card (DirectML) or, if
//! that isn't possible, on the processor:
//!  - Real-ESRGAN x4plus: the whole picture, faces left as they are.
//!  - GFPGAN v1.4: Real-ESRGAN for the whole picture, then every face is
//!    rebuilt at 512 × 512 and blended back in with a soft edge.
//!
//! The window decodes the picture (exactly as it is shown), finds the faces
//! and sends the pixels here. Everything stays in memory: results are kept
//! (encrypted nowhere, written nowhere) while the viewer is open, are shown
//! through `vault://localhost/upscaled/<token>`, and only "Save upscaled"
//! stores one, encrypted, as a new item next to the original.
//!
//! The upscaler is an optional download: `tools/upscaler` next to the app
//! (onnxruntime.dll, DirectML.dll and the two .onnx models), or the folder
//! named by MV_UPSCALER while developing. Without it the app runs as normal.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

use crate::import;
use crate::session::Session;
use crate::upscale_img::{self as img, Plan, STOPPED};

pub const ESRGAN_FILE: &str = "realesrgan-x4plus.onnx";
pub const GFPGAN_FILE: &str = "gfpgan-v1.4.onnx";
/// Most faces rebuilt in one picture.
const MAX_FACES: usize = 30;
/// Faces whose eyes are closer than this (pixels) are too small to rebuild.
const MIN_EYE_DISTANCE: f32 = 5.0;
/// Results kept in memory at once (the oldest goes first).
const KEEP_RESULTS: usize = 4;

fn runtime_name() -> &'static str {
    if cfg!(windows) {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    }
}

// ---- finding the pack --------------------------------------------------------------------

/// The upscaler folder: MV_UPSCALER, or `tools/upscaler` next to the app.
pub fn pack_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("MV_UPSCALER") {
        return Some(PathBuf::from(d));
    }
    Some(std::env::current_exe().ok()?.parent()?.join("tools").join("upscaler"))
}

/// The runtime library in `dir` (on Linux also a versioned libonnxruntime.so.1.x).
pub(crate) fn runtime_in(dir: &Path) -> Option<PathBuf> {
    let p = dir.join(runtime_name());
    if p.is_file() {
        return Some(p);
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("libonnxruntime.so.")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscalerInfo {
    pub available: bool,
    /// Why not, in one short sentence.
    pub problem: Option<String>,
    /// Where it is looked for.
    pub folder: Option<String>,
    /// "gpu" or "cpu" once it has run; before that, "gpu" when DirectML is there.
    pub device: Option<String>,
    /// True once a model has actually run (so `device` is certain).
    pub device_known: bool,
}

pub fn info() -> UpscalerInfo {
    let dir = pack_dir();
    let folder = dir.as_ref().map(|d| d.display().to_string());
    let missing = |problem: &str| UpscalerInfo {
        available: false,
        problem: Some(problem.to_string()),
        folder: folder.clone(),
        device: None,
        device_known: false,
    };
    let Some(dir) = dir.filter(|d| d.is_dir()) else {
        return missing("The upscaler pack isn't installed.");
    };
    if runtime_in(&dir).is_none() {
        return missing("The upscaler pack is incomplete (onnxruntime is missing).");
    }
    if !dir.join(ESRGAN_FILE).is_file() || !dir.join(GFPGAN_FILE).is_file() {
        return missing("The upscaler pack is incomplete (a model is missing).");
    }
    if let Some(Err(e)) = RUNTIME.get() {
        return missing(e);
    }
    let known = *LAST_DEVICE.lock().unwrap();
    let guess = if cfg!(windows) && dir.join("DirectML.dll").is_file() { "gpu" } else { "cpu" };
    UpscalerInfo {
        available: true,
        problem: None,
        folder,
        device: Some(known.map(|g| if g { "gpu" } else { "cpu" }).unwrap_or(guess).to_string()),
        device_known: known.is_some(),
    }
}

// ---- the runtime and the models --------------------------------------------------------

static RUNTIME: OnceLock<Result<ort::environment::Environment, String>> = OnceLock::new();
/// Whether the last model ran on the graphics card.
static LAST_DEVICE: Mutex<Option<bool>> = Mutex::new(None);

pub(crate) fn start_runtime(dir: &Path) -> Result<&'static ort::environment::Environment, String> {
    RUNTIME
        .get_or_init(|| {
            let lib = runtime_in(dir).ok_or("The upscaler pack is incomplete (onnxruntime is missing).")?;
            // The DirectML that came with the pack, not the older one in Windows.
            let dml = dir.join("DirectML.dll");
            if cfg!(windows) && dml.is_file() {
                let _ = ort::util::preload_dylib(dml.as_path());
            }
            ort::init_from(&lib)
                .map_err(|e| format!("The upscaler couldn't start ({e})."))?
                .with_name("MediaVault")
                .with_telemetry(false)
                .build()
                .map_err(|e| format!("The upscaler couldn't start ({e})."))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Model {
    Realesrgan,
    Gfpgan,
}

impl Model {
    fn file(self) -> &'static str {
        match self {
            Model::Realesrgan => ESRGAN_FILE,
            Model::Gfpgan => GFPGAN_FILE,
        }
    }
}

struct Loaded {
    esrgan: Option<ort::session::Session>,
    gfpgan: Option<ort::session::Session>,
    gpu: bool,
}

/// Models stay loaded while the viewer is open (GFPGAN takes a while to load).
static MODELS: Mutex<Option<Loaded>> = Mutex::new(None);

pub(crate) fn open_session(env: &ort::environment::Environment, path: &Path, gpu: bool) -> Result<ort::session::Session, String> {
    let err = |e: &dyn std::fmt::Display| format!("The upscaler couldn't load its model ({e}).");
    let mut b = ort::session::Session::builder(env).map_err(|e| err(&e))?;
    if !gpu {
        b = b.with_execution_providers([ort::ep::CPU::default().build()]).map_err(|e| err(&e))?;
    } else {
        // DirectML wants these two off.
        b = b.with_memory_pattern(false).map_err(|e| err(&e))?;
        b = b.with_parallel_execution(false).map_err(|e| err(&e))?;
        b = b
            .with_execution_providers([ort::ep::DirectML::default().build().error_on_failure()])
            .map_err(|e| err(&e))?;
    }
    b.commit_from_file(path).map_err(|e| err(&e))
}

/// Run `f` with the model loaded (on the graphics card if possible). A model
/// that fails on the graphics card is tried once more on the processor.
fn with_model<T>(
    dir: &Path,
    model: Model,
    f: &mut dyn FnMut(&mut ort::session::Session) -> Result<T, String>,
) -> Result<T, String> {
    let env = start_runtime(dir)?;
    let try_gpu = cfg!(windows) && dir.join("DirectML.dll").is_file();
    let mut guard = MODELS.lock().unwrap();
    for attempt in 0..2 {
        let loaded = guard.get_or_insert_with(|| Loaded { esrgan: None, gfpgan: None, gpu: try_gpu });
        let slot = match model {
            Model::Realesrgan => &mut loaded.esrgan,
            Model::Gfpgan => &mut loaded.gfpgan,
        };
        if slot.is_none() {
            let path = dir.join(model.file());
            match open_session(env, &path, loaded.gpu) {
                Ok(s) => *slot = Some(s),
                Err(_) if loaded.gpu => {
                    // No usable graphics card: everything on the processor from now on.
                    *guard = Some(Loaded { esrgan: None, gfpgan: None, gpu: false });
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        let gpu = loaded.gpu;
        let session = slot.as_mut().expect("loaded above");
        match f(session) {
            Ok(v) => {
                *LAST_DEVICE.lock().unwrap() = Some(gpu);
                return Ok(v);
            }
            Err(e) if e == STOPPED => return Err(e),
            Err(_) if gpu && attempt == 0 => {
                *guard = Some(Loaded { esrgan: None, gfpgan: None, gpu: false });
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err("The upscaler couldn't run.".into())
}

/// Planar f32 in, planar f32 out (1 × 3 × H × W).
fn run_planar(session: &mut ort::session::Session, data: Vec<f32>, side: usize) -> Result<Vec<f32>, String> {
    let input = ort::value::Tensor::from_array(([1usize, 3, side, side], data))
        .map_err(|e| format!("The upscaler couldn't run ({e})."))?;
    let out = session
        .run(ort::inputs![input])
        .map_err(|e| format!("The upscaler couldn't run ({e})."))?;
    let (_, v) = out[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("The upscaler gave back something unexpected ({e})."))?;
    Ok(v.to_vec())
}

/// Free the models' memory (when the viewer closes).
pub fn unload() {
    *MODELS.lock().unwrap() = None;
}

// ---- results kept in memory ---------------------------------------------------------------

struct Stored {
    token: u64,
    item: i64,
    model: Model,
    width: usize,
    height: usize,
    /// RGB or RGBA, 8 bits.
    pixels: Arc<Zeroizing<Vec<u8>>>,
    alpha: bool,
    /// The same as a quick PNG, for showing.
    png: Arc<Zeroizing<Vec<u8>>>,
}

static RESULTS: Mutex<Vec<Stored>> = Mutex::new(Vec::new());
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// The picture behind `vault://localhost/upscaled/<token>` (PNG).
pub fn shown(token: u64) -> Option<Arc<Zeroizing<Vec<u8>>>> {
    RESULTS.lock().unwrap().iter().find(|r| r.token == token).map(|r| r.png.clone())
}

/// Forget every result (the viewer closed, or the vault locked).
pub fn forget_all() {
    RESULTS.lock().unwrap().clear();
}

// ---- running a job --------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub item_id: i64,
    pub width: usize,
    pub height: usize,
    pub model: Model,
    /// Per face: eye on the left of the picture, other eye, nose tip, mouth
    /// left, mouth right; picture pixels.
    #[serde(default)]
    pub faces: Vec<[[f32; 2]; 5]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub job: u64,
    /// 0…1.
    pub fraction: f64,
    /// "loading", "picture", "faces" or "finishing".
    pub stage: &'static str,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    pub job: u64,
    /// Show it from `vault://localhost/upscaled/<token>`.
    pub token: Option<u64>,
    pub width: usize,
    pub height: usize,
    /// e.g. 4.0, or 2.3 for bigger pictures.
    pub factor: f64,
    /// Faces rebuilt (GFPGAN).
    pub faces: usize,
    /// "gpu" or "cpu".
    pub device: Option<String>,
    pub cancelled: bool,
    pub error: Option<String>,
}

/// The job running now (a new one stops it).
static CURRENT: Mutex<Option<(u64, Arc<AtomicBool>)>> = Mutex::new(None);
/// One job runs at a time.
static GATE: Mutex<()> = Mutex::new(());
static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

/// A new job: stops the one before. Returns its number and cancel flag.
pub fn new_job() -> (u64, Arc<AtomicBool>) {
    let job = NEXT_JOB.fetch_add(1, Ordering::SeqCst);
    let flag = Arc::new(AtomicBool::new(false));
    if let Some((_, old)) = CURRENT.lock().unwrap().replace((job, flag.clone())) {
        old.store(true, Ordering::SeqCst);
    }
    (job, flag)
}

pub fn cancel() {
    if let Some((_, f)) = CURRENT.lock().unwrap().as_ref() {
        f.store(true, Ordering::SeqCst);
    }
}

fn end_job(job: u64) {
    let mut c = CURRENT.lock().unwrap();
    if c.as_ref().is_some_and(|(j, _)| *j == job) {
        *c = None;
    }
}

/// Upscale `rgba` (the picture as the window shows it). Blocks; run it on its
/// own thread.
pub fn run(
    s: &Session,
    job: u64,
    req: &Request,
    rgba: &[u8],
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&Progress),
) -> Done {
    let _turn = GATE.lock().unwrap_or_else(|e| e.into_inner());
    let mut done = Done { job, ..Default::default() };
    let stop = || cancel.load(Ordering::SeqCst) || s.is_closed();
    let r = (|| -> Result<(), String> {
        if stop() {
            return Err(STOPPED.into());
        }
        let dir = pack_dir()
            .filter(|d| info_ok(d))
            .ok_or("The upscaler pack isn't installed. Download it from the Releases page and unzip it next to the app.")?;
        let (w, h) = (req.width, req.height);
        if w.checked_mul(h).and_then(|p| p.checked_mul(4)) != Some(rgba.len()) {
            return Err("The picture didn't arrive whole.".into());
        }
        let plan = img::plan(w, h)?;
        done.factor = (plan.factor(w) * 10.0).round() / 10.0;
        // Everything as 0…1; alpha kept apart.
        let mut rgb = Zeroizing::new(vec![0.0f32; w * h * 3]);
        let mut alpha: Option<Vec<f32>> = None;
        for (i, p) in rgba.chunks_exact(4).enumerate() {
            rgb[i * 3] = p[0] as f32 / 255.0;
            rgb[i * 3 + 1] = p[1] as f32 / 255.0;
            rgb[i * 3 + 2] = p[2] as f32 / 255.0;
            if p[3] != 255 && alpha.is_none() {
                alpha = Some(rgba.chunks_exact(4).map(|q| q[3] as f32 / 255.0).collect());
            }
        }
        let faces: Vec<[[f32; 2]; 5]> = if req.model == Model::Gfpgan {
            req.faces
                .iter()
                .filter(|f| f.iter().flatten().all(|v| v.is_finite()) && img::eye_distance(f) >= MIN_EYE_DISTANCE)
                .take(MAX_FACES)
                .copied()
                .collect()
        } else {
            Vec::new()
        };
        let face_share = if faces.is_empty() { 0.0 } else { 0.25 };

        // 1. The whole picture (or the same picture from Real-ESRGAN, kept from before).
        progress(&Progress { job, fraction: 0.0, stage: "loading" });
        let reuse = reuse_background(req.item_id, plan);
        let mut out: Zeroizing<Vec<f32>> = match reuse {
            Some(px) => Zeroizing::new(px.chunks_exact(if px.len() == plan.out_w * plan.out_h * 4 { 4 } else { 3 })
                .flat_map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
                .collect()),
            None => {
                let small = Zeroizing::new(img::resize(&rgb, 3, w, h, plan.in_w, plan.in_h));
                let side = img::TILE;
                Zeroizing::new(with_model(&dir, Model::Realesrgan, &mut |session| {
                    img::upscale_tiled(
                        &small,
                        plan.in_w,
                        plan.in_h,
                        &mut |tile| run_planar(session, tile.to_vec(), side),
                        &mut |d, t| {
                            progress(&Progress { job, fraction: (1.0 - face_share) * d as f64 / t as f64, stage: "picture" });
                            !stop()
                        },
                    )
                })?)
            }
        };
        if stop() {
            return Err(STOPPED.into());
        }

        // 2. Faces, rebuilt one by one from the original picture.
        let s_out = plan.out_w as f32 / w as f32;
        let n = faces.len();
        if n > 0 {
            progress(&Progress { job, fraction: 1.0 - face_share, stage: "faces" });
            with_model(&dir, Model::Gfpgan, &mut |session| {
                for (i, pts) in faces.iter().enumerate() {
                    if stop() {
                        return Err(STOPPED.into());
                    }
                    let Some(m) = img::face_transform(pts) else { continue };
                    let crop = img::warp_face(&rgb, w, h, &m);
                    let fixed = Zeroizing::new(run_planar(session, crop, img::FACE)?);
                    if fixed.len() != 3 * img::FACE * img::FACE {
                        return Err("The face model gave back something unexpected.".into());
                    }
                    img::paste_face(&mut out, plan.out_w, plan.out_h, s_out, &m, &fixed);
                    progress(&Progress {
                        job,
                        fraction: 1.0 - face_share + face_share * (i + 1) as f64 / n as f64,
                        stage: "faces",
                    });
                }
                Ok(())
            })?;
            done.faces = n;
        }
        if stop() {
            return Err(STOPPED.into());
        }

        // 3. To 8 bits, alpha resized alongside, and a quick PNG for showing.
        progress(&Progress { job, fraction: 1.0, stage: "finishing" });
        let ch = if alpha.is_some() { 4 } else { 3 };
        let big_alpha = alpha.map(|a| img::resize(&a, 1, w, h, plan.out_w, plan.out_h));
        let mut px = Zeroizing::new(vec![0u8; plan.out_w * plan.out_h * ch]);
        for i in 0..plan.out_w * plan.out_h {
            for c in 0..3 {
                px[i * ch + c] = (out[i * 3 + c] * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
            }
            if let Some(a) = &big_alpha {
                px[i * ch + 3] = (a[i] * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
            }
        }
        drop(out);
        let png = encode_png(&px, plan.out_w, plan.out_h, ch == 4, png::Compression::Fast)?;
        let token = NEXT_TOKEN.fetch_add(1, Ordering::SeqCst);
        let mut keep = RESULTS.lock().unwrap();
        keep.retain(|r| !(r.item == req.item_id && r.model == req.model));
        while keep.len() >= KEEP_RESULTS {
            keep.remove(0);
        }
        keep.push(Stored {
            token,
            item: req.item_id,
            model: req.model,
            width: plan.out_w,
            height: plan.out_h,
            pixels: Arc::new(px),
            alpha: ch == 4,
            png: Arc::new(png),
        });
        done.token = Some(token);
        done.width = plan.out_w;
        done.height = plan.out_h;
        done.device = LAST_DEVICE.lock().unwrap().map(|g| if g { "gpu".into() } else { "cpu".into() });
        Ok(())
    })();
    match r {
        Ok(()) => {}
        Err(e) if e == STOPPED => done.cancelled = true,
        Err(e) => done.error = Some(e),
    }
    end_job(job);
    done
}

fn info_ok(dir: &Path) -> bool {
    runtime_in(dir).is_some() && dir.join(ESRGAN_FILE).is_file() && dir.join(GFPGAN_FILE).is_file()
}

/// A Real-ESRGAN result of the same item at the same size: GFPGAN only has
/// to do the faces then.
fn reuse_background(item: i64, plan: Plan) -> Option<Arc<Zeroizing<Vec<u8>>>> {
    RESULTS
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.item == item && r.model == Model::Realesrgan && r.width == plan.out_w && r.height == plan.out_h)
        .map(|r| r.pixels.clone())
}

// ---- saving ------------------------------------------------------------------------------

fn encode_png(px: &[u8], w: usize, h: usize, alpha: bool, level: png::Compression) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut out = Zeroizing::new(Vec::with_capacity(px.len() / 2));
    {
        let mut enc = png::Encoder::new(&mut *out, w as u32, h as u32);
        enc.set_color(if alpha { png::ColorType::Rgba } else { png::ColorType::Rgb });
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(level);
        let mut wr = enc.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(px).map_err(|e| e.to_string())?;
        wr.finish().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn encode_jpeg(px: &[u8], w: usize, h: usize) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut out = Zeroizing::new(Vec::with_capacity(px.len() / 6));
    let mut enc = jpeg_encoder::Encoder::new(&mut *out, 95);
    enc.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4);
    enc.set_optimized_huffman_tables(true);
    let (w16, h16) = (u16::try_from(w).map_err(|_| "too wide")?, u16::try_from(h).map_err(|_| "too tall")?);
    enc.encode(px, w16, h16, jpeg_encoder::ColorType::Rgb).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Photos (JPEG, WebP…) are saved as a high-quality JPEG (a PNG would be
/// huge); PNGs, pictures with see-through parts and the rest as PNG.
fn save_as_jpeg(ext: &str, alpha: bool) -> bool {
    !alpha && matches!(ext, "jpg" | "jpeg" | "jfif" | "webp" | "heic" | "heif" | "avif")
}

/// "Beach.jpg" → "Beach (upscaled).jpg", or "(upscaled 2)" if that is taken.
fn upscaled_name(original: &str, ext: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let stem = Path::new(original)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Picture".into());
    for n in 1.. {
        let name = if n == 1 { format!("{stem} (upscaled).{ext}") } else { format!("{stem} (upscaled {n}).{ext}") };
        if !taken(&name) {
            return name;
        }
    }
    unreachable!()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub id: i64,
    pub name: String,
}

/// Store a result as a new item in the original's folder, with the same
/// date taken and tags. The original isn't touched.
pub fn save(s: &Session, token: u64) -> Result<Saved, String> {
    let (item, w, h, px, alpha) = {
        let r = RESULTS.lock().unwrap();
        let st = r.iter().find(|r| r.token == token).ok_or("That upscaled picture is no longer in memory. Upscale it again.")?;
        (st.item, st.width, st.height, st.pixels.clone(), st.alpha)
    };
    let (folder, name, ext): (Option<i64>, String, String) = s
        .db()
        .query_row(
            "SELECT folder_id, original_name, ext FROM media WHERE id = ? AND deleted_at IS NULL",
            [item],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?.to_ascii_lowercase())),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("The original is no longer in the library.")?;
    let jpeg = save_as_jpeg(&ext, alpha);
    let bytes = if jpeg { encode_jpeg(&px, w, h)? } else { encode_png(&px, w, h, alpha, png::Compression::Balanced)? };
    let new_name = {
        let db = s.db();
        let taken = |n: &str| {
            db.query_row(
                "SELECT 1 FROM media WHERE IFNULL(folder_id, 0) = IFNULL(?1, 0) AND original_name = ?2 AND deleted_at IS NULL",
                params![folder, n],
                |_| Ok(()),
            )
            .is_ok()
        };
        upscaled_name(&name, if jpeg { "jpg" } else { "png" }, &taken)
    };
    let id = import::add_bytes(s, folder, &new_name, &bytes)?;
    {
        let db = s.db();
        db.execute("UPDATE media SET width = ?1, height = ?2 WHERE id = ?3", params![w as i64, h as i64, id])
            .map_err(|e| e.to_string())?;
        db.execute(
            "UPDATE media SET taken_at = (SELECT taken_at FROM media WHERE id = ?1), \
             file_mtime = (SELECT file_mtime FROM media WHERE id = ?1) WHERE id = ?2",
            params![item, id],
        )
        .map_err(|e| e.to_string())?;
        db.execute(
            "INSERT OR IGNORE INTO media_tags(media_id, tag_id) SELECT ?1, tag_id FROM media_tags WHERE media_id = ?2",
            params![id, item],
        )
        .map_err(|e| e.to_string())?;
    }
    s.mark_dirty();
    s.save()?;
    Ok(Saved { id, name: new_name })
}

/// For the protocol: a reader over a result.
pub fn reader(png: Arc<Zeroizing<Vec<u8>>>) -> (Cursor<SharedBytes>, u64) {
    let len = png.len() as u64;
    (Cursor::new(SharedBytes(png)), len)
}

pub struct SharedBytes(Arc<Zeroizing<Vec<u8>>>);

impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

// ---- commands -------------------------------------------------------------------------------

/// Whether the upscaler pack is there, and graphics card or processor.
#[tauri::command]
pub async fn upscale_info() -> Result<UpscalerInfo, String> {
    tauri::async_runtime::spawn_blocking(info).await.map_err(|e| e.to_string())
}

/// Split the body the window sends: 4 bytes (little-endian) of JSON length,
/// the request as JSON, then the picture as RGBA.
fn split_body(body: &[u8]) -> Result<(Request, &[u8]), String> {
    let bad = || "The picture didn't arrive whole.".to_string();
    let n = u32::from_le_bytes(body.get(..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?) as usize;
    let json = body.get(4..4 + n).ok_or_else(bad)?;
    let req: Request = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    Ok((req, &body[4 + n..]))
}

/// Start upscaling (stops one that is still running). Returns the job
/// number; "upscale-progress" events follow, then "upscale-done".
#[tauri::command]
pub fn upscale_start(app: AppHandle, state: State<'_, crate::Shared>, request: tauri::ipc::Request<'_>) -> Result<u64, String> {
    let s = crate::sess(&state)?;
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The picture didn't arrive.".into());
    };
    let (req, rgba) = split_body(body)?;
    let rgba = Zeroizing::new(rgba.to_vec());
    let (job, flag) = new_job();
    std::thread::spawn(move || {
        let mut last = Instant::now() - Duration::from_secs(1);
        let done = run(&s, job, &req, &rgba, &flag, &mut |p| {
            if last.elapsed() > Duration::from_millis(120) || p.fraction >= 1.0 {
                last = Instant::now();
                let _ = app.emit("upscale-progress", p);
            }
        });
        drop(rgba);
        let _ = app.emit("upscale-done", done);
    });
    Ok(job)
}

#[tauri::command]
pub fn upscale_cancel() {
    cancel();
}

/// Save an upscaled picture as a new item next to the original.
#[tauri::command]
pub async fn upscale_save(state: State<'_, crate::Shared>, token: u64) -> Result<Saved, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || save(&s, token)).await.map_err(|e| e.to_string())?
}

/// The viewer closed: forget the results and free the models' memory.
#[tauri::command]
pub async fn upscale_forget() -> Result<(), String> {
    cancel();
    forget_all();
    tauri::async_runtime::spawn_blocking(unload).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_split() {
        let json = br#"{"itemId":1,"width":1,"height":1,"model":"realesrgan"}"#;
        let mut body = (json.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(json);
        body.extend_from_slice(&[1, 2, 3, 255]);
        let (r, px) = split_body(&body).unwrap();
        assert_eq!((r.item_id, px), (1, &[1u8, 2, 3, 255][..]));
        assert!(split_body(&body[..10]).is_err());
        assert!(split_body(&[]).is_err());
    }

    #[test]
    fn names() {
        let none = |_: &str| false;
        assert_eq!(upscaled_name("Beach.jpg", "jpg", &none), "Beach (upscaled).jpg");
        assert_eq!(upscaled_name(".jpg", "png", &none), ".jpg (upscaled).png");
        let first = |n: &str| n == "a (upscaled).png";
        assert_eq!(upscaled_name("a.webp", "png", &first), "a (upscaled 2).png");
    }

    #[test]
    fn formats() {
        assert!(save_as_jpeg("jpg", false));
        assert!(save_as_jpeg("webp", false));
        assert!(!save_as_jpeg("webp", true));
        assert!(!save_as_jpeg("png", false));
        assert!(!save_as_jpeg("bmp", false));
    }

    #[test]
    fn encoders_make_real_files() {
        let (w, h) = (20, 10);
        let px: Vec<u8> = (0..w * h * 3).map(|i| (i % 251) as u8).collect();
        let j = encode_jpeg(&px, w, h).unwrap();
        assert_eq!(&j[..2], &[0xFF, 0xD8]);
        let p = encode_png(&px, w, h, false, png::Compression::Fast).unwrap();
        let dec = png::Decoder::new(std::io::Cursor::new(&p[..]));
        let mut r = dec.read_info().unwrap();
        let mut buf = vec![0; r.output_buffer_size().unwrap()];
        r.next_frame(&mut buf).unwrap();
        assert_eq!(&buf[..px.len()], &px[..]);
    }

    #[test]
    fn requests_parse() {
        let r: Request = serde_json::from_str(
            r#"{"itemId":3,"width":10,"height":5,"model":"gfpgan","faces":[[[1,2],[3,4],[5,6],[7,8],[9,10]]]}"#,
        )
        .unwrap();
        assert_eq!(r.model, Model::Gfpgan);
        assert_eq!(r.faces[0][4], [9.0, 10.0]);
        let r: Request = serde_json::from_str(r#"{"itemId":3,"width":10,"height":5,"model":"realesrgan"}"#).unwrap();
        assert!(r.faces.is_empty());
    }

    #[test]
    fn a_new_job_stops_the_old_one() {
        let (a, fa) = new_job();
        let (b, fb) = new_job();
        assert!(b > a);
        assert!(fa.load(Ordering::SeqCst) && !fb.load(Ordering::SeqCst));
        cancel();
        assert!(fb.load(Ordering::SeqCst));
        end_job(b);
        assert!(CURRENT.lock().unwrap().is_none());
    }

    #[test]
    fn missing_pack_is_reported_not_fatal() {
        let t = tempfile::tempdir().unwrap();
        assert!(!info_ok(t.path()));
        std::fs::write(t.path().join(ESRGAN_FILE), b"x").unwrap();
        assert!(!info_ok(t.path()));
    }

    /// The real thing, on the processor, when a pack is around:
    /// MV_UPSCALER=<folder> MV_UPSCALE_TEST=<picture.rgba:w:h:faces.json> cargo test real_upscale -- --ignored
    #[test]
    #[ignore]
    fn real_upscale() {
        let spec = std::env::var("MV_UPSCALE_TEST").expect("MV_UPSCALE_TEST");
        let parts: Vec<&str> = spec.split(':').collect();
        let rgba = std::fs::read(parts[0]).unwrap();
        let (w, h): (usize, usize) = (parts[1].parse().unwrap(), parts[2].parse().unwrap());
        let faces: Vec<[[f32; 2]; 5]> = parts.get(3).map(|p| serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()).unwrap_or_default();
        let dir = pack_dir().unwrap();
        for model in [Model::Realesrgan, Model::Gfpgan] {
            let t = tempfile::tempdir().unwrap();
            let s = crate::session::create(t.path().to_str().unwrap(), "v", "correct horse battery", vault_core::KdfParams::TEST_ONLY).unwrap().0;
            let item = import::add_bytes(&s, None, "face.png", &encode_png(&rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect::<Vec<u8>>(), w, h, false, png::Compression::Fast).unwrap()).unwrap();
            let req = Request { item_id: item, width: w, height: h, model, faces: faces.clone() };
            let start = std::time::Instant::now();
            let done = run(&s, 1, &req, &rgba, &AtomicBool::new(false), &mut |p| eprintln!("{:?} {:.2}", p.stage, p.fraction));
            eprintln!("{model:?}: {:?} in {:?}", done, start.elapsed());
            assert!(done.error.is_none(), "{:?}", done.error);
            let png = shown(done.token.unwrap()).unwrap();
            let out = std::env::temp_dir().join(format!("mv-upscaled-{model:?}.png"));
            std::fs::write(&out, &png[..]).unwrap();
            eprintln!("wrote {} (test output only)", out.display());
            let saved = save(&s, done.token.unwrap()).unwrap();
            assert_eq!(saved.name, "face (upscaled).png");
        }
        assert!(dir.is_dir());
    }
}
