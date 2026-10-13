use std::fs;
use std::io::{Read, Seek, SeekFrom};

use vault_core::multipart::{MultiPartReader, find_parts};

#[test]
fn reads_and_seeks_across_parts() {
    let t = tempfile::tempdir().unwrap();
    let data: Vec<u8> = (0..250_000u32).map(|i| (i * 7 + i / 13) as u8).collect();
    for (i, c) in data.chunks(100_000).enumerate() {
        fs::write(t.path().join(format!("a.7z.{:03}", i + 1)), c).unwrap();
    }
    fs::write(t.path().join("a.7z.005"), b"not contiguous").unwrap(); // gap after .003

    // Starting from any part finds the whole set, in order.
    let parts = find_parts(&t.path().join("a.7z.002")).unwrap().unwrap();
    assert_eq!(parts.len(), 3);

    let mut r = MultiPartReader::open(&parts).unwrap();
    assert_eq!(r.len(), data.len() as u64);
    let mut all = Vec::new();
    r.read_to_end(&mut all).unwrap();
    assert_eq!(all, data);

    for &p in &[0u64, 99_999, 100_000, 150_000, 199_990, 249_999] {
        r.seek(SeekFrom::Start(p)).unwrap();
        let mut b = vec![0u8; 30];
        let n = r.read(&mut b).unwrap();
        assert!(n > 0);
        assert_eq!(&b[..n], &data[p as usize..p as usize + n]);
    }
}

#[test]
fn non_split_files_and_missing_first_part() {
    let t = tempfile::tempdir().unwrap();
    fs::write(t.path().join("plain.7z"), b"x").unwrap();
    assert!(find_parts(&t.path().join("plain.7z")).unwrap().is_none());
    fs::write(t.path().join("b.7z.002"), b"x").unwrap();
    assert!(find_parts(&t.path().join("b.7z.002")).is_err());
}
