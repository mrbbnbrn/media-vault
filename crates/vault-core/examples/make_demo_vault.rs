//! Developer helper: create a small demo vault for trying the export tool.
//! cargo run --example make_demo_vault -- <folder> <password>
use vault_core::{KdfParams, ObjectKind, Vault, db};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (v, phrase) = Vault::create(a[1].as_ref(), &a[2], KdfParams::STANDARD).unwrap();
    let conn = db::create_empty().unwrap();
    conn.execute("INSERT INTO folders(name, created_at) VALUES ('People', 0)", []).unwrap();
    conn.execute("INSERT INTO folders(parent_id, name, created_at) VALUES (1, 'Alex', 0)", []).unwrap();
    for (name, folder, body) in [("hello.txt", Some(2), b"hello from the vault".to_vec()), ("big.bin", Some(1), vec![7u8; 3_000_000]), ("top.jpg", None, b"jpeg".to_vec())] {
        let (id, w) = v.add_object(ObjectKind::Media, &body[..]).unwrap();
        conn.execute(
            "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at) VALUES (?1, ?2, 'image', ?3, 'x', ?4, ?5, 0)",
            rusqlite::params![id.to_hex(), folder, name, w.plaintext_len as i64, w.sha256_hex],
        ).unwrap();
    }
    v.save_db(&db::serialize(&conn).unwrap()).unwrap();
    println!("{}", phrase.as_str());
}
