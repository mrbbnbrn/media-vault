//! Streams media to the window without ever writing decrypted data to disk.
//!
//! `vault://localhost/media/<id>`, `/thumb/<id>`, `/preview/<id>` (frame
//! strip) and `/tiny/<id>` (tiny preview clip) decrypt on the fly from
//! the open vault, one 1 MiB chunk at a time, with HTTP Range support so
//! videos can seek. Range answers for media line up with the encryption
//! chunks, and the last few decrypted chunks of recently played files stay
//! in memory (see [`ChunkCache`]), so a seek or the next request never
//! decrypts the same chunk twice. Thumbnails are JPEG or WebP, told apart by
//! their first bytes; `?small=1` asks for the 256 px one, which comes from
//! its folder's thumbnail page (thumbpages.rs: one decryption per page, not
//! per tile). `local://localhost/f/<hex path>` plays ordinary files the
//! user dropped onto a player (outside any vault), only from folders they
//! dropped.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use zeroize::Zeroizing;

use serde::Serialize;
use tauri::http::{Request, Response, StatusCode, header};
use vault_core::{ObjectId, ObjectKind};

use crate::import::{ext_of, is_animated_webp, kind_by_ext};
use crate::session::Session;
use crate::thumbpages::{self, Size};

/// Largest piece sent for an open-ended range request.
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

/// Every answer from the vault says `Cache-Control: no-store`, thumbnails
/// too. WebView2 runs with a normal (not InPrivate) profile, whose HTTP cache
/// lives on disk in the app's data folder; anything it was allowed to cache
/// ("max-age", "immutable") could be written there, decrypted. So nothing is
/// cacheable, and the window keeps its own copies instead: thumbnails it
/// fetched stay in memory as blob: URLs (thumbcache.ts, a few dozen MB,
/// emptied when the vault locks), keyed by addresses that carry the
/// thumbnail's object id (`thumb/<id>?v=<first 8 hex>`), so a remade
/// thumbnail is a new address and the old copy is never shown.
pub const NO_STORE: &str = "no-store";

pub fn mime_for(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        // Text is decoded by the window itself (it guesses the encoding).
        "txt" | "md" | "log" | "csv" | "json" | "xml" | "nfo" | "ini" | "srt" | "vtt" | "yaml"
        | "yml" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// What a tiny preview clip is, from its first bytes: WebM (EBML header) or
/// MP4 ("ftyp" box). Anything else is refused.
pub fn tiny_mime(head: &[u8]) -> Option<&'static str> {
    if head.len() >= 4 && head[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        Some("video/webm")
    } else if head.len() >= 8 && &head[4..8] == b"ftyp" {
        Some("video/mp4")
    } else {
        None
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
            // Never let the web engine keep a copy on disk (see NO_STORE).
            .header(header::CACHE_CONTROL, NO_STORE)
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
    // An upscaled picture, from memory (upscale.rs).
    if what == "upscaled" {
        return match crate::upscale::shown(id as u64) {
            Some(png) => {
                let (r, len) = crate::upscale::reader(png);
                respond(r, len, "image/png", header_str(req, header::RANGE))
            }
            None => plain(StatusCode::NOT_FOUND, "Not found."),
        };
    }
    type Row = (String, Option<String>, String, Option<String>, Option<String>, Option<i64>);
    let row: Option<Row> = s
        .db()
        .query_row(
            "SELECT object_id, thumb_object_id, ext, preview_object_id, tiny_object_id, folder_id FROM media WHERE id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .ok();
    let Some((obj, thumb, ext, preview, tiny, folder)) = row else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    // An empty type: found from the first bytes below.
    let (kind, hex, mime) = match what {
        "media" => (ObjectKind::Media, obj, mime_for(&ext)),
        "thumb" => match thumb.filter(|t| !t.is_empty()) {
            Some(t) => (ObjectKind::Thumbnail, t, ""),
            None => return plain(StatusCode::NOT_FOUND, "No thumbnail yet."),
        },
        // Frame strips: JPEG (older) or WebP.
        "preview" => match preview.filter(|t| !t.is_empty()) {
            Some(t) => (ObjectKind::Thumbnail, t, ""),
            None => return plain(StatusCode::NOT_FOUND, "No preview clip yet."),
        },
        "tiny" => match tiny.filter(|t| !t.is_empty()) {
            Some(t) => (ObjectKind::Thumbnail, t, ""),
            None => return plain(StatusCode::NOT_FOUND, "No tiny clip yet."),
        },
        _ => return plain(StatusCode::NOT_FOUND, "Not found."),
    };
    let Ok(oid) = ObjectId::from_hex(&hex) else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    if what == "thumb" && wants_small(req.uri().query()) {
        // The small one, from its folder's thumbnail page (thumbpages.rs);
        // until that page is made, the stored (big) thumbnail.
        if let Some(bytes) = thumbpages::get(s, &oid, Size::Small) {
            let mime = crate::picture::image_mime(&bytes).unwrap_or("image/jpeg");
            let len = bytes.len() as u64;
            return respond(std::io::Cursor::new(bytes), len, mime, header_str(req, header::RANGE));
        }
        thumbpages::note_miss(s, folder, Size::Small);
    }
    // Videos (and anything else asked for in ranges) go through the chunk cache.
    if kind == ObjectKind::Media
        && let Some(range) = header_str(req, header::RANGE)
    {
        return serve_cached(s, &oid, mime, range);
    }
    // Opening only needs the key briefly; reading happens without holding locks.
    let reader = s.vault().open_object(kind, &oid);
    match reader {
        Ok(mut r) => {
            let len = r.len();
            let mime = if mime.is_empty() {
                let mut head = [0u8; 12];
                let n = r.read(&mut head).unwrap_or(0);
                if r.seek(SeekFrom::Start(0)).is_err() {
                    return plain(StatusCode::INTERNAL_SERVER_ERROR, "This file is damaged.");
                }
                // Pictures of an unexpected kind go as before (the web engine looks at the bytes itself).
                let found = if what == "tiny" { tiny_mime(&head[..n]) } else { crate::picture::image_mime(&head[..n]).or(Some("image/jpeg")) };
                match found {
                    Some(m) => m,
                    None => return plain(StatusCode::INTERNAL_SERVER_ERROR, "This picture is damaged."),
                }
            } else {
                mime
            };
            respond(r, len, mime, header_str(req, header::RANGE))
        }
        Err(e) => plain(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ---- decrypted chunks of recently played files ------------------------------------------

/// Files whose chunks are kept, and chunks kept per file. At 1 MiB chunks
/// that is at most 36 MiB, all in memory (wiped when dropped) and emptied
/// when the vault locks.
const CACHE_FILES: usize = 6;
const CACHE_CHUNKS: usize = 6;
/// After a seek (or the first request) only up to the end of the next chunk
/// is sent, so the picture comes back quickly; requests that carry on where
/// the last one ended get up to [`MAX_CHUNK`].
const SEEK_CHUNKS: u64 = 2;

type Chunk = Arc<Zeroizing<Vec<u8>>>;

struct CachedFile {
    id: ObjectId,
    len: u64,
    chunk: u64,
    /// (index, plaintext), most recently used last.
    chunks: Vec<(u64, Chunk)>,
    /// One past the last byte sent (to tell a seek from playing on).
    sent_to: u64,
    used: u64,
}

#[derive(Default)]
pub struct ChunkCache {
    files: Vec<CachedFile>,
    tick: u64,
    /// Chunks decrypted so far (for tests and measurements).
    pub decrypted: u64,
}

impl ChunkCache {
    fn file(&mut self, id: &ObjectId) -> Option<&mut CachedFile> {
        self.tick += 1;
        let t = self.tick;
        let f = self.files.iter_mut().find(|f| f.id == *id)?;
        f.used = t;
        Some(f)
    }

    fn add_file(&mut self, id: ObjectId, len: u64, chunk: u64) {
        if self.files.iter().any(|f| f.id == id) {
            return;
        }
        if self.files.len() >= CACHE_FILES
            && let Some(i) = self.files.iter().enumerate().min_by_key(|(_, f)| f.used).map(|(i, _)| i)
        {
            self.files.swap_remove(i);
        }
        self.tick += 1;
        self.files.push(CachedFile { id, len, chunk, chunks: Vec::new(), sent_to: u64::MAX, used: self.tick });
    }

    fn get(&mut self, id: &ObjectId, index: u64) -> Option<Chunk> {
        let f = self.file(id)?;
        let i = f.chunks.iter().position(|(k, _)| *k == index)?;
        let c = f.chunks.remove(i);
        let out = c.1.clone();
        f.chunks.push(c);
        Some(out)
    }

    fn has(&self, id: &ObjectId, index: u64) -> bool {
        self.files.iter().any(|f| f.id == *id && f.chunks.iter().any(|(k, _)| *k == index))
    }

    fn put(&mut self, id: &ObjectId, index: u64, data: Chunk) {
        self.decrypted += 1;
        if let Some(f) = self.file(id) {
            f.chunks.retain(|(k, _)| *k != index);
            if f.chunks.len() >= CACHE_CHUNKS {
                f.chunks.remove(0);
            }
            f.chunks.push((index, data));
        }
    }

    pub fn clear(&mut self) {
        self.files.clear();
    }
}

static CHUNKS: Mutex<ChunkCache> = Mutex::new(ChunkCache { files: Vec::new(), tick: 0, decrypted: 0 });

fn chunks() -> std::sync::MutexGuard<'static, ChunkCache> {
    CHUNKS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Forget every decrypted chunk and thumbnail page (the vault locked, or
/// another one opened).
pub fn forget_cache() {
    chunks().clear();
    thumbpages::forget();
}

/// `thumb/<id>?…&small=1`: the small (256 px) thumbnail is wanted.
pub fn wants_small(query: Option<&str>) -> bool {
    query.is_some_and(|q| q.split('&').any(|kv| kv == "small=1"))
}

/// Which bytes to send for a range request on a file split into chunks of
/// `chunk` bytes. An explicit end is honoured; an open end ("bytes=N-") stops
/// at a chunk boundary: soon after a seek, up to `MAX_CHUNK` when playing on
/// (`carry_on`: the request starts where the last answer ended).
pub fn chunked_range(h: &str, len: u64, chunk: u64, carry_on: bool) -> Option<(u64, u64)> {
    let (start, end) = parse_range(Some(h), len)?;
    let spec = h.trim().strip_prefix("bytes=")?;
    let open_end = spec.split(',').next()?.trim().ends_with('-');
    if !open_end || chunk == 0 {
        return Some((start, end));
    }
    let want = if carry_on { MAX_CHUNK.div_ceil(chunk).max(1) } else { SEEK_CHUNKS };
    let stop = (start / chunk + want) * chunk - 1;
    Some((start, stop.min(len - 1)))
}

fn serve_cached(s: &Session, oid: &ObjectId, mime: &str, range: &str) -> Response<Vec<u8>> {
    let known = chunks().file(oid).map(|f| (f.len, f.chunk, f.sent_to));
    let mut reader = None;
    let (len, cs, sent_to) = match known {
        Some(k) => k,
        None => match s.vault().open_object(ObjectKind::Media, oid) {
            Ok(r) => {
                let (len, cs) = (r.len(), r.header().chunk_size());
                chunks().add_file(*oid, len, cs);
                reader = Some(r);
                (len, cs, u64::MAX)
            }
            Err(e) => return plain(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        },
    };
    let base = |b: tauri::http::response::Builder| {
        b.header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, NO_STORE)
    };
    // Playing on: it starts where the last answer ended, or right after a
    // chunk that was just sent.
    let carry_on = parse_range(Some(range), len).is_some_and(|(a, _)| {
        a == sent_to
            || (a > 0 && a % cs == 0 && chunks().file(oid).is_some_and(|f| f.chunks.iter().any(|(k, _)| *k == a / cs - 1)))
    });
    let Some((start, end)) = chunked_range(range, len, cs, carry_on) else {
        return base(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())
            .unwrap();
    };
    let mut body = Vec::with_capacity((end - start + 1) as usize);
    let last_index = end / cs;
    // Decrypted for this answer (the cache may already have let go of them).
    let mut fresh: Vec<(u64, Chunk)> = Vec::new();
    for index in start / cs..=last_index {
        let hit = match fresh.iter().position(|(k, _)| *k == index) {
            Some(i) => Some(fresh.swap_remove(i).1),
            None => chunks().get(oid, index),
        };
        let data = match hit {
            Some(d) => d,
            None => {
                if reader.is_none() {
                    match s.vault().open_object(ObjectKind::Media, oid) {
                        Ok(r) => reader = Some(r),
                        Err(e) => return plain(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
                    }
                }
                // This chunk and the missing ones right after it, decrypted
                // at once on several cores (without holding the cache's lock).
                let mut run = 1;
                while index + run <= last_index && !chunks().has(oid, index + run) {
                    run += 1;
                }
                let Ok(v) = reader.as_mut().unwrap().read_chunks(index, run) else {
                    return plain(StatusCode::INTERNAL_SERVER_ERROR, "This file is damaged.");
                };
                let mut first = None;
                for (k, d) in v.into_iter().enumerate() {
                    let d = Arc::new(d);
                    chunks().put(oid, index + k as u64, d.clone());
                    if k == 0 {
                        first = Some(d);
                    } else {
                        fresh.push((index + k as u64, d));
                    }
                }
                let Some(d) = first else {
                    return plain(StatusCode::INTERNAL_SERVER_ERROR, "This file is damaged.");
                };
                d
            }
        };
        let c0 = index * cs;
        let from = start.max(c0) - c0;
        let to = (end + 1).min(c0 + data.len() as u64) - c0;
        if from >= to {
            return plain(StatusCode::INTERNAL_SERVER_ERROR, "This file is damaged.");
        }
        body.extend_from_slice(&data[from as usize..to as usize]);
    }
    if let Some(f) = chunks().file(oid) {
        f.sent_to = end + 1;
    }
    base(Response::builder().status(StatusCode::PARTIAL_CONTENT))
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .header(header::CONTENT_LENGTH, body.len())
        .body(body)
        .unwrap()
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


// ---- offline models (smart search) ------------------------------------------------------

/// Where the smart-search models live: `models` next to MediaVault.exe, or
/// MV_MODELS_DIR while developing.
pub fn models_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("MV_MODELS_DIR") {
        return Some(PathBuf::from(d));
    }
    std::env::current_exe().ok()?.parent().map(|p| p.join("models"))
}

/// Serve a model file by plain name ("clip-vision.onnx"). No sub-folders,
/// no "..": only files directly in the models folder.
pub fn serve_models(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let name = req.uri().path().trim_start_matches('/').to_string();
    let ok_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_');
    if name.is_empty() || !name.chars().all(ok_char) || name.starts_with('.') {
        return plain(StatusCode::BAD_REQUEST, "Bad model name.");
    }
    let Some(dir) = models_dir() else {
        return plain(StatusCode::NOT_FOUND, "No models folder.");
    };
    let path = dir.join(&name);
    let Ok(f) = std::fs::File::open(&path) else {
        return plain(StatusCode::NOT_FOUND, "Model not found.");
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "wasm" => "application/wasm",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    respond(std::io::BufReader::new(f), len, mime, header_str(req, header::RANGE))
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
    fn tiny_clips_are_recognised_by_their_first_bytes() {
        assert_eq!(tiny_mime(&[0x1A, 0x45, 0xDF, 0xA3, 0x9F]), Some("video/webm"));
        assert_eq!(tiny_mime(b"\0\0\0\x18ftypisom"), Some("video/mp4"));
        assert_eq!(tiny_mime(b"\xff\xd8\xff\xe0 jpeg"), None);
        assert_eq!(tiny_mime(b""), None);
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

    /// A vault with one "video" of `len` pseudo-random bytes; its item id and bytes.
    fn vault_with_video(t: &Path, len: usize) -> (Session, i64, Vec<u8>) {
        let (s, _) = crate::session::create(t.to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let data: Vec<u8> = (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        let (oid, _) = s.vault().add_object(ObjectKind::Media, &data[..]).unwrap();
        s.db()
            .execute(
                "INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES (?, 'video', 'big.mp4', 'mp4', ?, 'h', 0)",
                rusqlite::params![oid.to_hex(), len as i64],
            )
            .unwrap();
        let id = s.db().last_insert_rowid();
        (s, id, data)
    }

    fn get_range(s: &Session, id: i64, range: &str) -> Response<Vec<u8>> {
        let req = Request::builder().uri(format!("vault://localhost/media/{id}")).header(header::RANGE, range).body(Vec::new()).unwrap();
        serve_vault(Some(s), &req)
    }

    fn sent(r: &Response<Vec<u8>>) -> (u64, u64) {
        let cr = r.headers()[header::CONTENT_RANGE].to_str().unwrap();
        let (a, b) = cr.trim_start_matches("bytes ").split_once('/').unwrap().0.split_once('-').unwrap();
        (a.parse().unwrap(), b.parse().unwrap())
    }

    #[test]
    fn open_ranges_end_on_chunk_boundaries() {
        const M: u64 = 1 << 20;
        let len = 100 * M + 123;
        // After a seek: to the end of the next chunk.
        assert_eq!(chunked_range("bytes=0-", len, M, false), Some((0, 2 * M - 1)));
        assert_eq!(chunked_range("bytes=5000000-", len, M, false), Some((5_000_000, 6 * M - 1)));
        // Playing on: up to 8 chunks, still ending on a boundary.
        assert_eq!(chunked_range("bytes=2097152-", len, M, true), Some((2 * M, 10 * M - 1)));
        assert_eq!(chunked_range("bytes=2097000-", len, M, true), Some((2_097_000, 9 * M - 1)));
        // The end of the file, explicit ends and suffixes are as asked.
        assert_eq!(chunked_range("bytes=104857000-", len, M, false), Some((104_857_000, len - 1)));
        assert_eq!(chunked_range("bytes=10-20", len, M, false), Some((10, 20)));
        assert_eq!(chunked_range("bytes=-100", len, M, false), Some((len - 100, len - 1)));
        assert_eq!(chunked_range("bytes=999999999-", len, M, false), None);
    }

    #[test]
    fn video_ranges_come_from_the_chunk_cache() {
        let _one = crate::thumbpages::tests::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = tempfile::tempdir().unwrap();
        let (s, id, data) = vault_with_video(t.path(), 12 * (1 << 20) + 777);
        let len = data.len() as u64;
        let before = chunks().decrypted;
        // A seek into the middle: two chunks decrypted.
        let r = get_range(&s, id, "bytes=3500000-");
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        let (a, b) = sent(&r);
        assert_eq!((a, b), (3_500_000, 5 * (1 << 20) - 1));
        assert_eq!(r.body(), &data[a as usize..=b as usize]);
        assert_eq!(chunks().decrypted - before, 2);
        // The same place again, and small pieces inside it: nothing new decrypted.
        let r2 = get_range(&s, id, "bytes=3500000-");
        assert_eq!(r2.body(), r.body());
        let r3 = get_range(&s, id, "bytes=4000000-4000099");
        assert_eq!(r3.body(), &data[4_000_000..4_000_100]);
        assert_eq!(chunks().decrypted - before, 2);
        // Playing on from where the last answer ended: a long piece.
        let r4 = get_range(&s, id, &format!("bytes={}-", 5 << 20));
        let (a, b) = sent(&r4);
        assert_eq!((a, b), (5 << 20, len - 1));
        assert_eq!(r4.body(), &data[a as usize..]);
        // Asked with no Range at all: the whole file.
        let full = serve_vault(Some(&s), &Request::builder().uri(format!("vault://localhost/media/{id}")).body(Vec::new()).unwrap());
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body(), &data);
        assert_eq!(get_range(&s, id, "bytes=999999999-").status(), StatusCode::RANGE_NOT_SATISFIABLE);
        // Locking forgets every decrypted chunk.
        forget_cache();
        assert!(chunks().file(&ObjectId::from_hex(&s.db().query_row("SELECT object_id FROM media WHERE id = ?", [id], |r| r.get::<_, String>(0)).unwrap()).unwrap()).is_none());
    }

    #[test]
    fn the_cache_keeps_a_few_files_and_chunks() {
        let mut c = ChunkCache::default();
        let ids: Vec<ObjectId> = (0..8).map(|_| ObjectId::random()).collect();
        for id in &ids {
            c.add_file(*id, 100 << 20, 1 << 20);
        }
        assert_eq!(c.files.len(), CACHE_FILES);
        assert!(c.file(&ids[0]).is_none() && c.file(&ids[1]).is_none(), "the oldest went");
        for i in 0..10 {
            c.put(&ids[7], i, Arc::new(Zeroizing::new(vec![i as u8])));
        }
        assert_eq!(c.file(&ids[7]).unwrap().chunks.len(), CACHE_CHUNKS);
        assert!(c.get(&ids[7], 3).is_none());
        assert_eq!(c.get(&ids[7], 9).unwrap()[0], 9);
    }

    /// Seek latency through the protocol, before (each request opens the file
    /// and decrypts up to 8 MiB from wherever it lands) and after (chunk-aligned
    /// answers from the chunk cache). Run with
    /// `cargo test --release -p media-vault-app seek_latency -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn seek_latency() {
        let _one = crate::thumbpages::tests::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = tempfile::tempdir().unwrap();
        let mb = std::env::var("MV_BENCH_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(400usize);
        let (s, id, data) = vault_with_video(t.path(), mb << 20);
        let len = data.len() as u64;
        let hex: String = s.db().query_row("SELECT object_id FROM media WHERE id = ?", [id], |r| r.get(0)).unwrap();
        let oid = ObjectId::from_hex(&hex).unwrap();
        let old = |range: &str| {
            let r = s.vault().open_object(ObjectKind::Media, &oid).unwrap();
            respond(r, len, "video/mp4", Some(range))
        };
        let mut x: u64 = 12345;
        let mut seeks = Vec::new();
        for _ in 0..60 {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            seeks.push((x >> 11) % (len - (10 << 20)));
        }
        // A seek as the web engine does it: an open request where it lands, then
        // (often) the same place again with a small explicit range, then playing on.
        let run = |name: &str, f: &dyn Fn(&str) -> Response<Vec<u8>>| {
            let mut first = Vec::new();
            let mut total = Vec::new();
            for &p in &seeks {
                let t0 = std::time::Instant::now();
                let r = f(&format!("bytes={p}-"));
                first.push(t0.elapsed().as_secs_f64() * 1000.0);
                let (_, end) = sent(&r);
                assert_eq!(r.body()[..64], data[p as usize..p as usize + 64]);
                let _ = f(&format!("bytes={p}-{}", p + 65535));
                let _ = f(&format!("bytes={}-", end + 1));
                total.push(t0.elapsed().as_secs_f64() * 1000.0);
            }
            first.sort_by(f64::total_cmp);
            total.sort_by(f64::total_cmp);
            let med = |v: &Vec<f64>| v[v.len() / 2];
            let p90 = |v: &Vec<f64>| v[v.len() * 9 / 10];
            println!("{name}: first answer median {:.1} ms (p90 {:.1}); seek+check+play-on median {:.1} ms (p90 {:.1})", med(&first), p90(&first), med(&total), p90(&total));
        };
        let d0 = chunks().decrypted;
        run("before (no cache, 8 MiB from the seek)", &old);
        forget_cache();
        run("after  (chunk-aligned, cached)", &|r: &str| get_range(&s, id, r));
        println!("chunks decrypted after: {} for {} seeks", chunks().decrypted - d0, seeks.len());
    }

    fn get_thumb(s: &Session, id: i64, query: &str) -> Response<Vec<u8>> {
        let req = Request::builder().uri(format!("vault://localhost/thumb/{id}{query}")).body(Vec::new()).unwrap();
        serve_vault(Some(s), &req)
    }

    #[test]
    fn thumbnails_come_from_pages_and_say_what_they_are() {
        use crate::thumbpages::{self, Size};
        let _one = crate::thumbpages::tests::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = tempfile::tempdir().unwrap();
        let (s, folder, ids) = crate::thumbpages::tests::vault_with_folder(t.path(), 40, 400);
        forget_cache();
        // No pages yet: each from its own object, typed from its bytes, never cached by the web engine.
        let one = get_thumb(&s, ids[3], "?v=abcd1234");
        assert_eq!(one.status(), StatusCode::OK);
        assert_eq!(one.headers()[header::CONTENT_TYPE], "image/webp");
        assert_eq!(one.headers()[header::CACHE_CONTROL], "no-store");
        // An older JPEG thumbnail still works.
        let p = crate::thumbpages::tests::picture(1, 300, 200);
        let (jid, _) = s.vault().add_object(ObjectKind::Thumbnail, &crate::picture::encode_jpeg(&p, 86).unwrap()[..]).unwrap();
        s.db().execute("UPDATE media SET thumb_object_id = ? WHERE id = ?", rusqlite::params![jid.to_hex(), ids[39]]).unwrap();
        assert_eq!(get_thumb(&s, ids[39], "").headers()[header::CONTENT_TYPE], "image/jpeg");
        // No small pages yet: a small request gets the big one, and the folder is noted.
        let early = get_thumb(&s, ids[3], "?v=abcd1234&small=1");
        assert_eq!(early.body(), one.body());
        assert_eq!(thumbpages::stats().misses, 1);
        // Pages made: small ones only when asked for; big ones stay as they are.
        thumbpages::refresh_folder(&s, Some(folder), Size::Small, std::time::Duration::ZERO).unwrap();
        let before = thumbpages::stats().hits;
        let again = get_thumb(&s, ids[3], "?v=abcd1234");
        assert_eq!(again.body(), one.body());
        let small = get_thumb(&s, ids[3], "?v=abcd1234&small=1");
        assert_eq!(small.headers()[header::CONTENT_TYPE], "image/webp");
        assert!(small.body().len() < one.body().len() / 2);
        assert_eq!(get_thumb(&s, ids[39], "?small=1").headers()[header::CONTENT_TYPE], "image/webp", "small copies of JPEG ones are WebP");
        assert_eq!(thumbpages::stats().hits - before, 2);
        // Locked: nothing is answered, and the pages are forgotten.
        forget_cache();
        assert_eq!(thumbpages::stats(), thumbpages::Stats::default());
        assert_eq!(serve_vault(None, &Request::builder().uri(format!("vault://localhost/thumb/{}", ids[3])).body(Vec::new()).unwrap()).status(), StatusCode::FORBIDDEN);
        assert!(wants_small(Some("v=1&small=1")) && !wants_small(Some("v=1")) && !wants_small(None) && !wants_small(Some("nosmall=1")));
    }

    /// Grid load time for a folder of 2,000 items through the protocol
    /// handler: every thumbnail asked for (one at a time, and six at once as
    /// the grid's queue does), before thumbnail pages (one decryption each)
    /// and after (one per page), big and small. Run with
    /// `cargo test --release -p media-vault-app grid_load -- --ignored --nocapture`
    /// (MV_BENCH_ITEMS changes the count).
    #[test]
    #[ignore]
    fn grid_load() {
        use crate::thumbpages::{self, Size};
        use std::time::{Duration, Instant};
        let _one = crate::thumbpages::tests::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let n: usize = std::env::var("MV_BENCH_ITEMS").ok().and_then(|v| v.parse().ok()).unwrap_or(2000);
        let t = tempfile::tempdir().unwrap();
        let t0 = Instant::now();
        let (s, folder, ids) = crate::thumbpages::tests::vault_with_folder(t.path(), n, 640);
        let bytes: usize = ids.iter().take(24).map(|id| get_thumb(&s, *id, "").body().len()).sum::<usize>() / 24.min(ids.len());
        println!("{n} items, thumbnails about {:.1} KB each (made in {:.1} s)", bytes as f64 / 1024.0, t0.elapsed().as_secs_f64());
        forget_cache();
        let screen = 60.min(n);
        let run = |name: &str, query: &str| {
            // The first screen, then the whole folder (one at a time), then six at once.
            let t0 = Instant::now();
            let mut total = 0usize;
            for id in &ids[..screen] {
                let r = get_thumb(&s, *id, query);
                assert_eq!(r.status(), StatusCode::OK);
                total += r.body().len();
            }
            let first = t0.elapsed();
            for id in &ids[screen..] {
                total += get_thumb(&s, *id, query).body().len();
            }
            let all = t0.elapsed();
            let next = std::sync::atomic::AtomicUsize::new(0);
            let t1 = Instant::now();
            std::thread::scope(|sc| {
                for _ in 0..6 {
                    sc.spawn(|| {
                        loop {
                            let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            if i >= ids.len() {
                                break;
                            }
                            assert_eq!(get_thumb(&s, ids[i], query).status(), StatusCode::OK);
                        }
                    });
                }
            });
            let par = t1.elapsed();
            println!(
                "{name:44} first screen ({screen}) {:6.1} ms | all {n}: {:7.1} ms ({:5.0} µs/tile), 6 at once {:7.1} ms | {:.1} MB sent",
                first.as_secs_f64() * 1e3,
                all.as_secs_f64() * 1e3,
                all.as_secs_f64() * 1e6 / n as f64,
                par.as_secs_f64() * 1e3,
                total as f64 / 1e6
            );
        };
        run("before: one object per tile", "?v=1");
        // What making a small thumbnail costs, step by step.
        let (mut td, mut tf, mut te) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);
        let k = 40.min(ids.len());
        for id in &ids[..k] {
            let big = get_thumb(&s, *id, "").into_body();
            let t0 = Instant::now();
            let pic = crate::picture::decode_thumb(&big).unwrap();
            td += t0.elapsed();
            let t0 = Instant::now();
            let small = crate::picture::fit(&pic, crate::picture::SMALL_MAX).unwrap();
            tf += t0.elapsed();
            let t0 = Instant::now();
            let _ = crate::picture::encode_webp(&small, crate::picture::SMALL_WEBP_QUALITY).unwrap();
            te += t0.elapsed();
        }
        let ms = |d: Duration| d.as_secs_f64() * 1e3 / k as f64;
        println!("a small thumbnail: decode {:.1} ms, shrink {:.1} ms, encode {:.1} ms", ms(td), ms(tf), ms(te));
        let tb = Instant::now();
        let big = thumbpages::refresh_folder(&s, Some(folder), Size::Big, Duration::ZERO).unwrap();
        let tb = tb.elapsed();
        let ts = Instant::now();
        let small = thumbpages::refresh_folder(&s, Some(folder), Size::Small, Duration::ZERO).unwrap();
        let ts = ts.elapsed();
        let (pages, page_bytes) = thumbpages::usage(&s.db());
        println!(
            "pages made: big {} in {:.0} ms, small {} in {:.0} ms; {pages} pages, {:.1} MB",
            big.pages,
            tb.as_secs_f64() * 1e3,
            small.pages,
            ts.as_secs_f64() * 1e3,
            page_bytes as f64 / 1e6
        );
        forget_cache();
        run("after: pages, big, cold (just unlocked)", "?v=1");
        println!("{:?}", thumbpages::stats());
        run("after: pages, big, warm (in memory)", "?v=1");
        println!("{:?}", thumbpages::stats());
        // Where the time goes: the page lookup alone, the library lookup alone.
        let oids: Vec<ObjectId> = ids
            .iter()
            .map(|id| ObjectId::from_hex(&s.db().query_row("SELECT thumb_object_id FROM media WHERE id = ?", [id], |r| r.get::<_, String>(0)).unwrap()).unwrap())
            .collect();
        let t0 = Instant::now();
        for o in &oids {
            assert!(thumbpages::get(&s, o, Size::Big).is_some());
        }
        let t_get = t0.elapsed();
        let t0 = Instant::now();
        for id in &ids {
            let _: Option<String> = s.db().query_row("SELECT thumb_object_id FROM media WHERE id = ?", [id], |r| r.get(0)).ok();
        }
        println!("page lookups alone {:.1} ms, library lookups alone {:.1} ms", t_get.as_secs_f64() * 1e3, t0.elapsed().as_secs_f64() * 1e3);
        forget_cache();
        run("after: pages, small, cold", "?v=1&small=1");
        run("after: pages, small, warm", "?v=1&small=1");
        println!("{:?}", thumbpages::stats());
    }

    #[test]
    fn local_files_need_a_drop_first() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("clips");
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("b.mp4"), b"bb").unwrap();
        std::fs::write(d.join("a.jpg"), b"aa").unwrap();
        std::fs::write(d.join("sub/c.gif"), b"cc").unwrap();
        std::fs::write(d.join("x.exe"), b"x").unwrap();
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
        assert_eq!(get(&d.join("x.exe")), StatusCode::FORBIDDEN);
    }
}
