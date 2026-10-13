//! Built-in self-test, used by the Windows build check on GitHub.
//!
//! `MV_SELFTEST=1 MediaVault.exe` creates a throwaway vault with a few real
//! media files, and the window then checks — with the real web engine —
//! that pictures, GIFs and videos decode, seek and play from the encrypted
//! vault and from ordinary files, and that thumbnails can be made. The
//! result goes to `MV_SELFTEST_OUT` (or stdout) and the exit code (0 = pass).

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use serde::Serialize;

use crate::import;
use crate::library;
use crate::protocol::{self, LocalAccess, LocalItem};
use crate::session::{self, Session};

const FIXTURES: &[(&str, &[u8])] = &[
    ("clip.mp4", include_bytes!("../selftest/clip.mp4")),
    ("clip.webm", include_bytes!("../selftest/clip.webm")),
    ("picture.jpg", include_bytes!("../selftest/picture.jpg")),
    ("anim.gif", include_bytes!("../selftest/anim.gif")),
    ("notes.txt", include_bytes!("../selftest/notes.txt")),
    ("doc.pdf", include_bytes!("../selftest/doc.pdf")),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfItem {
    pub id: i64,
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfTestInfo {
    pub items: Vec<SelfItem>,
    pub local: Vec<LocalItem>,
    /// An empty folder to export into.
    pub export_dir: String,
    /// The build check copied a web engine next to the app: it must be used.
    pub expect_builtin_engine: bool,
}

pub fn enabled() -> bool {
    std::env::var_os("MV_SELFTEST").is_some()
}

pub fn work_dir() -> PathBuf {
    std::env::temp_dir().join(format!("mediavault-selftest-{}", std::process::id()))
}

/// Make the throwaway vault and return what the window should test.
pub fn prepare(local: &LocalAccess) -> Result<(Session, SelfTestInfo), String> {
    let dir = work_dir();
    let _ = std::fs::remove_dir_all(&dir);
    let src = dir.join("media");
    std::fs::create_dir_all(&src).map_err(|e| e.to_string())?;
    for (name, bytes) in FIXTURES {
        std::fs::write(src.join(name), bytes).map_err(|e| e.to_string())?;
    }
    let (s, _) = session::create(
        dir.to_str().ok_or("bad temp path")?,
        "SelfTest",
        "selftest password",
        vault_core::KdfParams::TEST_ONLY,
    )?;
    let report = import::run(
        &s,
        &import::Job {
            id: 0,
            paths: vec![src.display().to_string()],
            target: None,
            password: None,
            archive_folder: true,
        },
        &AtomicBool::new(false),
        &mut |_| {},
    );
    if report.imported != FIXTURES.len() {
        return Err(format!(
            "self-test import: {} of {} imported ({:?})",
            report.imported,
            FIXTURES.len(),
            report.failed
        ));
    }
    // Extra pictures from the build check (faces, smart search), if any.
    if let Some(extra) = std::env::var_os("MV_SELFTEST_EXTRA") {
        import::run(
            &s,
            &import::Job { id: 1, paths: vec![PathBuf::from(extra).display().to_string()], target: None, password: None, archive_folder: true },
            &AtomicBool::new(false),
            &mut |_| {},
        );
    }
    let export_dir = dir.join("export");
    std::fs::create_dir_all(&export_dir).map_err(|e| e.to_string())?;
    let items = library::query_items(&s.db(), &library::ItemFilter::default())?
        .into_iter()
        .map(|i| SelfItem {
            id: i.id,
            kind: i.kind,
            name: i.name,
        })
        .collect();
    let local = protocol::scan_local(local, &[src.display().to_string()])?.items;
    Ok((
        s,
        SelfTestInfo {
            items,
            local,
            export_dir: export_dir.display().to_string(),
            expect_builtin_engine: std::env::var_os("MV_SELFTEST_ENGINE").is_some(),
        },
    ))
}

pub fn finish(ok: bool, report: &str) -> i32 {
    let text = format!(
        "{}\n{report}\n",
        if ok { "SELFTEST PASS" } else { "SELFTEST FAIL" }
    );
    match std::env::var_os("MV_SELFTEST_OUT") {
        Some(p) => {
            let _ = std::fs::write(p, &text);
        }
        None => println!("{text}"),
    }
    let _ = std::fs::remove_dir_all(work_dir());
    if ok { 0 } else { 1 }
}
