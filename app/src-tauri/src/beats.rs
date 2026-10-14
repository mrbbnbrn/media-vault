//! Beat detection on plain sample buffers. No audio APIs in here: the
//! Windows capture code (beatlisten.rs) feeds it mono samples and forwards
//! what comes out. Nothing is kept beyond a few seconds of numbers.
//!
//! How it works:
//! * Loudness: an automatic gain brings quiet and loud sound to the same
//!   level first (Windows hands over the sound after its volume slider, so
//!   music at 10 % volume is 30 dB quieter than at 100 %).
//! * Onsets: spectral flux. Every 512 samples a 1024-sample Hann-windowed
//!   FFT is taken and summed into third-octave bands (so a kick drum counts
//!   as much as the hi-hats); the flux is how much the log-compressed bands
//!   grew since the previous frame.
//! * Adaptive threshold: a flux peak is an onset when it beats
//!   `2 × median + 2 × std` of the last second of flux and is the biggest
//!   value within ±3 frames (~30 ms).
//! * Tempo: for every tempo from 60 to 200 BPM (0.5 BPM steps), how well a
//!   pulse train at that tempo lines up with the last 8 s of onsets (best
//!   phase against the average), counting in its half and double (the
//!   metre), with a soft preference for tempos near 120 BPM.
//! * Beats: until the tempo is known, onsets at least 200 ms apart. Then
//!   the beat grid (that tempo, lined up with the strongest onsets of the
//!   last 4 s) gives the beats, so they land on the music's beat and not on
//!   off-beat hi-hats or bass notes; they stop 1.5 s after the last onset.

use std::collections::VecDeque;

pub const FRAME: usize = 1024;
pub const HOP: usize = 512;
/// Beats are never closer together than this.
pub const MIN_GAP_MS: f64 = 200.0;
const PEAK_RADIUS: usize = 3;
const THRESH_SECONDS: f64 = 1.0;
const THRESH_MEDIAN: f32 = 2.0;
const THRESH_STD: f32 = 2.0;
/// Absolute floor so tiny wiggles in near-silence never count.
const THRESH_DELTA: f32 = 0.002;
const TEMPO_SECONDS: f64 = 8.0;
const TEMPO_MIN_SECONDS: f64 = 4.0;
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;
/// Frames quieter than this (about −80 dBFS) are treated as silence.
const SILENCE_RMS: f32 = 1e-4;
const LOG_GAMMA: f32 = 1000.0;
/// Level meter updates per second.
const LEVEL_RATE: u32 = 10;
/// The analysis brings music to about this loudness (RMS)…
const TARGET_RMS: f32 = 0.1;
/// …boosting quiet sound at most this much (60 dB).
const MAX_GAIN: f32 = 1000.0;
/// How fast that loudness follows the music, per frame (~94 a second).
const LOUDNESS_RISE: f32 = 0.01;
const LOUDNESS_FALL: f32 = 0.002;
/// How strongly tempos near 120 BPM are preferred (octaves; smaller is stronger).
const TEMPO_SPREAD: f64 = 0.7;
/// A tempo counts when its pulse stands out this much (times the average onset).
const MIN_CONTRAST: f32 = 0.6;
/// Another phase of the beat grid takes over when it lines up this much better.
const SWITCH_RATIO: f32 = 1.3;
/// Beats are at least this share of a beat apart, also when the grid moves.
const MIN_SPACING: f64 = 0.75;
/// Seconds of onsets the beat grid is lined up with.
const PHASE_SECONDS: f64 = 4.0;
/// Grid beats stop this long after the last onset (the music stopped).
const ALIVE_SECONDS: f64 = 1.5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Beat {
    /// Milliseconds since the detector started (stream time).
    pub t_ms: u64,
    /// 0..1: how clearly the beat stood out.
    pub strength: f32,
    /// Current tempo estimate, once there is a steady one.
    pub bpm: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Event {
    Beat(Beat),
    /// Loudness 0..1 for a small meter, about 10 times a second.
    Level(f32),
}

/// Average interleaved channels into `out` (appends).
#[cfg(test)]
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    let ch = channels.max(1);
    let scale = 1.0 / ch as f32;
    out.extend(
        interleaved
            .chunks_exact(ch)
            .map(|f| f.iter().sum::<f32>() * scale),
    );
}

pub struct Detector {
    sr: f64,
    fps: f64,
    fft: Fft,
    window: Vec<f32>,
    /// FFT bins summed into each band (low bands are narrow: equal say per octave).
    bands: Vec<(usize, usize)>,
    pending: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    prev: Vec<f32>,
    have_prev: bool,
    frame_no: u64,
    /// Slow average loudness (log RMS), so quiet and loud music look alike.
    loudness: Option<f32>,
    /// (flux, threshold) of the last 2·PEAK_RADIUS+1 frames.
    recent: VecDeque<(f32, f32)>,
    hist: VecDeque<f32>,
    hist_cap: usize,
    env: VecDeque<f32>,
    env_cap: usize,
    /// Last onset that stood out (any kind), and the last beat reported.
    last_onset_frame: Option<u64>,
    last_beat_frame: Option<f64>,
    bpm: Option<f32>,
    /// Once the tempo is known: the next beat on the music's grid (frame).
    next_beat: Option<f64>,
    tempo_countdown: usize,
    level: f32,
    level_sq: f64,
    level_n: usize,
    level_every: usize,
}

impl Detector {
    pub fn new(sample_rate: u32) -> Self {
        let sr = f64::from(sample_rate.max(8000));
        let fps = sr / HOP as f64;
        let window = (0..FRAME)
            .map(|i| {
                let x = std::f32::consts::TAU * i as f32 / FRAME as f32;
                0.5 - 0.5 * x.cos()
            })
            .collect();
        Self {
            sr,
            fps,
            fft: Fft::new(FRAME),
            window,
            bands: bands(sr),
            pending: Vec::with_capacity(FRAME * 2),
            re: vec![0.0; FRAME],
            im: vec![0.0; FRAME],
            prev: Vec::new(),
            have_prev: false,
            frame_no: 0,
            loudness: None,
            recent: VecDeque::with_capacity(2 * PEAK_RADIUS + 2),
            hist: VecDeque::new(),
            hist_cap: (THRESH_SECONDS * fps).round() as usize,
            env: VecDeque::new(),
            env_cap: (TEMPO_SECONDS * fps).round() as usize,
            last_onset_frame: None,
            last_beat_frame: None,
            bpm: None,
            next_beat: None,
            tempo_countdown: 0,
            level: 0.0,
            level_sq: 0.0,
            level_n: 0,
            level_every: (sr as usize / LEVEL_RATE as usize).max(1),
        }
    }

    #[cfg(test)]
    pub fn bpm(&self) -> Option<f32> {
        self.bpm
    }

    /// Feed mono samples; beats and level updates are appended to `out` in
    /// time order.
    pub fn push(&mut self, mono: &[f32], out: &mut Vec<Event>) {
        for &s in mono {
            let s = if s.is_finite() { s } else { 0.0 };
            self.level_sq += f64::from(s * s);
            self.level_n += 1;
            if self.level_n >= self.level_every {
                self.update_level(out);
            }
            self.pending.push(s);
            if self.pending.len() >= FRAME {
                self.analyse_frame(out);
                self.pending.drain(..HOP);
            }
        }
    }

    fn update_level(&mut self, out: &mut Vec<Event>) {
        let rms = (self.level_sq / self.level_n as f64).sqrt() as f32;
        self.level_sq = 0.0;
        self.level_n = 0;
        let db = 20.0 * (rms + 1e-9).log10();
        let now = ((db + 60.0) / 60.0).clamp(0.0, 1.0);
        // Jumps up at once, falls back gently.
        self.level = if now >= self.level {
            now
        } else {
            self.level * 0.6 + now * 0.4
        };
        if self.level < 0.005 {
            self.level = 0.0;
        }
        out.push(Event::Level(self.level));
    }

    fn analyse_frame(&mut self, out: &mut Vec<Event>) {
        let frame = &self.pending[..FRAME];
        let rms = (frame.iter().map(|x| x * x).sum::<f32>() / FRAME as f32).sqrt();
        let silent = rms < SILENCE_RMS;
        // Automatic gain: the analysis sees every song at about the same
        // loudness, whatever the Windows volume or the recording level.
        if !silent {
            let l = rms.ln();
            self.loudness = Some(match self.loudness {
                Some(v) if l < v => v + (l - v) * LOUDNESS_FALL,
                Some(v) => v + (l - v) * LOUDNESS_RISE,
                None => l,
            });
        }
        let gain = self.loudness.map_or(1.0, |v| (TARGET_RMS / v.exp()).clamp(0.5, MAX_GAIN));
        for (((re, im), x), w) in self
            .re
            .iter_mut()
            .zip(self.im.iter_mut())
            .zip(frame)
            .zip(&self.window)
        {
            *re = x * w * gain;
            *im = 0.0;
        }
        self.fft.run(&mut self.re, &mut self.im);
        let norm = 2.0 / FRAME as f32;
        if self.prev.len() != self.bands.len() {
            self.prev = vec![0.0; self.bands.len()];
        }
        let mut flux = 0.0f32;
        for (&(lo, hi), prev) in self.bands.iter().zip(self.prev.iter_mut()) {
            let mut sum = 0.0f32;
            for k in lo..hi {
                let (r, i) = (self.re[k], self.im[k]);
                sum += (r * r + i * i).sqrt();
            }
            let mag = sum / (hi - lo) as f32 * norm;
            let lm = (1.0 + LOG_GAMMA * mag).ln();
            flux += (lm - *prev).max(0.0);
            *prev = lm;
        }
        flux /= self.bands.len().max(1) as f32;
        if !self.have_prev || silent {
            flux = 0.0;
        }
        self.have_prev = true;

        let (median, std) = median_std(&self.hist);
        let thr = THRESH_DELTA + THRESH_MEDIAN * median + THRESH_STD * std;
        push_capped(&mut self.hist, flux, self.hist_cap);
        push_capped(&mut self.env, (flux - median).max(0.0), self.env_cap);

        self.recent.push_back((flux, thr));
        if self.recent.len() > 2 * PEAK_RADIUS + 1 {
            self.recent.pop_front();
        }
        if self.recent.len() == 2 * PEAK_RADIUS + 1 {
            self.pick_peak(out);
        }

        if self.tempo_countdown == 0 {
            self.tempo_countdown = (self.fps / 2.0) as usize;
            self.update_tempo();
        } else {
            self.tempo_countdown -= 1;
        }
        self.follow_grid(silent, out);
        self.frame_no += 1;
    }

    fn t_ms(&self, frame: f64) -> u64 {
        let sample = frame * HOP as f64 + FRAME as f64 / 2.0;
        (sample / self.sr * 1000.0).max(0.0).round() as u64
    }

    /// Onsets: a flux peak above the adaptive threshold. Reported as beats
    /// only until the tempo is known; after that they just show the music is
    /// still going (the beats then come from the grid, `follow_grid`).
    fn pick_peak(&mut self, out: &mut Vec<Event>) {
        let (v, thr) = self.recent[PEAK_RADIUS];
        // Not before the threshold has half a second of history to go on.
        if v <= thr || self.hist.len() < self.hist_cap / 2 {
            return;
        }
        let earlier_lower = self.recent.iter().take(PEAK_RADIUS).all(|&(x, _)| x < v);
        let later_not_higher = self.recent.iter().skip(PEAK_RADIUS + 1).all(|&(x, _)| x <= v);
        if !earlier_lower || !later_not_higher {
            return;
        }
        let center = self.frame_no - PEAK_RADIUS as u64;
        self.last_onset_frame = Some(center);
        if self.next_beat.is_some() {
            return;
        }
        if let Some(last) = self.last_beat_frame
            && ((center as f64 - last) / self.fps) * 1000.0 < MIN_GAP_MS
        {
            return;
        }
        self.last_beat_frame = Some(center as f64);
        out.push(Event::Beat(Beat {
            t_ms: self.t_ms(center as f64),
            strength: (1.0 - thr / v).clamp(0.0, 1.0),
            bpm: self.bpm,
        }));
    }

    fn update_tempo(&mut self) {
        if (self.env.len() as f64) < TEMPO_MIN_SECONDS * self.fps {
            self.bpm = None;
            self.next_beat = None;
            return;
        }
        let env: Vec<f32> = self.env.iter().copied().collect();
        self.bpm = match (estimate_bpm_near(&env, self.fps, self.bpm), self.bpm) {
            (Some(new), Some(old)) if ((new - old) / old).abs() < 0.06 => Some(old * 0.7 + new * 0.3),
            (new, _) => {
                // Another tempo: the grid starts afresh.
                self.next_beat = None;
                new
            }
        };
        match self.bpm {
            Some(bpm) => self.place_grid(&env, f64::from(bpm)),
            None => self.next_beat = None,
        }
    }

    /// Find where the beats fall (the phase of the tempo grid that lines up
    /// best with the onsets of the last few seconds) and aim `next_beat` at
    /// the next one.
    fn place_grid(&mut self, env: &[f32], bpm: f64) {
        let period = self.fps * 60.0 / bpm;
        let span = (PHASE_SECONDS * self.fps) as usize;
        let mean = env.iter().sum::<f32>() / env.len().max(1) as f32;
        let (back, contrast) = best_phase(env, period, span, mean);
        let now = self.frame_no as f64; // env's newest value is this frame
        if contrast <= 0.0 {
            self.next_beat = None;
            return;
        }
        // The first grid point that is still to come (and not soon after the
        // last beat reported).
        let floor = self.last_beat_frame.map_or(now, |b| (b + MIN_SPACING * period).max(now));
        let first_from = |latest: f64| {
            let mut g = latest;
            while g < floor - 0.5 {
                g += period;
            }
            g
        };
        let Some(cur) = self.next_beat else {
            self.next_beat = Some(first_from(now - back));
            return;
        };
        // Already following a grid: stay with it (only drifting with the
        // music) unless another phase is clearly better, so the beat doesn't
        // flip between, say, kick and snare.
        let cur_back = (now - cur).rem_euclid(period);
        let reach = (0.15 * period).round() as i64;
        let (mut local_back, mut local) = (cur_back, f32::MIN);
        for d in -reach..=reach {
            let b = (cur_back + d as f64).rem_euclid(period);
            let v = pulse_score(env, period, b, span);
            if v > local {
                (local_back, local) = (b, v);
            }
        }
        let best = pulse_score(env, period, back, span);
        if best > SWITCH_RATIO * local.max(1e-9) {
            self.next_beat = Some(first_from(now - back));
        } else {
            let mut shift = cur_back - local_back;
            if shift > period / 2.0 {
                shift -= period;
            } else if shift < -period / 2.0 {
                shift += period;
            }
            self.next_beat = Some(cur + 0.5 * shift);
        }
    }

    /// Report the beats of the grid as their time comes, while the music
    /// still has onsets (so beats stop soon after it does).
    fn follow_grid(&mut self, silent: bool, out: &mut Vec<Event>) {
        let (Some(bpm), Some(mut next)) = (self.bpm, self.next_beat) else {
            return;
        };
        let period = self.fps * 60.0 / f64::from(bpm);
        let now = self.frame_no as f64;
        let alive = !silent
            && self
                .last_onset_frame
                .is_some_and(|f| (now - f as f64) / self.fps < ALIVE_SECONDS);
        while next <= now + 0.5 {
            if alive && self.last_beat_frame.is_none_or(|b| next - b >= MIN_SPACING * period) {
                self.last_beat_frame = Some(next);
                let strength = self.env.iter().rev().take(3).fold(0.0f32, |m, &v| m.max(v));
                let (median, std) = median_std(&self.hist);
                out.push(Event::Beat(Beat {
                    t_ms: self.t_ms(next),
                    strength: (strength / (median + 2.0 * std + THRESH_DELTA)).clamp(0.0, 1.0),
                    bpm: Some(bpm),
                }));
            }
            next += period;
        }
        self.next_beat = Some(next);
    }
}

/// Band edges (FFT bins) for `sr`: about a third of an octave each from
/// 40 Hz up, at least one bin wide.
fn bands(sr: f64) -> Vec<(usize, usize)> {
    let hz_per_bin = sr / FRAME as f64;
    let top = FRAME / 2;
    let mut out = Vec::new();
    let mut lo = 1usize;
    let mut f = 40.0f64;
    while lo < top {
        f *= 2f64.powf(1.0 / 3.0);
        let hi = ((f / hz_per_bin).round() as usize).clamp(lo + 1, top);
        out.push((lo, hi));
        lo = hi;
    }
    out
}

fn push_capped(q: &mut VecDeque<f32>, v: f32, cap: usize) {
    q.push_back(v);
    while q.len() > cap.max(1) {
        q.pop_front();
    }
}

fn median_std(q: &VecDeque<f32>) -> (f32, f32) {
    if q.is_empty() {
        return (0.0, 0.0);
    }
    let mut v: Vec<f32> = q.iter().copied().collect();
    v.sort_by(f32::total_cmp);
    let median = v[v.len() / 2];
    let mean = v.iter().sum::<f32>() / v.len() as f32;
    let var = v.iter().map(|x| (x - mean) * (x - mean)).sum::<f32>() / v.len() as f32;
    (median, var.sqrt())
}

/// How strongly the onsets of `env` (newest last) repeat every `period`
/// frames, with the latest pulse `phase` frames back: the average onset at
/// those points, looking back `span` frames. Each point takes the biggest
/// value within a frame either side (a beat rarely starts exactly on a frame).
fn pulse_score(env: &[f32], period: f64, phase: f64, span: usize) -> f32 {
    let n = env.len();
    let span = span.min(n);
    let (mut sum, mut count) = (0.0f32, 0u32);
    let mut back = phase;
    while back.round() < span as f64 {
        let i = n - 1 - back.round() as usize;
        let lo = i.saturating_sub(1);
        let hi = (i + 1).min(n - 1);
        sum += env[lo..=hi].iter().copied().fold(0.0f32, f32::max);
        count += 1;
        back += period;
    }
    if count == 0 { 0.0 } else { sum / count as f32 }
}

/// The strongest pulse at `period`: (how many frames back its latest beat
/// is, how much it stands out from the other phases relative to the
/// average onset).
fn best_phase(env: &[f32], period: f64, span: usize, mean: f32) -> (f64, f32) {
    let steps = (period.ceil() as usize).max(1);
    let (mut best, mut best_at, mut total) = (0.0f32, 0usize, 0.0f32);
    for phase in 0..steps {
        let v = pulse_score(env, period, phase as f64, span);
        total += v;
        if v > best {
            best = v;
            best_at = phase;
        }
    }
    let contrast = (best - total / steps as f32) / mean.max(1e-9);
    (best_at as f64, contrast)
}

/// Tempo of an onset envelope sampled `fps` times a second: the period
/// whose pulse train lines up best with the onsets (in 0.5 BPM steps,
/// 60–200 BPM), with a soft preference for tempos near 120 BPM. `None`
/// when there is no clear, steady pulse.
#[cfg(test)]
pub fn estimate_bpm(env: &[f32], fps: f64) -> Option<f32> {
    estimate_bpm_near(env, fps, None)
}

/// Like `estimate_bpm`, a little in favour of the tempo found before (so it
/// doesn't hop between two readings of the same music).
///
/// Each tempo is judged together with its neighbours in the metre: a real
/// beat also shows at twice the tempo (the off-beats, eighth notes) and at
/// half of it (bars), where a tempo that merely fits some of the onsets
/// (say, 3 against 2) doesn't.
fn estimate_bpm_near(env: &[f32], fps: f64, previous: Option<f32>) -> Option<f32> {
    let n = env.len();
    if (n as f64) < 2.5 * fps * 60.0 / MIN_BPM {
        return None;
    }
    let mean = env.iter().sum::<f32>() / n as f32;
    if mean <= 1e-9 {
        return None;
    }
    let contrast = |bpm: f64| best_phase(env, fps * 60.0 / bpm, n, mean).1;
    let mut best: Option<(f32, f64)> = None;
    let mut half_bpm = 2.0 * MIN_BPM;
    while half_bpm <= 2.0 * MAX_BPM {
        let bpm = half_bpm / 2.0;
        half_bpm += 1.0;
        let c = contrast(bpm);
        if c < MIN_CONTRAST {
            continue;
        }
        let metre = c + 0.5 * contrast(bpm * 2.0).max(0.0) + 0.5 * contrast(bpm / 2.0).max(0.0);
        let z = (bpm / 120.0).log2() / TEMPO_SPREAD;
        let mut score = metre * (-0.5 * z * z).exp() as f32;
        if previous.is_some_and(|p| (bpm as f32 - p).abs() <= p * 0.04) {
            score *= 1.15;
        }
        if best.is_none_or(|(s, _)| score > s) {
            best = Some((score, bpm));
        }
    }
    best.map(|(_, bpm)| bpm as f32)
}

/// Small in-place radix-2 FFT (power-of-two sizes only).
struct Fft {
    n: usize,
    cos: Vec<f32>,
    sin: Vec<f32>,
    rev: Vec<usize>,
}

impl Fft {
    fn new(n: usize) -> Self {
        assert!(n.is_power_of_two() && n >= 2);
        let bits = n.trailing_zeros();
        let rev = (0..n)
            .map(|i| i.reverse_bits() >> (usize::BITS - bits))
            .collect();
        let ang = |k: usize| std::f64::consts::TAU * k as f64 / n as f64;
        Self {
            n,
            cos: (0..n / 2).map(|k| ang(k).cos() as f32).collect(),
            sin: (0..n / 2).map(|k| ang(k).sin() as f32).collect(),
            rev,
        }
    }

    fn run(&self, re: &mut [f32], im: &mut [f32]) {
        let n = self.n;
        for (i, &j) in self.rev.iter().enumerate() {
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = n / len;
            for start in (0..n).step_by(len) {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * step], -self.sin[k * step]);
                    let a = start + k;
                    let b = a + half;
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            len <<= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    /// Tiny deterministic noise source in −1..1.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
        }
    }

    /// Clicks (short decaying noise bursts) at `bpm` over steady noise.
    fn clicks(bpm: f64, seconds: f64, noise: f32, first_at: f64) -> (Vec<f32>, Vec<f64>) {
        let n = (seconds * f64::from(SR)) as usize;
        let mut rng = Lcg(7);
        let mut out: Vec<f32> = (0..n).map(|_| rng.next() * noise).collect();
        let period = 60.0 / bpm;
        let mut times = Vec::new();
        let mut t = first_at;
        while t < seconds - 0.05 {
            let start = (t * f64::from(SR)) as usize;
            for i in 0..(0.03 * f64::from(SR)) as usize {
                let decay = (-(i as f32) / (0.006 * SR as f32)).exp();
                out[start + i] += 0.8 * decay * rng.next();
            }
            times.push(t * 1000.0);
            t += period;
        }
        (out, times)
    }

    fn run(samples: &[f32]) -> (Vec<Beat>, Vec<f32>, Option<f32>) {
        let mut d = Detector::new(SR);
        let mut ev = Vec::new();
        // Feed in uneven chunks, like an audio callback would.
        for chunk in samples.chunks(441) {
            d.push(chunk, &mut ev);
        }
        let mut beats = Vec::new();
        let mut levels = Vec::new();
        for e in ev {
            match e {
                Event::Beat(b) => beats.push(b),
                Event::Level(l) => levels.push(l),
            }
        }
        (beats, levels, d.bpm())
    }

    #[test]
    fn fft_matches_naive_dft() {
        let n = 64;
        let fft = Fft::new(n);
        let mut rng = Lcg(3);
        let x: Vec<f32> = (0..n).map(|_| rng.next()).collect();
        let mut re = x.clone();
        let mut im = vec![0.0; n];
        fft.run(&mut re, &mut im);
        for k in 0..n {
            let (mut sr, mut si) = (0.0f64, 0.0f64);
            for (t, v) in x.iter().enumerate() {
                let a = -std::f64::consts::TAU * (k * t) as f64 / n as f64;
                sr += f64::from(*v) * a.cos();
                si += f64::from(*v) * a.sin();
            }
            assert!((sr - f64::from(re[k])).abs() < 1e-3, "re[{k}]");
            assert!((si - f64::from(im[k])).abs() < 1e-3, "im[{k}]");
        }
    }

    #[test]
    fn clicks_at_120_bpm_are_found_with_the_tempo() {
        let (samples, clicks) = clicks(120.0, 12.0, 0.03, 0.25);
        let (beats, _, bpm) = run(&samples);
        let bpm = bpm.expect("a tempo");
        assert!((bpm - 120.0).abs() < 3.0, "bpm {bpm}");
        // Nearly every click is found, and every beat is close to a click.
        assert!(
            beats.len() + 1 >= clicks.len(),
            "{} beats for {} clicks",
            beats.len(),
            clicks.len()
        );
        assert!(beats.len() <= clicks.len());
        for b in &beats {
            let off = clicks
                .iter()
                .map(|c| (b.t_ms as f64 - c).abs())
                .fold(f64::MAX, f64::min);
            assert!(
                off < 40.0,
                "beat at {} ms is {off:.0} ms from a click",
                b.t_ms
            );
            assert!(b.strength > 0.3, "strength {}", b.strength);
        }
        // Later beats carry the tempo.
        let last = beats.last().unwrap();
        assert!((last.bpm.unwrap() - 120.0).abs() < 3.0);
    }

    #[test]
    fn off_beats_are_skipped_once_the_tempo_is_known() {
        // Strong clicks at 100 BPM plus weaker ones halfway between.
        let (strong, clicks) = clicks(100.0, 12.0, 0.02, 0.3);
        let (weak, _) = self::clicks(100.0, 12.0, 0.0, 0.6);
        let samples: Vec<f32> = strong
            .iter()
            .zip(&weak)
            .map(|(a, b)| a + 0.35 * b)
            .collect();
        let (beats, _, bpm) = run(&samples);
        let bpm = bpm.expect("a tempo");
        assert!((bpm - 100.0).abs() < 3.0, "bpm {bpm}");
        let late: Vec<&Beat> = beats.iter().filter(|b| b.t_ms > 6000).collect();
        assert!(!late.is_empty());
        for b in late {
            let off = clicks
                .iter()
                .map(|c| (b.t_ms as f64 - c).abs())
                .fold(f64::MAX, f64::min);
            assert!(off < 40.0, "late beat at {} ms is an off-beat", b.t_ms);
        }
    }

    #[test]
    fn kick_and_hats_over_a_chord_lock_onto_the_kick() {
        // 128 BPM kick drum, hi-hats on every half beat, a held chord.
        let sr = f64::from(SR);
        let n = (14.0 * sr) as usize;
        let mut rng = Lcg(5);
        let mut s: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / sr;
                (0.12
                    * ((std::f64::consts::TAU * 220.0 * t).sin()
                        + (std::f64::consts::TAU * 277.2 * t).sin())) as f32
            })
            .collect();
        let period = 60.0 / 128.0;
        let mut kicks = Vec::new();
        let mut t = 0.2;
        while t < 13.6 {
            let at = (t * sr) as usize;
            for i in 0..(0.15 * sr) as usize {
                let x = i as f64 / sr;
                let f = 50.0 + 70.0 * (-x / 0.03).exp();
                s[at + i] +=
                    (0.7 * (-x / 0.06).exp() * (std::f64::consts::TAU * f * x).sin()) as f32;
            }
            for h in [0.0, period / 2.0] {
                let at = ((t + h) * sr) as usize;
                for i in 0..(0.02 * sr) as usize {
                    s[at + i] += 0.15 * (-(i as f32) / (0.004 * SR as f32)).exp() * rng.next();
                }
            }
            kicks.push(t * 1000.0);
            t += period;
        }
        let (beats, _, bpm) = run(&s);
        let bpm = bpm.expect("a tempo");
        assert!((bpm - 128.0).abs() < 3.0, "bpm {bpm}");
        // (Once the drums stop, the beat may run on for a moment: not judged.)
        let last_kick = kicks.last().copied().unwrap_or(0.0);
        let late: Vec<&Beat> = beats.iter().filter(|b| b.t_ms > 6000 && (b.t_ms as f64) < last_kick + 100.0).collect();
        let late_kicks = kicks.iter().filter(|&&k| k > 6000.0).count();
        assert!(
            late.len() * 10 >= late_kicks * 8,
            "{} beats for {late_kicks} kicks",
            late.len()
        );
        for b in late {
            let off = kicks
                .iter()
                .map(|c| (b.t_ms as f64 - c).abs())
                .fold(f64::MAX, f64::min);
            assert!(
                off < 40.0,
                "beat at {} ms is {off:.0} ms from a kick",
                b.t_ms
            );
        }
    }

    #[test]
    fn silence_gives_no_beats_and_a_zero_level() {
        let (beats, levels, bpm) = run(&vec![0.0; SR as usize * 10]);
        assert!(beats.is_empty());
        assert!(bpm.is_none());
        assert!(levels.len() >= 99);
        assert!(levels.iter().all(|&l| l == 0.0));
    }

    #[test]
    fn steady_noise_gives_no_beats() {
        let mut rng = Lcg(11);
        let samples: Vec<f32> = (0..SR as usize * 10).map(|_| rng.next() * 0.2).collect();
        let (beats, levels, _) = run(&samples);
        assert!(beats.len() <= 1, "{} beats in plain noise", beats.len());
        assert!(levels.iter().skip(2).all(|&l| l > 0.5 && l < 1.0));
    }

    #[test]
    fn tempo_from_an_envelope() {
        let fps = f64::from(SR) / HOP as f64;
        for bpm in [75.0, 90.0, 128.0, 150.0] {
            let period = fps * 60.0 / bpm;
            let n = (8.0 * fps) as usize;
            let mut env = vec![0.0f32; n];
            let mut t = 3.0;
            while (t as usize) < n {
                env[t as usize] = 1.0;
                t += period;
            }
            let got = estimate_bpm(&env, fps).expect("tempo");
            assert!(
                (f64::from(got) - bpm).abs() < bpm * 0.03,
                "{bpm}: got {got}"
            );
        }
        assert_eq!(estimate_bpm(&vec![0.0; 800], fps), None);
    }

    #[test]
    fn downmix_averages_channels() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.0]);
    }
}
