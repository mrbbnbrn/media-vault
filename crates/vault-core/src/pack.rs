//! Pack files: many encrypted objects stored back to back in a few large
//! files (about 1 GiB each), so a vault of 100 GB is ~100 files instead of
//! tens of thousands. Backup tools and cloud services with file-count limits
//! handle that much better.
//!
//! ```text
//! pack file:  "MVPK" | version u8 (1) | kind u8 | 10 reserved bytes   (16 bytes)
//!             entry, entry, ...
//! entry:      "MVPE" | object id (16) | object length u64 LE          (28 bytes)
//!             object bytes (exactly the MVOB object format, see stream.rs)
//! ```
//!
//! Every entry carries its object id, so the packs can always be scanned to
//! find any object, even without the index (which lives in the encrypted
//! database). Objects are never modified in place: new ones are appended to
//! the newest pack; deleted ones leave unused space until "reclaim space"
//! copies the live entries into fresh packs.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{Error, Result};
use crate::stream::{ObjectId, ObjectKind};

pub const PACK_DIR: &str = "packs";
pub const PACK_MAGIC: &[u8; 4] = b"MVPK";
pub const ENTRY_MAGIC: &[u8; 4] = b"MVPE";
pub const PACK_VERSION: u8 = 1;
pub const PACK_HEADER_LEN: u64 = 16;
pub const ENTRY_HEADER_LEN: u64 = 28;
/// A pack is closed once it reaches this size (a single larger object gets a pack of its own).
pub const DEFAULT_PACK_LIMIT: u64 = 1 << 30;

/// Where an object lives inside the packs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Location {
    pub kind: ObjectKind,
    pub pack: u32,
    /// Offset of the object's first byte (just after its entry header).
    pub offset: u64,
    pub len: u64,
}

pub fn kind_prefix(kind: ObjectKind) -> Option<&'static str> {
    match kind {
        ObjectKind::Media => Some("media"),
        ObjectKind::Thumbnail => Some("thumbs"),
        ObjectKind::Database => None,
    }
}

pub fn pack_file_name(kind: ObjectKind, n: u32) -> String {
    format!("{}-{n:06}.pack", kind_prefix(kind).unwrap_or("other"))
}

pub fn parse_pack_name(name: &str) -> Option<(ObjectKind, u32)> {
    let stem = name.strip_suffix(".pack")?;
    let (prefix, num) = stem.rsplit_once('-')?;
    let kind = match prefix {
        "media" => ObjectKind::Media,
        "thumbs" => ObjectKind::Thumbnail,
        _ => return None,
    };
    if num.len() != 6 || !num.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((kind, num.parse().ok()?))
}

/// Part of a file seen as a whole file: what an object reader reads from.
pub struct Slice {
    file: File,
    base: u64,
    len: u64,
    pos: u64,
}

impl Slice {
    pub fn new(file: File, base: u64, len: u64) -> Self {
        Self {
            file,
            base,
            len,
            pos: 0,
        }
    }

    pub fn whole(file: File) -> io::Result<Self> {
        let len = file.metadata()?.len();
        Ok(Self::new(file, 0, len))
    }
}

impl Read for Slice {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len {
            return Ok(0);
        }
        let want = buf.len().min((self.len - self.pos) as usize);
        self.file.seek(SeekFrom::Start(self.base + self.pos))?;
        let n = self.file.read(&mut buf[..want])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for Slice {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let new = match to {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::End(d) => self.len as i128 + d as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
        };
        if new < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before start",
            ));
        }
        self.pos = new as u64;
        Ok(self.pos)
    }
}

/// Writes one object into a pack: positions are relative to the object's start.
pub struct EntryWriter<'a> {
    file: &'a mut File,
    base: u64,
}

impl Write for EntryWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.file.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Seek for EntryWriter<'_> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let abs = match to {
            SeekFrom::Start(p) => self.file.seek(SeekFrom::Start(self.base + p))?,
            other => self.file.seek(other)?,
        };
        Ok(abs.saturating_sub(self.base))
    }
}

struct Writer {
    n: u32,
    file: File,
    end: u64,
}

/// Index changes made since the last database save.
#[derive(Debug, Clone, PartialEq)]
pub enum IndexChange {
    Put(ObjectId, Location),
    Remove(ObjectId),
}

pub struct PackStore {
    dir: PathBuf,
    limit: u64,
    writable: bool,
    index: Mutex<HashMap<ObjectId, Location>>,
    media_writer: Mutex<Option<Writer>>,
    thumb_writer: Mutex<Option<Writer>>,
    changes: Mutex<Vec<IndexChange>>,
    /// Packs written since the last sync (must reach the disk before the
    /// database that points into them is saved).
    unsynced: Mutex<HashSet<PathBuf>>,
    /// Built on demand by scanning every pack, when the index misses.
    scanned: Mutex<Option<HashMap<ObjectId, Location>>>,
}

fn read_entry_header(f: &mut File, at: u64) -> io::Result<Option<(ObjectId, u64)>> {
    let mut h = [0u8; ENTRY_HEADER_LEN as usize];
    f.seek(SeekFrom::Start(at))?;
    match f.read_exact(&mut h) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    if &h[..4] != ENTRY_MAGIC {
        return Ok(None);
    }
    let id = ObjectId(h[4..20].try_into().unwrap());
    let len = u64::from_le_bytes(h[20..28].try_into().unwrap());
    Ok(Some((id, len)))
}

/// Read every complete entry of a pack. Returns the entries and where the
/// last complete one ends (anything after that is an interrupted write).
/// What a pack scan found: kind, pack number, complete entries, end of the last complete entry.
pub type PackScan = (ObjectKind, u32, Vec<(ObjectId, Location)>, u64);

pub fn scan_pack(path: &Path) -> Result<PackScan> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let (kind, n) =
        parse_pack_name(name).ok_or_else(|| Error::Corrupt(format!("not a pack file: {name}")))?;
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let mut head = [0u8; PACK_HEADER_LEN as usize];
    if size < PACK_HEADER_LEN {
        return Ok((kind, n, Vec::new(), 0));
    }
    f.read_exact(&mut head)?;
    if &head[..4] != PACK_MAGIC {
        return Err(Error::Corrupt(format!("{name} is not a pack file")));
    }
    if head[4] != PACK_VERSION {
        return Err(Error::UnsupportedVersion(head[4] as u32));
    }
    let mut out = Vec::new();
    let mut pos = PACK_HEADER_LEN;
    while let Some((id, len)) = read_entry_header(&mut f, pos)? {
        let start = pos + ENTRY_HEADER_LEN;
        if len == 0 || start + len > size {
            break; // interrupted write
        }
        out.push((
            id,
            Location {
                kind,
                pack: n,
                offset: start,
                len,
            },
        ));
        pos = start + len;
    }
    Ok((kind, n, out, pos))
}

impl PackStore {
    pub fn new(vault_root: &Path, writable: bool) -> Self {
        Self {
            dir: vault_root.join(PACK_DIR),
            limit: DEFAULT_PACK_LIMIT,
            writable,
            index: Mutex::new(HashMap::new()),
            media_writer: Mutex::new(None),
            thumb_writer: Mutex::new(None),
            changes: Mutex::new(Vec::new()),
            unsynced: Mutex::new(HashSet::new()),
            scanned: Mutex::new(None),
        }
    }

    pub fn set_limit(&mut self, bytes: u64) {
        self.limit = bytes.max(PACK_HEADER_LEN + 1);
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn path(&self, kind: ObjectKind, n: u32) -> PathBuf {
        self.dir.join(pack_file_name(kind, n))
    }

    /// Replace the index (loaded from the database after unlocking).
    pub fn load_index(&self, entries: impl IntoIterator<Item = (ObjectId, Location)>) {
        let mut idx = self.index.lock().unwrap();
        idx.clear();
        idx.extend(entries);
    }

    pub fn index_len(&self) -> usize {
        self.index.lock().unwrap().len()
    }

    pub fn location(&self, id: &ObjectId) -> Option<Location> {
        self.index.lock().unwrap().get(id).copied()
    }

    pub fn contains(&self, id: &ObjectId) -> bool {
        self.index.lock().unwrap().contains_key(id)
    }

    /// Take the index changes so the caller can write them into the database.
    pub fn drain_changes(&self) -> Vec<IndexChange> {
        std::mem::take(&mut *self.changes.lock().unwrap())
    }

    /// Put changes back if saving the database failed.
    pub fn restore_changes(&self, mut c: Vec<IndexChange>) {
        let mut ch = self.changes.lock().unwrap();
        c.append(&mut ch);
        *ch = c;
    }

    fn record(&self, c: IndexChange) {
        let mut idx = self.index.lock().unwrap();
        match &c {
            IndexChange::Put(id, loc) => {
                idx.insert(*id, *loc);
            }
            IndexChange::Remove(id) => {
                idx.remove(id);
            }
        }
        drop(idx);
        self.changes.lock().unwrap().push(c);
    }

    /// Pack numbers that exist on disk for a kind, sorted.
    pub fn packs_on_disk(&self, kind: ObjectKind) -> Result<Vec<u32>> {
        let mut v = Vec::new();
        let rd = match fs::read_dir(&self.dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(v),
            Err(e) => return Err(e.into()),
        };
        for e in rd.flatten() {
            if let Some((k, n)) = e.file_name().to_str().and_then(parse_pack_name)
                && k == kind
            {
                v.push(n);
            }
        }
        v.sort();
        Ok(v)
    }

    fn writer_slot(&self, kind: ObjectKind) -> Result<&Mutex<Option<Writer>>> {
        match kind {
            ObjectKind::Media => Ok(&self.media_writer),
            ObjectKind::Thumbnail => Ok(&self.thumb_writer),
            ObjectKind::Database => {
                Err(Error::Invalid("the database is not stored in packs".into()))
            }
        }
    }

    fn open_writer(&self, kind: ObjectKind, n: u32, fresh: bool) -> Result<Writer> {
        fs::create_dir_all(&self.dir)?;
        let path = self.path(kind, n);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        let end = if fresh || file.metadata()?.len() < PACK_HEADER_LEN {
            let mut head = [0u8; PACK_HEADER_LEN as usize];
            head[..4].copy_from_slice(PACK_MAGIC);
            head[4] = PACK_VERSION;
            head[5] = kind as u8;
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
            file.write_all(&head)?;
            PACK_HEADER_LEN
        } else {
            // Cut off anything left by a write that was interrupted (power cut).
            let (_, _, _, end) = scan_pack(&path)?;
            if end < file.metadata()?.len() {
                file.set_len(end)?;
            }
            end
        };
        self.unsynced.lock().unwrap().insert(path);
        Ok(Writer { n, file, end })
    }

    /// Append one object. `write` writes the object's bytes (it may seek back
    /// within the object, e.g. to fill in its header at the end).
    pub fn append<T>(
        &self,
        kind: ObjectKind,
        id: ObjectId,
        write: impl FnOnce(&mut EntryWriter) -> Result<T>,
    ) -> Result<(T, Location)> {
        if !self.writable {
            return Err(Error::Invalid("vault was opened read-only".into()));
        }
        let slot = self.writer_slot(kind)?;
        let mut guard = slot.lock().unwrap();
        if guard.as_ref().is_none_or(|w| w.end >= self.limit) {
            let next = match guard.as_ref() {
                Some(w) => (w.n + 1, true),
                None => match self.packs_on_disk(kind)?.last() {
                    Some(&last) => (last, false),
                    None => (1, true),
                },
            };
            let mut w = self.open_writer(kind, next.0, next.1)?;
            if w.end >= self.limit {
                w = self.open_writer(kind, next.0 + 1, true)?;
            }
            *guard = Some(w);
        }
        let w = guard.as_mut().unwrap();
        let start = w.end;
        let result = (|| -> Result<(T, u64)> {
            w.file.seek(SeekFrom::Start(start))?;
            let mut h = [0u8; ENTRY_HEADER_LEN as usize];
            h[..4].copy_from_slice(ENTRY_MAGIC);
            h[4..20].copy_from_slice(&id.0);
            w.file.write_all(&h)?;
            let base = start + ENTRY_HEADER_LEN;
            let out = write(&mut EntryWriter {
                file: &mut w.file,
                base,
            })?;
            let len = w.file.metadata()?.len().saturating_sub(base);
            if len == 0 {
                return Err(Error::Invalid("empty object".into()));
            }
            w.file.seek(SeekFrom::Start(start + 20))?;
            w.file.write_all(&len.to_le_bytes())?;
            Ok((out, len))
        })();
        match result {
            Ok((out, len)) => {
                let loc = Location {
                    kind,
                    pack: w.n,
                    offset: start + ENTRY_HEADER_LEN,
                    len,
                };
                w.end = loc.offset + len;
                self.unsynced.lock().unwrap().insert(self.path(kind, w.n));
                drop(guard);
                self.record(IndexChange::Put(id, loc));
                Ok((out, loc))
            }
            Err(e) => {
                // Leave the pack exactly as it was.
                let _ = w.file.set_len(start);
                Err(e)
            }
        }
    }

    /// Copy an already-encrypted object (from a loose file or another pack) unchanged.
    pub fn append_raw(
        &self,
        kind: ObjectKind,
        id: ObjectId,
        mut src: impl Read,
    ) -> Result<Location> {
        let ((), loc) = self.append(kind, id, |w| {
            io::copy(&mut src, w)?;
            Ok(())
        })?;
        Ok(loc)
    }

    /// Flush every pack written to since the last call. Called before the
    /// database (which points into the packs) is saved.
    pub fn sync(&self) -> Result<()> {
        let paths: Vec<PathBuf> = self.unsynced.lock().unwrap().drain().collect();
        for p in &paths {
            if let Ok(f) = OpenOptions::new().write(true).open(p) {
                f.sync_all()?;
            }
        }
        Ok(())
    }

    fn open_at(&self, id: &ObjectId, loc: &Location) -> Result<Option<Slice>> {
        let mut f = match File::open(self.path(loc.kind, loc.pack)) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        match read_entry_header(&mut f, loc.offset - ENTRY_HEADER_LEN)? {
            Some((eid, len)) if eid == *id && len == loc.len => {
                Ok(Some(Slice::new(f, loc.offset, loc.len)))
            }
            _ => Ok(None),
        }
    }

    /// Find an object: the index first, then (once) a full scan of the packs.
    pub fn open(&self, kind: ObjectKind, id: &ObjectId) -> Result<Option<Slice>> {
        let loc = self.index.lock().unwrap().get(id).copied();
        if let Some(loc) = loc
            && loc.kind == kind
            && let Some(s) = self.open_at(id, &loc)?
        {
            return Ok(Some(s));
        }
        // Index missing or stale (e.g. an older database backup): look in every pack.
        let mut scanned = self.scanned.lock().unwrap();
        if scanned.is_none() {
            *scanned = Some(self.scan_all()?);
        }
        let found = scanned.as_ref().unwrap().get(id).copied();
        drop(scanned);
        if let Some(loc) = found
            && loc.kind == kind
            && let Some(s) = self.open_at(id, &loc)?
        {
            if self.writable {
                self.record(IndexChange::Put(*id, loc));
            } else {
                self.index.lock().unwrap().insert(*id, loc);
            }
            return Ok(Some(s));
        }
        Ok(None)
    }

    /// Every object in every pack (later copies win).
    pub fn scan_all(&self) -> Result<HashMap<ObjectId, Location>> {
        let mut map = HashMap::new();
        for kind in [ObjectKind::Media, ObjectKind::Thumbnail] {
            for n in self.packs_on_disk(kind)? {
                if let Ok((_, _, entries, _)) = scan_pack(&self.path(kind, n)) {
                    map.extend(entries);
                }
            }
        }
        Ok(map)
    }

    pub fn remove(&self, id: &ObjectId) {
        if self.index.lock().unwrap().contains_key(id) {
            self.record(IndexChange::Remove(*id));
        }
    }

    pub fn ids(&self, kind: ObjectKind) -> Vec<ObjectId> {
        self.index
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, l)| l.kind == kind)
            .map(|(id, _)| *id)
            .collect()
    }

    /// Size on disk and live (still used) bytes per pack.
    pub fn usage(&self) -> Result<Vec<PackUsage>> {
        let idx = self.index.lock().unwrap();
        let mut live: HashMap<(u8, u32), (u64, usize)> = HashMap::new();
        for l in idx.values() {
            let e = live.entry((l.kind as u8, l.pack)).or_default();
            e.0 += l.len + ENTRY_HEADER_LEN;
            e.1 += 1;
        }
        drop(idx);
        let mut out = Vec::new();
        for kind in [ObjectKind::Media, ObjectKind::Thumbnail] {
            for n in self.packs_on_disk(kind)? {
                let size = fs::metadata(self.path(kind, n))
                    .map(|m| m.len())
                    .unwrap_or(0);
                let (live_bytes, objects) = live.get(&(kind as u8, n)).copied().unwrap_or((0, 0));
                out.push(PackUsage {
                    kind,
                    pack: n,
                    size,
                    live_bytes: live_bytes + PACK_HEADER_LEN.min(size),
                    objects,
                });
            }
        }
        Ok(out)
    }

    /// Copy the live objects out of packs that are mostly unused space into
    /// new packs. The old packs are NOT deleted here: the caller must first
    /// save the database (with the new locations) and then call
    /// [`PackStore::delete_retired`].
    pub fn compact(&self, min_waste: f64) -> Result<CompactPlan> {
        let mut plan = CompactPlan::default();
        for kind in [ObjectKind::Media, ObjectKind::Thumbnail] {
            // If the pack being written to is itself mostly waste, start a
            // fresh one so it can be reclaimed too.
            {
                let usage = self.usage()?;
                let mut guard = self.writer_slot(kind)?.lock().unwrap();
                if let Some(w) = guard.as_ref()
                    && let Some(u) = usage.iter().find(|u| u.kind == kind && u.pack == w.n)
                    && u.size > 0
                    && (u.size.saturating_sub(u.live_bytes)) as f64 / u.size as f64 >= min_waste
                {
                    let next = w.n + 1;
                    *guard = Some(self.open_writer(kind, next, true)?);
                }
            }
            // Packs being compacted must not be appended to meanwhile.
            let current = self
                .writer_slot(kind)?
                .lock()
                .unwrap()
                .as_ref()
                .map(|w| w.n);
            for u in self.usage()?.into_iter().filter(|u| u.kind == kind) {
                let waste = u.size.saturating_sub(u.live_bytes);
                let ratio = if u.size > 0 {
                    waste as f64 / u.size as f64
                } else {
                    0.0
                };
                if Some(u.pack) == current || waste == 0 || ratio < min_waste {
                    continue;
                }
                let entries: Vec<(ObjectId, Location)> = {
                    let idx = self.index.lock().unwrap();
                    let mut v: Vec<_> = idx
                        .iter()
                        .filter(|(_, l)| l.kind == kind && l.pack == u.pack)
                        .map(|(i, l)| (*i, *l))
                        .collect();
                    v.sort_by_key(|(_, l)| l.offset);
                    v
                };
                for (id, loc) in entries {
                    let src = self.open_at(&id, &loc)?.ok_or_else(|| {
                        Error::Corrupt(format!("object {id} missing from its pack"))
                    })?;
                    self.append_raw(kind, id, src)?;
                    plan.moved += 1;
                    plan.moved_bytes += loc.len;
                }
                plan.reclaimed_bytes += waste;
                plan.retired.push(self.path(kind, u.pack));
            }
        }
        // A pack that ended up being the target of the copies must not be retired.
        plan.retired.retain(|p| {
            let n = p.file_name().and_then(|n| n.to_str()).and_then(parse_pack_name);
            !matches!(n, Some((k, num)) if self.writer_slot(k).ok().and_then(|s| s.lock().unwrap().as_ref().map(|w| w.n)) == Some(num))
        });
        Ok(plan)
    }

    /// Delete packs that no index entry uses any more. Only call after the
    /// database with the current index has been saved.
    pub fn delete_retired(&self, plan: &CompactPlan) -> Result<()> {
        let used: HashSet<PathBuf> = self
            .index
            .lock()
            .unwrap()
            .values()
            .map(|l| self.path(l.kind, l.pack))
            .collect();
        for p in &plan.retired {
            if !used.contains(p) {
                fs::remove_file(p)?;
            }
        }
        *self.scanned.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PackUsage {
    pub kind: ObjectKind,
    pub pack: u32,
    pub size: u64,
    pub live_bytes: u64,
    pub objects: usize,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CompactPlan {
    pub moved: usize,
    pub moved_bytes: u64,
    pub reclaimed_bytes: u64,
    pub retired: Vec<PathBuf>,
}
