//! The slot machine's data: the pictures in a folder (with its subfolders)
//! and the groups a jackpot can land on: everyone recognised in them (person
//! folders, the same rule as a people search) and every tag they share (the
//! same rule as a tag search: direct or through a folder).

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::library::{self, Item, ItemFilter, R};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlotGroup {
    /// "person" or "tag"
    pub kind: String,
    /// Person folder id, or the tag's name.
    pub key: String,
    pub label: String,
    /// Items of the pool in this group, in pool order.
    pub items: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlotData {
    /// Pictures, GIFs and videos with a thumbnail.
    pub items: Vec<Item>,
    /// Groups with at least two items, people first.
    pub groups: Vec<SlotGroup>,
}

pub fn slot_data(conn: &Connection, folder: Option<i64>) -> R<SlotData> {
    let items: Vec<Item> = library::query_items(conn, &ItemFilter { folder: Some(folder), recursive: true, ..Default::default() })?
        .into_iter()
        .filter(|i| i.thumb == "ok" && matches!(i.kind.as_str(), "image" | "gif" | "video"))
        .collect();
    let pool: HashSet<i64> = items.iter().map(|i| i.id).collect();
    let order: HashMap<i64, usize> = items.iter().enumerate().map(|(k, i)| (i.id, k)).collect();
    let sorted = |mut v: Vec<i64>| {
        v.sort_by_key(|id| order[id]);
        v.dedup();
        v
    };
    let mut groups = Vec::new();

    // People: in the person's folder (or below it), or recognised by face.
    let persons: Vec<(i64, String)> = conn
        .prepare("SELECT id, name FROM folders WHERE person = 1 AND deleted_at IS NULL ORDER BY name COLLATE NOCASE")
        .map_err(e)?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<rusqlite::Result<_>>()
        .map_err(e)?;
    let mut faces: HashMap<i64, Vec<i64>> = HashMap::new();
    {
        let mut st = conn.prepare("SELECT person_id, media_id FROM faces WHERE person_id IS NOT NULL").map_err(e)?;
        for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))).map_err(e)? {
            let (p, m) = row.map_err(e)?;
            if pool.contains(&m) {
                faces.entry(p).or_default().push(m);
            }
        }
    }
    for (p, name) in persons {
        let inside: HashSet<i64> = library::descendants(conn, &[p])?.into_iter().collect();
        let mut v: Vec<i64> = items.iter().filter(|i| i.folder_id.is_some_and(|f| inside.contains(&f))).map(|i| i.id).collect();
        v.extend(faces.remove(&p).unwrap_or_default());
        let v = sorted(v);
        if v.len() >= 2 {
            groups.push(SlotGroup { kind: "person".into(), key: p.to_string(), label: name, items: v });
        }
    }

    // Tags: own tags plus tags of every folder an item is inside.
    let mut parent: HashMap<i64, Option<i64>> = HashMap::new();
    {
        let mut st = conn.prepare("SELECT id, parent_id FROM folders").map_err(e)?;
        for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?))).map_err(e)? {
            let (id, p) = row.map_err(e)?;
            parent.insert(id, p);
        }
    }
    let mut folder_tags: HashMap<i64, Vec<String>> = HashMap::new();
    let mut tag_name: HashMap<String, String> = HashMap::new();
    {
        let mut st = conn.prepare("SELECT ft.folder_id, t.name FROM folder_tags ft JOIN tags t ON t.id = ft.tag_id").map_err(e)?;
        for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(e)? {
            let (f, t) = row.map_err(e)?;
            tag_name.entry(t.to_lowercase()).or_insert(t.clone());
            folder_tags.entry(f).or_default().push(t.to_lowercase());
        }
    }
    let mut by_tag: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    {
        let mut st = conn.prepare("SELECT mt.media_id, t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id").map_err(e)?;
        for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(e)? {
            let (m, t) = row.map_err(e)?;
            if pool.contains(&m) {
                tag_name.entry(t.to_lowercase()).or_insert(t.clone());
                by_tag.entry(t.to_lowercase()).or_default().push(m);
            }
        }
    }
    for it in &items {
        let mut cur = it.folder_id;
        let mut guard = 0;
        while let Some(f) = cur {
            for t in folder_tags.get(&f).map(|v| v.as_slice()).unwrap_or(&[]) {
                by_tag.entry(t.clone()).or_default().push(it.id);
            }
            cur = parent.get(&f).copied().flatten();
            guard += 1;
            if guard > 1000 {
                break;
            }
        }
    }
    for (t, v) in by_tag {
        let v = sorted(v);
        if v.len() >= 2 {
            let label = tag_name.get(&t).cloned().unwrap_or(t.clone());
            groups.push(SlotGroup { kind: "tag".into(), key: label.clone(), label, items: v });
        }
    }
    Ok(SlotData { items, groups })
}

#[tauri::command]
pub async fn slot_machine_data(state: State<'_, crate::Shared>, folder: Option<i64>) -> Result<SlotData, String> {
    crate::read_db(state.inner(), move |c| slot_data(c, folder)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use vault_core::db;

    fn add(c: &Connection, name: &str, folder: Option<i64>) -> i64 {
        c.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (lower(hex(randomblob(16))), ?1, 'image', ?2, 'jpg', 10, 'h', 0, 'thumb')",
            params![folder, name],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    #[test]
    fn groups_follow_the_search_rules() {
        let c = db::create_empty().unwrap();
        let fun = library::create_folder(&c, None, "Fun").unwrap();
        let beach = library::create_folder(&c, Some(fun), "Beach").unwrap();
        let bahar = library::create_folder(&c, Some(fun), "Bahar").unwrap();
        c.execute("UPDATE folders SET person = 1 WHERE id = ?", [bahar]).unwrap();
        let elsewhere = library::create_folder(&c, None, "Elsewhere").unwrap();
        let a = add(&c, "a", Some(beach));
        let b = add(&c, "b", Some(beach));
        let d = add(&c, "d", Some(bahar));
        let x = add(&c, "x", Some(elsewhere));
        let no_thumb = add(&c, "n", Some(fun));
        c.execute("UPDATE media SET thumb_object_id = NULL WHERE id = ?", [no_thumb]).unwrap();
        c.execute(
            "INSERT INTO faces(media_id, x, y, w, h, score, descriptor, person_id) VALUES (?1, 0, 0, 1, 1, 1, x'00', ?2)",
            params![a, bahar],
        )
        .unwrap();
        library::tag_folder(&c, beach, &["Sea".into()]).unwrap();
        library::tag_items(&c, &[d, x], &["sea".into()]).unwrap();

        let s = slot_data(&c, Some(fun)).unwrap();
        let ids: HashSet<i64> = s.items.iter().map(|i| i.id).collect();
        assert_eq!(ids, HashSet::from([a, b, d]), "subfolders yes, no thumbnail no, other folders no");
        let g: Vec<(&str, &str, HashSet<i64>)> =
            s.groups.iter().map(|g| (g.kind.as_str(), g.label.as_str(), g.items.iter().copied().collect())).collect();
        assert_eq!(g, vec![("person", "Bahar", HashSet::from([a, d])), ("tag", "Sea", HashSet::from([a, b, d]))]);

        // The same items a search finds, limited to the pool.
        for grp in &s.groups {
            let f = if grp.kind == "person" {
                ItemFilter { people: vec![grp.key.parse().unwrap()], ..Default::default() }
            } else {
                ItemFilter { tags: vec![grp.key.clone()], ..Default::default() }
            };
            let found: HashSet<i64> = library::query_items(&c, &f).unwrap().into_iter().map(|i| i.id).filter(|i| ids.contains(i)).collect();
            assert_eq!(found, grp.items.iter().copied().collect::<HashSet<_>>(), "{}", grp.label);
        }
    }
}
