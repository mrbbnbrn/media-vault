use std::fs;
use std::io::Write;
use std::path::Path;

use vault_core::stream::ObjectWriter;
use vault_core::{Access, KdfParams, ObjectId, ObjectKind, Vault, db};

const PW: &str = "pack test password";

fn data(i: usize, len: usize) -> Vec<u8> {
    (0..len).map(|k| ((k * 31 + i * 7) % 251) as u8).collect()
}

/// Save the database the way the app does: index changes first.
fn save(v: &Vault, conn: &db::Connection) {
    let ch = v.drain_index_changes();
    db::apply_index_changes(conn, &ch).unwrap();
    v.save_db(&db::serialize(conn).unwrap()).unwrap();
}

fn reopen(root: &Path, load_index: bool) -> (Vault, db::Connection) {
    let v = Vault::unlock(root, PW, Access::ReadWrite).unwrap();
    let (bytes, _) = v.load_db().unwrap();
    let conn = db::deserialize(&bytes).unwrap();
    if load_index {
        v.load_index(db::load_index(&conn).unwrap());
    }
    (v, conn)
}

fn count_files(dir: &Path) -> usize {
    let mut n = 0;
    for e in fs::read_dir(dir).unwrap().flatten() {
        if e.file_type().unwrap().is_dir() {
            n += count_files(&e.path());
        } else {
            n += 1;
        }
    }
    n
}

#[test]
fn thousands_of_items_become_a_handful_of_files() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    let (mut v, _) = Vault::create(&root, PW, KdfParams::TEST_ONLY).unwrap();
    v.set_pack_limit(1 << 20); // 1 MiB packs so the test rolls over
    let conn = db::create_empty().unwrap();
    let mut ids = Vec::new();
    for i in 0..2000 {
        let (id, _) = v.add_object(ObjectKind::Media, &data(i, 1500)[..]).unwrap();
        let (tid, _) = v
            .add_object(ObjectKind::Thumbnail, &data(i + 9, 300)[..])
            .unwrap();
        ids.push((id, tid, i));
    }
    save(&v, &conn);
    let files = count_files(&root);
    assert!(files < 40, "4000 objects stored in {files} files");
    assert!(
        v.pack_usage().unwrap().len() >= 3,
        "packs roll over at the size limit"
    );
    drop(v);

    let (v, _) = reopen(&root, true);
    for (id, tid, i) in ids.iter().step_by(97) {
        assert_eq!(
            &v.read_object(ObjectKind::Media, id).unwrap()[..],
            &data(*i, 1500)[..]
        );
        assert_eq!(
            &v.read_object(ObjectKind::Thumbnail, tid).unwrap()[..],
            &data(*i + 9, 300)[..]
        );
    }
}

#[test]
fn objects_are_found_even_without_the_index() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    let (v, _) = Vault::create(&root, PW, KdfParams::TEST_ONLY).unwrap();
    let (id, _) = v
        .add_object(ObjectKind::Media, &data(1, 50_000)[..])
        .unwrap();
    // Database saved WITHOUT the index (simulates an older backup).
    v.save_db(&db::serialize(&db::create_empty().unwrap()).unwrap())
        .unwrap();
    drop(v);
    let (v, _) = reopen(&root, true);
    assert_eq!(
        &v.read_object(ObjectKind::Media, &id).unwrap()[..],
        &data(1, 50_000)[..]
    );
    // The export tool (read-only) finds it too.
    drop(v);
    let ro = Vault::unlock(&root, PW, Access::ReadOnly).unwrap();
    assert!(ro.verify_object(ObjectKind::Media, &id).is_ok());
}

#[test]
fn an_interrupted_write_is_cut_off_and_nothing_else_is_lost() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    let (v, _) = Vault::create(&root, PW, KdfParams::TEST_ONLY).unwrap();
    let conn = db::create_empty().unwrap();
    let (a, _) = v
        .add_object(ObjectKind::Media, &data(1, 40_000)[..])
        .unwrap();
    save(&v, &conn);
    drop(v);
    // Power cut in the middle of the next write: a partial entry at the end.
    let pack = root.join("packs/media-000001.pack");
    let before = fs::metadata(&pack).unwrap().len();
    let mut f = fs::OpenOptions::new().append(true).open(&pack).unwrap();
    f.write_all(b"MVPE").unwrap();
    f.write_all(&[7u8; 16]).unwrap();
    f.write_all(&123_456u64.to_le_bytes()).unwrap();
    f.write_all(&[1u8; 999]).unwrap();
    drop(f);

    let (v, conn) = reopen(&root, true);
    let (b, _) = v
        .add_object(ObjectKind::Media, &data(2, 40_000)[..])
        .unwrap();
    save(&v, &conn);
    let entry = 28 + v.object_location(ObjectKind::Media, &b).unwrap().2;
    assert_eq!(
        fs::metadata(&pack).unwrap().len(),
        before + entry,
        "the broken tail was removed"
    );
    drop(v);
    let (v, _) = reopen(&root, true);
    assert_eq!(
        &v.read_object(ObjectKind::Media, &a).unwrap()[..],
        &data(1, 40_000)[..]
    );
    assert_eq!(
        &v.read_object(ObjectKind::Media, &b).unwrap()[..],
        &data(2, 40_000)[..]
    );
}

#[test]
fn old_one_file_per_item_vaults_are_converted_safely() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    let (v, _) = Vault::create(&root, PW, KdfParams::TEST_ONLY).unwrap();
    // Build format-1 style loose files, as the earlier app version wrote them.
    let master_probe = Vault::unlock(&root, PW, Access::ReadOnly).unwrap();
    drop(master_probe);
    let mut loose = Vec::new();
    for i in 0..30 {
        let id = ObjectId::random();
        let kind = if i % 3 == 0 {
            ObjectKind::Thumbnail
        } else {
            ObjectKind::Media
        };
        let path = v.object_path(kind, &id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let w = ObjectWriter::new(fs::File::create(&path).unwrap(), id, kind, 20).unwrap();
        write_loose(w, v.test_master(), &data(i, 20_000 + i));
        loose.push((kind, id, i));
    }
    let conn = db::create_empty().unwrap();
    save(&v, &conn);
    drop(v);

    let (mut v, conn) = reopen(&root, true);
    assert!(v.has_loose_objects().unwrap());
    for (kind, id, i) in &loose {
        assert_eq!(
            &v.read_object(*kind, id).unwrap()[..],
            &data(*i, 20_000 + i)[..],
            "old layout still readable"
        );
    }
    let mut last = 0;
    let n = v.pack_loose_objects(|d, _| last = d).unwrap();
    assert_eq!((n, last), (30, 30));
    save(&v, &conn);
    assert_eq!(v.remove_packed_loose_files().unwrap(), 30);
    assert!(!root.join("media").exists() && !root.join("thumbs").exists());
    assert_eq!(vault_core::read_header(&root).unwrap().version, 2);
    drop(v);

    let (v, _) = reopen(&root, true);
    for (kind, id, i) in &loose {
        assert_eq!(
            &v.read_object(*kind, id).unwrap()[..],
            &data(*i, 20_000 + i)[..]
        );
    }
    assert!(count_files(&root) < 20);
}

fn write_loose(mut w: ObjectWriter<fs::File>, master: &vault_core::crypto::Key, bytes: &[u8]) {
    w.write_all(bytes).unwrap();
    let (f, _) = w.finish(master).unwrap();
    f.sync_all().unwrap();
}

#[test]
fn reclaiming_space_after_deletes() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    let (mut v, _) = Vault::create(&root, PW, KdfParams::TEST_ONLY).unwrap();
    v.set_pack_limit(300_000);
    let conn = db::create_empty().unwrap();
    let mut ids = Vec::new();
    for i in 0..20 {
        ids.push((
            v.add_object(ObjectKind::Media, &data(i, 60_000)[..])
                .unwrap()
                .0,
            i,
        ));
    }
    save(&v, &conn);
    let size = |v: &Vault| v.pack_usage().unwrap().iter().map(|u| u.size).sum::<u64>();
    let before = size(&v);
    // Delete most of them.
    for (id, i) in &ids {
        if i % 5 != 0 {
            v.delete_object(ObjectKind::Media, id).unwrap();
        }
    }
    save(&v, &conn);
    let plan = v.compact(0.25).unwrap();
    assert!(plan.moved > 0 && !plan.retired.is_empty());
    // Old packs stay until the database with the new locations is saved.
    for p in &plan.retired {
        assert!(p.exists());
    }
    save(&v, &conn);
    v.finish_compact(&plan).unwrap();
    let after = size(&v);
    assert!(after < before / 3, "{before} -> {after}");
    drop(v);

    let (v, _) = reopen(&root, true);
    for (id, i) in &ids {
        if i % 5 == 0 {
            assert_eq!(
                &v.read_object(ObjectKind::Media, id).unwrap()[..],
                &data(*i, 60_000)[..]
            );
        } else {
            assert!(
                v.read_object(ObjectKind::Media, id).is_err(),
                "deleted stays deleted"
            );
        }
    }
}

#[test]
fn an_older_database_backup_still_finds_moved_objects() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    let (mut v, _) = Vault::create(&root, PW, KdfParams::TEST_ONLY).unwrap();
    v.set_pack_limit(200_000);
    let conn = db::create_empty().unwrap();
    let keep = v
        .add_object(ObjectKind::Media, &data(1, 50_000)[..])
        .unwrap()
        .0;
    let gone: Vec<_> = (0..5)
        .map(|i| {
            v.add_object(ObjectKind::Media, &data(i + 2, 50_000)[..])
                .unwrap()
                .0
        })
        .collect();
    save(&v, &conn);
    let old_db = fs::read(root.join("meta.db.enc")).unwrap();
    for id in &gone {
        v.delete_object(ObjectKind::Media, id).unwrap();
    }
    save(&v, &conn);
    let plan = v.compact(0.2).unwrap();
    save(&v, &conn);
    v.finish_compact(&plan).unwrap();
    drop(v);
    // Main database lost; an old copy (pointing at deleted packs) is all we have.
    fs::write(root.join("meta.db.enc"), &old_db).unwrap();
    let (v, _) = reopen(&root, true);
    assert_eq!(
        &v.read_object(ObjectKind::Media, &keep).unwrap()[..],
        &data(1, 50_000)[..]
    );
}
