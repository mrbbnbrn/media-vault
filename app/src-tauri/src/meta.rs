//! When was a photo or video taken? Read from the file itself: EXIF
//! DateTimeOriginal (JPEG, WebP, PNG) or the MP4 movie header. Used for the
//! timeline. Times without a time zone are treated as UTC, which is exact
//! enough to group by month.

use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;
use std::time::Duration;

use vault_core::{ObjectId, ObjectKind};

use crate::session::Session;

/// Earliest plausible date (1990-01-01); anything before is a camera with an unset clock.
const MIN_DATE: i64 = 631_152_000;

fn plausible(t: i64) -> Option<i64> {
    let max = crate::library::now_secs() + 2 * 86_400;
    (MIN_DATE..=max).contains(&t).then_some(t)
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "2023:07:14 18:22:05" → seconds.
fn parse_exif_time(s: &[u8]) -> Option<i64> {
    let s = std::str::from_utf8(s).ok()?.trim_end_matches('\0').trim();
    if s.len() < 19 {
        return None;
    }
    let n = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (
        n(0, 4)?,
        n(5, 7)?,
        n(8, 10)?,
        n(11, 13)?,
        n(14, 16)?,
        n(17, 19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    plausible(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se)
}

/// Date from a TIFF/EXIF block: DateTimeOriginal, else DateTimeDigitized, else DateTime.
pub fn tiff_date(t: &[u8]) -> Option<i64> {
    if t.len() < 8 {
        return None;
    }
    let le = match &t[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |p: usize| -> Option<u16> {
        let b = t.get(p..p + 2)?;
        Some(if le {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |p: usize| -> Option<u32> {
        let b = t.get(p..p + 4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Some(if le {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        })
    };
    // Look through one IFD for the given tags; returns (tag, value) pairs we care about.
    let read_ifd = |off: usize| -> Vec<(u16, Option<i64>, Option<usize>)> {
        let mut out = Vec::new();
        let Some(count) = u16_at(off) else { return out };
        for i in 0..count.min(512) as usize {
            let e = off + 2 + i * 12;
            let (Some(tag), Some(typ), Some(cnt), Some(val)) =
                (u16_at(e), u16_at(e + 2), u32_at(e + 4), u32_at(e + 8))
            else {
                break;
            };
            match tag {
                0x9003 | 0x9004 | 0x0132 if typ == 2 && cnt >= 19 => {
                    let p = val as usize;
                    out.push((tag, t.get(p..p + 19).and_then(parse_exif_time), None));
                }
                0x8769 => out.push((tag, None, Some(val as usize))),
                _ => {}
            }
        }
        out
    };
    let ifd0 = read_ifd(u32_at(4)? as usize);
    let mut original = None;
    let mut digitized = None;
    let mut plain = None;
    for (tag, v, ptr) in &ifd0 {
        match tag {
            0x0132 => plain = *v,
            0x8769 => {
                if let Some(p) = ptr {
                    for (t2, v2, _) in read_ifd(*p) {
                        match t2 {
                            0x9003 => original = v2,
                            0x9004 => digitized = v2,
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
    original.or(digitized).or(plain)
}

/// EXIF date from the start of a JPEG, WebP or PNG file.
pub fn image_date(head: &[u8]) -> Option<i64> {
    if head.starts_with(&[0xFF, 0xD8]) {
        let mut p = 2;
        while p + 4 <= head.len() {
            if head[p] != 0xFF {
                return None;
            }
            let marker = head[p + 1];
            if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
                p += 2;
                continue;
            }
            if marker == 0xDA || marker == 0xD9 {
                return None; // image data starts; no EXIF before it
            }
            let len = u16::from_be_bytes([head[p + 2], head[p + 3]]) as usize;
            let body = head.get(p + 4..p + 2 + len)?;
            if marker == 0xE1 && body.starts_with(b"Exif\0\0") {
                return tiff_date(&body[6..]);
            }
            p += 2 + len;
        }
        return None;
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        let mut p = 12;
        while p + 8 <= head.len() {
            let id = &head[p..p + 4];
            let size =
                u32::from_le_bytes([head[p + 4], head[p + 5], head[p + 6], head[p + 7]]) as usize;
            if id == b"EXIF" {
                let body = head.get(p + 8..p + 8 + size)?;
                let body = body.strip_prefix(b"Exif\0\0").unwrap_or(body);
                return tiff_date(body);
            }
            p += 8 + size + (size & 1);
        }
        return None;
    }
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        let mut p = 8;
        while p + 8 <= head.len() {
            let size =
                u32::from_be_bytes([head[p], head[p + 1], head[p + 2], head[p + 3]]) as usize;
            let id = &head[p + 4..p + 8];
            if id == b"eXIf" {
                return tiff_date(head.get(p + 8..p + 8 + size)?);
            }
            if id == b"IDAT" || id == b"IEND" {
                return None;
            }
            p += 12 + size;
        }
    }
    None
}

/// Creation time from an MP4/M4V movie header, walking boxes with seeks so
/// a header at the end of a large file is found without reading the rest.
pub fn mp4_date<R: Read + Seek>(r: &mut R) -> Option<i64> {
    let end = r.seek(SeekFrom::End(0)).ok()?;
    let read_box = |r: &mut R, at: u64, limit: u64| -> Option<(u64, [u8; 4], u64)> {
        if at + 8 > limit {
            return None;
        }
        r.seek(SeekFrom::Start(at)).ok()?;
        let mut h = [0u8; 8];
        r.read_exact(&mut h).ok()?;
        let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
        let typ = [h[4], h[5], h[6], h[7]];
        let (size, header) = match size32 {
            1 => {
                let mut b = [0u8; 8];
                r.read_exact(&mut b).ok()?;
                (u64::from_be_bytes(b), 16)
            }
            0 => (limit - at, 8),
            s => (s, 8),
        };
        if size < header || at + size > limit {
            return None;
        }
        Some((size, typ, header))
    };
    let mut at = 0;
    let mut guard = 0;
    while let Some((size, typ, header)) = read_box(r, at, end) {
        guard += 1;
        if guard > 10_000 {
            return None;
        }
        if &typ == b"moov" {
            let moov_end = at + size;
            let mut inner = at + header;
            while let Some((isize, ityp, ih)) = read_box(r, inner, moov_end) {
                if &ityp == b"mvhd" {
                    r.seek(SeekFrom::Start(inner + ih)).ok()?;
                    let mut v = [0u8; 12];
                    r.read_exact(&mut v).ok()?;
                    let secs = if v[0] == 1 {
                        u64::from_be_bytes([v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11]])
                    } else {
                        u32::from_be_bytes([v[4], v[5], v[6], v[7]]) as u64
                    };
                    return plausible(secs as i64 - 2_082_844_800);
                }
                inner += isize;
            }
            return None;
        }
        at += size;
    }
    None
}

/// Date for a media file given its first bytes and a way to reach the rest.
pub fn media_date<R: Read + Seek>(ext: &str, head: &[u8], full: Option<&mut R>) -> Option<i64> {
    match ext {
        "mp4" | "m4v" | "mov" => {
            let mut c = std::io::Cursor::new(head);
            mp4_date(&mut c).or_else(|| full.and_then(|r| mp4_date(r)))
        }
        "webm" => None,
        _ => image_date(head),
    }
}

/// Fill in `taken_at` for items that haven't been looked at yet (older
/// vaults, and videos whose header is at the end of the file). Runs in the
/// background while the vault is open.
pub fn backfill(s: Arc<Session>) {
    std::thread::spawn(move || {
        crate::analyse::polite_thread();
        while !s.is_closed() {
            let todo: Vec<(i64, String, String, Option<i64>)> = {
                let db = s.db();
                let Ok(mut st) = db.prepare(
                    "SELECT id, object_id, ext, file_mtime FROM media WHERE taken_at IS NULL ORDER BY id LIMIT 40",
                ) else {
                    return;
                };
                st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                    .and_then(|it| it.collect())
                    .unwrap_or_default()
            };
            if todo.is_empty() {
                for _ in 0..10 {
                    if s.is_closed() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                continue;
            }
            for (id, obj, ext, _mtime) in todo {
                // While you use the window, wait between items (userbusy.rs).
                crate::userbusy::give_way(&|| s.is_closed());
                if s.is_closed() {
                    return;
                }
                let date = ObjectId::from_hex(&obj)
                    .ok()
                    .and_then(|oid| s.vault().open_object(ObjectKind::Media, &oid).ok())
                    .and_then(|mut r| {
                        let mut head = vec![0u8; 256 * 1024];
                        let mut n = 0;
                        while n < head.len() {
                            match r.read(&mut head[n..]) {
                                Ok(0) => break,
                                Ok(k) => n += k,
                                Err(_) => return None,
                            }
                        }
                        head.truncate(n);
                        media_date(&ext, &head, Some(&mut r))
                    });
                let _ = s.db().execute(
                    "UPDATE media SET taken_at = ? WHERE id = ? AND taken_at IS NULL",
                    rusqlite::params![date.unwrap_or(0), id],
                );
                s.mark_dirty();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiff_with_date(le: bool, tag: u16, date: &str) -> Vec<u8> {
        // Header, IFD0 with one entry pointing to an Exif IFD with the date.
        let w16 = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let w32 = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut t = Vec::new();
        t.extend_from_slice(if le { b"II" } else { b"MM" });
        t.extend_from_slice(&w16(42));
        t.extend_from_slice(&w32(8));
        // IFD0 at 8: 1 entry (ExifIFD pointer → 26)
        t.extend_from_slice(&w16(1));
        t.extend_from_slice(&w16(0x8769));
        t.extend_from_slice(&w16(4));
        t.extend_from_slice(&w32(1));
        t.extend_from_slice(&w32(26));
        t.extend_from_slice(&w32(0));
        // Exif IFD at 26: 1 entry (date string at 44)
        t.extend_from_slice(&w16(1));
        t.extend_from_slice(&w16(tag));
        t.extend_from_slice(&w16(2));
        t.extend_from_slice(&w32(20));
        t.extend_from_slice(&w32(44));
        t.extend_from_slice(&w32(0));
        t.extend_from_slice(date.as_bytes());
        t.push(0);
        t
    }

    #[test]
    fn exif_dates_in_jpeg_and_webp() {
        let tiff = tiff_with_date(true, 0x9003, "2023:07:14 18:22:05");
        let mut jpg = vec![0xFF, 0xD8, 0xFF, 0xE1];
        let len = (2 + 6 + tiff.len()) as u16;
        jpg.extend_from_slice(&len.to_be_bytes());
        jpg.extend_from_slice(b"Exif\0\0");
        jpg.extend_from_slice(&tiff);
        jpg.extend_from_slice(&[0xFF, 0xDA, 0, 2]);
        // 2023-07-14T18:22:05Z
        assert_eq!(image_date(&jpg), Some(1_689_358_925));
        assert_eq!(
            tiff_date(&tiff_with_date(false, 0x9004, "2001:02:03 04:05:06")),
            Some(981_173_106)
        );
        assert_eq!(
            image_date(&tiff_with_date(true, 0x9003, "0000:00:00 00:00:00")),
            None
        );

        let mut webp = b"RIFF\0\0\0\0WEBPEXIF".to_vec();
        webp.extend_from_slice(&(tiff.len() as u32).to_le_bytes());
        webp.extend_from_slice(&tiff);
        assert_eq!(image_date(&webp), Some(1_689_358_925));
        assert_eq!(image_date(b"GIF89a"), None);
    }

    #[test]
    fn mp4_header_found_at_the_end() {
        let bx = |typ: &[u8], body: &[u8]| {
            let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            b.extend_from_slice(typ);
            b.extend_from_slice(body);
            b
        };
        let created: u32 = (1_689_358_925i64 + 2_082_844_800) as u32;
        let mut mvhd = vec![0, 0, 0, 0];
        mvhd.extend_from_slice(&created.to_be_bytes());
        mvhd.extend_from_slice(&[0; 92]);
        let mut file = bx(b"ftyp", b"isom\0\0\0\0");
        file.extend(bx(b"mdat", &vec![7u8; 100_000]));
        file.extend(bx(b"moov", &bx(b"mvhd", &mvhd)));
        let mut c = std::io::Cursor::new(&file);
        assert_eq!(mp4_date(&mut c), Some(1_689_358_925));
        // Only the start available: not found from the head, found with the full reader.
        let head = &file[..4096];
        assert_eq!(
            media_date::<std::io::Cursor<&Vec<u8>>>("mp4", head, None),
            None
        );
        let mut c = std::io::Cursor::new(&file);
        assert_eq!(media_date("mp4", head, Some(&mut c)), Some(1_689_358_925));
        // Garbage doesn't loop or panic.
        let mut g = std::io::Cursor::new(vec![0u8; 64]);
        assert_eq!(mp4_date(&mut g), None);
    }
}
