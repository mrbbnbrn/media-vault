//! Measurements for the speed work (not run by default):
//! `cargo test -p media-vault-app bench_ -- --ignored --nocapture --test-threads 1`
//! Each prints its numbers; they only assert that the results are right.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use rusqlite::params;
use vault_core::stream::{ObjectReader, ObjectWriter};
use vault_core::{ObjectId, ObjectKind, half};

use crate::{clip, faces, import, library, session};

fn rnd(seed: &mut u64) -> f32 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    (*seed >> 11) as f32 / (1u64 << 53) as f32 - 0.5
}

fn unit(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter_mut().for_each(|x| *x /= n);
    v
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

const ITEMS: i64 = 20_000;
const FOLDERS: i64 = 300;
const FACES: i64 = 4_000;

/// A library like a big real one: 300 folders (some inside others), 20 000
/// items with thumbnails, smart-search vectors for all of them (videos have
/// five) and 4 000 faces.
fn fill(c: &rusqlite::Connection) {
    let tx = c.unchecked_transaction().unwrap();
    for f in 1..=FOLDERS {
        let parent = if f > 30 { Some((f % 30) + 1) } else { None };
        tx.execute("INSERT INTO folders(id, parent_id, name, created_at, person) VALUES (?, ?, ?, 0, ?)", params![f, parent, format!("Folder {f}"), (f <= 5) as i64])
            .unwrap();
    }
    let mut seed = 0x1234_5678_9abc_def0u64;
    let centres: Vec<Vec<f32>> = (0..40).map(|_| (0..clip::DIM).map(|_| rnd(&mut seed)).collect()).collect();
    for i in 1..=ITEMS {
        let kind = ["image", "image", "video", "gif"][(i % 4) as usize];
        tx.execute(
            "INSERT INTO media(id, object_id, thumb_object_id, folder_id, kind, original_name, ext, size, sha256, imported_at, clip_state) \
             VALUES (?1, lower(hex(randomblob(16))), lower(hex(randomblob(16))), ?2, ?3, ?4, 'jpg', ?5, 'h', ?1, 1)",
            params![i, if i % 50 == 0 { None } else { Some(i % FOLDERS + 1) }, kind, format!("IMG_{i:05}.jpg"), 1_000_000 + i],
        )
        .unwrap();
        let n = if kind == "video" { 5 } else { 1 };
        let mut v = Vec::new();
        for _ in 0..n {
            v.extend(unit(centres[(i % 40) as usize].iter().map(|c| c + rnd(&mut seed) * 1.5).collect()));
        }
        tx.execute("INSERT INTO clip(media_id, vec, f16) VALUES (?, ?, 1)", params![i, half::f32s_to_f16_blob(&v)]).unwrap();
    }
    let people: Vec<Vec<f32>> = (0..60).map(|_| unit((0..512).map(|_| rnd(&mut seed)).collect())).collect();
    for k in 1..=FACES {
        let d = unit(people[(k % 60) as usize].iter().map(|c| c + rnd(&mut seed) * 0.05).collect());
        let blob: Vec<u8> = d.iter().flat_map(|x| x.to_le_bytes()).collect();
        tx.execute(
            "INSERT INTO faces(media_id, x, y, w, h, score, descriptor, model, person_id) VALUES (?, 0.1, 0.1, 0.2, 0.2, 0.9, ?, 1, ?)",
            params![k * 4 + 1, blob, if k % 7 == 0 { Some(k % 5 + 1) } else { None }],
        )
        .unwrap();
    }
    tx.commit().unwrap();
}

/// How folders were counted before (the GROUP BY, the sorted samples, every item's kind).
fn old_folder_queries(c: &rusqlite::Connection) -> usize {
    let mut n = 0;
    let mut st = c
        .prepare(
            "SELECT folder_id, COUNT(*), MIN(CASE WHEN thumb_object_id IS NOT NULL AND thumb_object_id <> '' \
             AND kind = 'image' THEN id END), MIN(CASE WHEN thumb_object_id IS NOT NULL AND thumb_object_id <> '' THEN id END), \
             IFNULL(SUM(size), 0) FROM media WHERE folder_id IS NOT NULL AND deleted_at IS NULL GROUP BY folder_id",
        )
        .unwrap();
    n += st.query_map([], |r| r.get::<_, i64>(1)).unwrap().count();
    let mut st = c
        .prepare(
            "SELECT folder_id, id FROM media WHERE folder_id IS NOT NULL AND deleted_at IS NULL \
             AND thumb_object_id IS NOT NULL AND thumb_object_id <> '' ORDER BY folder_id, kind <> 'image', id",
        )
        .unwrap();
    n += st.query_map([], |r| r.get::<_, i64>(1)).unwrap().count();
    let mut st = c.prepare("SELECT id, kind FROM media WHERE id IN (SELECT cover_media_id FROM folders) OR thumb_object_id IS NOT NULL").unwrap();
    n += st.query_map([], |r| r.get::<_, String>(1)).unwrap().count();
    n
}

fn old_search(c: &rusqlite::Connection, q: &[f32]) -> usize {
    let rows: Vec<(i64, Vec<u8>)> = c
        .prepare("SELECT c.media_id, c.vec FROM clip c JOIN media m ON m.id = c.media_id WHERE m.deleted_at IS NULL")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let mut s: Vec<(i64, f32)> = rows
        .into_iter()
        .map(|(id, b)| {
            let v: Vec<f32> = b.chunks_exact(4).map(|x| f32::from_le_bytes([x[0], x[1], x[2], x[3]])).collect();
            (id, v.chunks(clip::DIM).map(|r| r.iter().zip(q).map(|(a, b)| a * b).sum::<f32>()).fold(f32::MIN, f32::max))
        })
        .collect();
    s.sort_by(|a, b| b.1.total_cmp(&a.1));
    let items = library::query_items(c, &Default::default()).unwrap();
    let by: HashMap<i64, library::Item> = items.into_iter().map(|i| (i.id, i)).collect();
    s.iter().take(300).filter(|x| by.contains_key(&x.0)).count()
}

#[test]
#[ignore]
fn bench_library_unlock_folders_search_faces() {
    let t = tempfile::tempdir().unwrap();
    let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
    let path = s.info().path;
    fill(&s.db());
    s.mark_dirty();
    s.save().unwrap();

    // Folder cards: counted before vs kept by triggers now.
    {
        let c = s.db();
        let t0 = Instant::now();
        for _ in 0..5 {
            old_folder_queries(&c);
        }
        let old = ms(t0) / 5.0;
        let t0 = Instant::now();
        for _ in 0..5 {
            library::all_folders(&c).unwrap();
        }
        let new = ms(t0) / 5.0;
        let t0 = Instant::now();
        let cards = library::all_folders(&c).unwrap();
        eprintln!(
            "folders: the counting queries alone took {old:.1} ms per load before; the whole folder list now {new:.1} ms ({} folders, {} items; once more: {:.1} ms)",
            cards.len(),
            cards.iter().filter(|f| f.parent_id.is_none()).map(|f| f.items).sum::<i64>(),
            ms(t0)
        );
        assert!(vault_core::db::check_folder_stats(&c).unwrap());
    }

    // Smart search: reading every vector per search before vs the index now.
    let mut seed = 99u64;
    let q = unit((0..clip::DIM).map(|_| rnd(&mut seed)).collect());
    {
        let c = s.db();
        let t0 = Instant::now();
        let first = clip::search(&c, &q, None, 300).unwrap();
        let cold = ms(t0);
        let t0 = Instant::now();
        for _ in 0..5 {
            clip::search(&c, &q, None, 300).unwrap();
        }
        let warm = ms(t0) / 5.0;
        // As before: 32-bit blobs read from the library on every search.
        c.execute_batch("UPDATE clip SET f16 = 0").unwrap(); // (marks only; converted below)
        let rows: Vec<(i64, Vec<u8>)> =
            c.prepare("SELECT media_id, vec FROM clip").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        for (id, b) in rows {
            let f32s: Vec<u8> = half::f16_blob_to_f32(&b).iter().flat_map(|x| x.to_le_bytes()).collect();
            c.execute("UPDATE clip SET vec = ? WHERE media_id = ?", params![f32s, id]).unwrap();
        }
        let t0 = Instant::now();
        for _ in 0..3 {
            old_search(&c, &q);
        }
        let old = ms(t0) / 3.0;
        let f32_size = vault_core::db::serialize(&c).unwrap().len();
        eprintln!("smart search: {old:.1} ms per search before; now {warm:.1} ms ({cold:.1} ms for the first, which loads the index); {} results", first.len());
        // Back to 16-bit for the rest (the index sees every change through its triggers).
        let rows: Vec<(i64, Vec<u8>)> =
            c.prepare("SELECT media_id, vec FROM clip").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        for (id, b) in rows {
            c.execute("UPDATE clip SET vec = ?, f16 = 1 WHERE media_id = ?", params![half::f32_blob_to_f16(&b), id]).unwrap();
        }
        c.execute_batch("VACUUM").unwrap();
        let f16_size = vault_core::db::serialize(&c).unwrap().len();
        eprintln!("library size: {:.1} MB with 32-bit vectors, {:.1} MB with 16-bit ones", f32_size as f64 / 1e6, f16_size as f64 / 1e6);
        let again = clip::search(&c, &q, None, 300).unwrap();
        assert_eq!(again.iter().map(|h| h.item.id).take(20).collect::<Vec<_>>(), first.iter().map(|h| h.item.id).take(20).collect::<Vec<_>>());
    }
    s.mark_dirty();
    s.save().unwrap();

    // Faces: the look-alike graph worked out from nothing, then read back.
    let t0 = Instant::now();
    faces::warm(&s).unwrap();
    let cold = ms(t0);
    faces::keep_graphs(&s);
    s.save().unwrap();
    drop(s);
    faces::forget_cache();
    clip::forget_index();

    // Unlocking until the grid can show (the top level and the folder list).
    let t0 = Instant::now();
    let s = session::unlock(&path, "long enough pw").unwrap();
    let opened = ms(t0);
    let folders = library::all_folders(&s.db()).unwrap();
    let top = library::query_items(&s.db(), &library::ItemFilter { folder: Some(None), ..Default::default() }).unwrap();
    let grid = ms(t0);
    eprintln!("unlock: library open in {opened:.0} ms, grid ready (folders + top level) in {grid:.0} ms; {} folders, {} items at the top", folders.len(), top.len());
    let t0 = Instant::now();
    let n = clip::warm(&s).unwrap();
    eprintln!("after unlock, in the background: {n} items' vectors loaded in {:.0} ms", ms(t0));
    let t0 = Instant::now();
    faces::warm(&s).unwrap();
    eprintln!("faces: graph of {FACES} faces worked out in {cold:.0} ms; read back from the library in {:.0} ms", ms(t0));
}

#[test]
#[ignore]
fn bench_encrypt_decrypt_and_import() {
    let master = vault_core::crypto::random_key();
    let data: Vec<u8> = (0..256u32 << 20).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8).collect();
    let mb = data.len() as f64 / 1e6;
    let mut enc = Vec::new();
    let id = ObjectId::random();
    for threads in [1, vault_core::stream::default_threads()] {
        let t0 = Instant::now();
        let mut w = ObjectWriter::new(Cursor::new(Vec::with_capacity(data.len() + (1 << 20))), id, ObjectKind::Media, 20).unwrap();
        w.set_threads(threads);
        for c in data.chunks(64 << 10) {
            w.write_all(c).unwrap();
        }
        let (cur, _) = w.finish(&master).unwrap();
        let wt = t0.elapsed().as_secs_f64();
        enc = cur.into_inner();
        let t0 = Instant::now();
        let mut r = ObjectReader::open(Cursor::new(&enc), &master, id, None).unwrap();
        r.set_threads(threads);
        let mut back = Vec::with_capacity(data.len());
        r.read_to_end(&mut back).unwrap();
        let rt = t0.elapsed().as_secs_f64();
        assert!(back == data);
        eprintln!("{threads} core(s): encrypt + SHA-256 {:.0} MB/s, decrypt {:.0} MB/s", mb / wt, mb / rt);
    }
    drop(enc);

    // Importing a folder: 120 pictures of 2 MB and two 40 MB videos.
    let t = tempfile::tempdir().unwrap();
    let src = t.path().join("Import");
    std::fs::create_dir_all(&src).unwrap();
    let mut total = 0usize;
    for i in 0..122usize {
        let len = if i % 61 == 60 { 40 << 20 } else { 2 << 20 };
        let name = if len > 2 << 20 { format!("v{i:03}.mp4") } else { format!("p{i:03}.jpg") };
        let body: Vec<u8> = (0..len).map(|k| ((k * 131 + i * 7) >> 3) as u8).collect();
        std::fs::write(src.join(name), body).unwrap();
        total += len;
    }
    let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
    // One by one, one core each (as before).
    let t0 = Instant::now();
    let mut files: Vec<_> = std::fs::read_dir(&src).unwrap().map(|e| e.unwrap().path()).collect();
    files.sort();
    for f in &files {
        let e = s.vault().encrypt_to_memory(ObjectKind::Media, std::fs::File::open(f).unwrap()).unwrap();
        s.vault().add_encrypted(&e).unwrap();
    }
    let before = t0.elapsed().as_secs_f64();
    let t0 = Instant::now();
    let job = import::Job { id: 1, paths: vec![src.display().to_string()], target: None, password: None, archive_folder: true };
    let r = import::run(&s, &job, &AtomicBool::new(false), &mut |_| {});
    let after = t0.elapsed().as_secs_f64();
    assert_eq!(r.imported, 122);
    eprintln!(
        "import of {:.0} MB in 122 files: {:.0} MB/s one at a time on one core, {:.0} MB/s now ({} cores)",
        total as f64 / 1e6,
        total as f64 / 1e6 / before,
        total as f64 / 1e6 / after,
        vault_core::stream::default_threads()
    );
}
