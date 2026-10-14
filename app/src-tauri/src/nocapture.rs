//! Hide the app's windows from screenshots, screen recording and screen
//! sharing. On Windows this is `SetWindowDisplayAffinity`: capture tools
//! (Snipping Tool, OBS, Discord, Zoom, Teams…) get a black window instead.
//! Elsewhere it does nothing.
//!
//! [`apply`] works on any window, so windows created later get it too: the
//! page-load hook in lib.rs calls it for every webview's window.

use tauri::{AppHandle, Manager, Runtime, Window};

use crate::Shared;

/// Whether the setting is on right now.
pub fn enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Shared>()
        .map(|s| s.config.lock().unwrap().block_capture)
        .unwrap_or(true)
}

/// Apply (or lift) the protection on one window.
pub fn apply<R: Runtime>(window: &Window<R>, on: bool) {
    #[cfg(windows)]
    {
        if let Ok(hwnd) = window.hwnd() {
            win::set(hwnd.0, on);
        }
    }
    #[cfg(not(windows))]
    let _ = (window, on);
}

/// Apply (or lift) the protection on every open window.
pub fn apply_all<R: Runtime>(app: &AppHandle<R>, on: bool) {
    for w in app.webview_windows().values() {
        apply(&w.as_ref().window(), on);
    }
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR, WDA_NONE,
    };

    pub fn set(hwnd: *mut core::ffi::c_void, on: bool) {
        // SAFETY: plain Win32 call on a window handle owned by this process;
        // a stale handle only makes the call fail.
        unsafe {
            if !on {
                SetWindowDisplayAffinity(hwnd, WDA_NONE);
                return;
            }
            // Windows 10 2004 and later: the window is left out of captures.
            if SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) == 0 {
                // Older Windows: the window is captured as a black rectangle.
                SetWindowDisplayAffinity(hwnd, WDA_MONITOR);
            }
        }
    }
}
