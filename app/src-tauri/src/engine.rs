//! The built-in web engine. The full package ships its own copy of
//! Microsoft's WebView2 engine in a `WebView2` folder next to the app, so a
//! Windows update can't change how the app plays things. When that folder is
//! there (and the setting is on) the app uses it; otherwise the engine that
//! comes with Windows.
//!
//! Safety net: a marker file is written before the window starts and removed
//! once the window reports in. If the marker is still there on the next start,
//! the built-in engine is skipped and the window says so.

use std::path::{Path, PathBuf};

use serde::Serialize;

const MARKER: &str = "engine-starting";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// "builtin" (using the shipped engine), "system" (using Windows' own)
    /// or "fallback" (the shipped engine failed last time, so Windows' own).
    pub mode: String,
    /// A shipped engine is present next to the app.
    pub available: bool,
    /// Its version (the folder name it was copied from), if known.
    pub version: Option<String>,
}

pub fn engine_dir() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("WebView2");
    dir.join("msedgewebview2.exe").is_file().then_some(dir)
}

fn version_of(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join("VERSION.txt")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Decide before any window exists. Sets the WebView2 environment variables
/// when the shipped engine is used.
pub fn prepare(config_dir: &Path, enabled: bool) -> EngineInfo {
    let Some(dir) = engine_dir() else {
        return EngineInfo { mode: "system".into(), available: false, version: None };
    };
    let version = version_of(&dir);
    let marker = config_dir.join(MARKER);
    if !enabled {
        return EngineInfo { mode: "system".into(), available: true, version };
    }
    if marker.exists() {
        return EngineInfo { mode: "fallback".into(), available: true, version };
    }
    let _ = std::fs::write(&marker, b"1");
    // SAFETY: called at start-up before any other thread exists.
    unsafe {
        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &dir);
        // A separate profile folder: one engine version's profile may not open in another.
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", config_dir.join("webview-builtin"));
    }
    EngineInfo { mode: "builtin".into(), available: true, version }
}

/// The window is up: the shipped engine works.
pub fn started(config_dir: &Path, info: &EngineInfo) {
    if info.mode == "builtin" {
        let _ = std::fs::remove_file(config_dir.join(MARKER));
    }
}

/// Try the shipped engine again on the next start.
pub fn retry(config_dir: &Path) {
    let _ = std::fs::remove_file(config_dir.join(MARKER));
}
