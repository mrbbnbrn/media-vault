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

use std::io::{self, Read, Seek, SeekFrom, Write};

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto::{self, Key, NONCE_LEN, TAG_LEN};
use crate::error::{Error, Result};

pub const MAGIC: &[u8; 4] = b"MVOB";
pub const OBJECT_VERSION: u8 = 1;
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

fn fixed_head(kind: ObjectKind, chunk_log2: u8) -> [u8; 8] {
    [
        MAGIC[0],
        MAGIC[1],
        MAGIC[2],
        MAGIC[3],
        OBJECT_VERSION,
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

/// Streams plaintext in, writes an encrypted object out.
/// Data is buffered one chunk at a time, so memory use stays at ~2 chunks
/// regardless of file size.
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
        let fixed = fixed_head(kind, chunk_log2);
        let chunk_size = 1usize << chunk_log2;
        Ok(Self {
            inner,
            id,
            kind,
            chunk_log2,
            chunk_size,
            data_key: crypto::random_key(),
            prefix,
            aad: chunk_aad(&fixed, &prefix, &id),
            buf: Zeroizing::new(Vec::with_capacity(chunk_size * 2)),
            next_index: 0,
            total: 0,
            hasher: Sha256::new(),
        })
    }

    fn emit(&mut self, len: usize, last: bool) -> io::Result<()> {
        let nonce = chunk_nonce(&self.prefix, self.next_index, last)?;
        let ct = crypto::seal(&self.data_key, &nonce, &self.aad, &self.buf[..len]);
        self.inner.write_all(&ct)?;
        self.buf.drain(..len);
        self.next_index += 1;
        Ok(())
    }

    /// Encrypt the remaining data, write the header, and return length + SHA-256.
    pub fn finish(mut self, master: &Key) -> io::Result<(W, WrittenObject)> {
        let rest = self.buf.len();
        self.emit(rest, true)?;

        let mut header = [0u8; HEADER_LEN as usize];
        header[..8].copy_from_slice(&fixed_head(self.kind, self.chunk_log2));
        header[8..16].copy_from_slice(&self.total.to_le_bytes());
        header[16..23].copy_from_slice(&self.prefix);
        let wrap_aad = [&header[..23], &self.id.0[..]].concat();
        let (knonce, wrapped) = crypto::wrap_key(master, &self.data_key, &wrap_aad);
        header[23..35].copy_from_slice(&knonce);
        header[35..83].copy_from_slice(&wrapped);

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
        self.hasher.update(data);
        self.total += data.len() as u64;
        self.buf.extend_from_slice(data);
        // Keep at least one byte back so the final chunk is always the one
        // written by finish() with the "last" flag set.
        while self.buf.len() > self.chunk_size {
            self.emit(self.chunk_size, false)?;
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
    /// The exact size the encrypted file must have.
    pub fn expected_file_len(&self) -> u64 {
        HEADER_LEN + self.plaintext_len + self.chunk_count() * TAG_LEN as u64
    }
}

/// Random-access decrypting reader. Implements `Read + Seek`, so a video
/// player can jump anywhere and only the 1 MiB chunk it lands in is decrypted.
pub struct ObjectReader<R: Read + Seek> {
    inner: R,
    header: ObjectHeader,
    data_key: Key,
    prefix: [u8; PREFIX_LEN],
    aad: Vec<u8>,
    pos: u64,
    cached: Option<(u64, Zeroizing<Vec<u8>>)>,
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
        if h[4] != OBJECT_VERSION {
            return Err(Error::UnsupportedVersion(h[4] as u32));
        }
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
        let data_key = crypto::unwrap_key(master, &knonce, &h[35..83], &wrap_aad)
            .ok_or_else(|| Error::Corrupt(format!("object {id}: header failed authentication")))?;
        let fixed: [u8; 8] = h[..8].try_into().unwrap();
        Ok(Self {
            inner,
            header: ObjectHeader {
                kind,
                chunk_log2,
                plaintext_len,
            },
            data_key,
            aad: chunk_aad(&fixed, &prefix, &id),
            prefix,
            pos: 0,
            cached: None,
        })
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

    fn load_chunk(&mut self, index: u64) -> io::Result<()> {
        if matches!(&self.cached, Some((i, _)) if *i == index) {
            return Ok(());
        }
        let cs = self.header.chunk_size();
        let n = self.header.chunk_count();
        if index >= n {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "chunk out of range",
            ));
        }
        let last = index == n - 1;
        let plain = if last {
            self.header.plaintext_len - index * cs
        } else {
            cs
        };
        let mut ct = vec![0u8; (plain + TAG_LEN as u64) as usize];
        self.inner
            .seek(SeekFrom::Start(HEADER_LEN + index * (cs + TAG_LEN as u64)))?;
        self.inner.read_exact(&mut ct).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                io::Error::new(io::ErrorKind::InvalidData, "encrypted file is truncated")
            } else {
                e
            }
        })?;
        let nonce = chunk_nonce(&self.prefix, index, last)?;
        let pt = crypto::open(&self.data_key, &nonce, &self.aad, &ct).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("chunk {index} is damaged or was tampered with"),
            )
        })?;
        self.cached = Some((index, Zeroizing::new(pt)));
        Ok(())
    }

    /// One whole decrypted chunk (`index` counts from 0; see
    /// `ObjectHeader::chunk_count`). For callers that keep their own cache of
    /// chunks, e.g. to serve a video's byte ranges without decrypting the same
    /// chunk again for each request.
    pub fn read_chunk(&mut self, index: u64) -> io::Result<Zeroizing<Vec<u8>>> {
        self.load_chunk(index)?;
        Ok(self.cached.take().unwrap().1)
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
        for i in 0..self.header.chunk_count() {
            self.cached = None;
            self.load_chunk(i)
                .map_err(|e| Error::Corrupt(e.to_string()))?;
        }
        self.cached = None;
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
        let (_, data) = self.cached.as_ref().unwrap();
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
