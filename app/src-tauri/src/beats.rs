//! Beat detection on plain sample buffers. No audio APIs in here: the
//! Windows capture code (beatlisten.rs) feeds it mono samples and forwards
//! what comes out. Nothing is kept beyond a few seconds of numbers.
//!
//! How it works:
//! * Onsets: spectral flux. Every 512 samples a 1024-sample Hann-windowed
//!   FFT is taken; the flux is how much the (log-compressed) spectrum grew
//!   since the previous frame.
//! * Adaptive threshold: a flux peak counts as a beat when it beats
//!   `1.5 × median + 1 × std` of the last second of flux, is the biggest
//!   value within ±3 frames (~30 ms) and comes at least 200 ms after the
//!   previous beat (longer once the tempo is known, so off-beats are skipped).
//! * Tempo: autocorrelation of the last 8 s of the onset envelope, looking
//!   at 60–200 BPM with a soft preference for tempos near 120 BPM (avoids
//!   picking half or double the real tempo).

use std::collections::VecDeque;

pub const FRAME: usize = 1024;
pub const HOP: usize = 512;
/// Beats are never closer together than this.
pub const MIN_GAP_MS: f64 = 200.0;
/// Once the tempo is known, beats are at least this share of a beat apart.
const GAP_SHARE_OF_BEAT: f64 = 0.7;
const PEAK_RADIUS: usize = 3;
const THRESH_SECONDS: f64 = 1.0;
const THRESH_MEDIAN: f32 = 1.5;
const THRESH_STD: f32 = 1.0;
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
    pending: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    prev: Vec<f32>,
    have_prev: bool,
    frame_no: u64,
    /// (flux, threshold) of the last 2·PEAK_RADIUS+1 frames.
    recent: VecDeque<(f32, f32)>,
    hist: VecDeque<f32>,
    hist_cap: usize,
    env: VecDeque<f32>,
    env_cap: usize,
    last_beat_frame: Option<u64>,
    bpm: Option<f32>,
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
            pending: Vec::with_capacity(FRAME * 2),
            re: vec![0.0; FRAME],
            im: vec![0.0; FRAME],
            prev: vec![0.0; FRAME / 2],
            have_prev: false,
            frame_no: 0,
            recent: VecDeque::with_capacity(2 * PEAK_RADIUS + 2),
            hist: VecDeque::new(),
            hist_cap: (THRESH_SECONDS * fps).round() as usize,
            env: VecDeque::new(),
            env_cap: (TEMPO_SECONDS * fps).round() as usize,
            last_beat_frame: None,
            bpm: None,
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
        for (((re, im), x), w) in self
            .re
            .iter_mut()
            .zip(self.im.iter_mut())
            .zip(frame)
            .zip(&self.window)
        {
            *re = x * w;
            *im = 0.0;
        }
        self.fft.run(&mut self.re, &mut self.im);
        let norm = 2.0 / FRAME as f32;
        let mut flux = 0.0f32;
        // Bins 1..FRAME/2 (DC left out).
        for (k, prev) in self.prev.iter_mut().enumerate() {
            let (r, i) = (self.re[k + 1], self.im[k + 1]);
            let mag = (r * r + i * i).sqrt() * norm;
            let lm = (1.0 + LOG_GAMMA * mag).ln();
            flux += (lm - *prev).max(0.0);
            *prev = lm;
        }
        flux /= self.prev.len() as f32;
        if !self.have_prev || rms < SILENCE_RMS {
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
        self.frame_no += 1;
    }

    fn pick_peak(&mut self, out: &mut Vec<Event>) {
        let (v, thr) = self.recent[PEAK_RADIUS];
        if v <= thr {
            return;
        }
        let earlier_lower = self.recent.iter().take(PEAK_RADIUS).all(|&(x, _)| x < v);
        let later_not_higher = self
            .recent
            .iter()
            .skip(PEAK_RADIUS + 1)
            .all(|&(x, _)| x <= v);
        if !earlier_lower || !later_not_higher {
            return;
        }
        let center = self.frame_no - PEAK_RADIUS as u64;
        let mut gap_ms = MIN_GAP_MS;
        if let Some(bpm) = self.bpm {
            gap_ms = gap_ms.max(GAP_SHARE_OF_BEAT * 60_000.0 / f64::from(bpm));
        }
        if let Some(last) = self.last_beat_frame
            && ((center - last) as f64 / self.fps) * 1000.0 < gap_ms
        {
            return;
        }
        self.last_beat_frame = Some(center);
        let center_sample = center as f64 * HOP as f64 + FRAME as f64 / 2.0;
        out.push(Event::Beat(Beat {
            t_ms: (center_sample / self.sr * 1000.0).round() as u64,
            strength: (1.0 - thr / v).clamp(0.0, 1.0),
            bpm: self.bpm,
        }));
    }

    fn update_tempo(&mut self) {
        if (self.env.len() as f64) < TEMPO_MIN_SECONDS * self.fps {
            self.bpm = None;
            return;
        }
        let env: Vec<f32> = self.env.iter().copied().collect();
        self.bpm = match (estimate_bpm(&env, self.fps), self.bpm) {
            (Some(new), Some(old)) if ((new - old) / old).abs() < 0.06 => {
                Some(old * 0.7 + new * 0.3)
            }
            (new, _) => new,
        };
    }
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

/// Tempo of an onset envelope sampled `fps` times a second, by
/// autocorrelation. `None` when there is no clear, steady pulse.
pub fn estimate_bpm(env: &[f32], fps: f64) -> Option<f32> {
    let n = env.len();
    let lag_min = ((fps * 60.0 / MAX_BPM).floor() as usize).max(2);
    let lag_max = ((fps * 60.0 / MIN_BPM).ceil() as usize).min(n / 2);
    if lag_max <= lag_min + 2 {
        return None;
    }
    // Light smoothing, so beats that fall between frames still line up.
    let smooth: Vec<f32> = (0..n)
        .map(|i| {
            const K: [f32; 5] = [1.0, 2.0, 3.0, 2.0, 1.0];
            let (mut s, mut w) = (0.0, 0.0);
            for (j, k) in K.iter().enumerate() {
                if let Some(v) = (i + j).checked_sub(2).and_then(|p| env.get(p)) {
                    s += v * k;
                    w += k;
                }
            }
            s / w
        })
        .collect();
    let mean = smooth.iter().sum::<f32>() / n as f32;
    let x: Vec<f32> = smooth.iter().map(|v| v - mean).collect();
    let ac0 = x.iter().map(|v| v * v).sum::<f32>() / n as f32;
    if ac0 <= 1e-12 {
        return None;
    }
    // Normalised (unbiased) autocorrelation for 0 ..= 2·lag_max+1.
    let ac: Vec<f32> = (0..=2 * lag_max + 1)
        .map(|l| {
            if l >= n {
                return 0.0;
            }
            let s: f32 = x[..n - l].iter().zip(&x[l..]).map(|(a, b)| a * b).sum();
            s / (n - l) as f32 / ac0
        })
        .collect();
    let weight = |lag: f64| {
        let bpm = 60.0 * fps / lag;
        let oct = (bpm / 120.0).log2();
        (-0.5 * oct * oct).exp() as f32
    };
    // A real beat period also repeats at twice the lag; counting that in
    // keeps a fast tempo from being read as half its speed.
    let (best, _) = (lag_min..=lag_max)
        .map(|l| (l, (ac[l] + 0.5 * ac[2 * l]) * weight(l as f64)))
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    let peak = ac[best];
    if peak < 0.15 {
        return None;
    }
    let (a, b, c) = (ac[best - 1], peak, ac[best + 1]);
    let denom = a - 2.0 * b + c;
    let shift = if denom.abs() > 1e-9 {
        (0.5 * (a - c) / denom).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    let lag = best as f64 + f64::from(shift);
    Some((60.0 * fps / lag) as f32)
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
        let late: Vec<&Beat> = beats.iter().filter(|b| b.t_ms > 6000).collect();
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
