//! Login history: when the vault was last opened (and on which PC), and how
//! many wrong passwords were tried since.
//!
//! Failed attempts can't go into the encrypted library (the key isn't known
//! yet), so they are counted in a small plain file in the vault folder,
//! `attempts.json`, holding only times. Successful unlocks are kept inside
//! the encrypted library.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::session::Session;

const ATTEMPTS_FILE: &str = "attempts.json";
const KEEP: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// Seconds since 1970.
    pub at: i64,
    pub computer: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginInfo {
    /// The previous time the vault was opened (none the first time).
    pub last: Option<Opened>,
    /// Wrong passwords or recovery words tried since then.
    pub failed: Vec<i64>,
}

#[derive(Default, Serialize, Deserialize)]
struct Attempts {
    failed: Vec<i64>,
}

pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "this PC".into())
}

fn read_attempts(vault: &Path) -> Attempts {
    std::fs::read(vault.join(ATTEMPTS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_attempts(vault: &Path, a: &Attempts) {
    let tmp = vault.join(format!("{ATTEMPTS_FILE}.tmp"));
    if let Ok(json) = serde_json::to_vec(a)
        && std::fs::write(&tmp, json).is_ok()
    {
        let _ = std::fs::rename(&tmp, vault.join(ATTEMPTS_FILE));
    }
}

/// Note a wrong password or wrong recovery words (best effort).
pub fn record_failure(vault: &Path) {
    if !vault_core::is_vault(vault) {
        return;
    }
    let mut a = read_attempts(vault);
    a.failed.push(crate::library::now_secs());
    let n = a.failed.len();
    if n > KEEP {
        a.failed.drain(..n - KEEP);
    }
    write_attempts(vault, &a);
}

/// After a successful unlock: what to tell the user, then start a fresh count.
pub fn on_unlock(s: &Session) -> LoginInfo {
    let root = s.vault().root().to_path_buf();
    let history: Vec<Opened> = s
        .db()
        .query_row("SELECT value FROM settings WHERE key = 'unlock_history'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default();
    let last = history.last().cloned();
    let since = last.as_ref().map(|l| l.at).unwrap_or(0);
    let failed: Vec<i64> = read_attempts(&root).failed.into_iter().filter(|t| *t >= since).collect();
    write_attempts(&root, &Attempts::default());

    let mut history = history;
    history.push(Opened { at: crate::library::now_secs(), computer: computer_name() });
    let n = history.len();
    if n > 20 {
        history.drain(..n - 20);
    }
    if let Ok(json) = serde_json::to_string(&history) {
        let _ = s.db().execute(
            "INSERT INTO settings(key, value) VALUES ('unlock_history', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [json],
        );
        s.mark_dirty();
    }
    LoginInfo { last, failed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session;

    #[test]
    fn counts_wrong_passwords_between_unlocks() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        let root = s.vault().root().to_path_buf();
        let first = on_unlock(&s);
        assert!(first.last.is_none());
        assert!(first.failed.is_empty());
        s.save().unwrap();
        drop(s);

        record_failure(&root);
        record_failure(&root);
        record_failure(&t.path().join("not a vault")); // ignored
        let s = session::unlock(root.to_str().unwrap(), "long enough pw").unwrap();
        let info = on_unlock(&s);
        assert!(info.last.is_some());
        assert_eq!(info.failed.len(), 2);
        // The count starts again.
        assert!(on_unlock(&s).failed.is_empty());
    }
}
