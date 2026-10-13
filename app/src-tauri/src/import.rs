//! Importing: files, folders, .7z archives and split archives (.7z.001…).
//!
//! Everything streams straight into the vault. Nothing decrypted is ever
//! written to disk, including archive contents.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rusqlite::params;
use serde::Serialize;
use sevenz_rust2::{ArchiveReader, EncoderMethod, Password};
use vault_core::multipart::{MultiPartReader, find_parts};
use vault_core::{ObjectId, ObjectKind};

use crate::library::{self, now_secs};
use crate::session::Session;

pub const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "webp"];
pub const GIF_EXT: &[&str] = &["gif"];
pub const VIDEO_EXT: &[&str] = &["mp4", "m4v", "webm"];
/// Plain-text files shown as text (read-only).
pub const TEXT_EXT: &[&str] = &[
    "txt", "md", "log", "csv", "json", "xml", "nfo", "ini", "srt", "vtt", "yaml", "yml",
];
pub const PDF_EXT: &[&str] = &["pdf"];

pub fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// "image", "gif", "video", "text" or "pdf" by file extension; None if not supported.
pub fn kind_by_ext(name: &str) -> Option<&'static str> {
    let e = ext_of(name);
    if IMAGE_EXT.contains(&e.as_str()) {
        Some("image")
    } else if GIF_EXT.contains(&e.as_str()) {
        Some("gif")
    } else if VIDEO_EXT.contains(&e.as_str()) {
        Some("video")
    } else if TEXT_EXT.contains(&e.as_str()) {
        Some("text")
    } else if PDF_EXT.contains(&e.as_str()) {
        Some("pdf")
    } else {
        None
    }
}

/// An animated WebP (VP8X chunk with the animation flag) behaves like a GIF.
pub fn is_animated_webp(head: &[u8]) -> bool {
    head.len() >= 21
        && &head[0..4] == b"RIFF"
        && &head[8..12] == b"WEBP"
        && &head[12..16] == b"VP8X"
        && head[20] & 0x02 != 0
}

fn kind_for(name: &str, head: &[u8]) -> Option<&'static str> {
    match kind_by_ext(name) {
        Some("image") if ext_of(name) == "webp" && is_animated_webp(head) => Some("gif"),
        k => k,
    }
}

pub fn is_archive_name(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".7z") || is_split_part(&l)
}

fn is_split_part(lower: &str) -> bool {
    match lower.rsplit_once('.') {
        Some((base, num)) => {
            base.ends_with(".7z") && num.len() >= 3 && num.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// "Beach 2024.7z" and "Beach 2024.7z.003" both become "Beach 2024".
pub fn archive_stem(name: &str) -> String {
    let mut n = name.to_string();
    if is_split_part(&n.to_ascii_lowercase())
        && let Some((base, _)) = n.rsplit_once('.')
    {
        n = base.to_string();
    }
    if n.to_ascii_lowercase().ends_with(".7z") {
        n.truncate(n.len() - 3);
    }
    if n.trim().is_empty() {
        "Archive".into()
    } else {
        n
    }
}

// ---- inspecting a drop ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub path: String,
    pub name: String,
    pub parts: usize,
    pub needs_password: bool,
    pub media: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DropSummary {
    pub files: usize,
    pub folders: usize,
    pub archives: Vec<ArchiveInfo>,
    pub unsupported: usize,
}

enum Source {
    File(PathBuf),
    Dir(PathBuf),
    Archive { first: PathBuf, parts: Vec<PathBuf> },
}

fn classify(paths: &[String]) -> (Vec<Source>, Vec<(String, String)>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let mut seen_sets: Vec<PathBuf> = Vec::new();
    for p in paths {
        let path = PathBuf::from(p);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.is_dir() {
            out.push(Source::Dir(path));
        } else if path.is_file() && is_archive_name(&name) {
            let parts = match find_parts(&path) {
                Ok(Some(parts)) => parts,
                Ok(None) => vec![path.clone()],
                Err(e) => {
                    errors.push((name, e.to_string()));
                    continue;
                }
            };
            if seen_sets.contains(&parts[0]) {
                continue; // several parts of the same set were dropped
            }
            seen_sets.push(parts[0].clone());
            out.push(Source::Archive {
                first: parts[0].clone(),
                parts,
            });
        } else if path.is_file() {
            out.push(Source::File(path));
        } else {
            errors.push((name, "not found".into()));
        }
    }
    (out, errors)
}

fn walk_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        for e in entries.into_iter().rev() {
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(e.path()),
                Ok(t) if t.is_file() => out.push(e.path()),
                _ => {}
            }
        }
    }
    out.reverse();
    out.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    out
}

fn open_archive(
    parts: &[PathBuf],
    password: Option<&str>,
) -> Result<ArchiveReader<MultiPartReader>, sevenz_rust2::Error> {
    let reader = MultiPartReader::open(parts).map_err(sevenz_rust2::Error::from)?;
    let pw = match password {
        Some(p) => Password::from(p),
        None => Password::empty(),
    };
    ArchiveReader::new(reader, pw)
}

fn archive_encrypted(r: &ArchiveReader<MultiPartReader>) -> bool {
    r.archive().blocks.iter().any(|b| {
        b.coders
            .iter()
            .any(|c| c.encoder_method_id() == EncoderMethod::ID_AES256_SHA256)
    })
}

fn is_password_error(e: &sevenz_rust2::Error) -> bool {
    matches!(
        e,
        sevenz_rust2::Error::PasswordRequired | sevenz_rust2::Error::MaybeBadPassword(_)
    )
}

fn archive_info(first: &Path, parts: &[PathBuf]) -> ArchiveInfo {
    let name = first
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut info = ArchiveInfo {
        path: first.display().to_string(),
        name,
        parts: parts.len(),
        needs_password: false,
        media: 0,
        error: None,
    };
    match open_archive(parts, None) {
        Ok(r) => {
            info.needs_password = archive_encrypted(&r);
            info.media = r
                .archive()
                .files
                .iter()
                .filter(|f| f.has_stream && kind_by_ext(&f.name).is_some())
                .count();
        }
        // Encrypted file names: the contents can't be listed without the password.
        Err(e) if is_password_error(&e) => info.needs_password = true,
        Err(e) => info.error = Some(e.to_string()),
    }
    info
}

pub fn inspect(paths: &[String]) -> DropSummary {
    let (sources, errors) = classify(paths);
    let mut s = DropSummary {
        unsupported: errors.len(),
        ..Default::default()
    };
    for src in sources {
        match src {
            Source::File(p) => {
                if kind_by_ext(&p.to_string_lossy()).is_some() {
                    s.files += 1
                } else {
                    s.unsupported += 1
                }
            }
            Source::Dir(d) => {
                s.folders += 1;
                for f in walk_files(&d) {
                    if kind_by_ext(&f.to_string_lossy()).is_some() {
                        s.files += 1
                    } else {
                        s.unsupported += 1
                    }
                }
            }
            Source::Archive { first, parts } => s.archives.push(archive_info(&first, &parts)),
        }
    }
    s
}

/// Check an archive password before importing. Only possible when the file
/// names are encrypted too; otherwise a wrong password shows up on the first file.
pub fn check_password(path: &str, password: &str) -> Result<(), String> {
    let parts = find_parts(Path::new(path))
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| vec![PathBuf::from(path)]);
    match open_archive(&parts, Some(password)) {
        Ok(_) => Ok(()),
        Err(e) if is_password_error(&e) => Err("That password doesn't open this archive.".into()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- running an import -------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub job: u64,
    pub done: usize,
    pub total: usize,
    pub bytes: u64,
    pub current: String,
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub job: u64,
    pub imported: usize,
    pub duplicates: usize,
    /// Files that aren't supported media (listed by name, first 50).
    pub skipped: Vec<String>,
    pub skipped_count: usize,
    pub failed: Vec<(String, String)>,
    pub cancelled: bool,
    pub bytes: u64,
    pub seconds: f64,
}

pub struct Job {
    pub id: u64,
    pub paths: Vec<String>,
    pub target: Option<i64>,
    pub password: Option<String>,
    /// Put each archive's contents in a new folder named after it (default).
    pub archive_folder: bool,
}

struct Ctx<'a> {
    s: &'a Session,
    cancel: &'a AtomicBool,
    bytes: AtomicU64,
    report: Report,
    done: usize,
    total: usize,
    source: String,
    last_emit: Instant,
    last_save: Instant,
    progress: &'a mut dyn FnMut(&Progress),
}

impl Ctx<'_> {
    fn stopped(&self) -> bool {
        self.cancel.load(Ordering::SeqCst) || self.s.is_closed()
    }

    fn emit(&mut self, current: &str, force: bool) {
        if force || self.last_emit.elapsed() >= Duration::from_millis(200) {
            self.last_emit = Instant::now();
            (self.progress)(&Progress {
                job: self.report.job,
                done: self.done,
                total: self.total.max(self.done),
                bytes: self.bytes.load(Ordering::Relaxed),
                current: current.to_string(),
                source: self.source.clone(),
            });
        }
        if self.last_save.elapsed() >= Duration::from_secs(30) {
            self.last_save = Instant::now();
            let _ = self.s.save();
        }
    }

    fn skip(&mut self, name: &str) {
        self.report.skipped_count += 1;
        if self.report.skipped.len() < 50 {
            self.report.skipped.push(name.to_string());
        }
    }
}

/// Reads from the source while counting bytes, keeping the first bytes (for
/// format sniffing) and stopping promptly on cancel or lock.
struct Tap<'a, R: Read> {
    inner: R,
    head: Vec<u8>,
    bytes: &'a AtomicU64,
    cancel: &'a AtomicBool,
    s: &'a Session,
}

impl<R: Read> Read for Tap<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::SeqCst) || self.s.is_closed() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        let n = self.inner.read(buf)?;
        if self.head.len() < 32 {
            let take = (32 - self.head.len()).min(n);
            self.head.extend_from_slice(&buf[..take]);
        }
        self.bytes.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

enum Added {
    New,
    Duplicate,
}

/// Encrypt one file into the vault and record it in `folder`.
fn add_one(
    ctx: &mut Ctx,
    folder: Option<i64>,
    name: &str,
    reader: &mut dyn Read,
) -> Result<Added, String> {
    let mut tap = Tap {
        inner: reader,
        head: Vec::new(),
        bytes: &ctx.bytes,
        cancel: ctx.cancel,
        s: ctx.s,
    };
    let (id, written) = {
        let vault = ctx.s.vault();
        vault
            .add_object(ObjectKind::Media, &mut tap)
            .map_err(|e| e.to_string())?
    };
    let kind = kind_for(name, &tap.head).unwrap_or("image");
    let db = ctx.s.db();
    let dup: bool = db
        .query_row(
            "SELECT 1 FROM media WHERE sha256 = ?1 AND IFNULL(folder_id, 0) = IFNULL(?2, 0)",
            params![written.sha256_hex, folder],
            |_| Ok(()),
        )
        .is_ok();
    if dup {
        drop(db);
        let _ = ctx.s.vault().delete_object(ObjectKind::Media, &id);
        return Ok(Added::Duplicate);
    }
    let display = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    db.execute(
        "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id.to_hex(), folder, kind, display, ext_of(name), written.plaintext_len as i64, written.sha256_hex, now_secs()],
    )
    .map_err(|e| e.to_string())?;
    drop(db);
    ctx.s.mark_dirty();
    Ok(Added::New)
}

fn record(ctx: &mut Ctx, name: &str, r: Result<Added, String>) {
    match r {
        Ok(Added::New) => ctx.report.imported += 1,
        Ok(Added::Duplicate) => ctx.report.duplicates += 1,
        Err(_) if ctx.stopped() => {}
        Err(e) => ctx.report.failed.push((name.to_string(), e)),
    }
    ctx.done += 1;
    ctx.emit(name, false);
}

/// Folder for a relative path like "a/b" under `base`, creating it if needed.
fn folder_for(
    ctx: &Ctx,
    base: Option<i64>,
    rel_dirs: &[String],
    cache: &mut HashMap<Vec<String>, Option<i64>>,
) -> Result<Option<i64>, String> {
    if let Some(id) = cache.get(rel_dirs) {
        return Ok(*id);
    }
    let mut cur = base;
    let mut key = Vec::new();
    for d in rel_dirs {
        key.push(d.clone());
        if let Some(id) = cache.get(&key) {
            cur = *id;
            continue;
        }
        let id = library::get_or_create_folder(&ctx.s.db(), cur, d)?;
        ctx.s.mark_dirty();
        cur = Some(id);
        cache.insert(key.clone(), cur);
    }
    Ok(cur)
}

fn import_file(ctx: &mut Ctx, folder: Option<i64>, path: &Path) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if kind_by_ext(&name).is_none() {
        ctx.skip(&name);
        ctx.done += 1;
        return;
    }
    let r = File::open(path)
        .map_err(|e| e.to_string())
        .and_then(|mut f| add_one(ctx, folder, &name, &mut f));
    record(ctx, &name, r);
}

fn import_dir(ctx: &mut Ctx, target: Option<i64>, dir: &Path) {
    let dir_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Imported".into());
    let base = match library::get_or_create_folder(&ctx.s.db(), target, &dir_name) {
        Ok(id) => Some(id),
        Err(e) => {
            ctx.report.failed.push((dir_name, e));
            return;
        }
    };
    ctx.s.mark_dirty();
    let mut cache = HashMap::new();
    for f in walk_files(dir) {
        if ctx.stopped() {
            return;
        }
        let rel: Vec<String> = f
            .parent()
            .and_then(|p| p.strip_prefix(dir).ok())
            .map(|p| {
                p.components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        match folder_for(ctx, base, &rel, &mut cache) {
            Ok(folder) => import_file(ctx, folder, &f),
            Err(e) => ctx.report.failed.push((f.display().to_string(), e)),
        }
    }
}

fn import_archive(
    ctx: &mut Ctx,
    target: Option<i64>,
    first: &Path,
    parts: &[PathBuf],
    password: Option<&str>,
    own_folder: bool,
) {
    let shown = first
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut reader = match open_archive(parts, password) {
        Ok(r) => r,
        Err(e) if is_password_error(&e) => {
            let msg = if password.is_some() {
                "wrong password"
            } else {
                "needs a password"
            };
            ctx.report.failed.push((shown, msg.into()));
            return;
        }
        Err(e) => {
            ctx.report.failed.push((shown, e.to_string()));
            return;
        }
    };
    if archive_encrypted(&reader) && password.is_none() {
        ctx.report.failed.push((shown, "needs a password".into()));
        return;
    }
    let base = if own_folder {
        match library::get_or_create_folder(&ctx.s.db(), target, &archive_stem(&shown)) {
            Ok(id) => Some(id),
            Err(e) => {
                ctx.report.failed.push((shown, e));
                return;
            }
        }
    } else {
        target
    };
    ctx.s.mark_dirty();
    let mut cache = HashMap::new();
    let mut first_failure: Option<String> = None;
    let res = reader.for_each_entries(|entry, rd| {
        if ctx.stopped() {
            return Ok(false);
        }
        if entry.is_directory || !entry.has_stream {
            return Ok(true);
        }
        let full = entry.name.replace('\\', "/");
        let mut segs: Vec<String> = full
            .split('/')
            .filter(|s| !s.is_empty() && *s != "." && *s != "..")
            .map(String::from)
            .collect();
        let Some(name) = segs.pop() else {
            return Ok(true);
        };
        if kind_by_ext(&name).is_none() {
            ctx.skip(&name);
            ctx.done += 1;
            io::copy(rd, &mut io::sink())?; // keep the stream in step
            return Ok(true);
        }
        let folder = match folder_for(ctx, base, &segs, &mut cache) {
            Ok(f) => f,
            Err(e) => {
                ctx.report.failed.push((full, e));
                io::copy(rd, &mut io::sink())?;
                return Ok(true);
            }
        };
        let r = add_one(ctx, folder, &name, rd);
        if let Err(e) = &r
            && !ctx.stopped()
        {
            // A read error inside an archive (wrong password, damage) means
            // the rest of this archive can't be trusted either.
            first_failure = Some(e.clone());
            record(ctx, &name, r);
            return Ok(false);
        }
        record(ctx, &name, r);
        Ok(true)
    });
    if let Some(f) = first_failure {
        let msg = if password.is_some() && ctx.report.imported == 0 {
            format!("stopped: {f} (is the password right?)")
        } else {
            format!("stopped: {f}")
        };
        ctx.report.failed.push((shown, msg));
    } else if let Err(e) = res
        && !ctx.stopped()
    {
        ctx.report.failed.push((shown, e.to_string()));
    }
}

/// Run one import job. `progress` is called a few times a second.
pub fn run(
    s: &Session,
    job: &Job,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&Progress),
) -> Report {
    let started = Instant::now();
    let (sources, errors) = classify(&job.paths);
    let mut ctx = Ctx {
        s,
        cancel,
        bytes: AtomicU64::new(0),
        report: Report {
            job: job.id,
            failed: errors,
            ..Default::default()
        },
        done: 0,
        total: 0,
        source: String::new(),
        last_emit: Instant::now() - Duration::from_secs(1),
        last_save: Instant::now(),
        progress,
    };
    // Count first so the progress bar is honest.
    for src in &sources {
        ctx.total += match src {
            Source::File(_) => 1,
            Source::Dir(d) => walk_files(d).len(),
            Source::Archive { first, parts } => {
                let i = archive_info(first, parts);
                if i.needs_password && i.media == 0 {
                    open_archive(parts, job.password.as_deref())
                        .map(|r| r.archive().files.iter().filter(|f| f.has_stream).count())
                        .unwrap_or(0)
                } else {
                    i.media
                }
            }
        };
    }
    ctx.emit("", true);
    for src in &sources {
        if ctx.stopped() {
            break;
        }
        match src {
            Source::File(p) => {
                ctx.source = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                import_file(&mut ctx, job.target, p)
            }
            Source::Dir(d) => {
                ctx.source = d
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                import_dir(&mut ctx, job.target, d)
            }
            Source::Archive { first, parts } => {
                ctx.source = first
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                import_archive(
                    &mut ctx,
                    job.target,
                    first,
                    parts,
                    job.password.as_deref(),
                    job.archive_folder,
                )
            }
        }
    }
    ctx.report.cancelled = ctx.stopped();
    ctx.report.bytes = ctx.bytes.load(Ordering::Relaxed);
    ctx.report.seconds = started.elapsed().as_secs_f64();
    ctx.emit("", true);
    if !s.is_closed() {
        let _ = s.save();
    }
    ctx.report
}

/// Remove encrypted files that the library no longer references.
pub fn remove_objects(s: &Session, o: &library::Orphans) {
    let v = s.vault();
    for m in &o.media {
        if let Ok(id) = ObjectId::from_hex(m) {
            let _ = v.delete_object(ObjectKind::Media, &id);
        }
    }
    for t in &o.thumbs {
        if let Ok(id) = ObjectId::from_hex(t) {
            let _ = v.delete_object(ObjectKind::Thumbnail, &id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session;
    use std::fs;

    fn names(s: &Session, folder: Option<i64>) -> Vec<String> {
        let mut v: Vec<String> = library::query_items(
            &s.db(),
            &library::ItemFilter {
                folder: Some(folder),
                ..Default::default()
            },
        )
        .unwrap()
        .into_iter()
        .map(|i| i.name)
        .collect();
        v.sort();
        v
    }

    #[test]
    fn kinds_and_names() {
        assert_eq!(kind_by_ext("A.JPG"), Some("image"));
        assert_eq!(kind_by_ext("x.webm"), Some("video"));
        assert_eq!(kind_by_ext("x.gif"), Some("gif"));
        assert_eq!(kind_by_ext("notes.txt"), Some("text"));
        assert_eq!(kind_by_ext("Book.PDF"), Some("pdf"));
        assert_eq!(kind_by_ext("setup.exe"), None);
        assert!(
            is_archive_name("Beach.7z") && is_archive_name("b.7z.002") && !is_archive_name("b.zip")
        );
        assert_eq!(archive_stem("Beach 2024.7z.001"), "Beach 2024");
        assert_eq!(archive_stem("x.7z"), "x");
        let mut anim = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\x02".to_vec();
        anim.resize(32, 0);
        assert!(is_animated_webp(&anim));
        assert_eq!(kind_for("a.webp", &anim), Some("gif"));
        assert_eq!(kind_for("a.webp", b"RIFF"), Some("image"));
    }

    #[test]
    fn imports_files_and_folders_with_structure_and_dedup() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(
            t.path().to_str().unwrap(),
            "V",
            "long enough pw",
            vault_core::KdfParams::TEST_ONLY,
        )
        .unwrap();
        let src = t.path().join("Trips");
        fs::create_dir_all(src.join("Beach")).unwrap();
        fs::write(src.join("a.jpg"), b"aaa").unwrap();
        fs::write(src.join("Beach/b.mp4"), b"bbb").unwrap();
        fs::write(src.join("Beach/Thumbs.db"), b"x").unwrap();
        let loose = t.path().join("loose.png");
        fs::write(&loose, b"ccc").unwrap();

        let target = library::create_folder(&s.db(), None, "Inbox").unwrap();
        let job = Job {
            id: 1,
            paths: vec![src.display().to_string(), loose.display().to_string()],
            target: Some(target),
            password: None,
            archive_folder: true,
        };
        let cancel = AtomicBool::new(false);
        let mut events = 0;
        let r = run(&s, &job, &cancel, &mut |_| events += 1);
        assert_eq!(r.imported, 3);
        assert_eq!(r.skipped_count, 1);
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        assert!(events >= 2);

        let trips = library::find_child(&s.db(), Some(target), "Trips")
            .unwrap()
            .unwrap();
        let beach = library::find_child(&s.db(), Some(trips), "Beach")
            .unwrap()
            .unwrap();
        assert_eq!(names(&s, Some(trips)), vec!["a.jpg"]);
        assert_eq!(names(&s, Some(beach)), vec!["b.mp4"]);
        assert_eq!(names(&s, Some(target)), vec!["loose.png"]);

        // Same drop again: folders merge, files are recognised as duplicates.
        let r2 = run(&s, &Job { id: 2, ..job }, &cancel, &mut |_| {});
        assert_eq!(r2.imported, 0);
        assert_eq!(r2.duplicates, 3);
        assert_eq!(
            s.vault().list_objects(ObjectKind::Media).unwrap().len(),
            3,
            "duplicate copies are removed"
        );

        // The library was saved: reopening shows the same items.
        let path = s.info().path;
        drop(s);
        let s2 = session::unlock(&path, "long enough pw").unwrap();
        assert_eq!(s2.info().items, 3);
    }

    fn make_7z(path: &Path, password: Option<&str>, encrypt_names: bool, files: &[(&str, &[u8])]) {
        use sevenz_rust2::encoder_options::AesEncoderOptions;
        use sevenz_rust2::{ArchiveEntry, ArchiveWriter, EncoderConfiguration};
        let mut w = ArchiveWriter::create(path).unwrap();
        let mut methods = vec![EncoderConfiguration::new(EncoderMethod::COPY)];
        if let Some(pw) = password {
            methods.insert(
                0,
                EncoderConfiguration::new(EncoderMethod::AES256_SHA256)
                    .with_options(AesEncoderOptions::new(Password::from(pw)).into()),
            );
            w.set_encrypt_header(encrypt_names);
        }
        w.set_content_methods(methods);
        for (name, data) in files {
            w.push_archive_entry(ArchiveEntry::new_file(name), Some(*data))
                .unwrap();
        }
        w.finish().unwrap();
    }

    fn vault(t: &Path) -> Session {
        session::create(
            t.to_str().unwrap(),
            "V",
            "long enough pw",
            vault_core::KdfParams::TEST_ONLY,
        )
        .unwrap()
        .0
    }

    fn job(paths: Vec<String>, pw: Option<&str>) -> Job {
        Job {
            id: 1,
            paths,
            target: None,
            password: pw.map(String::from),
            archive_folder: true,
        }
    }

    #[test]
    fn encrypted_7z_with_hidden_names_imports_straight_into_folders() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let arc = t.path().join("Beach 2024.7z");
        let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        make_7z(
            &arc,
            Some("s3cret"),
            true,
            &[
                ("People/Alex/a.jpg", b"jpeg"),
                ("clip.mp4", &big),
                ("setup.exe", b"x"),
            ],
        );

        let info = &inspect(&[arc.display().to_string()]).archives[0];
        assert!(info.needs_password);
        assert!(check_password(&arc.display().to_string(), "nope").is_err());
        check_password(&arc.display().to_string(), "s3cret").unwrap();

        let cancel = AtomicBool::new(false);
        let r = run(
            &s,
            &job(vec![arc.display().to_string()], None),
            &cancel,
            &mut |_| {},
        );
        assert_eq!(r.imported, 0);
        assert_eq!(r.failed[0].1, "needs a password");
        let r = run(
            &s,
            &job(vec![arc.display().to_string()], Some("wrong")),
            &cancel,
            &mut |_| {},
        );
        assert_eq!((r.imported, r.failed[0].1.as_str()), (0, "wrong password"));
        assert!(
            s.vault()
                .list_objects(ObjectKind::Media)
                .unwrap()
                .is_empty()
        );

        let r = run(
            &s,
            &job(vec![arc.display().to_string()], Some("s3cret")),
            &cancel,
            &mut |_| {},
        );
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        assert_eq!((r.imported, r.skipped_count), (2, 1));
        let beach = library::find_child(&s.db(), None, "Beach 2024")
            .unwrap()
            .unwrap();
        let people = library::find_child(&s.db(), Some(beach), "People").unwrap();
        let alex = library::find_child(&s.db(), people, "Alex")
            .unwrap()
            .unwrap();
        assert_eq!(names(&s, Some(beach)), vec!["clip.mp4"]);
        assert_eq!(names(&s, Some(alex)), vec!["a.jpg"]);
        let clip = library::query_items(
            &s.db(),
            &library::ItemFilter {
                folder: Some(Some(beach)),
                ..Default::default()
            },
        )
        .unwrap()[0]
            .id;
        let obj: String = s
            .db()
            .query_row("SELECT object_id FROM media WHERE id = ?", [clip], |r| {
                r.get(0)
            })
            .unwrap();
        let got = s
            .vault()
            .read_object(ObjectKind::Media, &ObjectId::from_hex(&obj).unwrap())
            .unwrap();
        assert_eq!(&got[..], &big[..], "archive contents arrive byte-for-byte");
    }

    #[test]
    fn encrypted_7z_with_visible_names_and_wrong_password_stops_cleanly() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let arc = t.path().join("x.7z");
        make_7z(
            &arc,
            Some("pw"),
            false,
            &[("a.jpg", b"aaaa"), ("b.jpg", b"bbbb")],
        );
        let info = &inspect(&[arc.display().to_string()]).archives[0];
        assert!(info.needs_password);
        assert_eq!(info.media, 2);
        let cancel = AtomicBool::new(false);
        let r = run(
            &s,
            &job(vec![arc.display().to_string()], Some("bad")),
            &cancel,
            &mut |_| {},
        );
        assert_eq!(r.imported, 0);
        assert!(!r.failed.is_empty());
        assert!(
            s.vault()
                .list_objects(ObjectKind::Media)
                .unwrap()
                .is_empty(),
            "no garbage left behind"
        );
        let r = run(
            &s,
            &job(vec![arc.display().to_string()], Some("pw")),
            &cancel,
            &mut |_| {},
        );
        assert_eq!(r.imported, 2);
    }

    #[test]
    fn split_archive_from_any_part() {
        let t = tempfile::tempdir().unwrap();
        let s = vault(t.path());
        let whole = t.path().join("whole.7z");
        let data: Vec<u8> = (0..500_000u32).map(|i| (i * 7) as u8).collect();
        make_7z(
            &whole,
            Some("pw"),
            true,
            &[("v.webm", &data), ("p.png", b"png")],
        );
        let bytes = fs::read(&whole).unwrap();
        fs::remove_file(&whole).unwrap();
        for (i, chunk) in bytes.chunks(200_000).enumerate() {
            fs::write(t.path().join(format!("Clips.7z.{:03}", i + 1)), chunk).unwrap();
        }
        let cancel = AtomicBool::new(false);
        let part2 = t.path().join("Clips.7z.002").display().to_string();
        let part1 = t.path().join("Clips.7z.001").display().to_string();
        let r = run(
            &s,
            &job(vec![part2, part1], Some("pw")),
            &cancel,
            &mut |_| {},
        );
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        assert_eq!(r.imported, 2, "both parts dropped = one archive");
        assert!(
            library::find_child(&s.db(), None, "Clips")
                .unwrap()
                .is_some()
        );

        fs::remove_file(t.path().join("Clips.7z.001")).unwrap();
        let s2 = inspect(&[t.path().join("Clips.7z.003").display().to_string()]);
        assert_eq!(s2.unsupported, 1, "missing first part is reported");
    }

    #[test]
    fn cancel_stops_quickly() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(
            t.path().to_str().unwrap(),
            "V",
            "long enough pw",
            vault_core::KdfParams::TEST_ONLY,
        )
        .unwrap();
        let f = t.path().join("a.jpg");
        fs::write(&f, b"x").unwrap();
        let cancel = AtomicBool::new(true);
        let r = run(
            &s,
            &Job {
                id: 1,
                paths: vec![f.display().to_string()],
                target: None,
                password: None,
                archive_folder: true,
            },
            &cancel,
            &mut |_| {},
        );
        assert!(r.cancelled);
        assert_eq!(r.imported, 0);
    }
}

/// Developer helper: builds a demo vault for trying the app.
/// MV_SEED_DIR=<parent> MV_SEED_SRC=<folder with media> cargo test seed_demo_vault -- --ignored
#[cfg(test)]
mod seed {
    use super::*;

    #[test]
    #[ignore]
    fn seed_demo_vault() {
        let dir = std::env::var("MV_SEED_DIR").expect("MV_SEED_DIR");
        let src = PathBuf::from(std::env::var("MV_SEED_SRC").expect("MV_SEED_SRC"));
        let (s, _) = crate::session::create(
            &dir,
            "Photos",
            "demo password",
            vault_core::KdfParams::TEST_ONLY,
        )
        .unwrap();
        let paths: Vec<String> = ["People", "Trips", "Clips", "Docs"]
            .iter()
            .map(|p| src.join(p).display().to_string())
            .collect();
        let r = run(
            &s,
            &Job {
                id: 1,
                paths,
                target: None,
                password: None,
                archive_folder: true,
            },
            &AtomicBool::new(false),
            &mut |_| {},
        );
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        let db = s.db();
        let people = library::find_child(&db, None, "People").unwrap().unwrap();
        let alex = library::find_child(&db, Some(people), "Alex")
            .unwrap()
            .unwrap();
        library::tag_folder(&db, alex, &["alex".into()]).unwrap();
        let beach = library::find_child(
            &db,
            library::find_child(&db, None, "Trips").unwrap(),
            "Beach 2024",
        )
        .unwrap()
        .unwrap();
        library::tag_folder(&db, beach, &["beach".into(), "summer".into()]).unwrap();
        let ids: Vec<i64> = library::query_items(&db, &library::ItemFilter::default())
            .unwrap()
            .iter()
            .map(|i| i.id)
            .collect();
        library::set_favourite(&db, &ids[..3], true).unwrap();
        library::set_weight(&db, &ids[3..5], 5.0).unwrap();
        drop(db);
        s.save().unwrap();
        println!("imported {}", r.imported);
    }
}
