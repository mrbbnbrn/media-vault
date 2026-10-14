//! Tests for the folder fields the sidebar sorts by (size, date made) and for
//! where new folders land in your own order.

use rusqlite::params;
use vault_core::db;

use crate::library::{all_folders, create_folder};
use crate::organize::set_order;

fn add(c: &rusqlite::Connection, folder: i64, size: i64) {
    c.execute(
        "INSERT INTO media(object_id, folder_id, kind, original_name, ext, size, sha256, imported_at) \
         VALUES (lower(hex(randomblob(16))), ?1, 'image', 'p.jpg', 'jpg', ?2, 'h', 0)",
        params![folder, size],
    )
    .unwrap();
}

#[test]
fn sizes_add_up_and_dates_are_kept() {
    let c = db::create_empty().unwrap();
    let a = create_folder(&c, None, "A").unwrap();
    let b = create_folder(&c, Some(a), "B").unwrap();
    add(&c, a, 100);
    add(&c, b, 50);
    add(&c, b, 25);
    let f = all_folders(&c).unwrap();
    assert_eq!(f.iter().map(|x| (x.name.as_str(), x.bytes)).collect::<Vec<_>>(), vec![("A", 175), ("B", 75)]);
    assert!(f[0].created_at > 1_600_000_000);
}

#[test]
fn new_folders_go_to_the_end_of_their_level() {
    let c = db::create_empty().unwrap();
    let z = create_folder(&c, None, "Zebra").unwrap();
    let m = create_folder(&c, None, "Mango").unwrap();
    // Your own order: Mango before Zebra.
    set_order(&c, &[m, z]).unwrap();
    create_folder(&c, None, "Apple").unwrap();
    create_folder(&c, Some(z), "Kid").unwrap();
    create_folder(&c, Some(z), "Aaa").unwrap();
    let names: Vec<String> = all_folders(&c).unwrap().into_iter().map(|f| f.name).collect();
    assert_eq!(names, ["Mango", "Zebra", "Kid", "Aaa", "Apple"]);
}
