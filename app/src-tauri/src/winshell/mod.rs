//! Working with Windows Explorer and the desktop:
//!
//! * drag items out of the window onto Explorer or the desktop,
//! * Ctrl+C in the app, Ctrl+V in Explorer,
//! * read what is on the clipboard (files or a picture) to paste it in.
//!
//! Items leave the vault as "virtual files": Explorer is told the names
//! (and folders) first and then reads each file through a stream that
//! decrypts straight from the vault while it copies. The app never writes a
//! decrypted file anywhere itself; copies only appear where the user drops
//! or pastes them.
//!
//! The planning of names and folders and the picture conversion are plain
//! Rust (and tested everywhere); the Windows plumbing lives in `win.rs`.

// Off Windows only the tests use the picture and question helpers.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use vault_core::export::safe_name;

use crate::Shared;
use crate::session::Session;

#[cfg(windows)]
mod win;

// ---- what goes out: names, folders and which vault object each file is ----

/// One entry of the virtual file list, in the order Explorer gets it
/// (a folder always comes before what is inside it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VEntry {
    /// Relative path with `\` between the parts, e.g. `Alex\Beach\b.jpg`.
    pub path: String,
    /// `None` for a folder.
    pub file: Option<VFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VFile {
    pub media: i64,
    /// Hex object id in the vault.
    pub object: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct FolderRow {
    pub id: i64,
    pub parent: Option<i64>,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct MediaRow {
    pub id: i64,
    pub object: String,
    pub name: String,
    pub folder: Option<i64>,
    pub size: u64,
}

/// Explorer's limit for one name in the file list (MAX_PATH, without the
/// closing zero).
const MAX_REL: usize = 259;

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Shorten a name to at most `max` UTF-16 units, keeping its extension.
fn fit(name: &str, max: usize) -> String {
    if units(name) <= max {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && units(&name[i..]) < max / 2 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let room = max.saturating_sub(units(ext)).max(1);
    let mut out = String::new();
    for c in stem.chars() {
        if units(&out) + c.len_utf16() > room {
            break;
        }
        out.push(c);
    }
    let out = out.trim_end_matches([' ', '.']).to_string();
    format!("{}{ext}", if out.is_empty() { "_" } else { &out })
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}\\{name}") }
}

/// `dir\photo.jpg`, or `dir\photo (2).jpg` … if that is taken (Windows names
/// ignore case). Returns `None` when even a short name would be too long.
fn unique(dir: &str, name: &str, taken: &mut HashSet<String>) -> Option<String> {
    let room = MAX_REL.checked_sub(if dir.is_empty() { 0 } else { units(dir) + 1 })?;
    if room < 12 {
        return None;
    }
    let name = fit(name, room.saturating_sub(6)); // space for " (99)"
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };
    for n in 1.. {
        let candidate = if n == 1 { name.clone() } else { format!("{stem} ({n}){ext}") };
        let p = join(dir, &candidate);
        if taken.insert(p.to_lowercase()) {
            return Some(p);
        }
    }
    None
}

/// Work out the virtual file list. Picked folders come out with everything
/// inside them, keeping their sub-folders; picked items go side by side at
/// the top. Each item appears once, and a folder inside another picked
/// folder is not repeated. Only live (not deleted) rows should be passed in.
pub fn plan_entries(
    folders: &[FolderRow],
    media: &[MediaRow],
    ids: &[i64],
    picked: &[i64],
) -> Vec<VEntry> {
    let by_id: HashMap<i64, &FolderRow> = folders.iter().map(|f| (f.id, f)).collect();
    let mut children: HashMap<Option<i64>, Vec<&FolderRow>> = HashMap::new();
    for f in folders {
        children.entry(f.parent).or_default().push(f);
    }
    for v in children.values_mut() {
        v.sort_by_key(|f| (f.name.to_lowercase(), f.id));
    }
    let mut inside: HashMap<Option<i64>, Vec<&MediaRow>> = HashMap::new();
    for m in media {
        inside.entry(m.folder).or_default().push(m);
    }
    for v in inside.values_mut() {
        v.sort_by_key(|m| (m.name.to_lowercase(), m.id));
    }

    // Leave out folders that sit inside another picked folder.
    let picked_set: HashSet<i64> = picked.iter().copied().filter(|f| by_id.contains_key(f)).collect();
    let has_picked_parent = |mut f: i64| {
        let mut steps = 0;
        while let Some(p) = by_id.get(&f).and_then(|r| r.parent) {
            if picked_set.contains(&p) {
                return true;
            }
            f = p;
            steps += 1;
            if steps > 256 {
                break;
            }
        }
        false
    };
    let mut seen_top = HashSet::new();
    let tops: Vec<i64> = picked
        .iter()
        .copied()
        .filter(|f| picked_set.contains(f) && !has_picked_parent(*f) && seen_top.insert(*f))
        .collect();

    let mut out = Vec::new();
    let mut taken = HashSet::new();
    let mut placed: HashSet<i64> = HashSet::new();

    struct Walk<'a> {
        children: &'a HashMap<Option<i64>, Vec<&'a FolderRow>>,
        inside: &'a HashMap<Option<i64>, Vec<&'a MediaRow>>,
    }
    impl Walk<'_> {
        fn file(&self, dir: &str, m: &MediaRow, taken: &mut HashSet<String>, out: &mut Vec<VEntry>) {
            let name = safe_name(&m.name);
            // Too deep for Windows: put it at the top instead of losing it.
            let path = unique(dir, &name, taken).or_else(|| unique("", &name, taken));
            if let Some(path) = path {
                out.push(VEntry {
                    path,
                    file: Some(VFile { media: m.id, object: m.object.clone(), size: m.size }),
                });
            }
        }
        #[allow(clippy::too_many_arguments)]
        fn folder(
            &self,
            dir: &str,
            f: &FolderRow,
            depth: usize,
            taken: &mut HashSet<String>,
            placed: &mut HashSet<i64>,
            out: &mut Vec<VEntry>,
        ) {
            if depth > 256 {
                return;
            }
            // A folder too deep to be made is flattened into its parent.
            let here = match unique(dir, &safe_name(&f.name), taken) {
                Some(p) => {
                    out.push(VEntry { path: p.clone(), file: None });
                    p
                }
                None => dir.to_string(),
            };
            if let Some(subs) = self.children.get(&Some(f.id)) {
                for sub in subs {
                    self.folder(&here, sub, depth + 1, taken, placed, out);
                }
            }
            if let Some(items) = self.inside.get(&Some(f.id)) {
                for m in items {
                    if placed.insert(m.id) {
                        self.file(&here, m, taken, out);
                    }
                }
            }
        }
    }
    let w = Walk { children: &children, inside: &inside };
    for f in tops {
        w.folder("", by_id[&f], 0, &mut taken, &mut placed, &mut out);
    }
    let rows: HashMap<i64, &MediaRow> = media.iter().map(|m| (m.id, m)).collect();
    for id in ids {
        if let Some(m) = rows.get(id)
            && placed.insert(*id)
        {
            w.file("", m, &mut taken, &mut out);
        }
    }
    out
}

/// Read the live folders and items from the library and plan the list.
pub fn load_plan(s: &Session, ids: &[i64], picked: &[i64]) -> Result<Vec<VEntry>, String> {
    let db = s.db();
    let e = |x: rusqlite::Error| x.to_string();
    let folders: Vec<FolderRow> = db
        .prepare("SELECT id, parent_id, name FROM folders WHERE deleted_at IS NULL")
        .map_err(e)?
        .query_map([], |r| Ok(FolderRow { id: r.get(0)?, parent: r.get(1)?, name: r.get(2)? }))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let media: Vec<MediaRow> = db
        .prepare("SELECT id, object_id, original_name, folder_id, size FROM media WHERE deleted_at IS NULL")
        .map_err(e)?
        .query_map([], |r| {
            Ok(MediaRow {
                id: r.get(0)?,
                object: r.get(1)?,
                name: r.get(2)?,
                folder: r.get(3)?,
                size: r.get::<_, i64>(4)?.max(0) as u64,
            })
        })
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    drop(db);
    let plan = plan_entries(&folders, &media, ids, picked);
    if !plan.iter().any(|x| x.file.is_some()) {
        return Err("There is nothing to copy.".into());
    }
    Ok(plan)
}

/// How many files (not folders) a plan holds.
pub fn file_count(plan: &[VEntry]) -> usize {
    plan.iter().filter(|x| x.file.is_some()).count()
}

/// The question asked before Explorer pastes.
pub fn paste_question(files: usize) -> String {
    if files == 1 {
        "Copy 1 file out of the vault?\n\nIt will be a normal, unencrypted file.".into()
    } else {
        format!("Copy {files} files out of the vault?\n\nThey will be normal, unencrypted files.")
    }
}

// ---- pictures on the clipboard ------------------------------------------------

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

pub fn is_png(b: &[u8]) -> bool {
    b.starts_with(PNG_SIGNATURE)
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn i32_at(b: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// Pull one channel out of a packed pixel with a bit mask, scaled to 0-255.
fn channel(px: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let max = mask >> shift;
    let v = (px & mask) >> shift;
    if max == 255 { v as u8 } else { ((v as u64 * 255 + max as u64 / 2) / max as u64) as u8 }
}

/// Turn a Windows clipboard bitmap (CF_DIB / CF_DIBV5: a BITMAPINFOHEADER or
/// BITMAPV5HEADER followed by the pixels) into PNG bytes, in memory.
pub fn dib_to_png(dib: &[u8]) -> Result<Vec<u8>, String> {
    let bad = || "The picture on the clipboard couldn't be read.".to_string();
    let hsize = u32_at(dib, 0).ok_or_else(bad)? as usize;
    if !(40..=1024).contains(&hsize) || dib.len() < hsize {
        return Err(bad());
    }
    let width = i32_at(dib, 4).ok_or_else(bad)?;
    let height = i32_at(dib, 8).ok_or_else(bad)?;
    let bpp = u16_at(dib, 14).ok_or_else(bad)?;
    let compression = u32_at(dib, 16).ok_or_else(bad)?;
    let colors_used = u32_at(dib, 32).ok_or_else(bad)?;
    const BI_RGB: u32 = 0;
    const BI_BITFIELDS: u32 = 3;
    const BI_PNG: u32 = 5;
    const BI_ALPHABITFIELDS: u32 = 6;
    if compression == BI_PNG {
        let data = &dib[hsize..];
        return if is_png(data) { Ok(data.to_vec()) } else { Err(bad()) };
    }
    if width <= 0 || height == 0 {
        return Err(bad());
    }
    let w = width as usize;
    let top_down = height < 0;
    let h = height.unsigned_abs() as usize;
    if w > 32_768 || h > 32_768 {
        return Err("The picture on the clipboard is too big.".into());
    }

    // Colour masks: inside a V2+ header, or right after a plain one.
    let mut at = hsize;
    let mut masks: Option<[u32; 4]> = None;
    if compression == BI_BITFIELDS || compression == BI_ALPHABITFIELDS {
        let m = if hsize >= 52 {
            [u32_at(dib, 40), u32_at(dib, 44), u32_at(dib, 48), if hsize >= 56 { u32_at(dib, 52) } else { Some(0) }]
        } else {
            let n = if compression == BI_ALPHABITFIELDS { 4 } else { 3 };
            let m = [u32_at(dib, at), u32_at(dib, at + 4), u32_at(dib, at + 8), if n == 4 { u32_at(dib, at + 12) } else { Some(0) }];
            at += n * 4;
            m
        };
        masks = Some([m[0].ok_or_else(bad)?, m[1].ok_or_else(bad)?, m[2].ok_or_else(bad)?, m[3].ok_or_else(bad)?]);
    } else if compression != BI_RGB {
        return Err("That kind of picture on the clipboard isn't supported.".into());
    }
    let masks = match (bpp, masks) {
        (16 | 32, Some(m)) => m,
        (16, None) => [0x7C00, 0x03E0, 0x001F, 0],
        (32, None) => [0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0xFF00_0000],
        (1 | 4 | 8 | 24, None) => [0; 4],
        _ => return Err("That kind of picture on the clipboard isn't supported.".into()),
    };

    let mut palette: Vec<[u8; 3]> = Vec::new();
    if bpp <= 8 {
        let n = if colors_used == 0 { 1usize << bpp } else { (colors_used as usize).min(256) };
        for i in 0..n {
            let p = dib.get(at + i * 4..at + i * 4 + 3).ok_or_else(bad)?;
            palette.push([p[2], p[1], p[0]]);
        }
        at += n * 4;
    }

    let stride = (w * bpp as usize).div_ceil(32) * 4;
    let need = stride.checked_mul(h).ok_or_else(bad)?;
    let pixels = dib.get(at..at.checked_add(need).ok_or_else(bad)?).ok_or_else(bad)?;

    let mut rgba = vec![0u8; w * h * 4];
    let mut any_alpha = false;
    for y in 0..h {
        let src_row = if top_down { y } else { h - 1 - y };
        let row = &pixels[src_row * stride..src_row * stride + stride];
        for x in 0..w {
            let o = (y * w + x) * 4;
            let (r, g, b, a) = match bpp {
                32 | 16 => {
                    let px = if bpp == 32 {
                        u32::from_le_bytes(row[x * 4..x * 4 + 4].try_into().unwrap())
                    } else {
                        u16::from_le_bytes(row[x * 2..x * 2 + 2].try_into().unwrap()) as u32
                    };
                    (channel(px, masks[0]), channel(px, masks[1]), channel(px, masks[2]), channel(px, masks[3]))
                }
                24 => (row[x * 3 + 2], row[x * 3 + 1], row[x * 3], 0),
                _ => {
                    let bits = bpp as usize;
                    let bit = x * bits;
                    let byte = row[bit / 8];
                    let idx = (byte >> (8 - bits - bit % 8)) & ((1u16 << bits) - 1) as u8;
                    let c = palette.get(idx as usize).copied().unwrap_or([0, 0, 0]);
                    (c[0], c[1], c[2], 0)
                }
            };
            any_alpha |= a != 0;
            rgba[o..o + 4].copy_from_slice(&[r, g, b, a]);
        }
    }
    // Most copied bitmaps leave the alpha byte empty: that means solid.
    let has_alpha_channel = masks[3] != 0 && any_alpha;
    let (color, data) = if has_alpha_channel {
        (png::ColorType::Rgba, rgba)
    } else {
        let rgb: Vec<u8> = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        (png::ColorType::Rgb, rgb)
    };
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(color);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(&data).map_err(|e| e.to_string())?;
        wr.finish().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContent {
    /// Files and folders copied in Explorer (CF_HDROP).
    pub files: Vec<String>,
    /// A copied picture (screenshot, image from a browser…) as PNG.
    pub image_png: Option<Vec<u8>>,
    /// The clipboard holds items this app put there (Ctrl+C in the app).
    pub ours: bool,
}

// ---- commands -------------------------------------------------------------------

#[cfg(not(windows))]
const ONLY_WINDOWS: &str = "This only works on Windows.";

async fn plan_for(state: &Shared, ids: Vec<i64>, folders: Vec<i64>) -> Result<(std::sync::Weak<Session>, Vec<VEntry>), String> {
    let s = crate::sess(state)?;
    let weak = Arc::downgrade(&s);
    let plan = crate::blocking(move || load_plan(&s, &ids, &folders)).await?;
    Ok((weak, plan))
}

/// Drag items/folders out of the window to Explorer or the desktop. Runs a
/// real Windows drag (the mouse button must still be held). Resolves with
/// "copied" or "cancelled" when the drag ends.
#[tauri::command]
pub async fn drag_out(app: AppHandle, state: State<'_, Shared>, ids: Vec<i64>, folders: Vec<i64>) -> Result<String, String> {
    let (weak, plan) = plan_for(state.inner(), ids, folders).await?;
    #[cfg(windows)]
    {
        crate::blocking(move || win::drag_out(&app, weak, plan)).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, weak, plan);
        Err(ONLY_WINDOWS.into())
    }
}

/// Ctrl+C: put items/folders on the Windows clipboard so they can be pasted
/// in Explorer. Explorer asks before anything is copied. Returns how many
/// files are on it.
#[tauri::command]
pub async fn clipboard_put_files(app: AppHandle, state: State<'_, Shared>, ids: Vec<i64>, folders: Vec<i64>) -> Result<usize, String> {
    let (weak, plan) = plan_for(state.inner(), ids, folders).await?;
    #[cfg(windows)]
    {
        crate::blocking(move || win::clipboard_put(&app, weak, plan)).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, weak, plan);
        Err(ONLY_WINDOWS.into())
    }
}

/// Take our items off the clipboard (if they are still the ones on it).
#[tauri::command]
pub async fn clipboard_clear_ours(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        crate::blocking(move || win::clear_ours(&app)).await
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}

/// What is on the clipboard: copied files and/or a picture (as PNG).
#[tauri::command]
pub async fn clipboard_read() -> Result<ClipboardContent, String> {
    #[cfg(windows)]
    {
        crate::blocking(win::clipboard_read).await
    }
    #[cfg(not(windows))]
    {
        Err(ONLY_WINDOWS.into())
    }
}

/// The vault was locked: our items can't be pasted any more, so take them
/// off the clipboard. Safe to call from any thread.
pub fn on_lock(app: &AppHandle) {
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = win::clear_ours(&app);
        });
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// The app is closing (called on the main thread): never leave a clipboard
/// entry behind that points into the vault.
pub fn on_exit() {
    #[cfg(windows)]
    win::clear_ours_here();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(id: i64, parent: Option<i64>, name: &str) -> FolderRow {
        FolderRow { id, parent, name: name.into() }
    }
    fn m(id: i64, folder: Option<i64>, name: &str) -> MediaRow {
        MediaRow { id, object: format!("{id:064x}"), name: name.into(), folder, size: id as u64 * 10 }
    }
    fn paths(v: &[VEntry]) -> Vec<String> {
        v.iter().map(|e| if e.file.is_some() { e.path.clone() } else { format!("{}\\", e.path) }).collect()
    }

    #[test]
    fn plans_folders_with_structure_and_items_flat() {
        let folders = [f(1, None, "Alex"), f(2, Some(1), "Beach"), f(3, None, "Other"), f(4, Some(2), "Empty")];
        let media = [
            m(10, Some(1), "a.jpg"),
            m(11, Some(2), "b.jpg"),
            m(12, None, "c.jpg"),
            m(13, Some(3), "A.JPG"),
            m(14, Some(3), "x?.png"),
        ];
        let plan = plan_entries(&folders, &media, &[12, 13, 14, 10, 999], &[1, 2]);
        assert_eq!(
            paths(&plan),
            vec![
                "Alex\\",
                "Alex\\Beach\\",
                "Alex\\Beach\\Empty\\",
                "Alex\\Beach\\b.jpg",
                "Alex\\a.jpg",
                "c.jpg",
                "A.JPG",
                "x_.png",
            ]
        );
        // Item 10 was already inside a picked folder; 999 doesn't exist.
        assert_eq!(file_count(&plan), 5);
        let b = plan.iter().find(|e| e.path.ends_with("b.jpg")).unwrap();
        assert_eq!(b.file.as_ref().unwrap().media, 11);
        assert_eq!(b.file.as_ref().unwrap().size, 110);
    }

    #[test]
    fn same_names_get_numbers_ignoring_case() {
        let media = [m(1, None, "photo.jpg"), m(2, None, "Photo.JPG"), m(3, Some(5), "photo.jpg"), m(4, None, "noext")];
        let folders = [f(5, None, "photo.jpg")];
        let plan = plan_entries(&folders, &media, &[1, 2, 4, 4], &[5, 5]);
        assert_eq!(
            paths(&plan),
            vec!["photo.jpg\\", "photo.jpg\\photo.jpg", "photo (2).jpg", "Photo (3).JPG", "noext"]
        );
    }

    #[test]
    fn long_paths_stay_under_the_windows_limit() {
        let long = "x".repeat(200);
        let folders: Vec<FolderRow> =
            (1..=4).map(|i| f(i, if i == 1 { None } else { Some(i - 1) }, &long)).collect();
        let media = [m(10, Some(4), &format!("{}.jpg", "y".repeat(150))), m(11, None, &format!("{}.jpg", "é".repeat(300)))];
        let plan = plan_entries(&folders, &media, &[11], &[1]);
        assert_eq!(file_count(&plan), 2);
        for e in &plan {
            assert!(units(&e.path) <= MAX_REL, "{} is {} long", e.path, units(&e.path));
        }
        // Too deep to keep inside its folders: it goes to the top instead.
        let ten = plan.iter().find(|e| e.file.as_ref().is_some_and(|f| f.media == 10)).unwrap();
        assert_eq!(ten.path, format!("{}.jpg", "y".repeat(150)));
    }

    #[test]
    fn fit_keeps_extension() {
        assert_eq!(fit("short.png", 50), "short.png");
        let s = fit(&format!("{}.jpeg", "a".repeat(100)), 20);
        assert_eq!(units(&s), 20);
        assert!(s.ends_with(".jpeg"));
    }

    fn decode(png_bytes: &[u8]) -> (png::ColorType, u32, u32, Vec<u8>) {
        let dec = png::Decoder::new(std::io::Cursor::new(png_bytes));
        let mut r = dec.read_info().unwrap();
        let mut buf = vec![0; r.output_buffer_size().unwrap()];
        let info = r.next_frame(&mut buf).unwrap();
        buf.truncate(info.buffer_size());
        (info.color_type, info.width, info.height, buf)
    }

    fn header(size: u32, w: i32, h: i32, bpp: u16, compression: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend(size.to_le_bytes());
        v.extend(w.to_le_bytes());
        v.extend(h.to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(bpp.to_le_bytes());
        v.extend(compression.to_le_bytes());
        v.resize(40, 0);
        v
    }

    #[test]
    fn bottom_up_24_bit_dib() {
        // 2x2: bottom row first. Rows padded to 4 bytes (6 -> 8).
        let mut d = header(40, 2, 2, 24, 0);
        d.extend([0, 0, 255, 0, 255, 0, 0, 0]); // bottom: red, green
        d.extend([255, 0, 0, 255, 255, 255, 0, 0]); // top: blue, white
        let (c, w, h, px) = decode(&dib_to_png(&d).unwrap());
        assert_eq!((c, w, h), (png::ColorType::Rgb, 2, 2));
        assert_eq!(px, vec![0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0]);
    }

    #[test]
    fn top_down_32_bit_with_empty_alpha_is_solid() {
        let mut d = header(40, 1, -2, 32, 0);
        d.extend([10, 20, 30, 0, 40, 50, 60, 0]);
        let (c, _, _, px) = decode(&dib_to_png(&d).unwrap());
        assert_eq!(c, png::ColorType::Rgb);
        assert_eq!(px, vec![30, 20, 10, 60, 50, 40]);
    }

    #[test]
    fn v5_header_with_alpha_mask() {
        let mut d = header(124, 1, 1, 32, 3);
        d.resize(124, 0);
        d[40..44].copy_from_slice(&0x00FF_0000u32.to_le_bytes());
        d[44..48].copy_from_slice(&0x0000_FF00u32.to_le_bytes());
        d[48..52].copy_from_slice(&0x0000_00FFu32.to_le_bytes());
        d[52..56].copy_from_slice(&0xFF00_0000u32.to_le_bytes());
        d.extend([1, 2, 3, 128]);
        let (c, _, _, px) = decode(&dib_to_png(&d).unwrap());
        assert_eq!(c, png::ColorType::Rgba);
        assert_eq!(px, vec![3, 2, 1, 128]);
    }

    #[test]
    fn bitfields_after_plain_header_and_565() {
        let mut d = header(40, 2, 1, 16, 3);
        d.extend(0xF800u32.to_le_bytes());
        d.extend(0x07E0u32.to_le_bytes());
        d.extend(0x001Fu32.to_le_bytes());
        d.extend(0xF800u16.to_le_bytes()); // red
        d.extend(0x001Fu16.to_le_bytes()); // blue
        let (_, _, _, px) = decode(&dib_to_png(&d).unwrap());
        assert_eq!(px, vec![255, 0, 0, 0, 0, 255]);
    }

    #[test]
    fn palette_1_bit() {
        let mut d = header(40, 3, 1, 1, 0);
        d.extend([0, 0, 0, 0, 255, 255, 255, 0]); // black, white
        d.extend([0b1010_0000, 0, 0, 0]);
        let (_, _, _, px) = decode(&dib_to_png(&d).unwrap());
        assert_eq!(px, vec![255, 255, 255, 0, 0, 0, 255, 255, 255]);
    }

    #[test]
    fn rejects_broken_data() {
        assert!(dib_to_png(&[]).is_err());
        assert!(dib_to_png(&header(40, 100, 100, 24, 0)).is_err()); // no pixels
        assert!(dib_to_png(&header(40, 1, 1, 24, 4)).is_err()); // JPEG inside
        let mut p = header(40, 1, 1, 0, 5);
        p.extend(PNG_SIGNATURE);
        assert_eq!(dib_to_png(&p).unwrap(), PNG_SIGNATURE);
    }

    #[test]
    fn plans_from_a_real_library() {
        use crate::{import, session};
        use std::sync::atomic::AtomicBool;
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        let src = t.path().join("src");
        std::fs::create_dir_all(src.join("Alex/Beach")).unwrap();
        std::fs::write(src.join("Alex/a.jpg"), vec![1u8; 3000]).unwrap();
        std::fs::write(src.join("Alex/Beach/b.jpg"), vec![2u8; 3000]).unwrap();
        std::fs::write(src.join("c.jpg"), vec![3u8; 3000]).unwrap();
        import::run(
            &s,
            &import::Job { id: 1, paths: vec![src.join("Alex").display().to_string(), src.join("c.jpg").display().to_string()], target: None, password: None, archive_folder: true },
            &AtomicBool::new(false),
            &mut |_| {},
        );
        let alex = crate::library::find_child(&s.db(), None, "Alex").unwrap().unwrap();
        let c: i64 = s.db().query_row("SELECT id FROM media WHERE original_name = 'c.jpg'", [], |r| r.get(0)).unwrap();
        let plan = load_plan(&s, &[c], &[alex]).unwrap();
        assert_eq!(paths(&plan), vec!["Alex\\", "Alex\\Beach\\", "Alex\\Beach\\b.jpg", "Alex\\a.jpg", "c.jpg"]);
        assert_eq!(plan[2].file.as_ref().unwrap().size, 3000);
        assert!(load_plan(&s, &[], &[]).is_err());
        assert_eq!(paste_question(1), "Copy 1 file out of the vault?\n\nIt will be a normal, unencrypted file.");
    }
}
