//! "Remove camera info, location and dates from files I export or share."
//!
//! When the setting is on, every way a file leaves the vault (export, the
//! encrypted .7z, drag-out and copy to Explorer) goes through [`open`]:
//!
//! - Pictures (JPEG, PNG, WebP, GIF) are cleaned whole in memory (they are
//!   small) and handed out from there. Camera make/model, GPS, dates, XMP,
//!   IPTC, comments and embedded thumbnails go; what is needed to show the
//!   picture the same way stays (colour profile, JFIF, the EXIF orientation).
//! - MP4/MOV/M4V videos are never loaded whole: their metadata boxes (udta,
//!   meta, XMP) are blanked in place into `free` boxes of the same size and
//!   the creation/modification times are zeroed while the file streams. The
//!   length and every offset stay the same, so nothing else needs fixing.
//! - Other files pass through unchanged.
//!
//! Nothing is written to disk; decrypted picture bytes are wiped from memory
//! when they are dropped.

use std::io::{self, Cursor, Read, Seek, SeekFrom};

use zeroize::Zeroizing;

pub trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Picture,
    Video,
    Other,
}

/// What kind of cleaning a file gets, by its name.
pub fn class_of(name: &str) -> Class {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "jpe" | "jfif" | "png" | "apng" | "webp" | "gif" => Class::Picture,
        "mp4" | "m4v" | "mov" => Class::Video,
        _ => Class::Other,
    }
}

/// Cleaning may change the length of this file (pictures). Videos and other
/// files keep theirs.
pub fn changes_length(name: &str) -> bool {
    class_of(name) == Class::Picture
}

/// Bigger pictures are refused rather than handed out with their metadata.
const MAX_PICTURE: u64 = 1 << 30;

/// A cleaned view of `r` (positioned anywhere) and its length.
pub fn open<'a, R: Read + Seek + 'a>(mut r: R, name: &str) -> io::Result<(Box<dyn ReadSeek + 'a>, u64)> {
    let len = r.seek(SeekFrom::End(0))?;
    r.seek(SeekFrom::Start(0))?;
    match class_of(name) {
        Class::Picture => {
            if len > MAX_PICTURE {
                return Err(io::Error::other("it is too large to remove its camera info"));
            }
            let mut data = Zeroizing::new(Vec::with_capacity(len as usize));
            r.read_to_end(&mut data)?;
            let out = match clean_picture(&data) {
                Some(v) => Zeroizing::new(v),
                None => data,
            };
            let n = out.len() as u64;
            Ok((Box::new(Cursor::new(out)), n))
        }
        Class::Video => {
            let patches = video_patches(&mut r, len)?;
            r.seek(SeekFrom::Start(0))?;
            Ok((Box::new(Patched { inner: r, patches, pos: 0 }), len))
        }
        Class::Other => Ok((Box::new(r), len)),
    }
}

/// `r` as it is, or cleaned when `on` (the setting). For export and sharing.
pub fn maybe<'a, R: Read + Seek + 'a>(r: R, name: &str, on: bool) -> Result<Box<dyn ReadSeek + 'a>, String> {
    if !on {
        return Ok(Box::new(r));
    }
    open(r, name).map(|(r, _)| r).map_err(|e| format!("couldn't remove its camera info ({e})"))
}

/// The cleaned bytes of a picture, by its content (None = not a picture
/// format we know; it is then left as it is).
pub fn clean_picture(d: &[u8]) -> Option<Vec<u8>> {
    if d.starts_with(&[0xFF, 0xD8, 0xFF]) {
        clean_jpeg(d)
    } else if d.starts_with(&PNG_SIG) {
        clean_png(d)
    } else if d.len() >= 12 && &d[..4] == b"RIFF" && &d[8..12] == b"WEBP" {
        clean_webp(d)
    } else if d.starts_with(b"GIF87a") || d.starts_with(b"GIF89a") {
        clean_gif(d)
    } else {
        None
    }
}

// ---- JPEG --------------------------------------------------------------------------

/// Keeps APP0 JFIF, APP2 ICC profile and APP14 Adobe (colour transform, needed
/// to show CMYK pictures right); drops every other APPn (EXIF, XMP, IPTC,
/// MPF…), comments and anything after the end of the picture. A turned
/// picture gets a minimal EXIF with only its orientation back.
pub fn clean_jpeg(d: &[u8]) -> Option<Vec<u8>> {
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    let mut out = Vec::with_capacity(d.len());
    out.extend_from_slice(&d[..2]);
    let mut orientation = 1u16;
    let mut insert_at = 2usize;
    let mut i = 2usize;
    while i < d.len() {
        if d[i] != 0xFF {
            // Not a marker where one should be: keep the rest as it is.
            out.extend_from_slice(&d[i..]);
            break;
        }
        let mut j = i + 1;
        while j < d.len() && d[j] == 0xFF {
            j += 1; // fill bytes
        }
        let Some(&m) = d.get(j) else { break };
        match m {
            0xD9 => {
                out.extend_from_slice(&[0xFF, 0xD9]);
                break; // the end: whatever trails (extra pictures, motion clips) is dropped
            }
            0x01 | 0xD0..=0xD8 => {
                out.extend_from_slice(&[0xFF, m]);
                i = j + 1;
            }
            _ => {
                let Some(l) = d.get(j + 1..j + 3).map(|b| u16::from_be_bytes([b[0], b[1]]) as usize) else {
                    break;
                };
                if l < 2 || j + 1 + l > d.len() {
                    // Cut short: keep what is there unless it is metadata.
                    if !(0xE0..=0xEF).contains(&m) && m != 0xFE {
                        out.extend_from_slice(&d[j - 1..]);
                    }
                    break;
                }
                let payload = &d[j + 3..j + 1 + l];
                let keep = match m {
                    0xE0 => payload.starts_with(b"JFIF\0"),
                    0xE1 => {
                        if payload.starts_with(b"Exif\0\0")
                            && let Some(o) = exif_orientation(&payload[6..])
                        {
                            orientation = o;
                        }
                        false
                    }
                    0xE2 => payload.starts_with(b"ICC_PROFILE\0"),
                    0xEE => payload.starts_with(b"Adobe"),
                    0xE3..=0xEF | 0xFE => false,
                    _ => true,
                };
                if keep {
                    let first = out.len() == 2;
                    out.push(0xFF);
                    out.extend_from_slice(&d[j..j + 1 + l]);
                    if m == 0xE0 && first {
                        insert_at = out.len();
                    }
                }
                i = j + 1 + l;
                if m == 0xDA {
                    // Entropy-coded data runs until the next real marker.
                    let mut k = i;
                    while k + 1 < d.len() {
                        if d[k] == 0xFF {
                            match d[k + 1] {
                                0x00 | 0xD0..=0xD7 => {
                                    k += 2;
                                    continue;
                                }
                                0xFF => {
                                    k += 1;
                                    continue;
                                }
                                _ => break,
                            }
                        }
                        k += 1;
                    }
                    if k + 1 >= d.len() {
                        out.extend_from_slice(&d[i..]); // no end marker: keep it all
                        break;
                    }
                    out.extend_from_slice(&d[i..k]);
                    i = k;
                }
            }
        }
    }
    if (2..=8).contains(&orientation) {
        let exif = minimal_exif(orientation);
        out.splice(insert_at..insert_at, exif);
    }
    Some(out)
}

/// The orientation (tag 0x0112) in IFD0 of an EXIF TIFF block.
fn exif_orientation(t: &[u8]) -> Option<u16> {
    let be = match t.get(..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let u16_at = |o: usize| t.get(o..o + 2).map(|b| if be { u16::from_be_bytes([b[0], b[1]]) } else { u16::from_le_bytes([b[0], b[1]]) });
    let u32_at = |o: usize| {
        t.get(o..o + 4).map(|b| {
            let a = [b[0], b[1], b[2], b[3]];
            if be { u32::from_be_bytes(a) } else { u32::from_le_bytes(a) }
        })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let n = u16_at(ifd)? as usize;
    for k in 0..n.min(1024) {
        let e = ifd + 2 + k * 12;
        if u16_at(e)? == 0x0112 {
            return match u16_at(e + 2)? {
                3 => u16_at(e + 8),
                4 => u32_at(e + 8).and_then(|v| u16::try_from(v).ok()),
                _ => None,
            };
        }
    }
    None
}

/// APP1 with an EXIF block that holds only the orientation.
fn minimal_exif(orientation: u16) -> Vec<u8> {
    let mut p = vec![0xFF, 0xE1, 0, 34];
    p.extend_from_slice(b"Exif\0\0");
    p.extend_from_slice(b"MM\0\x2A\0\0\0\x08"); // big-endian TIFF, IFD0 at 8
    p.extend_from_slice(&[0, 1]); // one entry
    p.extend_from_slice(&[0x01, 0x12, 0, 3, 0, 0, 0, 1]); // Orientation, SHORT, 1
    p.extend_from_slice(&orientation.to_be_bytes());
    p.extend_from_slice(&[0, 0]);
    p.extend_from_slice(&[0, 0, 0, 0]); // no next IFD
    p
}

// ---- PNG ---------------------------------------------------------------------------

const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Ancillary chunks that only describe how to show the picture (colour,
/// transparency, pixel size, animation). Everything else ancillary —
/// eXIf, tEXt, zTXt, iTXt, tIME and private chunks — is dropped.
const PNG_KEEP: [&[u8; 4]; 16] = [
    b"tRNS", b"cHRM", b"gAMA", b"iCCP", b"sBIT", b"sRGB", b"cICP", b"mDCV", b"cLLI", b"bKGD", b"hIST", b"pHYs", b"sPLT",
    b"acTL", b"fcTL", b"fdAT",
];

pub fn clean_png(d: &[u8]) -> Option<Vec<u8>> {
    if !d.starts_with(&PNG_SIG) {
        return None;
    }
    let mut out = Vec::with_capacity(d.len());
    out.extend_from_slice(&PNG_SIG);
    let mut i = 8;
    while i + 12 <= d.len() {
        let len = u32::from_be_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]) as usize;
        let ty: [u8; 4] = [d[i + 4], d[i + 5], d[i + 6], d[i + 7]];
        let keep = ty[0].is_ascii_uppercase() || PNG_KEEP.contains(&&ty);
        let end = i.saturating_add(12).saturating_add(len);
        if end > d.len() {
            if keep {
                out.extend_from_slice(&d[i..]);
            }
            break;
        }
        if keep {
            out.extend_from_slice(&d[i..end]);
        }
        i = end;
        if &ty == b"IEND" {
            break;
        }
    }
    Some(out)
}

// ---- WebP --------------------------------------------------------------------------

const WEBP_KEEP: [&[u8; 4]; 7] = [b"VP8 ", b"VP8L", b"VP8X", b"ALPH", b"ANIM", b"ANMF", b"ICCP"];

/// Drops EXIF, XMP and unknown chunks, clears their flags in VP8X and fixes
/// the RIFF size.
pub fn clean_webp(d: &[u8]) -> Option<Vec<u8>> {
    if d.len() < 12 || &d[..4] != b"RIFF" || &d[8..12] != b"WEBP" {
        return None;
    }
    let riff_end = (8 + u32::from_le_bytes([d[4], d[5], d[6], d[7]]) as usize).min(d.len());
    let mut out = Vec::with_capacity(d.len());
    out.extend_from_slice(&d[..12]);
    let mut i = 12;
    while i + 8 <= riff_end {
        let id: [u8; 4] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        let size = u32::from_le_bytes([d[i + 4], d[i + 5], d[i + 6], d[i + 7]]) as usize;
        let end = i.saturating_add(8).saturating_add(size + (size & 1)).min(riff_end);
        if WEBP_KEEP.contains(&&id) {
            let at = out.len();
            out.extend_from_slice(&d[i..end]);
            if &id == b"VP8X" && out.len() > at + 8 {
                out[at + 8] &= !(0x08 | 0x04); // EXIF and XMP flags
            }
        }
        i = end;
    }
    let size = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&size.to_le_bytes());
    Some(out)
}

// ---- GIF ---------------------------------------------------------------------------

/// The index just after a chain of data sub-blocks (after its 0 terminator).
fn sub_blocks_end(d: &[u8], mut i: usize) -> Option<usize> {
    loop {
        let n = *d.get(i)? as usize;
        i += 1;
        if n == 0 {
            return Some(i);
        }
        i += n;
        if i > d.len() {
            return None;
        }
    }
}

/// Drops comments and application extensions (XMP, ICC…) except the looping
/// ones (NETSCAPE2.0 / ANIMEXTS1.0), and anything after the trailer.
pub fn clean_gif(d: &[u8]) -> Option<Vec<u8>> {
    if d.len() < 13 || !(d.starts_with(b"GIF87a") || d.starts_with(b"GIF89a")) {
        return None;
    }
    let flags = d[10];
    let mut i = 13;
    if flags & 0x80 != 0 {
        i += 3usize << ((flags & 7) + 1);
    }
    if i > d.len() {
        return None;
    }
    let mut out = Vec::with_capacity(d.len());
    out.extend_from_slice(&d[..i]);
    loop {
        match d.get(i) {
            Some(0x3B) => {
                out.push(0x3B);
                break;
            }
            Some(0x21) => {
                let Some(&label) = d.get(i + 1) else { break };
                let body = i + 2;
                let Some(end) = sub_blocks_end(d, body) else { break };
                let keep = match label {
                    0xF9 | 0x01 => true, // graphic control (timing, transparency), plain text
                    0xFF => d[body] == 11 && matches!(d.get(body + 1..body + 12), Some(b"NETSCAPE2.0") | Some(b"ANIMEXTS1.0")),
                    _ => false,
                };
                if keep {
                    out.extend_from_slice(&d[i..end]);
                }
                i = end;
            }
            Some(0x2C) => {
                if i + 10 > d.len() {
                    break;
                }
                let lf = d[i + 9];
                let mut j = i + 10;
                if lf & 0x80 != 0 {
                    j += 3usize << ((lf & 7) + 1);
                }
                j += 1; // LZW minimum code size
                match sub_blocks_end(d, j) {
                    Some(end) => {
                        out.extend_from_slice(&d[i..end]);
                        i = end;
                    }
                    None => {
                        out.extend_from_slice(&d[i..]); // cut short: keep the picture data
                        break;
                    }
                }
            }
            _ => break,
        }
    }
    Some(out)
}

// ---- MP4 / MOV ---------------------------------------------------------------------

/// A change to a video while it streams: new bytes at an offset, or zeros.
#[derive(Debug, Clone, PartialEq)]
enum Patch {
    Bytes(u64, Vec<u8>),
    Zero(u64, u64),
}

impl Patch {
    fn range(&self) -> (u64, u64) {
        match self {
            Patch::Bytes(at, b) => (*at, *at + b.len() as u64),
            Patch::Zero(at, n) => (*at, *at + n),
        }
    }
}

struct BoxHdr {
    start: u64,
    hdr: u64,
    end: u64,
    ty: [u8; 4],
}

const XMP_UUID: [u8; 16] = [0xBE, 0x7A, 0xCF, 0xCB, 0x97, 0xA9, 0x42, 0xE8, 0x9C, 0x71, 0x99, 0x94, 0x91, 0xE3, 0xAF, 0xAC];

fn read_box<R: Read + Seek>(r: &mut R, at: u64, limit: u64) -> io::Result<Option<BoxHdr>> {
    if at + 8 > limit {
        return Ok(None);
    }
    r.seek(SeekFrom::Start(at))?;
    let mut h = [0u8; 8];
    r.read_exact(&mut h)?;
    let ty = [h[4], h[5], h[6], h[7]];
    let (hdr, size) = match u32::from_be_bytes([h[0], h[1], h[2], h[3]]) {
        1 => {
            if at + 16 > limit {
                return Ok(None);
            }
            let mut l = [0u8; 8];
            r.read_exact(&mut l)?;
            (16, u64::from_be_bytes(l))
        }
        0 => (8, limit - at),
        s => (8, s as u64),
    };
    if size < hdr || size > limit - at {
        return Ok(None); // damaged: stop looking at this level
    }
    Ok(Some(BoxHdr { start: at, hdr, end: at + size, ty }))
}

fn blank(b: &BoxHdr, p: &mut Vec<Patch>) {
    p.push(Patch::Bytes(b.start + 4, b"free".to_vec()));
    if b.end > b.start + b.hdr {
        p.push(Patch::Zero(b.start + b.hdr, b.end - b.start - b.hdr));
    }
}

fn walk<R: Read + Seek>(r: &mut R, from: u64, to: u64, depth: u32, p: &mut Vec<Patch>) -> io::Result<()> {
    let mut at = from;
    while let Some(b) = read_box(r, at, to)? {
        match &b.ty {
            b"udta" | b"meta" => blank(&b, p),
            b"uuid" => {
                if b.end >= b.start + b.hdr + 16 {
                    let mut u = [0u8; 16];
                    r.seek(SeekFrom::Start(b.start + b.hdr))?;
                    r.read_exact(&mut u)?;
                    if u == XMP_UUID {
                        blank(&b, p);
                    }
                }
            }
            b"moov" | b"trak" | b"mdia" | b"minf" | b"moof" | b"traf" if depth < 8 => {
                walk(r, b.start + b.hdr, b.end, depth + 1, p)?;
            }
            b"mvhd" | b"tkhd" | b"mdhd" => {
                // Full box: version, flags, then creation and modification time.
                let body = b.start + b.hdr;
                if b.end > body {
                    r.seek(SeekFrom::Start(body))?;
                    let mut v = [0u8; 1];
                    r.read_exact(&mut v)?;
                    let n = if v[0] == 1 { 16 } else { 8 };
                    if b.end >= body + 4 + n {
                        p.push(Patch::Zero(body + 4, n));
                    }
                }
            }
            _ => {}
        }
        at = b.end;
    }
    Ok(())
}

/// What to blank in an MP4/MOV file. Empty when it doesn't look like one.
fn video_patches<R: Read + Seek>(r: &mut R, len: u64) -> io::Result<Vec<Patch>> {
    let Some(first) = read_box(r, 0, len)? else { return Ok(Vec::new()) };
    let known: [&[u8; 4]; 8] = [b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"pnot", b"uuid"];
    if !known.contains(&&first.ty) {
        return Ok(Vec::new());
    }
    let mut p = Vec::new();
    walk(r, 0, len, 0, &mut p)?;
    p.sort_by_key(|x| x.range().0);
    Ok(p)
}

/// A reader that applies patches on the fly (same length as the original).
struct Patched<R> {
    inner: R,
    patches: Vec<Patch>,
    pos: u64,
}

impl<R: Read> Read for Patched<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        let (lo, hi) = (self.pos, self.pos + n as u64);
        for p in &self.patches {
            let (a, b) = p.range();
            if b <= lo || a >= hi {
                continue;
            }
            let (s, e) = (a.max(lo), b.min(hi));
            let dst = &mut buf[(s - lo) as usize..(e - lo) as usize];
            match p {
                Patch::Bytes(at, bytes) => dst.copy_from_slice(&bytes[(s - at) as usize..(e - at) as usize]),
                Patch::Zero(..) => dst.fill(0),
            }
        }
        self.pos = hi;
        Ok(n)
    }
}

impl<R: Seek> Seek for Patched<R> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.pos = self.inner.seek(to)?;
        Ok(self.pos)
    }
}

/// A tiny JPEG-shaped file whose EXIF names the camera ("Canon"), for the
/// export and sharing tests.
#[cfg(test)]
pub(crate) fn tiny_camera_jpeg() -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
    v.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
    let exif = b"Exif\0\0MM\0\x2A\0\0\0\x08\0\x01\x01\x0F\0\x02\0\0\0\x06\0\0\0\x1ACanon\0";
    v.extend_from_slice(&[0xFF, 0xE1, 0, exif.len() as u8 + 2]);
    v.extend_from_slice(exif);
    v.extend_from_slice(&[0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34, 0xFF, 0xD9]);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contains(h: &[u8], n: &[u8]) -> bool {
        h.windows(n.len()).any(|w| w == n)
    }

    fn rgb(w: u32, h: u32) -> image::RgbImage {
        image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x * 20) as u8, (y * 30) as u8, 128]))
    }

    // ---- JPEG ----

    fn base_jpeg() -> Vec<u8> {
        let mut v = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut v, 90).encode_image(&rgb(16, 8)).unwrap();
        v
    }

    fn seg(marker: u8, payload: &[u8]) -> Vec<u8> {
        let mut s = vec![0xFF, marker];
        s.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        s.extend_from_slice(payload);
        s
    }

    /// A camera-like EXIF: little-endian, Make, Model, Orientation, DateTime.
    fn camera_exif(orientation: u16) -> Vec<u8> {
        let mut t = b"II\x2A\0\x08\0\0\0".to_vec();
        let entries: u16 = 4;
        t.extend_from_slice(&entries.to_le_bytes());
        let data_at = 8 + 2 + 12 * entries as u32 + 4;
        let make = b"Canon\0";
        let model = b"EOS R5\0\0";
        let date = b"2024:05:01 10:00:00\0";
        let mut e = |tag: u16, ty: u16, count: u32, val: u32| {
            t.extend_from_slice(&tag.to_le_bytes());
            t.extend_from_slice(&ty.to_le_bytes());
            t.extend_from_slice(&count.to_le_bytes());
            t.extend_from_slice(&val.to_le_bytes());
        };
        e(0x010F, 2, make.len() as u32, data_at);
        e(0x0110, 2, model.len() as u32, data_at + make.len() as u32);
        e(0x0112, 3, 1, orientation as u32);
        e(0x0132, 2, date.len() as u32, data_at + (make.len() + model.len()) as u32);
        t.extend_from_slice(&[0, 0, 0, 0]);
        t.extend_from_slice(make);
        t.extend_from_slice(model);
        t.extend_from_slice(date);
        let mut p = b"Exif\0\0".to_vec();
        p.extend_from_slice(&t);
        p
    }

    fn camera_jpeg(orientation: u16) -> Vec<u8> {
        let base = base_jpeg();
        // The encoder writes SOI + APP0 JFIF first; add metadata after it.
        assert_eq!(&base[2..4], &[0xFF, 0xE0]);
        let app0_end = 4 + u16::from_be_bytes([base[4], base[5]]) as usize;
        let mut v = base[..app0_end].to_vec();
        v.extend(seg(0xE1, &camera_exif(orientation)));
        v.extend(seg(0xE1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPSLatitude 52,22.1N</x:xmpmeta>"));
        v.extend(seg(0xE2, b"ICC_PROFILE\0\x01\x01fake-profile-bytes"));
        v.extend(seg(0xED, b"Photoshop 3.0\08BIM\x04\x04IPTC By-line: Jane"));
        v.extend(seg(0xFE, b"Shot at Grandma's house"));
        v.extend(seg(0xEB, b"some private app data"));
        v.extend_from_slice(&base[app0_end..]);
        v.extend_from_slice(b"TRAILER motion photo with Canon inside");
        v
    }

    #[test]
    fn jpeg_loses_camera_info_keeps_colour_profile_and_decodes() {
        let src = camera_jpeg(1);
        assert!(contains(&src, b"Canon"));
        let out = clean_jpeg(&src).unwrap();
        for gone in [&b"Exif"[..], b"Canon", b"EOS R5", b"2024:05:01", b"xmpmeta", b"IPTC", b"Grandma", b"private app", b"TRAILER"] {
            assert!(!contains(&out, gone), "{:?} is still there", String::from_utf8_lossy(gone));
        }
        assert!(contains(&out, b"ICC_PROFILE\0"));
        assert!(contains(&out, b"JFIF\0"));
        assert_eq!(&out[out.len() - 2..], &[0xFF, 0xD9]);
        let a = image::load_from_memory(&src).unwrap().to_rgb8();
        let b = image::load_from_memory(&out).unwrap().to_rgb8();
        assert_eq!(a, b, "the picture itself is untouched");
    }

    #[test]
    fn jpeg_turned_picture_keeps_only_its_orientation() {
        for o in [3u16, 6, 8] {
            let out = clean_jpeg(&camera_jpeg(o)).unwrap();
            assert!(!contains(&out, b"Canon") && !contains(&out, b"2024:05:01"));
            // JFIF stays first, then the minimal EXIF.
            assert_eq!(&out[2..4], &[0xFF, 0xE0]);
            let app0_end = 4 + u16::from_be_bytes([out[4], out[5]]) as usize;
            assert_eq!(&out[app0_end..app0_end + 2], &[0xFF, 0xE1]);
            let l = u16::from_be_bytes([out[app0_end + 2], out[app0_end + 3]]) as usize;
            let payload = &out[app0_end + 4..app0_end + 2 + l];
            assert!(payload.starts_with(b"Exif\0\0"));
            assert_eq!(exif_orientation(&payload[6..]), Some(o));
            assert!(image::load_from_memory(&out).is_ok());
        }
        // Big-endian EXIF is read too.
        let mut t = b"MM\0\x2A\0\0\0\x08\0\x01".to_vec();
        t.extend_from_slice(&[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
        assert_eq!(exif_orientation(&t), Some(6));
        assert_eq!(exif_orientation(b"XX"), None);
    }

    #[test]
    fn jpeg_progressive_scans_and_restart_markers_survive() {
        // Hand-made stream: segments between two scans, RST and stuffed bytes in the data.
        let mut v = vec![0xFF, 0xD8];
        v.extend(seg(0xE1, &camera_exif(1)));
        v.extend(seg(0xDB, &[0; 65]));
        v.extend(seg(0xDA, &[1, 1, 0, 0, 63, 0]));
        v.extend_from_slice(&[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0xFF, 0xFF, 0xD1, 0x78]);
        v.extend(seg(0xFE, b"between scans"));
        v.extend(seg(0xC4, &[0; 20]));
        v.extend(seg(0xDA, &[1, 1, 0, 0, 63, 0]));
        v.extend_from_slice(&[0x9A, 0xFF, 0x00]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        let out = clean_jpeg(&v).unwrap();
        let mut want = vec![0xFF, 0xD8];
        want.extend(seg(0xDB, &[0; 65]));
        want.extend(seg(0xDA, &[1, 1, 0, 0, 63, 0]));
        want.extend_from_slice(&[0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0xFF, 0xFF, 0xD1, 0x78]);
        want.extend(seg(0xC4, &[0; 20]));
        want.extend(seg(0xDA, &[1, 1, 0, 0, 63, 0]));
        want.extend_from_slice(&[0x9A, 0xFF, 0x00, 0xFF, 0xD9]);
        assert_eq!(out, want);
        assert_eq!(clean_jpeg(b"not a jpeg"), None);
        // Cut short inside a metadata segment: nothing of it leaks.
        let mut cut = vec![0xFF, 0xD8];
        cut.extend_from_slice(&seg(0xE1, &camera_exif(1))[..30]);
        assert_eq!(clean_jpeg(&cut).unwrap(), vec![0xFF, 0xD8]);
    }

    // ---- PNG ----

    fn crc32(data: &[u8]) -> u32 {
        let mut c = 0xFFFF_FFFFu32;
        for &b in data {
            c ^= b as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
        !c
    }

    fn chunk(ty: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = (data.len() as u32).to_be_bytes().to_vec();
        c.extend_from_slice(ty);
        c.extend_from_slice(data);
        let mut crc_in = ty.to_vec();
        crc_in.extend_from_slice(data);
        c.extend_from_slice(&crc32(&crc_in).to_be_bytes());
        c
    }

    #[test]
    fn png_loses_text_time_and_exif_keeps_colour_chunks_and_decodes() {
        use image::ImageEncoder as _;
        let mut base = Vec::new();
        image::codecs::png::PngEncoder::new(&mut base)
            .write_image(&rgb(10, 6), 10, 6, image::ExtendedColorType::Rgb8)
            .unwrap();
        let ihdr_end = 8 + 12 + 13;
        let iend = base.len() - 12;
        let mut v = base[..ihdr_end].to_vec();
        v.extend(chunk(b"gAMA", &45455u32.to_be_bytes()));
        v.extend(chunk(b"pHYs", &[0, 0, 0x0B, 0x13, 0, 0, 0x0B, 0x13, 1]));
        v.extend(chunk(b"eXIf", &camera_exif(1)[6..]));
        v.extend(chunk(b"tEXt", b"Author\0Jane Doe"));
        v.extend(chunk(b"zTXt", b"Comment\0\0xyz"));
        v.extend(chunk(b"iTXt", b"XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>"));
        v.extend(chunk(b"tIME", &[0x07, 0xE8, 5, 1, 10, 0, 0]));
        v.extend(chunk(b"prVt", b"private"));
        v.extend_from_slice(&base[ihdr_end..iend]);
        v.extend(chunk(b"tEXt", b"Location\0Paris"));
        v.extend_from_slice(&base[iend..]);
        v.extend_from_slice(b"junk after the end");
        let out = clean_png(&v).unwrap();
        for gone in [&b"eXIf"[..], b"Canon", b"tEXt", b"Jane", b"zTXt", b"iTXt", b"tIME", b"prVt", b"Paris", b"junk"] {
            assert!(!contains(&out, gone), "{:?} is still there", String::from_utf8_lossy(gone));
        }
        assert!(contains(&out, b"gAMA") && contains(&out, b"pHYs"));
        assert!(out.ends_with(&base[iend..]));
        let a = image::load_from_memory(&v).unwrap().to_rgb8();
        let b = image::load_from_memory(&out).unwrap().to_rgb8();
        assert_eq!(a, b);
    }

    // ---- WebP ----

    fn riff_chunk(id: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = id.to_vec();
        c.extend_from_slice(&(data.len() as u32).to_le_bytes());
        c.extend_from_slice(data);
        if data.len() % 2 == 1 {
            c.push(0);
        }
        c
    }

    #[test]
    fn webp_loses_exif_and_xmp_flags_are_cleared_and_it_decodes() {
        let mut simple = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut simple)
            .encode(rgb(9, 7).as_raw(), 9, 7, image::ExtendedColorType::Rgb8)
            .unwrap();
        assert_eq!(&simple[12..16], b"VP8L");
        let vp8l = &simple[12..];
        // Extended file: VP8X (EXIF + XMP flags), image, EXIF, XMP, an unknown chunk.
        let mut x = vec![0x08 | 0x04, 0, 0, 0];
        x.extend_from_slice(&(9u32 - 1).to_le_bytes()[..3]);
        x.extend_from_slice(&(7u32 - 1).to_le_bytes()[..3]);
        let mut body = b"WEBP".to_vec();
        body.extend(riff_chunk(b"VP8X", &x));
        body.extend_from_slice(vp8l);
        body.extend(riff_chunk(b"EXIF", &camera_exif(1)[6..]));
        body.extend(riff_chunk(b"XMP ", b"<x:xmpmeta>GPS</x:xmpmeta>"));
        body.extend(riff_chunk(b"ZZZZ", b"unknown"));
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&(body.len() as u32).to_le_bytes());
        v.extend(body);
        assert!(image::load_from_memory(&v).is_ok());
        let out = clean_webp(&v).unwrap();
        assert!(!contains(&out, b"EXIF") && !contains(&out, b"Canon") && !contains(&out, b"XMP ") && !contains(&out, b"ZZZZ"));
        assert_eq!(out[20] & 0x0C, 0, "EXIF/XMP flags cleared");
        assert_eq!(u32::from_le_bytes([out[4], out[5], out[6], out[7]]) as usize, out.len() - 8);
        let a = image::load_from_memory(&v).unwrap().to_rgb8();
        let b = image::load_from_memory(&out).unwrap().to_rgb8();
        assert_eq!(a, b);
    }

    // ---- GIF ----

    #[test]
    fn gif_loses_comments_and_xmp_keeps_looping_and_decodes() {
        use image::codecs::gif::{GifEncoder, Repeat};
        let mut base = Vec::new();
        {
            let mut enc = GifEncoder::new(&mut base);
            enc.set_repeat(Repeat::Infinite).unwrap();
            for k in 0..2u8 {
                let img = image::RgbaImage::from_pixel(6, 4, image::Rgba([k * 100, 50, 200, 255]));
                enc.encode_frame(image::Frame::new(img)).unwrap();
            }
        }
        assert!(contains(&base, b"NETSCAPE2.0"));
        // Put a comment and an XMP application block before the trailer.
        let mut v = base[..base.len() - 1].to_vec();
        v.extend_from_slice(&[0x21, 0xFE, 11]);
        v.extend_from_slice(b"Taken by me");
        v.push(0);
        v.extend_from_slice(&[0x21, 0xFF, 11]);
        v.extend_from_slice(b"XMP DataXMP");
        v.extend_from_slice(&[5]);
        v.extend_from_slice(b"<xmp>");
        v.push(0);
        v.push(0x3B);
        v.extend_from_slice(b"trailing");
        let out = clean_gif(&v).unwrap();
        assert!(!contains(&out, b"Taken by me") && !contains(&out, b"XMP DataXMP") && !contains(&out, b"trailing"));
        assert!(contains(&out, b"NETSCAPE2.0"));
        assert_eq!(out, base, "only the added blocks went");
        use image::AnimationDecoder as _;
        let frames = image::codecs::gif::GifDecoder::new(Cursor::new(&out)).unwrap().into_frames().collect_frames().unwrap();
        assert_eq!(frames.len(), 2);
    }

    // ---- MP4 ----

    fn bx(ty: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(ty);
        b.extend_from_slice(body);
        b
    }

    fn full(ty: &[u8; 4], version: u8, rest: &[u8]) -> Vec<u8> {
        let mut b = vec![version, 0, 0, 0];
        b.extend_from_slice(rest);
        bx(ty, &b)
    }

    const DATE32: [u8; 4] = [0xE1, 0x23, 0x45, 0x67];

    /// A small MP4 with moov before mdat (so offsets would break if moov changed size).
    fn sample_mp4() -> (Vec<u8>, std::ops::Range<usize>) {
        let mut mvhd = Vec::new();
        mvhd.extend_from_slice(&DATE32);
        mvhd.extend_from_slice(&DATE32);
        mvhd.extend_from_slice(&[0, 0, 0x03, 0xE8, 0, 0, 0x0B, 0xB8]);
        mvhd.extend_from_slice(&[0; 80]);
        let mut tkhd = Vec::new();
        tkhd.extend_from_slice(&[0, 0, 0, 0]);
        tkhd.extend_from_slice(&DATE32);
        tkhd.extend_from_slice(&[0, 0, 0, 0]);
        tkhd.extend_from_slice(&DATE32);
        tkhd.extend_from_slice(&[0; 80]);
        let mdhd = full(b"mdhd", 0, &[DATE32, DATE32, [0, 0, 0x03, 0xE8], [0; 4], [0x55, 0xC4, 0, 0]].concat());
        let stco_at_placeholder = [0u8; 4];
        let stbl = bx(b"stbl", &full(b"stco", 0, &[[0, 0, 0, 1], stco_at_placeholder].concat()));
        let minf = bx(b"minf", &stbl);
        let mdia = bx(b"mdia", &[mdhd, minf].concat());
        let trak_udta = bx(b"udta", &bx(b"name", b"Track by Jane"));
        let trak = bx(b"trak", &[full(b"tkhd", 1, &tkhd), mdia, trak_udta].concat());
        let xyz = bx(b"\xA9xyz", b"\0\x0E\0\0+52.3700+004.8900/");
        let make = bx(b"\xA9mak", b"\0\x05\0\0Apple");
        let udta = bx(b"udta", &[xyz, make].concat());
        let meta = full(b"meta", 0, &bx(b"keys", b"com.apple.quicktime.creationdate 2024-05-01T10:00:00+0200"));
        let moov = bx(b"moov", &[full(b"mvhd", 0, &mvhd), trak, udta, meta].concat());
        let ftyp = bx(b"ftyp", b"isom\0\0\x02\0isomiso2mp41");
        let payload: Vec<u8> = (0..4000u32).map(|i| (i * 7 % 251) as u8).collect();
        let mut xmp_uuid = XMP_UUID.to_vec();
        xmp_uuid.extend_from_slice(b"<x:xmpmeta>Jane's phone</x:xmpmeta>");
        let mut v = [ftyp, moov].concat();
        // mdat with a 64-bit size, to cover large boxes.
        let mdat_start = v.len();
        v.extend_from_slice(&1u32.to_be_bytes());
        v.extend_from_slice(b"mdat");
        v.extend_from_slice(&((payload.len() + 16) as u64).to_be_bytes());
        v.extend_from_slice(&payload);
        let data = mdat_start + 16..v.len();
        v.extend(bx(b"uuid", &xmp_uuid));
        (v, data)
    }

    fn top_types(d: &[u8]) -> Vec<[u8; 4]> {
        let mut c = Cursor::new(d);
        let mut at = 0;
        let mut out = Vec::new();
        while let Some(b) = read_box(&mut c, at, d.len() as u64).unwrap() {
            out.push(b.ty);
            at = b.end;
        }
        out
    }

    #[test]
    fn mp4_metadata_is_blanked_in_place_and_offsets_stay_valid() {
        let (src, data) = sample_mp4();
        let (mut r, len) = open(Cursor::new(src.clone()), "clip.MP4").unwrap();
        assert_eq!(len, src.len() as u64);
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!(out.len(), src.len(), "same length, so stco/co64 offsets still point at the same bytes");
        for gone in [&b"+52.3700"[..], b"Apple", b"creationdate", b"Jane", b"\xA9xyz", b"udta", b"meta", &DATE32] {
            assert!(!contains(&out, gone), "{:?} is still there", String::from_utf8_lossy(gone));
        }
        assert_eq!(&out[data.clone()], &src[data], "the video data is untouched");
        assert_eq!(top_types(&out), top_types(&src).iter().map(|t| if t == b"uuid" { *b"free" } else { *t }).collect::<Vec<_>>());
        // Inside moov the structure is intact: mvhd, trak, free, free.
        let moov_at = src.windows(4).position(|w| w == b"moov").unwrap() - 4;
        let moov = read_box(&mut Cursor::new(&out), moov_at as u64, out.len() as u64).unwrap().unwrap();
        let mut kids = Vec::new();
        let mut at = moov.start + moov.hdr;
        while let Some(b) = read_box(&mut Cursor::new(&out), at, moov.end).unwrap() {
            kids.push(b.ty);
            at = b.end;
        }
        assert_eq!(kids, vec![*b"mvhd", *b"trak", *b"free", *b"free"]);
        assert!(contains(&out, &[0, 0, 0x03, 0xE8, 0, 0, 0x0B, 0xB8]), "timescale and duration stay");
    }

    #[test]
    fn mp4_patches_apply_with_any_read_size_and_after_seeking() {
        let (src, _) = sample_mp4();
        let (mut r, _) = open(Cursor::new(src.clone()), "a.mov").unwrap();
        let mut whole = Vec::new();
        r.read_to_end(&mut whole).unwrap();
        for step in [1usize, 3, 7, 64, 1000] {
            r.seek(SeekFrom::Start(0)).unwrap();
            let mut got = Vec::new();
            let mut buf = vec![0u8; step];
            loop {
                let n = r.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
            }
            assert_eq!(got, whole, "step {step}");
        }
        for at in [0u64, 5, 33, 200, (src.len() - 10) as u64] {
            r.seek(SeekFrom::Start(at)).unwrap();
            let mut tail = Vec::new();
            r.read_to_end(&mut tail).unwrap();
            assert_eq!(tail, &whole[at as usize..]);
        }
    }

    #[test]
    fn other_files_and_odd_videos_pass_through() {
        let d = b"plain text with Canon in it".to_vec();
        let (mut r, len) = open(Cursor::new(d.clone()), "notes.txt").unwrap();
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!((out, len), (d.clone(), d.len() as u64));
        // A ".mp4" that isn't one is left alone.
        let (mut r, _) = open(Cursor::new(d.clone()), "x.mp4").unwrap();
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!(out, d);
        // A ".jpg" that isn't a picture too.
        let (mut r, len) = open(Cursor::new(d.clone()), "x.jpg").unwrap();
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!((out, len), (d.clone(), d.len() as u64));
        assert_eq!(class_of("A.JPEG"), Class::Picture);
        assert_eq!(class_of("b.m4v"), Class::Video);
        assert_eq!(class_of("noext"), Class::Other);
        assert!(changes_length("p.webp") && !changes_length("v.mov"));
    }

    #[test]
    fn picture_through_open_reports_its_new_length() {
        let src = camera_jpeg(6);
        let (mut r, len) = open(Cursor::new(src.clone()), "IMG_0001.JPG").unwrap();
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!(len, out.len() as u64);
        assert!(out.len() < src.len());
        r.seek(SeekFrom::Start(2)).unwrap();
        let mut b = [0u8; 2];
        r.read_exact(&mut b).unwrap();
        assert_eq!(b, [0xFF, 0xE0]);
    }
}
