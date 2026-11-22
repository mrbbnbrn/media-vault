//! Prepared 3D for videos (docs/video-3d-plan.md): a video's frames handed to
//! the window a few at a time, decoded by ffmpeg straight from the vault
//! (videotool.rs: piped, never on disk), each with its exact time. The window
//! works out each frame's 3D data with the same models as for pictures and
//! saves it (derived.rs, kind "track"); GIFs are decoded in the window itself.
//!
//! One decoder per video being prepared, kept here between calls. It stops
//! when the window closes it, when the vault locks, or after two minutes
//! without being asked for frames.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::process::{Child, ChildStdout};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::session::Session;
use crate::videotool;

/// Most bytes handed over in one call.
const MAX_BATCH: usize = 64 << 20;
/// Biggest frame side accepted.
const MAX_SIDE: u32 = 4096;
/// A decoder nobody asked for frames this long is stopped.
const IDLE: Duration = Duration::from_secs(120);

struct Decoder {
    session: Arc<Session>,
    child: Child,
    out: ChildStdout,
    _server: videotool::Server,
    times: Arc<Mutex<VecDeque<f64>>>,
    errors: Arc<Mutex<Vec<String>>>,
    messages_done: Arc<AtomicBool>,
    frame_bytes: usize,
    given: u64,
    finished: bool,
}

impl Drop for Decoder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone)]
struct Entry {
    dec: Arc<Mutex<Decoder>>,
    used: Arc<Mutex<Instant>>,
}

fn decoders() -> &'static Mutex<HashMap<u64, Entry>> {
    static D: OnceLock<Mutex<HashMap<u64, Entry>>> = OnceLock::new();
    D.get_or_init(|| {
        // Every 20 s: stop decoders left alone too long or whose vault was locked.
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(20));
                sweep();
            }
        });
        Mutex::new(HashMap::new())
    })
}

static NEXT: AtomicU64 = AtomicU64::new(1);

/// Stops decoders that were left alone or whose vault is locked.
fn sweep() {
    let gone: Vec<Entry> = {
        let mut map = decoders().lock().unwrap();
        let stale: Vec<u64> = map
            .iter()
            .filter(|(_, e)| {
                let idle = e.used.lock().map(|u| u.elapsed() > IDLE).unwrap_or(true);
                // A decoder busy in a call is locked: it counts as in use.
                let closed = e.dec.try_lock().map(|d| d.session.is_closed()).unwrap_or(false);
                idle || closed
            })
            .map(|(id, _)| *id)
            .collect();
        stale.iter().filter_map(|id| map.remove(id)).collect()
    };
    drop(gone); // (outside the map's lock: stopping ffmpeg can take a moment)
}

/// Stop every decoder (the vault locked).
pub fn stop_all() {
    let gone: Vec<Entry> = decoders().lock().unwrap().drain().map(|(_, e)| e).collect();
    drop(gone);
}

/// The time on one of ffmpeg's showinfo lines ("… n: 3 pts: 3003 pts_time:0.1001 …").
pub(crate) fn pts_time(line: &str) -> Option<f64> {
    let at = line.find("pts_time:")? + "pts_time:".len();
    let v: String = line[at..].trim_start().chars().take_while(|c| !c.is_whitespace()).collect();
    match v.parse::<f64>() {
        Ok(t) if t.is_finite() => Some(t),
        _ => Some(f64::NAN), // NOPTS: the frame is there, its time isn't
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: u64,
    pub width: u32,
    pub height: u32,
}

fn open(s: &Arc<Session>, item: i64, width: u32, height: u32, start: f64) -> Result<Opened, String> {
    if !(2..=MAX_SIDE).contains(&width) || !(2..=MAX_SIDE).contains(&height) || !start.is_finite() || start < 0.0 {
        return Err("That size can't be prepared.".into());
    }
    let tool = videotool::tool_path().ok_or("Preparing 3D for videos needs the video tool (ffmpeg): see Settings → About.")?;
    sweep();
    let (mut child, server) = videotool::spawn_frames(s, &tool, item, width, height, start)?;
    let out = child.stdout.take().ok_or("The video tool gave no output.")?;
    let err = child.stderr.take().ok_or("The video tool gave no messages.")?;
    let times: Arc<Mutex<VecDeque<f64>>> = Default::default();
    let errors: Arc<Mutex<Vec<String>>> = Default::default();
    let done = Arc::new(AtomicBool::new(false));
    let (t2, e2, d2) = (times.clone(), errors.clone(), done.clone());
    std::thread::spawn(move || {
        // Read as bytes: a line that isn't UTF-8 (a file's own tags) must not stop the reading,
        // or ffmpeg would wait forever on a full pipe.
        let mut r = BufReader::new(err);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf);
            if line.contains("showinfo") && line.contains(" n:") {
                if let Some(t) = pts_time(&line) {
                    t2.lock().unwrap().push_back(t);
                }
            } else if line.to_ascii_lowercase().contains("error") {
                let mut e = e2.lock().unwrap();
                if e.len() < 20 {
                    // Never show the local server's secret addresses.
                    let clean: Vec<&str> = line.split_whitespace().map(|w| if w.contains("127.0.0.1") { "(the item)" } else { w }).collect();
                    e.push(clean.join(" "));
                }
            }
        }
        d2.store(true, Ordering::SeqCst);
    });
    let dec = Decoder {
        session: s.clone(),
        child,
        out,
        _server: server,
        times,
        errors,
        messages_done: done,
        frame_bytes: width as usize * height as usize * 4,
        given: 0,
        finished: false,
    };
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    decoders().lock().unwrap().insert(id, Entry { dec: Arc::new(Mutex::new(dec)), used: Arc::new(Mutex::new(Instant::now())) });
    Ok(Opened { id, width, height })
}

/// The next frames, as the window reads them: u32 count (LE), u8 1 = no more after these, 3 bytes
/// nothing, then each frame's time in seconds (f64 LE; NaN = unknown), then the frames (RGBA).
pub(crate) fn pack(times: &[f64], frames: &[u8], done: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + times.len() * 8 + frames.len());
    out.extend_from_slice(&(times.len() as u32).to_le_bytes());
    out.extend_from_slice(&[done as u8, 0, 0, 0]);
    for t in times {
        out.extend_from_slice(&t.to_le_bytes());
    }
    out.extend_from_slice(frames);
    out
}

fn read_batch(dec: &Mutex<Decoder>, max: u32) -> Result<Vec<u8>, String> {
    let mut d = dec.lock().unwrap();
    if d.session.is_closed() {
        return Err("The vault is locked.".into());
    }
    if d.finished {
        return Ok(pack(&[], &[], true));
    }
    let fb = d.frame_bytes;
    let n = (max.clamp(1, 64) as usize).min((MAX_BATCH / fb.max(1)).max(1));
    let mut frames: Vec<u8> = Vec::with_capacity(n * fb);
    let mut times: Vec<f64> = Vec::with_capacity(n);
    let mut buf = vec![0u8; fb];
    for _ in 0..n {
        match read_frame(&mut d.out, &mut buf) {
            Ok(true) => {}
            Ok(false) => {
                d.finished = true;
                break;
            }
            Err(e) => return Err(format!("The video couldn't be read ({e}).")),
        }
        frames.extend_from_slice(&buf);
        // Its time (the message about it comes before the frame itself, nearly always at once).
        let waited = Instant::now();
        let t = loop {
            if let Some(t) = d.times.lock().unwrap().pop_front() {
                break t;
            }
            if d.messages_done.load(Ordering::SeqCst) || waited.elapsed() > Duration::from_secs(3) {
                break f64::NAN;
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        times.push(t);
        d.given += 1;
    }
    if d.finished && d.given == 0 {
        // Nothing at all: say why.
        let _ = d.child.wait();
        let why = d.errors.lock().unwrap().last().cloned().map(|l| format!(" ({})", l.chars().take(160).collect::<String>())).unwrap_or_default();
        return Err(format!("The video tool couldn't read this video{why}."));
    }
    Ok(pack(&times, &frames, d.finished))
}

/// One whole frame (false: the video ended; a frame cut short counts as the end).
fn read_frame(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<bool> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) => return Ok(false),
            Ok(n) => got += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

fn entry(id: u64) -> Option<Entry> {
    decoders().lock().unwrap().get(&id).cloned()
}

// ---- commands -------------------------------------------------------------------------------

/// Start decoding a video item's frames at `width` × `height` from `start` seconds on.
#[tauri::command]
pub async fn video3d_open(state: State<'_, crate::Shared>, item: i64, width: u32, height: u32, start: f64) -> Result<Opened, String> {
    let s = crate::sess(&state)?;
    tauri::async_runtime::spawn_blocking(move || open(&s, item, width, height, start)).await.map_err(|x| x.to_string())?
}

/// Up to `max` next frames (see `pack`).
#[tauri::command]
pub async fn video3d_read(state: State<'_, crate::Shared>, id: u64, max: u32) -> Result<tauri::ipc::Response, String> {
    crate::sess(&state)?;
    let Entry { dec, used } = entry(id).ok_or("That video isn't being prepared any more.")?;
    *used.lock().unwrap() = Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || read_batch(&dec, max)).await.map_err(|x| x.to_string())?;
    *used.lock().unwrap() = Instant::now();
    if out.is_err() {
        let gone = decoders().lock().unwrap().remove(&id);
        drop(gone);
    }
    Ok(tauri::ipc::Response::new(out?))
}

/// Done with (or stopped) a video's decoder.
#[tauri::command]
pub async fn video3d_close(id: u64) -> Result<(), String> {
    let gone = decoders().lock().unwrap().remove(&id);
    // Stopping ffmpeg may wait a moment: not on the window's thread.
    tauri::async_runtime::spawn_blocking(move || drop(gone)).await.map_err(|x| x.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn showinfo_times() {
        let l = "[Parsed_showinfo_2 @ 0000020b] n:   3 pts:   3003 pts_time:0.1001  duration:   1001 duration_time:0.03336 fmt:rgba";
        assert_eq!(pts_time(l), Some(0.1001));
        assert_eq!(pts_time("[Parsed_showinfo_2 @ 0] n:   0 pts:      0 pts_time:0       duration:"), Some(0.0));
        assert!(pts_time("n: 1 pts: NOPTS pts_time:NOPTS dur").unwrap().is_nan());
        assert_eq!(pts_time("Stream #0:0: Video: h264"), None);
    }

    #[test]
    fn batches_are_laid_out_for_the_window() {
        let b = pack(&[0.5, 1.0], &[1, 2, 3, 4, 5, 6, 7, 8], true);
        assert_eq!(&b[..4], &2u32.to_le_bytes());
        assert_eq!(b[4], 1);
        assert_eq!(&b[8..16], &0.5f64.to_le_bytes());
        assert_eq!(&b[16..24], &1.0f64.to_le_bytes());
        assert_eq!(&b[24..], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(pack(&[], &[], false), vec![0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn whole_frames_only() {
        let mut buf = [0u8; 4];
        let mut r: &[u8] = &[1, 2, 3, 4, 5, 6];
        assert!(read_frame(&mut r, &mut buf).unwrap());
        assert_eq!(buf, [1, 2, 3, 4]);
        // Two bytes left: a frame cut short is the end.
        assert!(!read_frame(&mut r, &mut buf).unwrap());
    }
}
