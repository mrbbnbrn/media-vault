//! "Why is this here?": explains why an item is in a search's results, using
//! the search's own rules (library::query_items for people, tags, file names
//! and filters; clip::search for smart search), so the two can't drift apart.
//! The tests check that the explanation's verdict always agrees with the
//! search itself.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::clip;
use crate::library::{self, Item, ItemFilter, R};

fn e(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

/// One searched word and where it was found (character ranges, end exclusive,
/// counted in Unicode characters of the original text).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WordMatch {
    pub word: String,
    pub found: bool,
    pub in_name: Vec<(usize, usize)>,
    pub in_note: Vec<(usize, usize)>,
    /// Also appears in the names of the folders it is in (shown for context:
    /// folder names are not part of a name search).
    pub in_folder_path: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagMatch {
    pub tag: String,
    pub found: bool,
    /// Tagged directly.
    pub own: bool,
    /// Tagged through these folders (it is inside them).
    pub from_folders: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersonMatch {
    pub id: i64,
    pub name: String,
    pub found: bool,
    /// It is stored in the person's folder (or a folder inside it).
    pub in_folder: bool,
    /// Faces recognised as this person in it.
    pub faces: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilterCheck {
    /// "kind", "favourites", "recent", "folder", "trash"
    pub filter: String,
    pub passed: bool,
    /// What the filter wants, in words.
    pub wants: String,
    /// What the item has, in words.
    pub has: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SmartMatch {
    /// Similarity to the words (CLIP cosine, about 0.15–0.40 in practice).
    pub score: Option<f32>,
    /// The best match's score.
    pub best: f32,
    /// Results need at least this score, unless they are among the first few.
    pub cut: f32,
    /// Always kept: this many best matches.
    pub min_results: usize,
    /// 1 = best match (among items smart search could show).
    pub rank: Option<usize>,
    pub kept: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    pub item: Item,
    /// Does it pass every rule of the search? (The same answer the search gives.)
    pub matched: bool,
    /// The folders it is in, top first.
    pub folder_path: Vec<String>,
    pub names: Vec<WordMatch>,
    pub tags: Vec<TagMatch>,
    pub people: Vec<PersonMatch>,
    pub filters: Vec<FilterCheck>,
    pub smart: Option<SmartMatch>,
}

/// Fold one character at a time, remembering which original character each
/// folded one came from (for highlighting).
fn fold_mapped(s: &str) -> (Vec<char>, Vec<usize>) {
    let mut out = Vec::new();
    let mut from = Vec::new();
    for (k, c) in s.chars().enumerate() {
        for f in library::fold(&c.to_string()).chars() {
            out.push(f);
            from.push(k);
        }
    }
    (out, from)
}

/// Every place `word` (folded) appears in `text`, as original character ranges.
fn find_all(text: &str, word: &str) -> Vec<(usize, usize)> {
    let (hay, from) = fold_mapped(text);
    let w: Vec<char> = word.chars().collect();
    let mut out = Vec::new();
    if w.is_empty() || w.len() > hay.len() {
        return out;
    }
    let mut i = 0;
    while i + w.len() <= hay.len() {
        if hay[i..i + w.len()] == w[..] {
            out.push((from[i], from[i + w.len() - 1] + 1));
            i += w.len();
        } else {
            i += 1;
        }
    }
    out
}

fn folder_chain(conn: &Connection, folder: Option<i64>) -> R<Vec<(i64, String)>> {
    let mut out = Vec::new();
    let mut cur = folder;
    while let Some(f) = cur {
        let row: Option<(String, Option<i64>)> = conn
            .query_row("SELECT name, parent_id FROM folders WHERE id = ?", [f], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(e)?;
        let Some((name, parent)) = row else { break };
        out.push((f, name));
        cur = parent;
        if out.len() > 1000 {
            break;
        }
    }
    out.reverse();
    Ok(out)
}

fn kind_word(k: &str) -> &str {
    match k {
        "image" => "picture",
        "gif" => "GIF",
        "video" => "video",
        "text" => "text file",
        "pdf" => "PDF",
        other => other,
    }
}

/// Explain why `id` is (or isn't) in the results of `filter`, plus smart
/// search with the query vector `smart` (searched in `smart_folder`) if given.
pub fn explain(conn: &Connection, id: i64, filter: &ItemFilter, smart: Option<&[f32]>, smart_folder: Option<i64>) -> R<Explanation> {
    let item = library::get_item(conn, id)?;
    let chain = folder_chain(conn, item.folder_id)?;
    let path_folded = library::fold(&chain.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(" "));
    let mut matched = true;

    // File name (and your note): the same haystack and test as query_items.
    let words: Vec<String> = filter.names.iter().map(|n| library::fold(n.trim())).filter(|n| !n.is_empty()).collect();
    let mut names = Vec::new();
    for (raw, w) in filter.names.iter().filter(|n| !library::fold(n.trim()).is_empty()).zip(&words) {
        let found = library::names_match(&item, std::slice::from_ref(w));
        names.push(WordMatch {
            word: raw.trim().to_string(),
            found,
            in_name: find_all(&item.name, w),
            in_note: item.note.as_deref().map(|n| find_all(n, w)).unwrap_or_default(),
            in_folder_path: path_folded.contains(w.as_str()),
        });
    }
    if !words.is_empty() && !library::names_match(&item, &words) {
        matched = false;
    }

    // Tags: the same query as the search (direct or through a folder).
    let mut tags = Vec::new();
    if !filter.tags.is_empty() {
        let names_all: Vec<&str> = filter.tags.iter().map(|s| s.as_str()).collect();
        let all = vault_core::db::search_by_tags(conn, &names_all).map_err(|x| x.to_string())?;
        if !all.contains(&id) {
            matched = false;
        }
        let it = library::item_tags(conn, id)?;
        for t in &filter.tags {
            let one = vault_core::db::search_by_tags(conn, &[t.as_str()]).map_err(|x| x.to_string())?;
            let lt = t.trim().to_lowercase();
            let mut from: Vec<String> = it.inherited.iter().filter(|(x, _)| x.to_lowercase() == lt).map(|(_, f)| f.clone()).collect();
            from.dedup();
            tags.push(TagMatch {
                tag: t.trim().to_string(),
                found: one.contains(&id),
                own: it.own.iter().any(|x| x.to_lowercase() == lt),
                from_folders: from,
            });
        }
    }

    // People: in the person's folder (or below it), or a face recognised as them.
    let mut people = Vec::new();
    for p in &filter.people {
        let inside: HashSet<i64> = library::descendants(conn, &[*p])?.into_iter().collect();
        let in_folder = item.folder_id.is_some_and(|f| inside.contains(&f));
        let faces: i64 = conn
            .query_row("SELECT COUNT(*) FROM faces WHERE media_id = ? AND person_id = ?", [id, *p], |r| r.get(0))
            .map_err(e)?;
        let name: String = conn
            .query_row("SELECT name FROM folders WHERE id = ?", [*p], |r| r.get(0))
            .optional()
            .map_err(e)?
            .unwrap_or_else(|| "someone".into());
        let found = in_folder || faces > 0;
        if !found {
            matched = false;
        }
        people.push(PersonMatch { id: *p, name, found, in_folder, faces });
    }

    // Filters.
    let mut filters = Vec::new();
    let mut check = |filter: &str, passed: bool, wants: String, has: String| {
        if !passed {
            matched = false;
        }
        filters.push(FilterCheck { filter: filter.into(), passed, wants, has });
    };
    let in_trash = item.deleted_at.is_some();
    check(
        "trash",
        in_trash == filter.trash,
        if filter.trash { "in the trash".into() } else { "not in the trash".into() },
        if in_trash { "in the trash".into() } else { "not in the trash".into() },
    );
    let kinds: Vec<&String> = filter.kinds.iter().filter(|k| ["image", "gif", "video", "text", "pdf"].contains(&k.as_str())).collect();
    if !kinds.is_empty() {
        check(
            "kind",
            kinds.iter().any(|k| **k == item.kind),
            kinds.iter().map(|k| format!("{}s", kind_word(k))).collect::<Vec<_>>().join(" or "),
            format!("a {}", kind_word(&item.kind)),
        );
    }
    if filter.favourites_only {
        check(
            "favourites",
            item.favourite,
            "favourites".into(),
            if item.favourite { "a favourite".into() } else { "not a favourite".into() },
        );
    }
    if let Some(d) = filter.recent_days {
        let since = library::now_secs() - d * 86_400;
        check("recent", item.imported_at >= since, format!("added in the last {d} days"), format!("added at {}", item.imported_at));
    }
    let mut folder_ids: Vec<i64> = filter.folders.clone();
    let mut include_top = false;
    match filter.folder {
        Some(Some(f)) => folder_ids.push(f),
        Some(None) => include_top = true,
        None => {}
    }
    if include_top || !folder_ids.is_empty() || filter.folder.is_some() || !filter.folders.is_empty() {
        let everything = include_top && filter.recursive;
        let set: HashSet<i64> =
            if filter.recursive && !folder_ids.is_empty() { library::descendants(conn, &folder_ids)? } else { folder_ids.clone() }.into_iter().collect();
        let passed = everything || (include_top && item.folder_id.is_none()) || item.folder_id.is_some_and(|f| set.contains(&f));
        check(
            "folder",
            passed,
            if filter.recursive { "inside the chosen folders".into() } else { "directly in the chosen folders".into() },
            chain.last().map(|(_, n)| format!("in “{n}”")).unwrap_or_else(|| "at the top level".into()),
        );
    }

    // Smart search: ask the search itself whether it keeps this item.
    let smart = match smart {
        Some(vec) => {
            let q = clip::query_vector(vec)?;
            let scored = clip::score_all(conn, &q)?;
            let hits = clip::search(conn, vec, smart_folder, 300)?;
            let kept = hits.iter().any(|h| h.item.id == id);
            if !kept {
                matched = false;
            }
            let best = scored.first().map(|s| s.1).unwrap_or(0.0);
            // Rank among the items the search could show (what its results are counted in).
            let showable: HashSet<i64> = library::query_items(
                conn,
                &ItemFilter { folder: smart_folder.map(Some), recursive: smart_folder.is_some(), ..Default::default() },
            )?
            .into_iter()
            .map(|i| i.id)
            .collect();
            let rank = scored.iter().filter(|(k, _)| showable.contains(k)).position(|(k, _)| *k == id).map(|r| r + 1);
            Some(SmartMatch {
                score: scored.iter().find(|(k, _)| *k == id).map(|s| s.1),
                best,
                cut: best - clip::CUT_BELOW_BEST,
                min_results: clip::MIN_RESULTS,
                rank,
                kept,
            })
        }
        None => None,
    };

    Ok(Explanation {
        folder_path: chain.into_iter().map(|(_, n)| n).collect(),
        item,
        matched,
        names,
        tags,
        people,
        filters,
        smart,
    })
}

#[tauri::command]
pub async fn explain_match(
    state: State<'_, crate::Shared>,
    id: i64,
    filter: ItemFilter,
    smart: Option<Vec<f32>>,
    smart_folder: Option<i64>,
) -> Result<Explanation, String> {
    crate::read_db(state.inner(), move |c| explain(c, id, &filter, smart.as_deref(), smart_folder)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use vault_core::db;

    fn add(c: &Connection, name: &str, folder: Option<i64>, kind: &str) -> i64 {
        c.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, thumb_object_id) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, 'jpg', 10, 'h', ?4, 'thumb')",
            params![folder, kind, name, library::now_secs()],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    fn face(c: &Connection, media: i64, person: i64) {
        c.execute(
            "INSERT INTO faces(media_id, x, y, w, h, score, descriptor, person_id) VALUES (?1, 0, 0, 0.5, 0.5, 0.9, x'00', ?2)",
            params![media, person],
        )
        .unwrap();
    }

    struct Lib {
        c: Connection,
        people: i64,
        bahar: i64,
        trips: i64,
        antalya: i64,
        items: Vec<i64>,
    }

    fn lib() -> Lib {
        let c = db::create_empty().unwrap();
        let people = library::create_folder(&c, None, "People").unwrap();
        let bahar = library::create_folder(&c, Some(people), "Bahar").unwrap();
        c.execute("UPDATE folders SET person = 1 WHERE id = ?", [bahar]).unwrap();
        let trips = library::create_folder(&c, None, "Trips").unwrap();
        let antalya = library::create_folder(&c, Some(trips), "Antalya beach").unwrap();
        let a = add(&c, "IMG_0001 sunset.jpg", Some(antalya), "image");
        let b = add(&c, "İstanbul köprü.jpg", Some(trips), "image");
        let d = add(&c, "Bahar portrait.jpg", Some(bahar), "image");
        let v = add(&c, "clip.mp4", None, "video");
        let g = add(&c, "dance.gif", Some(antalya), "gif");
        face(&c, a, bahar);
        library::tag_items(&c, &[a, v], &["summer".into()]).unwrap();
        library::tag_folder(&c, trips, &["travel".into()]).unwrap();
        library::set_favourite(&c, &[b, g], true).unwrap();
        c.execute("UPDATE media SET note = 'the sunset boat trip' WHERE id = ?", [v]).unwrap();
        Lib { c, people, bahar, trips, antalya, items: vec![a, b, d, v, g] }
    }

    fn filters(l: &Lib) -> Vec<ItemFilter> {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        vec![
            ItemFilter { names: s(&["sunset"]), ..Default::default() },
            ItemFilter { names: s(&["ISTANBUL"]), ..Default::default() },
            ItemFilter { names: s(&["istanbul", "köprü"]), ..Default::default() },
            ItemFilter { names: s(&["boat"]), ..Default::default() },
            ItemFilter { names: s(&["antalya"]), ..Default::default() },
            ItemFilter { tags: s(&["summer"]), ..Default::default() },
            ItemFilter { tags: s(&["TRAVEL"]), ..Default::default() },
            ItemFilter { tags: s(&["travel", "summer"]), ..Default::default() },
            ItemFilter { tags: s(&["nope"]), ..Default::default() },
            ItemFilter { people: vec![l.bahar], ..Default::default() },
            ItemFilter { people: vec![l.bahar], tags: s(&["summer"]), ..Default::default() },
            ItemFilter { favourites_only: true, ..Default::default() },
            ItemFilter { kinds: s(&["gif", "video"]), ..Default::default() },
            ItemFilter { folder: Some(Some(l.trips)), recursive: true, ..Default::default() },
            ItemFilter { folder: Some(Some(l.trips)), ..Default::default() },
            ItemFilter { folder: Some(None), ..Default::default() },
            ItemFilter { folder: Some(None), recursive: true, ..Default::default() },
            ItemFilter { folders: vec![l.antalya, l.people], recursive: true, names: s(&["a"]), ..Default::default() },
            ItemFilter { recent_days: Some(14), favourites_only: true, kinds: s(&["image"]), ..Default::default() },
            ItemFilter { trash: true, ..Default::default() },
        ]
    }

    #[test]
    fn verdict_always_agrees_with_the_search() {
        let l = lib();
        library::trash_items(&l.c, &[l.items[4]]).unwrap();
        for f in filters(&l) {
            let hits: HashSet<i64> = library::query_items(&l.c, &f).unwrap().into_iter().map(|i| i.id).collect();
            for id in &l.items {
                let x = explain(&l.c, *id, &f, None, None).unwrap();
                assert_eq!(x.matched, hits.contains(id), "item {id} with {f:?}: {x:?}");
            }
        }
    }

    #[test]
    fn says_where_words_tags_and_people_matched() {
        let l = lib();
        let [a, b, _, v, _] = l.items[..] else { panic!() };
        let f = ItemFilter { names: vec!["SUNSET".into()], ..Default::default() };
        let x = explain(&l.c, a, &f, None, None).unwrap();
        assert!(x.matched);
        assert_eq!(x.names[0].in_name, vec![(9, 15)]);
        assert!(x.names[0].in_note.is_empty());
        assert_eq!(x.folder_path, vec!["Trips".to_string(), "Antalya beach".to_string()]);
        // Found in the note only.
        let x = explain(&l.c, v, &f, None, None).unwrap();
        assert!(x.matched && x.names[0].in_name.is_empty());
        assert_eq!(x.names[0].in_note, vec![(4, 10)]);
        // Turkish letters: "istanbul" matches "İstanbul" (one character in the original).
        let x = explain(&l.c, b, &ItemFilter { names: vec!["istanbul".into()], ..Default::default() }, None, None).unwrap();
        assert!(x.matched);
        assert_eq!(x.names[0].in_name, vec![(0, 8)]);
        // A word only in the folder path is not a match, but is mentioned.
        let x = explain(&l.c, a, &ItemFilter { names: vec!["antalya".into()], ..Default::default() }, None, None).unwrap();
        assert!(!x.matched && x.names[0].in_folder_path && !x.names[0].found);

        // Tags: own vs through a folder.
        let x = explain(&l.c, a, &ItemFilter { tags: vec!["summer".into(), "travel".into()], ..Default::default() }, None, None).unwrap();
        assert!(x.matched);
        assert!(x.tags[0].own && x.tags[0].from_folders.is_empty());
        assert!(!x.tags[1].own && x.tags[1].from_folders == vec!["Trips".to_string()]);

        // People: by face, and by folder.
        let x = explain(&l.c, a, &ItemFilter { people: vec![l.bahar], ..Default::default() }, None, None).unwrap();
        assert!(x.matched && x.people[0].faces == 1 && !x.people[0].in_folder && x.people[0].name == "Bahar");
        let x = explain(&l.c, l.items[2], &ItemFilter { people: vec![l.bahar], ..Default::default() }, None, None).unwrap();
        assert!(x.matched && x.people[0].in_folder && x.people[0].faces == 0);
        let _ = l.people;

        // Filters say what they wanted.
        let x = explain(&l.c, a, &ItemFilter { kinds: vec!["video".into()], favourites_only: true, ..Default::default() }, None, None).unwrap();
        assert!(!x.matched);
        let kinds: Vec<_> = x.filters.iter().map(|c| (c.filter.as_str(), c.passed)).collect();
        assert_eq!(kinds, vec![("trash", true), ("kind", false), ("favourites", false)]);
    }

    #[test]
    fn smart_search_verdict_agrees_and_reports_scores() {
        let l = lib();
        let unit = |i: usize, j: usize, mix: f32| {
            let mut v = vec![0.0; clip::DIM];
            v[i] = 1.0;
            v[j] += mix;
            v
        };
        // Ten items close to the query, one far away.
        let mut ids = l.items.clone();
        for k in 0..6 {
            ids.push(add(&l.c, &format!("x{k}.jpg"), None, "image"));
        }
        for (k, id) in ids.iter().enumerate() {
            let mix = if k == 0 { 0.0 } else if k == ids.len() - 1 { 9.0 } else { 0.05 + k as f32 * 0.01 };
            clip::save(&l.c, *id, &unit(0, 1, mix)).unwrap();
        }
        let q = unit(0, 1, 0.0);
        let hits: HashSet<i64> = clip::search(&l.c, &q, None, 300).unwrap().into_iter().map(|h| h.item.id).collect();
        for id in &ids {
            let x = explain(&l.c, *id, &ItemFilter::default(), Some(&q), None).unwrap();
            let s = x.smart.clone().unwrap();
            assert_eq!(s.kept, hits.contains(id));
            assert_eq!(x.matched, s.kept);
            assert!(s.score.is_some());
        }
        let best = explain(&l.c, ids[0], &ItemFilter::default(), Some(&q), None).unwrap().smart.unwrap();
        assert_eq!(best.rank, Some(1));
        assert!((best.score.unwrap() - 1.0).abs() < 1e-4 && (best.cut - (1.0 - clip::CUT_BELOW_BEST)).abs() < 1e-4);
        let far = explain(&l.c, *ids.last().unwrap(), &ItemFilter::default(), Some(&q), None).unwrap().smart.unwrap();
        assert!(!far.kept && far.score.unwrap() < far.cut);
    }
}
