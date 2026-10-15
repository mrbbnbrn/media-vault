//! "3D photos": a depth map for a still picture, so the slideshow can move
//! it with gentle 2.5D parallax (the window draws the effect with WebGL).
//!
//! The model is Depth Anything V2 Small (Apache-2.0; the Base and Large
//! models are not), run by ONNX Runtime on the graphics card (DirectML) or
//! the processor, exactly like the upscaler and face recognition.
//!
//! The window decodes the picture in memory, scales it down to the model's
//! size and sends the pixels here; the depth map goes straight back (a few
//! hundred kilobytes) and is kept in the window's memory only. Nothing is
//! written anywhere.
//!
//! The model is an optional download: `tools/depth` next to the app
//! (depth_anything_v2_vits.onnx, and ONNX Runtime unless the upscaler or
//! faces pack already has it), or the folder named by MV_DEPTH while
//! developing. Without it pictures show as usual.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::{faceid, upscale, upscale_img};

pub const MODEL_FILE: &str = "depth_anything_v2_vits.onnx";
/// Used when the model takes any size (the exported one is fixed at 518 × 518).
const DEFAULT_SIDE: usize = 518;
/// The model is freed after this long without use.
const IDLE_UNLOAD: Duration = Duration::from_secs(90);
/// Biggest picture accepted from the window (it sends ~518 px).
const MAX_SIDE: usize = 2048;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// The depth pack: MV_DEPTH, or `tools/depth` next to the app.
pub fn pack_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("MV_DEPTH") {
        return Some(PathBuf::from(d));
    }
    Some(std::env::current_exe().ok()?.parent()?.join("tools").join("depth"))
}

/// Where ONNX Runtime comes from: the depth pack itself, else the upscaler
/// pack, else the faces pack (all three ship the same version).
fn runtime_dir(pack: &Path) -> Option<PathBuf> {
    if upscale::runtime_in(pack).is_some() {
        return Some(pack.to_path_buf());
    }
    [upscale::pack_dir(), faceid::pack_dir()]
        .into_iter()
        .flatten()
        .find(|d| upscale::runtime_in(d).is_some())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthInfo {
    pub available: bool,
    /// Why not, in one short sentence.
    pub problem: Option<String>,
    /// Where the pack is looked for.
    pub folder: Option<String>,
    /// "gpu" or "cpu" (a guess until the model has run).
    pub device: Option<String>,
    pub device_known: bool,
    /// ONNX Runtime comes from the upscaler or faces pack.
    pub shared_runtime: bool,
}

fn friendly(e: &str) -> String {
    e.replace("The upscaler", "3D photos").replace("the upscaler", "3D photos")
}

pub fn info() -> DepthInfo {
    let dir = pack_dir();
    let folder = dir.as_ref().map(|d| d.display().to_string());
    let missing = |p: &str| DepthInfo { available: false, problem: Some(p.into()), folder: folder.clone(), device: None, device_known: false, shared_runtime: false };
    let Some(dir) = dir.filter(|d| d.is_dir()) else {
        return missing("The depth pack isn't installed.");
    };
    if !dir.join(MODEL_FILE).is_file() {
        return missing("The depth pack is incomplete (the model is missing).");
    }
    let Some(rt) = runtime_dir(&dir) else {
        return missing("The depth pack is incomplete (onnxruntime is missing).");
    };
    if let Some(e) = BROKEN.lock().unwrap().clone() {
        return missing(&e);
    }
    let known = *LAST_DEVICE.lock().unwrap();
    let guess = if cfg!(windows) && rt.join("DirectML.dll").is_file() { "gpu" } else { "cpu" };
    DepthInfo {
        available: true,
        problem: None,
        folder,
        device: Some(known.map(|g| if g { "gpu" } else { "cpu" }).unwrap_or(guess).into()),
        device_known: known.is_some(),
        shared_runtime: rt != dir,
    }
}

// ---- the model ----------------------------------------------------------------------------

struct Loaded {
    session: ort::session::Session,
    /// The model's input size (height, width).
    side: (usize, usize),
    gpu: bool,
}

static MODEL: Mutex<Option<Loaded>> = Mutex::new(None);
static LAST_USE: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_DEVICE: Mutex<Option<bool>> = Mutex::new(None);
/// The runtime or the model couldn't start at all (shown in Settings).
static BROKEN: Mutex<Option<String>> = Mutex::new(None);

/// The model's fixed input size, or the default when it takes any size.
fn input_side(session: &ort::session::Session) -> (usize, usize) {
    let dims: Vec<i64> = session
        .inputs()
        .first()
        .and_then(|i| i.dtype().tensor_shape())
        .map(|s| s.iter().copied().collect())
        .unwrap_or_default();
    let pick = |v: Option<&i64>| v.copied().filter(|&d| d > 0).map(|d| d as usize).unwrap_or(DEFAULT_SIDE);
    if dims.len() == 4 { (pick(dims.get(2)), pick(dims.get(3))) } else { (DEFAULT_SIDE, DEFAULT_SIDE) }
}

fn load(dir: &Path, gpu: bool) -> Result<Loaded, String> {
    let rt = runtime_dir(dir).ok_or("The depth pack is incomplete (onnxruntime is missing).")?;
    let env = upscale::start_runtime(&rt).map_err(|e| friendly(&e))?;
    let session = upscale::open_session(env, &dir.join(MODEL_FILE), gpu).map_err(|e| friendly(&e))?;
    let side = input_side(&session);
    Ok(Loaded { session, side, gpu })
}

/// Free the model after a while without use.
fn reaper() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(15));
        let idle = LAST_USE.lock().unwrap().is_none_or(|t| t.elapsed() > IDLE_UNLOAD);
        if idle {
            if let Ok(mut m) = MODEL.try_lock() {
                *m = None;
            } else {
                continue;
            }
            *LAST_USE.lock().unwrap() = None;
            return;
        }
    });
}

/// Free the model now (the vault locked or the viewer closed).
pub fn unload() {
    if let Ok(mut m) = MODEL.try_lock() {
        *m = None;
    }
}

/// Run `f` with the model (on the graphics card when possible; a failure
/// there is tried once more on the processor).
fn with_model<T>(f: &mut dyn FnMut(&mut Loaded) -> Result<T, String>) -> Result<T, String> {
    let dir = pack_dir().filter(|d| d.is_dir()).ok_or("The depth pack isn't installed.")?;
    let try_gpu = cfg!(windows) && runtime_dir(&dir).is_some_and(|r| r.join("DirectML.dll").is_file());
    let mut guard = MODEL.lock().unwrap();
    {
        let mut last = LAST_USE.lock().unwrap();
        if last.is_none() {
            reaper();
        }
        *last = Some(Instant::now());
    }
    for attempt in 0..2 {
        if guard.is_none() {
            let first = attempt == 0 && try_gpu;
            let loaded = match load(&dir, first) {
                Ok(l) => Ok(l),
                Err(_) if first => load(&dir, false),
                Err(e) => Err(e),
            };
            match loaded {
                Ok(l) => *guard = Some(l),
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
    Err("3D photos couldn't run.".into())
}

// ---- the maths (no model needed) --------------------------------------------------------------

/// RGBA (w × h) → the model's input: 1 × 3 × sh × sw, scaled smoothly and
/// normalised like the model was trained (ImageNet mean and spread).
pub fn model_input(rgba: &[u8], w: usize, h: usize, sw: usize, sh: usize) -> Vec<f32> {
    let rgb = Zeroizing::new(rgba.chunks_exact(4).flat_map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0]).collect::<Vec<f32>>());
    let small = Zeroizing::new(upscale_img::resize(&rgb, 3, w, h, sw, sh));
    let n = sw * sh;
    let mut out = vec![0.0f32; 3 * n];
    for i in 0..n {
        for c in 0..3 {
            out[c * n + i] = (small[i * 3 + c] - MEAN[c]) / STD[c];
        }
    }
    out
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
pub fn finish(raw: &[f32], w: usize, h: usize) -> Vec<u8> {
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
    let grow = ((3.0 * scale).round() as usize).max(1);
    let soft = ((4.0 * scale).round() as usize).max(1);
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

/// The depth of an RGBA picture.
pub fn estimate(rgba: &[u8], w: usize, h: usize) -> Result<DepthMap, String> {
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE || w.checked_mul(h).and_then(|p| p.checked_mul(4)) != Some(rgba.len()) {
        return Err("The picture didn't arrive whole.".into());
    }
    with_model(&mut |m| {
        let (sh, sw) = m.side;
        let input = model_input(rgba, w, h, sw, sh);
        let t = ort::value::Tensor::from_array(([1usize, 3, sh, sw], input)).map_err(|e| format!("3D photos couldn't run ({e})."))?;
        let out = m.session.run(ort::inputs![t]).map_err(|e| format!("3D photos couldn't run ({e})."))?;
        let (shape, v) = out[0].try_extract_tensor::<f32>().map_err(|e| format!("3D photos got something unexpected back ({e})."))?;
        let dims: Vec<i64> = shape.iter().copied().collect();
        let (oh, ow) = match dims.as_slice() {
            [.., oh, ow] if *oh > 0 && *ow > 0 => (*oh as usize, *ow as usize),
            _ => return Err("3D photos got something unexpected back.".into()),
        };
        if v.len() != oh * ow {
            return Err("3D photos got something unexpected back.".into());
        }
        Ok(DepthMap { w: ow, h: oh, data: finish(v, ow, oh) })
    })
}

// ---- commands -------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthRequest {
    pub width: usize,
    pub height: usize,
}

/// Body: 4 bytes (little-endian) of JSON length, the request as JSON, then RGBA.
fn split_body(body: &[u8]) -> Result<(DepthRequest, &[u8]), String> {
    let bad = || "The picture didn't arrive whole.".to_string();
    let n = u32::from_le_bytes(body.get(..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?) as usize;
    let json = body.get(4..4 + n).ok_or_else(bad)?;
    let req: DepthRequest = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    Ok((req, &body[4 + n..]))
}

/// Whether the depth pack is there, and graphics card or processor.
#[tauri::command]
pub async fn depth_info() -> Result<DepthInfo, String> {
    tauri::async_runtime::spawn_blocking(info).await.map_err(|e| e.to_string())
}

/// The depth map of the picture the window sends (see `DepthMap::to_bytes`).
#[tauri::command]
pub async fn depth_estimate(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The picture didn't arrive.".into());
    };
    let (req, rgba) = split_body(body)?;
    let rgba = Zeroizing::new(rgba.to_vec());
    let map = tauri::async_runtime::spawn_blocking(move || estimate(&rgba, req.width, req.height)).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(map.to_bytes()))
}

/// The viewer closed: free the model's memory.
#[tauri::command]
pub async fn depth_forget() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(unload).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_split() {
        let json = br#"{"width":2,"height":1}"#;
        let mut body = (json.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(json);
        body.extend_from_slice(&[1, 2, 3, 255, 4, 5, 6, 255]);
        let (r, px) = split_body(&body).unwrap();
        assert_eq!((r.width, r.height, px.len()), (2, 1, 8));
        assert!(split_body(&body[..6]).is_err());
        assert!(split_body(&[]).is_err());
    }

    #[test]
    fn broken_pictures_are_refused_before_any_model() {
        assert!(estimate(&[0; 7], 1, 1).is_err());
        assert!(estimate(&[], 0, 0).is_err());
        assert!(estimate(&vec![0; 4 * 4096], 4096, 1).is_err());
    }

    #[test]
    fn input_is_planar_and_normalised() {
        // A 2 × 1 picture: white, black → 1 × 3 × 1 × 2.
        let x = model_input(&[255, 255, 255, 255, 0, 0, 0, 255], 2, 1, 2, 1);
        assert_eq!(x.len(), 6);
        assert!((x[0] - (1.0 - MEAN[0]) / STD[0]).abs() < 1e-5);
        assert!((x[1] - (0.0 - MEAN[0]) / STD[0]).abs() < 1e-5);
        assert!((x[4] - (1.0 - MEAN[2]) / STD[2]).abs() < 1e-5);
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
    fn maps_go_out_with_their_size() {
        let b = DepthMap { w: 3, h: 2, data: vec![1, 2, 3, 4, 5, 6] }.to_bytes();
        assert_eq!(&b[..8], &[3, 0, 0, 0, 2, 0, 0, 0]);
        assert_eq!(&b[8..], &[1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn missing_pack_is_reported_not_fatal() {
        // A folder without the model.
        let t = tempfile::tempdir().unwrap();
        assert!(!t.path().join(MODEL_FILE).is_file());
        assert!(runtime_dir(t.path()).is_none_or(|d| d != t.path()));
    }

    /// The real thing, when a pack is around (writes the depth maps as PNGs, test output only):
    /// MV_DEPTH=<folder> MV_DEPTH_TEST=<a.jpg,b.png,...> MV_DEPTH_OUT=/tmp/depth-shots cargo test real_depth -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_depth() {
        let list = std::env::var("MV_DEPTH_TEST").expect("MV_DEPTH_TEST");
        let out = PathBuf::from(std::env::var("MV_DEPTH_OUT").unwrap_or_else(|_| std::env::temp_dir().display().to_string()));
        std::fs::create_dir_all(&out).unwrap();
        for p in list.split(',') {
            let img = image::open(p).unwrap().to_rgba8();
            // Like the window: scaled down to about the model's size first.
            let (w0, h0) = img.dimensions();
            let k = (640.0 / w0.max(h0) as f32).min(1.0);
            let img = image::imageops::resize(&img, ((w0 as f32 * k) as u32).max(1), ((h0 as f32 * k) as u32).max(1), image::imageops::FilterType::Triangle);
            let (w, h) = img.dimensions();
            let start = Instant::now();
            let map = estimate(img.as_raw(), w as usize, h as usize).unwrap();
            eprintln!("{p}: {}x{} depth in {:?} ({:?})", map.w, map.h, start.elapsed(), info().device);
            // Back to the picture's shape, for looking at.
            let grey = image::GrayImage::from_raw(map.w as u32, map.h as u32, map.data.clone()).unwrap();
            let grey = image::imageops::resize(&grey, w, h, image::imageops::FilterType::Triangle);
            let name = Path::new(p).file_stem().unwrap().to_string_lossy().to_string();
            grey.save(out.join(format!("{name}-depth.png"))).unwrap();
            assert!(map.data.iter().any(|&v| v > 200) && map.data.iter().any(|&v| v < 60));
        }
    }
}
