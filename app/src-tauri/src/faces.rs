//! Face recognition, the library side. The window finds faces and makes a
//! 128-number "fingerprint" for each (fully offline); this module stores
//! them (inside the encrypted library), learns each person from their person
//! folder, and suggests which other pictures show them. Nothing is ever
//! moved without the user confirming.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::library::{self, Item, R};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

pub const DIM: usize = 128;
/// Below this distance two faces are very likely the same person.
pub const SURE: f32 = 0.45;
/// Up to this distance a face is suggested (unticked) for a person.
pub const MAYBE: f32 = 0.55;
/// Faces closer than this are grouped as one unknown person.
pub const CLUSTER: f32 = 0.5;

fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

pub fn distance(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f32>().sqrt()
}

// ---- queue and storage -----------------------------------------------------------------

/// Which items to scan: these ids, a folder (with subfolders) or everything.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    #[serde(default)]
    pub ids: Vec<i64>,
    #[serde(default)]
    pub folder: Option<i64>,
    #[serde(default)]
    pub all: bool,
    /// Scan again items that were already scanned.
    #[serde(default)]
    pub again: bool,
}

fn scannable_ids(conn: &Connection, req: &ScanRequest) -> R<Vec<i64>> {
    let items = if req.all {
        library::query_items(conn, &Default::default())?
    } else if let Some(f) = req.folder {
        library::query_items(conn, &library::ItemFilter { folder: Some(Some(f)), recursive: true, ..Default::default() })?
    } else {
        let set: HashSet<i64> = req.ids.iter().copied().collect();
        library::query_items(conn, &Default::default())?.into_iter().filter(|i| set.contains(&i.id)).collect()
    };
    Ok(items.into_iter().filter(|i| matches!(i.kind.as_str(), "image" | "gif" | "video")).map(|i| i.id).collect())
}

/// Put items in the scan queue. Returns how many will be scanned.
pub fn queue(conn: &Connection, req: &ScanRequest) -> R<usize> {
    let ids = scannable_ids(conn, req)?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    let mut n = 0;
    for id in ids {
        let sql = if req.again {
            "UPDATE media SET faces_state = 2 WHERE id = ?"
        } else {
            "UPDATE media SET faces_state = 2 WHERE id = ? AND faces_state IN (0, 2)"
        };
        n += tx.execute(sql, [id]).map_err(e)?;
    }
    tx.commit().map_err(e)?;
    Ok(n)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanTask {
    pub id: i64,
    pub kind: String,
    pub duration_ms: Option<i64>,
}

pub fn needed(conn: &Connection, limit: i64) -> R<Vec<ScanTask>> {
    conn.prepare("SELECT id, kind, duration_ms FROM media WHERE faces_state = 2 AND deleted_at IS NULL ORDER BY id LIMIT ?")
        .map_err(e)?
        .query_map([limit], |r| Ok(ScanTask { id: r.get(0)?, kind: r.get(1)?, duration_ms: r.get(2)? }))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub queued: i64,
    pub scanned: i64,
    pub faces: i64,
    pub failed: i64,
}

pub fn status(conn: &Connection) -> R<ScanStatus> {
    let one = |sql: &str| -> R<i64> { conn.query_row(sql, [], |r| r.get(0)).map_err(e) };
    Ok(ScanStatus {
        queued: one("SELECT COUNT(*) FROM media WHERE faces_state = 2 AND deleted_at IS NULL")?,
        scanned: one("SELECT COUNT(*) FROM media WHERE faces_state = 1 AND deleted_at IS NULL")?,
        faces: one("SELECT COUNT(*) FROM faces f JOIN media m ON m.id = f.media_id WHERE m.deleted_at IS NULL")?,
        failed: one("SELECT COUNT(*) FROM media WHERE faces_state = -1 AND deleted_at IS NULL")?,
    })
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FaceIn {
    #[serde(default)]
    pub frame_ms: i64,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
    pub descriptor: Vec<f32>,
}

/// Store what was found in one item (replacing an earlier scan, but keeping
/// who was confirmed where the same face is found again).
pub fn save(conn: &Connection, media: i64, faces: &[FaceIn]) -> R<usize> {
    let old: Vec<(Vec<f32>, Option<i64>)> = conn
        .prepare("SELECT descriptor, person_id FROM faces WHERE media_id = ? AND person_id IS NOT NULL")
        .map_err(e)?
        .query_map([media], |r| Ok((from_blob(&r.get::<_, Vec<u8>>(0)?), r.get(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let tx = conn.unchecked_transaction().map_err(e)?;
    tx.execute("DELETE FROM faces WHERE media_id = ?", [media]).map_err(e)?;
    let mut n = 0;
    for f in faces.iter().filter(|f| f.descriptor.len() == DIM && f.descriptor.iter().all(|v| v.is_finite())) {
        let keep = old.iter().find(|(d, _)| distance(d, &f.descriptor) < 0.2).and_then(|(_, p)| *p);
        tx.execute(
            "INSERT INTO faces(media_id, frame_ms, x, y, w, h, score, descriptor, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![media, f.frame_ms, f.x.clamp(0.0, 1.0), f.y.clamp(0.0, 1.0), f.w.clamp(0.0, 1.0), f.h.clamp(0.0, 1.0), f.score, to_blob(&f.descriptor), keep],
        )
        .map_err(e)?;
        n += 1;
    }
    tx.execute("UPDATE media SET faces_state = 1 WHERE id = ?", [media]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(n)
}

pub fn failed(conn: &Connection, media: i64) -> R<()> {
    conn.execute("UPDATE media SET faces_state = -1 WHERE id = ?", [media]).map_err(e)?;
    Ok(())
}

pub fn set_person(conn: &Connection, folder: i64, on: bool) -> R<()> {
    conn.execute("UPDATE folders SET person = ? WHERE id = ?", params![on as i64, folder]).map_err(e)?;
    Ok(())
}

// ---- learning and suggestions -----------------------------------------------------------

struct FaceRow {
    id: i64,
    media: i64,
    folder: Option<i64>,
    person: Option<i64>,
    desc: Vec<f32>,
}

fn all_faces(conn: &Connection) -> R<Vec<FaceRow>> {
    conn.prepare(
        "SELECT f.id, f.media_id, m.folder_id, f.person_id, f.descriptor FROM faces f JOIN media m ON m.id = f.media_id \
         WHERE m.deleted_at IS NULL ORDER BY f.id",
    )
    .map_err(e)?
    .query_map([], |r| {
        Ok(FaceRow { id: r.get(0)?, media: r.get(1)?, folder: r.get(2)?, person: r.get(3)?, desc: from_blob(&r.get::<_, Vec<u8>>(4)?) })
    })
    .map_err(e)?
    .collect::<rusqlite::Result<_>>()
    .map_err(e)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub folder: i64,
    pub name: String,
    /// Faces it has learned from.
    pub known: usize,
    /// Photos in the folder with several faces where nobody said which one is them.
    pub unsure: usize,
}

/// Each person folder and the faces that define it: confirmed faces, plus
/// the only face in photos inside that folder (or its subfolders).
fn people(conn: &Connection, faces: &[FaceRow]) -> R<Vec<(Person, Vec<usize>)>> {
    let folders = library::all_folders(conn)?;
    let person_ids: Vec<i64> = conn
        .prepare("SELECT id FROM folders WHERE person = 1 AND deleted_at IS NULL")
        .map_err(e)?
        .query_map([], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let rejects: HashSet<(i64, i64)> = conn
        .prepare("SELECT face_id, folder_id FROM face_rejects")
        .map_err(e)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let mut per_media: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, f) in faces.iter().enumerate() {
        per_media.entry(f.media).or_default().push(i);
    }
    let mut out = Vec::new();
    for pid in person_ids {
        let Some(card) = folders.iter().find(|f| f.id == pid) else { continue };
        let inside: HashSet<i64> = folders
            .iter()
            .filter(|f| f.id == pid || f.path.iter().any(|c| c.id == pid))
            .map(|f| f.id)
            .collect();
        let mut refs: Vec<usize> = Vec::new();
        let mut unsure = 0;
        let mut seen_media: HashSet<i64> = HashSet::new();
        for (i, f) in faces.iter().enumerate() {
            if f.person == Some(pid) {
                refs.push(i);
                seen_media.insert(f.media);
            }
        }
        for (i, f) in faces.iter().enumerate() {
            if !f.folder.is_some_and(|x| inside.contains(&x)) || seen_media.contains(&f.media) {
                continue;
            }
            let here = &per_media[&f.media];
            let open: Vec<&usize> = here.iter().filter(|j| faces[**j].person.is_none() && !rejects.contains(&(faces[**j].id, pid))).collect();
            if here.len() == 1 && open.len() == 1 {
                refs.push(i);
            } else if here.len() > 1 && here[0] == i && !here.iter().any(|j| faces[*j].person == Some(pid)) {
                unsure += 1;
            }
        }
        out.push((Person { folder: pid, name: card.name.clone(), known: refs.len(), unsure }, refs));
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub face_id: i64,
    pub item: Item,
    pub frame_ms: i64,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// 0–100, higher = more alike.
    pub confidence: u32,
    /// Ticked by default (very likely the same person).
    pub sure: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonGroup {
    pub person: Person,
    pub suggestions: Vec<Suggestion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownGroup {
    /// Faces in this group (their ids), for "create person".
    pub face_ids: Vec<i64>,
    pub samples: Vec<Suggestion>,
    pub photos: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub people: Vec<PersonGroup>,
    pub unknown: Vec<UnknownGroup>,
    pub status: ScanStatus,
}

fn confidence(d: f32) -> u32 {
    ((1.0 - (d / 0.8)).clamp(0.0, 1.0) * 100.0).round() as u32
}

/// Everything the review screen shows.
pub fn review(conn: &Connection) -> R<Review> {
    let faces = all_faces(conn)?;
    let people = people(conn, &faces)?;
    let rejects: HashSet<(i64, i64)> = conn
        .prepare("SELECT face_id, folder_id FROM face_rejects")
        .map_err(e)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let folders = library::all_folders(conn)?;
    let inside = |pid: i64, folder: Option<i64>| {
        folder.is_some_and(|fid| fid == pid || folders.iter().any(|f| f.id == fid && f.path.iter().any(|c| c.id == pid)))
    };
    let used: HashSet<usize> = people.iter().flat_map(|(_, r)| r.iter().copied()).collect();
    let mut per_person: HashMap<i64, Vec<(usize, f32)>> = HashMap::new();
    let mut leftovers: Vec<usize> = Vec::new();
    for (i, f) in faces.iter().enumerate() {
        if f.person.is_some() || used.contains(&i) {
            continue;
        }
        let mut best: Option<(i64, f32)> = None;
        for (p, refs) in &people {
            if refs.is_empty() || rejects.contains(&(f.id, p.folder)) || inside(p.folder, f.folder) {
                continue;
            }
            let d = refs.iter().map(|r| distance(&faces[*r].desc, &f.desc)).fold(f32::MAX, f32::min);
            if best.is_none_or(|(_, bd)| d < bd) {
                best = Some((p.folder, d));
            }
        }
        match best {
            Some((pid, d)) if d < MAYBE => per_person.entry(pid).or_default().push((i, d)),
            _ => leftovers.push(i),
        }
    }
    let item_cache: HashMap<i64, Item> = {
        let ids: HashSet<i64> = faces.iter().map(|f| f.media).collect();
        library::query_items(conn, &Default::default())?.into_iter().filter(|i| ids.contains(&i.id)).map(|i| (i.id, i)).collect()
    };
    let suggestion = |i: usize, d: f32| -> R<Option<Suggestion>> {
        let f = &faces[i];
        let (frame_ms, x, y, w, h): (i64, f32, f32, f32, f32) = conn
            .query_row("SELECT frame_ms, x, y, w, h FROM faces WHERE id = ?", [f.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .map_err(e)?;
        Ok(item_cache.get(&f.media).map(|item| Suggestion {
            face_id: f.id,
            item: item.clone(),
            frame_ms,
            x,
            y,
            w,
            h,
            confidence: confidence(d),
            sure: d < SURE,
        }))
    };
    let mut groups = Vec::new();
    for (p, _) in people {
        let mut list = per_person.remove(&p.folder).unwrap_or_default();
        list.sort_by(|a, b| a.1.total_cmp(&b.1));
        // One suggestion per photo (its most alike face).
        let mut seen = HashSet::new();
        let mut sug = Vec::new();
        for (i, d) in list {
            if seen.insert(faces[i].media)
                && let Some(s) = suggestion(i, d)?
            {
                sug.push(s);
            }
        }
        groups.push(PersonGroup { person: p, suggestions: sug });
    }

    // Unknown people: group faces that are close to each other.
    let mut clusters: Vec<(Vec<f32>, Vec<usize>)> = Vec::new();
    for i in leftovers {
        let d = &faces[i].desc;
        match clusters.iter_mut().map(|c| (distance(&c.0, d), c)).filter(|(dist, _)| *dist < CLUSTER).min_by(|a, b| a.0.total_cmp(&b.0)) {
            Some((_, c)) => {
                let n = c.1.len() as f32;
                for (k, v) in c.0.iter_mut().enumerate() {
                    *v = (*v * n + d[k]) / (n + 1.0);
                }
                c.1.push(i);
            }
            None => clusters.push((d.clone(), vec![i])),
        }
    }
    let mut unknown = Vec::new();
    for (center, members) in clusters {
        let photos: HashSet<i64> = members.iter().map(|i| faces[*i].media).collect();
        if photos.len() < 3 {
            continue;
        }
        let mut ranked: Vec<(usize, f32)> = members.iter().map(|i| (*i, distance(&center, &faces[*i].desc))).collect();
        ranked.sort_by(|a, b| a.1.total_cmp(&b.1));
        let mut samples = Vec::new();
        let mut seen = HashSet::new();
        for (i, d) in ranked.iter().take(24) {
            if seen.insert(faces[*i].media)
                && let Some(s) = suggestion(*i, *d)?
            {
                samples.push(s);
            }
        }
        unknown.push(UnknownGroup { face_ids: members.iter().map(|i| faces[*i].id).collect(), samples, photos: photos.len() });
    }
    unknown.sort_by_key(|g| std::cmp::Reverse(g.photos));
    unknown.truncate(20);
    Ok(Review { people: groups, unknown, status: status(conn)? })
}

// ---- decisions --------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accepted {
    pub moved: usize,
    pub tagged: usize,
}

fn in_person_folder(conn: &Connection, folder: Option<i64>) -> R<bool> {
    let mut cur = folder;
    let mut guard = 0;
    while let Some(f) = cur {
        let (person, parent): (i64, Option<i64>) =
            conn.query_row("SELECT person, parent_id FROM folders WHERE id = ?", [f], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        if person == 1 {
            return Ok(true);
        }
        cur = parent;
        guard += 1;
        if guard > 1000 {
            break;
        }
    }
    Ok(false)
}

/// These faces are this person: remember it, tag the photos with the
/// person's name, and move photos that aren't in anyone's folder yet into
/// the person's folder. (A photo of two people goes to the first one; the
/// other person is added as a tag.)
pub fn accept(conn: &Connection, face_ids: &[i64], person: i64) -> R<Accepted> {
    let name: String = conn
        .query_row("SELECT name FROM folders WHERE id = ? AND deleted_at IS NULL", [person], |r| r.get(0))
        .optional()
        .map_err(e)?
        .ok_or("That person's folder no longer exists.")?;
    let mut out = Accepted::default();
    let mut media: Vec<(i64, Option<i64>)> = Vec::new();
    for fid in face_ids {
        conn.execute("UPDATE faces SET person_id = ? WHERE id = ?", [person, *fid]).map_err(e)?;
        if let Some(m) = conn
            .query_row("SELECT m.id, m.folder_id FROM faces f JOIN media m ON m.id = f.media_id WHERE f.id = ?", [fid], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(e)?
            && !media.iter().any(|x: &(i64, Option<i64>)| x.0 == m.0)
        {
            media.push(m);
        }
    }
    let ids: Vec<i64> = media.iter().map(|m| m.0).collect();
    out.tagged = library::tag_items(conn, &ids, &[name])?.first().map(|t| t.1.len()).unwrap_or(0);
    let mut to_move = Vec::new();
    for (id, folder) in media {
        if !in_person_folder(conn, folder)? {
            to_move.push(id);
        }
    }
    out.moved = library::move_items(conn, &to_move, Some(person))?;
    Ok(out)
}

/// "Not this person": never suggest these faces for this person again.
pub fn reject(conn: &Connection, face_ids: &[i64], person: i64) -> R<()> {
    for fid in face_ids {
        conn.execute("INSERT OR IGNORE INTO face_rejects(face_id, folder_id) VALUES (?, ?)", [*fid, person]).map_err(e)?;
        conn.execute("UPDATE faces SET person_id = NULL WHERE id = ? AND person_id = ?", [*fid, person]).map_err(e)?;
    }
    Ok(())
}

/// A new person from a group of unknown faces: make the folder, then accept.
pub fn new_person(conn: &Connection, name: &str, parent: Option<i64>, face_ids: &[i64]) -> R<(i64, Accepted)> {
    let id = library::create_folder(conn, parent, name)?;
    set_person(conn, id, true)?;
    let a = accept(conn, face_ids, id)?;
    Ok((id, a))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceBox {
    pub id: i64,
    pub frame_ms: i64,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub person: Option<i64>,
}

/// Faces found in one item (for "which one is them?").
pub fn faces_of(conn: &Connection, media: i64) -> R<Vec<FaceBox>> {
    conn.prepare("SELECT id, frame_ms, x, y, w, h, person_id FROM faces WHERE media_id = ? ORDER BY x")
        .map_err(e)?
        .query_map([media], |r| Ok(FaceBox { id: r.get(0)?, frame_ms: r.get(1)?, x: r.get(2)?, y: r.get(3)?, w: r.get(4)?, h: r.get(5)?, person: r.get(6)? }))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)
}

/// Photos in a person's folder with several faces and no answer yet.
pub fn unsure_items(conn: &Connection, person: i64) -> R<Vec<Item>> {
    let folder_items = library::query_items(conn, &library::ItemFilter { folder: Some(Some(person)), recursive: true, ..Default::default() })?;
    let mut out = Vec::new();
    for it in folder_items {
        let faces = faces_of(conn, it.id)?;
        if faces.len() > 1 && !faces.iter().any(|f| f.person == Some(person)) {
            out.push(it);
        }
    }
    Ok(out)
}

#[cfg(test)]
pub fn person_folders(conn: &Connection) -> R<Vec<i64>> {
    conn.prepare("SELECT id FROM folders WHERE person = 1 AND deleted_at IS NULL")
        .map_err(e)?
        .query_map([], |r| r.get(0))
        .map_err(e)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::db;

    fn add(conn: &Connection, folder: Option<i64>) -> i64 {
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (lower(hex(randomblob(16))), ?1, 'image', 'p.jpg', 'jpg', 1, 'h', 0, 't')",
            params![folder],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// A face "fingerprint" near a person's base point.
    fn face(base: f32, wobble: f32) -> FaceIn {
        let mut d = vec![0.0f32; DIM];
        d[0] = base;
        d[1] = wobble;
        FaceIn { frame_ms: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.9, descriptor: d }
    }

    #[test]
    fn learns_people_suggests_and_groups_strangers() {
        let c = db::create_empty().unwrap();
        let ayse = library::create_folder(&c, None, "Ayşe").unwrap();
        let mehmet = library::create_folder(&c, None, "Mehmet").unwrap();
        set_person(&c, ayse, true).unwrap();
        set_person(&c, mehmet, true).unwrap();
        // Known photos: one face each, inside the person folders.
        for w in [0.0, 0.05] {
            let m = add(&c, Some(ayse));
            save(&c, m, &[face(0.0, w)]).unwrap();
            let m = add(&c, Some(mehmet));
            save(&c, m, &[face(1.0, w)]).unwrap();
        }
        // New photos at the top level.
        let a1 = add(&c, None);
        save(&c, a1, &[face(0.02, 0.1)]).unwrap();
        let m1 = add(&c, None);
        save(&c, m1, &[face(0.98, 0.55)]).unwrap(); // a little less alike
        let both = add(&c, None);
        save(&c, both, &[face(0.0, 0.0), face(1.0, 0.0)]).unwrap();
        // Three photos of a stranger.
        for w in [0.0, 0.1, 0.2] {
            let s = add(&c, None);
            save(&c, s, &[face(3.0, w)]).unwrap();
        }

        let r = review(&c).unwrap();
        let ga = r.people.iter().find(|g| g.person.folder == ayse).unwrap();
        let gm = r.people.iter().find(|g| g.person.folder == mehmet).unwrap();
        assert_eq!(ga.person.known, 2);
        assert_eq!(ga.suggestions.iter().map(|s| s.item.id).collect::<HashSet<_>>(), HashSet::from([a1, both]));
        assert!(ga.suggestions.iter().all(|s| s.sure));
        assert_eq!(gm.suggestions.iter().map(|s| s.item.id).collect::<HashSet<_>>(), HashSet::from([m1, both]));
        assert!(gm.suggestions.iter().any(|s| s.item.id == m1 && !s.sure), "less alike = suggested but not ticked");
        assert_eq!(r.unknown.len(), 1);
        assert_eq!(r.unknown[0].photos, 3);

        // Accept for Ayşe: moved + tagged. The shared photo then only gets Mehmet's tag.
        let fa: Vec<i64> = ga.suggestions.iter().map(|s| s.face_id).collect();
        let a = accept(&c, &fa, ayse).unwrap();
        assert_eq!(a.moved, 2);
        assert_eq!(library::get_item(&c, both).unwrap().folder_id, Some(ayse));
        let fm: Vec<i64> = review(&c).unwrap().people.iter().find(|g| g.person.folder == mehmet).unwrap().suggestions.iter().map(|s| s.face_id).collect();
        let m = accept(&c, &fm, mehmet).unwrap();
        assert_eq!(m.moved, 1, "the shared photo stays in Ayşe's folder");
        assert_eq!(library::item_tags(&c, both).unwrap().own, vec!["Ayşe", "Mehmet"]);

        // "Not this person" sticks, even after scanning again.
        let s = add(&c, None);
        save(&c, s, &[face(0.03, 0.0)]).unwrap();
        let f = review(&c).unwrap().people.iter().find(|g| g.person.folder == ayse).unwrap().suggestions[0].face_id;
        reject(&c, &[f], ayse).unwrap();
        assert!(review(&c).unwrap().people.iter().find(|g| g.person.folder == ayse).unwrap().suggestions.is_empty());

        // The stranger becomes a person.
        let ids = review(&c).unwrap().unknown[0].face_ids.clone();
        let (pid, acc) = new_person(&c, "Zeynep", None, &ids).unwrap();
        assert_eq!(acc.moved, 3);
        assert!(person_folders(&c).unwrap().contains(&pid));
    }

    #[test]
    fn queue_and_rescan_keep_answers() {
        let c = db::create_empty().unwrap();
        let p = library::create_folder(&c, None, "P").unwrap();
        set_person(&c, p, true).unwrap();
        let m = add(&c, None);
        assert_eq!(queue(&c, &ScanRequest { ids: vec![m], folder: None, all: false, again: false }).unwrap(), 1);
        assert_eq!(needed(&c, 10).unwrap().len(), 1);
        save(&c, m, &[face(0.0, 0.0), face(2.0, 0.0)]).unwrap();
        assert!(needed(&c, 10).unwrap().is_empty());
        let fid = faces_of(&c, m).unwrap()[0].id;
        accept(&c, &[fid], p).unwrap();
        // Scanning again keeps who it was.
        assert_eq!(queue(&c, &ScanRequest { ids: vec![m], folder: None, all: false, again: false }).unwrap(), 0);
        assert_eq!(queue(&c, &ScanRequest { ids: vec![], folder: None, all: true, again: true }).unwrap(), 1);
        save(&c, m, &[face(0.01, 0.0), face(2.0, 0.0)]).unwrap();
        assert_eq!(faces_of(&c, m).unwrap().iter().filter(|f| f.person == Some(p)).count(), 1);
        assert_eq!(status(&c).unwrap().faces, 2);
    }
}
