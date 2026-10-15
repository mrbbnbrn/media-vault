//! Native face recognition: InsightFace buffalo_l (the SCRFD-10G face finder
//! and the ArcFace R50 fingerprint model), run by ONNX Runtime on the
//! graphics card (DirectML) or the processor, exactly like the upscaler.
//!
//! Pictures are decoded here by the analysis pass (analyse.rs); video
//! frames (and pictures only the window can read) are decoded by the window
//! in memory and their pixels sent here. Faces are found, lined up and turned
//! into 512-number fingerprints. Nothing is written anywhere.
//!
//! The models are an optional download: `tools/faces` next to the app
//! (det_10g.onnx, w600k_r50.onnx, and ONNX Runtime unless another pack
//! already has it), or the folder named by MV_FACES while developing.
//! Without it faces aren't scanned at all (People says where to get it).
//! The buffalo_l weights are for non-commercial research use: personal use.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::faceid_math::{self as fm, Detection};
use crate::upscale;
use crate::upscale_img;

pub const DET_FILE: &str = "det_10g.onnx";
pub const REC_FILE: &str = "w600k_r50.onnx";
/// `faces.model` / `media.faces_model` for faces made here.
pub const MODEL_ID: i64 = 1;
/// Faces narrower than this (pixels of the picture sent) give unreliable fingerprints.
pub const MIN_FACE_PX: f32 = 20.0;
/// Most faces kept in one picture.
const MAX_FACES: usize = 60;
/// Models are freed after this long without use.
const IDLE_UNLOAD: Duration = Duration::from_secs(120);

/// The faces pack: MV_FACES, or `tools/faces` next to the app.
pub fn pack_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("MV_FACES") {
        return Some(PathBuf::from(d));
    }
    Some(std::env::current_exe().ok()?.parent()?.join("tools").join("faces"))
}

/// Where ONNX Runtime comes from: the faces pack itself, else another pack that has it.
fn runtime_dir(pack: &Path) -> Option<PathBuf> {
    if upscale::runtime_in(pack).is_some() {
        return Some(pack.to_path_buf());
    }
    crate::smartnative::runtime_dir()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// The pack is there and complete.
    pub available: bool,
    /// Why not, in one short sentence.
    pub problem: Option<String>,
    /// Where the pack is looked for.
    pub folder: Option<String>,
    /// "gpu" or "cpu" (a guess until a model has run).
    pub device: Option<String>,
    pub device_known: bool,
    /// The runtime is shared with the upscaler pack.
    pub shared_runtime: bool,
}

fn friendly(e: &str) -> String {
    e.replace("The upscaler", "Face recognition").replace("the upscaler", "face recognition")
}

pub fn info() -> EngineInfo {
    let dir = pack_dir();
    let folder = dir.as_ref().map(|d| d.display().to_string());
    let missing = |p: &str| EngineInfo { available: false, problem: Some(p.into()), folder: folder.clone(), device: None, device_known: false, shared_runtime: false };
    let Some(dir) = dir.filter(|d| d.is_dir()) else {
        return missing("The face recognition pack isn't installed.");
    };
    if !dir.join(DET_FILE).is_file() || !dir.join(REC_FILE).is_file() {
        return missing("The face recognition pack is incomplete (a model is missing).");
    }
    let Some(rt) = runtime_dir(&dir) else {
        return missing("The face recognition pack is incomplete (onnxruntime is missing).");
    };
    if let Some(e) = BROKEN.lock().unwrap().clone() {
        return missing(&e);
    }
    let known = *LAST_DEVICE.lock().unwrap();
    let guess = if cfg!(windows) && rt.join("DirectML.dll").is_file() { "gpu" } else { "cpu" };
    EngineInfo {
        available: true,
        problem: None,
        folder,
        device: Some(known.map(|g| if g { "gpu" } else { "cpu" }).unwrap_or(guess).into()),
        device_known: known.is_some(),
        shared_runtime: rt != dir,
    }
}

/// The new models can be used (the pack is there and hasn't failed).
#[cfg(test)]
pub fn available() -> bool {
    info().available
}

// ---- the models ---------------------------------------------------------------------------

struct Loaded {
    det: ort::session::Session,
    rec: ort::session::Session,
    gpu: bool,
}

static MODELS: Mutex<Option<Loaded>> = Mutex::new(None);
static LAST_USE: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_DEVICE: Mutex<Option<bool>> = Mutex::new(None);
/// The runtime or the models couldn't start at all (shown in Settings;
/// faces aren't scanned until the app restarts).
static BROKEN: Mutex<Option<String>> = Mutex::new(None);

fn load(dir: &Path, gpu: bool) -> Result<Loaded, String> {
    let rt = runtime_dir(dir).ok_or("The face recognition pack is incomplete (onnxruntime is missing).")?;
    let env = upscale::start_runtime(&rt).map_err(|e| friendly(&e))?;
    let det = upscale::open_session(env, &dir.join(DET_FILE), gpu).map_err(|e| friendly(&e))?;
    let rec = upscale::open_session(env, &dir.join(REC_FILE), gpu).map_err(|e| friendly(&e))?;
    Ok(Loaded { det, rec, gpu })
}

/// Free the models after a while without use.
fn reaper() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(20));
        let idle = LAST_USE.lock().unwrap().is_none_or(|t| t.elapsed() > IDLE_UNLOAD);
        if idle {
            if let Ok(mut m) = MODELS.try_lock() {
                *m = None;
            } else {
                continue;
            }
            *LAST_USE.lock().unwrap() = None;
            return;
        }
    });
}

/// Free the models now (the vault locked). If a picture is being looked at
/// right now, they are freed a little later (when idle).
pub fn unload() {
    if let Ok(mut m) = MODELS.try_lock() {
        *m = None;
    }
}

/// Run `f` with both models (on the graphics card when possible; a failure
/// there is tried once more on the processor).
fn with_models<T>(f: &mut dyn FnMut(&mut Loaded) -> Result<T, String>) -> Result<T, String> {
    let dir = pack_dir().filter(|d| d.is_dir()).ok_or("The face recognition pack isn't installed.")?;
    let try_gpu = cfg!(windows) && runtime_dir(&dir).is_some_and(|r| r.join("DirectML.dll").is_file());
    let mut guard = MODELS.lock().unwrap();
    {
        let mut last = LAST_USE.lock().unwrap();
        if last.is_none() {
            reaper();
        }
        *last = Some(Instant::now());
    }
    for attempt in 0..2 {
        if guard.is_none() {
            let first = if attempt == 0 { try_gpu } else { false };
            match load(&dir, first) {
                Ok(l) => *guard = Some(l),
                Err(_) if first => match load(&dir, false) {
                    Ok(l) => *guard = Some(l),
                    Err(e) => {
                        *BROKEN.lock().unwrap() = Some(e.clone());
                        return Err(e);
                    }
                },
                Err(e) => {
                    *BROKEN.lock().unwrap() = Some(e.clone());
                    return Err(e);
                }
            }
        }
        let loaded = guard.as_mut().expect("loaded above");
        let gpu = loaded.gpu;
        match f(loaded) {
            Ok(v) => {
                *LAST_DEVICE.lock().unwrap() = Some(gpu);
                return Ok(v);
            }
            Err(_) if gpu && attempt == 0 => {
                *guard = None; // next round: the processor
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err("Face recognition couldn't run.".into())
}

fn run_det(s: &mut ort::session::Session, input: Vec<f32>, plan: &fm::DetPlan) -> Result<Vec<Detection>, String> {
    let t = ort::value::Tensor::from_array(([1usize, 3, plan.in_h, plan.in_w], input)).map_err(|e| format!("The face finder couldn't run ({e})."))?;
    let out = s.run(ort::inputs![t]).map_err(|e| format!("The face finder couldn't run ({e})."))?;
    if out.len() < 9 {
        return Err("The face finder gave back something unexpected.".into());
    }
    let mut all = Vec::new();
    for (i, &stride) in fm::STRIDES.iter().enumerate() {
        let get = |k: usize| -> Result<&[f32], String> {
            out[k].try_extract_tensor::<f32>().map(|(_, v)| v).map_err(|e| format!("The face finder gave back something unexpected ({e})."))
        };
        all.extend(fm::decode(get(i)?, get(i + 3)?, get(i + 6)?, plan.in_w, plan.in_h, stride, fm::DET_THRESH)?);
    }
    Ok(fm::nms(all, fm::NMS_IOU))
}

fn run_rec(s: &mut ort::session::Session, crops: &[f32], n: usize) -> Result<Vec<Vec<f32>>, String> {
    let t = ort::value::Tensor::from_array(([n, 3, fm::REC, fm::REC], crops.to_vec())).map_err(|e| format!("The face model couldn't run ({e})."))?;
    let out = s.run(ort::inputs![t]).map_err(|e| format!("The face model couldn't run ({e})."))?;
    let (_, v) = out[0].try_extract_tensor::<f32>().map_err(|e| format!("The face model gave back something unexpected ({e})."))?;
    if v.len() != n * fm::DIM {
        return Err("The face model gave back something unexpected.".into());
    }
    Ok(v.chunks_exact(fm::DIM)
        .map(|c| {
            let mut e = c.to_vec();
            fm::normalize(&mut e);
            e
        })
        .collect())
}

/// One face found in a picture.
#[derive(Debug, Clone)]
pub struct Found {
    /// x1, y1, x2, y2 in picture pixels.
    pub bbox: [f32; 4],
    pub score: f32,
    /// 512 numbers, unit length.
    pub embedding: Vec<f32>,
}

/// Find the faces in an RGBA picture and fingerprint them.
pub fn analyse(rgba: &[u8], w: usize, h: usize) -> Result<Vec<Found>, String> {
    if w.checked_mul(h).and_then(|p| p.checked_mul(4)) != Some(rgba.len()) {
        return Err("The picture didn't arrive whole.".into());
    }
    let plan = fm::det_plan(w, h, fm::DET_SIZE).ok_or("This picture is empty.")?;
    // The finder's input: the picture scaled (smoothly) to fit 640 × 640.
    let input = {
        let rgb = Zeroizing::new(rgba.chunks_exact(4).flat_map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect::<Vec<f32>>());
        let small = Zeroizing::new(upscale_img::resize(&rgb, 3, w, h, plan.w, plan.h));
        fm::det_input(&small, &plan)
    };
    with_models(&mut |m| {
        let mut dets: Vec<Detection> = run_det(&mut m.det, input.clone(), &plan)?
            .into_iter()
            .map(|d| d.unscaled(plan.scale))
            .filter(|d| d.bbox[2] - d.bbox[0] >= MIN_FACE_PX)
            .collect();
        dets.truncate(MAX_FACES);
        let mut crops = Zeroizing::new(vec![0.0f32; dets.len() * 3 * fm::REC * fm::REC]);
        let mut kept = Vec::new();
        for d in &dets {
            let Some(t) = fm::arcface_transform(&d.kps) else { continue };
            let k = kept.len();
            fm::warp_arcface(rgba, w, h, &t, &mut crops[k * 3 * fm::REC * fm::REC..(k + 1) * 3 * fm::REC * fm::REC]);
            kept.push(*d);
        }
        let mut out = Vec::new();
        const BATCH: usize = 16;
        let per = 3 * fm::REC * fm::REC;
        for (ci, chunk) in kept.chunks(BATCH).enumerate() {
            let from = ci * BATCH * per;
            let embs = run_rec(&mut m.rec, &crops[from..from + chunk.len() * per], chunk.len())?;
            for (d, e) in chunk.iter().zip(embs) {
                out.push(Found { bbox: d.bbox, score: d.score, embedding: e });
            }
        }
        Ok(out)
    })
}

/// The upscaler (GFPGAN): the five face points (eyes, nose tip, mouth
/// corners) of every face in an RGBA picture, in its pixels.
pub fn points(rgba: &[u8], w: usize, h: usize) -> Result<Vec<[[f32; 2]; 5]>, String> {
    if w.checked_mul(h).and_then(|p| p.checked_mul(4)) != Some(rgba.len()) {
        return Err("The picture didn't arrive whole.".into());
    }
    let plan = fm::det_plan(w, h, fm::DET_SIZE).ok_or("This picture is empty.")?;
    let input = {
        let rgb = Zeroizing::new(rgba.chunks_exact(4).flat_map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect::<Vec<f32>>());
        let small = Zeroizing::new(upscale_img::resize(&rgb, 3, w, h, plan.w, plan.h));
        fm::det_input(&small, &plan)
    };
    with_models(&mut |m| {
        let mut dets: Vec<Detection> = run_det(&mut m.det, input.clone(), &plan)?.into_iter().map(|d| d.unscaled(plan.scale)).collect();
        dets.truncate(MAX_FACES);
        Ok(dets.into_iter().map(|d| d.kps).collect())
    })
}

// ---- command ----------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectRequest {
    pub width: usize,
    pub height: usize,
    #[serde(default)]
    pub frame_ms: i64,
}

/// Body: 4 bytes (little-endian) of JSON length, the request, then RGBA.
pub fn split_body(body: &[u8]) -> Result<(DetectRequest, &[u8]), String> {
    let bad = || "The picture didn't arrive whole.".to_string();
    let n = u32::from_le_bytes(body.get(..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?) as usize;
    let json = body.get(4..4 + n).ok_or_else(bad)?;
    let req: DetectRequest = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    Ok((req, &body[4 + n..]))
}

/// Faces in one picture or video frame, as the library stores them.
pub fn detect_faces(req: &DetectRequest, rgba: &[u8]) -> Result<Vec<crate::faces::FaceIn>, String> {
    faces_in(rgba, req.width, req.height, req.frame_ms)
}

/// Faces in an RGBA picture, as the library stores them (parts of the picture).
pub fn faces_in(rgba: &[u8], width: usize, height: usize, frame_ms: i64) -> Result<Vec<crate::faces::FaceIn>, String> {
    let (w, h) = (width as f32, height as f32);
    Ok(analyse(rgba, width, height)?
        .into_iter()
        .map(|f| {
            let x1 = f.bbox[0].clamp(0.0, w);
            let y1 = f.bbox[1].clamp(0.0, h);
            let x2 = f.bbox[2].clamp(0.0, w);
            let y2 = f.bbox[3].clamp(0.0, h);
            crate::faces::FaceIn {
                frame_ms,
                x: x1 / w,
                y: y1 / h,
                w: (x2 - x1) / w,
                h: (y2 - y1) / h,
                score: f.score,
                descriptor: f.embedding,
            }
        })
        .collect())
}

/// Find and fingerprint the faces in the picture the window sends (only
/// while a vault is open).
#[tauri::command]
pub async fn faces_detect(state: State<'_, crate::Shared>, request: tauri::ipc::Request<'_>) -> Result<Vec<crate::faces::FaceIn>, String> {
    crate::sess(&state)?;
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The picture didn't arrive.".into());
    };
    let (req, rgba) = split_body(body)?;
    let rgba = Zeroizing::new(rgba.to_vec());
    tauri::async_runtime::spawn_blocking(move || detect_faces(&req, &rgba)).await.map_err(|e| e.to_string())?
}

/// The face points of the picture the upscaler is about to rebuild faces in
/// (only while a vault is open; needs the faces pack).
#[tauri::command]
pub async fn faces_points(state: State<'_, crate::Shared>, request: tauri::ipc::Request<'_>) -> Result<Vec<[[f32; 2]; 5]>, String> {
    crate::sess(&state)?;
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The picture didn't arrive.".into());
    };
    let (req, rgba) = split_body(body)?;
    let rgba = Zeroizing::new(rgba.to_vec());
    tauri::async_runtime::spawn_blocking(move || points(&rgba, req.width, req.height)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_split() {
        let json = br#"{"width":2,"height":1,"frameMs":500}"#;
        let mut body = (json.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(json);
        body.extend_from_slice(&[1, 2, 3, 255, 4, 5, 6, 255]);
        let (r, px) = split_body(&body).unwrap();
        assert_eq!((r.width, r.height, r.frame_ms, px.len()), (2, 1, 500, 8));
        assert!(split_body(&body[..6]).is_err());
    }

    #[test]
    fn broken_pictures_are_refused_before_any_model() {
        assert!(analyse(&[0; 7], 1, 1).is_err());
        assert!(analyse(&[], 0, 0).is_err());
    }

    /// The real models on the processor, compared with InsightFace's own
    /// Python pipeline. Needs the models and ONNX Runtime:
    /// MV_FACES=<folder with det_10g.onnx, w600k_r50.onnx, libonnxruntime.so.*>
    /// MV_FACES_PHOTOS=<folder of .jpg/.png> [MV_FACES_REF=<ref.json>]
    /// cargo test real_faces -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_faces() {
        let dir = std::env::var("MV_FACES_PHOTOS").expect("MV_FACES_PHOTOS");
        assert!(info().available, "{:?}", info().problem);
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        files.sort();
        let mut all: Vec<(String, Found)> = Vec::new();
        let start = Instant::now();
        for p in &files {
            let Ok(img) = image::open(p) else { continue };
            let img = img.to_rgba8();
            let (w, h) = (img.width() as usize, img.height() as usize);
            let t = Instant::now();
            let found = analyse(img.as_raw(), w, h).unwrap();
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            eprintln!("{name}: {w}×{h}, {} faces in {:?}", found.len(), t.elapsed());
            for f in found {
                all.push((name.clone(), f));
            }
        }
        eprintln!("total {:?}, device {:?}", start.elapsed(), info().device);
        // Against the reference (same photos, InsightFace's Python code).
        if let Ok(r) = std::env::var("MV_FACES_REF") {
            #[derive(serde::Deserialize)]
            struct RefFace {
                photo: String,
                #[serde(rename = "box")]
                bbox: Vec<f32>,
                emb: Vec<f32>,
            }
            let refs: Vec<RefFace> = serde_json::from_slice(&std::fs::read(r).unwrap()).unwrap();
            let mut worst = 1.0f32;
            for rf in &refs {
                let rb = [rf.bbox[0], rf.bbox[1], rf.bbox[2], rf.bbox[3]];
                let best = all.iter().filter(|(n, _)| *n == rf.photo).max_by(|a, b| fm::iou(&a.1.bbox, &rb).total_cmp(&fm::iou(&b.1.bbox, &rb)));
                let Some((_, f)) = best else { panic!("{} has no faces here", rf.photo) };
                let ov = fm::iou(&f.bbox, &rb);
                let sim = fm::dot(&f.embedding, &rf.emb);
                eprintln!("{:32} box overlap {ov:.2}  same-face similarity {sim:.3}", rf.photo);
                worst = worst.min(sim);
            }
            eprintln!("faces in reference: {}, here: {}, worst similarity to reference {worst:.3}", refs.len(), all.len());
            assert!(worst > 0.9, "fingerprints differ from InsightFace's own");
        }
        let names: Vec<String> = all.iter().enumerate().map(|(i, (n, _))| format!("{n}#{i}")).collect();
        for (i, (_, a)) in all.iter().enumerate() {
            let mut sims: Vec<(f32, usize)> = all.iter().enumerate().filter(|(j, _)| *j != i).map(|(j, (_, b))| (fm::dot(&a.embedding, &b.embedding), j)).collect();
            sims.sort_by(|x, y| y.0.total_cmp(&x.0));
            eprintln!("{:36} {}", names[i], sims.iter().take(3).map(|(s, j)| format!("{}={s:.2}", names[*j])).collect::<Vec<_>>().join("  "));
        }
    }
}
