//! Treat a split archive (`name.7z.001`, `name.7z.002`, …) as one continuous file.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// If `path` is part of a split archive, return all parts in order.
/// Accepts any part (e.g. `.003`); the set always starts from `.001`.
/// Returns None if `path` is not a numbered part.
pub fn find_parts(path: &Path) -> io::Result<Option<Vec<PathBuf>>> {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return Ok(None),
    };
    let Some((base, num)) = name.rsplit_once('.') else { return Ok(None) };
    if num.len() < 3 || !num.chars().all(|c| c.is_ascii_digit()) {
        return Ok(None);
    }
    let width = num.len();
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut parts = Vec::new();
    for i in 1.. {
        let p = dir.join(format!("{base}.{i:0width$}"));
        if p.is_file() {
            parts.push(p);
        } else {
            break;
        }
    }
    if parts.is_empty() {
        return Err(io::Error::new(io::ErrorKind::NotFound, format!("first part {base}.{:0width$} is missing", 1)));
    }
    Ok(Some(parts))
}

/// Read + Seek over several files as if they were one.
pub struct MultiPartReader {
    files: Vec<File>,
    starts: Vec<u64>, // start offset of each part
    len: u64,
    pos: u64,
}

impl MultiPartReader {
    pub fn open(parts: &[PathBuf]) -> io::Result<Self> {
        let mut files = Vec::with_capacity(parts.len());
        let mut starts = Vec::with_capacity(parts.len());
        let mut len = 0;
        for p in parts {
            let f = File::open(p)?;
            starts.push(len);
            len += f.metadata()?.len();
            files.push(f);
        }
        Ok(Self { files, starts, len, pos: 0 })
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Read for MultiPartReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len || buf.is_empty() {
            return Ok(0);
        }
        let idx = self.starts.partition_point(|&s| s <= self.pos) - 1;
        let part_end = self.starts.get(idx + 1).copied().unwrap_or(self.len);
        let f = &mut self.files[idx];
        f.seek(SeekFrom::Start(self.pos - self.starts[idx]))?;
        let want = buf.len().min((part_end - self.pos) as usize);
        let n = f.read(&mut buf[..want])?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "archive part changed while reading"));
        }
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for MultiPartReader {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let new = match to {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::End(d) => self.len as i128 + d as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
        };
        if new < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = new as u64;
        Ok(self.pos)
    }
}
