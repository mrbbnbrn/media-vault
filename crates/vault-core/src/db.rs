//! The library database: an ordinary SQLite database that only ever exists
//! in memory, and is saved to disk as one encrypted object (meta.db.enc).

use std::collections::HashMap;

pub use rusqlite::Connection;
use rusqlite::{MAIN_DB, params_from_iter};
use zeroize::Zeroizing;

use crate::error::{Error, Result};

pub const SCHEMA_VERSION: i64 = 1;

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
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
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
    Ok(conn)
}

/// Folder id -> list of folder names from the top down.
pub fn folder_paths(conn: &Connection) -> Result<HashMap<i64, Vec<String>>> {
    let mut stmt = conn.prepare("SELECT id, parent_id, name FROM folders")?;
    let rows: Vec<(i64, Option<i64>, String)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    let by_id: HashMap<i64, (Option<i64>, String)> = rows.into_iter().map(|(i, p, n)| (i, (p, n))).collect();
    let mut out = HashMap::new();
    for &id in by_id.keys() {
        let mut path = Vec::new();
        let mut cur = Some(id);
        let mut guard = 0;
        while let Some(c) = cur {
            let (parent, name) = by_id.get(&c).ok_or_else(|| Error::Corrupt(format!("folder {c} missing")))?;
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
    let mut tags: Vec<String> = tags.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).collect();
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
    let ids = stmt.query_map(params_from_iter(args), |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(ids)
}
