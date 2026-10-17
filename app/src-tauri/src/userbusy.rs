//! Background work steps aside: the window says when you are using it (moving
//! the mouse, scrolling, pressing keys) and when a video plays. The analysis
//! pass and other background loops wait between items while you are busy, and
//! take a breather between items while a video plays.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static BUSY: AtomicBool = AtomicBool::new(false);
static VIDEO: AtomicBool = AtomicBool::new(false);

/// Never wait longer than this at a time for the user (the window may have
/// missed saying "calm", e.g. it was closed mid-scroll).
const MAX_WAIT: Duration = Duration::from_secs(20);

pub fn set(busy: bool, video: bool) {
    BUSY.store(busy, Ordering::SeqCst);
    VIDEO.store(video, Ordering::SeqCst);
}

pub fn busy() -> bool {
    BUSY.load(Ordering::SeqCst)
}

/// Between two items of background work: wait while the user is busy (or
/// until `stop`), then a short breather if a video is playing.
pub fn give_way(stop: &dyn Fn() -> bool) {
    let start = Instant::now();
    while BUSY.load(Ordering::SeqCst) && !stop() && start.elapsed() < MAX_WAIT {
        std::thread::sleep(Duration::from_millis(100));
    }
    if VIDEO.load(Ordering::SeqCst) && !stop() {
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The vault locked or closed: nobody is busy any more.
pub fn reset() {
    set(false, false);
}

#[tauri::command]
pub fn set_user_busy(busy: bool, video: bool) {
    set(busy, video);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_while_busy_and_goes_on_when_calm_or_stopped() {
        set(true, false);
        let t = Instant::now();
        let flag = AtomicBool::new(false);
        std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_millis(250));
                set(false, false);
            });
            give_way(&|| flag.load(Ordering::SeqCst));
        });
        assert!(t.elapsed() >= Duration::from_millis(200), "waited for calm");
        assert!(!busy());
        // Stopping ends the wait at once.
        set(true, false);
        let t = Instant::now();
        give_way(&|| true);
        assert!(t.elapsed() < Duration::from_millis(150));
        reset();
    }
}
