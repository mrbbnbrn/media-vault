//! The library database: an ordinary SQLite database that only ever exists
//! in memory, and is saved to disk as one encrypted object (meta.db.enc).

use std::collections::HashMap;

pub use rusqlite::Connection;
use rusqlite::{MAIN_DB, params_from_iter};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::pack::{IndexChange, Location};
use crate::stream::{ObjectId, ObjectKind};

pub const SCHEMA_VERSION: i64 = 19;

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
    if v < 13 || !table_exists(conn, "folder_stats")? || !has_column(conn, "clip", "f16")? {
        // v13: speed. Item counts and sizes per folder kept up to date by
        // triggers (instead of counting on every folder load); smart-search
        // vectors stored as 16-bit floats (half the size, same results); the
        // face look-alike graph saved (face_graph) instead of worked out
        // again at every unlock. Every part only if it isn't there yet, so
        // this step is safe to run again.
        conn.execute_batch("BEGIN;")?;
        let r = (|| -> Result<()> {
            conn.execute_batch(FOLDER_STATS_SQL)?;
            rebuild_folder_stats(conn)?;
            if !has_column(conn, "clip", "f16")? {
                conn.execute_batch("ALTER TABLE clip ADD COLUMN f16 INTEGER NOT NULL DEFAULT 0;")?;
            }
            let old: Vec<(i64, Vec<u8>)> = conn
                .prepare("SELECT media_id, vec FROM clip WHERE f16 = 0")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let mut st = conn.prepare("UPDATE clip SET vec = ?2, f16 = 1 WHERE media_id = ?1")?;
            for (id, blob) in old {
                st.execute(rusqlite::params![id, crate::half::f32_blob_to_f16(&blob)])?;
            }
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS face_graph (model INTEGER PRIMARY KEY, data BLOB NOT NULL);",
            )?;
            if v < 13 {
                conn.execute_batch("PRAGMA user_version = 13;")?;
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
    if v < 14 || !has_table(conn, "thumb_bundles")? {
        // v14: thumbnail pages — a folder's thumbnails packed into a few
        // objects (stored like thumbnails) so a grid decrypts one per page.
        // Derived data: can be deleted at any time and is made again. Only
        // added if it isn't there yet, so this step is safe to run again.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS thumb_bundles (
                object_id TEXT PRIMARY KEY,
                folder_id INTEGER,
                size      INTEGER NOT NULL,
                items     INTEGER NOT NULL,
                bytes     INTEGER NOT NULL,
                members   BLOB NOT NULL,
                made_at   INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS thumb_bundles_folder ON thumb_bundles(folder_id, size);",
        )?;
        if v < 14 {
            conn.pragma_update(None, "user_version", 14)?;
        }
    }
    // ---- folder banners (begin) ----
    if v < 15 || !has_column(conn, "folders", "banner_media_id")? || !has_column(conn, "folders", "banner_y")? {
        // v15: a wide banner picture at the top of a folder (one of its items)
        // and where in it to look (0 = top, 1 = bottom). NULL = no banner.
        // Each column only if it isn't there yet, so this is safe to run again.
        conn.execute_batch("BEGIN;")?;
        let r = (|| -> Result<()> {
            if !has_column(conn, "folders", "banner_media_id")? {
                conn.execute_batch("ALTER TABLE folders ADD COLUMN banner_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL;")?;
            }
            if !has_column(conn, "folders", "banner_y")? {
                conn.execute_batch("ALTER TABLE folders ADD COLUMN banner_y REAL;")?;
            }
            if v < 15 {
                conn.execute_batch("PRAGMA user_version = 15;")?;
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
    // ---- folder banners (end) ----
    // ---- cover framing (begin) ----
    if v < 16 || !has_column(conn, "folders", "cover_x")? || !has_column(conn, "folders", "cover_y")? || !has_column(conn, "folders", "cover_zoom")? {
        // v16: which part of a folder's cover shows on its card, set by hand
        // in "Adjust cover…": the point of the picture to keep in view (x, y,
        // 0–1) and how far to zoom in (1 = the whole card filled, no more).
        // NULL = automatic (centred, or on the face for person folders).
        // Each column only if it isn't there yet, so this is safe to run again.
        conn.execute_batch("BEGIN;")?;
        let r = (|| -> Result<()> {
            for col in ["cover_x", "cover_y", "cover_zoom"] {
                if !has_column(conn, "folders", col)? {
                    conn.execute_batch(&format!("ALTER TABLE folders ADD COLUMN {col} REAL;"))?;
                }
            }
            if v < 16 {
                conn.execute_batch("PRAGMA user_version = 16;")?;
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
    // ---- cover framing (end) ----
    // ---- poor faces (begin) ----
    let faces_table = table_exists(conn, "faces")?;
    if v < 17 || (faces_table && (!has_column(conn, "faces", "px")? || !has_column(conn, "faces", "sharp")? || !has_column(conn, "faces", "turn")?)) {
        // v17: what's needed to tell a "poor face" (too small, too blurry or
        // turned too far away to be trusted): its height in the item's own
        // pixels, how sharp it is (variance of the Laplacian of a small grey
        // crop; -1 = couldn't be measured) and how far it is turned (degrees,
        // 0 = looking straight at the camera). NULL = not measured yet, which
        // counts as fine. Whether a face is poor is decided when asked, from
        // the settings, so nothing here changes names. Heights are filled in
        // straight away from the item's size; sharpness and turn are measured
        // in the background. Each column only if it isn't there yet, so this
        // is safe to run again (with or without v16 before it).
        conn.execute_batch("BEGIN;")?;
        let r = (|| -> Result<()> {
            if faces_table {
                for col in ["px", "sharp", "turn"] {
                    if !has_column(conn, "faces", col)? {
                        conn.execute_batch(&format!("ALTER TABLE faces ADD COLUMN {col} REAL;"))?;
                    }
                }
                conn.execute_batch(
                    "UPDATE faces SET px = h * (SELECT m.height FROM media m WHERE m.id = faces.media_id) \
                     WHERE px IS NULL AND (SELECT m.height FROM media m WHERE m.id = faces.media_id) > 0;",
                )?;
            }
            if v < 17 {
                conn.execute_batch("PRAGMA user_version = 17;")?;
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
    // ---- poor faces (end) ----
    // ---- saved depth maps and outlines (begin) ----
    if v < 18 || !has_table(conn, "derived")? {
        // v18: depth maps and subject outlines made for still pictures, kept so
        // they needn't be made again: one encrypted object (stored like a
        // thumbnail) per item, kind ('depth' or 'outline') and model. `source`
        // is the item's object_id when it was made (a rotated picture gets a
        // new file, so its old maps no longer count). Derived data: can all be
        // deleted at any time. Rows go with their item (and its objects are
        // removed with the item's other files). Only added if it isn't there
        // yet, so this step is safe to run again.
        conn.execute_batch(DERIVED_SQL)?;
        if v < 18 {
            conn.pragma_update(None, "user_version", 18)?;
        }
    }
    // ---- saved depth maps and outlines (end) ----
    // ---- nothing left behind (begin) ----
    let faces_both = has_table(conn, "faces")? && has_table(conn, "face_not_same")?;
    if v < 19 || (faces_both && !has_trigger(conn, "face_not_same_gone")?) {
        // v19: "these two faces aren't the same person" goes with either face
        // (a face's number can be used again by a new face, which must not
        // inherit it). Pairs left by faces already gone are removed. Safe to
        // run again.
        if faces_both {
            conn.execute_batch(NOT_SAME_SQL)?;
            conn.execute_batch(
                "DELETE FROM face_not_same WHERE a NOT IN (SELECT id FROM faces) OR b NOT IN (SELECT id FROM faces);",
            )?;
        }
        if v < 19 {
            conn.pragma_update(None, "user_version", 19)?;
        }
    }
    // ---- nothing left behind (end) ----
    Ok(())
}

const NOT_SAME_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS face_not_same_b ON face_not_same(b);
CREATE TRIGGER IF NOT EXISTS face_not_same_gone AFTER DELETE ON faces
BEGIN
    DELETE FROM face_not_same WHERE a = OLD.id OR b = OLD.id;
END;
"#;

fn has_trigger(conn: &Connection, t: &str) -> Result<bool> {
    Ok(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = ?", [t], |r| r.get::<_, i64>(0))? > 0)
}

const DERIVED_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS derived (
    media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('depth', 'outline')),
    model      TEXT NOT NULL,
    object_id  TEXT NOT NULL,      -- kind 2 object: width u32 LE, height u32 LE, one byte per pixel
    source     TEXT NOT NULL,      -- media.object_id it was made from
    bytes      INTEGER NOT NULL,
    made_at    INTEGER NOT NULL,   -- ms
    PRIMARY KEY (media_id, kind, model)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS derived_kind ON derived(kind);
CREATE INDEX IF NOT EXISTS derived_object ON derived(object_id);
"#;

fn table_exists(conn: &Connection, t: &str) -> Result<bool> {
    Ok(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", [t], |r| r.get::<_, i64>(0))? > 0)
}

/// Items (not in the trash) directly in each folder and their total size,
/// kept up to date by triggers on `media` for every insert, delete, move,
/// trash, restore and size change. (A future upgrade that rebuilds the media
/// table must create these triggers again: dropping a table drops them.)
const FOLDER_STATS_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS folder_stats (
    folder_id  INTEGER PRIMARY KEY,
    items      INTEGER NOT NULL,
    bytes      INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS folder_stats_add AFTER INSERT ON media
WHEN NEW.folder_id IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
    INSERT INTO folder_stats(folder_id, items, bytes) VALUES (NEW.folder_id, 1, NEW.size)
        ON CONFLICT(folder_id) DO UPDATE SET items = items + 1, bytes = bytes + excluded.bytes;
END;
CREATE TRIGGER IF NOT EXISTS folder_stats_remove AFTER DELETE ON media
WHEN OLD.folder_id IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
    UPDATE folder_stats SET items = items - 1, bytes = bytes - OLD.size WHERE folder_id = OLD.folder_id;
END;
CREATE TRIGGER IF NOT EXISTS folder_stats_change AFTER UPDATE OF folder_id, deleted_at, size ON media
WHEN OLD.folder_id IS NOT NEW.folder_id OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.size IS NOT NEW.size
BEGIN
    UPDATE folder_stats SET items = items - 1, bytes = bytes - OLD.size
        WHERE folder_id = OLD.folder_id AND OLD.deleted_at IS NULL;
    INSERT INTO folder_stats(folder_id, items, bytes)
        SELECT NEW.folder_id, 1, NEW.size WHERE NEW.folder_id IS NOT NULL AND NEW.deleted_at IS NULL
        ON CONFLICT(folder_id) DO UPDATE SET items = items + 1, bytes = bytes + excluded.bytes;
END;
CREATE TRIGGER IF NOT EXISTS folder_stats_gone AFTER DELETE ON folders
BEGIN
    DELETE FROM folder_stats WHERE folder_id = OLD.id;
END;
-- A folder's first few pictures (its cover and stacked cards), found without sorting.
CREATE INDEX IF NOT EXISTS media_samples ON media(folder_id, kind <> 'image', id)
    WHERE deleted_at IS NULL AND thumb_object_id IS NOT NULL AND thumb_object_id <> '';
"#;

const FOLDER_STATS_COUNT: &str = "SELECT folder_id, COUNT(*), IFNULL(SUM(size), 0) FROM media \
     WHERE folder_id IS NOT NULL AND deleted_at IS NULL GROUP BY folder_id";

/// Count every folder's items again (after an upgrade, or if a check found
/// the kept counts wrong).
pub fn rebuild_folder_stats(conn: &Connection) -> Result<()> {
    conn.execute_batch(&format!(
        "DELETE FROM folder_stats; INSERT INTO folder_stats(folder_id, items, bytes) {FOLDER_STATS_COUNT};"
    ))?;
    Ok(())
}

/// Compare the kept counts with a real count; rebuild them if they differ.
/// Returns true if they were right.
pub fn check_folder_stats(conn: &Connection) -> Result<bool> {
    let real: HashMap<i64, (i64, i64)> = conn
        .prepare(FOLDER_STATS_COUNT)?
        .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<rusqlite::Result<_>>()?;
    let kept: HashMap<i64, (i64, i64)> = conn
        .prepare("SELECT folder_id, items, bytes FROM folder_stats WHERE items <> 0 OR bytes <> 0")?
        .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
        .collect::<rusqlite::Result<_>>()?;
    if real == kept {
        return Ok(true);
    }
    rebuild_folder_stats(conn)?;
    Ok(false)
}

fn has_table(conn: &Connection, t: &str) -> Result<bool> {
    Ok(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", [t], |r| r.get::<_, i64>(0))? > 0)
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
        assert_eq!(v, SCHEMA_VERSION);
        // Running it again (or with the column already there) changes nothing.
        migrate(&c).unwrap();
        c.execute_batch("PRAGMA user_version = 11;").unwrap();
        migrate(&c).unwrap();
    }

    fn stats(c: &Connection) -> Vec<(i64, i64, i64)> {
        c.prepare("SELECT folder_id, items, bytes FROM folder_stats WHERE items <> 0 OR bytes <> 0 ORDER BY folder_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn v13_counts_folders_with_triggers_through_every_change() {
        let c = create_empty().unwrap();
        for (id, name) in [(1, "A"), (2, "B")] {
            c.execute("INSERT INTO folders(id, name, created_at) VALUES (?, ?, 0)", rusqlite::params![id, name]).unwrap();
        }
        let add = |folder: Option<i64>, size: i64| {
            c.execute(
                "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at) VALUES (lower(hex(randomblob(16))), ?, 'image', 'a', 'jpg', ?, 'h', 0)",
                rusqlite::params![folder, size],
            )
            .unwrap();
            c.last_insert_rowid()
        };
        let a1 = add(Some(1), 10);
        let a2 = add(Some(1), 5);
        let top = add(None, 7);
        assert_eq!(stats(&c), vec![(1, 2, 15)]);
        // Move, trash, restore, change size, delete, move to top level.
        c.execute("UPDATE media SET folder_id = 2 WHERE id = ?", [a2]).unwrap();
        assert_eq!(stats(&c), vec![(1, 1, 10), (2, 1, 5)]);
        c.execute("UPDATE media SET deleted_at = 1 WHERE id = ?", [a1]).unwrap();
        assert_eq!(stats(&c), vec![(2, 1, 5)]);
        c.execute("UPDATE media SET folder_id = 2 WHERE id = ?", [a1]).unwrap(); // moved while in the trash
        assert_eq!(stats(&c), vec![(2, 1, 5)]);
        c.execute("UPDATE media SET deleted_at = NULL WHERE id = ?", [a1]).unwrap();
        assert_eq!(stats(&c), vec![(2, 2, 15)]);
        c.execute("UPDATE media SET size = 100 WHERE id = ?", [a1]).unwrap();
        assert_eq!(stats(&c), vec![(2, 2, 105)]);
        c.execute("UPDATE media SET folder_id = 1, deleted_at = 5, size = 1 WHERE id = ?", [a2]).unwrap();
        assert_eq!(stats(&c), vec![(2, 1, 100)]);
        c.execute("DELETE FROM media WHERE id = ?", [a2]).unwrap();
        c.execute("UPDATE media SET folder_id = 1 WHERE id = ?", [top]).unwrap();
        assert_eq!(stats(&c), vec![(1, 1, 7), (2, 1, 100)]);
        c.execute("UPDATE media SET folder_id = NULL WHERE id = ?", [a1]).unwrap();
        c.execute("UPDATE media SET original_name = 'b', favourite = 1", []).unwrap(); // not counted
        assert_eq!(stats(&c), vec![(1, 1, 7)]);
        assert!(check_folder_stats(&c).unwrap());
        // Deleting a folder forever forgets its row; a wrong count is put right.
        c.execute("DELETE FROM media WHERE folder_id = 1", []).unwrap();
        c.execute("DELETE FROM folders WHERE id = 1", []).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM folder_stats WHERE folder_id = 1", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        add(Some(2), 3);
        c.execute("UPDATE folder_stats SET items = 9", []).unwrap();
        assert!(!check_folder_stats(&c).unwrap());
        assert_eq!(stats(&c), vec![(2, 1, 3)]);
        // Survives saving and loading.
        let c2 = deserialize(&serialize(&c).unwrap()).unwrap();
        c2.execute("INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('x', 2, 'image', 'a', 'jpg', 4, 'h', 0)", []).unwrap();
        assert_eq!(stats(&c2), vec![(2, 2, 7)]);
    }

    #[test]
    fn v13_upgrade_counts_and_halves_vectors() {
        let c = create_empty().unwrap();
        c.execute("INSERT INTO folders(id, name, created_at) VALUES (1, 'A', 0)", []).unwrap();
        for (i, deleted) in [(1, None), (2, Some(5)), (3, None)] {
            c.execute(
                "INSERT INTO media(id, object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, deleted_at) VALUES (?1, ?1, 1, 'image', 'a', 'jpg', 10, 'h', 0, ?2)",
                rusqlite::params![i, deleted],
            )
            .unwrap();
        }
        let v: Vec<f32> = (0..1024).map(|i| ((i as f32) * 0.37).sin() * 0.06).collect();
        let blob: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        // Back to how a v12 library looked, then upgrade again.
        c.execute_batch(
            "DROP TRIGGER folder_stats_add; DROP TRIGGER folder_stats_remove; DROP TRIGGER folder_stats_change; DROP TRIGGER folder_stats_gone; \
             DROP TABLE folder_stats; DROP TABLE face_graph; ALTER TABLE clip DROP COLUMN f16; PRAGMA user_version = 12;",
        )
        .unwrap();
        c.execute("INSERT INTO clip(media_id, vec) VALUES (1, ?)", [&blob]).unwrap();
        migrate(&c).unwrap();
        assert_eq!(stats(&c), vec![(1, 2, 20)]);
        let (back, f16): (Vec<u8>, i64) = c.query_row("SELECT vec, f16 FROM clip", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((back.len(), f16), (2048, 1));
        let got = crate::half::f16_blob_to_f32(&back);
        assert!(got.iter().zip(&v).all(|(a, b)| (a - b).abs() < 1e-4));
        let ver: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert!(ver >= 13);
        // Running it again changes nothing.
        c.execute_batch("PRAGMA user_version = 12;").unwrap();
        migrate(&c).unwrap();
        assert_eq!(stats(&c), vec![(1, 2, 20)]);
        assert_eq!(c.query_row("SELECT vec FROM clip", [], |r| r.get::<_, Vec<u8>>(0)).unwrap(), back);
    }

    #[test]
    fn v14_adds_thumbnail_pages_and_can_run_again() {
        let c = create_empty().unwrap();
        c.execute(
            "INSERT INTO thumb_bundles(object_id, folder_id, size, items, bytes, members, made_at) VALUES ('p', NULL, 0, 1, 10, x'00', 0)",
            [],
        )
        .unwrap();
        // A v12 library (no pages yet) upgrades.
        c.execute_batch("DROP TABLE thumb_bundles; PRAGMA user_version = 12;").unwrap();
        migrate(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        let n: i64 = c.query_row("SELECT COUNT(*) FROM thumb_bundles", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        // Pages already there (or run again from 13) are kept.
        c.execute(
            "INSERT INTO thumb_bundles(object_id, folder_id, size, items, bytes, members, made_at) VALUES ('p', 3, 1, 1, 10, x'00', 0)",
            [],
        )
        .unwrap();
        c.execute_batch("PRAGMA user_version = 13;").unwrap();
        migrate(&c).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM thumb_bundles", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn v15_adds_folder_banners() {
        let c = create_empty().unwrap();
        // (A fresh library comes up through every step, so it got them just now.)
        c.execute("INSERT INTO folders(name, created_at, note) VALUES ('Trips', 0, 'Summer')", []).unwrap();
        c.execute_batch("ALTER TABLE folders DROP COLUMN banner_y; PRAGMA user_version = 12;").unwrap();
        migrate(&c).unwrap();
        let (b, y, n): (Option<i64>, Option<f64>, String) =
            c.query_row("SELECT banner_media_id, banner_y, note FROM folders", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((b, y, n.as_str()), (None, None, "Summer"));
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // Again, and with a column missing at the current version: fine.
        c.execute_batch("ALTER TABLE folders DROP COLUMN banner_y;").unwrap();
        migrate(&c).unwrap();
        assert!(has_column(&c, "folders", "banner_y").unwrap());
        c.execute_batch("PRAGMA user_version = 12;").unwrap();
        migrate(&c).unwrap();
        // Deleting the banner's item for good clears it.
        c.execute("INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('o', 'image', 'a', 'jpg', 1, 'h', 0)", [])
            .unwrap();
        c.execute("UPDATE folders SET banner_media_id = 1, banner_y = 0.4", []).unwrap();
        c.execute("DELETE FROM media", []).unwrap();
        let b: Option<i64> = c.query_row("SELECT banner_media_id FROM folders", [], |r| r.get(0)).unwrap();
        assert_eq!(b, None);
    }

    #[test]
    fn v16_adds_cover_framing() {
        let c = create_empty().unwrap();
        c.execute("INSERT INTO folders(name, created_at, note) VALUES ('Alex', 0, 'Friend')", []).unwrap();
        c.execute_batch("ALTER TABLE folders DROP COLUMN cover_zoom; ALTER TABLE folders DROP COLUMN cover_x; PRAGMA user_version = 15;").unwrap();
        migrate(&c).unwrap();
        let (x, y, z, n): (Option<f64>, Option<f64>, Option<f64>, String) =
            c.query_row("SELECT cover_x, cover_y, cover_zoom, note FROM folders", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        assert_eq!((x, y, z, n.as_str()), (None, None, None, "Friend"));
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // A framing that is there survives running it again (from 15, or with a column missing).
        c.execute("UPDATE folders SET cover_x = 0.25, cover_y = 0.75, cover_zoom = 2.0", []).unwrap();
        c.execute_batch("PRAGMA user_version = 15;").unwrap();
        migrate(&c).unwrap();
        c.execute_batch("ALTER TABLE folders DROP COLUMN cover_zoom;").unwrap();
        migrate(&c).unwrap();
        assert!(has_column(&c, "folders", "cover_zoom").unwrap());
        let (x, y): (f64, f64) = c.query_row("SELECT cover_x, cover_y FROM folders", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((x, y), (0.25, 0.75));
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }

    // ---- poor faces tests (begin) ----
    #[test]
    fn v17_adds_poor_face_measures_and_can_run_again() {
        let c = create_empty().unwrap();
        c.execute("INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at, height) VALUES ('o', 'image', 'a', 'jpg', 1, 'h', 0, 1000)", []).unwrap();
        c.execute("INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('p', 'image', 'b', 'jpg', 1, 'h', 0)", []).unwrap();
        c.execute("INSERT INTO faces(media_id, x, y, w, h, score, descriptor) VALUES (1, 0, 0, 0.1, 0.05, 1, x'00')", []).unwrap();
        c.execute("INSERT INTO faces(media_id, x, y, w, h, score, descriptor) VALUES (2, 0, 0, 0.1, 0.5, 1, x'00')", []).unwrap();
        // Back to how a v15 library looked (no v16 either), then upgrade.
        c.execute_batch("ALTER TABLE faces DROP COLUMN px; ALTER TABLE faces DROP COLUMN sharp; ALTER TABLE faces DROP COLUMN turn; PRAGMA user_version = 15;").unwrap();
        migrate(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        let rows: Vec<(Option<f64>, Option<f64>, Option<f64>)> = c
            .prepare("SELECT px, sharp, turn FROM faces ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(rows, vec![(Some(50.0), None, None), (None, None, None)], "height filled in where the item's size is known");
        // Measured values survive running it again: from v15 or v16, with a column missing, or as it is.
        c.execute("UPDATE faces SET sharp = 12.5, turn = 30 WHERE id = 1", []).unwrap();
        for back in ["PRAGMA user_version = 15;", "PRAGMA user_version = 16;", "ALTER TABLE faces DROP COLUMN turn;", ""] {
            c.execute_batch(back).unwrap();
            migrate(&c).unwrap();
            assert!(has_column(&c, "faces", "turn").unwrap());
            let s: Option<f64> = c.query_row("SELECT sharp FROM faces WHERE id = 1", [], |r| r.get(0)).unwrap();
            assert_eq!(s, Some(12.5));
            let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
            assert_eq!(v, SCHEMA_VERSION);
        }
    }
    // ---- poor faces tests (end) ----

    #[test]
    fn v18_adds_saved_depth_maps_that_go_with_their_item() {
        let c = create_empty().unwrap();
        c.execute("INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('o', 'image', 'a', 'jpg', 1, 'h', 0)", []).unwrap();
        // Back to how a v17 library looked, then upgrade.
        c.execute_batch("DROP TABLE derived; PRAGMA user_version = 17;").unwrap();
        assert!(!has_table(&c, "derived").unwrap());
        migrate(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        let put = |kind: &str, model: &str, obj: &str| {
            c.execute(
                "INSERT INTO derived(media_id, kind, model, object_id, source, bytes, made_at) VALUES (1, ?1, ?2, ?3, 'o', 10, 0)",
                rusqlite::params![kind, model, obj],
            )
        };
        put("depth", "v2-small", "d1").unwrap();
        put("outline", "birefnet", "o1").unwrap();
        put("depth", "da3-mono-large", "d2").unwrap();
        assert!(put("depth", "v2-small", "d3").is_err(), "one per item, kind and model");
        assert!(put("height", "x", "d4").is_err(), "only depth and outline");
        // Rows survive running it again (from 17, or as it is) and saving.
        for back in ["PRAGMA user_version = 17;", ""] {
            c.execute_batch(back).unwrap();
            migrate(&c).unwrap();
            assert_eq!(c.query_row("SELECT COUNT(*) FROM derived", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        }
        let c = deserialize(&serialize(&c).unwrap()).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM derived", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        // Deleting the item for good takes its rows.
        c.execute("DELETE FROM media", []).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM derived", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn v19_not_the_same_person_goes_with_the_face() {
        let c = create_empty().unwrap();
        c.execute("INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('o', 'image', 'a', 'jpg', 1, 'h', 0)", []).unwrap();
        c.execute("INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('p', 'image', 'b', 'jpg', 1, 'h', 0)", []).unwrap();
        for m in [1, 1, 2] {
            c.execute("INSERT INTO faces(media_id, x, y, w, h, score, descriptor) VALUES (?, 0, 0, 1, 1, 1, x'00')", [m]).unwrap();
        }
        // Back to v18 with a pair left behind by a face already gone (9).
        c.execute_batch("DROP TRIGGER face_not_same_gone; PRAGMA user_version = 18;").unwrap();
        c.execute_batch("INSERT INTO face_not_same VALUES (1, 3), (2, 3), (1, 9);").unwrap();
        migrate(&c).unwrap();
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        let n = |c: &Connection| c.query_row("SELECT COUNT(*) FROM face_not_same", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(n(&c), 2, "the pair with a missing face went");
        // Deleting the second picture for good takes its face's pairs (through the cascade).
        let c = deserialize(&serialize(&c).unwrap()).unwrap();
        c.execute("DELETE FROM media WHERE id = 2", []).unwrap();
        assert_eq!(n(&c), 0);
        migrate(&c).unwrap();
    }
}
