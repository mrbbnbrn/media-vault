//! Small helpers shared by many modules.

/// Numbers for an SQL list: "1, 2, 3" (only numbers go into the SQL text).
pub fn id_list(ids: &[i64]) -> String {
    ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ")
}

/// A number for this database connection, different for every connection
/// the app ever opens (kept in a temporary table, which only this connection
/// sees and which is never saved). Work remembered for one library can then
/// never be mistaken for another's.
pub fn conn_token(conn: &rusqlite::Connection) -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    if let Ok(v) = conn.query_row("SELECT v FROM temp.mv_conn_token", [], |r| r.get::<_, i64>(0)) {
        return v as u64;
    }
    let v = NEXT.fetch_add(1, Ordering::SeqCst);
    let _ = conn.execute_batch(&format!("CREATE TEMP TABLE IF NOT EXISTS mv_conn_token(v INTEGER); DELETE FROM temp.mv_conn_token; INSERT INTO temp.mv_conn_token VALUES ({v});"));
    v
}

/// Identifies the library's contents as they are now: changes whenever
/// anything is written through this connection (every insert, update and
/// delete, including those made by triggers).
pub fn conn_state(conn: &rusqlite::Connection) -> (u64, u64) {
    let token = conn_token(conn);
    (token, conn.total_changes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_state_follows_every_change() {
        let a = rusqlite::Connection::open_in_memory().unwrap();
        let b = rusqlite::Connection::open_in_memory().unwrap();
        a.execute_batch("CREATE TABLE t(x)").unwrap();
        let s1 = conn_state(&a);
        assert_eq!(conn_state(&a), s1, "reading changes nothing");
        assert_ne!(conn_token(&a), conn_token(&b));
        a.execute("INSERT INTO t VALUES (1)", []).unwrap();
        assert_ne!(conn_state(&a), s1);
        // A temporary table never reaches the saved library.
        let names: i64 = a.query_row("SELECT COUNT(*) FROM main.sqlite_master WHERE name = 'mv_conn_token'", [], |r| r.get(0)).unwrap();
        assert_eq!(names, 0);
    }

    #[test]
    fn lists_of_numbers() {
        assert_eq!(id_list(&[]), "");
        assert_eq!(id_list(&[3, -1, 20]), "3, -1, 20");
    }
}
