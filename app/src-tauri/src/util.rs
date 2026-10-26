//! Small helpers shared by many modules.

use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// A library error as the window shows it.
pub fn sql_err(err: rusqlite::Error) -> String {
    format!("Library error: {err}")
}

/// Seconds since 1970 (UTC).
pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Milliseconds since 1970 (UTC).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// "?,?,?": `n` placeholders for an SQL list.
pub fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// A background loop's rest that something can cut short ("there is new
/// work"): `sleep` waits up to the time given or until `wake`, whichever
/// comes first; a wake while it wasn't sleeping cuts the next rest short.
pub struct Wake {
    woken: Mutex<bool>,
    cv: Condvar,
}

impl Wake {
    pub const fn new() -> Self {
        Self { woken: Mutex::new(false), cv: Condvar::new() }
    }

    pub fn wake(&self) {
        *self.woken.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.cv.notify_all();
    }

    pub fn sleep(&self, ms: u64) {
        let g = self.woken.lock().unwrap_or_else(|e| e.into_inner());
        let (mut g, _) = self.cv.wait_timeout_while(g, Duration::from_millis(ms), |woken| !*woken).unwrap_or_else(|e| e.into_inner());
        *g = false;
    }
}

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
    fn a_wake_cuts_the_rest_short() {
        static W: Wake = Wake::new();
        let t = std::time::Instant::now();
        W.wake();
        W.sleep(10_000);
        assert!(t.elapsed() < Duration::from_secs(5), "woken before it slept");
        let t = std::time::Instant::now();
        W.sleep(30);
        assert!(t.elapsed() >= Duration::from_millis(25), "not woken: the whole rest");
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(50));
            W.wake();
        });
        let t = std::time::Instant::now();
        W.sleep(10_000);
        assert!(t.elapsed() < Duration::from_secs(5));
        assert_eq!(placeholders(3), "?,?,?");
        assert!(now_ms() / 1000 - now_secs() <= 1);
    }

    #[test]
    fn lists_of_numbers() {
        assert_eq!(id_list(&[]), "");
        assert_eq!(id_list(&[3, -1, 20]), "3, -1, 20");
    }
}
