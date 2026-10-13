//! Decrypt a vault back into ordinary files with their original names and
//! folder structure. Used by vault-export.exe and the app's "Export decrypted".

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::db;
use crate::error::{Error, Result};
use crate::stream::{ObjectId, ObjectKind};
use crate::vault::Vault;

#[derive(Debug, Default)]
pub struct ExportReport {
    pub exported: u64,
    pub bytes: u64,
    /// (original name, what went wrong). Export continues past failures so
    /// one damaged file never blocks the rest.
    pub failed: Vec<(String, String)>,
}

pub struct ExportItem {
    pub media_id: i64,
    pub object_id: String,
    pub original_name: String,
    pub folder_id: Option<i64>,
    pub size: u64,
}

/// All media rows, optionally limited to some ids.
pub fn list_items(conn: &Connection, only: Option<&[i64]>) -> Result<Vec<ExportItem>> {
    let mut stmt =
        conn.prepare("SELECT id, object_id, original_name, folder_id, size FROM media ORDER BY folder_id, original_name")?;
    let rows = stmt.query_map([], |r| {
        Ok(ExportItem {
            media_id: r.get(0)?,
            object_id: r.get(1)?,
            original_name: r.get(2)?,
            folder_id: r.get(3)?,
            size: r.get::<_, i64>(4)? as u64,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let item = row?;
        if only.is_none_or(|ids| ids.contains(&item.media_id)) {
            out.push(item);
        }
    }
    Ok(out)
}

const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Make a name safe to use as a Windows file or folder name.
pub fn safe_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    let s = s.trim_start().to_string();
    let mut s = if s.is_empty() { "_".to_string() } else { s };
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        s.insert(0, '_');
    }
    if s.chars().count() > 200 {
        s = s.chars().take(200).collect();
    }
    s
}

/// "photo.jpg" -> "photo (2).jpg" etc. until the name is free.
fn unique_path(dir: &Path, name: &str, taken: &mut HashSet<PathBuf>) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let candidate = if n == 1 {
            name.to_string()
        } else {
            format!("{stem} ({n}){ext}")
        };
        let p = dir.join(&candidate);
        let key = PathBuf::from(p.to_string_lossy().to_lowercase());
        if !taken.contains(&key) && !p.exists() {
            taken.insert(key);
            return p;
        }
        n += 1;
    }
}

/// Export `items` into `out_dir`, recreating the folder tree.
/// `progress` is called after each file with (done, total).
pub fn export_items(
    vault: &Vault,
    conn: &Connection,
    items: &[ExportItem],
    out_dir: &Path,
    mut progress: impl FnMut(usize, usize, &str),
) -> Result<ExportReport> {
    fs::create_dir_all(out_dir)?;
    let folders = db::folder_paths(conn)?;
    let mut taken = HashSet::new();
    let mut report = ExportReport::default();

    for (i, item) in items.iter().enumerate() {
        let result = (|| -> Result<u64> {
            let mut dir = out_dir.to_path_buf();
            if let Some(fid) = item.folder_id {
                let parts = folders
                    .get(&fid)
                    .ok_or_else(|| Error::Corrupt(format!("folder {fid} missing")))?;
                for p in parts {
                    dir.push(safe_name(p));
                }
            }
            fs::create_dir_all(&dir)?;
            let target = unique_path(&dir, &safe_name(&item.original_name), &mut taken);
            let id = ObjectId::from_hex(&item.object_id)?;
            let mut reader = vault.open_object(ObjectKind::Media, &id)?;
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            match io::copy(&mut reader, &mut out) {
                Ok(n) => {
                    out.sync_all()?;
                    Ok(n)
                }
                Err(e) => {
                    drop(out);
                    let _ = fs::remove_file(&target);
                    Err(Error::Corrupt(e.to_string()))
                }
            }
        })();
        match result {
            Ok(n) => {
                report.exported += 1;
                report.bytes += n;
            }
            Err(e) => report
                .failed
                .push((item.original_name.clone(), e.to_string())),
        }
        progress(i + 1, items.len(), &item.original_name);
    }
    Ok(report)
}
