//! Listen to the computer's own sound (what plays through the speakers or
//! headphones) and report beats, for beat-synced slideshows.
//!
//! Windows only: WASAPI loopback capture of the default output device (see
//! loopback_win.rs). Samples are analysed in memory as they arrive (see
//! beats.rs) and dropped right away: nothing is recorded or saved.
//!
//! The listening loop itself is plain Rust (beatloop.rs), so everything
//! except the few Windows calls is tested on any machine.
//!
//! Events:
//! * `beat`        `{ t_ms, strength, bpm }` — at most one per 200 ms
//! * `beat-level`  `{ level }` — 0..1, about 10 times a second
//! * `beat-status` `BeatStatus` — whenever the listening state changes
//!
//! Listening stops on `beats_stop`, when the vault locks and when the app
//! exits.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::beatloop::{BeatStatus, Clock, Sink};
use crate::beats::Event;

#[derive(Default)]
pub struct BeatListener {
    running: Mutex<Option<Running>>,
    status: Arc<Mutex<BeatStatus>>,
    /// Bumped on every start, so a thread that is still winding down never
    /// overwrites the status of the one that replaced it.
    generation: Arc<AtomicU64>,
}

struct Running {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl BeatListener {
    fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            r.stop.store(true, Ordering::SeqCst);
            // Not joined: the thread notices within ~10 ms and ends itself.
            drop(r.thread);
        }
    }
}

// ---------------------------------------------------------------------------
// The app side: events to the window

#[derive(Serialize, Clone)]
struct BeatPayload {
    t_ms: u64,
    strength: f32,
    bpm: Option<f32>,
}

#[derive(Serialize, Clone)]
struct LevelPayload {
    level: f32,
}

#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows capture thread
struct AppSink<R: Runtime> {
    app: AppHandle<R>,
    shared: Arc<Mutex<BeatStatus>>,
    generation: Arc<AtomicU64>,
    mine: u64,
}

impl<R: Runtime> Sink for AppSink<R> {
    fn events(&mut self, events: &[Event]) {
        for e in events {
            let _ = match *e {
                Event::Beat(b) => self.app.emit(
                    "beat",
                    BeatPayload { t_ms: b.t_ms, strength: b.strength, bpm: b.bpm.map(|v| (v * 10.0).round() / 10.0) },
                ),
                Event::Level(level) => self.app.emit("beat-level", LevelPayload { level }),
            };
        }
    }

    fn status(&mut self, status: &BeatStatus) {
        if self.generation.load(Ordering::SeqCst) != self.mine {
            return; // a newer listener has taken over
        }
        *self.shared.lock().unwrap() = status.clone();
        let _ = self.app.emit("beat-status", status.clone());
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
struct WallClock;

impl Clock for WallClock {
    fn now_ms(&mut self) -> u64 {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
    }
    fn sleep_ms(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

/// Stop listening, if it is on. Safe to call any time (lock, exit).
pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    if let Some(l) = app.try_state::<BeatListener>() {
        l.stop();
    }
}

#[tauri::command]
pub fn beats_supported() -> bool {
    cfg!(windows)
}

#[tauri::command]
pub fn beats_status(state: State<'_, BeatListener>) -> BeatStatus {
    let s = state.status.lock().unwrap().clone();
    if s.state.is_empty() { BeatStatus { state: "off", ..s } } else { s }
}

#[tauri::command]
pub fn beats_start(app: AppHandle, state: State<'_, BeatListener>) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Listening to the computer's sound only works on Windows.".into());
    }
    let mut running = state.running.lock().unwrap();
    if running.as_ref().is_some_and(|r| !r.thread.is_finished() && !r.stop.load(Ordering::SeqCst)) {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let mine = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let sink = AppSink { app, shared: state.status.clone(), generation: state.generation.clone(), mine };
    let thread = std::thread::Builder::new()
        .name("beat-listener".into())
        .spawn(move || capture::run(sink, flag))
        .map_err(|e| format!("Couldn't start listening: {e}"))?;
    *running = Some(Running { stop, thread });
    Ok(())
}

#[tauri::command]
pub fn beats_stop(state: State<'_, BeatListener>) {
    state.stop();
}

#[cfg(not(windows))]
mod capture {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use tauri::Runtime;

    pub(super) fn run<R: Runtime>(_sink: super::AppSink<R>, _stop: Arc<AtomicBool>) {}
}

#[cfg(windows)]
mod capture {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use tauri::Runtime;

    pub(super) fn run<R: Runtime>(mut sink: super::AppSink<R>, stop: Arc<AtomicBool>) {
        // COM stays initialised for the whole thread; everything COM is
        // created and dropped inside `listen`, before this guard goes.
        let _com = crate::loopback_win::Com::init();
        let mut opener = crate::loopback_win::WasapiOpener::default();
        crate::beatloop::listen(&mut opener, &mut super::WallClock, &mut sink, &stop);
    }
}
