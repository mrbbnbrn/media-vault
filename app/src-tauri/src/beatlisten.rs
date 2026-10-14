//! Listen to the computer's own sound (what plays through the speakers or
//! headphones) and report beats, for beat-synced slideshows.
//!
//! Windows only: WASAPI loopback through cpal (an input stream built on the
//! default *output* device). Samples are analysed in memory as they arrive
//! (see beats.rs) and dropped right away: nothing is recorded or saved.
//!
//! Events:
//! * `beat`       `{ t_ms, strength, bpm }` — at most one per 200 ms
//! * `beat-level` `{ level }` — 0..1, about 10 times a second
//!
//! Listening stops on `beats_stop`, when the vault locks and when the app
//! exits.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

#[derive(Default)]
pub struct BeatListener {
    running: Mutex<Option<Running>>,
}

struct Running {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl BeatListener {
    fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            r.stop.store(true, Ordering::SeqCst);
            // Not joined: the thread notices within ~100 ms and ends itself.
            drop(r.thread);
        }
    }
}

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

#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows capture loop
fn emit_events<R: Runtime>(app: &AppHandle<R>, events: &[crate::beats::Event]) {
    use crate::beats::Event;
    for e in events {
        let _ = match *e {
            Event::Beat(b) => app.emit(
                "beat",
                BeatPayload {
                    t_ms: b.t_ms,
                    strength: b.strength,
                    bpm: b.bpm.map(|v| (v * 10.0).round() / 10.0),
                },
            ),
            Event::Level(level) => app.emit("beat-level", LevelPayload { level }),
        };
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
pub fn beats_start(app: AppHandle, state: State<'_, BeatListener>) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Listening to the computer's sound only works on Windows.".into());
    }
    let mut running = state.running.lock().unwrap();
    if running
        .as_ref()
        .is_some_and(|r| !r.thread.is_finished() && !r.stop.load(Ordering::SeqCst))
    {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let thread = std::thread::Builder::new()
        .name("beat-listener".into())
        .spawn(move || capture::run(app, flag))
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

    use tauri::AppHandle;

    pub fn run(_app: AppHandle, _stop: Arc<AtomicBool>) {}
}

#[cfg(windows)]
mod capture {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
    use std::time::Duration;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{SampleFormat, SizedSample};
    use tauri::AppHandle;

    use super::emit_events;
    use crate::beats::{Detector, Event, downmix};

    /// Capture until `stop` is set. Reopens the stream when the default
    /// output device changes or goes away (headphones plugged in, etc.).
    pub fn run(app: AppHandle, stop: Arc<AtomicBool>) {
        let mut events = Vec::new();
        while !stop.load(Ordering::SeqCst) {
            let failed = Arc::new(AtomicBool::new(false));
            let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(256);
            let (stream, rate) = match open(tx, failed.clone()) {
                Ok(s) => s,
                Err(_) => {
                    // No output device right now: show a still meter, retry.
                    emit_events(&app, &[Event::Level(0.0)]);
                    for _ in 0..20 {
                        if stop.load(Ordering::SeqCst) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    continue;
                }
            };
            let mut detector = Detector::new(rate);
            pump(&app, &stop, &failed, &rx, &mut detector, rate, &mut events);
            drop(stream);
        }
    }

    fn pump(
        app: &AppHandle,
        stop: &AtomicBool,
        failed: &AtomicBool,
        rx: &Receiver<Vec<f32>>,
        detector: &mut Detector,
        rate: u32,
        events: &mut Vec<Event>,
    ) {
        // Windows delivers nothing while nothing plays; feed silence then so
        // the meter falls and the clock keeps running.
        let quiet = vec![0.0f32; (rate / 10) as usize];
        while !stop.load(Ordering::SeqCst) && !failed.load(Ordering::SeqCst) {
            events.clear();
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(buf) => detector.push(&buf, events),
                Err(RecvTimeoutError::Timeout) => detector.push(&quiet, events),
                Err(RecvTimeoutError::Disconnected) => return,
            }
            emit_events(app, events);
        }
    }

    fn open(
        tx: SyncSender<Vec<f32>>,
        failed: Arc<AtomicBool>,
    ) -> Result<(cpal::Stream, u32), String> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or("No speakers or headphones found.")?;
        let supported = device.default_output_config().map_err(|e| e.to_string())?;
        let channels = usize::from(supported.channels());
        let rate = supported.sample_rate();
        let config = supported.config();
        let stream = match supported.sample_format() {
            SampleFormat::F32 => build::<f32>(&device, config, channels, tx, failed, |s| s),
            SampleFormat::I16 => build::<i16>(&device, config, channels, tx, failed, |s| {
                f32::from(s) / 32_768.0
            }),
            SampleFormat::I32 => build::<i32>(&device, config, channels, tx, failed, |s| {
                (f64::from(s) / 2_147_483_648.0) as f32
            }),
            other => return Err(format!("Unsupported sound format {other:?}.")),
        }?;
        stream.play().map_err(|e| e.to_string())?;
        Ok((stream, rate))
    }

    fn build<T: SizedSample + Copy + Send + 'static>(
        device: &cpal::Device,
        config: cpal::StreamConfig,
        channels: usize,
        tx: SyncSender<Vec<f32>>,
        failed: Arc<AtomicBool>,
        to_f32: fn(T) -> f32,
    ) -> Result<cpal::Stream, String> {
        let mut floats: Vec<f32> = Vec::new();
        device
            .build_input_stream::<T, _, _>(
                config,
                move |data: &[T], _: &cpal::InputCallbackInfo| {
                    floats.clear();
                    floats.extend(data.iter().map(|&s| to_f32(s)));
                    let mut mono = Vec::with_capacity(floats.len() / channels.max(1));
                    downmix(&floats, channels, &mut mono);
                    // Never block the audio thread; drop data if analysis lags.
                    let _ = tx.try_send(mono);
                },
                move |_err: cpal::Error| failed.store(true, Ordering::SeqCst),
                None,
            )
            .map_err(|e| e.to_string())
    }
}
