//! What the transfer remembers, kept only inside the vault's own (encrypted)
//! library: this vault's identity key, the paired phones and the landing
//! folder. Nothing about pairing is visible while the vault is locked.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::mvtp::{self, KeyPair};

const K_IDENTITY: &str = "transfer.identity";
const K_PEERS: &str = "transfer.peers";
const K_LANDING: &str = "transfer.landing";

/// One paired phone.
#[derive(Clone, Serialize, Deserialize)]
pub struct Peer {
    /// Its identity public key (65 bytes, hex).
    pub key: String,
    pub name: String,
    /// The shared pairing secret (32 bytes, hex).
    pub pair_key: String,
    pub paired_at: i64,
}

impl Peer {
    pub fn public(&self) -> Option<[u8; 65]> {
        hex::decode(&self.key).ok()?.try_into().ok()
    }

    pub fn pair_key(&self) -> Option<Zeroizing<[u8; 32]>> {
        let v = Zeroizing::new(hex::decode(&self.pair_key).ok()?);
        let mut k = Zeroizing::new([0u8; 32]);
        if v.len() != 32 {
            return None;
        }
        k.copy_from_slice(&v);
        Some(k)
    }

    /// Short id shown to the window.
    pub fn id(&self) -> String {
        self.public().map(|p| mvtp::key_id(&p)).unwrap_or_default()
    }
}

fn get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

fn put(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// This vault's identity, if it has paired before.
pub fn identity(conn: &Connection) -> Option<KeyPair> {
    let h = Zeroizing::new(get(conn, K_IDENTITY)?);
    let b = Zeroizing::new(hex::decode(h.as_str()).ok()?);
    KeyPair::from_scalar(&b).ok()
}

/// This vault's identity, made (and kept) the first time it is needed.
pub fn identity_or_new(conn: &Connection) -> Result<KeyPair, String> {
    if let Some(k) = identity(conn) {
        return Ok(k);
    }
    let k = KeyPair::generate();
    put(conn, K_IDENTITY, &hex::encode(*k.scalar()))?;
    Ok(k)
}

pub fn peers(conn: &Connection) -> Vec<Peer> {
    get(conn, K_PEERS)
        .and_then(|j| serde_json::from_str::<Vec<Peer>>(&j).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.public().is_some() && p.pair_key().is_some())
        .collect()
}

fn save_peers(conn: &Connection, peers: &[Peer]) -> Result<(), String> {
    put(conn, K_PEERS, &serde_json::to_string(peers).map_err(|e| e.to_string())?)
}

/// Add a paired phone; one already known by the same key is replaced (r2).
pub fn add_peer(conn: &Connection, p: Peer) -> Result<(), String> {
    let mut all = peers(conn);
    all.retain(|o| o.key != p.key);
    all.push(p);
    save_peers(conn, &all)
}

/// Forget a paired phone by its short id. True if one was removed.
pub fn forget(conn: &Connection, id: &str) -> Result<bool, String> {
    let mut all = peers(conn);
    let before = all.len();
    all.retain(|p| p.id() != id);
    let removed = all.len() != before;
    if removed {
        save_peers(conn, &all)?;
    }
    Ok(removed)
}

/// The "Received from phone" folder: the one remembered (even if renamed),
/// else found or made at the top level.
pub fn landing_folder(conn: &Connection) -> Result<i64, String> {
    if let Some(id) = get(conn, K_LANDING).and_then(|v| v.parse::<i64>().ok()) {
        let live = conn
            .query_row("SELECT 1 FROM folders WHERE id = ? AND deleted_at IS NULL", [id], |_| Ok(()))
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if live {
            return Ok(id);
        }
    }
    let id = crate::library::get_or_create_folder(conn, None, "Received from phone")?;
    put(conn, K_LANDING, &id.to_string())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        vault_core::db::create_empty().unwrap()
    }

    #[test]
    fn identity_is_kept() {
        let c = db();
        assert!(identity(&c).is_none());
        let a = identity_or_new(&c).unwrap();
        let b = identity_or_new(&c).unwrap();
        assert_eq!(a.public, b.public);
    }

    #[test]
    fn re_pairing_replaces() {
        let c = db();
        let k = KeyPair::generate();
        let p = |name: &str, pk: u8| Peer {
            key: hex::encode(k.public),
            name: name.into(),
            pair_key: hex::encode([pk; 32]),
            paired_at: 1,
        };
        add_peer(&c, p("Telefon", 1)).unwrap();
        add_peer(&c, p("Telefon 2", 2)).unwrap();
        let all = peers(&c);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Telefon 2");
        assert_eq!(*all[0].pair_key().unwrap(), [2u8; 32]);
        assert!(forget(&c, &all[0].id()).unwrap());
        assert!(peers(&c).is_empty());
    }

    #[test]
    fn landing_survives_rename_and_comes_back_when_deleted() {
        let c = db();
        let a = landing_folder(&c).unwrap();
        c.execute("UPDATE folders SET name = 'Phone stuff' WHERE id = ?", [a]).unwrap();
        assert_eq!(landing_folder(&c).unwrap(), a);
        c.execute("UPDATE folders SET deleted_at = 5 WHERE id = ?", [a]).unwrap();
        let b = landing_folder(&c).unwrap();
        assert_ne!(a, b);
    }
}
