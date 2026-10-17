//! Vaults without encryption, and changing a vault from encrypted to not
//! encrypted and back.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use vault_core::{Access, KdfParams, ObjectId, ObjectKind, PlainFile, Vault, db};

const PW: &str = "plain test password";

fn data(i: usize, len: usize) -> Vec<u8> {
    (0..len).map(|k| ((k * 31 + i * 7) % 251) as u8).collect()
}

fn save(v: &Vault, conn: &db::Connection) {
    let ch = v.drain_index_changes();
    db::apply_index_changes(conn, &ch).unwrap();
    v.save_db(&db::serialize(conn).unwrap()).unwrap();
}

fn all_bytes(dir: &Path) -> Vec<u8> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).unwrap().flatten() {
        if e.file_type().unwrap().is_dir() {
            out.extend(all_bytes(&e.path()));
        } else if e.file_name() != ".lock" {
            // (.lock is locked while the vault is open: Windows can't read it)
            out.extend(fs::read(e.path()).unwrap());
        }
    }
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Convert everything, saving in between, the way the app does.
fn convert_all(v: &mut Vault, conn: &db::Connection) {
    let todo = v.conversion_todo().unwrap();
    let mut later = Vec::new();
    for (k, id) in todo {
        if let Some(p) = v.convert_one(k, &id).unwrap().remove_after_save {
            later.push(p);
        }
    }
    save(v, conn);
    for p in later {
        v.remove_converted(&p).unwrap();
    }
    let plan = v.compact(1e-9).unwrap();
    save(v, conn);
    v.finish_compact(&plan).unwrap();
    v.finish_conversion().unwrap();
    save(v, conn);
}

#[test]
fn a_vault_without_encryption_keeps_media_as_ordinary_files() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("Plain");
    let v = Vault::create_plain(&root, KdfParams::TEST_ONLY).unwrap();
    assert!(v.header().is_plain() && v.header().is_passwordless());
    let pic = data(1, 3_000_000);
    let (id, w) = v.add_object(ObjectKind::Media, &pic[..]).unwrap();
    assert_eq!(w.plaintext_len, pic.len() as u64);
    // The new file is the picture itself, byte for byte.
    assert_eq!(fs::read(v.new_file_path(&id)).unwrap(), pic);
    let thumb = b"thumbnail bytes, readable as they are".to_vec();
    let (tid, _) = v.add_object(ObjectKind::Thumbnail, &thumb[..]).unwrap();
    let conn = db::create_empty().unwrap();
    save(&v, &conn);
    assert!(contains(&all_bytes(&root.join("packs")), &thumb), "thumbnails are stored unencrypted");
    // Moved into its folder; read back from there, also with seeking.
    v.set_media_file(id, Some(PlainFile { path: "Trip/beach.jpg".into(), prev: Some(format!(".new/{}", id.to_hex())) }));
    v.move_media_file(&id, "Trip/beach.jpg").unwrap();
    assert!(root.join("Files").join("Trip").join("beach.jpg").is_file());
    let mut r = v.open_object(ObjectKind::Media, &id).unwrap();
    r.seek(SeekFrom::Start(2_500_000)).unwrap();
    let mut b = vec![0u8; 10];
    r.read_exact(&mut b).unwrap();
    assert_eq!(b, pic[2_500_000..2_500_010]);
    drop(r); // Windows can't remove a folder while a file in it is open
    assert_eq!(v.read_object(ObjectKind::Thumbnail, &tid).unwrap()[..], thumb[..]);
    assert!(v.list_objects(ObjectKind::Media).unwrap().contains(&id));
    drop(v);
    // Opens without a password; no password can be set while not encrypted.
    let mut v = Vault::open_without_password(&root, Access::ReadWrite).unwrap();
    let (bytes, _) = v.load_db().unwrap();
    let conn = db::deserialize(&bytes).unwrap();
    v.load_index(db::load_index(&conn).unwrap());
    v.set_media_files([(id, PlainFile { path: "Trip/beach.jpg".into(), prev: None })]);
    assert_eq!(v.read_object(ObjectKind::Media, &id).unwrap()[..], pic[..]);
    assert!(v.change_password("a new password").is_err());
    assert!(v.turn_password_off().is_err());
    // Deleting removes the file and the folder it leaves empty.
    v.delete_object(ObjectKind::Media, &id).unwrap();
    assert!(!root.join("Files").join("Trip").exists());
    assert!(root.join("Files").is_dir());
}

#[test]
fn encrypted_to_plain_and_back_again() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("V");
    let (mut v, _) = Vault::create(&root, PW, KdfParams::TEST_ONLY).unwrap();
    v.set_pack_limit(4 << 20);
    let pics: Vec<Vec<u8>> = (0..5).map(|i| data(i, 1_500_000 + i)).collect();
    let ids: Vec<ObjectId> = pics.iter().map(|p| v.add_object(ObjectKind::Media, &p[..]).unwrap().0).collect();
    let marker = b"a thumbnail that must end up readable".to_vec();
    let (tid, _) = v.add_object(ObjectKind::Thumbnail, &marker[..]).unwrap();
    let conn = db::create_empty().unwrap();
    conn.execute("INSERT INTO folders(name, created_at) VALUES ('secret folder name', 0)", []).unwrap();
    save(&v, &conn);
    assert!(!contains(&all_bytes(&root), b"secret folder name"));

    // ---- to plain
    v.begin_plain().unwrap();
    assert_eq!(v.conversion(), Some("plain"));
    // Half done, then "closed" and opened again with the password: everything still reads.
    let todo = v.conversion_todo().unwrap();
    assert_eq!(todo.len(), 6);
    v.convert_one(todo[0].0, &todo[0].1).unwrap();
    save(&v, &conn);
    drop(v);
    let mut v = Vault::unlock(&root, PW, Access::ReadWrite).unwrap();
    let (bytes, _) = v.load_db().unwrap();
    let conn = db::deserialize(&bytes).unwrap();
    v.load_index(db::load_index(&conn).unwrap());
    for (i, id) in ids.iter().enumerate() {
        assert_eq!(v.read_object(ObjectKind::Media, id).unwrap()[..], pics[i][..], "midway, item {i}");
    }
    assert_eq!(v.conversion_todo().unwrap().len(), 5);
    convert_all(&mut v, &conn);
    assert!(v.header().is_plain() && v.header().password_slot.is_none());
    for (i, id) in ids.iter().enumerate() {
        assert_eq!(fs::read(v.new_file_path(id)).unwrap(), pics[i], "an ordinary file");
    }
    assert!(contains(&all_bytes(&root), b"secret folder name"), "the library is readable now");
    assert!(contains(&all_bytes(&root.join("packs")), &marker));
    for b in fs::read_dir(root.join("meta-backups")).unwrap().flatten() {
        assert!(contains(&fs::read(b.path()).unwrap(), b"secret folder name"), "old encrypted backups gone");
    }
    drop(v);
    assert!(Vault::unlock(&root, PW, Access::ReadOnly).is_err(), "no password any more");
    let mut v = Vault::open_without_password(&root, Access::ReadWrite).unwrap();
    let (bytes, _) = v.load_db().unwrap();
    let conn = db::deserialize(&bytes).unwrap();
    v.load_index(db::load_index(&conn).unwrap());
    assert_eq!(v.read_object(ObjectKind::Thumbnail, &tid).unwrap()[..], marker[..]);
    // A file put in a folder by the app.
    v.set_media_file(ids[0], Some(PlainFile { path: "A/one.jpg".into(), prev: None }));
    v.move_media_file(&ids[0], "A/one.jpg").unwrap();

    // ---- and back to encrypted (with a password)
    let phrase = v.begin_encrypted(Some("another long password")).unwrap();
    assert_eq!(phrase.words().len(), 24);
    convert_all(&mut v, &conn);
    assert!(!v.header().plain && v.header().has_password());
    assert!(!root.join("Files").exists(), "the ordinary files are gone");
    let everything = all_bytes(&root);
    assert!(!contains(&everything, b"secret folder name"));
    assert!(!contains(&everything, &marker));
    assert!(!contains(&everything, &pics[2][1000..1100]));
    drop(v);
    let v = Vault::unlock(&root, "another long password", Access::ReadOnly).unwrap();
    let (bytes, _) = v.load_db().unwrap();
    let conn = db::deserialize(&bytes).unwrap();
    v.load_index(db::load_index(&conn).unwrap());
    for (i, id) in ids.iter().enumerate() {
        assert_eq!(v.read_object(ObjectKind::Media, id).unwrap()[..], pics[i][..], "item {i}");
        v.verify_object(ObjectKind::Media, id).unwrap();
    }
    drop(v);
    Vault::unlock_with_recovery(&root, phrase.as_str(), Access::ReadOnly).unwrap();
}

#[test]
fn encrypting_without_a_password_opens_without_asking() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("P");
    let mut v = Vault::create_plain(&root, KdfParams::TEST_ONLY).unwrap();
    let (id, _) = v.add_object(ObjectKind::Media, &b"hello"[..]).unwrap();
    let conn = db::create_empty().unwrap();
    save(&v, &conn);
    v.begin_encrypted(None).unwrap();
    convert_all(&mut v, &conn);
    drop(v);
    let h = vault_core::read_header(&root).unwrap();
    assert!(!h.plain && h.open_slot.is_some() && h.version == 3);
    let v = Vault::open_without_password(&root, Access::ReadOnly).unwrap();
    let (bytes, _) = v.load_db().unwrap();
    let conn = db::deserialize(&bytes).unwrap();
    v.load_index(db::load_index(&conn).unwrap());
    assert_eq!(&v.read_object(ObjectKind::Media, &id).unwrap()[..], b"hello");
}
