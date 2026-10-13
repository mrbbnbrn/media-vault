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
    pub vaults: Vec<KnownVault>,
    pub last_vault: Option<String>,
}

pub const DEFAULT_ACCENT: &str = "#2ec4b6";

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            accent: DEFAULT_ACCENT.into(),
            lock: LockSettings::default(),
            fullscreen_controls_on_mouse: true,
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
