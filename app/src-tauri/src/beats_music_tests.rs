//! Beat sync, end to end without Windows: music-like recordings are made up
//! here (drum kits, bass, chords, melody, reverb, a loud "mastered" mix) at
//! many tempos and loudness levels, packed into the byte format Windows
//! hands over (32-bit float stereo, 10 ms packets), and played through the
//! real listening loop (beatloop::listen) and detector (beats.rs). Only the
//! handful of WASAPI calls in loopback_win.rs is left out.
//!
//! Real recordings can be checked too: put .wav files in a folder and run
//!   MV_BEAT_WAVS=/path/to/folder cargo test -p media-vault-app real_music -- --nocapture
//! (`ffmpeg -i song.mp3 -t 60 song.wav` makes one).

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::beatloop::{BeatStatus, Capture, Clock, Health, Opener, SampleKind, Sink, StreamInfo, decode_mono, listen};
use crate::beats::{Beat, Event};

const SR: u32 = 48_000;
const TAU: f64 = std::f64::consts::TAU;

// ---------------------------------------------------------------------------
// A tiny synthesiser

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }
}

#[derive(Clone, Copy)]
struct Style {
    name: &'static str,
    bpm: f64,
    /// Positions within a 4-beat bar, in beats.
    kick: &'static [f64],
    snare: &'static [f64],
    /// Hi-hat every this many beats (0 = none).
    hats: f64,
    /// 0.5 = straight, 0.66 = heavy swing (where the off-beat 8th lands).
    swing: f64,
    bass: bool,
    pad: bool,
    lead: bool,
    /// Seconds of chords only before the drums come in.
    intro: f64,
    /// Tempos that count as right (the true one and accepted octaves).
    ok_bpm: &'static [f64],
}

const STYLES: &[Style] = &[
    Style { name: "house 124", bpm: 124.0, kick: &[0.0, 1.0, 2.0, 3.0], snare: &[1.0, 3.0], hats: 0.5, swing: 0.5, bass: true, pad: true, lead: false, intro: 0.0, ok_bpm: &[124.0] },
    Style { name: "rock 112", bpm: 112.0, kick: &[0.0, 2.0, 2.5], snare: &[1.0, 3.0], hats: 0.5, swing: 0.5, bass: true, pad: true, lead: true, intro: 0.0, ok_bpm: &[112.0] },
    Style { name: "hip-hop 88 swung", bpm: 88.0, kick: &[0.0, 1.75, 2.5], snare: &[1.0, 3.0], hats: 0.5, swing: 0.62, bass: true, pad: true, lead: false, intro: 0.0, ok_bpm: &[88.0, 176.0] },
    Style { name: "ballad 72", bpm: 72.0, kick: &[0.0, 2.0], snare: &[1.0, 3.0], hats: 0.0, swing: 0.5, bass: true, pad: true, lead: true, intro: 0.0, ok_bpm: &[72.0, 144.0] },
    Style { name: "drum & bass 172", bpm: 172.0, kick: &[0.0, 2.5], snare: &[1.0, 3.0], hats: 0.5, swing: 0.5, bass: true, pad: false, lead: false, intro: 0.0, ok_bpm: &[172.0, 86.0] },
    Style { name: "pop 100 with an intro", bpm: 100.0, kick: &[0.0, 2.0], snare: &[1.0, 3.0], hats: 0.5, swing: 0.5, bass: true, pad: true, lead: true, intro: 4.0, ok_bpm: &[100.0] },
    Style { name: "techno 135", bpm: 135.0, kick: &[0.0, 1.0, 2.0, 3.0], snare: &[], hats: 0.25, swing: 0.5, bass: true, pad: false, lead: false, intro: 0.0, ok_bpm: &[135.0] },
];

/// Add `f(x)` (x = seconds since `at`) for `len` seconds.
fn add(buf: &mut [f64], at: f64, len: f64, mut f: impl FnMut(f64) -> f64) {
    let start = (at * f64::from(SR)) as usize;
    let n = (len * f64::from(SR)) as usize;
    for i in 0..n {
        if let Some(s) = buf.get_mut(start + i) {
            *s += f(i as f64 / f64::from(SR));
        }
    }
}

/// Where beat `b` (in beats from the start) falls, in seconds, with swing.
fn when(style: &Style, b: f64) -> f64 {
    let beat = b.floor();
    let frac = b - beat;
    let frac = if (frac - 0.5).abs() < 1e-9 { style.swing } else { frac };
    style.intro + (beat + frac) * 60.0 / style.bpm
}

/// Stereo music (interleaved f32) and the true beat times (ms).
fn render(style: &Style, seconds: f64, gain_db: f64, seed: u64) -> (Vec<f32>, Vec<f64>) {
    let n = (seconds * f64::from(SR)) as usize;
    let mut drums = vec![0.0f64; n];
    let mut tonal = vec![0.0f64; n];
    let mut hats_l = vec![0.0f64; n];
    let mut rng = Rng(seed);
    let spb = 60.0 / style.bpm;
    let beats = ((seconds - style.intro) / spb).floor() as usize;
    let mut truth = Vec::new();
    for b in 0..beats {
        truth.push((style.intro + b as f64 * spb) * 1000.0);
    }
    let bars = beats.div_ceil(4);
    for bar in 0..bars {
        let b0 = (bar * 4) as f64;
        for &k in style.kick {
            let at = when(style, b0 + k);
            let v = 0.9 + 0.1 * rng.next();
            let mut click = Rng(seed ^ bar as u64);
            add(&mut drums, at, 0.4, |x| {
                // A pitch sweep from about 160 Hz down to 48 Hz.
                let ph = TAU * (48.0 * x + 110.0 * 0.035 * (1.0 - (-x / 0.035).exp()));
                v * (ph.sin() * (-x / 0.2).exp() + 0.3 * click.next() * (-x / 0.002).exp())
            });
        }
        for &s in style.snare {
            let at = when(style, b0 + s);
            let mut noise = Rng(seed.wrapping_add(bar as u64 * 7 + 1));
            let mut prev = 0.0;
            add(&mut drums, at, 0.3, |x| {
                let w = noise.next();
                let hp = w - prev;
                prev = w;
                0.45 * hp * (-x / 0.09).exp() + 0.35 * (TAU * 185.0 * x).sin() * (-x / 0.05).exp()
            });
        }
        if style.hats > 0.0 {
            let mut h = 0.0;
            while h < 4.0 - 1e-9 {
                let at = when(style, b0 + h);
                let open = (h - 1.5).abs() < 1e-9 || (h - 3.5).abs() < 1e-9;
                let decay = if open { 0.12 } else { 0.02 };
                let mut noise = Rng(seed.wrapping_add((bar * 31) as u64 + (h * 8.0) as u64));
                let mut prev = 0.0;
                let accent = if (h.fract()).abs() < 1e-9 { 0.16 } else { 0.11 };
                add(&mut hats_l, at, decay * 5.0, |x| {
                    let w = noise.next();
                    let hp = w - prev;
                    prev = w;
                    accent * hp * (-x / decay).exp()
                });
                h += style.hats;
            }
        }
    }
    // Chords: one per bar, from the very start (the intro too).
    let roots = [55.0, 43.65, 49.0, 41.2]; // A, F, G, E
    let total_bars = ((seconds / (4.0 * spb)).ceil()) as usize + 1;
    for bar in 0..total_bars {
        let root = roots[bar % 4];
        let at = bar as f64 * 4.0 * spb;
        if style.pad {
            let notes = [root * 4.0, root * 5.0, root * 6.0];
            let len = 4.0 * spb;
            let mut lp = 0.0;
            add(&mut tonal, at, len, |x| {
                let env = (x / 0.15).min(1.0) * (1.0 - (x / len).powi(8));
                let mut s = 0.0;
                for (i, f) in notes.iter().enumerate() {
                    for d in [-0.003, 0.003] {
                        let ph = (f * (1.0 + d) * x + i as f64 * 0.17).fract();
                        s += 2.0 * ph - 1.0; // saw
                    }
                }
                lp += 0.08 * (s - lp);
                0.05 * env * lp
            });
        }
        if style.bass {
            // Eighth notes on the root and its octave, legato.
            for e in 0..8 {
                let t0 = style.intro + (bar * 4) as f64 * spb + e as f64 * spb / 2.0;
                if t0 < style.intro {
                    continue;
                }
                let f = if e % 4 == 3 { root * 2.0 } else { root };
                let mut lp = 0.0;
                add(&mut tonal, t0, spb / 2.0, |x| {
                    let ph = (f * x).fract();
                    let saw = 2.0 * ph - 1.0;
                    lp += 0.05 * (saw - lp);
                    0.35 * lp * (x / 0.01).min(1.0) * (-x / 0.6).exp()
                });
            }
        }
        if style.lead {
            // A melody off the grid now and then (distracting onsets).
            for k in 0..5 {
                let pos = [0.0, 0.75, 1.5, 2.25, 3.25][k];
                let t0 = style.intro + ((bar * 4) as f64 + pos) * spb;
                let f = root * [8.0, 9.0, 10.0, 12.0, 9.0][(k + bar) % 5];
                add(&mut tonal, t0, spb * 0.7, |x| {
                    let vib = 1.0 + 0.004 * (TAU * 5.5 * x).sin();
                    let s = (TAU * f * vib * x).sin() + 0.3 * (TAU * 2.0 * f * x).sin();
                    0.12 * s * (x / 0.02).min(1.0) * (-x / 0.4).exp()
                });
            }
        }
    }
    // Room: a few feedback combs on the drums.
    let mut wet = vec![0.0f64; n];
    for (delay_ms, fb) in [(29.7, 0.6), (37.1, 0.55), (41.1, 0.5), (43.7, 0.45)] {
        let d = (delay_ms / 1000.0 * f64::from(SR)) as usize;
        let mut line = vec![0.0f64; n];
        for i in 0..n {
            let back = if i >= d { line[i - d] } else { 0.0 };
            line[i] = drums[i] + fb * back;
            wet[i] += 0.06 * line[i];
        }
    }
    // Mix, "master" (normalise, soft-clip like a loud modern mix), then set
    // the level.
    let mut l: Vec<f64> = (0..n).map(|i| drums[i] + wet[i] + tonal[i] + 0.7 * hats_l[i]).collect();
    let mut r: Vec<f64> = (0..n).map(|i| drums[i] + 0.9 * wet[i] + tonal[i] + 1.0 * hats_l[i]).collect();
    let peak = l.iter().chain(&r).fold(1e-9f64, |m, v| m.max(v.abs()));
    let drive = 2.0;
    let gain = 10f64.powf(gain_db / 20.0);
    for v in l.iter_mut().chain(r.iter_mut()) {
        *v = (drive * *v / peak).tanh() / drive.tanh() * gain;
    }
    let mut out = Vec::with_capacity(2 * n);
    for i in 0..n {
        out.push(l[i] as f32);
        out.push(r[i] as f32);
    }
    (out, truth)
}

// ---------------------------------------------------------------------------
// Playing it through the real loop

#[derive(Default)]
struct Log {
    beats: Vec<Beat>,
    levels: Vec<f32>,
    statuses: Vec<BeatStatus>,
}

struct TestSink(Rc<RefCell<Log>>);
impl Sink for TestSink {
    fn events(&mut self, events: &[Event]) {
        let mut log = self.0.borrow_mut();
        for e in events {
            match *e {
                Event::Beat(b) => log.beats.push(b),
                Event::Level(l) => log.levels.push(l),
            }
        }
    }
    fn status(&mut self, status: &BeatStatus) {
        self.0.borrow_mut().statuses.push(status.clone());
    }
}

struct FakeClock(Rc<RefCell<u64>>);
impl Clock for FakeClock {
    fn now_ms(&mut self) -> u64 {
        *self.0.borrow()
    }
    fn sleep_ms(&mut self, ms: u64) {
        *self.0.borrow_mut() += ms;
    }
}

/// Plays interleaved stereo float music as Windows would: 10 ms packets of
/// little-endian f32 bytes; nothing at all during `gaps` (seconds).
struct Tape {
    music: Rc<Vec<f32>>,
    pos: usize,
    gaps: Vec<(f64, f64)>,
    stop: Arc<AtomicBool>,
    moved_at: Option<usize>,
    reads: usize,
}

impl Capture for Tape {
    fn info(&self) -> StreamInfo {
        StreamInfo { device: "Speakers (Test Audio)".into(), rate: SR, channels: 2, kind: SampleKind::F32 }
    }
    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        self.reads += 1;
        let frames = (SR / 100) as usize;
        let total = self.music.len() / 2;
        if self.pos >= total {
            self.stop.store(true, Ordering::SeqCst);
            return Ok(());
        }
        let end = (self.pos + frames).min(total);
        let t = self.pos as f64 / f64::from(SR);
        let quiet = self.gaps.iter().any(|&(a, b)| t >= a && t < b);
        if !quiet {
            let mut bytes = Vec::with_capacity((end - self.pos) * 8);
            for v in &self.music[self.pos * 2..end * 2] {
                bytes.extend(v.to_le_bytes());
            }
            decode_mono(&bytes, SampleKind::F32, 2, 8, out);
        }
        self.pos = end;
        Ok(())
    }
    fn health(&mut self) -> Health {
        let moved = self.moved_at.is_some_and(|r| self.reads >= r);
        if moved {
            self.moved_at = None;
        }
        Health { moved, volume: Some(0.5), muted: false }
    }
}

struct TapeOpener {
    music: Rc<Vec<f32>>,
    gaps: Vec<(f64, f64)>,
    stop: Arc<AtomicBool>,
    fail_first: usize,
    opened: usize,
    moved_at: Option<usize>,
}

impl Opener for TapeOpener {
    type C = Tape;
    fn open(&mut self) -> Result<Tape, String> {
        if self.fail_first > 0 {
            self.fail_first -= 1;
            return Err("No speakers or headphones are set as the default output (0x80070490)".into());
        }
        self.opened += 1;
        Ok(Tape {
            music: self.music.clone(),
            pos: 0,
            gaps: self.gaps.clone(),
            stop: self.stop.clone(),
            moved_at: self.moved_at.take(),
            reads: 0,
        })
    }
}

fn play(music: Vec<f32>, gaps: Vec<(f64, f64)>) -> Log {
    play_with(music, gaps, 0, None).0
}

fn play_with(music: Vec<f32>, gaps: Vec<(f64, f64)>, fail_first: usize, moved_at: Option<usize>) -> (Log, usize) {
    let log = Rc::new(RefCell::new(Log::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let mut opener = TapeOpener {
        music: Rc::new(music),
        gaps,
        stop: stop.clone(),
        fail_first,
        opened: 0,
        moved_at,
    };
    let mut clock = FakeClock(Rc::new(RefCell::new(0)));
    listen(&mut opener, &mut clock, &mut TestSink(log.clone()), &stop);
    let opened = opener.opened;
    let log = Rc::try_unwrap(log).ok().unwrap().into_inner();
    (log, opened)
}

/// Share of `beats` (ms) within `tol` ms of one of `grid`.
fn on_grid(beats: &[f64], grid: &[f64], tol: f64) -> f64 {
    if beats.is_empty() {
        return 0.0;
    }
    let hits = beats.iter().filter(|&&b| grid.iter().any(|&g| (b - g).abs() <= tol)).count();
    hits as f64 / beats.len() as f64
}

struct Verdict {
    found: usize,
    expected: usize,
    on_beat: f64,
    bpm: Option<f32>,
}

/// The loop starts its clock at 0 and the music plays from 0, so beat times
/// line up with the truth directly.
fn judge(style: &Style, log: &Log, truth: &[f64], from_ms: f64) -> Verdict {
    let late: Vec<f64> = log.beats.iter().map(|b| b.t_ms as f64).filter(|&t| t >= from_ms).collect();
    let expected = truth.iter().filter(|&&t| t >= from_ms).count();
    // Accept beats on the quarter-note grid (and, for tempos read at
    // double speed, the eighth-note grid).
    let spb = 60_000.0 / style.bpm;
    let mut grid = truth.to_vec();
    if style.ok_bpm.iter().any(|&b| b > style.bpm * 1.5) {
        grid.extend(truth.iter().map(|t| t + spb * (style.swing.max(0.5))));
    }
    Verdict { found: late.len(), expected, on_beat: on_grid(&late, &grid, 50.0), bpm: log.beats.last().and_then(|b| b.bpm) }
}

fn bpm_ok(style: &Style, bpm: Option<f32>) -> bool {
    bpm.is_some_and(|b| style.ok_bpm.iter().any(|&ok| (f64::from(b) - ok).abs() <= ok * 0.04))
}

// ---------------------------------------------------------------------------
// The tests

#[test]
fn music_in_many_styles_and_levels_gives_steady_beats() {
    let mut report = Vec::new();
    let mut failures = Vec::new();
    for (i, style) in STYLES.iter().enumerate() {
        for gain_db in [0.0, -20.0, -45.0] {
            let seconds = 24.0 + style.intro;
            let (music, truth) = render(style, seconds, gain_db, 100 + i as u64);
            let log = play(music, vec![]);
            let v = judge(style, &log, &truth, (style.intro + 8.0) * 1000.0);
            let line = format!(
                "{:<24} {:>4} dB: {:>3} beats for {:>3} quarter notes, {:>3.0}% on the beat, tempo {}",
                style.name,
                gain_db,
                v.found,
                v.expected,
                v.on_beat * 100.0,
                v.bpm.map_or("none".into(), |b| format!("{b:.1}"))
            );
            // Enough beats to drive a slideshow (one every 1–2 beats at
            // least), nearly all of them on the music's beat, right tempo.
            let enough = v.found * 2 >= v.expected;
            let not_too_many = v.found <= v.expected * 2 + 2;
            if !(enough && not_too_many && v.on_beat >= 0.85 && bpm_ok(style, v.bpm)) {
                failures.push(line.clone());
            }
            report.push(line);
        }
    }
    eprintln!("{}", report.join("\n"));
    assert!(failures.is_empty(), "these didn't follow the music:\n{}", failures.join("\n"));
}

#[test]
fn quiet_gaps_with_no_packets_dont_stop_listening() {
    // Windows sends nothing while nothing plays: music, 5 s of nothing at
    // all, music again.
    let style = &STYLES[0];
    let (music, truth) = render(style, 30.0, -6.0, 9);
    let log = play(music, vec![(10.0, 15.0)]);
    let in_gap = log.beats.iter().filter(|b| b.t_ms > 10_300 && b.t_ms < 14_900).count();
    assert_eq!(in_gap, 0, "beats during silence");
    let after: Vec<f64> = log.beats.iter().map(|b| b.t_ms as f64).filter(|&t| t > 18_000.0).collect();
    let expected = truth.iter().filter(|&&t| t > 18_000.0).count();
    assert!(after.len() * 10 >= expected * 8, "{} beats after the gap for {expected}", after.len());
    assert!(on_grid(&after, &truth, 50.0) >= 0.9);
    // The meter drops to nothing in the gap, and comes back.
    assert!(log.levels.contains(&0.0));
    assert!(log.levels.last().copied().unwrap_or(0.0) > 0.3);
    // The status says when sound stops and starts again.
    let receiving: Vec<bool> = log.statuses.iter().map(|s| s.receiving).collect();
    let flips = receiving.windows(2).filter(|w| w[0] != w[1]).count();
    assert!(flips >= 3, "receiving went {receiving:?}");
    let last_listening = log.statuses.iter().rev().find(|s| s.state == "listening").unwrap();
    assert_eq!(last_listening.device.as_deref(), Some("Speakers (Test Audio)"));
    assert_eq!(last_listening.format.as_deref(), Some("48 kHz · stereo · 32-bit float"));
    assert!(last_listening.log.iter().any(|l| l == "Sound is coming in"));
    assert_eq!(log.statuses.last().unwrap().state, "off");
}

#[test]
fn a_missing_output_is_reported_and_retried() {
    let (music, _) = render(&STYLES[0], 12.0, -6.0, 3);
    let (log, opened) = play_with(music, vec![], 2, None);
    assert_eq!(opened, 1);
    let err = log.statuses.iter().find(|s| s.state == "error").expect("an error status");
    assert!(err.error.as_deref().unwrap().starts_with("Couldn't open the sound output: No speakers"), "{:?}", err.error);
    // Logged once, not once per retry.
    let last = log.statuses.last().unwrap();
    assert_eq!(last.log.iter().filter(|l| l.starts_with("Couldn't open")).count(), 1);
    assert!(log.statuses.iter().any(|s| s.state == "listening" && s.error.is_none()));
    assert!(!log.beats.is_empty());
}

#[test]
fn a_changed_output_is_opened_again() {
    let (music, _) = render(&STYLES[0], 8.0, -6.0, 4);
    let (log, opened) = play_with(music, vec![], 0, Some(150));
    assert!(opened >= 2, "opened {opened} times");
    let last = log.statuses.last().unwrap();
    assert!(last.log.iter().any(|l| l.contains("changed")), "{:?}", last.log);
}

#[test]
fn silence_only_gives_a_still_meter_and_no_beats() {
    let log = play(vec![0.0; SR as usize * 2 * 10], vec![(0.0, 5.0)]);
    assert!(log.beats.is_empty());
    assert!(log.levels.len() >= 90, "{} level updates", log.levels.len());
    assert!(log.levels.iter().all(|&l| l == 0.0));
}

#[test]
fn analysis_keeps_up_with_real_time_easily() {
    let (music, _) = render(&STYLES[0], 20.0, -6.0, 5);
    let t = std::time::Instant::now();
    let _ = play(music, vec![]);
    // 20 s of music: even an unoptimised test build is far quicker.
    assert!(t.elapsed().as_secs_f64() < 10.0, "{:?}", t.elapsed());
}

// ---------------------------------------------------------------------------
// Real recordings

/// Reads a PCM or float WAV file into mono samples (first 90 s).
fn read_wav(bytes: &[u8]) -> Option<(u32, Vec<f32>)> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12;
    let mut fmt: Option<(SampleKind, u16, u32, u16)> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().ok()?) as usize;
        let body = &bytes[pos + 8..(pos + 8 + len).min(bytes.len())];
        if id == b"fmt " && body.len() >= 16 {
            let tag = u16::from_le_bytes([body[0], body[1]]);
            let ch = u16::from_le_bytes([body[2], body[3]]);
            let rate = u32::from_le_bytes(body[4..8].try_into().ok()?);
            let align = u16::from_le_bytes([body[12], body[13]]);
            let bits = u16::from_le_bytes([body[14], body[15]]);
            let sub = (body.len() >= 28).then(|| u32::from_le_bytes(body[24..28].try_into().unwrap()));
            fmt = Some((SampleKind::from_wave_format(tag, bits, sub)?, ch, rate, align));
        } else if id == b"data" {
            let (kind, ch, rate, align) = fmt?;
            let max = 90 * rate as usize * usize::from(align);
            let mut mono = Vec::new();
            decode_mono(&body[..body.len().min(max)], kind, usize::from(ch), usize::from(align), &mut mono);
            return Some((rate, mono));
        }
        pos += 8 + len + (len & 1);
    }
    None
}

fn beats_of(rate: u32, mono: &[f32]) -> (Vec<Beat>, Option<f32>) {
    let mut d = crate::beats::Detector::new(rate);
    let mut ev = Vec::new();
    for c in mono.chunks((rate / 100) as usize) {
        d.push(c, &mut ev);
    }
    let beats: Vec<Beat> = ev
        .into_iter()
        .filter_map(|e| match e {
            Event::Beat(b) => Some(b),
            Event::Level(_) => None,
        })
        .collect();
    let bpm = beats.last().and_then(|b| b.bpm);
    (beats, bpm)
}

#[test]
fn real_conga_loop_from_the_system_if_there_is_one() {
    // LibreOffice ships a short conga recording; looped, it is a real
    // (if simple) rhythm. Skipped where it isn't installed.
    let Ok(bytes) = std::fs::read("/usr/lib/libreoffice/share/gallery/sounds/kongas.wav") else {
        eprintln!("no conga recording here: skipped");
        return;
    };
    let (rate, mono) = read_wav(&bytes).expect("a readable wav");
    let mut looped = Vec::new();
    while looped.len() < rate as usize * 20 {
        looped.extend_from_slice(&mono);
    }
    let (beats, bpm) = beats_of(rate, &looped);
    let loop_ms = mono.len() as f64 / f64::from(rate) * 1000.0;
    eprintln!("conga loop ({loop_ms:.0} ms long): {} beats in 20 s, tempo {bpm:?}", beats.len());
    assert!(beats.len() >= 20, "{} beats", beats.len());
}

#[test]
fn real_music() {
    let Ok(dir) = std::env::var("MV_BEAT_WAVS") else {
        eprintln!("MV_BEAT_WAVS not set: skipped (see the top of beats_music_tests.rs)");
        return;
    };
    let mut any = false;
    for entry in std::fs::read_dir(&dir).expect("the MV_BEAT_WAVS folder") {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() != Some("wav") {
            continue;
        }
        let Some((rate, mono)) = std::fs::read(&path).ok().and_then(|b| read_wav(&b)) else {
            eprintln!("{}: not a PCM/float wav", path.display());
            continue;
        };
        any = true;
        let secs = mono.len() as f64 / f64::from(rate);
        let (beats, bpm) = beats_of(rate, &mono);
        let gaps: Vec<f64> = beats.windows(2).map(|w| (w[1].t_ms - w[0].t_ms) as f64).collect();
        let mut sorted = gaps.clone();
        sorted.sort_by(f64::total_cmp);
        let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
        eprintln!(
            "{}: {secs:.0} s, {} beats ({:.1}/s), median gap {median:.0} ms, tempo {bpm:?}",
            path.file_name().unwrap().to_string_lossy(),
            beats.len(),
            beats.len() as f64 / secs
        );
        assert!(!beats.is_empty(), "no beats in {}", path.display());
    }
    assert!(any, "no .wav files in {dir}");
}
