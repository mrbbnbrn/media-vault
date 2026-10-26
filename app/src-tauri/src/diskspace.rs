//! Free space on the vault's drive, so a full drive gives one clear message
//! (before an import, before saving) instead of a failure for every file.

use std::path::Path;

/// Free space for this app on the drive holding `path`, in bytes. None when
/// it can't be told (then nothing is refused because of it).
pub fn free_bytes(path: &Path) -> Option<u64> {
    #[cfg(test)]
    if let Some((under, v)) = TEST_FREE.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        && path.starts_with(under)
    {
        return Some(*v);
    }
    platform_free(path)
}

#[cfg(windows)]
fn platform_free(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free: u64 = 0;
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call;
    // the out pointer is a valid u64 and the others may be null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

/// Other systems: not told (no extra library is pulled in just for this).
#[cfg(not(windows))]
fn platform_free(_path: &Path) -> Option<u64> {
    None
}

/// Whether there is room for `need` more bytes (and a little to spare).
pub fn has_room(path: &Path, need: u64, spare: u64) -> bool {
    free_bytes(path).is_none_or(|f| f >= need.saturating_add(spare))
}

/// An error saying the drive is full (Windows: "There is not enough space on
/// the disk", os error 112 or 39; elsewhere os error 28).
pub fn is_full_error(e: &str) -> bool {
    let l = e.to_ascii_lowercase();
    l.contains("os error 112") || l.contains("os error 39") || l.contains("os error 28") || l.contains("not enough space on the disk")
        || l.contains("no space left") || l.contains("storage full") || l.contains("disk full")
}

/// Sizes for messages: "1.2 GB", "350 MB".
pub fn size_text(n: u64) -> String {
    if n >= 1_000_000_000 {
        format!("{:.1} GB", n as f64 / 1e9)
    } else {
        format!("{} MB", n.div_ceil(1_000_000).max(1))
    }
}

#[cfg(test)]
static TEST_FREE: std::sync::Mutex<Option<(std::path::PathBuf, u64)>> = std::sync::Mutex::new(None);

/// Tests: pretend the drive holding `under` has this much free space (None = ask the system).
#[cfg(test)]
pub fn set_test_free(under: &Path, v: Option<u64>) {
    *TEST_FREE.lock().unwrap_or_else(|e| e.into_inner()) = v.map(|v| (under.to_path_buf(), v));
}

/// Tests that pretend a full drive take turns.
#[cfg(test)]
pub static TEST_TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_a_full_drive() {
        assert!(is_full_error("Io error: No space left on device (os error 28)"));
        assert!(is_full_error("There is not enough space on the disk. (os error 112)"));
        assert!(!is_full_error("Access is denied. (os error 5)"));
        assert_eq!(size_text(1_500_000_000), "1.5 GB");
        assert_eq!(size_text(1), "1 MB");
    }
}
