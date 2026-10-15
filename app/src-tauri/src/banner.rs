//! Folder banners: a wide picture at the top of a folder (one of the vault's
//! items, usually one from inside the folder) and where in it to look.
//! Stored only in the encrypted library (folders.banner_media_id / banner_y).
//! A banner whose item is in the trash or gone is simply not shown.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::library::R;

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Banner {
    pub folder: i64,
    pub media: i64,
    /// "image", "gif" or "video" (a video banner plays muted).
    pub kind: String,
    /// Where to look, top to bottom (0..1); 0.5 = the middle.
    pub y: f64,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

fn clamp_y(y: Option<f64>) -> f64 {
    match y {
        Some(v) if v.is_finite() => v.clamp(0.0, 1.0),
        _ => 0.5,
    }
}

/// The folder's banner, if it has one whose item is still there.
pub fn get(conn: &Connection, folder: i64) -> R<Option<Banner>> {
    conn.query_row(
        "SELECT m.id, m.kind, f.banner_y, m.width, m.height FROM folders f \
         JOIN media m ON m.id = f.banner_media_id AND m.deleted_at IS NULL \
         WHERE f.id = ? AND f.deleted_at IS NULL",
        [folder],
        |r| {
            Ok(Banner {
                folder,
                media: r.get(0)?,
                kind: r.get(1)?,
                y: clamp_y(r.get(2)?),
                width: r.get(3)?,
                height: r.get(4)?,
            })
        },
    )
    .optional()
    .map_err(e)
}

/// Set (or with `media` None, remove) a folder's banner.
pub fn set(conn: &Connection, folder: i64, media: Option<i64>, y: Option<f64>) -> R<()> {
    if let Some(m) = media {
        let kind: Option<String> = conn
            .query_row("SELECT kind FROM media WHERE id = ? AND deleted_at IS NULL", [m], |r| r.get(0))
            .optional()
            .map_err(e)?;
        match kind.as_deref() {
            None => return Err("That item isn't in the vault any more.".into()),
            Some("image" | "gif" | "video") => {}
            Some(_) => return Err("Only a picture, GIF or video can be a banner.".into()),
        }
    }
    let y = media.map(|_| clamp_y(y));
    let n = conn
        .execute("UPDATE folders SET banner_media_id = ?, banner_y = ? WHERE id = ?", params![media, y, folder])
        .map_err(e)?;
    if n == 0 {
        return Err("That folder isn't there any more.".into());
    }
    Ok(())
}

/// A copied folder gets the same banner; when the banner's item was copied
/// along with it (`copied` = original id, copy id), the copy's own one.
pub fn copy(conn: &Connection, from: i64, to: i64, copied: &[(i64, i64)]) -> R<()> {
    let row: Option<(Option<i64>, Option<f64>)> = conn
        .query_row("SELECT banner_media_id, banner_y FROM folders WHERE id = ?", [from], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(e)?;
    let Some((Some(media), y)) = row else { return Ok(()) };
    let media = copied.iter().find(|(o, _)| *o == media).map(|(_, c)| *c).unwrap_or(media);
    conn.execute("UPDATE folders SET banner_media_id = ?, banner_y = ? WHERE id = ?", params![media, y, to])
        .map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{create_folder, trash_items};
    use vault_core::db;

    fn add(conn: &Connection, folder: Option<i64>, kind: &str) -> i64 {
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, width, height) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, 'x', 'jpg', 10, 'h', 0, 1600, 900)",
            params![folder, kind],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn set_get_and_remove() {
        let c = db::create_empty().unwrap();
        let f = create_folder(&c, None, "Trips").unwrap();
        let pic = add(&c, Some(f), "image");
        assert_eq!(get(&c, f).unwrap(), None);
        set(&c, f, Some(pic), Some(0.3)).unwrap();
        let b = get(&c, f).unwrap().expect("a banner");
        assert_eq!((b.media, b.kind.as_str(), b.width, b.height), (pic, "image", Some(1600), Some(900)));
        assert!((b.y - 0.3).abs() < 1e-9);
        // Out of range positions are kept inside the picture.
        set(&c, f, Some(pic), Some(7.0)).unwrap();
        assert_eq!(get(&c, f).unwrap().unwrap().y, 1.0);
        set(&c, f, Some(pic), Some(f64::NAN)).unwrap();
        assert_eq!(get(&c, f).unwrap().unwrap().y, 0.5);
        set(&c, f, None, None).unwrap();
        assert_eq!(get(&c, f).unwrap(), None);
        assert!(set(&c, f, Some(9999), None).is_err());
        assert!(set(&c, 9999, Some(pic), None).is_err());
    }

    #[test]
    fn trashed_or_gone_items_are_ignored() {
        let c = db::create_empty().unwrap();
        let f = create_folder(&c, None, "People").unwrap();
        let a = add(&c, Some(f), "video");
        set(&c, f, Some(a), None).unwrap();
        assert_eq!(get(&c, f).unwrap().unwrap().kind, "video");
        trash_items(&c, &[a]).unwrap();
        assert_eq!(get(&c, f).unwrap(), None, "in the trash: not shown");
        assert!(set(&c, f, Some(a), None).is_err());
        c.execute("UPDATE media SET deleted_at = NULL WHERE id = ?", [a]).unwrap();
        assert!(get(&c, f).unwrap().is_some(), "restored: back again");
        c.execute("DELETE FROM media WHERE id = ?", [a]).unwrap();
        assert_eq!(get(&c, f).unwrap(), None);
        let left: Option<i64> = c.query_row("SELECT banner_media_id FROM folders WHERE id = ?", [f], |r| r.get(0)).unwrap();
        assert_eq!(left, None, "deleting the item for good clears the reference");
    }

    #[test]
    fn copies_follow_the_copied_item() {
        let c = db::create_empty().unwrap();
        let f = create_folder(&c, None, "A").unwrap();
        let g = create_folder(&c, None, "B").unwrap();
        let h = create_folder(&c, None, "C").unwrap();
        let pic = add(&c, Some(f), "image");
        let copy_of_pic = add(&c, Some(g), "image");
        set(&c, f, Some(pic), Some(0.2)).unwrap();
        copy(&c, f, g, &[(pic, copy_of_pic)]).unwrap();
        assert_eq!(get(&c, g).unwrap().unwrap().media, copy_of_pic);
        copy(&c, f, h, &[]).unwrap();
        let b = get(&c, h).unwrap().unwrap();
        assert_eq!(b.media, pic);
        assert!((b.y - 0.2).abs() < 1e-9);
        // No banner: nothing to copy.
        let empty = create_folder(&c, None, "D").unwrap();
        copy(&c, empty, h, &[]).unwrap();
        assert!(get(&c, h).unwrap().is_some());
    }
}
