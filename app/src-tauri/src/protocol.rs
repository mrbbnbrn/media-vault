//! Streams media to the window without ever writing decrypted data to disk.
//!
//! `vault://localhost/media/<id>` and `/thumb/<id>` decrypt on the fly from
//! the open vault, one 1 MiB chunk at a time, with HTTP Range support so
//! videos can seek. `local://localhost/f/<hex path>` plays ordinary files the
//! user dropped onto a player (outside any vault), only from folders they
//! dropped.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::http::{Request, Response, StatusCode, header};
use vault_core::{ObjectId, ObjectKind};

use crate::import::{ext_of, is_animated_webp, kind_by_ext};
use crate::session::Session;

/// Largest piece sent for an open-ended range request.
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

pub fn mime_for(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn plain(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

/// Parse "bytes=START-END" (END optional) against a known length.
pub fn parse_range(h: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let spec = h?.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    if len == 0 {
        return None;
    }
    if a.is_empty() {
        // Suffix range: the last N bytes.
        let n: u64 = b.parse().ok()?;
        let n = n.min(len);
        return Some((len - n, len - 1));
    }
    let start: u64 = a.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if b.is_empty() {
        (start + MAX_CHUNK - 1).min(len - 1)
    } else {
        b.parse::<u64>().ok()?.min(len - 1)
    };
    (end >= start).then_some((start, end))
}

/// Serve `len` bytes from a seekable reader, honouring Range.
fn respond<R: Read + Seek>(
    mut r: R,
    len: u64,
    mime: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    let base = |b: tauri::http::response::Builder| {
        b.header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            // Never let the web engine keep a copy on disk.
            .header(header::CACHE_CONTROL, "no-store")
    };
    match (range.is_some(), parse_range(range, len)) {
        (true, None) => base(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())
            .unwrap(),
        (true, Some((start, end))) => {
            let mut buf = vec![0u8; (end - start + 1) as usize];
            if r.seek(SeekFrom::Start(start))
                .and_then(|_| r.read_exact(&mut buf))
                .is_err()
            {
                return plain(StatusCode::INTERNAL_SERVER_ERROR, "This file is damaged.");
            }
            base(Response::builder().status(StatusCode::PARTIAL_CONTENT))
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, buf.len())
                .body(buf)
                .unwrap()
        }
        (false, _) => {
            let mut buf = Vec::with_capacity(len as usize);
            if r.read_to_end(&mut buf).is_err() {
                return plain(StatusCode::INTERNAL_SERVER_ERROR, "This file is damaged.");
            }
            base(Response::builder().status(StatusCode::OK))
                .header(header::CONTENT_LENGTH, buf.len())
                .body(buf)
                .unwrap()
        }
    }
}

fn header_str(req: &Request<Vec<u8>>, name: header::HeaderName) -> Option<&str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

pub fn serve_vault(session: Option<&Session>, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let r = serve_vault_inner(session, req);
    if std::env::var_os("MV_DEBUG").is_some() {
        eprintln!(
            "vault {} range={:?} -> {} {:?} len={}",
            req.uri(),
            header_str(req, header::RANGE),
            r.status(),
            r.headers().get(header::CONTENT_RANGE),
            r.body().len()
        );
    }
    r
}

fn serve_vault_inner(session: Option<&Session>, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(s) = session.filter(|s| !s.is_closed()) else {
        return plain(StatusCode::FORBIDDEN, "The vault is locked.");
    };
    let path = req.uri().path().trim_start_matches('/');
    let (what, id) = match path.split_once('/') {
        Some((w, id)) => (w, id.trim_end_matches('/').parse::<i64>().ok()),
        None => return plain(StatusCode::NOT_FOUND, "Not found."),
    };
    let Some(id) = id else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    let row: Option<(String, Option<String>, String)> = s
        .db()
        .query_row(
            "SELECT object_id, thumb_object_id, ext FROM media WHERE id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let Some((obj, thumb, ext)) = row else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    let (kind, hex, mime) = match what {
        "media" => (ObjectKind::Media, obj, mime_for(&ext)),
        "thumb" => match thumb.filter(|t| !t.is_empty()) {
            Some(t) => (ObjectKind::Thumbnail, t, "image/jpeg"),
            None => return plain(StatusCode::NOT_FOUND, "No thumbnail yet."),
        },
        _ => return plain(StatusCode::NOT_FOUND, "Not found."),
    };
    let Ok(oid) = ObjectId::from_hex(&hex) else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    // Opening only needs the key briefly; reading happens without holding locks.
    let reader = s.vault().open_object(kind, &oid);
    match reader {
        Ok(r) => {
            let len = r.len();
            respond(r, len, mime, header_str(req, header::RANGE))
        }
        Err(e) => plain(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ---- playing ordinary files outside the vault ------------------------------------------

/// Folders (and single files) the user dropped onto a player this session.
#[derive(Default)]
pub struct LocalAccess {
    roots: Mutex<HashSet<PathBuf>>,
}

impl LocalAccess {
    pub fn grant(&self, p: &Path) {
        if let Ok(c) = p.canonicalize() {
            self.roots.lock().unwrap().insert(c);
        }
    }

    pub fn allowed(&self, p: &Path) -> Option<PathBuf> {
        let c = p.canonicalize().ok()?;
        let roots = self.roots.lock().unwrap();
        roots
            .iter()
            .any(|r| c == *r || c.starts_with(r))
            .then_some(c)
    }
}

pub fn serve_local(access: &LocalAccess, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = req.uri().path().trim_start_matches('/');
    let Some(hexpath) = path.strip_prefix("f/") else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    let Some(p) = hex::decode(hexpath.trim_end_matches('/'))
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
    else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    let Some(real) = access.allowed(Path::new(&p)) else {
        return plain(
            StatusCode::FORBIDDEN,
            "Drop the file or folder onto a player first.",
        );
    };
    if kind_by_ext(&p).is_none() {
        return plain(StatusCode::FORBIDDEN, "Not a supported media file.");
    }
    match File::open(&real) {
        Ok(f) => {
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            respond(
                f,
                len,
                mime_for(&ext_of(&p)),
                header_str(req, header::RANGE),
            )
        }
        Err(e) => plain(StatusCode::NOT_FOUND, &e.to_string()),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalItem {
    /// Hex-encoded full path; the media URL is local://localhost/f/<key>.
    pub key: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSet {
    pub title: String,
    pub items: Vec<LocalItem>,
    /// Index of the file that was dropped, so playback starts there.
    pub start: usize,
}

fn local_item(p: &Path) -> Option<LocalItem> {
    let name = p.file_name()?.to_string_lossy().into_owned();
    let mut kind = kind_by_ext(&name)?.to_string();
    let meta = p.metadata().ok()?;
    if ext_of(&name) == "webp" {
        let mut head = [0u8; 32];
        if File::open(p).and_then(|mut f| f.read(&mut head)).is_ok() && is_animated_webp(&head) {
            kind = "gif".into();
        }
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let path = p.display().to_string();
    Some(LocalItem {
        key: hex::encode(path.as_bytes()),
        name,
        path,
        kind,
        size: meta.len(),
        modified,
    })
}

fn media_in(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() && recursive => stack.push(p),
                Ok(t) if t.is_file() && kind_by_ext(&p.to_string_lossy()).is_some() => out.push(p),
                _ => {}
            }
        }
    }
    out.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    out
}

/// What to play for a drop: a dropped file brings its whole folder (starting
/// at that file); a dropped folder brings everything inside it.
pub fn scan_local(access: &LocalAccess, paths: &[String]) -> Result<LocalSet, String> {
    let mut items: Vec<LocalItem> = Vec::new();
    let mut start_path: Option<String> = None;
    let mut titles = Vec::new();
    let mut seen = HashSet::new();
    for p in paths {
        let path = PathBuf::from(p);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.clone());
        let list = if path.is_dir() {
            access.grant(&path);
            titles.push(name);
            media_in(&path, true)
        } else if path.is_file() && kind_by_ext(p).is_some() {
            let parent = path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));
            access.grant(&parent);
            titles.push(
                parent
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(name),
            );
            if start_path.is_none() {
                start_path = Some(path.display().to_string());
            }
            media_in(&parent, false)
        } else {
            continue;
        };
        for f in list {
            if seen.insert(f.clone())
                && let Some(i) = local_item(&f)
            {
                items.push(i);
            }
        }
    }
    if items.is_empty() {
        return Err(
            "No playable media there (supported: mp4, m4v, webm, gif, webp, png, jpg).".into(),
        );
    }
    let start = start_path
        .and_then(|sp| items.iter().position(|i| i.path == sp))
        .unwrap_or(0);
    titles.dedup();
    Ok(LocalSet {
        title: titles.join(", "),
        items,
        start,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), Some((0, 99)));
        assert_eq!(parse_range(Some("bytes=900-"), 1000), Some((900, 999)));
        assert_eq!(parse_range(Some("bytes=-100"), 1000), Some((900, 999)));
        assert_eq!(parse_range(Some("bytes=0-5000"), 1000), Some((0, 999)));
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), None);
        assert_eq!(
            parse_range(Some("bytes=0-"), 100 * 1024 * 1024),
            Some((0, MAX_CHUNK - 1))
        );
        assert_eq!(parse_range(Some("items=0-1"), 1000), None);
    }

    #[test]
    fn range_responses() {
        let data: Vec<u8> = (0..=255u8).collect();
        let r = respond(
            std::io::Cursor::new(data.clone()),
            256,
            "video/mp4",
            Some("bytes=10-19"),
        );
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body(), &data[10..20]);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 10-19/256");
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
        let full = respond(std::io::Cursor::new(data.clone()), 256, "image/png", None);
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body().len(), 256);
        let bad = respond(
            std::io::Cursor::new(data),
            256,
            "image/png",
            Some("bytes=999-"),
        );
        assert_eq!(bad.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[test]
    fn local_files_need_a_drop_first() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("clips");
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("b.mp4"), b"bb").unwrap();
        std::fs::write(d.join("a.jpg"), b"aa").unwrap();
        std::fs::write(d.join("sub/c.gif"), b"cc").unwrap();
        std::fs::write(d.join("x.txt"), b"x").unwrap();
        let access = LocalAccess::default();
        let other = t.path().join("secret.jpg");
        std::fs::write(&other, b"s").unwrap();

        // Dropping one file plays its folder, starting at that file.
        let set = scan_local(&access, &[d.join("b.mp4").display().to_string()]).unwrap();
        assert_eq!(
            set.items
                .iter()
                .map(|i| i.name.as_str())
                .collect::<Vec<_>>(),
            vec!["a.jpg", "b.mp4"]
        );
        assert_eq!(set.start, 1);
        // Dropping the folder includes subfolders.
        let set = scan_local(&access, &[d.display().to_string()]).unwrap();
        assert_eq!(set.items.len(), 3);

        let get = |p: &Path| {
            let uri = format!(
                "local://localhost/f/{}",
                hex::encode(p.display().to_string())
            );
            serve_local(
                &access,
                &Request::builder().uri(uri).body(Vec::new()).unwrap(),
            )
            .status()
        };
        assert_eq!(get(&d.join("a.jpg")), StatusCode::OK);
        assert_eq!(
            get(&other),
            StatusCode::FORBIDDEN,
            "files outside dropped folders are refused"
        );
        assert_eq!(get(&d.join("x.txt")), StatusCode::FORBIDDEN);
    }
}
