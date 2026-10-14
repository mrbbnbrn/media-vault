//! "Export decrypted": write items back out as ordinary files with their
//! original names (and folders). The copies are NOT encrypted, so the window
//! warns before starting. Files are streamed straight from the vault to the
//! chosen folder; a half-written file is removed if it fails or is cancelled.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use vault_core::export::safe_name;
use vault_core::{ObjectId, ObjectKind};

use crate::session::Session;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    /// These items (written side by side), or…
    #[serde(default)]
    pub ids: Vec<i64>,
    /// …this folder with everything inside it, or…
    #[serde(default)]
    pub folder: Option<i64>,
    /// …the whole library, with its folders.
    #[serde(default)]
    pub all: bool,
    /// Where to put the new export folder.
    pub dest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub done: usize,
    pub total: usize,
    pub bytes: u64,
    pub total_bytes: u64,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDone {
    pub exported: usize,
    pub bytes: u64,
    /// (name, what went wrong)
    pub failed: Vec<(String, String)>,
    pub folder: String,
    pub cancelled: bool,
    pub error: Option<String>,
}

struct Row {
    id: i64,
    object: String,
    name: String,
    folder: Option<i64>,
    size: u64,
}

/// "photo.jpg" -> "photo (2).jpg" until the name is free.
fn unique_path(dir: &Path, name: &str, taken: &mut HashSet<String>) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let candidate = if n == 1 { name.to_string() } else { format!("{stem} ({n}){ext}") };
        let p = dir.join(&candidate);
        let key = p.to_string_lossy().to_lowercase();
        if !taken.contains(&key) && !p.exists() {
            taken.insert(key);
            return p;
        }
        n += 1;
    }
}

fn plan(s: &Session, req: &ExportRequest) -> Result<(String, Vec<(Row, PathBuf)>), String> {
    let db = s.db();
    let e = |x: rusqlite::Error| x.to_string();
    let folders: HashMap<i64, (Option<i64>, String)> = db
        .prepare("SELECT id, parent_id, name FROM folders")
        .map_err(e)?
        .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let rows: Vec<Row> = db
        .prepare("SELECT id, object_id, original_name, folder_id, size FROM media WHERE deleted_at IS NULL ORDER BY folder_id, original_name")
        .map_err(e)?
        .query_map([], |r| {
            Ok(Row { id: r.get(0)?, object: r.get(1)?, name: r.get(2)?, folder: r.get(3)?, size: r.get::<_, i64>(4)?.max(0) as u64 })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    drop(db);

    // Folder chain from the top, as ids.
    let chain = |mut f: Option<i64>| -> Vec<i64> {
        let mut out = Vec::new();
        while let Some(id) = f {
            if out.len() > 256 {
                break;
            }
            out.push(id);
            f = folders.get(&id).and_then(|x| x.0);
        }
        out.reverse();
        out
    };
    let name_of = |id: i64| folders.get(&id).map(|x| x.1.clone()).unwrap_or_default();
    let today = chrono_like_today();

    let (title, picked): (String, Vec<(Row, PathBuf)>) = if req.all {
        let v = rows
            .into_iter()
            .map(|r| {
                let rel: PathBuf = chain(r.folder).into_iter().map(|f| safe_name(&name_of(f))).collect();
                (r, rel)
            })
            .collect();
        (format!("Media Vault export {today}"), v)
    } else if let Some(base) = req.folder {
        let v = rows
            .into_iter()
            .filter_map(|r| {
                let c = chain(r.folder);
                let at = c.iter().position(|f| *f == base)?;
                let rel: PathBuf = c[at + 1..].iter().map(|f| safe_name(&name_of(*f))).collect();
                Some((r, rel))
            })
            .collect();
        (name_of(base), v)
    } else {
        let want: HashSet<i64> = req.ids.iter().copied().collect();
        let v = rows.into_iter().filter(|r| want.contains(&r.id)).map(|r| (r, PathBuf::new())).collect();
        (format!("Media Vault export {today}"), v)
    };
    Ok((title, picked))
}

/// Today's date as YYYY-MM-DD (UTC is fine for a folder name).
pub(crate) fn chrono_like_today() -> String {
    let days = crate::library::now_secs().div_euclid(86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn run(s: &Session, req: &ExportRequest, cancel: &AtomicBool, progress: &mut dyn FnMut(&ExportProgress)) -> ExportDone {
    let mut done = ExportDone::default();
    let (title, items) = match plan(s, req) {
        Ok(p) => p,
        Err(e) => {
            done.error = Some(e);
            return done;
        }
    };
    if items.is_empty() {
        done.error = Some("There is nothing to export.".into());
        return done;
    }
    let dest = Path::new(&req.dest);
    if !dest.is_dir() {
        done.error = Some(format!("{} isn't a folder that can be written to.", dest.display()));
        return done;
    }
    let mut taken = HashSet::new();
    let root = unique_path(dest, &safe_name(&title), &mut taken);
    if let Err(e) = fs::create_dir_all(&root) {
        done.error = Some(format!("Couldn't create {}: {e}", root.display()));
        return done;
    }
    done.folder = root.display().to_string();
    let total = items.len();
    let total_bytes: u64 = items.iter().map(|(r, _)| r.size).sum();
    let mut buf = vec![0u8; 1 << 20];
    for (i, (row, rel)) in items.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) || s.is_closed() {
            done.cancelled = true;
            break;
        }
        let res = (|| -> Result<u64, String> {
            let dir = root.join(rel);
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let target = unique_path(&dir, &safe_name(&row.name), &mut taken);
            let oid = ObjectId::from_hex(&row.object).map_err(|e| e.to_string())?;
            let mut reader = s.vault().open_object(ObjectKind::Media, &oid).map_err(|e| e.to_string())?;
            let mut out = OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
            let mut n = 0u64;
            let r = (|| -> Result<(), String> {
                loop {
                    if cancel.load(Ordering::SeqCst) || s.is_closed() {
                        return Err("cancelled".into());
                    }
                    let k = reader.read(&mut buf).map_err(|_| "its encrypted data is damaged".to_string())?;
                    if k == 0 {
                        break;
                    }
                    out.write_all(&buf[..k]).map_err(|e| e.to_string())?;
                    n += k as u64;
                }
                out.sync_all().map_err(|e| e.to_string())
            })();
            if let Err(e) = r {
                drop(out);
                let _ = fs::remove_file(&target);
                return Err(e);
            }
            Ok(n)
        })();
        match res {
            Ok(n) => {
                done.exported += 1;
                done.bytes += n;
            }
            Err(e) if e == "cancelled" => {
                done.cancelled = true;
                break;
            }
            Err(e) => done.failed.push((row.name.clone(), e)),
        }
        progress(&ExportProgress { done: i + 1, total, bytes: done.bytes, total_bytes, name: row.name.clone() });
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{import, library, session};

    #[test]
    fn exports_selection_folder_and_everything() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        let src = t.path().join("src");
        std::fs::create_dir_all(src.join("Alex/Beach")).unwrap();
        std::fs::write(src.join("Alex/a.jpg"), vec![1u8; 3000]).unwrap();
        std::fs::write(src.join("Alex/Beach/b.jpg"), vec![2u8; 3000]).unwrap();
        std::fs::write(src.join("c.jpg"), vec![3u8; 3000]).unwrap();
        import::run(
            &s,
            &import::Job { id: 1, paths: vec![src.join("Alex").display().to_string(), src.join("c.jpg").display().to_string()], target: None, password: None, archive_folder: true },
            &AtomicBool::new(false),
            &mut |_| {},
        );
        let out = t.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let go = |req: ExportRequest| run(&s, &req, &AtomicBool::new(false), &mut |_| {});

        let all = go(ExportRequest { ids: vec![], folder: None, all: true, dest: out.display().to_string() });
        assert_eq!(all.exported, 3, "{:?}", all);
        let root = PathBuf::from(&all.folder);
        assert_eq!(std::fs::read(root.join("Alex/Beach/b.jpg")).unwrap(), vec![2u8; 3000]);
        assert!(root.join("c.jpg").exists());

        let alex = library::find_child(&s.db(), None, "Alex").unwrap().unwrap();
        let f = go(ExportRequest { ids: vec![], folder: Some(alex), all: false, dest: out.display().to_string() });
        assert_eq!(f.exported, 2);
        assert!(PathBuf::from(&f.folder).ends_with("Alex"));
        assert!(PathBuf::from(&f.folder).join("Beach/b.jpg").exists());

        let id: i64 = s.db().query_row("SELECT id FROM media WHERE original_name = 'b.jpg'", [], |r| r.get(0)).unwrap();
        let one = go(ExportRequest { ids: vec![id], folder: None, all: false, dest: out.display().to_string() });
        assert_eq!(one.exported, 1);
        assert!(PathBuf::from(&one.folder).join("b.jpg").exists());
        assert_ne!(one.folder, all.folder, "a new folder each time");
        assert_eq!(chrono_like_today().len(), 10);
    }
}
