//! Thumbnail pages: a folder's thumbnails packed together into a few
//! encrypted objects, so a grid needs one decryption per page (up to
//! [`PAGE_ITEMS`] tiles) instead of one per tile.
//!
//! Each item's own thumbnail object stays the source of truth; pages are a
//! derived cache, made in the background (by [`start`]'s thread) for folders
//! that grids show, and slowly for every folder. They can be dropped and
//! made again at any time ("Delete thumbnails" drops them too). A page that
//! is missing, damaged or out of date is simply not used: tiles fall back
//! to their own thumbnail object.
//!
//! The format has two sizes: `Big` pages would hold the stored thumbnails
//! exactly as they are (640 px), `Small` pages hold 256 px WebP copies made
//! from them (dense grids, the minimap, the sidebar). The app makes small
//! pages only: measured through the protocol (`protocol::tests::grid_load`),
//! a big thumbnail decrypts about as fast on its own as from a page (the
//! cost is in the bytes, not in opening the object), while big pages would
//! store every thumbnail twice; small pages are 13 times smaller than the
//! thumbnails they come from and serve a whole screen in a few ms. Small
//! thumbnails exist only in pages: until a folder's are made, small
//! requests get the big thumbnail.
//!
//! A page is found by the *thumbnail object id* it was made from (not the
//! item), so a remade thumbnail (new object id) can never be answered with
//! the old picture. Which page holds which thumbnail is kept in the library
//! (`thumb_bundles`, schema v14) and in memory while the vault is open;
//! decrypted pages stay in memory (at most [`CACHE_BYTES`], wiped when
//! dropped) until the vault locks. Nothing decrypted is written anywhere.
//!
//! Page layout (the plaintext of the encrypted object; little-endian):
//!
//! ```text
//! 0   4  magic "MVTP"
//! 4   1  version 1
//! 5   1  size: 0 = stored thumbnails as they are, 1 = small (256 px)
//! 6   2  reserved, 0
//! 8   4  n = number of entries
//! 12  n × 24: thumbnail object id (16) | offset (u32, from the end of this table) | length (u32)
//! ..     the pictures, back to back (JPEG or WebP, told apart by their first bytes)
//! ```

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension, params};
use vault_core::{ObjectId, ObjectKind};
use zeroize::Zeroizing;

use crate::session::Session;

/// Thumbnails per page (at most).
pub const PAGE_ITEMS: usize = 96;
/// Bytes per page (at most, roughly): 96 small thumbnails are about 0.4 MB.
const PAGE_BYTES: usize = 6 << 20;
/// Decrypted pages kept in memory (all sizes together).
pub const CACHE_BYTES: usize = 64 << 20;
/// Folders with fewer thumbnails than this get no pages (a page wouldn't save anything).
const MIN_FOLDER: usize = 16;
/// New thumbnails not in a page yet: at least this many before a new page is added.
const MIN_NEW: usize = 16;
/// A folder a grid shows is looked at again (for new thumbnails) at most this often.
const RECHECK: Duration = Duration::from_secs(45);

const MAGIC: &[u8; 4] = b"MVTP";
const HEAD: usize = 12;
const ENTRY: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Size {
    Big = 0,
    Small = 1,
}

impl Size {
    fn from_i64(v: i64) -> Option<Size> {
        match v {
            0 => Some(Size::Big),
            1 => Some(Size::Small),
            _ => None,
        }
    }
}

// ---- the page format ------------------------------------------------------------------

/// Pack pictures into one page (plaintext).
pub fn build_page(size: Size, entries: &[(ObjectId, &[u8])]) -> Zeroizing<Vec<u8>> {
    let total: usize = entries.iter().map(|(_, b)| b.len()).sum();
    let mut out = Zeroizing::new(Vec::with_capacity(HEAD + entries.len() * ENTRY + total));
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&[1, size as u8, 0, 0]);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    let mut off = 0u32;
    for (id, b) in entries {
        out.extend_from_slice(&id.0);
        out.extend_from_slice(&off.to_le_bytes());
        out.extend_from_slice(&(b.len() as u32).to_le_bytes());
        off += b.len() as u32;
    }
    for (_, b) in entries {
        out.extend_from_slice(b);
    }
    out
}

/// A decrypted page: its bytes and where each picture is in them.
pub struct Page {
    data: Zeroizing<Vec<u8>>,
    at: HashMap<ObjectId, (usize, usize)>,
}

impl Page {
    pub fn parse(data: Zeroizing<Vec<u8>>) -> Result<Page, String> {
        let bad = || "This thumbnail page is damaged.".to_string();
        if data.len() < HEAD || &data[..4] != MAGIC || data[4] != 1 {
            return Err(bad());
        }
        Size::from_i64(data[5] as i64).ok_or_else(bad)?;
        let n = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
        let base = HEAD.checked_add(n.checked_mul(ENTRY).ok_or_else(bad)?).ok_or_else(bad)?;
        if base > data.len() {
            return Err(bad());
        }
        let mut at = HashMap::with_capacity(n);
        for e in data[HEAD..base].chunks_exact(ENTRY) {
            let id = ObjectId(e[..16].try_into().unwrap());
            let off = u32::from_le_bytes(e[16..20].try_into().unwrap()) as usize;
            let len = u32::from_le_bytes(e[20..24].try_into().unwrap()) as usize;
            let start = base.checked_add(off).ok_or_else(bad)?;
            if start.checked_add(len).is_none_or(|end| end > data.len()) {
                return Err(bad());
            }
            at.insert(id, (start, len));
        }
        Ok(Page { data, at })
    }

    pub fn get(&self, thumb: &ObjectId) -> Option<&[u8]> {
        self.at.get(thumb).map(|&(a, n)| &self.data[a..a + n])
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.at.len()
    }

    fn bytes(&self) -> usize {
        self.data.len()
    }
}

// ---- what is in memory while the vault is open -----------------------------------------------

#[derive(Default)]
struct State {
    /// The vault this belongs to (anything else is forgotten first).
    vault: String,
    /// Which page holds each thumbnail; None = not read from the library yet.
    members: Option<HashMap<(ObjectId, Size), ObjectId>>,
    /// Decrypted pages, least recently used first.
    pages: Vec<(ObjectId, Arc<Page>)>,
    bytes: usize,
    /// One lock per page being decrypted, so six tiles asking at once decrypt it once.
    loading: HashMap<ObjectId, Arc<Mutex<()>>>,
    /// Folders a grid showed tiles of that weren't in pages (made first).
    wanted: Vec<(Option<i64>, Size)>,
    /// When each folder was last looked at for that (not again for a while).
    checked: HashMap<(Option<i64>, Size), Instant>,
    stats: Stats,
}

/// Counts, for the measurements and the tests.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Stats {
    pub hits: u64,
    pub misses: u64,
    pub pages_decrypted: u64,
    pub pages_made: u64,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn state<'a>(g: &'a mut std::sync::MutexGuard<'static, Option<State>>, vault: &str) -> &'a mut State {
    if g.as_ref().is_none_or(|st| st.vault != vault) {
        **g = Some(State { vault: vault.to_string(), ..Default::default() });
    }
    g.as_mut().unwrap()
}

fn lock() -> std::sync::MutexGuard<'static, Option<State>> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

fn vault_id(s: &Session) -> String {
    s.vault().header().vault_id.clone()
}

/// Forget everything decrypted (the vault locked, or another one opened).
pub fn forget() {
    *lock() = None;
}

#[cfg(test)]
pub fn stats() -> Stats {
    lock().as_ref().map(|s| s.stats).unwrap_or_default()
}

fn load_members(c: &Connection) -> HashMap<(ObjectId, Size), ObjectId> {
    let mut out = HashMap::new();
    let Ok(mut st) = c.prepare("SELECT object_id, size, members FROM thumb_bundles") else {
        return out;
    };
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Vec<u8>>(2)?)));
    if let Ok(rows) = rows {
        for (page, size, members) in rows.flatten() {
            let (Ok(page), Some(size)) = (ObjectId::from_hex(&page), Size::from_i64(size)) else { continue };
            for m in members.chunks_exact(16) {
                out.insert((ObjectId(m.try_into().unwrap()), size), page);
            }
        }
    }
    out
}

/// Read which page holds what from the library, once per session.
fn ensure_members(s: &Session, vault: &str) {
    if lock().as_ref().is_some_and(|st| st.vault == vault && st.members.is_some()) {
        return;
    }
    // Read without holding the lock (the library has its own).
    let m = load_members(&s.db());
    let mut g = lock();
    state(&mut g, vault).members.get_or_insert(m);
}

/// The page holding `thumb` at `size`, if there is one.
fn page_of(s: &Session, vault: &str, thumb: &ObjectId, size: Size) -> Option<ObjectId> {
    ensure_members(s, vault);
    let mut g = lock();
    state(&mut g, vault).members.as_ref()?.get(&(*thumb, size)).copied()
}

fn cached(st: &mut State, page: &ObjectId) -> Option<Arc<Page>> {
    let i = st.pages.iter().position(|(id, _)| id == page)?;
    let e = st.pages.remove(i);
    let p = e.1.clone();
    st.pages.push(e);
    Some(p)
}

fn remember(st: &mut State, id: ObjectId, p: Arc<Page>) {
    st.bytes += p.bytes();
    st.pages.push((id, p));
    while st.bytes > CACHE_BYTES && st.pages.len() > 1 {
        let (_, old) = st.pages.remove(0);
        st.bytes -= old.bytes();
    }
}

/// A page, from memory or decrypted now (once, however many ask at the same time).
fn load(s: &Session, vault: &str, page: &ObjectId) -> Option<Arc<Page>> {
    let slot = {
        let mut g = lock();
        let st = state(&mut g, vault);
        if let Some(p) = cached(st, page) {
            return Some(p);
        }
        st.loading.entry(*page).or_default().clone()
    };
    let _one = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = cached(state(&mut lock(), vault), page) {
        return Some(p);
    }
    let read = s.vault().read_object(ObjectKind::Thumbnail, page).map_err(|e| e.to_string()).and_then(Page::parse);
    let mut g = lock();
    let st = state(&mut g, vault);
    st.loading.remove(page);
    if s.is_closed() {
        // Locked meanwhile: nothing decrypted is kept.
        return None;
    }
    match read {
        Ok(p) => {
            let p = Arc::new(p);
            st.stats.pages_decrypted += 1;
            remember(st, *page, p.clone());
            Some(p)
        }
        Err(_) => {
            // Missing or damaged: never asked for again this session (its folder is made again).
            if let Some(m) = st.members.as_mut() {
                m.retain(|_, v| v != page);
            }
            None
        }
    }
}

/// The picture for thumbnail `thumb` at `size` from a page, if one has it.
pub fn get(s: &Session, thumb: &ObjectId, size: Size) -> Option<Vec<u8>> {
    let vault = vault_id(s);
    let page = page_of(s, &vault, thumb, size)?;
    let p = load(s, &vault, &page)?;
    let out = p.get(thumb).map(|b| b.to_vec());
    let mut g = lock();
    let st = state(&mut g, &vault);
    if out.is_some() {
        st.stats.hits += 1;
    } else if let Some(m) = st.members.as_mut() {
        // Listed but not in the page (shouldn't happen): don't look there again.
        m.remove(&(*thumb, size));
    }
    out
}

/// A grid showed a tile of this folder whose thumbnail (at this size)
/// wasn't in a page: make the folder's pages of that size soon.
pub fn note_miss(s: &Session, folder: Option<i64>, size: Size) {
    let vault = vault_id(s);
    let mut g = lock();
    let st = state(&mut g, &vault);
    st.stats.misses += 1;
    let key = (folder, size);
    let recent = st.checked.get(&key).is_some_and(|t| t.elapsed() < RECHECK);
    if !recent && !st.wanted.contains(&key) {
        st.checked.insert(key, Instant::now());
        st.wanted.push(key);
        drop(g);
        let (m, cv) = &WAKE;
        *m.lock().unwrap_or_else(|e| e.into_inner()) = true;
        cv.notify_all();
    }
}

// ---- making pages ---------------------------------------------------------------------------

/// What making one folder's pages did.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Made {
    pub pages: usize,
    pub items: usize,
    pub removed: usize,
}

/// The folder's thumbnails (each once), oldest item first.
fn folder_thumbs(c: &Connection, folder: Option<i64>) -> Vec<ObjectId> {
    let Ok(mut st) = c.prepare(
        "SELECT thumb_object_id FROM media WHERE folder_id IS ?1 AND deleted_at IS NULL \
         AND thumb_object_id IS NOT NULL AND thumb_object_id <> '' GROUP BY thumb_object_id ORDER BY MIN(id)",
    ) else {
        return Vec::new();
    };
    st.query_map([folder], |r| r.get::<_, String>(0))
        .map(|it| it.flatten().filter_map(|h| ObjectId::from_hex(&h).ok()).collect())
        .unwrap_or_default()
}

/// The folder's pages of one size: (page id, its thumbnails).
fn folder_pages(c: &Connection, folder: Option<i64>, size: Size) -> Vec<(ObjectId, Vec<ObjectId>)> {
    let Ok(mut st) = c.prepare("SELECT object_id, members FROM thumb_bundles WHERE folder_id IS ?1 AND size = ?2") else {
        return Vec::new();
    };
    st.query_map(params![folder, size as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map(|it| {
            it.flatten()
                .filter_map(|(p, m)| {
                    Some((ObjectId::from_hex(&p).ok()?, m.chunks_exact(16).map(|x| ObjectId(x.try_into().unwrap())).collect()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The picture a page holds for this thumbnail.
fn page_picture(s: &Session, thumb: &ObjectId, size: Size) -> Option<Zeroizing<Vec<u8>>> {
    let big = s.vault().read_object(ObjectKind::Thumbnail, thumb).ok()?;
    match size {
        Size::Big => Some(big),
        Size::Small => match crate::picture::small_from_thumb(&big) {
            Ok(Some(small)) => Some(small),
            // Already small, or a picture only the window can read: as it is.
            Ok(None) | Err(_) => Some(big),
        },
    }
}

/// Encrypt and record pages made of `thumbs` (in that order). Stops early
/// (keeping what is done) when the vault closes.
fn write_pages(s: &Session, folder: Option<i64>, size: Size, thumbs: &[ObjectId], pause: Duration) -> Result<Vec<(ObjectId, Vec<ObjectId>)>, String> {
    let mut made = Vec::new();
    let mut pics: Vec<(ObjectId, Zeroizing<Vec<u8>>)> = Vec::new();
    let mut bytes = 0;
    let flush = |pics: &mut Vec<(ObjectId, Zeroizing<Vec<u8>>)>, made: &mut Vec<(ObjectId, Vec<ObjectId>)>| -> Result<(), String> {
        if pics.is_empty() {
            return Ok(());
        }
        let entries: Vec<(ObjectId, &[u8])> = pics.iter().map(|(id, b)| (*id, &b[..])).collect();
        let page = build_page(size, &entries);
        let (pid, _) = s.vault().add_object(ObjectKind::Thumbnail, &page[..]).map_err(|e| e.to_string())?;
        let members: Vec<u8> = pics.iter().flat_map(|(id, _)| id.0).collect();
        s.db()
            .execute(
                "INSERT INTO thumb_bundles(object_id, folder_id, size, items, bytes, members, made_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![pid.to_hex(), folder, size as i64, pics.len() as i64, page.len() as i64, members, now()],
            )
            .map_err(|e| e.to_string())?;
        made.push((pid, pics.iter().map(|(id, _)| *id).collect()));
        pics.clear();
        Ok(())
    };
    for t in thumbs {
        if s.is_closed() {
            return Ok(made);
        }
        let Some(pic) = page_picture(s, t, size) else { continue };
        bytes += pic.len();
        pics.push((*t, pic));
        if pics.len() >= PAGE_ITEMS || bytes >= PAGE_BYTES {
            flush(&mut pics, &mut made)?;
            bytes = 0;
        }
        if !pause.is_zero() {
            std::thread::sleep(pause);
        }
    }
    flush(&mut pics, &mut made)?;
    Ok(made)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn drop_pages(s: &Session, pages: &[ObjectId]) {
    for p in pages {
        let _ = s.db().execute("DELETE FROM thumb_bundles WHERE object_id = ?", [p.to_hex()]);
        let _ = s.vault().delete_object(ObjectKind::Thumbnail, p);
    }
}

/// Bring one folder's pages of one size up to date: add a page for new
/// thumbnails once there are enough of them, and make them all again when
/// many have gone (moved, deleted, remade) or there are too many small
/// add-on pages. `pause` between thumbnails keeps the computer free.
pub fn refresh_folder(s: &Session, folder: Option<i64>, size: Size, pause: Duration) -> Result<Made, String> {
    let vault = vault_id(s);
    let (current, pages) = {
        let db = s.db();
        (folder_thumbs(&db, folder), folder_pages(&db, folder, size))
    };
    let cur: HashSet<ObjectId> = current.iter().copied().collect();
    // In a page anywhere (an item moved here from another folder still has its old page).
    let paged: HashSet<ObjectId> = {
        let mine: HashSet<ObjectId> = pages.iter().flat_map(|(_, m)| m.iter().copied()).collect();
        ensure_members(s, &vault);
        let g = lock();
        let others = g.as_ref().and_then(|st| st.members.as_ref());
        current.iter().copied().filter(|t| mine.contains(t) || others.is_some_and(|m| m.contains_key(&(*t, size)))).collect()
    };
    let in_pages: usize = pages.iter().map(|(_, m)| m.len()).sum();
    let stale = pages.iter().flat_map(|(_, m)| m.iter()).filter(|t| !cur.contains(t)).count();
    let new: Vec<ObjectId> = current.iter().copied().filter(|t| !paged.contains(t)).collect();
    let mut out = Made::default();
    if current.len() < MIN_FOLDER {
        // Too few to be worth a page: drop pages that only hold what went away.
        let gone: Vec<ObjectId> = pages.iter().filter(|(_, m)| m.iter().all(|t| !cur.contains(t))).map(|(p, _)| *p).collect();
        out.removed = gone.len();
        forget_pages(&vault, &gone);
        drop_pages(s, &gone);
        if !gone.is_empty() {
            s.mark_dirty();
        }
        return Ok(out);
    }
    let needed = current.len().div_ceil(PAGE_ITEMS);
    let rebuild = (stale > 0 && stale * 4 >= in_pages.max(1)) || pages.len() > needed + 2;
    let todo: Vec<ObjectId> = if rebuild { current.clone() } else if new.len() >= MIN_NEW || (pages.is_empty() && !new.is_empty()) { new } else { Vec::new() };
    if todo.is_empty() {
        return Ok(out);
    }
    let made = write_pages(s, folder, size, &todo, pause)?;
    out.pages = made.len();
    out.items = made.iter().map(|(_, m)| m.len()).sum();
    {
        let mut g = lock();
        let st = state(&mut g, &vault);
        st.stats.pages_made += made.len() as u64;
        if let Some(m) = st.members.as_mut() {
            for (p, ids) in &made {
                for t in ids {
                    m.insert((*t, size), *p);
                }
            }
        }
    }
    if rebuild && !s.is_closed() {
        let old: Vec<ObjectId> = pages.iter().map(|(p, _)| *p).collect();
        out.removed = old.len();
        forget_pages(&vault, &old);
        drop_pages(s, &old);
    }
    s.mark_dirty();
    Ok(out)
}

/// Thumbnails that are going away for good (their item deleted, or a
/// picture rotated): every page holding a copy of one is removed at once, so
/// no copy is left behind, and its folder's pages are made again soon for
/// the thumbnails still there. How many pages went.
pub fn drop_pages_holding(s: &Session, thumbs: &[ObjectId]) -> usize {
    if thumbs.is_empty() {
        return 0;
    }
    let gone_thumbs: HashSet<&ObjectId> = thumbs.iter().collect();
    let hit: Vec<(ObjectId, Option<i64>, Option<Size>)> = {
        let db = s.db();
        let Ok(mut st) = db.prepare("SELECT object_id, folder_id, size, members FROM thumb_bundles") else { return 0 };
        st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, i64>(2)?, r.get::<_, Vec<u8>>(3)?)))
            .map(|it| {
                it.flatten()
                    .filter(|(_, _, _, m)| m.chunks_exact(16).any(|x| gone_thumbs.contains(&ObjectId(x.try_into().unwrap()))))
                    .filter_map(|(p, f, z, _)| Some((ObjectId::from_hex(&p).ok()?, f, Size::from_i64(z))))
                    .collect()
            })
            .unwrap_or_default()
    };
    if hit.is_empty() {
        return 0;
    }
    let pages: Vec<ObjectId> = hit.iter().map(|(p, _, _)| *p).collect();
    let vault = vault_id(s);
    forget_pages(&vault, &pages);
    drop_pages(s, &pages);
    s.mark_dirty();
    // The rest of those folders: paged again by the background thread.
    {
        let mut g = lock();
        let st = state(&mut g, &vault);
        for (_, folder, size) in &hit {
            if let Some(size) = size {
                let key = (*folder, *size);
                st.checked.remove(&key);
                if !st.wanted.contains(&key) {
                    st.wanted.push(key);
                }
            }
        }
    }
    let (m, cv) = &WAKE;
    *m.lock().unwrap_or_else(|e| e.into_inner()) = true;
    cv.notify_all();
    pages.len()
}

/// Pages no longer in the library: out of memory too.
fn forget_pages(vault: &str, pages: &[ObjectId]) {
    if pages.is_empty() {
        return;
    }
    let mut g = lock();
    let st = state(&mut g, vault);
    let gone: HashSet<&ObjectId> = pages.iter().collect();
    if let Some(m) = st.members.as_mut() {
        // Keep entries that a newer page took over.
        m.retain(|_, p| !gone.contains(p));
    }
    st.pages.retain(|(id, p)| {
        let keep = !gone.contains(id);
        if !keep {
            st.bytes -= p.bytes();
        }
        keep
    });
}

/// Every page (both sizes) out of the library and the vault ("Delete thumbnails").
pub fn delete_all(s: &Session) -> usize {
    let ids: Vec<ObjectId> = {
        let db = s.db();
        let Ok(mut st) = db.prepare("SELECT object_id FROM thumb_bundles") else { return 0 };
        st.query_map([], |r| r.get::<_, String>(0)).map(|it| it.flatten().filter_map(|h| ObjectId::from_hex(&h).ok()).collect()).unwrap_or_default()
    };
    let _ = s.db().execute("DELETE FROM thumb_bundles", []);
    for p in &ids {
        let _ = s.vault().delete_object(ObjectKind::Thumbnail, p);
    }
    forget();
    if !ids.is_empty() {
        s.mark_dirty();
    }
    ids.len()
}

/// How many pages there are and the space they take (Settings → storage).
pub fn usage(c: &Connection) -> (i64, i64) {
    c.query_row("SELECT COUNT(*), IFNULL(SUM(bytes), 0) FROM thumb_bundles", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .ok()
        .flatten()
        .unwrap_or((0, 0))
}

// ---- the background maker ------------------------------------------------------------------

/// Folders (and the top level) with enough thumbnails for pages, most items first.
fn all_folders(c: &Connection) -> Vec<Option<i64>> {
    let Ok(mut st) = c.prepare(
        "SELECT folder_id FROM media WHERE deleted_at IS NULL AND thumb_object_id IS NOT NULL AND thumb_object_id <> '' \
         GROUP BY folder_id HAVING COUNT(*) >= ?1 ORDER BY COUNT(*) DESC",
    ) else {
        return Vec::new();
    };
    st.query_map([MIN_FOLDER as i64], |r| r.get::<_, Option<i64>>(0)).map(|it| it.flatten().collect()).unwrap_or_default()
}

fn take_wanted(vault: &str) -> Option<(Option<i64>, Size)> {
    let mut g = lock();
    let st = state(&mut g, vault);
    (!st.wanted.is_empty()).then(|| st.wanted.remove(0))
}

fn sleep_until_woken(ms: u64) {
    let (m, cv) = &WAKE;
    let g = m.lock().unwrap_or_else(|e| e.into_inner());
    let (mut g, _) = cv.wait_timeout_while(g, Duration::from_millis(ms), |woken| !*woken).unwrap_or_else(|e| e.into_inner());
    *g = false;
}

/// Make (small) pages in the background while the vault is open: folders
/// grids showed first, right away; then, slowly, every folder.
pub fn start(s: Arc<Session>) {
    std::thread::spawn(move || {
        crate::analyse::polite_thread();
        let vault = vault_id(&s);
        // Let unlocking and the first grid have the computer first.
        sleep_until_woken(4000);
        let mut sweep: Vec<Option<i64>> = Vec::new();
        let mut last_sweep: Option<Instant> = None;
        while !s.is_closed() {
            if let Some((f, size)) = take_wanted(&vault) {
                let _ = refresh_folder(&s, f, size, Duration::ZERO);
                if s.is_dirty() {
                    s.save_soon();
                }
                continue;
            }
            if sweep.is_empty() && last_sweep.is_none_or(|t| t.elapsed() > Duration::from_secs(600)) {
                sweep = all_folders(&s.db());
                sweep.reverse();
                last_sweep = Some(Instant::now());
            }
            match sweep.pop() {
                Some(f) => {
                    let _ = refresh_folder(&s, f, Size::Small, Duration::from_millis(2));
                    if s.is_dirty() {
                        s.save_soon();
                    }
                    sleep_until_woken(500);
                }
                None => sleep_until_woken(30_000),
            }
        }
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::picture::{Rgb, encode_webp};

    /// Tests that use (or forget) what is kept in memory take turns.
    pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// A photo-like 640 × 427 test picture, different for each `i`.
    pub(crate) fn picture(i: usize, w: usize, h: usize) -> Rgb {
        let mut x: u32 = 0x9e37_79b9 ^ (i as u32).wrapping_mul(2_654_435_761);
        let mut px = Zeroizing::new(Vec::with_capacity(w * h * 3));
        let f = 5.0 + (i % 7) as f64;
        for y in 0..h {
            for xx in 0..w {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                let n = (x % 24) as f64 - 12.0;
                let v = ((xx as f64 / f).sin() * 50.0 + (y as f64 / (f * 1.7)).cos() * 50.0 + 128.0 + n).clamp(0.0, 255.0);
                px.extend_from_slice(&[v as u8, ((xx * 255 / w) as f64 + n).clamp(0.0, 255.0) as u8, ((y * 255 / h + i * 13) % 256) as u8]);
            }
        }
        Rgb { w, h, px }
    }

    /// A vault with one folder of `n` pictures, each with a real WebP thumbnail
    /// (`thumb_size` px wide); the folder id and the item ids.
    pub(crate) fn vault_with_folder(t: &std::path::Path, n: usize, thumb_w: usize) -> (Session, i64, Vec<i64>) {
        let (s, _) = crate::session::create(t.to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        s.db().execute("INSERT INTO folders(name, created_at) VALUES ('Trip', 0)", []).unwrap();
        let folder = s.db().last_insert_rowid();
        // A few different pictures, used in turn (encoding is the slow part).
        let thumbs: Vec<Zeroizing<Vec<u8>>> =
            (0..n.min(24)).map(|i| encode_webp(&picture(i, thumb_w, thumb_w * 2 / 3), crate::picture::THUMB_WEBP_QUALITY).unwrap()).collect();
        let mut ids = Vec::new();
        for i in 0..n {
            let (oid, _) = s.vault().add_object(ObjectKind::Media, &b"not really a photo"[..]).unwrap();
            let (tid, _) = s.vault().add_object(ObjectKind::Thumbnail, &thumbs[i % thumbs.len()][..]).unwrap();
            s.db()
                .execute(
                    "INSERT INTO media(object_id, thumb_object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, width, height) \
                     VALUES (?1, ?2, ?3, 'image', ?4, 'jpg', 1, 'h', 0, ?5, ?6)",
                    params![oid.to_hex(), tid.to_hex(), folder, format!("p{i}.jpg"), thumb_w as i64 * 4, thumb_w as i64 * 8 / 3],
                )
                .unwrap();
            ids.push(s.db().last_insert_rowid());
        }
        (s, folder, ids)
    }

    fn thumb_of(s: &Session, id: i64) -> ObjectId {
        ObjectId::from_hex(&s.db().query_row("SELECT thumb_object_id FROM media WHERE id = ?", [id], |r| r.get::<_, String>(0)).unwrap()).unwrap()
    }

    #[test]
    fn folders_get_pages_that_follow_their_changes() {
        let _one = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = tempfile::tempdir().unwrap();
        let (s, folder, ids) = vault_with_folder(t.path(), 150, 320);
        forget();
        // 150 thumbnails: two pages of each size.
        let big = refresh_folder(&s, Some(folder), Size::Big, Duration::ZERO).unwrap();
        assert_eq!((big.pages, big.items, big.removed), (2, 150, 0));
        let small = refresh_folder(&s, Some(folder), Size::Small, Duration::ZERO).unwrap();
        assert_eq!((small.pages, small.items), (2, 150));
        // Nothing changed: nothing to do.
        assert_eq!(refresh_folder(&s, Some(folder), Size::Big, Duration::ZERO).unwrap(), Made::default());
        // Every thumbnail comes from a page: the big one exactly as stored, the small one smaller.
        let stored = s.vault().read_object(ObjectKind::Thumbnail, &thumb_of(&s, ids[7])).unwrap();
        assert_eq!(get(&s, &thumb_of(&s, ids[7]), Size::Big).as_deref(), Some(&stored[..]));
        let sm = get(&s, &thumb_of(&s, ids[7]), Size::Small).unwrap();
        let pic = crate::picture::decode(&sm).unwrap();
        assert_eq!((pic.w, pic.h), (256, 170));
        assert!(sm.len() < stored.len());
        // Read from the library again after locking (and decrypted once per page).
        forget();
        for id in &ids {
            assert!(get(&s, &thumb_of(&s, *id), Size::Big).is_some());
        }
        assert_eq!(stats().pages_decrypted, 2);
        assert_eq!(stats().hits, 150);
        // 20 new items: an add-on page; a remade thumbnail isn't answered from the old page.
        let extra = encode_webp(&picture(99, 320, 213), 80.0).unwrap();
        for i in 0..20 {
            let (oid, _) = s.vault().add_object(ObjectKind::Media, &b"x"[..]).unwrap();
            let (tid, _) = s.vault().add_object(ObjectKind::Thumbnail, &extra[..]).unwrap();
            s.db()
                .execute(
                    "INSERT INTO media(object_id, thumb_object_id, folder_id, kind, original_name, ext, size, sha256, imported_at) VALUES (?1, ?2, ?3, 'image', ?4, 'jpg', 1, 'h', 0)",
                    params![oid.to_hex(), tid.to_hex(), folder, format!("n{i}.jpg")],
                )
                .unwrap();
        }
        let add = refresh_folder(&s, Some(folder), Size::Big, Duration::ZERO).unwrap();
        assert_eq!((add.pages, add.items, add.removed), (1, 20, 0));
        let (tid, _) = s.vault().add_object(ObjectKind::Thumbnail, &extra[..]).unwrap();
        let old = thumb_of(&s, ids[0]);
        s.db().execute("UPDATE media SET thumb_object_id = ? WHERE id = ?", params![tid.to_hex(), ids[0]]).unwrap();
        assert!(get(&s, &tid, Size::Big).is_none(), "a new thumbnail is never answered from a page made before");
        assert!(get(&s, &old, Size::Big).is_some(), "(the old one is still in its page, until it is made again)");
        // Most of the folder gone to the trash: made again, the old pages removed.
        s.db().execute("UPDATE media SET deleted_at = 1 WHERE id IN (SELECT id FROM media WHERE folder_id = ? ORDER BY id LIMIT 100)", [folder]).unwrap();
        let re = refresh_folder(&s, Some(folder), Size::Big, Duration::ZERO).unwrap();
        assert_eq!((re.pages, re.items, re.removed), (1, 70, 3));
        let pages: i64 = s.db().query_row("SELECT COUNT(*) FROM thumb_bundles WHERE size = 0", [], |r| r.get(0)).unwrap();
        assert_eq!(pages, 1);
        assert!(get(&s, &old, Size::Big).is_none());
        assert!(get(&s, &thumb_of(&s, ids[120]), Size::Big).is_some());
        // A missing or damaged page is skipped (the tile falls back to its own thumbnail).
        s.db().execute("UPDATE thumb_bundles SET object_id = ? WHERE size = 0", [ObjectId::random().to_hex()]).unwrap();
        forget();
        assert!(get(&s, &thumb_of(&s, ids[120]), Size::Big).is_none());
        let (garbage, _) = s.vault().add_object(ObjectKind::Thumbnail, &b"MVTP\x01\x00\x00\x00\xff\xff\xff\x00"[..]).unwrap();
        s.db().execute("UPDATE thumb_bundles SET object_id = ? WHERE size = 0", [garbage.to_hex()]).unwrap();
        forget();
        assert!(get(&s, &thumb_of(&s, ids[120]), Size::Big).is_none());
        // "Delete thumbnails" takes the pages too.
        assert_eq!(delete_all(&s), 3);
        assert_eq!(usage(&s.db()), (0, 0));
    }

    #[test]
    fn deleting_for_good_removes_every_page_holding_a_copy() {
        let _one = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = tempfile::tempdir().unwrap();
        let (s, folder, ids) = vault_with_folder(t.path(), 150, 200);
        forget();
        refresh_folder(&s, Some(folder), Size::Big, Duration::ZERO).unwrap();
        refresh_folder(&s, Some(folder), Size::Small, Duration::ZERO).unwrap();
        assert_eq!(usage(&s.db()).0, 4);
        let gone = thumb_of(&s, ids[3]);
        let kept = thumb_of(&s, ids[140]);
        // One item deleted for good (as delete_forever + remove_objects do).
        crate::library::trash_items(&s.db(), &[ids[3]]).unwrap();
        let o = crate::library::delete_forever(&s.db(), &[ids[3]]).unwrap();
        crate::import::remove_objects(&s, &o);
        // Only the two pages (one per size) that held it went; no copy is left.
        assert_eq!(usage(&s.db()).0, 2);
        assert!(get(&s, &gone, Size::Big).is_none() && get(&s, &gone, Size::Small).is_none());
        assert!(get(&s, &kept, Size::Big).is_some(), "the other page stays");
        // The folder's pages are made again for what is still there.
        let re = refresh_folder(&s, Some(folder), Size::Big, Duration::ZERO).unwrap();
        assert!(re.pages >= 1, "{re:?}");
        assert!(get(&s, &thumb_of(&s, ids[4]), Size::Big).is_some());
        assert!(get(&s, &gone, Size::Big).is_none());
        assert_eq!(drop_pages_holding(&s, &[]), 0);
        assert_eq!(drop_pages_holding(&s, &[ObjectId::random()]), 0);
    }

    #[test]
    fn small_folders_get_no_pages() {
        let _one = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let t = tempfile::tempdir().unwrap();
        let (s, folder, _) = vault_with_folder(t.path(), MIN_FOLDER - 1, 200);
        assert_eq!(refresh_folder(&s, Some(folder), Size::Big, Duration::ZERO).unwrap(), Made::default());
        assert_eq!(usage(&s.db()).0, 0);
    }

    #[test]
    fn pages_round_trip_and_damage_is_refused() {
        let a = ObjectId::random();
        let b = ObjectId::random();
        let page = build_page(Size::Small, &[(a, b"first picture"), (b, b"second")]);
        let p = Page::parse(page.clone()).unwrap();
        assert_eq!(page[5], Size::Small as u8);
        assert_eq!(p.len(), 2);
        assert_eq!(p.get(&a), Some(&b"first picture"[..]));
        assert_eq!(p.get(&b), Some(&b"second"[..]));
        assert_eq!(p.get(&ObjectId::random()), None);
        // Cut short, wrong magic, an entry pointing past the end: refused.
        assert!(Page::parse(Zeroizing::new(page[..page.len() - 1].to_vec())).is_err());
        let mut m = page.to_vec();
        m[0] = b'X';
        assert!(Page::parse(Zeroizing::new(m)).is_err());
        let mut m = page.to_vec();
        m[HEAD + 20] = 200;
        assert!(Page::parse(Zeroizing::new(m)).is_err());
        let mut m = page.to_vec();
        m[8] = 255;
        assert!(Page::parse(Zeroizing::new(m)).is_err());
        assert_eq!(Page::parse(build_page(Size::Big, &[])).unwrap().len(), 0);
    }
}
