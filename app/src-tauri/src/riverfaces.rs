//! The faces river: every known face (a face named as a person) to float past
//! as a round bubble. Only the boxes are sent; the window cuts each face out
//! of the picture's thumbnail on screen, so no crop is ever stored.
//!
//! Left out: faces marked "not important", items in the trash, people whose
//! folder is in the trash, and faces in videos (a video's thumbnail is one
//! moment of it, rarely the moment the face was found in).

use rusqlite::Connection;
use serde::Serialize;

use crate::library::R;

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiverFace {
    pub id: i64,
    pub media: i64,
    pub person: i64,
    /// The face's box, as parts of the picture's size (0..1).
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub frame_ms: i64,
    /// How tall the face is in the original picture (pixels), when the picture's size is known.
    pub px: Option<f64>,
    /// The picture's shape (width / height), when known.
    pub aspect: Option<f64>,
}

/// Faces of these people (all named people when the list is empty).
pub fn list(conn: &Connection, people: &[i64]) -> R<Vec<RiverFace>> {
    let mut sql = String::from(
        "SELECT f.id, f.media_id, f.person_id, f.x, f.y, f.w, f.h, f.frame_ms, m.width, m.height FROM faces f \
         JOIN media m ON m.id = f.media_id AND m.deleted_at IS NULL AND m.kind IN ('image', 'gif') \
         JOIN folders p ON p.id = f.person_id AND p.deleted_at IS NULL \
         WHERE f.person_id IS NOT NULL AND f.hidden = 0 AND f.w > 0 AND f.h > 0",
    );
    // Only whole numbers go into the text, so this is safe to build.
    if !people.is_empty() {
        let ids: Vec<String> = people.iter().map(|p| p.to_string()).collect();
        sql.push_str(&format!(" AND f.person_id IN ({})", ids.join(",")));
    }
    sql.push_str(" ORDER BY f.id");
    let mut st = conn.prepare(&sql).map_err(e)?;
    let rows = st
        .query_map([], |r| {
            let w: Option<i64> = r.get(8)?;
            let h: Option<i64> = r.get(9)?;
            let bh: f64 = r.get(6)?;
            let known = |v: Option<i64>| v.filter(|&v| v > 0);
            Ok(RiverFace {
                id: r.get(0)?,
                media: r.get(1)?,
                person: r.get(2)?,
                x: r.get(3)?,
                y: r.get(4)?,
                w: r.get(5)?,
                h: bh,
                frame_ms: r.get(7)?,
                px: known(h).map(|h| (h as f64 * bh).round()),
                aspect: known(w).zip(known(h)).map(|(w, h)| w as f64 / h as f64),
            })
        })
        .map_err(e)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{create_folder, trash_items};
    use rusqlite::params;
    use vault_core::db;

    fn add(conn: &Connection, kind: &str, h: Option<i64>) -> i64 {
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, width, height) \
             VALUES (lower(hex(randomblob(16))), NULL, ?1, 'x', 'jpg', 10, 'h', 0, 1600, ?2)",
            params![kind, h],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn face(conn: &Connection, media: i64, person: Option<i64>, hidden: bool) -> i64 {
        conn.execute(
            "INSERT INTO faces(media_id, frame_ms, x, y, w, h, score, descriptor, person_id, hidden) VALUES (?1, 0, 0.1, 0.2, 0.1, 0.25, 0.9, x'00', ?2, ?3)",
            params![media, person, hidden as i64],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn known_faces_only() {
        let c = db::create_empty().unwrap();
        let ann = create_folder(&c, None, "Ann").unwrap();
        let bob = create_folder(&c, None, "Bob").unwrap();
        let pic = add(&c, "image", Some(800));
        let no_size = add(&c, "image", None);
        let vid = add(&c, "video", Some(800));
        let gone = add(&c, "image", Some(800));
        let a1 = face(&c, pic, Some(ann), false);
        let b1 = face(&c, pic, Some(bob), false);
        let a2 = face(&c, no_size, Some(ann), false);
        face(&c, pic, None, false); // nobody yet
        face(&c, pic, Some(ann), true); // not important
        face(&c, vid, Some(ann), false); // in a video
        face(&c, gone, Some(ann), false);
        trash_items(&c, &[gone]).unwrap();

        let all = list(&c, &[]).unwrap();
        assert_eq!(all.iter().map(|f| f.id).collect::<Vec<_>>(), vec![a1, b1, a2]);
        let f = &all[0];
        assert_eq!((f.media, f.person, f.px), (pic, ann, Some(200.0)));
        assert!((f.aspect.unwrap() - 2.0).abs() < 1e-9);
        // The picture's size unknown: no pixel height.
        assert_eq!(all[2].px, None);
        assert_eq!(list(&c, &[bob]).unwrap().iter().map(|f| f.id).collect::<Vec<_>>(), vec![b1]);
        assert_eq!(list(&c, &[ann, bob]).unwrap().len(), 3);
    }
}
