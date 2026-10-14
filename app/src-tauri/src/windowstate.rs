//! The main window's size, place (and so its monitor) and maximised state,
//! remembered across restarts in `window.json` next to `config.json`. Nothing
//! private: just numbers. It is a separate file so saving the settings from
//! the window never overwrites it with stale values.
//!
//! The window starts hidden (tauri.conf.json), is put back where it was, and
//! only then shown, so it does not jump. If the saved place is no longer on
//! any monitor (a monitor was unplugged, resolution changed) it is centred on
//! the primary monitor instead. Full screen is never saved as the normal size.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, Window, WindowEvent};

const FILE: &str = "window.json";
const MAIN: &str = "main";

/// The normal (not maximised) outer position and inner size, in physical pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// A monitor's usable area (without the taskbar), physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// What the window is doing right now (kept up to date from its events).
#[derive(Default)]
pub struct Tracker(Mutex<Option<Geometry>>);

impl Geometry {
    fn sane(&self) -> bool {
        (200..=30_000).contains(&self.width)
            && (150..=30_000).contains(&self.height)
            && self.x.abs() < 100_000
            && self.y.abs() < 100_000
    }
}

/// Whether the saved place can be used on these monitors: enough of the title
/// bar (the strip you drag the window by) must be on one of them.
pub fn usable(g: &Geometry, monitors: &[Area]) -> bool {
    if !g.sane() {
        return false;
    }
    let (bx0, by0) = (i64::from(g.x), i64::from(g.y));
    let (bx1, by1) = (bx0 + i64::from(g.width), by0 + 32);
    monitors.iter().any(|m| {
        let (mx0, my0) = (i64::from(m.x), i64::from(m.y));
        let (mx1, my1) = (mx0 + i64::from(m.width), my0 + i64::from(m.height));
        let w = bx1.min(mx1) - bx0.max(mx0);
        let h = by1.min(my1) - by0.max(my0);
        // The top edge must not be above this monitor (the title bar would be unreachable).
        w >= 120 && h >= 16 && by0 >= my0 - 8
    })
}

/// Centred on a monitor, no bigger than it.
pub fn centred(width: u32, height: u32, m: &Area) -> (i32, i32, u32, u32) {
    let w = width.min(m.width);
    let h = height.min(m.height);
    let x = m.x + ((m.width - w) / 2) as i32;
    let y = m.y + ((m.height - h) / 2) as i32;
    (x, y, w, h)
}

pub fn load(dir: &Path) -> Option<Geometry> {
    let bytes = fs::read(dir.join(FILE)).ok()?;
    serde_json::from_slice::<Geometry>(&bytes)
        .ok()
        .filter(Geometry::sane)
}

pub fn save(dir: &Path, g: &Geometry) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(g).map_err(std::io::Error::other)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    let mut f = fs::File::create(&tmp)?;
    f.write_all(&json)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, dir.join(FILE))
}

fn area(m: &tauri::Monitor) -> Area {
    let r = m.work_area();
    Area {
        x: r.position.x,
        y: r.position.y,
        width: r.size.width,
        height: r.size.height,
    }
}

/// Put the (still hidden) main window back where it was, then show it.
pub fn restore<R: Runtime>(app: &AppHandle<R>, dir: &Path) {
    app.manage(Tracker::default());
    let Some(w) = app.get_webview_window(MAIN) else {
        return;
    };
    if let Some(g) = load(dir) {
        let monitors: Vec<Area> = w
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(area)
            .collect();
        let place = if usable(&g, &monitors) {
            Some((g.x, g.y, g.width, g.height))
        } else {
            // The saved monitor is gone: the same size, centred on the primary monitor.
            w.primary_monitor()
                .ok()
                .flatten()
                .map(|m| centred(g.width, g.height, &area(&m)))
        };
        if let Some((x, y, width, height)) = place {
            let _ = w.set_size(PhysicalSize::new(width, height));
            let _ = w.set_position(PhysicalPosition::new(x, y));
            *app.state::<Tracker>().0.lock().unwrap() = Some(Geometry {
                x,
                y,
                width,
                height,
                maximized: g.maximized,
            });
        }
        if g.maximized {
            let _ = w.maximize();
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
}

/// Follow the main window's moves and resizes; save when it closes.
pub fn on_event<R: Runtime>(window: &Window<R>, event: &WindowEvent, dir: &Path) {
    if window.label() != MAIN {
        return;
    }
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => observe(window),
        WindowEvent::CloseRequested { .. } => {
            observe(window);
            let g = window
                .try_state::<Tracker>()
                .and_then(|t| *t.0.lock().unwrap());
            if let Some(g) = g {
                let _ = save(dir, &g);
            }
        }
        _ => {}
    }
}

fn observe<R: Runtime>(window: &Window<R>) {
    let Some(tracker) = window.try_state::<Tracker>() else {
        return;
    };
    // Minimised and full screen are not places to come back to.
    if window.is_minimized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
        || !window.is_visible().unwrap_or(false)
    {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let mut cur = tracker.0.lock().unwrap();
    if maximized {
        // Keep the normal size and place for when it is restored.
        if let Some(g) = cur.as_mut() {
            g.maximized = true;
        } else if let Ok(Some(m)) = window.current_monitor() {
            // Never seen at its normal size: restoring later gives the usual size, centred.
            let (x, y, width, height) = centred(1280, 820, &area(&m));
            *cur = Some(Geometry {
                x,
                y,
                width,
                height,
                maximized: true,
            });
        }
        return;
    }
    if let (Ok(p), Ok(s)) = (window.outer_position(), window.inner_size()) {
        let g = Geometry {
            x: p.x,
            y: p.y,
            width: s.width,
            height: s.height,
            maximized: false,
        };
        if g.sane() {
            *cur = Some(g);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN_MON: Area = Area {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    const LEFT_MON: Area = Area {
        x: -2560,
        y: -200,
        width: 2560,
        height: 1400,
    };

    #[test]
    fn usable_only_when_the_title_bar_is_on_a_monitor() {
        let g = |x, y, width, height| Geometry {
            x,
            y,
            width,
            height,
            maximized: false,
        };
        assert!(usable(&g(100, 100, 1280, 820), &[MAIN_MON]));
        assert!(usable(&g(-2000, 0, 1280, 820), &[MAIN_MON, LEFT_MON]));
        // The left monitor was unplugged.
        assert!(!usable(&g(-2000, 0, 1280, 820), &[MAIN_MON]));
        // Mostly off to the right, but a good part of the title bar still shows.
        assert!(usable(&g(1700, 100, 1280, 820), &[MAIN_MON]));
        assert!(!usable(&g(1850, 100, 1280, 820), &[MAIN_MON]));
        // Title bar above the top of the screen, or below the bottom.
        assert!(!usable(&g(100, -100, 1280, 820), &[MAIN_MON]));
        assert!(!usable(&g(100, 1030, 1280, 820), &[MAIN_MON]));
        // Nonsense sizes.
        assert!(!usable(&g(0, 0, 10, 10), &[MAIN_MON]));
        assert!(!usable(&g(0, 0, 1280, 820), &[]));
    }

    #[test]
    fn centres_and_fits_on_the_monitor() {
        assert_eq!(centred(1280, 820, &MAIN_MON), (320, 110, 1280, 820));
        assert_eq!(centred(4000, 3000, &LEFT_MON), (-2560, -200, 2560, 1400));
    }

    #[test]
    fn saves_and_loads() {
        let dir = std::env::temp_dir().join(format!("mv-winstate-{}", std::process::id()));
        let geo = Geometry {
            x: -1900,
            y: 40,
            width: 1500,
            height: 900,
            maximized: true,
        };
        save(&dir, &geo).unwrap();
        assert_eq!(load(&dir), Some(geo));
        fs::write(dir.join(FILE), b"{\"x\":1}").unwrap();
        assert_eq!(load(&dir), None);
        fs::write(
            dir.join(FILE),
            br#"{"x":0,"y":0,"width":5,"height":5,"maximized":false}"#,
        )
        .unwrap();
        assert_eq!(load(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
