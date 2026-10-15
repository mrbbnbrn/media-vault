//! The library database: an ordinary SQLite database that only ever exists
//! in memory, and is saved to disk as one encrypted object (meta.db.enc).

use std::collections::HashMap;

pub use rusqlite::Connection;
use rusqlite::{MAIN_DB, params_from_iter};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::pack::{IndexChange, Location};
use crate::stream::{ObjectId, ObjectKind};

pub const SCHEMA_VERSION: i64 = 12;

const SCHEMA_V1: &str = r#"
CREATE TABLE folders (
    id          INTEGER PRIMARY KEY,
    parent_id   INTEGER REFERENCES folders(id) ON DELETE RESTRICT,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    cover_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL  -- picture on the folder's card
);
CREATE UNIQUE INDEX folders_unique_name ON folders(IFNULL(parent_id, 0), name COLLATE NOCASE);

CREATE TABLE media (
    id               INTEGER PRIMARY KEY,
    object_id        TEXT NOT NULL UNIQUE,      -- media/<xx>/<object_id>.bin
    thumb_object_id  TEXT,                      -- thumbs/<xx>/<id>.bin
    folder_id        INTEGER REFERENCES folders(id) ON DELETE RESTRICT, -- NULL = top level
    kind             TEXT NOT NULL CHECK (kind IN ('image', 'gif', 'video')),
    original_name    TEXT NOT NULL,
    ext              TEXT NOT NULL,
    size             INTEGER NOT NULL,
    width            INTEGER,
    height           INTEGER,
    duration_ms      INTEGER,
    has_audio        INTEGER,
    sha256           TEXT NOT NULL,
    imported_at      INTEGER NOT NULL,
    favourite        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX media_folder ON media(folder_id);
CREATE INDEX media_sha256 ON media(sha256);
CREATE INDEX media_favourite ON media(favourite) WHERE favourite = 1;

CREATE TABLE tags (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE media_tags (
    media_id  INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (media_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX media_tags_tag ON media_tags(tag_id);

CREATE TABLE folder_tags (
    folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
    PRIMARY KEY (folder_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX folder_tags_tag ON folder_tags(tag_id);

CREATE TABLE presets (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    settings_json  TEXT NOT NULL
);

CREATE TABLE layouts (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    settings_json  TEXT NOT NULL
);

CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
"#;

fn configure(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(())
}

/// A fresh, empty in-memory library.
pub fn create_empty() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    conn.execute_batch(SCHEMA_V1)?;
    conn.pragma_update(None, "user_version", 1)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Turn the in-memory database into bytes for `Vault::save_db`.
pub fn serialize(conn: &Connection) -> Result<Zeroizing<Vec<u8>>> {
    let data = conn.serialize(MAIN_DB)?;
    Ok(Zeroizing::new(data.to_vec()))
}

/// Load bytes from `Vault::load_db` into an in-memory database.
pub fn deserialize(bytes: &[u8]) -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    conn.deserialize_read_exact(MAIN_DB, bytes, bytes.len(), false)?;
    configure(&conn)?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(Error::Corrupt(format!("database check failed: {check}")));
    }
    let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if v > SCHEMA_VERSION {
        return Err(Error::UnsupportedVersion(v as u32));
    }
    migrate(&conn)?;
    Ok(conn)
}

fn has_column(conn: &Connection, table: &str, col: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names.iter().any(|n| n == col))
}

/// Bring an older library up to the current schema. Each step only adds
/// things, so older data is never lost.
fn migrate(conn: &Connection) -> Result<()> {
    let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if v < 2 {
        // v2: folder cover pictures and per-file slideshow weights.
        if !has_column(conn, "folders", "cover_media_id")? {
            conn.execute_batch("ALTER TABLE folders ADD COLUMN cover_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL;")?;
        }
        if !has_column(conn, "media", "weight")? {
            conn.execute_batch(
                "ALTER TABLE media ADD COLUMN weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0);",
            )?;
        }
        conn.pragma_update(None, "user_version", 2)?;
    }
    if v < 3 {
        // v3: text and PDF files; the pack index (where each encrypted
        // object lives inside the pack files).
        // SQLite can't change a CHECK rule in place, so the media table is
        // rebuilt with the same rows (the standard SQLite procedure).
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        let r = conn.execute_batch(
            r#"
            BEGIN;
            CREATE TABLE media_v3 (
                id               INTEGER PRIMARY KEY,
                object_id        TEXT NOT NULL UNIQUE,
                thumb_object_id  TEXT,
                folder_id        INTEGER REFERENCES folders(id) ON DELETE RESTRICT,
                kind             TEXT NOT NULL CHECK (kind IN ('image', 'gif', 'video', 'text', 'pdf')),
                original_name    TEXT NOT NULL,
                ext              TEXT NOT NULL,
                size             INTEGER NOT NULL,
                width            INTEGER,
                height           INTEGER,
                duration_ms      INTEGER,
                has_audio        INTEGER,
                sha256           TEXT NOT NULL,
                imported_at      INTEGER NOT NULL,
                favourite        INTEGER NOT NULL DEFAULT 0,
                weight           REAL NOT NULL DEFAULT 1 CHECK (weight >= 0)
            );
            INSERT INTO media_v3 (id, object_id, thumb_object_id, folder_id, kind, original_name, ext, size,
                                  width, height, duration_ms, has_audio, sha256, imported_at, favourite, weight)
                SELECT id, object_id, thumb_object_id, folder_id, kind, original_name, ext, size,
                       width, height, duration_ms, has_audio, sha256, imported_at, favourite, weight FROM media;
            DROP TABLE media;
            ALTER TABLE media_v3 RENAME TO media;
            CREATE INDEX media_folder ON media(folder_id);
            CREATE INDEX media_sha256 ON media(sha256);
            CREATE INDEX media_favourite ON media(favourite) WHERE favourite = 1;
            CREATE TABLE IF NOT EXISTS objects (
                object_id  TEXT PRIMARY KEY,   -- 32 hex characters
                kind       INTEGER NOT NULL,   -- 1 = media, 2 = thumbnail
                pack       INTEGER NOT NULL,   -- packs/<media|thumbs>-<pack, 6 digits>.pack
                offset     INTEGER NOT NULL,   -- first byte of the object in that file
                length     INTEGER NOT NULL
            ) WITHOUT ROWID;
            PRAGMA user_version = 3;
            COMMIT;
            "#,
        );
        if let Err(e) = r {
            let _ = conn.execute_batch("ROLLBACK;");
            conn.execute_batch("PRAGMA foreign_keys = ON;")?;
            return Err(e.into());
        }
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let bad: i64 =
            conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })?;
        if bad != 0 {
            return Err(Error::Corrupt(format!(
                "{bad} broken references after upgrade"
            )));
        }
    }
    if v < 4 {
        // v4: trash (deleted_at), pinned folders, folder colour and emoji,
        // date taken, view counts, video bookmarks.
        let r = conn.execute_batch(
            r#"
            BEGIN;
            ALTER TABLE folders ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE folders ADD COLUMN color TEXT;
            ALTER TABLE folders ADD COLUMN emoji TEXT;
            ALTER TABLE folders ADD COLUMN deleted_at INTEGER;   -- ms; items deleted together share it
            ALTER TABLE media ADD COLUMN deleted_at INTEGER;     -- ms; NULL = not in the trash
            ALTER TABLE media ADD COLUMN taken_at INTEGER;       -- s; NULL = not looked at yet, 0 = unknown
            ALTER TABLE media ADD COLUMN file_mtime INTEGER;     -- s; the original file's modified time
            ALTER TABLE media ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE media ADD COLUMN last_viewed_at INTEGER;
            CREATE TABLE bookmarks (
                id           INTEGER PRIMARY KEY,
                media_id     INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                position_ms  INTEGER NOT NULL,
                note         TEXT NOT NULL DEFAULT '',
                created_at   INTEGER NOT NULL
            );
            CREATE INDEX bookmarks_media ON bookmarks(media_id);
            DROP INDEX IF EXISTS folders_unique_name;
            CREATE UNIQUE INDEX folders_unique_name ON folders(IFNULL(parent_id, 0), name COLLATE NOCASE)
                WHERE deleted_at IS NULL;
            CREATE INDEX media_deleted ON media(deleted_at) WHERE deleted_at IS NOT NULL;
            PRAGMA user_version = 4;
            COMMIT;
            "#,
        );
        if let Err(e) = r {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(e.into());
        }
    }
    if v < 5 {
        // v5: face recognition (person folders, faces found in each item)
        // and smart search (one picture fingerprint per item).
        let r = conn.execute_batch(
            r#"
            BEGIN;
            ALTER TABLE folders ADD COLUMN person INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE media ADD COLUMN faces_state INTEGER NOT NULL DEFAULT 0;  -- 0 not scanned, 2 queued, 1 done, -1 failed
            ALTER TABLE media ADD COLUMN clip_state INTEGER NOT NULL DEFAULT 0;   -- 0 not analysed, 1 done, -1 failed
            CREATE TABLE faces (
                id          INTEGER PRIMARY KEY,
                media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                frame_ms    INTEGER NOT NULL DEFAULT 0,   -- videos: where in the video
                x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,  -- 0..1 of the picture
                score       REAL NOT NULL,
                descriptor  BLOB NOT NULL,                -- 128 little-endian f32
                person_id   INTEGER REFERENCES folders(id) ON DELETE SET NULL
            );
            CREATE INDEX faces_media ON faces(media_id);
            CREATE INDEX faces_person ON faces(person_id);
            CREATE TABLE face_rejects (
                face_id    INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
                folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                PRIMARY KEY (face_id, folder_id)
            ) WITHOUT ROWID;
            CREATE TABLE clip (
                media_id  INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
                vec       BLOB NOT NULL                   -- 512 little-endian f32, unit length
            );
            PRAGMA user_version = 5;
            COMMIT;
            "#,
        );
        if let Err(e) = r {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(e.into());
        }
    }
    if v < 6 {
        // v6: a small preview clip per video (a strip of frames, stored with
        // the thumbnails). NULL = not made yet, '' = couldn't be made.
        let r = conn.execute_batch(
            r#"
            BEGIN;
            ALTER TABLE media ADD COLUMN preview_object_id TEXT;
            PRAGMA user_version = 6;
            COMMIT;
            "#,
        );
        if let Err(e) = r {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(e.into());
        }
    }
    if v < 7 {
        // v7: smart search also looks at several moments of each video
        // (from its preview clip); videos that have one are analysed again.
        let r = conn.execute_batch(
            r#"
            BEGIN;
            DELETE FROM clip WHERE media_id IN (SELECT id FROM media WHERE kind = 'video' AND IFNULL(preview_object_id, '') <> '');
            UPDATE media SET clip_state = 0 WHERE kind = 'video' AND IFNULL(preview_object_id, '') <> '';
            PRAGMA user_version = 7;
            COMMIT;
            "#,
        );
        if let Err(e) = r {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(e.into());
        }
    }
    if v < 8 {
        // v8: a picture fingerprint (64-bit perceptual hash) and a sharpness
        // score per item, made from its thumbnail, for finding look-alikes.
        // phash_state: 0 not made, 1 made, -1 couldn't be made.
        let r = conn.execute_batch(
            r#"
            BEGIN;
            ALTER TABLE media ADD COLUMN phash INTEGER;
            ALTER TABLE media ADD COLUMN sharpness REAL;
            ALTER TABLE media ADD COLUMN phash_state INTEGER NOT NULL DEFAULT 0;
            PRAGMA user_version = 8;
            COMMIT;
            "#,
        );
        if let Err(e) = r {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(e.into());
        }
    }
    if v < 9 {
        // v9 needs several items to be able to share one stored file, so the
        // media table is rebuilt without the "one item per file" rule (the
        // standard SQLite procedure; every row and column is kept).
        let sql: String = conn.query_row("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media'", [], |r| r.get(0))?;
        if sql.contains("UNIQUE") {
            let cols: Vec<String> = {
                let mut st = conn.prepare("PRAGMA table_info(media)")?;
                st.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let indexes: Vec<String> = {
                let mut st = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media' AND sql IS NOT NULL")?;
                st.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let new_sql = sql.replacen("UNIQUE", "", 1).replacen("media", "media_v9", 1);
            let list = cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
            conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
            let r = conn.execute_batch(&format!(
                "BEGIN; {new_sql}; INSERT INTO media_v9 ({list}) SELECT {list} FROM media; DROP TABLE media; \
                 ALTER TABLE media_v9 RENAME TO media; {} ; COMMIT;",
                indexes.join("; ")
            ));
            if let Err(e) = r {
                let _ = conn.execute_batch("ROLLBACK;");
                conn.execute_batch("PRAGMA foreign_keys = ON;")?;
                return Err(e.into());
            }
            conn.execute_batch("PRAGMA foreign_keys = ON;")?;
            let bad: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))?;
            if bad != 0 {
                return Err(Error::Corrupt(format!("{bad} broken references after upgrade")));
            }
        }
        // v9: free copies (several items sharing one stored file; copy_of =
        // the original's id), notes, tag colours, where a video was left off,
        // and the duel ranking. Each column only if it isn't there yet.
        let table_exists = |t: &str| -> Result<bool> {
            Ok(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", [t], |r| r.get::<_, i64>(0))? > 0)
        };
        let adds: [(&str, &str, &str); 7] = [
            ("media", "copy_of", "INTEGER"),
            ("media", "note", "TEXT"),
            ("media", "resume_ms", "INTEGER"),
            ("media", "elo", "REAL"),
            ("media", "duels", "INTEGER NOT NULL DEFAULT 0"),
            ("folders", "note", "TEXT"),
            ("tags", "color", "TEXT"),
        ];
        conn.execute_batch("BEGIN;")?;
        let r = (|| -> Result<()> {
            for (t, c, def) in adds {
                if table_exists(t)? && !has_column(conn, t, c)? {
                    conn.execute_batch(&format!("ALTER TABLE {t} ADD COLUMN {c} {def};"))?;
                }
            }
            conn.execute_batch("CREATE INDEX IF NOT EXISTS media_object ON media(object_id); PRAGMA user_version = 9;")?;
            Ok(())
        })();
        match r {
            Ok(()) => conn.execute_batch("COMMIT;")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }
    }
    if v < 10 {
        // v10: native face recognition (InsightFace). Which model found each
        // face and scanned each item (0 = built-in face-api, 1 = buffalo_l),
        // faces named automatically (and when), "not important" faces, and
        // pairs of people you said are not the same. Each part only if its
        // table is there and it isn't there yet.
        let table_exists = |t: &str| -> Result<bool> {
            Ok(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", [t], |r| r.get::<_, i64>(0))? > 0)
        };
        let adds: [(&str, &str, &str); 5] = [
            ("faces", "model", "INTEGER NOT NULL DEFAULT 0"),
            ("faces", "auto", "INTEGER NOT NULL DEFAULT 0"),
            ("faces", "named_at", "INTEGER"),
            ("faces", "hidden", "INTEGER NOT NULL DEFAULT 0"),
            ("media", "faces_model", "INTEGER NOT NULL DEFAULT 0"),
        ];
        conn.execute_batch("BEGIN;")?;
        let r = (|| -> Result<()> {
            for (t, c, def) in adds {
                if table_exists(t)? && !has_column(conn, t, c)? {
                    conn.execute_batch(&format!("ALTER TABLE {t} ADD COLUMN {c} {def};"))?;
                }
            }
            if table_exists("faces")? {
                conn.execute_batch("CREATE INDEX IF NOT EXISTS faces_model ON faces(model);")?;
            }
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS face_not_same (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID; \
                 PRAGMA user_version = 10;",
            )?;
            Ok(())
        })();
        match r {
            Ok(()) => conn.execute_batch("COMMIT;")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }
    }
    if v < 11 {
        // v11: a tiny colour sketch of each thumbnail (a few cells of colour,
        // drawn blurred while the thumbnail loads). NULL = not made yet.
        if !has_column(conn, "media", "sketch")? {
            conn.execute_batch("ALTER TABLE media ADD COLUMN sketch TEXT;")?;
        }
        conn.pragma_update(None, "user_version", 11)?;
    }
    if v < 12 || !has_column(conn, "media", "tiny_object_id")? {
        // v12: a tiny silent preview video per video (about 240p, a few
        // seconds, stored with the thumbnails) that grids play straight away.
        // NULL = not made yet, '' = couldn't be made. Only added if it isn't
        // there yet, so this step is safe to run again.
        conn.execute_batch("BEGIN;")?;
        let r = (|| -> Result<()> {
            if !has_column(conn, "media", "tiny_object_id")? {
                conn.execute_batch("ALTER TABLE media ADD COLUMN tiny_object_id TEXT;")?;
            }
            if v < 12 {
                conn.execute_batch("PRAGMA user_version = 12;")?;
            }
            Ok(())
        })();
        match r {
            Ok(()) => conn.execute_batch("COMMIT;")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }
    }
    Ok(())
}

/// The pack index stored in the database.
pub fn load_index(conn: &Connection) -> Result<Vec<(ObjectId, Location)>> {
    let mut st = conn.prepare("SELECT object_id, kind, pack, offset, length FROM objects")?;
    let rows = st.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, kind, pack, offset, len) = row?;
        let kind = match kind {
            1 => ObjectKind::Media,
            2 => ObjectKind::Thumbnail,
            _ => continue,
        };
        out.push((
            ObjectId::from_hex(&id)?,
            Location {
                kind,
                pack: pack as u32,
                offset: offset as u64,
                len: len as u64,
            },
        ));
    }
    Ok(out)
}

/// Write pack index changes into the database (done right before saving it).
pub fn apply_index_changes(conn: &Connection, changes: &[IndexChange]) -> Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for c in changes {
        match c {
            IndexChange::Put(id, l) => {
                tx.execute(
                    "INSERT OR REPLACE INTO objects(object_id, kind, pack, offset, length) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![id.to_hex(), l.kind as u8 as i64, l.pack as i64, l.offset as i64, l.len as i64],
                )?;
            }
            IndexChange::Remove(id) => {
                tx.execute("DELETE FROM objects WHERE object_id = ?", [id.to_hex()])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// Folder id -> list of folder names from the top down.
pub fn folder_paths(conn: &Connection) -> Result<HashMap<i64, Vec<String>>> {
    let mut stmt = conn.prepare("SELECT id, parent_id, name FROM folders")?;
    let rows: Vec<(i64, Option<i64>, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let by_id: HashMap<i64, (Option<i64>, String)> =
        rows.into_iter().map(|(i, p, n)| (i, (p, n))).collect();
    let mut out = HashMap::new();
    for &id in by_id.keys() {
        let mut path = Vec::new();
        let mut cur = Some(id);
        let mut guard = 0;
        while let Some(c) = cur {
            let (parent, name) = by_id
                .get(&c)
                .ok_or_else(|| Error::Corrupt(format!("folder {c} missing")))?;
            path.push(name.clone());
            cur = *parent;
            guard += 1;
            if guard > 10_000 {
                return Err(Error::Corrupt("folder tree contains a loop".into()));
            }
        }
        path.reverse();
        out.insert(id, path);
    }
    Ok(out)
}

/// Media ids that carry *all* of `tags`, counting tags put on the item itself
/// and tags inherited from any folder above it. Case-insensitive.
pub fn search_by_tags(conn: &Connection, tags: &[&str]) -> Result<Vec<i64>> {
    let mut tags: Vec<String> = tags
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    tags.sort();
    tags.dedup();
    if tags.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; tags.len()].join(",");
    let sql = format!(
        "WITH RECURSIVE
            wanted(id) AS (SELECT id FROM tags WHERE name IN ({placeholders})),
            folder_eff(folder_id, tag_id) AS (
                SELECT folder_id, tag_id FROM folder_tags WHERE tag_id IN wanted
                UNION
                SELECT f.id, fe.tag_id FROM folders f JOIN folder_eff fe ON f.parent_id = fe.folder_id
            ),
            media_eff(media_id, tag_id) AS (
                SELECT media_id, tag_id FROM media_tags WHERE tag_id IN wanted
                UNION
                SELECT m.id, fe.tag_id FROM media m JOIN folder_eff fe ON m.folder_id = fe.folder_id
            )
         SELECT media_id FROM media_eff
         GROUP BY media_id
         HAVING COUNT(DISTINCT tag_id) = (SELECT COUNT(*) FROM wanted) AND (SELECT COUNT(*) FROM wanted) = ?
         ORDER BY media_id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut args: Vec<rusqlite::types::Value> = tags.iter().map(|t| t.clone().into()).collect();
    args.push((tags.len() as i64).into());
    let ids = stmt
        .query_map(params_from_iter(args), |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_can_share_a_stored_file_after_upgrade() {
        let c = create_empty().unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        for name in ["a.jpg", "b.jpg"] {
            c.execute(
                "INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('same', 'image', ?, 'jpg', 1, 'h', 0)",
                [name],
            )
            .unwrap();
        }
        let n: i64 = c.query_row("SELECT COUNT(*) FROM media WHERE object_id = 'same'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        // Indexes came back, and the database round-trips.
        let idx: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media'", [], |r| r.get(0)).unwrap();
        assert!(idx >= 4, "{idx}");
        let bytes = serialize(&c).unwrap();
        let c2 = deserialize(&bytes).unwrap();
        let n2: i64 = c2.query_row("SELECT COUNT(*) FROM media", [], |r| r.get(0)).unwrap();
        assert_eq!(n2, 2);
    }

    #[test]
    fn v10_keeps_faces_and_adds_the_model() {
        let c = create_empty().unwrap();
        c.execute("INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('o', 'image', 'a', 'jpg', 1, 'h', 0)", []).unwrap();
        c.execute("INSERT INTO faces(media_id, x, y, w, h, score, descriptor) VALUES (1, 0, 0, 1, 1, 1, x'00')", []).unwrap();
        // Back to how a v9 library looked, then upgrade again.
        c.execute_batch(
            "DROP INDEX faces_model; ALTER TABLE faces DROP COLUMN model; ALTER TABLE faces DROP COLUMN auto; \
             ALTER TABLE faces DROP COLUMN named_at; ALTER TABLE faces DROP COLUMN hidden; ALTER TABLE media DROP COLUMN faces_model; \
             DROP TABLE face_not_same; PRAGMA user_version = 9;",
        )
        .unwrap();
        migrate(&c).unwrap();
        let (m, a, h, fm): (i64, i64, i64, i64) = c
            .query_row("SELECT f.model, f.auto, f.hidden, m.faces_model FROM faces f JOIN media m ON m.id = f.media_id", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap();
        assert_eq!((m, a, h, fm), (0, 0, 0, 0));
        c.execute("INSERT INTO face_not_same(a, b) VALUES (1, 2)", []).unwrap();
        // A library without the faces table still upgrades.
        c.execute_batch("DROP TABLE face_rejects; DROP TABLE faces; DROP TABLE face_not_same; PRAGMA user_version = 9;").unwrap();
        migrate(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }

    #[test]
    fn v11_adds_the_sketch_column() {
        let c = create_empty().unwrap();
        c.execute("INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('o', 'image', 'a', 'jpg', 1, 'h', 0)", []).unwrap();
        c.execute_batch("ALTER TABLE media DROP COLUMN sketch; PRAGMA user_version = 10;").unwrap();
        migrate(&c).unwrap();
        let s: Option<String> = c.query_row("SELECT sketch FROM media", [], |r| r.get(0)).unwrap();
        assert_eq!(s, None);
        // Running it again (column already there) is fine.
        c.execute_batch("PRAGMA user_version = 10;").unwrap();
        migrate(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert!(v >= 11);
    }

    #[test]
    fn v12_adds_tiny_clips_and_keeps_preview_strips() {
        let c = create_empty().unwrap();
        c.execute(
            "INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at, preview_object_id) \
             VALUES ('o', 'video', 'a', 'mp4', 1, 'h', 0, 'strip')",
            [],
        )
        .unwrap();
        c.execute_batch("ALTER TABLE media DROP COLUMN tiny_object_id; PRAGMA user_version = 11;").unwrap();
        migrate(&c).unwrap();
        let (p, t): (String, Option<String>) =
            c.query_row("SELECT preview_object_id, tiny_object_id FROM media", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((p.as_str(), t), ("strip", None));
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, 12);
        // Running it again (or with the column already there) changes nothing.
        migrate(&c).unwrap();
        c.execute_batch("PRAGMA user_version = 11;").unwrap();
        migrate(&c).unwrap();
    }
}
