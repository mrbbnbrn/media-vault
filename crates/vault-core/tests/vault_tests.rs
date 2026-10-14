use std::fs;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use vault_core::stream::{HEADER_LEN, ObjectReader, ObjectWriter};
use vault_core::{Access, Error, KdfParams, ObjectId, ObjectKind, Vault, crypto, db, export};

const PW: &str = "correct horse battery staple";

fn new_vault(dir: &Path) -> (Vault, String) {
    let (v, phrase) = Vault::create(&dir.join("v"), PW, KdfParams::TEST_ONLY).unwrap();
    (v, phrase.as_str().to_string())
}

fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

// ---- keys, password, recovery ----------------------------------------------

#[test]
fn create_then_unlock_with_password() {
    let t = tempfile::tempdir().unwrap();
    let (v, phrase) = new_vault(t.path());
    assert_eq!(phrase.split(' ').count(), 24);
    let id = v.add_object(ObjectKind::Media, &b"hello"[..]).unwrap().0;
    drop(v);

    let v = Vault::unlock(&t.path().join("v"), PW, Access::ReadWrite).unwrap();
    assert_eq!(
        &v.read_object(ObjectKind::Media, &id).unwrap()[..],
        b"hello"
    );
    assert!(t.path().join("v/FORMAT.md").is_file());
}

#[test]
fn wrong_password_is_rejected() {
    let t = tempfile::tempdir().unwrap();
    drop(new_vault(t.path()));
    let err = Vault::unlock(&t.path().join("v"), "wrong", Access::ReadOnly)
        .err()
        .unwrap();
    assert!(matches!(err, Error::WrongKey), "{err}");
}

#[test]
fn recovery_phrase_unlocks_and_tolerates_formatting() {
    let t = tempfile::tempdir().unwrap();
    let (v, phrase) = new_vault(t.path());
    let id = v.add_object(ObjectKind::Media, &b"data"[..]).unwrap().0;
    drop(v);

    // Numbered, upper case, split over lines, as someone might type it from paper.
    let messy: String = phrase
        .split(' ')
        .enumerate()
        .map(|(i, w)| {
            format!(
                "{}. {}{}",
                i + 1,
                w.to_uppercase(),
                if i % 6 == 5 { "\n" } else { "  " }
            )
        })
        .collect();
    let mut v =
        Vault::unlock_with_recovery(&t.path().join("v"), &messy, Access::ReadWrite).unwrap();
    assert_eq!(&v.read_object(ObjectKind::Media, &id).unwrap()[..], b"data");

    // Typical flow after recovery: set a new password.
    v.change_password("brand new password").unwrap();
    drop(v);
    assert!(Vault::unlock(&t.path().join("v"), PW, Access::ReadOnly).is_err());
    assert!(Vault::unlock(&t.path().join("v"), "brand new password", Access::ReadOnly).is_ok());
}

#[test]
fn wrong_or_malformed_recovery_phrase_is_rejected() {
    let t = tempfile::tempdir().unwrap();
    drop(new_vault(t.path()));
    let other = crypto::entropy_to_words(&crypto::random_bytes::<32>());
    assert!(matches!(
        Vault::unlock_with_recovery(&t.path().join("v"), &other, Access::ReadOnly)
            .err()
            .unwrap(),
        Error::WrongKey
    ));
    assert!(matches!(
        Vault::unlock_with_recovery(&t.path().join("v"), "abandon abandon", Access::ReadOnly)
            .err()
            .unwrap(),
        Error::BadRecoveryPhrase(_)
    ));
}

#[test]
fn reset_recovery_invalidates_old_words() {
    let t = tempfile::tempdir().unwrap();
    let (mut v, old) = new_vault(t.path());
    let new = v.reset_recovery().unwrap().as_str().to_string();
    drop(v);
    assert!(Vault::unlock_with_recovery(&t.path().join("v"), &old, Access::ReadOnly).is_err());
    assert!(Vault::unlock_with_recovery(&t.path().join("v"), &new, Access::ReadOnly).is_ok());
}

#[test]
fn header_has_no_secrets_and_backup_header_works() {
    let t = tempfile::tempdir().unwrap();
    let (_v, phrase) = new_vault(t.path());
    let root = t.path().join("v");
    let json = fs::read_to_string(root.join("vault.json")).unwrap();
    assert!(!json.contains(PW));
    for w in phrase.split(' ').take(3) {
        assert!(!json.contains(&format!("\"{w}\"")));
    }
    drop(_v);
    // Damage the main header; the .bak copy takes over.
    fs::write(root.join("vault.json"), b"{ garbage").unwrap();
    assert!(Vault::unlock(&root, PW, Access::ReadOnly).is_ok());
}

#[test]
fn refuses_to_create_over_existing_data() {
    let t = tempfile::tempdir().unwrap();
    drop(new_vault(t.path()));
    assert!(matches!(
        Vault::create(&t.path().join("v"), PW, KdfParams::TEST_ONLY)
            .err()
            .unwrap(),
        Error::AlreadyExists(_)
    ));
    let busy = t.path().join("busy");
    fs::create_dir(&busy).unwrap();
    fs::write(busy.join("x.txt"), b"x").unwrap();
    assert!(Vault::create(&busy, PW, KdfParams::TEST_ONLY).is_err());
}

#[test]
fn only_one_writer_at_a_time() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let root = t.path().join("v");
    assert!(Vault::unlock(&root, PW, Access::ReadWrite).is_err());
    // Read-only (export tool) is always allowed.
    let ro = Vault::unlock(&root, PW, Access::ReadOnly).unwrap();
    assert!(ro.add_object(ObjectKind::Media, &b"x"[..]).is_err());
    drop(v);
    assert!(Vault::unlock(&root, PW, Access::ReadWrite).is_ok());
}

// ---- encrypted objects -------------------------------------------------------

#[test]
fn round_trips_all_sizes_around_chunk_boundaries() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let mib = 1 << 20;
    for &len in &[0, 1, 1000, mib - 1, mib, mib + 1, 2 * mib, 3 * mib + 12345] {
        let data = pseudo_random(len, len as u64);
        let (id, w) = v.add_object(ObjectKind::Media, &data[..]).unwrap();
        assert_eq!(w.plaintext_len, len as u64);
        assert_eq!(
            &v.read_object(ObjectKind::Media, &id).unwrap()[..],
            &data[..],
            "len {len}"
        );
        v.verify_object(ObjectKind::Media, &id).unwrap();
    }
}

#[test]
fn sha256_is_of_the_original_file() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let (_, w) = v.add_object(ObjectKind::Media, &b"abc"[..]).unwrap();
    assert_eq!(
        w.sha256_hex,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn random_access_seeking_matches_original() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let data = pseudo_random(5 * (1 << 20) + 777, 42);
    let (id, _) = v.add_object(ObjectKind::Media, &data[..]).unwrap();
    let mut r = v.open_object(ObjectKind::Media, &id).unwrap();
    let positions = [
        0u64,
        1,
        1048575,
        1048576,
        3_000_000,
        5 * 1048576,
        data.len() as u64 - 10,
        12345,
    ];
    for &p in &positions {
        r.seek(SeekFrom::Start(p)).unwrap();
        let mut buf = vec![0u8; 70_000];
        let mut got = 0;
        loop {
            let n = r.read(&mut buf[got..]).unwrap();
            if n == 0 || got + n == buf.len() {
                got += n;
                break;
            }
            got += n;
        }
        let end = (p as usize + 70_000).min(data.len());
        assert_eq!(&buf[..got], &data[p as usize..end], "at {p}");
    }
    assert_eq!(r.seek(SeekFrom::End(-1)).unwrap(), data.len() as u64 - 1);
}

#[test]
fn ciphertext_does_not_contain_plaintext() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let marker = b"THIS-IS-A-VERY-RECOGNISABLE-MARKER-STRING".repeat(1000);
    let (id, _) = v.add_object(ObjectKind::Media, &marker[..]).unwrap();
    let (pack, _, _) = v.object_location(ObjectKind::Media, &id).unwrap();
    let raw = fs::read(pack).unwrap();
    assert!(!raw.windows(20).any(|w| w == &marker[..20]));
}

/// The encrypted bytes of an object, wherever it is stored.
fn object_bytes(v: &Vault, id: &ObjectId) -> Vec<u8> {
    let (path, off, len) = v.object_location(ObjectKind::Media, id).unwrap();
    let all = fs::read(path).unwrap();
    all[off as usize..(off + len) as usize].to_vec()
}

/// Overwrite an object's bytes in place (same length).
fn put_object_bytes(v: &Vault, id: &ObjectId, bytes: &[u8]) {
    let (path, off, len) = v.object_location(ObjectKind::Media, id).unwrap();
    assert_eq!(bytes.len() as u64, len);
    let mut all = fs::read(&path).unwrap();
    all[off as usize..(off + len) as usize].copy_from_slice(bytes);
    fs::write(path, all).unwrap();
}

#[test]
fn any_flipped_bit_is_detected() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let data = pseudo_random(2 * (1 << 20) + 100, 7);
    let (id, _) = v.add_object(ObjectKind::Media, &data[..]).unwrap();
    let good = object_bytes(&v, &id);
    // Header fields, wrapped key, first/middle/last chunk, and tags.
    for &pos in &[
        4usize,
        6,
        9,
        17,
        25,
        40,
        82,
        83,
        500_000,
        1_048_600,
        good.len() - 20,
        good.len() - 1,
    ] {
        let mut bad = good.clone();
        bad[pos] ^= 0x01;
        put_object_bytes(&v, &id, &bad);
        let ok = v.verify_object(ObjectKind::Media, &id).is_ok();
        assert!(!ok, "flip at {pos} went unnoticed");
    }
    put_object_bytes(&v, &id, &good);
    v.verify_object(ObjectKind::Media, &id).unwrap();
}

fn in_memory_object(data: &[u8]) -> (vault_core::crypto::Key, ObjectId, Vec<u8>) {
    let master = crypto::random_key();
    let id = ObjectId::random();
    let mut w = ObjectWriter::new(Cursor::new(Vec::new()), id, ObjectKind::Media, 20).unwrap();
    std::io::Write::write_all(&mut w, data).unwrap();
    let (cur, _) = w.finish(&master).unwrap();
    (master, id, cur.into_inner())
}

#[test]
fn truncation_and_appending_are_detected() {
    let data = pseudo_random(3 * (1 << 20), 9);
    let (master, id, good) = in_memory_object(&data);
    let chunk = (1 << 20) + 16;

    // Drop the final chunk entirely (cut exactly at a chunk boundary).
    let cut = good[..HEADER_LEN as usize + 2 * chunk].to_vec();
    let mut r = ObjectReader::open(Cursor::new(cut), &master, id, None).unwrap();
    assert!(r.verify_all().is_err());
    r.seek(SeekFrom::Start(0)).unwrap();
    let mut sink = Vec::new();
    assert!(r.read_to_end(&mut sink).is_err());

    // Extra bytes on the end.
    let mut longer = good.clone();
    longer.extend_from_slice(&[0u8; 50]);
    let mut r = ObjectReader::open(Cursor::new(longer), &master, id, None).unwrap();
    assert!(r.verify_all().is_err());
}

#[test]
fn chunks_cannot_be_swapped_or_moved_between_objects() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let a = pseudo_random(3 * (1 << 20), 1);
    let b = pseudo_random(3 * (1 << 20), 2);
    let (ia, _) = v.add_object(ObjectKind::Media, &a[..]).unwrap();
    let (ib, _) = v.add_object(ObjectKind::Media, &b[..]).unwrap();
    let chunk = (1 << 20) + 16;
    let h = HEADER_LEN as usize;

    // Swap chunk 0 and 1 inside A.
    let good = object_bytes(&v, &ia);
    let mut sw = good.clone();
    sw[h..h + chunk].copy_from_slice(&good[h + chunk..h + 2 * chunk]);
    sw[h + chunk..h + 2 * chunk].copy_from_slice(&good[h..h + chunk]);
    put_object_bytes(&v, &ia, &sw);
    assert!(v.verify_object(ObjectKind::Media, &ia).is_err());

    // Put B's bytes where A should be: the header is bound to the id, so it fails.
    let bb = object_bytes(&v, &ib);
    put_object_bytes(&v, &ia, &bb);
    assert!(v.open_object(ObjectKind::Media, &ia).is_err());
}

#[test]
fn objects_from_another_vault_do_not_open() {
    let t1 = tempfile::tempdir().unwrap();
    let t2 = tempfile::tempdir().unwrap();
    let (v1, _) = new_vault(t1.path());
    let (v2, _) = new_vault(t2.path());
    let (id, _) = v1.add_object(ObjectKind::Media, &b"secret"[..]).unwrap();
    v1.save_db(&db::serialize(&db::create_empty().unwrap()).unwrap())
        .unwrap();
    // Plant v1's pack inside v2 and let v2 find it by scanning.
    let (pack, _, _) = v1.object_location(ObjectKind::Media, &id).unwrap();
    fs::copy(&pack, t2.path().join("v/packs/media-000099.pack")).unwrap();
    v2.rescan_packs().unwrap();
    assert!(v2.open_object(ObjectKind::Media, &id).is_err());
}

#[test]
fn small_chunk_sizes_work_in_memory() {
    let master = crypto::random_key();
    let id = ObjectId::random();
    for &len in &[0usize, 4095, 4096, 4097, 50_000] {
        let data = pseudo_random(len, 3);
        let mut w =
            ObjectWriter::new(Cursor::new(Vec::new()), id, ObjectKind::Thumbnail, 12).unwrap();
        std::io::Write::write_all(&mut w, &data).unwrap();
        let (cur, _) = w.finish(&master).unwrap();
        let mut r = ObjectReader::open(cur, &master, id, Some(ObjectKind::Thumbnail)).unwrap();
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!(out, data);
        r.verify_all().unwrap();
    }
}

#[test]
fn list_and_delete_objects() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let a = v.add_object(ObjectKind::Media, &b"a"[..]).unwrap().0;
    let b = v.add_object(ObjectKind::Media, &b"b"[..]).unwrap().0;
    let th = v.add_object(ObjectKind::Thumbnail, &b"t"[..]).unwrap().0;
    let mut want = vec![a, b];
    want.sort();
    assert_eq!(v.list_objects(ObjectKind::Media).unwrap(), want);
    assert_eq!(v.list_objects(ObjectKind::Thumbnail).unwrap(), vec![th]);
    // A thumbnail can't be opened as media.
    assert!(v.open_object(ObjectKind::Media, &th).is_err());
    v.delete_object(ObjectKind::Media, &a).unwrap();
    assert_eq!(v.list_objects(ObjectKind::Media).unwrap(), vec![b]);
    // No stray temp files left behind.
    let leftovers: Vec<_> = walk(t.path())
        .into_iter()
        .filter(|p| p.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

fn walk(p: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for e in fs::read_dir(p).unwrap() {
        let e = e.unwrap();
        if e.file_type().unwrap().is_dir() {
            out.extend(walk(&e.path()));
        } else {
            out.push(e.path().to_string_lossy().into_owned());
        }
    }
    out
}

// ---- database ----------------------------------------------------------------

#[test]
fn database_round_trip_and_rotating_backups() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let (bytes, from_backup) = v.load_db().unwrap();
    assert!(from_backup.is_none());
    let conn = db::deserialize(&bytes).unwrap();

    for i in 0..15 {
        conn.execute("INSERT INTO tags(name) VALUES (?)", [format!("tag{i}")])
            .unwrap();
        v.save_db(&db::serialize(&conn).unwrap()).unwrap();
    }
    assert_eq!(v.db_backups().unwrap().len(), 10);

    // Saving often with a minimum gap keeps just one fresh backup.
    let before = v.db_backups().unwrap().len();
    for _ in 0..5 {
        v.save_db_spaced(&db::serialize(&conn).unwrap(), std::time::Duration::from_secs(3600)).unwrap();
    }
    assert_eq!(v.db_backups().unwrap().len(), before, "the newest backup is recent, no new copies");

    let (bytes, _) = v.load_db().unwrap();
    let conn2 = db::deserialize(&bytes).unwrap();
    let n: i64 = conn2
        .query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 15);

    // Database file is not readable SQLite on disk.
    let raw = fs::read(t.path().join("v/meta.db.enc")).unwrap();
    assert!(!raw.starts_with(b"SQLite format 3"));
    assert!(!raw.windows(5).any(|w| w == b"tag14"));
}

#[test]
fn damaged_database_falls_back_to_newest_backup() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let conn = db::create_empty().unwrap();
    conn.execute("INSERT INTO tags(name) VALUES ('first')", [])
        .unwrap();
    v.save_db(&db::serialize(&conn).unwrap()).unwrap();
    conn.execute("INSERT INTO tags(name) VALUES ('second')", [])
        .unwrap();
    v.save_db(&db::serialize(&conn).unwrap()).unwrap();

    let main = t.path().join("v/meta.db.enc");
    let mut raw = fs::read(&main).unwrap();
    let n = raw.len();
    raw[n - 5] ^= 0xff;
    fs::write(&main, raw).unwrap();

    let (bytes, used) = v.load_db().unwrap();
    assert!(used.is_some());
    let c = db::deserialize(&bytes).unwrap();
    let names: Vec<String> = c
        .prepare("SELECT name FROM tags")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|x| x.unwrap())
        .collect();
    assert_eq!(names, vec!["first"]);
}

fn add_media(
    conn: &rusqlite::Connection,
    v: &Vault,
    name: &str,
    folder: Option<i64>,
    body: &[u8],
) -> i64 {
    let (id, w) = v.add_object(ObjectKind::Media, body).unwrap();
    conn.execute(
        "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at)
         VALUES (?1, ?2, 'image', ?3, 'jpg', ?4, ?5, 0)",
        rusqlite::params![id.to_hex(), folder, name, w.plaintext_len as i64, w.sha256_hex],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn add_folder(conn: &rusqlite::Connection, parent: Option<i64>, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO folders(parent_id, name, created_at) VALUES (?1, ?2, 0)",
        rusqlite::params![parent, name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn tag(conn: &rusqlite::Connection, name: &str) -> i64 {
    conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", [name])
        .unwrap();
    conn.query_row("SELECT id FROM tags WHERE name = ?", [name], |r| r.get(0))
        .unwrap()
}

#[test]
fn tag_search_includes_inherited_folder_tags() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let conn = db::create_empty().unwrap();
    let people = add_folder(&conn, None, "People");
    let alex = add_folder(&conn, Some(people), "Alex");
    let beach = add_folder(&conn, Some(alex), "Beach 2024");
    let other = add_folder(&conn, None, "Other");

    let m1 = add_media(&conn, &v, "a.jpg", Some(beach), b"1");
    let m2 = add_media(&conn, &v, "b.jpg", Some(alex), b"2");
    let m3 = add_media(&conn, &v, "c.jpg", Some(other), b"3");
    let m4 = add_media(&conn, &v, "d.jpg", None, b"4");

    let t_alex = tag(&conn, "Alex");
    let t_sun = tag(&conn, "sunny");
    conn.execute("INSERT INTO folder_tags VALUES (?, ?)", [alex, t_alex])
        .unwrap();
    conn.execute("INSERT INTO media_tags VALUES (?, ?)", [m1, t_sun])
        .unwrap();
    conn.execute("INSERT INTO media_tags VALUES (?, ?)", [m3, t_sun])
        .unwrap();
    conn.execute("INSERT INTO media_tags VALUES (?, ?)", [m4, t_alex])
        .unwrap();

    assert_eq!(
        db::search_by_tags(&conn, &["alex"]).unwrap(),
        vec![m1, m2, m4]
    );
    assert_eq!(db::search_by_tags(&conn, &["SUNNY"]).unwrap(), vec![m1, m3]);
    assert_eq!(
        db::search_by_tags(&conn, &["alex", "sunny"]).unwrap(),
        vec![m1]
    );
    assert_eq!(
        db::search_by_tags(&conn, &["alex", "Alex "]).unwrap(),
        vec![m1, m2, m4]
    );
    assert!(
        db::search_by_tags(&conn, &["alex", "nonexistent"])
            .unwrap()
            .is_empty()
    );
    assert!(db::search_by_tags(&conn, &[]).unwrap().is_empty());
}

#[test]
fn tag_names_are_unique_ignoring_case() {
    let conn = db::create_empty().unwrap();
    conn.execute("INSERT INTO tags(name) VALUES ('Alex')", [])
        .unwrap();
    assert!(
        conn.execute("INSERT INTO tags(name) VALUES ('alex')", [])
            .is_err()
    );
}

// ---- export ---------------------------------------------------------------------

#[test]
fn export_restores_names_folders_and_handles_awkward_names() {
    let t = tempfile::tempdir().unwrap();
    let (v, phrase) = new_vault(t.path());
    let conn = db::create_empty().unwrap();
    let people = add_folder(&conn, None, "People");
    let alex = add_folder(&conn, Some(people), "Alex: best/worst");
    add_media(&conn, &v, "photo.jpg", Some(alex), b"one");
    add_media(&conn, &v, "photo.jpg", Some(alex), b"two"); // same name twice
    add_media(&conn, &v, "PHOTO.JPG", Some(alex), b"three"); // differs only by case
    add_media(&conn, &v, "CON.png", None, b"reserved");
    let big = pseudo_random(2_500_000, 5);
    add_media(&conn, &v, "clip.mp4", Some(people), &big);
    v.save_db(&db::serialize(&conn).unwrap()).unwrap();
    drop(v);

    // Simulate the standalone tool: read-only, recovery key, fresh DB load.
    let v = Vault::unlock_with_recovery(&t.path().join("v"), &phrase, Access::ReadOnly).unwrap();
    let (bytes, _) = v.load_db().unwrap();
    let conn = db::deserialize(&bytes).unwrap();
    let items = export::list_items(&conn, None).unwrap();
    let out = t.path().join("out");
    let report = export::export_items(&v, &conn, &items, &out, |_, _, _| {}).unwrap();
    assert_eq!(report.exported, 5);
    assert!(report.failed.is_empty());

    let alex_dir = out.join("People").join("Alex_ best_worst");
    let mut got: Vec<(String, Vec<u8>)> = fs::read_dir(&alex_dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                fs::read(e.path()).unwrap(),
            )
        })
        .collect();
    got.sort();
    let mut contents: Vec<&[u8]> = got.iter().map(|(_, c)| c.as_slice()).collect();
    contents.sort();
    assert_eq!(contents, vec![&b"one"[..], b"three", b"two"]);
    assert_eq!(got.len(), 3);
    assert_eq!(fs::read(out.join("People/clip.mp4")).unwrap(), big);
    assert_eq!(fs::read(out.join("_CON.png")).unwrap(), b"reserved");
}

#[test]
fn export_continues_past_damaged_files() {
    let t = tempfile::tempdir().unwrap();
    let (v, _) = new_vault(t.path());
    let conn = db::create_empty().unwrap();
    add_media(&conn, &v, "good.jpg", None, b"fine");
    let bad_id = add_media(&conn, &v, "bad.jpg", None, &pseudo_random(10_000, 1));
    let obj: String = conn
        .query_row("SELECT object_id FROM media WHERE id = ?", [bad_id], |r| {
            r.get(0)
        })
        .unwrap();
    let oid = ObjectId::from_hex(&obj).unwrap();
    let mut raw = object_bytes(&v, &oid);
    raw[200] ^= 1;
    put_object_bytes(&v, &oid, &raw);

    let items = export::list_items(&conn, None).unwrap();
    let out = t.path().join("out");
    let report = export::export_items(&v, &conn, &items, &out, |_, _, _| {}).unwrap();
    assert_eq!(report.exported, 1);
    assert_eq!(report.failed.len(), 1);
    assert_eq!(report.failed[0].0, "bad.jpg");
    assert!(out.join("good.jpg").exists());
    assert!(
        !out.join("bad.jpg").exists(),
        "partial file should be removed"
    );
}

#[test]
fn safe_names() {
    assert_eq!(
        export::safe_name("a<b>c:d\"e/f\\g|h?i*j.jpg"),
        "a_b_c_d_e_f_g_h_i_j.jpg"
    );
    assert_eq!(export::safe_name("trailing. . "), "trailing");
    assert_eq!(export::safe_name("nul.txt"), "_nul.txt");
    assert_eq!(export::safe_name(""), "_");
    assert_eq!(export::safe_name("Ünïcödé 写真.png"), "Ünïcödé 写真.png");
}

#[test]
fn schema_v2_has_weights_and_upgrades_v1_libraries() {
    let conn = db::create_empty().unwrap();
    let v: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(v, db::SCHEMA_VERSION);
    conn.execute("INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('x','image','a.jpg','jpg',1,'h',0)", []).unwrap();
    let w: f64 = conn
        .query_row("SELECT weight FROM media", [], |r| r.get(0))
        .unwrap();
    assert_eq!(w, 1.0);
    assert!(conn.execute("UPDATE media SET weight = -1", []).is_err());

    // A v1 library (no weight column) is upgraded on load.
    let old = rusqlite::Connection::open_in_memory().unwrap();
    old.execute_batch("CREATE TABLE folders (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
        CREATE TABLE media (id INTEGER PRIMARY KEY, object_id TEXT NOT NULL UNIQUE, thumb_object_id TEXT, folder_id INTEGER, kind TEXT NOT NULL CHECK (kind IN ('image','gif','video')), width INTEGER, height INTEGER, duration_ms INTEGER, has_audio INTEGER, original_name TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, imported_at INTEGER NOT NULL, favourite INTEGER NOT NULL DEFAULT 0);
        INSERT INTO media(object_id, kind, original_name, ext, size, sha256, imported_at) VALUES ('y','video','b.mp4','mp4',1,'h',0);
        PRAGMA user_version = 1;").unwrap();
    let bytes = db::serialize(&old).unwrap();
    let up = db::deserialize(&bytes).unwrap();
    let w: f64 = up
        .query_row("SELECT weight FROM media", [], |r| r.get(0))
        .unwrap();
    assert_eq!(w, 1.0);
    up.execute("UPDATE folders SET cover_media_id = NULL", [])
        .unwrap();
}
