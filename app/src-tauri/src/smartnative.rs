//! Smart search, the picture side, run natively: the CLIP vision model
//! (models/clip-vision.onnx, the same file the window uses) by ONNX Runtime
//! on the graphics card (DirectML) or on the processor, the model kept
//! loaded between pictures. The input is prepared exactly like the window does it
//! (picture.rs `clip_input`), so vectors stored before stay valid.
//!
//! ONNX Runtime comes from whichever pack has it: `tools/onnxruntime` (the
//! models download), `tools/faces` or `tools/upscaler` (or MV_ORT_DIR while
//! developing). Without it the window analyses pictures as before (slowly,
//! in its own engine). The words side of smart search stays in the window.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::{faceid, protocol, upscale};

pub const VISION_FILE: &str = "clip-vision.onnx";
pub const DIM: usize = 512;
const SIDE: usize = crate::picture::CLIP_SIZE;
/// The model is freed after this long without use.
const IDLE_UNLOAD: Duration = Duration::from_secs(120);
/// Graphics card results must be this close to the processor's (checked once).
const GPU_AGREES: f32 = 0.995;

/// Folders that may hold ONNX Runtime, in the order they are tried.
pub fn runtime_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(d) = std::env::var_os("MV_ORT_DIR") {
        out.push(PathBuf::from(d));
    }
    if let Some(exe) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        out.push(exe.join("tools").join("onnxruntime"));
    }
    out.extend(faceid::pack_dir());
    out.extend(upscale::pack_dir());
    out
}

/// The first folder with ONNX Runtime in it.
pub fn runtime_dir() -> Option<PathBuf> {
    runtime_candidates().into_iter().find(|d| upscale::runtime_in(d).is_some())
}

fn model_path() -> Option<PathBuf> {
    protocol::models_dir().map(|d| d.join(VISION_FILE)).filter(|p| p.is_file())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartEngine {
    /// The model files are there at all (else smart search is off).
    pub models: bool,
    /// Pictures are analysed natively (else in the window, slowly).
    pub native: bool,
    /// "gpu" or "cpu" when native (a guess until it has run).
    pub device: Option<String>,
    pub device_known: bool,
    /// Why not native, in one short sentence.
    pub problem: Option<String>,
}

pub fn info() -> SmartEngine {
    let models = model_path().is_some();
    let no = |p: &str| SmartEngine { models, native: false, device: None, device_known: false, problem: Some(p.into()) };
    if !models {
        return no("The smart-search models aren't installed.");
    }
    let Some(rt) = runtime_dir() else {
        return no("ONNX Runtime isn't there (it comes with the newer models download).");
    };
    if let Some(e) = BROKEN.lock().unwrap().clone() {
        return no(&e);
    }
    let known = *LAST_DEVICE.lock().unwrap();
    let guess = !*NO_GPU.lock().unwrap() && cfg!(windows) && rt.join("DirectML.dll").is_file();
    SmartEngine {
        models,
        native: true,
        device: Some(if known.unwrap_or(guess) { "gpu" } else { "cpu" }.into()),
        device_known: known.is_some(),
        problem: None,
    }
}

/// Pictures can be analysed natively right now.
pub fn usable() -> bool {
    model_path().is_some() && runtime_dir().is_some() && BROKEN.lock().unwrap().is_none()
}

// ---- the model ------------------------------------------------------------------------

struct Loaded {
    session: ort::session::Session,
    gpu: bool,
    /// The graphics card's answers were compared with the processor's.
    checked: bool,
}

static MODEL: Mutex<Option<Loaded>> = Mutex::new(None);
static LAST_USE: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_DEVICE: Mutex<Option<bool>> = Mutex::new(None);
/// The graphics card failed or disagreed: the processor from now on.
static NO_GPU: Mutex<bool> = Mutex::new(false);
/// The runtime or the model couldn't start (the window analyses instead).
static BROKEN: Mutex<Option<String>> = Mutex::new(None);

fn err(e: &dyn std::fmt::Display) -> String {
    format!("Smart search couldn't start its model ({e}).")
}

fn open(gpu: bool) -> Result<ort::session::Session, String> {
    let rt = runtime_dir().ok_or("ONNX Runtime isn't there.")?;
    let path = model_path().ok_or("The smart-search models aren't installed.")?;
    let env = upscale::start_runtime(&rt).map_err(|e| e.replace("The upscaler", "Smart search"))?;
    let mut b = ort::session::Session::builder(env).map_err(|e| err(&e))?;
    if gpu {
        b = b.with_memory_pattern(false).map_err(|e| err(&e))?;
        b = b.with_parallel_execution(false).map_err(|e| err(&e))?;
        crate::gpuroom::room_for_other(1 << 30); // room beside the 3D models first
        b = b.with_execution_providers([ort::ep::DirectML::default().build().error_on_failure()]).map_err(|e| err(&e))?;
    } else {
        // Half the cores: its own threads run at normal priority (they don't take the
        // analysis pass's low one), so the rest stays free for the window and videos.
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
        b = b.with_intra_threads((cores / 2).max(1)).map_err(|e| err(&e))?;
        b = b.with_execution_providers([ort::ep::CPU::default().build()]).map_err(|e| err(&e))?;
    }
    b.commit_from_file(&path).map_err(|e| err(&e))
}

fn run(s: &mut ort::session::Session, input: &[f32], n: usize) -> Result<Vec<Vec<f32>>, String> {
    let bad = |e: &dyn std::fmt::Display| format!("Smart search couldn't analyse ({e}).");
    let t = ort::value::Tensor::from_array(([n, 3, SIDE, SIDE], input.to_vec())).map_err(|e| bad(&e))?;
    let out = s.run(ort::inputs![t]).map_err(|e| bad(&e))?;
    // The image embeddings ("image_embeds"), else the first output.
    let v = match out.get("image_embeds") {
        Some(v) => v,
        None => &out[0],
    };
    let (shape, data) = v.try_extract_tensor::<f32>().map_err(|e| bad(&e))?;
    if data.len() != n * DIM || shape.last().copied() != Some(DIM as i64) {
        return Err("Smart search's model gave back something unexpected.".into());
    }
    Ok(data
        .chunks_exact(DIM)
        .map(|c| {
            let norm = c.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
            c.iter().map(|x| x / norm).collect()
        })
        .collect())
}

fn reaper() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(20));
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

/// Free the model now (the vault locked); if busy, it goes when idle.
pub fn unload() {
    if let Ok(mut m) = MODEL.try_lock() {
        *m = None;
    }
}

fn cos(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Meaning vectors (unit length) of `n` prepared pictures (picture.rs
/// `clip_input`, one after another). On the graphics card when possible:
/// its first answers are checked against the processor's, and any trouble
/// there moves everything to the processor.
pub fn embed(input: &[f32], n: usize) -> Result<Vec<Vec<f32>>, String> {
    if input.len() != n * 3 * SIDE * SIDE || n == 0 {
        return Err("Smart search got a picture that wasn't whole.".into());
    }
    let mut guard = MODEL.lock().unwrap();
    {
        let mut last = LAST_USE.lock().unwrap();
        if last.is_none() {
            reaper();
        }
        *last = Some(Instant::now());
    }
    let can_gpu = || cfg!(windows) && !*NO_GPU.lock().unwrap() && runtime_dir().is_some_and(|d| d.join("DirectML.dll").is_file());
    for _ in 0..3 {
        if guard.is_none() {
            let gpu = can_gpu();
            match open(gpu) {
                Ok(s) => *guard = Some(Loaded { session: s, gpu, checked: !gpu }),
                Err(_) if gpu => {
                    *NO_GPU.lock().unwrap() = true;
                    continue;
                }
                Err(e) => {
                    *BROKEN.lock().unwrap() = Some(e.clone());
                    return Err(e);
                }
            }
        }
        let m = guard.as_mut().expect("loaded above");
        let mut out = Vec::with_capacity(n);
        let per = 3 * SIDE * SIDE;
        let mut failed = None;
        // One picture per run: the model is 8-bit with its scale worked out
        // over the whole input, so pictures run together change each
        // other's vectors a little (cosine ≈ 0.987). One at a time they match
        // what the window stored.
        for chunk in input.chunks(per) {
            match run(&mut m.session, chunk, 1) {
                Ok(v) => out.extend(v),
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        match failed {
            None if m.gpu && !m.checked => {
                // Once: the graphics card must agree with the processor.
                let cpu = open(false).and_then(|mut s| run(&mut s, &input[..per], 1));
                match cpu {
                    Ok(c) if cos(&c[0], &out[0]) >= GPU_AGREES => {
                        m.checked = true;
                        *LAST_DEVICE.lock().unwrap() = Some(true);
                        return Ok(out);
                    }
                    Ok(c) => {
                        eprintln!("smart search: graphics card disagrees with the processor ({:.4}); using the processor", cos(&c[0], &out[0]));
                        *NO_GPU.lock().unwrap() = true;
                        *guard = None;
                        continue;
                    }
                    Err(e) => {
                        *BROKEN.lock().unwrap() = Some(e.clone());
                        return Err(e);
                    }
                }
            }
            None => {
                *LAST_DEVICE.lock().unwrap() = Some(m.gpu);
                return Ok(out);
            }
            Some(_) if m.gpu => {
                *NO_GPU.lock().unwrap() = true;
                *guard = None;
                continue;
            }
            Some(e) => {
                *BROKEN.lock().unwrap() = Some(e.clone());
                *guard = None;
                return Err(e);
            }
        }
    }
    Err("Smart search couldn't analyse.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_broken_input_before_any_model() {
        assert!(embed(&[0.0; 5], 1).is_err());
        assert!(embed(&[], 0).is_err());
    }

    #[test]
    fn looks_for_the_runtime_in_every_pack() {
        let c = runtime_candidates();
        assert!(c.iter().any(|p| p.ends_with("tools/onnxruntime") || p.ends_with("tools\\onnxruntime")) || std::env::var_os("MV_ORT_DIR").is_some());
    }
}
