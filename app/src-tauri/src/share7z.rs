//! "Share as encrypted .7z": put chosen items and folders into a
//! password-protected 7z archive (AES-256, optionally with hidden file names),
//! the same kind 7-Zip makes with "Add to archive". Every item is streamed
//! straight from the vault into the archive writer; nothing decrypted ever
//! touches the disk. The archive can be split into standard 7-Zip volumes
//! (`name.7z.001`, `.002`, …). A half-written archive is removed if the share
//! fails or is cancelled.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sevenz_rust2::encoder_options::{AesEncoderOptions, Lzma2Options};
use sevenz_rust2::{ArchiveEntry, ArchiveWriter, EncoderConfiguration, EncoderMethod, Password};
use vault_core::export::safe_name;
use vault_core::{ObjectId, ObjectKind};
use zeroize::Zeroize;

use crate::exporter::ExportProgress;
use crate::session::Session;

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRequest {
    /// Single items (placed at the top of the archive).
    #[serde(default)]
    pub ids: Vec<i64>,
    /// Folders, each with everything inside it (subfolders too).
    #[serde(default)]
    pub folders: Vec<i64>,
    /// Full path of the .7z to create.
    pub dest: String,
    pub password: String,
    /// Hide the file names too (7-Zip's "Encrypt file names").
    #[serde(default = "yes")]
    pub encrypt_names: bool,
    /// 0 = store (no compression) … 9 = ultra.
    #[serde(default)]
    pub level: u32,
    /// Split into volumes of this many bytes.
    #[serde(default)]
    pub split_bytes: Option<u64>,
    /// Keep the folders (from the selected folder down) inside the archive.
    #[serde(default = "yes")]
    pub keep_structure: bool,
    /// Remove camera info, location and dates (set from the app's settings,
    /// never by the window).
    #[serde(skip)]
    pub strip: bool,
}

impl Drop for ShareRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

/// Same shape as the export progress ("share-progress").
pub type ShareProgress = ExportProgress;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDone {
    /// Files put into the archive.
    pub files: usize,
    /// Their size before compression.
    pub bytes: u64,
    /// Size of the archive on disk (all parts together).
    pub archive_bytes: u64,
    /// The file(s) written: one .7z, or .7z.001, .7z.002, …
    pub parts: Vec<String>,
    /// (name, what went wrong) for items that were skipped.
    pub failed: Vec<(String, String)>,
    pub cancelled: bool,
    pub error: Option<String>,
}

struct Planned {
    object: String,
    /// Display name for progress and errors.
    name: String,
    /// Path inside the archive ("/"-separated).
    path: String,
    size: u64,
}

struct Plan {
    dirs: Vec<String>,
    files: Vec<Planned>,
}

/// Picks a free path inside the archive: "a.jpg", "a (2).jpg", …
/// Compared without case, like Windows does.
fn unique(dir: &str, name: &str, taken: &mut HashSet<String>) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let candidate = if n == 1 { name.to_string() } else { format!("{stem} ({n}){ext}") };
        let full = if dir.is_empty() { candidate } else { format!("{dir}/{candidate}") };
        if taken.insert(full.to_lowercase()) {
            return full;
        }
        n += 1;
    }
}

fn plan(s: &Session, req: &ShareRequest) -> Result<Plan, String> {
    let db = s.db();
    let e = |x: rusqlite::Error| x.to_string();
    let folders: HashMap<i64, (Option<i64>, String)> = db
        .prepare("SELECT id, parent_id, name FROM folders ORDER BY name COLLATE NOCASE")
        .map_err(e)?
        .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(i64, String, String, Option<i64>, u64)> = db
        .prepare(
            "SELECT id, object_id, original_name, folder_id, size FROM media WHERE deleted_at IS NULL ORDER BY folder_id, original_name COLLATE NOCASE",
        )
        .map_err(e)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)?.max(0) as u64)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    drop(db);

    let mut children: HashMap<Option<i64>, Vec<i64>> = HashMap::new();
    for (id, (parent, _)) in &folders {
        children.entry(*parent).or_default().push(*id);
    }
    for v in children.values_mut() {
        v.sort_by_key(|id| folders[id].1.to_lowercase());
    }
    let ancestors = |mut f: Option<i64>| -> Vec<i64> {
        let mut out = Vec::new();
        while let Some(id) = f {
            if out.len() > 256 {
                break;
            }
            out.push(id);
            f = folders.get(&id).and_then(|x| x.0);
        }
        out
    };

    // Selected folders, minus those already inside another selected folder.
    let selected: HashSet<i64> = req.folders.iter().copied().filter(|f| folders.contains_key(f)).collect();
    let mut tops: Vec<i64> = Vec::new();
    for f in &req.folders {
        let inside_other = ancestors(folders.get(f).and_then(|x| x.0)).iter().any(|a| selected.contains(a));
        if selected.contains(f) && !inside_other && !tops.contains(f) {
            tops.push(*f);
        }
    }

    let mut taken: HashSet<String> = HashSet::new();
    let mut dirs: Vec<String> = Vec::new();
    // Folder id -> its directory inside the archive ("" when flat), and which
    // selected folder it belongs to.
    let mut place: HashMap<i64, String> = HashMap::new();
    for top in &tops {
        let mut stack: Vec<(i64, String)> = vec![(*top, String::new())];
        while let Some((id, parent_dir)) = stack.pop() {
            let dir = if req.keep_structure {
                let d = unique(&parent_dir, &safe_name(&folders[&id].1), &mut taken);
                dirs.push(d.clone());
                d
            } else {
                String::new()
            };
            for c in children.get(&Some(id)).into_iter().flatten().rev() {
                stack.push((*c, dir.clone()));
            }
            place.insert(id, dir);
        }
    }

    let mut files = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    let by_id: HashMap<i64, usize> = rows.iter().enumerate().map(|(i, r)| (r.0, i)).collect();
    // Items of the selected folders, folder by folder in the order the dirs were laid out.
    let mut folder_order: Vec<i64> = Vec::new();
    {
        let mut stack: Vec<i64> = tops.iter().rev().copied().collect();
        while let Some(id) = stack.pop() {
            folder_order.push(id);
            for c in children.get(&Some(id)).into_iter().flatten().rev() {
                stack.push(*c);
            }
        }
    }
    let mut rows_in: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        if let Some(f) = r.3 {
            rows_in.entry(f).or_default().push(i);
        }
    }
    let mut add = |i: usize, dir: &str, files: &mut Vec<Planned>, taken: &mut HashSet<String>| {
        let r = &rows[i];
        if !seen.insert(r.0) {
            return;
        }
        let path = unique(dir, &safe_name(&r.2), taken);
        files.push(Planned { object: r.1.clone(), name: r.2.clone(), path, size: r.4 });
    };
    for f in &folder_order {
        let dir = place.get(f).cloned().unwrap_or_default();
        for i in rows_in.get(f).into_iter().flatten() {
            add(*i, &dir, &mut files, &mut taken);
        }
    }
    for id in &req.ids {
        if let Some(i) = by_id.get(id) {
            add(*i, "", &mut files, &mut taken);
        }
    }
    Ok(Plan { dirs, files })
}

// ---- a file writer that can span several volume files -----------------------------

/// Writes one logical stream into `base` — or, when split, into `base.001`,
/// `base.002`, … of `split` bytes each — and can seek anywhere in it (the 7z
/// writer goes back to the start at the end to fill in the header). Every file
/// it creates is listed in `created`, so they can be removed if the share stops.
struct PartWriter {
    base: PathBuf,
    split: Option<u64>,
    files: Vec<File>,
    /// Where each part's own file cursor is, to skip needless seeks.
    cursors: Vec<u64>,
    created: Rc<RefCell<Vec<PathBuf>>>,
    pos: u64,
    len: u64,
}

fn part_path(base: &Path, split: Option<u64>, i: usize) -> PathBuf {
    match split {
        None => base.to_path_buf(),
        Some(_) => {
            let mut s = base.as_os_str().to_owned();
            s.push(format!(".{:03}", i + 1));
            PathBuf::from(s)
        }
    }
}

impl PartWriter {
    fn new(base: &Path, split: Option<u64>, created: Rc<RefCell<Vec<PathBuf>>>) -> Self {
        PartWriter { base: base.to_path_buf(), split, files: Vec::new(), cursors: Vec::new(), created, pos: 0, len: 0 }
    }

    fn ensure(&mut self, idx: usize) -> io::Result<()> {
        while self.files.len() <= idx {
            let p = part_path(&self.base, self.split, self.files.len());
            let f = OpenOptions::new().write(true).create_new(true).open(&p)?;
            self.created.borrow_mut().push(p);
            self.files.push(f);
            self.cursors.push(0);
        }
        Ok(())
    }

    fn sync(&mut self) -> io::Result<()> {
        for f in &mut self.files {
            f.flush()?;
            f.sync_all()?;
        }
        Ok(())
    }
}

impl Write for PartWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let size = self.split.unwrap_or(u64::MAX);
        let idx = usize::try_from(self.pos / size).map_err(io::Error::other)?;
        let off = self.pos % size;
        self.ensure(idx)?;
        let n = (size - off).min(buf.len() as u64) as usize;
        if self.cursors[idx] != off {
            self.files[idx].seek(SeekFrom::Start(off))?;
        }
        let k = self.files[idx].write(&buf[..n])?;
        self.cursors[idx] = off + k as u64;
        self.pos += k as u64;
        self.len = self.len.max(self.pos);
        Ok(k)
    }

    fn flush(&mut self) -> io::Result<()> {
        for f in &mut self.files {
            f.flush()?;
        }
        Ok(())
    }
}

impl Seek for PartWriter {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let new = match to {
            SeekFrom::Start(p) => Some(p),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
        };
        self.pos = new.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek before the start"))?;
        Ok(self.pos)
    }
}

// ---- feeding one item into the archive ------------------------------------------------

const CANCELLED: &str = "cancelled";

/// Reads a decrypted item for the archive writer, watching for Cancel and
/// telling how far it got.
struct Feed<'a, R: Read> {
    inner: R,
    cancel: &'a AtomicBool,
    session: &'a Session,
    damaged: bool,
    cancelled: bool,
    on_bytes: &'a mut dyn FnMut(u64),
}

impl<R: Read> Read for Feed<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::SeqCst) || self.session.is_closed() {
            self.cancelled = true;
            return Err(io::Error::other(CANCELLED));
        }
        match self.inner.read(buf) {
            Ok(k) => {
                (self.on_bytes)(k as u64);
                Ok(k)
            }
            Err(e) => {
                self.damaged = true;
                Err(e)
            }
        }
    }
}

fn content_methods(password: &str, level: u32) -> Vec<EncoderConfiguration> {
    // The first method is applied last: compress (or copy), then encrypt.
    let aes = EncoderConfiguration::new(EncoderMethod::AES256_SHA256).with_options(AesEncoderOptions::new(Password::from(password)).into());
    let pack = if level == 0 { EncoderConfiguration::new(EncoderMethod::COPY) } else { Lzma2Options::from_level(level.min(9)).into() };
    vec![aes, pack]
}

/// The archive path to use: what was asked, with ".7z" added if missing.
fn archive_path(dest: &str) -> PathBuf {
    let d = dest.trim();
    if d.to_lowercase().ends_with(".7z") { PathBuf::from(d) } else { PathBuf::from(format!("{d}.7z")) }
}

fn validate(req: &ShareRequest, total_bytes: u64) -> Result<PathBuf, String> {
    if req.password.is_empty() {
        return Err("Please choose a password for the archive.".into());
    }
    if req.split_bytes == Some(0) {
        return Err("The part size has to be bigger than zero.".into());
    }
    if req.dest.trim().is_empty() {
        return Err("Please choose where to save the archive.".into());
    }
    let base = archive_path(&req.dest);
    match base.parent() {
        Some(p) if p.as_os_str().is_empty() || p.is_dir() => {}
        _ => return Err("The folder to save the archive in doesn't exist.".into()),
    }
    let count = match req.split_bytes {
        None => 1,
        // Enough to cover the parts this archive could need (it never grows much beyond its items).
        Some(n) => (total_bytes / n + 2).min(10_000) as usize,
    };
    for i in 0..count {
        let p = part_path(&base, req.split_bytes, i);
        if p.exists() {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            return Err(format!("There is already a file called \"{name}\" there. Please pick another name."));
        }
    }
    Ok(base)
}

pub fn run(s: &Session, req: &ShareRequest, cancel: &AtomicBool, progress: &mut dyn FnMut(&ShareProgress)) -> ShareDone {
    let mut done = ShareDone::default();
    let plan = match plan(s, req) {
        Ok(p) => p,
        Err(e) => {
            done.error = Some(e);
            return done;
        }
    };
    if plan.files.is_empty() {
        done.error = Some("There is nothing to share.".into());
        return done;
    }
    let total_bytes: u64 = plan.files.iter().map(|f| f.size).sum();
    let base = match validate(req, total_bytes) {
        Ok(b) => b,
        Err(e) => {
            done.error = Some(e);
            return done;
        }
    };

    let created: Rc<RefCell<Vec<PathBuf>>> = Rc::default();
    let result = write_archive(s, req, &plan, &base, cancel, progress, &mut done, created.clone());
    let parts = created.borrow().clone();
    match result {
        Ok(()) if !done.cancelled => {
            done.archive_bytes = parts.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum();
            done.parts = parts.iter().map(|p| p.display().to_string()).collect();
        }
        other => {
            if let Err(e) = other {
                done.error = Some(e);
            }
            for p in &parts {
                let _ = fs::remove_file(p);
            }
            done.files = 0;
            done.bytes = 0;
        }
    }
    done
}

/// Writes the archive. When it fails or is cancelled the writer is dropped
/// (closing its files) before returning, and the caller removes every file
/// listed in `created`.
#[allow(clippy::too_many_arguments)]
fn write_archive(
    s: &Session,
    req: &ShareRequest,
    plan: &Plan,
    base: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&ShareProgress),
    done: &mut ShareDone,
    created: Rc<RefCell<Vec<PathBuf>>>,
) -> Result<(), String> {
    let total = plan.files.len();
    let total_bytes: u64 = plan.files.iter().map(|f| f.size).sum();
    let write_err = |e: &dyn std::fmt::Display| format!("Couldn't write the archive: {e}");

    let pw = PartWriter::new(base, req.split_bytes, created);
    let mut writer = ArchiveWriter::new(BufWriter::with_capacity(1 << 20, pw)).map_err(|e| write_err(&e))?;
    writer.set_content_methods(content_methods(&req.password, req.level));
    writer.set_encrypt_header(req.encrypt_names);

    for d in &plan.dirs {
        writer.push_archive_entry::<&[u8]>(ArchiveEntry::new_directory(d), None).map_err(|e| write_err(&e))?;
    }

    let mut bytes_before = 0u64;
    for (i, f) in plan.files.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) || s.is_closed() {
            done.cancelled = true;
            return Ok(());
        }
        progress(&ShareProgress { done: i, total, bytes: bytes_before, total_bytes, name: f.name.clone() });
        let opened = ObjectId::from_hex(&f.object)
            .map_err(|e| e.to_string())
            .and_then(|oid| s.vault().open_object(ObjectKind::Media, &oid).map_err(|e| e.to_string()))
            .and_then(|r| crate::stripmeta::maybe(r, &f.name, req.strip));
        let reader = match opened {
            Ok(r) => r,
            Err(e) => {
                // Nothing was written for it yet: skip it and carry on.
                done.failed.push((f.name.clone(), e));
                continue;
            }
        };
        let mut read_now = 0u64;
        let mut last_tick = std::time::Instant::now();
        let mut on_bytes = |k: u64| {
            read_now += k;
            if last_tick.elapsed().as_millis() >= 100 {
                last_tick = std::time::Instant::now();
                progress(&ShareProgress { done: i, total, bytes: bytes_before + read_now, total_bytes, name: f.name.clone() });
            }
        };
        let mut feed = Feed { inner: reader, cancel, session: s, damaged: false, cancelled: false, on_bytes: &mut on_bytes };
        let entry = ArchiveEntry::new_file(&f.path);
        let r = if f.size == 0 {
            // An empty file has no data stream in a 7z archive.
            writer.push_archive_entry::<&[u8]>(entry, None).map(|_| ())
        } else {
            writer.push_archive_entry(entry, Some(&mut feed)).map(|_| ())
        };
        let (damaged, cancelled) = (feed.damaged, feed.cancelled);
        drop(feed);
        if let Err(e) = r {
            if cancelled {
                done.cancelled = true;
                return Ok(());
            }
            if damaged {
                return Err(format!("\"{}\" couldn't be read — its encrypted data is damaged. The archive was not made.", f.name));
            }
            return Err(write_err(&e));
        }
        done.files += 1;
        done.bytes += read_now;
        bytes_before += read_now;
    }
    if done.files == 0 {
        return Err("None of the items could be read, so the archive was not made.".into());
    }
    let buf = writer.finish().map_err(|e| write_err(&e))?;
    let mut pw = buf.into_inner().map_err(|e| write_err(e.error()))?;
    pw.sync().map_err(|e| write_err(&e))?;
    progress(&ShareProgress { done: total, total, bytes: bytes_before, total_bytes, name: String::new() });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{import, library, session};
    use sevenz_rust2::ArchiveReader;

    struct Fixture {
        _t: tempfile::TempDir,
        s: Session,
        out: PathBuf,
    }

    fn fixture() -> Fixture {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        let src = t.path().join("src");
        std::fs::create_dir_all(src.join("Alex/Beach")).unwrap();
        std::fs::write(src.join("Alex/a.jpg"), vec![1u8; 3000]).unwrap();
        std::fs::write(src.join("Alex/Beach/b.jpg"), (0..200_000u32).map(|i| (i % 253) as u8).collect::<Vec<_>>()).unwrap();
        std::fs::write(src.join("Alex/Beach/same.jpg"), vec![4u8; 1000]).unwrap();
        std::fs::write(src.join("c.jpg"), vec![3u8; 3000]).unwrap();
        std::fs::create_dir_all(src.join("other")).unwrap();
        std::fs::write(src.join("other/same.jpg"), vec![5u8; 1000]).unwrap();
        let r = import::run(
            &s,
            &import::Job {
                id: 1,
                paths: vec![
                    src.join("Alex").display().to_string(),
                    src.join("c.jpg").display().to_string(),
                    src.join("other/same.jpg").display().to_string(),
                ],
                target: None,
                password: None,
                archive_folder: true,
            },
            &AtomicBool::new(false),
            &mut |_| {},
        );
        assert_eq!(r.imported, 5);
        let out = t.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        Fixture { _t: t, s, out }
    }

    /// The item called `name` at the top of the library (not in a folder), or anywhere.
    fn id_of(s: &Session, name: &str) -> i64 {
        s.db()
            .query_row("SELECT id FROM media WHERE original_name = ?1 ORDER BY folder_id IS NOT NULL LIMIT 1", [name], |r| r.get(0))
            .unwrap()
    }

    fn req(dest: &Path, ids: Vec<i64>, folders: Vec<i64>) -> ShareRequest {
        ShareRequest {
            ids,
            folders,
            dest: dest.display().to_string(),
            password: "s3cret pw".into(),
            encrypt_names: true,
            level: 0,
            split_bytes: None,
            keep_structure: true,
            strip: false,
        }
    }

    fn read_all(path: &Path, pw: &str) -> HashMap<String, Vec<u8>> {
        let mut r = ArchiveReader::open(path, Password::from(pw)).unwrap();
        let mut out = HashMap::new();
        r.for_each_entries(|e, rd| {
            if !e.is_directory() {
                let mut v = Vec::new();
                rd.read_to_end(&mut v)?;
                out.insert(e.name().to_string(), v);
            }
            Ok(true)
        })
        .unwrap();
        out
    }

    #[test]
    fn shares_items_and_folders_into_an_encrypted_archive() {
        let f = fixture();
        let alex = library::find_child(&f.s.db(), None, "Alex").unwrap().unwrap();
        let c = id_of(&f.s, "c.jpg");
        let other_same = id_of(&f.s, "same.jpg");
        let b = id_of(&f.s, "b.jpg");
        let dest = f.out.join("Shared.7z");
        // `b` is also inside Alex: it goes in once.
        let mut ticks = 0;
        let d = run(&f.s, &req(&dest, vec![c, other_same, b], vec![alex]), &AtomicBool::new(false), &mut |_| ticks += 1);
        assert_eq!(d.error, None);
        assert_eq!(d.files, 5, "{d:?}");
        assert!(ticks >= 5);
        assert_eq!(d.parts, vec![dest.display().to_string()]);
        assert!(d.archive_bytes > 0);

        let got = read_all(&dest, "s3cret pw");
        let names: HashSet<&str> = got.keys().map(|k| k.as_str()).collect();
        assert_eq!(names, ["Alex/a.jpg", "Alex/Beach/b.jpg", "Alex/Beach/same.jpg", "c.jpg", "same.jpg"].into_iter().collect());
        assert_eq!(got["Alex/a.jpg"], vec![1u8; 3000]);
        assert_eq!(got["Alex/Beach/b.jpg"], (0..200_000u32).map(|i| (i % 253) as u8).collect::<Vec<_>>());
        assert_eq!(got["same.jpg"], vec![5u8; 1000]);

        // Names are hidden: without the password the archive can't even be listed.
        assert!(ArchiveReader::open(&dest, Password::empty()).is_err());
        assert!(sevenz_rust2::Archive::open(&dest).is_err());

        // Never overwrites.
        let again = run(&f.s, &req(&dest, vec![c], vec![]), &AtomicBool::new(false), &mut |_| {});
        assert!(again.error.unwrap().contains("already a file"));
        assert_eq!(read_all(&dest, "s3cret pw").len(), 5, "the existing archive is untouched");
    }

    #[test]
    fn camera_info_is_removed_from_shared_pictures_when_asked() {
        let f = fixture();
        let src = f.out.join("cam");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("cam.jpg"), crate::stripmeta::tiny_camera_jpeg()).unwrap();
        let job = import::Job { id: 2, paths: vec![src.join("cam.jpg").display().to_string()], target: None, password: None, archive_folder: true };
        assert_eq!(import::run(&f.s, &job, &AtomicBool::new(false), &mut |_| {}).imported, 1);
        let cam = id_of(&f.s, "cam.jpg");
        for strip in [false, true] {
            let dest = f.out.join(format!("strip-{strip}.7z"));
            let mut r = req(&dest, vec![cam], vec![]);
            r.strip = strip;
            let d = run(&f.s, &r, &AtomicBool::new(false), &mut |_| {});
            assert_eq!(d.error, None);
            let got = read_all(&dest, "s3cret pw");
            let has = got["cam.jpg"].windows(5).any(|w| w == b"Canon");
            assert_eq!(has, !strip, "strip = {strip}");
        }
    }

    #[test]
    fn flat_compressed_visible_names_and_clashes() {
        let f = fixture();
        let alex = library::find_child(&f.s.db(), None, "Alex").unwrap().unwrap();
        let other_same = id_of(&f.s, "same.jpg");
        let dest = f.out.join("flat"); // ".7z" is added
        let mut r = req(&dest, vec![other_same], vec![alex]);
        r.keep_structure = false;
        r.encrypt_names = false;
        r.level = 5;
        let d = run(&f.s, &r, &AtomicBool::new(false), &mut |_| {});
        assert_eq!(d.error, None);
        let path = f.out.join("flat.7z");
        assert_eq!(d.parts, vec![path.display().to_string()]);
        // Names can be listed without the password…
        let listed = sevenz_rust2::Archive::open(&path).unwrap();
        let mut names: Vec<String> = listed.files.iter().map(|e| e.name().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["a.jpg", "b.jpg", "same (2).jpg", "same.jpg"]);
        // …but not the contents.
        let mut no_pw = ArchiveReader::open(&path, Password::empty()).unwrap();
        assert!(no_pw.read_file("a.jpg").is_err());
        let got = read_all(&path, "s3cret pw");
        assert_eq!(got["same.jpg"], vec![4u8; 1000]);
        assert_eq!(got["same (2).jpg"], vec![5u8; 1000]);
        assert!(d.archive_bytes < d.bytes, "LZMA2 shrinks the repetitive test data");
    }

    #[test]
    fn split_parts_join_into_a_valid_archive() {
        let f = fixture();
        let alex = library::find_child(&f.s.db(), None, "Alex").unwrap().unwrap();
        let dest = f.out.join("Parts.7z");
        let mut r = req(&dest, vec![], vec![alex]);
        r.split_bytes = Some(50_000);
        let d = run(&f.s, &r, &AtomicBool::new(false), &mut |_| {});
        assert_eq!(d.error, None);
        assert!(d.parts.len() >= 4, "{:?}", d.parts);
        assert!(d.parts[0].ends_with("Parts.7z.001"));
        assert!(d.parts[1].ends_with("Parts.7z.002"));
        assert!(!dest.exists());
        let mut joined = Vec::new();
        for (i, p) in d.parts.iter().enumerate() {
            let bytes = std::fs::read(p).unwrap();
            if i + 1 < d.parts.len() {
                assert_eq!(bytes.len(), 50_000);
            }
            joined.extend(bytes);
        }
        assert_eq!(joined.len() as u64, d.archive_bytes);
        let whole = f.out.join("joined.7z");
        std::fs::write(&whole, &joined).unwrap();
        let got = read_all(&whole, "s3cret pw");
        assert_eq!(got.len(), 3);
        assert_eq!(got["Alex/Beach/b.jpg"].len(), 200_000);

        // The app's own importer reads split archives too.
        let parts: Vec<PathBuf> = d.parts.iter().map(PathBuf::from).collect();
        let mut rd = ArchiveReader::new(vault_core::multipart::MultiPartReader::open(&parts).unwrap(), Password::from("s3cret pw")).unwrap();
        assert_eq!(rd.read_file("Alex/a.jpg").unwrap(), vec![1u8; 3000]);
    }

    #[test]
    fn refuses_bad_requests_and_cleans_up_on_cancel() {
        let f = fixture();
        let alex = library::find_child(&f.s.db(), None, "Alex").unwrap().unwrap();
        let go = |r: ShareRequest| run(&f.s, &r, &AtomicBool::new(false), &mut |_| {});

        let mut r = req(&f.out.join("x.7z"), vec![], vec![alex]);
        r.password.clear();
        assert!(go(r).error.unwrap().contains("password"));
        assert!(go(req(&f.out.join("nope/x.7z"), vec![], vec![alex])).error.unwrap().contains("doesn't exist"));
        assert!(go(req(&f.out.join("x.7z"), vec![], vec![])).error.unwrap().contains("nothing"));
        std::fs::write(f.out.join("y.7z.001"), b"keep").unwrap();
        let mut r = req(&f.out.join("y.7z"), vec![], vec![alex]);
        r.split_bytes = Some(1_000_000);
        assert!(go(r).error.unwrap().contains("y.7z.001"));
        assert_eq!(std::fs::read(f.out.join("y.7z.001")).unwrap(), b"keep");

        // Cancel part-way: no files are left behind.
        let cancel = AtomicBool::new(false);
        let mut r = req(&f.out.join("z.7z"), vec![], vec![alex]);
        r.split_bytes = Some(10_000);
        let d = run(&f.s, &r, &cancel, &mut |p| {
            if p.bytes > 30_000 {
                cancel.store(true, Ordering::SeqCst);
            }
        });
        assert!(d.cancelled, "{d:?}");
        assert!(d.parts.is_empty());
        let left: Vec<_> = std::fs::read_dir(&f.out).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(left.iter().all(|n| !n.starts_with("z.7z")), "{left:?}");
    }
}
