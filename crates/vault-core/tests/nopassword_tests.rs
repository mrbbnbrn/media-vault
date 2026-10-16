//! Vaults without a password: the "open" key slot, switching it on and off,
//! the recovery key, and what older programs make of such a vault.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use vault_core::vault::{HEADER_BACKUP_FILE, HEADER_FILE, NO_PASSWORD_VERSION, PACKED_VERSION};
use vault_core::{Access, Error, KdfParams, ObjectKind, Vault, read_header};

const PW: &str = "correct horse battery staple";

/// Every file in the vault except the header and the format description,
/// with its bytes: what must never change when only the password changes.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            if [HEADER_FILE, HEADER_BACKUP_FILE, "FORMAT.md", ".lock"].contains(&name.as_str()) {
                continue;
            }
            out.insert(p.strip_prefix(root).unwrap().to_path_buf(), fs::read(&p).unwrap());
        }
    }
    out
}

fn json(root: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(root.join(HEADER_FILE)).unwrap()).unwrap()
}

#[test]
fn passwordless_vault_opens_without_a_password() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    let (v, phrase) = Vault::create_without_password(&root, KdfParams::TEST_ONLY).unwrap();
    assert_eq!(phrase.words().len(), 24);
    let id = v.add_object(ObjectKind::Media, &b"no password here"[..]).unwrap().0;
    drop(v);

    let h = read_header(&root).unwrap();
    assert!(h.is_passwordless() && !h.has_password());
    assert_eq!(h.version, NO_PASSWORD_VERSION);
    let j = json(&root);
    assert_eq!(j["password_slot"]["salt"], "", "an empty stand-in for older programs");
    assert_eq!(j["open_slot"]["master_key"].as_str().unwrap().len(), 64);
    assert!(j["open_slot"]["warning"].as_str().unwrap().contains("anyone"));
    assert_eq!(json(&root), serde_json::from_slice::<serde_json::Value>(&fs::read(root.join(HEADER_BACKUP_FILE)).unwrap()).unwrap());

    let v = Vault::open_without_password(&root, Access::ReadWrite).unwrap();
    assert_eq!(&v.read_object(ObjectKind::Media, &id).unwrap()[..], b"no password here");
    drop(v);
    // Asking for a password makes no sense here, and says so.
    assert!(matches!(Vault::unlock(&root, PW, Access::ReadOnly).err().unwrap(), Error::NoPassword));
    // The recovery key still works.
    let v = Vault::unlock_with_recovery(&root, phrase.as_str(), Access::ReadOnly).unwrap();
    assert_eq!(&v.read_object(ObjectKind::Media, &id).unwrap()[..], b"no password here");
    // The in-vault format description explains the open slot.
    assert!(fs::read_to_string(root.join("FORMAT.md")).unwrap().contains("open_slot"));
}

#[test]
fn a_vault_with_a_password_cannot_be_opened_without_one() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    drop(Vault::create(&root, PW, KdfParams::TEST_ONLY).unwrap());
    assert!(Vault::open_without_password(&root, Access::ReadOnly).is_err());
    let h = read_header(&root).unwrap();
    assert_eq!(h.version, PACKED_VERSION, "older programs still read ordinary vaults");
    assert!(h.has_password() && !h.is_passwordless());
    assert!(json(&root).get("open_slot").is_none());
}

#[test]
fn password_off_and_on_again_only_changes_the_header() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    let (mut v, phrase) = Vault::create(&root, PW, KdfParams::TEST_ONLY).unwrap();
    let id = v.add_object(ObjectKind::Media, &b"keep me exactly as I am"[..]).unwrap().0;
    v.save_db(&vault_core::db::serialize(&vault_core::db::create_empty().unwrap()).unwrap()).unwrap();
    let before = snapshot(&root);
    let vault_id = read_header(&root).unwrap().vault_id;

    // Off: opens without asking, the password stops working.
    v.turn_password_off().unwrap();
    drop(v);
    assert!(Vault::unlock(&root, PW, Access::ReadOnly).is_err());
    let mut v = Vault::open_without_password(&root, Access::ReadWrite).unwrap();
    assert_eq!(&v.read_object(ObjectKind::Media, &id).unwrap()[..], b"keep me exactly as I am");
    assert_eq!(read_header(&root).unwrap().version, NO_PASSWORD_VERSION);
    assert_eq!(snapshot(&root), before, "media and database untouched");

    // On again, with a new password: the open slot is gone.
    v.change_password("a new password").unwrap();
    drop(v);
    let h = read_header(&root).unwrap();
    assert!(h.has_password() && !h.is_passwordless());
    assert_eq!(h.version, PACKED_VERSION, "readable by older programs again");
    assert_eq!(h.vault_id, vault_id);
    assert!(json(&root).get("open_slot").is_none());
    assert!(!fs::read_to_string(root.join(HEADER_BACKUP_FILE)).unwrap().contains("open_slot"));
    assert!(Vault::open_without_password(&root, Access::ReadOnly).is_err());
    let v = Vault::unlock(&root, "a new password", Access::ReadOnly).unwrap();
    assert_eq!(&v.read_object(ObjectKind::Media, &id).unwrap()[..], b"keep me exactly as I am");
    drop(v);
    assert_eq!(snapshot(&root), before, "media and database untouched");

    // The same 24 words worked all along.
    assert!(Vault::unlock_with_recovery(&root, phrase.as_str(), Access::ReadOnly).is_ok());
}

#[test]
fn recovery_key_can_be_renewed_without_a_password() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    let (mut v, old) = Vault::create_without_password(&root, KdfParams::TEST_ONLY).unwrap();
    let new = v.reset_recovery().unwrap();
    drop(v);
    assert!(Vault::unlock_with_recovery(&root, old.as_str(), Access::ReadOnly).is_err());
    assert!(Vault::unlock_with_recovery(&root, new.as_str(), Access::ReadOnly).is_ok());
    assert!(Vault::open_without_password(&root, Access::ReadOnly).is_ok());
}

#[test]
fn damaged_main_header_falls_back_to_the_backup_copy() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    drop(Vault::create_without_password(&root, KdfParams::TEST_ONLY).unwrap());
    fs::write(root.join(HEADER_FILE), b"{ garbage").unwrap();
    assert!(Vault::open_without_password(&root, Access::ReadOnly).is_ok());
}

#[test]
fn a_wrong_master_key_in_the_open_slot_never_opens_the_library() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    drop(Vault::create_without_password(&root, KdfParams::TEST_ONLY).unwrap());
    for f in [HEADER_FILE, HEADER_BACKUP_FILE] {
        let mut j = json(&root);
        j["open_slot"]["master_key"] = serde_json::Value::String("00".repeat(32));
        fs::write(root.join(f), serde_json::to_vec(&j).unwrap()).unwrap();
    }
    let v = Vault::open_without_password(&root, Access::ReadOnly).unwrap();
    assert!(v.load_db().is_err(), "nothing decrypts with the wrong key");
}

/// vault.json as programs from before format 3 read it (password_slot was
/// required). They must get as far as the version number and refuse.
#[test]
fn older_programs_see_a_newer_version_instead_of_a_broken_file() {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct OldSlot {
        salt: String,
        nonce: String,
        wrapped_key: String,
    }
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct OldHeader {
        format: String,
        version: u32,
        vault_id: String,
        created_at: u64,
        kdf: KdfParams,
        password_slot: OldSlot,
        recovery_slot: OldSlot,
    }
    const OLD_FORMAT_VERSION: u32 = 2;

    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("v");
    drop(Vault::create_without_password(&root, KdfParams::TEST_ONLY).unwrap());
    let old: OldHeader = serde_json::from_slice(&fs::read(root.join(HEADER_FILE)).unwrap()).unwrap();
    assert_eq!(old.format, "media-vault");
    assert!(old.version > OLD_FORMAT_VERSION, "an older program refuses it as too new");
}
