//! The beat listener's loop, without any audio API or window in it: open
//! the default output (through `Opener`), read what it plays, feed the
//! detector (beats.rs), report events and a status line (through `Sink`),
//! and open it again when it changes or breaks. The Windows side is
//! loopback_win.rs; beatlisten.rs wires it to the window. Tested on any
//! machine with fake openers and clocks (here and in beats_music_tests.rs).

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::beats::{Detector, Event};

/// What the listener is doing, for the small status line in the Timing panel.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeatStatus {
    /// "off", "starting", "listening" or "error".
    pub state: &'static str,
    /// Friendly name of the sound output being listened to.
    pub device: Option<String>,
    /// e.g. "48 kHz · 2 channels · 32-bit float".
    pub format: Option<String>,
    /// Why listening doesn't work right now (retried every couple of seconds).
    pub error: Option<String>,
    /// Sound arrived in the last second (Windows sends nothing while all is quiet).
    pub receiving: bool,
    /// Windows volume of that output, 0..1, when known.
    pub volume: Option<f32>,
    /// The output is muted in Windows.
    pub muted: bool,
    /// The last few things that happened, oldest first.
    pub log: Vec<String>,
}

const LOG_LINES: usize = 12;

impl BeatStatus {
    fn note(&mut self, line: String) {
        eprintln!("[beat sync] {line}");
        self.log.push(line);
        if self.log.len() > LOG_LINES {
            let extra = self.log.len() - LOG_LINES;
            self.log.drain(..extra);
        }
    }
}

// ---------------------------------------------------------------------------
// Sample formats (shared by the Windows capture code and the tests)

/// How one sample is stored in a capture buffer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleKind {
    F32,
    F64,
    U8,
    I16,
    I24,
    I32,
}

impl SampleKind {
    /// From a WAVEFORMATEX: the format tag, bits per sample and, for
    /// WAVE_FORMAT_EXTENSIBLE, the first field of the SubFormat GUID (which
    /// holds the real format tag).
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    pub fn from_wave_format(tag: u16, bits: u16, sub_tag: Option<u32>) -> Option<Self> {
        const PCM: u32 = 1;
        const FLOAT: u32 = 3;
        const EXTENSIBLE: u16 = 0xFFFE;
        let tag = if tag == EXTENSIBLE { sub_tag? } else { u32::from(tag) };
        Some(match (tag, bits) {
            (FLOAT, 32) => Self::F32,
            (FLOAT, 64) => Self::F64,
            (PCM, 8) => Self::U8,
            (PCM, 16) => Self::I16,
            (PCM, 24) => Self::I24,
            (PCM, 32) => Self::I32,
            _ => return None,
        })
    }

    pub fn bytes(self) -> usize {
        match self {
            Self::U8 => 1,
            Self::I16 => 2,
            Self::I24 => 3,
            Self::F32 | Self::I32 => 4,
            Self::F64 => 8,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::F32 => "32-bit float",
            Self::F64 => "64-bit float",
            Self::U8 => "8-bit",
            Self::I16 => "16-bit",
            Self::I24 => "24-bit",
            Self::I32 => "32-bit",
        }
    }

    fn read(self, b: &[u8]) -> f32 {
        match self {
            Self::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            Self::F64 => f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f32,
            Self::U8 => (f32::from(b[0]) - 128.0) / 128.0,
            Self::I16 => f32::from(i16::from_le_bytes([b[0], b[1]])) / 32_768.0,
            Self::I24 => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
            Self::I32 => (f64::from(i32::from_le_bytes([b[0], b[1], b[2], b[3]])) / 2_147_483_648.0) as f32,
        }
    }
}

/// Interleaved little-endian frames (`stride` bytes each, `channels` samples
/// at the start of each) → mono samples appended to `out`.
pub fn decode_mono(bytes: &[u8], kind: SampleKind, channels: usize, stride: usize, out: &mut Vec<f32>) {
    let ch = channels.max(1);
    let size = kind.bytes();
    let stride = stride.max(ch * size);
    let scale = 1.0 / ch as f32;
    out.extend(bytes.chunks_exact(stride).map(|frame| {
        let sum: f32 = (0..ch).map(|c| kind.read(&frame[c * size..])).sum();
        let v = sum * scale;
        if v.is_finite() { v } else { 0.0 }
    }));
}

// ---------------------------------------------------------------------------
// The listening loop

/// An open capture stream.
pub trait Capture {
    /// Device name and format, for the status line.
    fn info(&self) -> StreamInfo;
    /// Append whatever mono samples are ready (often none). An error means
    /// the stream broke and has to be opened again.
    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String>;
    /// Asked about once a second.
    fn health(&mut self) -> Health;
}

#[derive(Clone, Debug)]
pub struct StreamInfo {
    pub device: String,
    pub rate: u32,
    pub channels: u16,
    pub kind: SampleKind,
}

impl StreamInfo {
    fn describe(&self) -> String {
        let khz = f64::from(self.rate) / 1000.0;
        let khz = if self.rate.is_multiple_of(1000) { format!("{khz:.0}") } else { format!("{khz:.1}") };
        let ch = match self.channels {
            1 => "mono".to_string(),
            2 => "stereo".to_string(),
            n => format!("{n} channels"),
        };
        format!("{khz} kHz · {ch} · {}", self.kind.label())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Health {
    /// The default output changed (or went away): open it again.
    pub moved: bool,
    pub volume: Option<f32>,
    pub muted: bool,
}

pub trait Opener {
    type C: Capture;
    fn open(&mut self) -> Result<Self::C, String>;
}

/// Time, so the tests can run the loop without waiting.
pub trait Clock {
    fn now_ms(&mut self) -> u64;
    fn sleep_ms(&mut self, ms: u64);
}

/// Where the results go (the window, or a test).
pub trait Sink {
    fn events(&mut self, events: &[Event]);
    fn status(&mut self, status: &BeatStatus);
}

/// How often the capture buffer is read. Windows keeps 200 ms of sound for
/// us, so a late wake-up loses nothing.
const POLL_MS: u64 = 10;
/// After this long without sound, the detector is fed silence so the meter
/// falls and the clock keeps running.
const IDLE_FILL_MS: u64 = 150;
const HEALTH_EVERY_MS: u64 = 1000;
const RETRY_OPEN_MS: u64 = 2000;
const RETRY_BROKEN_MS: u64 = 500;

enum End {
    Stopped,
    Moved,
    Broken(String),
}

/// Listen until `stop` is set: open the default output, analyse what it
/// plays, and open it again whenever it changes or breaks.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn listen<O: Opener>(opener: &mut O, clock: &mut impl Clock, sink: &mut impl Sink, stop: &AtomicBool) {
    let mut status = BeatStatus { state: "starting", ..BeatStatus::default() };
    sink.status(&status);
    while !stop.load(Ordering::SeqCst) {
        let mut cap = match opener.open() {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("Couldn't open the sound output: {e}");
                if status.error.as_deref() != Some(msg.as_str()) {
                    status.note(msg.clone());
                }
                status.state = "error";
                status.error = Some(msg);
                status.receiving = false;
                sink.status(&status);
                if wait(clock, stop, RETRY_OPEN_MS) {
                    break;
                }
                continue;
            }
        };
        let info = cap.info();
        let what = info.describe();
        status.note(format!("Listening to {} ({what})", info.device));
        status.state = "listening";
        status.device = Some(info.device.clone());
        status.format = Some(what);
        status.error = None;
        status.receiving = false;
        sink.status(&status);
        let end = pump(&mut cap, &info, clock, sink, stop, &mut status);
        drop(cap);
        match end {
            End::Stopped => break,
            End::Moved => {
                status.note("The sound output changed; switching over".into());
                status.state = "starting";
                sink.status(&status);
            }
            End::Broken(e) => {
                let msg = format!("Lost the sound output: {e}");
                status.note(msg.clone());
                status.state = "error";
                status.error = Some(msg);
                status.receiving = false;
                sink.status(&status);
                if wait(clock, stop, RETRY_BROKEN_MS) {
                    break;
                }
            }
        }
    }
    status.state = "off";
    status.receiving = false;
    sink.status(&status);
}

/// Sleep in small steps; true when told to stop meanwhile.
fn wait(clock: &mut impl Clock, stop: &AtomicBool, ms: u64) -> bool {
    let mut left = ms;
    while left > 0 {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        let step = left.min(50);
        clock.sleep_ms(step);
        left -= step;
    }
    stop.load(Ordering::SeqCst)
}

fn pump<C: Capture>(
    cap: &mut C,
    info: &StreamInfo,
    clock: &mut impl Clock,
    sink: &mut impl Sink,
    stop: &AtomicBool,
    status: &mut BeatStatus,
) -> End {
    let rate = u64::from(info.rate.max(1));
    let mut detector = Detector::new(info.rate);
    let mut buf: Vec<f32> = Vec::new();
    let mut events = Vec::new();
    let quiet = vec![0.0f32; (rate / 20).max(1) as usize];
    let start = clock.now_ms();
    // Silence fed since the last real sound.
    let mut filled: u64 = 0;
    let mut last_sound = start;
    let mut last_health = start;
    let mut got_any = false;
    loop {
        if stop.load(Ordering::SeqCst) {
            return End::Stopped;
        }
        buf.clear();
        if let Err(e) = cap.read(&mut buf) {
            return End::Broken(e);
        }
        let now = clock.now_ms();
        if !buf.is_empty() {
            detector.push(&buf, &mut events);
            filled = 0;
            last_sound = now;
            if !got_any {
                got_any = true;
                status.note("Sound is coming in".into());
            }
            if !status.receiving {
                status.receiving = true;
                sink.status(status);
            }
        } else if now.saturating_sub(last_sound) >= IDLE_FILL_MS {
            // Catch the detector up with the wall clock, in silence.
            let due = now.saturating_sub(last_sound) * rate / 1000;
            while filled + quiet.len() as u64 <= due {
                detector.push(&quiet, &mut events);
                filled += quiet.len() as u64;
            }
            if status.receiving && now.saturating_sub(last_sound) >= 1000 {
                status.receiving = false;
                sink.status(status);
            }
        }
        if !events.is_empty() {
            sink.events(&events);
            events.clear();
        }
        if now.saturating_sub(last_health) >= HEALTH_EVERY_MS {
            last_health = now;
            let h = cap.health();
            if h.moved {
                return End::Moved;
            }
            if h.volume != status.volume || h.muted != status.muted {
                if h.muted && !status.muted {
                    status.note("The sound output is muted in Windows".into());
                }
                status.volume = h.volume;
                status.muted = h.muted;
                sink.status(status);
            }
        }
        clock.sleep_ms(POLL_MS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wave_formats() {
        assert_eq!(SampleKind::from_wave_format(3, 32, None), Some(SampleKind::F32));
        assert_eq!(SampleKind::from_wave_format(0xFFFE, 32, Some(3)), Some(SampleKind::F32));
        assert_eq!(SampleKind::from_wave_format(0xFFFE, 32, Some(1)), Some(SampleKind::I32));
        assert_eq!(SampleKind::from_wave_format(0xFFFE, 24, Some(1)), Some(SampleKind::I24));
        assert_eq!(SampleKind::from_wave_format(1, 16, None), Some(SampleKind::I16));
        assert_eq!(SampleKind::from_wave_format(0xFFFE, 32, None), None);
        assert_eq!(SampleKind::from_wave_format(0x0092, 16, None), None); // AC-3 passthrough
    }

    #[test]
    fn decodes_every_format_to_mono() {
        // Two stereo frames: (0.5, -0.5) and (0.25, 0.75).
        let frames = [(0.5f64, -0.5f64), (0.25, 0.75)];
        let expect = [0.0f32, 0.5];
        type Encode = fn(f64) -> Vec<u8>;
        let enc: [(SampleKind, Encode); 6] = [
            (SampleKind::F32, |v| (v as f32).to_le_bytes().to_vec()),
            (SampleKind::F64, |v| v.to_le_bytes().to_vec()),
            (SampleKind::I16, |v| ((v * 32_768.0) as i16).to_le_bytes().to_vec()),
            (SampleKind::I24, |v| ((v * 8_388_608.0) as i32).to_le_bytes()[..3].to_vec()),
            (SampleKind::I32, |v| ((v * 2_147_483_648.0) as i32).to_le_bytes().to_vec()),
            (SampleKind::U8, |v| vec![(v * 128.0 + 128.0) as u8]),
        ];
        for (kind, f) in enc {
            let mut bytes = Vec::new();
            for (l, r) in frames {
                bytes.extend(f(l));
                bytes.extend(f(r));
            }
            let mut out = Vec::new();
            decode_mono(&bytes, kind, 2, 2 * kind.bytes(), &mut out);
            assert_eq!(out.len(), 2, "{kind:?}");
            for (a, b) in out.iter().zip(expect) {
                assert!((a - b).abs() < 0.01, "{kind:?}: {a} vs {b}");
            }
        }
        // A wider stride (padding after the samples) is skipped over.
        let mut bytes = Vec::new();
        for v in [0.5f32, 0.25] {
            bytes.extend(v.to_le_bytes());
            bytes.extend([0xFFu8; 4]);
        }
        let mut out = Vec::new();
        decode_mono(&bytes, SampleKind::F32, 1, 8, &mut out);
        assert_eq!(out, vec![0.5, 0.25]);
    }

    #[test]
    fn describes_the_stream() {
        let i = StreamInfo { device: "Speakers".into(), rate: 44_100, channels: 2, kind: SampleKind::F32 };
        assert_eq!(i.describe(), "44.1 kHz · stereo · 32-bit float");
        let i = StreamInfo { device: "Speakers".into(), rate: 48_000, channels: 6, kind: SampleKind::I16 };
        assert_eq!(i.describe(), "48 kHz · 6 channels · 16-bit");
    }
}
