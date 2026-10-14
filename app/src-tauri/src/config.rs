//! App-level settings, stored as a small JSON file.
//!
//! Lives in `data/config.json` next to MediaVault.exe when that folder is
//! writable (portable mode), otherwise in the user's app-data folder.
//! Holds nothing secret: vault folder paths, accent colour, lock options.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LockSettings {
    /// Lock after this many minutes with no input and nothing playing. 0 = never.
    pub idle_minutes: u32,
    /// Lock when Windows locks or the PC goes to sleep.
    pub on_system_lock: bool,
    /// Lock when the window is minimised.
    pub on_minimize: bool,
    /// Lock after this many minutes without mouse/keyboard input, even while
    /// something is playing. 0 = off.
    pub safety_net_minutes: u32,
}

impl Default for LockSettings {
    fn default() -> Self {
        Self {
            idle_minutes: 15,
            on_system_lock: true,
            on_minimize: false,
            safety_net_minutes: 0,
        }
    }
}

/// How pictures are scaled and how far the arrow keys jump in videos.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewerSettings {
    /// High-quality smoothing when a picture is shrunk to fit the window.
    pub smooth_fit: bool,
    /// Smoothing when zoomed in past 100%; off shows crisp square pixels.
    pub smooth_zoom: bool,
    /// Light sharpening after smoothing.
    pub sharpen: bool,
    /// ←/→ in videos jump this many seconds…
    pub seek_seconds: f64,
    /// …and Shift+←/→ this many.
    pub seek_big_seconds: f64,
    /// Sound: the last mute choice, used by every player (muted by default).
    pub muted: bool,
    /// Starts at 0 (a new key, so an older saved 80% doesn't carry over).
    pub sound_volume: f64,
    /// Items per row in the library grid (0 = automatic from the size slider).
    pub grid_columns: u32,
    /// A soft, blurred colour glow of the picture behind it instead of black.
    pub ambient: bool,
    /// Draw boxes around found faces in the viewer (also switched from the library).
    pub face_boxes: bool,
    /// Slideshow "Line up faces": the main face stays at the same place and size.
    pub align_faces: bool,
}

impl Default for ViewerSettings {
    fn default() -> Self {
        Self {
            smooth_fit: true,
            smooth_zoom: true,
            sharpen: false,
            seek_seconds: 5.0,
            seek_big_seconds: 30.0,
            muted: true,
            sound_volume: 0.0,
            grid_columns: 0,
            ambient: false,
            face_boxes: false,
            align_faces: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[derive(Default)]
pub struct KnownVault {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub accent: String,
    pub lock: LockSettings,
    /// In clean full screen, show controls while the mouse moves.
    pub fullscreen_controls_on_mouse: bool,
    /// Grid previews of videos and GIFs: "all" (everything on screen plays,
    /// muted), "hover" (the one under the mouse plays, muted) or "off".
    pub preview: String,
    /// While previewing, the hovered video/GIF shows uncropped.
    pub whole_on_hover: bool,
    /// Grid shows every item at its true shape (no cropping).
    pub grid_shape: bool,
    pub viewer: ViewerSettings,
    /// Use the web engine shipped next to the app (when there is one).
    pub builtin_engine: bool,
    /// The smart-search switch next to the search box.
    pub smart_search: bool,
    /// Make small preview clips of videos in the background (smooth grids).
    pub make_previews: bool,
    /// Analyse pictures for smart search in the background.
    pub smart_index: bool,
    /// Hide the app's windows from screenshots, screen recording and screen
    /// sharing (on Windows they show up black).
    pub block_capture: bool,
    /// How the library looks: sidebar, tiles, interface size, top bar.
    pub look: LookSettings,
    pub vaults: Vec<KnownVault>,
    pub last_vault: Option<String>,
}

pub const DEFAULT_ACCENT: &str = "#2ec4b6";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LookSettings {
    /// The sidebar shows only icons and folder pictures.
    pub sidebar_rail: bool,
    /// Name, size and length show on the hovered tile.
    pub hover_info: bool,
    /// Square tiles are cropped around faces.
    pub face_crop: bool,
    /// Interface size (1 = normal).
    pub ui_scale: f64,
    /// "default", "oled", "graphite" or "midnight".
    pub style: String,
    /// Space between tiles (px) and corner roundness (px).
    pub tile_gap: u32,
    pub tile_radius: u32,
    /// Top-bar buttons in your order; hidden ones are left out. Empty = the default bar.
    pub top_bar: Vec<String>,
    /// The thumbnail minimap beside the grid's scrollbar (long grids only).
    pub minimap: bool,
}

impl Default for LookSettings {
    fn default() -> Self {
        Self {
            sidebar_rail: false,
            hover_info: true,
            face_crop: false,
            ui_scale: 1.0,
            style: "default".into(),
            tile_gap: 10,
            tile_radius: 8,
            top_bar: Vec::new(),
            minimap: true,
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            accent: DEFAULT_ACCENT.into(),
            lock: LockSettings::default(),
            fullscreen_controls_on_mouse: true,
            preview: "hover".into(),
            whole_on_hover: false,
            grid_shape: false,
            viewer: ViewerSettings::default(),
            builtin_engine: true,
            smart_search: false,
            make_previews: true,
            smart_index: true,
            block_capture: true,
            look: LookSettings::default(),
            vaults: Vec::new(),
            last_vault: None,
        }
    }
}

impl AppConfig {
    /// Fix anything out of range instead of refusing to start.
    pub fn sanitized(mut self) -> Self {
        if !is_hex_color(&self.accent) {
            self.accent = DEFAULT_ACCENT.into();
        }
        self.accent = self.accent.to_ascii_lowercase();
        if !["all", "hover", "off"].contains(&self.preview.as_str()) {
            self.preview = "hover".into();
        }
        let l = &mut self.look;
        l.ui_scale = if l.ui_scale.is_finite() { (l.ui_scale * 20.0).round().clamp(10.0, 40.0) / 20.0 } else { 1.0 };
        if !["default", "oled", "graphite", "midnight"].contains(&l.style.as_str()) {
            l.style = "default".into();
        }
        l.tile_gap = l.tile_gap.min(40);
        l.tile_radius = l.tile_radius.min(24);
        l.top_bar.truncate(40);
        let v = &mut self.viewer;
        let clamp =
            |x: f64, lo: f64, hi: f64, d: f64| if x.is_finite() { x.clamp(lo, hi) } else { d };
        v.seek_seconds = clamp(v.seek_seconds, 1.0, 600.0, 5.0);
        v.seek_big_seconds = clamp(v.seek_big_seconds, 1.0, 3600.0, 30.0);
        v.sound_volume = clamp(v.sound_volume, 0.0, 1.0, 0.0);
        v.grid_columns = v.grid_columns.min(16);
        self.lock.idle_minutes = self.lock.idle_minutes.min(24 * 60);
        self.lock.safety_net_minutes = self.lock.safety_net_minutes.min(24 * 60);
        let mut seen = std::collections::HashSet::new();
        self.vaults
            .retain(|v| !v.path.trim().is_empty() && seen.insert(v.path.to_lowercase()));
        self
    }

    pub fn add_vault(&mut self, path: &str) {
        if !self
            .vaults
            .iter()
            .any(|v| v.path.eq_ignore_ascii_case(path))
        {
            self.vaults.push(KnownVault {
                path: path.to_string(),
            });
        }
    }

    pub fn forget_vault(&mut self, path: &str) {
        self.vaults.retain(|v| !v.path.eq_ignore_ascii_case(path));
        if self
            .last_vault
            .as_deref()
            .is_some_and(|p| p.eq_ignore_ascii_case(path))
        {
            self.last_vault = None;
        }
    }
}

pub fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Where config.json lives.
pub fn config_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let portable = dir.join("data");
        if fs::create_dir_all(&portable).is_ok() && is_writable(&portable) {
            return portable;
        }
    }
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("MediaVault");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".write-test");
    let ok = fs::write(&probe, b"x").is_ok();
    let _ = fs::remove_file(probe);
    ok
}

pub fn load(dir: &Path) -> AppConfig {
    let main = dir.join("config.json");
    let bak = dir.join("config.json.bak");
    for p in [&main, &bak] {
        if let Ok(bytes) = fs::read(p)
            && let Ok(cfg) = serde_json::from_slice::<AppConfig>(&bytes)
        {
            return cfg.sanitized();
        }
    }
    AppConfig::default()
}

pub fn save(dir: &Path, cfg: &AppConfig) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(cfg).map_err(std::io::Error::other)?;
    for name in ["config.json", "config.json.bak"] {
        let path = dir.join(name);
        let tmp = dir.join(format!("{name}.tmp"));
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, &path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_teal_and_idle_15() {
        let c = AppConfig::default();
        assert_eq!(c.accent, "#2ec4b6");
        assert_eq!(c.lock.idle_minutes, 15);
        assert!(c.lock.on_system_lock);
        assert!(!c.lock.on_minimize);
        assert_eq!(c.lock.safety_net_minutes, 0);
        assert!(c.fullscreen_controls_on_mouse);
        assert!(c.block_capture);
    }

    #[test]
    fn block_capture_is_on_for_older_config_files() {
        let c: AppConfig = serde_json::from_str(r##"{"accent":"#2ec4b6"}"##).unwrap();
        assert!(c.block_capture);
        let c: AppConfig = serde_json::from_str(r#"{"blockCapture":false}"#).unwrap();
        assert!(!c.block_capture);
    }

    #[test]
    fn save_load_round_trip_and_corrupt_file_falls_back() {
        let t = tempfile::tempdir().unwrap();
        let mut c = AppConfig {
            accent: "#A78BFA".into(),
            ..Default::default()
        };
        c.add_vault("D:\\Vaults\\Photos");
        c.add_vault("d:\\vaults\\photos"); // same path, different case
        save(t.path(), &c.clone().sanitized()).unwrap();
        let l = load(t.path());
        assert_eq!(l.accent, "#a78bfa");
        assert_eq!(l.vaults.len(), 1);

        fs::write(t.path().join("config.json"), b"{ broken").unwrap();
        assert_eq!(load(t.path()).accent, "#a78bfa"); // from .bak

        fs::write(t.path().join("config.json.bak"), b"also broken").unwrap();
        assert_eq!(load(t.path()), AppConfig::default());
    }

    #[test]
    fn unknown_or_missing_fields_are_tolerated() {
        let c: AppConfig =
            serde_json::from_str(r#"{"accent":"nope","futureSetting":1,"lock":{"idleMinutes":5}}"#)
                .unwrap();
        let c = c.sanitized();
        assert_eq!(c.accent, DEFAULT_ACCENT);
        assert_eq!(c.lock.idle_minutes, 5);
        assert!(c.lock.on_system_lock);
    }

    #[test]
    fn forget_vault_clears_last_vault() {
        let mut c = AppConfig::default();
        c.add_vault("E:\\A");
        c.last_vault = Some("E:\\A".into());
        c.forget_vault("e:\\a");
        assert!(c.vaults.is_empty());
        assert!(c.last_vault.is_none());
    }
}
