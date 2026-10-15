//! Progress events at most about ten times a second: more only makes the
//! window busier, not the bar smoother. The last one of a run always goes out.

use std::time::{Duration, Instant};

pub const GAP: Duration = Duration::from_millis(100);

pub struct Throttle {
    last: Option<Instant>,
    gap: Duration,
}

impl Default for Throttle {
    fn default() -> Self {
        Self::new()
    }
}

impl Throttle {
    pub fn new() -> Self {
        Throttle { last: None, gap: GAP }
    }

    #[cfg(test)]
    pub fn with_gap(gap: Duration) -> Self {
        Throttle { last: None, gap }
    }

    /// Whether to send this one now (`last`: the final one, always sent).
    pub fn ready(&mut self, last: bool) -> bool {
        let now = Instant::now();
        if last || self.last.is_none_or(|t| now.duration_since(t) >= self.gap) {
            self.last = Some(now);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_and_last_always_and_otherwise_spaced() {
        let mut t = Throttle::with_gap(Duration::from_millis(40));
        assert!(t.ready(false), "the first one");
        assert!(!t.ready(false));
        assert!(t.ready(true), "the last one");
        std::thread::sleep(Duration::from_millis(45));
        assert!(t.ready(false));
        // Many calls in a short time: about one per gap.
        let mut t = Throttle::with_gap(Duration::from_millis(10));
        let start = Instant::now();
        let mut sent = 0;
        while start.elapsed() < Duration::from_millis(105) {
            sent += t.ready(false) as usize;
        }
        // (Fewer when the test machine is busy; never more.)
        assert!((1..=12).contains(&sent), "{sent}");
    }
}
