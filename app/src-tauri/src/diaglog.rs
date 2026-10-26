//! A small diagnostics log on this PC (`diagnostics.log` next to the settings:
//! the `data` folder next to the app, or %APPDATA%\MediaVault). It holds steps
//! and sizes only — never file names, folder names or anything from inside the
//! vault — and is written straight to disk line by line, so it is still there
//! when the window dies and the app has to be closed. Kept under 256 KB.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
static START: Mutex<Option<Instant>> = Mutex::new(None);
const MAX: u64 = 256 * 1024;

pub fn init(config_dir: &std::path::Path) {
    let path = config_dir.join("diagnostics.log");
    if let Ok(m) = std::fs::metadata(&path)
        && m.len() > MAX
        && let Ok(all) = std::fs::read(&path)
    {
        let keep = &all[all.len() - (MAX as usize / 2)..];
        let from = keep.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
        let _ = std::fs::write(&path, &keep[from..]);
    }
    *PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    *START.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    note(&format!("=== app started · version {} · clock {secs} (seconds since 1970, UTC)", env!("CARGO_PKG_VERSION")));
}

/// One line: seconds since the app started, then the text (one line, at most 1200 characters).
pub fn note(text: &str) {
    let Some(path) = PATH.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
    let t = START.lock().unwrap_or_else(|e| e.into_inner()).map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0);
    let one: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).take(1200).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{t:>10.3}s  {one}");
        let _ = f.sync_data();
    }
}

// ---- commands that waited for the library ---------------------------------------------------

/// Waiting for or running a library query longer than this is noted.
const SLOW: std::time::Duration = std::time::Duration::from_millis(50);
/// At most this many such lines per minute (a busy minute shouldn't fill the log).
const SLOW_PER_MINUTE: u32 = 4;
static SLOW_LINES: Mutex<Option<(Instant, u32)>> = Mutex::new(None);

/// The command a closure belongs to, from its type name
/// ("media_vault_app::library_page::{{closure}}" → "library_page").
pub fn command_name<F>() -> &'static str {
    let full = std::any::type_name::<F>();
    full.split("::").filter(|p| !p.starts_with('{') && !p.is_empty()).last().unwrap_or(full)
}

/// Whether a slow library call should be written down now (and count it).
fn slow_line_allowed(now: Instant) -> bool {
    let mut g = SLOW_LINES.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_mut() {
        Some((since, n)) if now.duration_since(*since) < std::time::Duration::from_secs(60) => {
            *n += 1;
            *n <= SLOW_PER_MINUTE
        }
        _ => {
            *g = Some((now, 1));
            true
        }
    }
}

/// A command waited for the library (held by a save, an import, background
/// work) or ran long: noted when either took over 50 ms (no names from the vault).
pub fn library_time(command: &str, waited: std::time::Duration, ran: std::time::Duration) {
    if (waited >= SLOW || ran >= SLOW) && slow_line_allowed(Instant::now()) {
        note(&format!("library: {command} waited {} ms for the library, then took {} ms", waited.as_millis(), ran.as_millis()));
    }
}

/// The window's steps (the picture editor's saving, the window loading).
#[tauri::command]
pub fn diag_note(text: String) {
    note(&format!("window: {text}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_library_calls_are_named_and_kept_few() {
        let f = |_: i64| 1;
        fn takes<F>(_: &F) -> &'static str {
            command_name::<F>()
        }
        assert_eq!(takes(&f), "slow_library_calls_are_named_and_kept_few");
        assert_eq!(command_name::<fn()>(), "fn()");
        let t = Instant::now() + std::time::Duration::from_secs(3600);
        let allowed = (0..10).filter(|_| slow_line_allowed(t)).count();
        assert_eq!(allowed, SLOW_PER_MINUTE as usize);
        assert!(slow_line_allowed(t + std::time::Duration::from_secs(61)), "a new minute");
    }

    #[test]
    fn writes_one_line_each_and_stays_small() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("diagnostics.log"), vec![b'x'; 300 * 1024]).unwrap();
        init(dir.path());
        note("hello\nworld");
        let text = std::fs::read_to_string(dir.path().join("diagnostics.log")).unwrap();
        assert!(text.len() < 200 * 1024);
        assert!(text.contains("app started"));
        assert!(text.lines().any(|l| l.ends_with("hello world")));
    }
}
