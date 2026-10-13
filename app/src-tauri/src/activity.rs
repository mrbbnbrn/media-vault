//! Decides when the vault should lock itself.
//!
//! The rule the user asked for: only lock when *truly* idle, meaning no
//! mouse or keyboard use AND nothing playing. The UI reports two kinds of
//! activity: `Input` (mouse/keyboard) and `Playing` (sent regularly while a
//! slideshow, video or multi-screen session is running).

use std::time::{Duration, Instant, SystemTime};

use crate::config::LockSettings;

/// A "playing" heartbeat keeps the app awake for this long. The UI sends one
/// every 10 seconds while anything plays.
pub const PLAYING_GRACE: Duration = Duration::from_secs(30);

/// If the wall clock jumps forward by more than this between two checks that
/// should be ~2 s apart, the PC was asleep.
pub const SLEEP_JUMP: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockReason {
    Idle,
    SafetyNet,
    SystemLocked,
    Sleep,
    Minimized,
    PanicKey,
    Manual,
}

impl LockReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::SafetyNet => "safetyNet",
            Self::SystemLocked => "systemLocked",
            Self::Sleep => "sleep",
            Self::Minimized => "minimized",
            Self::PanicKey => "panicKey",
            Self::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Activity {
    pub last_input: Instant,
    pub last_playing: Option<Instant>,
}

impl Activity {
    pub fn new(now: Instant) -> Self {
        Self {
            last_input: now,
            last_playing: None,
        }
    }

    pub fn input(&mut self, now: Instant) {
        self.last_input = now;
    }

    pub fn playing(&mut self, now: Instant) {
        self.last_playing = Some(now);
    }

    /// Is something playing right now (heartbeat seen recently)?
    pub fn is_playing(&self, now: Instant) -> bool {
        self.last_playing
            .is_some_and(|t| now.saturating_duration_since(t) <= PLAYING_GRACE)
    }

    /// Should we lock because of inactivity? Checks idle and the safety net.
    pub fn check(&self, now: Instant, s: &LockSettings) -> Option<LockReason> {
        let since_input = now.saturating_duration_since(self.last_input);
        if s.safety_net_minutes > 0 && since_input >= minutes(s.safety_net_minutes) {
            return Some(LockReason::SafetyNet);
        }
        if s.idle_minutes > 0 && !self.is_playing(now) {
            // Idle time counts from whichever happened last: input, or the end
            // of playback.
            let last = match self.last_playing {
                Some(p) if p > self.last_input => p,
                _ => self.last_input,
            };
            if now.saturating_duration_since(last) >= minutes(s.idle_minutes) {
                return Some(LockReason::Idle);
            }
        }
        None
    }
}

fn minutes(m: u32) -> Duration {
    Duration::from_secs(m as u64 * 60)
}

/// Detects sleep/hibernate: the background check runs every ~2 s, so a large
/// wall-clock gap between runs means the machine was suspended.
pub struct SleepDetector {
    last_wall: SystemTime,
}

impl SleepDetector {
    pub fn new(now: SystemTime) -> Self {
        Self { last_wall: now }
    }

    pub fn tick(&mut self, now: SystemTime) -> bool {
        let jumped = now
            .duration_since(self.last_wall)
            .map(|d| d > SLEEP_JUMP)
            .unwrap_or(false);
        self.last_wall = now;
        jumped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(idle: u32, safety: u32) -> LockSettings {
        LockSettings {
            idle_minutes: idle,
            safety_net_minutes: safety,
            ..Default::default()
        }
    }

    #[test]
    fn locks_after_idle_time_with_nothing_playing() {
        let t0 = Instant::now();
        let a = Activity::new(t0);
        let s = settings(15, 0);
        assert_eq!(a.check(t0 + Duration::from_secs(14 * 60), &s), None);
        assert_eq!(
            a.check(t0 + Duration::from_secs(15 * 60), &s),
            Some(LockReason::Idle)
        );
    }

    #[test]
    fn never_locks_while_playing_even_without_input() {
        let t0 = Instant::now();
        let mut a = Activity::new(t0);
        let s = settings(5, 0);
        // A 3-hour slideshow, heartbeat every 10 s, no input at all.
        let mut t = t0;
        for _ in 0..(3 * 60 * 6) {
            t += Duration::from_secs(10);
            a.playing(t);
            assert_eq!(a.check(t + Duration::from_secs(5), &s), None);
        }
    }

    #[test]
    fn idle_clock_starts_when_playback_stops() {
        let t0 = Instant::now();
        let mut a = Activity::new(t0);
        let s = settings(5, 0);
        let stop = t0 + Duration::from_secs(60 * 60);
        a.playing(stop);
        assert_eq!(a.check(stop + Duration::from_secs(4 * 60), &s), None);
        assert_eq!(
            a.check(stop + Duration::from_secs(5 * 60), &s),
            Some(LockReason::Idle)
        );
    }

    #[test]
    fn input_resets_idle() {
        let t0 = Instant::now();
        let mut a = Activity::new(t0);
        let s = settings(5, 0);
        a.input(t0 + Duration::from_secs(4 * 60));
        assert_eq!(a.check(t0 + Duration::from_secs(8 * 60), &s), None);
    }

    #[test]
    fn idle_never_means_never() {
        let t0 = Instant::now();
        let a = Activity::new(t0);
        assert_eq!(
            a.check(t0 + Duration::from_secs(48 * 3600), &settings(0, 0)),
            None
        );
    }

    #[test]
    fn safety_net_locks_during_playback_without_input() {
        let t0 = Instant::now();
        let mut a = Activity::new(t0);
        let s = settings(15, 60);
        let t = t0 + Duration::from_secs(60 * 60);
        a.playing(t);
        assert_eq!(a.check(t, &s), Some(LockReason::SafetyNet));
        a.input(t);
        assert_eq!(a.check(t + Duration::from_secs(1), &s), None);
    }

    #[test]
    fn sleep_detector_spots_clock_jumps() {
        let t0 = SystemTime::now();
        let mut d = SleepDetector::new(t0);
        assert!(!d.tick(t0 + Duration::from_secs(2)));
        assert!(!d.tick(t0 + Duration::from_secs(5)));
        assert!(d.tick(t0 + Duration::from_secs(5 + 3600)));
        assert!(!d.tick(t0 + Duration::from_secs(5 + 3602)));
    }
}
