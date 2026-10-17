//! A place to keep one loaded model (an ONNX Runtime session and what goes
//! with it), freed after a while without use.
//!
//! Each kind of model has its own slot: 3D photos (depth.rs), subject
//! outlines (subject.rs) and background fill (inpaint.rs). The slots are
//! separate (their own lock and their own idle timer), so the three models can
//! all stay loaded at the same time (a 3D photo with its subject lifted off
//! and the background behind it filled needs all three), and loading or freeing
//! one never touches another. Within a slot only one model is kept: choosing
//! another model of the same kind frees the old one first (they are big).
//!
//! Freed: after the slot's idle time without use, when the vault locks and when
//! the viewer closes (each module's `unload`).

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub struct ModelSlot<T> {
    model: Mutex<Option<T>>,
    last_use: Mutex<Option<Instant>>,
    idle: Duration,
}

impl<T: Send + 'static> ModelSlot<T> {
    pub const fn new(idle: Duration) -> Self {
        Self { model: Mutex::new(None), last_use: Mutex::new(None), idle }
    }

    /// The slot, to use or fill. Marks it as used now; the first use after it
    /// was freed starts the timer that frees it again once it sits idle.
    pub fn lock(&'static self) -> MutexGuard<'static, Option<T>> {
        let guard = self.model.lock().unwrap_or_else(|e| e.into_inner());
        let mut last = self.last_use.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_none() {
            self.reaper();
        }
        *last = Some(Instant::now());
        guard
    }

    /// Free the model now, unless it is being used this very moment (then the
    /// idle timer frees it later).
    pub fn unload(&self) {
        if let Ok(mut m) = self.model.try_lock() {
            *m = None;
        }
    }

    /// When it was last used (None once freed by the idle timer).
    pub fn last_used(&self) -> Option<Instant> {
        *self.last_use.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A model is in the slot (or the slot is busy).
    pub fn is_loaded(&self) -> bool {
        self.model.try_lock().map(|m| m.is_some()).unwrap_or(true)
    }

    /// Frees the model once it has been idle for the slot's idle time, then stops.
    fn reaper(&'static self) {
        let poll = (self.idle / 6).clamp(Duration::from_millis(10), Duration::from_secs(15));
        std::thread::spawn(move || loop {
            std::thread::sleep(poll);
            let idle = self.last_use.lock().unwrap_or_else(|e| e.into_inner()).is_none_or(|t| t.elapsed() > self.idle);
            if idle {
                if let Ok(mut m) = self.model.try_lock() {
                    *m = None;
                } else {
                    continue; // in use right now: look again later
                }
                *self.last_use.lock().unwrap_or_else(|e| e.into_inner()) = None;
                return;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static DEPTH: ModelSlot<String> = ModelSlot::new(Duration::from_secs(30));
    static SUBJECT: ModelSlot<String> = ModelSlot::new(Duration::from_secs(30));
    static FILL: ModelSlot<String> = ModelSlot::new(Duration::from_millis(60));

    #[test]
    fn slots_keep_their_models_together_and_free_them_on_their_own() {
        // All three loaded at once.
        *DEPTH.lock() = Some("depth".into());
        *SUBJECT.lock() = Some("subject".into());
        *FILL.lock() = Some("fill".into());
        assert!(DEPTH.is_loaded() && SUBJECT.is_loaded() && FILL.is_loaded());
        // Loading another model into one slot leaves the others alone.
        *SUBJECT.lock() = Some("subject best".into());
        assert_eq!(DEPTH.lock().as_deref(), Some("depth"));
        assert_eq!(FILL.lock().as_deref(), Some("fill"));
        // One slot busy doesn't hold up another.
        let busy = DEPTH.lock();
        let other = std::thread::spawn(|| SUBJECT.lock().clone()).join().unwrap();
        assert_eq!(other.as_deref(), Some("subject best"));
        drop(busy);
        // Freeing one frees only that one.
        SUBJECT.unload();
        assert!(!SUBJECT.is_loaded() && DEPTH.is_loaded());
        // Each has its own idle timer: the short one frees its model, the others keep theirs.
        let start = Instant::now();
        while FILL.is_loaded() && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!FILL.is_loaded(), "the idle fill model was freed");
        assert!(DEPTH.is_loaded(), "the depth model wasn't touched");
        // Used again after being freed: loads and is kept again.
        *FILL.lock() = Some("fill again".into());
        assert!(FILL.is_loaded());
        DEPTH.unload();
        FILL.unload();
    }
}
