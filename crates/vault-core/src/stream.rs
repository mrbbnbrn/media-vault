//! Encrypted object files (media, thumbnails, the database).
//!
//! Layout (all integers little-endian), see FORMAT.md for the full description:
//!
//! ```text
//! offset size
//!  0      4   magic "MVOB"
//!  4      1   format version (1)
//!  5      1   object kind (1 = media, 2 = thumbnail, 3 = database)
//!  6      1   log2(chunk size), normally 20 (= 1 MiB)
//!  7      1   reserved, 0
//!  8      8   plaintext length in bytes
//! 16      7   nonce prefix (random)
//! 23     12   nonce used to wrap the data key
//! 35     48   data key, AES-256-GCM-wrapped under the master key
//! 83     ..   chunks: AES-256-GCM(ciphertext || 16-byte tag), one per chunk
//! ```
//!
//! Chunk i uses nonce = prefix(7) || i as u32 big-endian (4) || last flag (1),
//! and associated data = header bytes 0..8 || nonce prefix || object id (16).
//! The key-wrap associated data = header bytes 0..23 || object id, which
//! authenticates the length and chunk size. Reordered, removed, appended or
//! modified chunks all fail authentication.
//!
//! Version 2 is the same layout **without encryption** (vaults made without
//! encryption): bytes 16..83 of the header are zero and the chunks are the
//! plain bytes, without tags. Media of such vaults isn't stored as objects at
//! all but as ordinary files ([`ObjectReader::raw`] reads those).

use std::io::{self, Read, Seek, SeekFrom, Write};

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto::{self, Key, NONCE_LEN, TAG_LEN};
use crate::error::{Error, Result};

pub const MAGIC: &[u8; 4] = b"MVOB";
pub const OBJECT_VERSION: u8 = 1;
/// The same layout, not encrypted.
pub const PLAIN_OBJECT_VERSION: u8 = 2;
pub const HEADER_LEN: u64 = 83;
pub const DEFAULT_CHUNK_LOG2: u8 = 20; // 1 MiB
const PREFIX_LEN: usize = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ObjectKind {
    Media = 1,
    Thumbnail = 2,
    Database = 3,
}

impl ObjectKind {
    fn from_u8(b: u8) -> Option<Self> {
        match b {
            1 => Some(Self::Media),
            2 => Some(Self::Thumbnail),
            3 => Some(Self::Database),
            _ => None,
        }
    }
}

/// 16-byte random identifier; shown as 32 hex characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ObjectId(pub [u8; 16]);

impl ObjectId {
    pub fn random() -> Self {
        Self(crypto::random_bytes::<16>())
    }
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
    pub fn from_hex(s: &str) -> Result<Self> {
        let v = hex::decode(s).map_err(|_| Error::Invalid(format!("bad object id {s:?}")))?;
        let arr: [u8; 16] = v
            .try_into()
            .map_err(|_| Error::Invalid(format!("bad object id {s:?}")))?;
        Ok(Self(arr))
    }
}

impl std::fmt::Display for ObjectId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_hex())
    }
}

fn chunk_nonce(prefix: &[u8; PREFIX_LEN], index: u64, last: bool) -> io::Result<[u8; NONCE_LEN]> {
    let idx: u32 = index
        .try_into()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "file too large"))?;
    let mut n = [0u8; NONCE_LEN];
    n[..PREFIX_LEN].copy_from_slice(prefix);
    n[PREFIX_LEN..PREFIX_LEN + 4].copy_from_slice(&idx.to_be_bytes());
    n[11] = last as u8;
    Ok(n)
}

fn fixed_head(kind: ObjectKind, chunk_log2: u8, plain: bool) -> [u8; 8] {
    [
        MAGIC[0],
        MAGIC[1],
        MAGIC[2],
        MAGIC[3],
        if plain { PLAIN_OBJECT_VERSION } else { OBJECT_VERSION },
        kind as u8,
        chunk_log2,
        0,
    ]
}

fn chunk_aad(fixed: &[u8; 8], prefix: &[u8; PREFIX_LEN], id: &ObjectId) -> Vec<u8> {
    [&fixed[..], &prefix[..], &id.0[..]].concat()
}

/// What `ObjectWriter::finish` returns.
#[derive(Debug, Clone)]
pub struct WrittenObject {
    pub plaintext_len: u64,
    pub sha256_hex: String,
}

/// At most this much plaintext is encrypted or decrypted at once, spread over
/// the processor's cores (several chunks of a big file at a time).
pub const PARALLEL_BYTES: usize = 8 << 20;

/// Cores used for encrypting and decrypting several chunks at once.
pub fn default_threads() -> usize {
    static N: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *N.get_or_init(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).clamp(1, 8))
}

/// `f(0..n)` on up to `threads` threads (the calling thread included),
/// results in order. `side` runs on the calling thread at the same time.
fn par_map<T: Send>(n: usize, threads: usize, f: impl Fn(usize) -> T + Sync, side: impl FnOnce()) -> Vec<T> {
    let threads = threads.clamp(1, n.max(1));
    if threads == 1 {
        side();
        return (0..n).map(f).collect();
    }
    let f = &f;
    let parts: Vec<Vec<(usize, T)>> = std::thread::scope(|sc| {
        let hs: Vec<_> = (1..threads)
            .map(|t| sc.spawn(move || (t..n).step_by(threads).map(|i| (i, f(i))).collect::<Vec<_>>()))
            .collect();
        side();
        let mut all = vec![(0..n).step_by(threads).map(|i| (i, f(i))).collect::<Vec<_>>()];
        for h in hs {
            match h.join() {
                Ok(v) => all.push(v),
                Err(p) => std::panic::resume_unwind(p),
            }
        }
        all
    });
    let mut out: Vec<Option<T>> = (0..n).map(|_| None).collect();
    for (i, v) in parts.into_iter().flatten() {
        out[i] = Some(v);
    }
    out.into_iter().map(|v| v.expect("every index was computed")).collect()
}

/// Streams plaintext in, writes an encrypted object out, reading the source
/// once: the SHA-256 of the plaintext is computed while it is encrypted. Big
/// files are encrypted several chunks at a time on all cores (and hashed on
/// the calling thread at the same time), so memory use stays at about
/// [`PARALLEL_BYTES`] regardless of file size. The output is exactly the same
/// as encrypting chunk by chunk.
pub struct ObjectWriter<W: Write + Seek> {
    inner: W,
    id: ObjectId,
    kind: ObjectKind,
    chunk_log2: u8,
    chunk_size: usize,
    data_key: Key,
    prefix: [u8; PREFIX_LEN],
    aad: Vec<u8>,
    buf: Zeroizing<Vec<u8>>,
    next_index: u64,
    total: u64,
    hasher: Sha256,
    threads: usize,
    /// Chunks encrypted at once.
    batch: usize,
    /// Written without encryption (format version 2).
    plain: bool,
}

impl<W: Write + Seek> ObjectWriter<W> {
    pub fn new(mut inner: W, id: ObjectId, kind: ObjectKind, chunk_log2: u8) -> io::Result<Self> {
        if !(12..=24).contains(&chunk_log2) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "chunk size must be 4 KiB..16 MiB",
            ));
        }
        inner.seek(SeekFrom::Start(0))?;
        inner.write_all(&[0u8; HEADER_LEN as usize])?; // placeholder, filled in by finish()
        let prefix = crypto::random_bytes::<PREFIX_LEN>();
        let fixed = fixed_head(kind, chunk_log2, false);
        let chunk_size = 1usize << chunk_log2;
        let mut w = Self {
            inner,
            id,
            kind,
            chunk_log2,
            chunk_size,
            data_key: crypto::random_key(),
            prefix,
            aad: chunk_aad(&fixed, &prefix, &id),
            buf: Zeroizing::new(Vec::new()),
            next_index: 0,
            total: 0,
            hasher: Sha256::new(),
            threads: 1,
            batch: 1,
            plain: false,
        };
        w.set_threads(default_threads());
        Ok(w)
    }

    /// Write this object without encryption (format version 2). Only before writing anything.
    pub fn set_plain(&mut self, plain: bool) {
        if self.total == 0 {
            self.plain = plain;
        }
    }

    /// How many cores to encrypt on (1 = one chunk at a time, for callers
    /// that already run several writers at once). Only before writing anything.
    pub fn set_threads(&mut self, threads: usize) {
        if self.total > 0 {
            return;
        }
        self.threads = threads.max(1);
        self.batch = if self.threads == 1 { 1 } else { (PARALLEL_BYTES / self.chunk_size).clamp(1, 64) };
    }

    /// Make room for `extra` more bytes. The buffer grows by moving to a
    /// bigger one and wiping the old one, so no stray copies of plaintext are
    /// left behind (small objects such as thumbnails never get a big buffer).
    fn reserve(&mut self, extra: usize) {
        let need = self.buf.len() + extra;
        if need <= self.buf.capacity() {
            return;
        }
        let most = self.chunk_size * self.batch + 1;
        let cap = need.max(self.buf.capacity() * 2).max(64 << 10).min(most.max(need));
        let mut b = Zeroizing::new(Vec::with_capacity(cap));
        b.extend_from_slice(&self.buf);
        self.buf = b; // the old one is wiped as it is dropped
    }

    /// Encrypt and write `full` whole chunks from the front of the buffer,
    /// then (if `last`) everything after them as the final chunk. The
    /// plaintext is hashed at the same time.
    fn emit(&mut self, full: usize, last: bool) -> io::Result<()> {
        let cs = self.chunk_size;
        let n = full + last as usize;
        let take = if last { self.buf.len() } else { full * cs };
        if self.plain {
            self.hasher.update(&self.buf[..take]);
            self.inner.write_all(&self.buf[..take])?;
            self.buf.drain(..take);
            self.next_index += n as u64;
            return Ok(());
        }
        let first = self.next_index;
        let nonces = (0..n)
            .map(|k| chunk_nonce(&self.prefix, first + k as u64, last && k == full))
            .collect::<io::Result<Vec<_>>>()?;
        let (data, key, aad, hasher) = (&self.buf[..take], &self.data_key, &self.aad, &mut self.hasher);
        let sealed = par_map(
            n,
            self.threads,
            |k| {
                let end = if k == full { take } else { (k + 1) * cs };
                crypto::seal(key, &nonces[k], aad, &data[k * cs..end])
            },
            || hasher.update(data),
        );
        for ct in &sealed {
            self.inner.write_all(ct)?;
        }
        self.buf.drain(..take);
        self.next_index += n as u64;
        Ok(())
    }

    /// Encrypt the remaining data, write the header, and return length + SHA-256.
    pub fn finish(mut self, master: &Key) -> io::Result<(W, WrittenObject)> {
        // The final chunk always carries the "last" flag (an empty file is one empty chunk).
        let full = self.buf.len().saturating_sub(1) / self.chunk_size;
        self.emit(full, true)?;

        let mut header = [0u8; HEADER_LEN as usize];
        header[..8].copy_from_slice(&fixed_head(self.kind, self.chunk_log2, self.plain));
        header[8..16].copy_from_slice(&self.total.to_le_bytes());
        if !self.plain {
            header[16..23].copy_from_slice(&self.prefix);
            let wrap_aad = [&header[..23], &self.id.0[..]].concat();
            let (knonce, wrapped) = crypto::wrap_key(master, &self.data_key, &wrap_aad);
            header[23..35].copy_from_slice(&knonce);
            header[35..83].copy_from_slice(&wrapped);
        }

        self.inner.seek(SeekFrom::Start(0))?;
        self.inner.write_all(&header)?;
        self.inner.flush()?;
        let digest = std::mem::take(&mut self.hasher).finalize();
        let out = WrittenObject {
            plaintext_len: self.total,
            sha256_hex: hex::encode(digest),
        };
        Ok((self.inner, out))
    }
}

impl<W: Write + Seek> Write for ObjectWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.total += data.len() as u64;
        let limit = self.chunk_size * self.batch;
        let mut rest = data;
        while !rest.is_empty() {
            // Never more than one batch plus one byte in the buffer.
            let room = (limit + 1 - self.buf.len()).min(rest.len());
            let (now, later) = rest.split_at(room);
            self.reserve(now.len());
            self.buf.extend_from_slice(now);
            rest = later;
            // Keep at least one byte back so the final chunk is always the one
            // written by finish() with the "last" flag set.
            if self.buf.len() > limit {
                self.emit(self.batch, false)?;
            }
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Parsed header of an encrypted object.
#[derive(Debug, Clone)]
pub struct ObjectHeader {
    pub kind: ObjectKind,
    pub chunk_log2: u8,
    pub plaintext_len: u64,
    /// Not encrypted (format version 2, or an ordinary media file).
    pub plain: bool,
    /// Where the data starts in the file (HEADER_LEN; 0 for an ordinary file).
    pub base: u64,
}

impl ObjectHeader {
    pub fn chunk_size(&self) -> u64 {
        1u64 << self.chunk_log2
    }
    pub fn chunk_count(&self) -> u64 {
        if self.plaintext_len == 0 {
            1
        } else {
            self.plaintext_len.div_ceil(self.chunk_size())
        }
    }
    fn tag_len(&self) -> u64 {
        if self.plain { 0 } else { TAG_LEN as u64 }
    }
    /// The exact size the object file must have.
    pub fn expected_file_len(&self) -> u64 {
        self.base + self.plaintext_len + self.chunk_count() * self.tag_len()
    }
}

/// Random-access decrypting reader. Implements `Read + Seek`, so a video
/// player can jump anywhere and only the 1 MiB chunk it lands in is decrypted.
/// Reading on from chunk to chunk (export, sharing, analysing, checking)
/// decrypts the next few chunks ahead at once on all cores, up to
/// [`PARALLEL_BYTES`] at a time.
pub struct ObjectReader<R: Read + Seek> {
    inner: R,
    header: ObjectHeader,
    data_key: Key,
    prefix: [u8; PREFIX_LEN],
    aad: Vec<u8>,
    pos: u64,
    /// Decrypted chunks (consecutive, the first one's index).
    cached: Option<(u64, Vec<Zeroizing<Vec<u8>>>)>,
    /// The chunk right after the last ones decrypted, and how many were.
    next: u64,
    ahead: u64,
    threads: usize,
}

impl<R: Read + Seek> ObjectReader<R> {
    pub fn open(
        mut inner: R,
        master: &Key,
        id: ObjectId,
        expected_kind: Option<ObjectKind>,
    ) -> Result<Self> {
        let mut h = [0u8; HEADER_LEN as usize];
        inner.seek(SeekFrom::Start(0))?;
        inner.read_exact(&mut h).map_err(|e| match e.kind() {
            io::ErrorKind::UnexpectedEof => Error::Corrupt(format!("object {id} is truncated")),
            _ => Error::Io(e),
        })?;
        if &h[..4] != MAGIC {
            return Err(Error::Corrupt(format!("object {id} has no valid header")));
        }
        if h[4] != OBJECT_VERSION && h[4] != PLAIN_OBJECT_VERSION {
            return Err(Error::UnsupportedVersion(h[4] as u32));
        }
        let plain = h[4] == PLAIN_OBJECT_VERSION;
        let kind = ObjectKind::from_u8(h[5])
            .ok_or_else(|| Error::Corrupt(format!("object {id}: unknown kind")))?;
        if let Some(k) = expected_kind
            && k != kind
        {
            return Err(Error::Corrupt(format!(
                "object {id} is a {kind:?}, expected {k:?}"
            )));
        }
        let chunk_log2 = h[6];
        if !(12..=24).contains(&chunk_log2) {
            return Err(Error::Corrupt(format!("object {id}: bad chunk size")));
        }
        let plaintext_len = u64::from_le_bytes(h[8..16].try_into().unwrap());
        let prefix: [u8; PREFIX_LEN] = h[16..23].try_into().unwrap();
        let knonce: [u8; NONCE_LEN] = h[23..35].try_into().unwrap();
        let wrap_aad = [&h[..23], &id.0[..]].concat();
        let data_key = if plain {
            crypto::random_key() // never used
        } else {
            crypto::unwrap_key(master, &knonce, &h[35..83], &wrap_aad)
                .ok_or_else(|| Error::Corrupt(format!("object {id}: header failed authentication")))?
        };
        let fixed: [u8; 8] = h[..8].try_into().unwrap();
        Ok(Self {
            inner,
            header: ObjectHeader {
                kind,
                chunk_log2,
                plaintext_len,
                plain,
                base: HEADER_LEN,
            },
            data_key,
            aad: chunk_aad(&fixed, &prefix, &id),
            prefix,
            pos: 0,
            cached: None,
            next: u64::MAX,
            ahead: 0,
            threads: default_threads(),
        })
    }

    /// An ordinary (unencrypted) file of `len` bytes read as an object: the
    /// media of a vault without encryption.
    pub fn raw(inner: R, len: u64, kind: ObjectKind) -> Self {
        Self {
            inner,
            header: ObjectHeader { kind, chunk_log2: DEFAULT_CHUNK_LOG2, plaintext_len: len, plain: true, base: 0 },
            data_key: crypto::random_key(), // never used
            prefix: [0; PREFIX_LEN],
            aad: Vec::new(),
            pos: 0,
            cached: None,
            next: u64::MAX,
            ahead: 0,
            threads: 1,
        }
    }

    /// Not encrypted (format version 2, or an ordinary file).
    pub fn is_plain(&self) -> bool {
        self.header.plain
    }

    /// How many cores to decrypt on (1 = one chunk at a time).
    pub fn set_threads(&mut self, threads: usize) {
        self.threads = threads.max(1);
    }

    pub fn header(&self) -> &ObjectHeader {
        &self.header
    }

    pub fn len(&self) -> u64 {
        self.header.plaintext_len
    }

    pub fn is_empty(&self) -> bool {
        self.header.plaintext_len == 0
    }

    fn cached_chunk(&self, index: u64) -> Option<&Zeroizing<Vec<u8>>> {
        let (first, v) = self.cached.as_ref()?;
        v.get(usize::try_from(index.checked_sub(*first)?).ok()?)
    }

    /// Most chunks decrypted at once.
    fn max_run(&self) -> u64 {
        (PARALLEL_BYTES as u64 / self.header.chunk_size()).max(1)
    }

    /// Decrypt up to `count` chunks from `first` on (fewer at the end of the
    /// object): one read from the file, then on several cores.
    fn decrypt_run(&mut self, first: u64, count: u64) -> io::Result<Vec<Zeroizing<Vec<u8>>>> {
        let cs = self.header.chunk_size();
        let n = self.header.chunk_count();
        if first >= n {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "chunk out of range",
            ));
        }
        let count = count.clamp(1, n - first);
        let len = self.header.plaintext_len;
        let plain = |i: u64| (len.min((i + 1) * cs) - (i * cs).min(len)) as usize;
        let tag = self.header.tag_len();
        if self.header.plain {
            // Not encrypted: the bytes as they are, cut into chunks.
            self.inner.seek(SeekFrom::Start(self.header.base + first * cs))?;
            let mut out = Vec::with_capacity(count as usize);
            for i in first..first + count {
                let mut b = Zeroizing::new(vec![0u8; plain(i)]);
                self.inner.read_exact(&mut b).map_err(|e| {
                    if e.kind() == io::ErrorKind::UnexpectedEof {
                        io::Error::new(io::ErrorKind::InvalidData, "file is truncated")
                    } else {
                        e
                    }
                })?;
                out.push(b);
            }
            return Ok(out);
        }
        let sizes: Vec<usize> = (first..first + count).map(|i| plain(i) + tag as usize).collect();
        let mut ct = vec![0u8; sizes.iter().sum()];
        self.inner
            .seek(SeekFrom::Start(self.header.base + first * (cs + tag)))?;
        self.inner.read_exact(&mut ct).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                io::Error::new(io::ErrorKind::InvalidData, "encrypted file is truncated")
            } else {
                e
            }
        })?;
        let nonces = (first..first + count)
            .map(|i| chunk_nonce(&self.prefix, i, i == n - 1))
            .collect::<io::Result<Vec<_>>>()?;
        let mut starts = Vec::with_capacity(sizes.len());
        let mut at = 0;
        for s in &sizes {
            starts.push(at);
            at += s;
        }
        let (key, aad, ct) = (&self.data_key, &self.aad, &ct);
        let threads = if count > 1 { self.threads } else { 1 };
        let plain = par_map(
            count as usize,
            threads,
            |k| crypto::open(key, &nonces[k], aad, &ct[starts[k]..starts[k] + sizes[k]]).map(Zeroizing::new),
            || {},
        );
        plain
            .into_iter()
            .enumerate()
            .map(|(k, p)| {
                p.ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("chunk {} is damaged or was tampered with", first + k as u64),
                    )
                })
            })
            .collect()
    }

    fn load_chunk(&mut self, index: u64) -> io::Result<()> {
        if self.cached_chunk(index).is_some() {
            return Ok(());
        }
        // Reading on from where the last chunks ended: decrypt more ahead each time.
        let count = if index == self.next && self.threads > 1 { (self.ahead * 2).clamp(1, self.max_run()) } else { 1 };
        self.cached = None;
        let v = self.decrypt_run(index, count)?;
        self.ahead = v.len() as u64;
        self.next = index + self.ahead;
        self.cached = Some((index, v));
        Ok(())
    }

    /// One whole decrypted chunk (`index` counts from 0; see
    /// `ObjectHeader::chunk_count`). For callers that keep their own cache of
    /// chunks, e.g. to serve a video's byte ranges without decrypting the same
    /// chunk again for each request.
    pub fn read_chunk(&mut self, index: u64) -> io::Result<Zeroizing<Vec<u8>>> {
        self.load_chunk(index)?;
        let (first, mut v) = self.cached.take().expect("loaded above");
        let rest = v.split_off((index - first) as usize + 1);
        let chunk = v.pop().expect("loaded above");
        if !rest.is_empty() {
            self.cached = Some((index + 1, rest));
        }
        Ok(chunk)
    }

    /// Chunks `first..first + count` (fewer at the end), decrypted at once on
    /// several cores.
    pub fn read_chunks(&mut self, first: u64, count: u64) -> io::Result<Vec<Zeroizing<Vec<u8>>>> {
        let mut out = Vec::new();
        if count == 0 {
            return Ok(out);
        }
        let max = self.max_run();
        let end = self.header.chunk_count().min(first.saturating_add(count));
        if first >= end {
            return self.decrypt_run(first, 1); // out of range: the error
        }
        let mut i = first;
        while i < end {
            let v = self.decrypt_run(i, (end - i).min(max))?;
            i += v.len() as u64;
            out.extend(v);
        }
        Ok(out)
    }

    /// Decrypt and authenticate every chunk, and check there are no extra
    /// bytes at the end. Used by the integrity check.
    pub fn verify_all(&mut self) -> Result<()> {
        let actual = self.inner.seek(SeekFrom::End(0))?;
        let expected = self.header.expected_file_len();
        if actual != expected {
            return Err(Error::Corrupt(format!(
                "file is {actual} bytes, expected {expected}"
            )));
        }
        self.cached = None;
        let (n, max) = (self.header.chunk_count(), self.max_run());
        let mut i = 0;
        while i < n {
            let done = self.decrypt_run(i, max).map_err(|e| Error::Corrupt(e.to_string()))?;
            i += done.len() as u64;
        }
        Ok(())
    }

    pub fn into_inner(self) -> R {
        self.inner
    }
}

impl<R: Read + Seek> Read for ObjectReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.header.plaintext_len || out.is_empty() {
            // Make sure even an empty object is authenticated on first read.
            if self.header.plaintext_len == 0 {
                self.load_chunk(0)?;
            }
            return Ok(0);
        }
        let cs = self.header.chunk_size();
        let index = self.pos / cs;
        self.load_chunk(index)?;
        let data = self.cached_chunk(index).expect("loaded above");
        let off = (self.pos - index * cs) as usize;
        let n = out.len().min(data.len() - off);
        out[..n].copy_from_slice(&data[off..off + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl<R: Read + Seek> Seek for ObjectReader<R> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let len = self.header.plaintext_len as i128;
        let new = match to {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::End(d) => len + d as i128,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn data(len: usize) -> Vec<u8> {
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect()
    }

    fn write(plain: &[u8], log2: u8, threads: usize, piece: usize) -> (Key, ObjectId, Vec<u8>, WrittenObject) {
        let master = crypto::random_key();
        let id = ObjectId::random();
        let mut w = ObjectWriter::new(Cursor::new(Vec::new()), id, ObjectKind::Media, log2).unwrap();
        w.set_threads(threads);
        for p in plain.chunks(piece.max(1)) {
            w.write_all(p).unwrap();
        }
        let (cur, done) = w.finish(&master).unwrap();
        (master, id, cur.into_inner(), done)
    }

    #[test]
    fn parallel_and_one_at_a_time_agree_both_ways() {
        let cs = 1usize << 12;
        let batch = PARALLEL_BYTES / cs;
        for len in [0, 1, cs - 1, cs, cs + 1, 3 * cs, batch * cs, batch * cs + 1, batch * cs * 2 + 7, 70 * cs + 5] {
            let plain = data(len);
            let want = hex::encode(Sha256::digest(&plain));
            for (wt, piece) in [(1, 8192), (4, 8192), (3, 1), (4, 1 << 20), (2, len + 1)] {
                if piece == 1 && len > 4 * cs {
                    continue;
                }
                let (master, id, enc, done) = write(&plain, 12, wt, piece);
                assert_eq!(done.sha256_hex, want, "len {len} threads {wt}");
                assert_eq!(done.plaintext_len, len as u64);
                let head = ObjectHeader { kind: ObjectKind::Media, chunk_log2: 12, plaintext_len: len as u64, plain: false, base: HEADER_LEN };
                assert_eq!(enc.len() as u64, head.expected_file_len());
                for rt in [1, 4] {
                    let mut r = ObjectReader::open(Cursor::new(&enc), &master, id, None).unwrap();
                    r.set_threads(rt);
                    let mut back = Vec::new();
                    r.read_to_end(&mut back).unwrap();
                    assert!(back == plain, "len {len} write threads {wt} read threads {rt}");
                    r.verify_all().unwrap();
                }
            }
        }
    }

    #[test]
    fn reading_ahead_keeps_random_access_and_chunk_reads_right() {
        let cs = 1usize << 12;
        let plain = data(40 * cs + 123);
        let (master, id, enc, _) = write(&plain, 12, 4, 65536);
        let mut r = ObjectReader::open(Cursor::new(&enc), &master, id, None).unwrap();
        r.set_threads(4);
        // Sequential, then jumping around, then on again.
        let mut buf = vec![0u8; 3000];
        for at in [0usize, 3000, 6000, 9000, 39 * cs, 5, 20 * cs - 10, 20 * cs + 2990, 40 * cs + 100] {
            r.seek(SeekFrom::Start(at as u64)).unwrap();
            let n = r.read(&mut buf).unwrap();
            assert!(n > 0);
            assert_eq!(&buf[..n], &plain[at..at + n], "at {at}");
        }
        for i in [0u64, 1, 2, 3, 7, 8, 9, 40, 12] {
            let c = r.read_chunk(i).unwrap();
            let s = i as usize * cs;
            assert_eq!(&c[..], &plain[s..(s + cs).min(plain.len())], "chunk {i}");
        }
        let many = r.read_chunks(38, 10).unwrap();
        assert_eq!(many.len(), 3);
        assert_eq!(many.iter().flat_map(|c| c.iter().copied()).collect::<Vec<u8>>(), plain[38 * cs..]);
        assert!(r.read_chunks(41, 1).is_err());
        assert!(r.read_chunks(0, 0).unwrap().is_empty());
        // One damaged chunk in the middle of a run is found, not skipped.
        let mut bad = enc.clone();
        bad[HEADER_LEN as usize + 13 * (cs + TAG_LEN) + 5] ^= 1;
        let mut r = ObjectReader::open(Cursor::new(&bad), &master, id, None).unwrap();
        r.set_threads(4);
        let mut back = Vec::new();
        let err = r.read_to_end(&mut back).unwrap_err();
        assert!(err.to_string().contains("chunk 13"), "{err}");
        assert!(back.len() <= 13 * cs);
        let mut r = ObjectReader::open(Cursor::new(&bad), &master, id, None).unwrap();
        assert!(r.verify_all().is_err());
    }

    #[test]
    fn plain_objects_round_trip_and_are_readable_as_they_are() {
        for len in [0usize, 1, 4095, 4096, 4097, 3 * 4096 + 5] {
            let plain = data(len);
            let id = ObjectId::random();
            let mut w = ObjectWriter::new(Cursor::new(Vec::new()), id, ObjectKind::Thumbnail, 12).unwrap();
            w.set_plain(true);
            w.write_all(&plain).unwrap();
            let master = crypto::random_key();
            let (cur, done) = w.finish(&master).unwrap();
            assert_eq!(done.sha256_hex, hex::encode(Sha256::digest(&plain)));
            let bytes = cur.into_inner();
            assert_eq!(bytes[4], PLAIN_OBJECT_VERSION);
            assert_eq!(&bytes[HEADER_LEN as usize..], &plain[..], "the bytes as they are");
            // Any key reads it (there's nothing to decrypt).
            let other = crypto::random_key();
            let mut r = ObjectReader::open(Cursor::new(bytes), &other, id, Some(ObjectKind::Thumbnail)).unwrap();
            assert!(r.is_plain());
            let mut back = Vec::new();
            r.read_to_end(&mut back).unwrap();
            assert_eq!(back, plain);
            r.verify_all().unwrap();
            // An ordinary file, with seeking.
            let mut raw = ObjectReader::raw(Cursor::new(plain.clone()), len as u64, ObjectKind::Media);
            if len > 10 {
                raw.seek(SeekFrom::Start(len as u64 - 10)).unwrap();
                let mut tail = Vec::new();
                raw.read_to_end(&mut tail).unwrap();
                assert_eq!(tail, plain[len - 10..]);
            }
            raw.verify_all().unwrap();
        }
    }
}
