//! MVTP/1: the Wi-Fi transfer protocol shared with the phone app (Baro Alarm).
//!
//! The protocol itself is `claude/transfer-protocol.md` (revision 2) in the
//! project; the test vectors are `vectors.json` next to this file. This module
//! is the pure part: crypto, packets, frames and messages. No sockets here.
//!
//! The phone is always the client, the PC (this app) always the server.
//! All integers are big-endian.

use hmac::{Hmac, KeyInit as _, Mac};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use zeroize::Zeroizing;

pub const VERSION: u8 = 1;
pub const MAGIC: &[u8; 4] = b"MVTP";
pub const TCP_PORT: u16 = 47630;
pub const UDP_PORT: u16 = 47631;
/// Largest frame body accepted (L).
pub const MAX_FRAME: u32 = 65_600;
/// Largest piece of a file in one DATA frame.
pub const MAX_DATA: usize = 65_536;
/// At most this many items in one OFFER (r2).
pub const MAX_OFFER_ITEMS: usize = 1000;
/// CANCEL ref meaning "everything".
pub const CANCEL_ALL: u32 = 0xFFFF_FFFF;

// ---- message types ---------------------------------------------------------

pub mod ty {
    pub const PAIR_DISCOVER: u8 = 0x01;
    pub const PAIR_ANSWER: u8 = 0x02;
    pub const DISCOVER: u8 = 0x10;
    pub const DISCOVER_ANSWER: u8 = 0x11;
    pub const HELLO1: u8 = 0x20;
    pub const HELLO2: u8 = 0x21;
    pub const HELLO3: u8 = 0x22;
    pub const INFO: u8 = 0x30;
    pub const BYE: u8 = 0x31;
    pub const PING: u8 = 0x32;
    pub const PONG: u8 = 0x33;
    pub const OFFER: u8 = 0x40;
    pub const ANSWER: u8 = 0x41;
    pub const ITEM_START: u8 = 0x42;
    pub const DATA: u8 = 0x43;
    pub const ITEM_END: u8 = 0x44;
    pub const ITEM_OK: u8 = 0x45;
    pub const ITEM_FAILED: u8 = 0x46;
    pub const CANCEL: u8 = 0x47;
    pub const LOCKED: u8 = 0x48;
    pub const PAIR_COMMIT: u8 = 0x50;
    pub const PAIR_PC: u8 = 0x51;
    pub const PAIR_REVEAL: u8 = 0x52;
    pub const PAIR_ID: u8 = 0x53;
    pub const PAIR_CONFIRM: u8 = 0x54;
}

/// BYE reasons.
pub mod bye {
    pub const NORMAL: u8 = 0;
    pub const LOCKED: u8 = 1;
    pub const USER_CLOSED: u8 = 2;
    pub const ERROR: u8 = 3;
}

/// ITEM_FAILED reasons.
pub mod fail {
    pub const HASH_MISMATCH: u8 = 1;
    pub const NO_SPACE: u8 = 2;
    pub const WRITE_ERROR: u8 = 3;
    pub const CANCELLED: u8 = 4;
    pub const BAD_DATA: u8 = 5;
}

// ---- errors ------------------------------------------------------------------

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    /// Anything the other side did wrong: bad signature, bad frame, wrong order…
    Protocol(&'static str),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::Protocol(w) => write!(f, "{w}"),
        }
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

fn bad(what: &'static str) -> Error {
    Error::Protocol(what)
}

// ---- small crypto helpers --------------------------------------------------

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

pub fn hmac256(key: &[u8], data: &[&[u8]]) -> [u8; 32] {
    let mut m = <Hmac<Sha256>>::new_from_slice(key).expect("HMAC takes any key length");
    for d in data {
        m.update(d);
    }
    m.finalize().into_bytes().into()
}

/// RFC 5869 HKDF-SHA256 (§2). The salt is always given.
pub fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8], out: &mut [u8]) {
    hkdf::Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, out)
        .expect("HKDF output is short");
}

pub fn hkdf32(ikm: &[u8], salt: &[u8], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut k = Zeroizing::new([0u8; 32]);
    hkdf(ikm, salt, info, &mut *k);
    k
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("operating system random number generator failed");
    b
}

/// A P-256 key pair (identity or one-time).
pub struct KeyPair {
    secret: SecretKey,
    pub public: [u8; 65],
}

impl KeyPair {
    pub fn generate() -> Self {
        loop {
            let b: Zeroizing<[u8; 32]> = Zeroizing::new(random());
            if let Ok(k) = Self::from_scalar(&b[..]) {
                return k;
            }
        }
    }

    pub fn from_scalar(d: &[u8]) -> Result<Self> {
        let secret = SecretKey::from_slice(d).map_err(|_| bad("bad private key"))?;
        let public = pub65(&secret.public_key());
        Ok(Self { secret, public })
    }

    /// The 32-byte private scalar (only for keeping it inside the vault).
    pub fn scalar(&self) -> Zeroizing<[u8; 32]> {
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&self.secret.to_bytes());
        out
    }

    /// ECDH with another public key: the 32-byte X coordinate.
    pub fn ecdh(&self, peer: &[u8; 65]) -> Result<Zeroizing<[u8; 32]>> {
        let peer = parse_pub(peer)?;
        let shared = p256::ecdh::diffie_hellman(self.secret.to_nonzero_scalar(), peer.as_affine());
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(shared.raw_secret_bytes());
        Ok(out)
    }

    /// ECDSA P-256 / SHA-256, raw r ‖ s (64 bytes).
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        let sk = SigningKey::from(&self.secret);
        let sig: Signature = sk.sign(msg);
        let mut out = [0u8; 64];
        out.copy_from_slice(&sig.to_bytes());
        out
    }
}

fn pub65(p: &PublicKey) -> [u8; 65] {
    let ep = p.to_sec1_point(false);
    let mut out = [0u8; 65];
    out.copy_from_slice(ep.as_bytes());
    out
}

/// A received public key: must be uncompressed and on the curve (§1.1, r2).
pub fn parse_pub(b: &[u8]) -> Result<PublicKey> {
    if b.len() != 65 || b[0] != 0x04 {
        return Err(bad("bad public key"));
    }
    PublicKey::from_sec1_bytes(b).map_err(|_| bad("bad public key"))
}

/// Verify a raw 64-byte signature. High s is accepted (§1.1).
pub fn verify(public: &[u8; 65], msg: &[u8], sig: &[u8]) -> bool {
    let Ok(pk) = parse_pub(public) else { return false };
    let Ok(sig) = Signature::from_slice(sig) else { return false };
    // Accept a high s too: check the normalised form (same signature, other sign).
    let sig = sig.normalize_s();
    VerifyingKey::from(&pk).verify(msg, &sig).is_ok()
}

/// Short id of a public key for the UI and for remembering (first 8 bytes of its hash, hex).
pub fn key_id(public: &[u8; 65]) -> String {
    hex::encode(&sha256(&[public])[..8])
}

// ---- derived keys (§2) -------------------------------------------------------

pub fn disc_key(pair_key: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    hkdf32(pair_key, &[0u8; 32], b"MVTP1 discovery")
}

/// 6-digit code from sas4 (§5.2).
pub fn code6(sas4: &[u8; 4]) -> String {
    format!("{:06}", u32::from_be_bytes(*sas4) % 1_000_000)
}

// ---- frames (§3) -------------------------------------------------------------

/// Write a plain frame: u32 L | type | payload.
pub fn write_plain(w: &mut impl Write, msg_type: u8, payload: &[u8]) -> io::Result<()> {
    let body_len = 1 + payload.len();
    let mut buf = Vec::with_capacity(4 + body_len);
    buf.extend_from_slice(&(body_len as u32).to_be_bytes());
    buf.push(msg_type);
    buf.extend_from_slice(payload);
    w.write_all(&buf)?;
    w.flush()
}

/// Read one frame body (plain or encrypted), checking the size limit.
pub fn read_body(r: &mut impl Read) -> Result<(u32, Vec<u8>)> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let l = u32::from_be_bytes(len);
    if l == 0 || l > MAX_FRAME {
        return Err(bad("frame too big"));
    }
    let mut body = vec![0u8; l as usize];
    r.read_exact(&mut body)?;
    Ok((l, body))
}

/// Read a plain frame of an expected type.
pub fn read_plain(r: &mut impl Read, want: u8) -> Result<Vec<u8>> {
    let (_, mut body) = read_body(r)?;
    if body[0] != want {
        return Err(bad("unexpected message"));
    }
    body.remove(0);
    Ok(body)
}

/// One direction of an encrypted connection: a key and its frame counter.
pub struct Sealer {
    key: Zeroizing<[u8; 32]>,
    counter: u64,
}

fn nonce(counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    n
}

impl Sealer {
    pub fn new(key: Zeroizing<[u8; 32]>) -> Self {
        Self { key, counter: 0 }
    }

    /// A whole encrypted frame (length prefix included).
    pub fn seal(&mut self, msg_type: u8, payload: &[u8]) -> Result<Vec<u8>> {
        if self.counter >= 1 << 32 {
            return Err(bad("too many frames"));
        }
        let l = (1 + payload.len() + 16) as u32;
        if l > MAX_FRAME {
            return Err(bad("frame too big"));
        }
        let mut plain = Zeroizing::new(Vec::with_capacity(1 + payload.len()));
        plain.push(msg_type);
        plain.extend_from_slice(payload);
        let aad = l.to_be_bytes();
        let ct = vault_core::crypto::seal(&self.key, &nonce(self.counter), &aad, &plain);
        self.counter += 1;
        let mut out = Vec::with_capacity(4 + ct.len());
        out.extend_from_slice(&aad);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Open a frame body read with [`read_body`]: (type, payload).
    pub fn open(&mut self, l: u32, body: &[u8]) -> Result<(u8, Zeroizing<Vec<u8>>)> {
        if body.len() < 17 {
            return Err(bad("frame too short"));
        }
        let plain = vault_core::crypto::open(&self.key, &nonce(self.counter), &l.to_be_bytes(), body)
            .ok_or(bad("frame failed to decrypt"))?;
        self.counter += 1;
        let plain = Zeroizing::new(plain);
        Ok((plain[0], Zeroizing::new(plain[1..].to_vec())))
    }
}

// ---- discovery (§5.1, §6) ------------------------------------------------------

fn head(t: u8) -> [u8; 6] {
    [MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], VERSION, t]
}

/// PAIR_DISCOVER → its nonce.
pub fn parse_pair_discover(p: &[u8]) -> Option<[u8; 16]> {
    (p.len() == 22 && p[..6] == head(ty::PAIR_DISCOVER)).then(|| p[6..22].try_into().unwrap())
}

pub fn pair_discover(nonce: &[u8; 16]) -> Vec<u8> {
    [&head(ty::PAIR_DISCOVER)[..], nonce].concat()
}

pub fn pair_answer(nonce: &[u8; 16], port: u16) -> Vec<u8> {
    [&head(ty::PAIR_ANSWER)[..], nonce, &port.to_be_bytes()].concat()
}

/// A DISCOVER packet (phone side, used by the tests' fake phone).
pub fn discover(disc_key: &[u8; 32], ts_ms: u64, nonce: &[u8; 16]) -> Vec<u8> {
    let body = [&head(ty::DISCOVER)[..], &ts_ms.to_be_bytes(), nonce].concat();
    let mac = hmac256(disc_key, &[&body]);
    [body, mac.to_vec()].concat()
}

/// DISCOVER parts without checking the MAC: (ts_ms, nonce, body, mac).
pub fn split_discover(p: &[u8]) -> Option<(u64, [u8; 16], &[u8], &[u8])> {
    if p.len() != 6 + 8 + 16 + 32 || p[..6] != head(ty::DISCOVER) {
        return None;
    }
    let ts = u64::from_be_bytes(p[6..14].try_into().unwrap());
    let nonce: [u8; 16] = p[14..30].try_into().unwrap();
    Some((ts, nonce, &p[..30], &p[30..]))
}

/// Does this DISCOVER's MAC match this disc_key? (constant time)
pub fn discover_matches(disc_key: &[u8; 32], body: &[u8], mac: &[u8]) -> bool {
    let mut m = <Hmac<Sha256>>::new_from_slice(disc_key).expect("any key");
    m.update(body);
    m.verify_slice(mac).is_ok()
}

pub fn discover_answer(disc_key: &[u8; 32], nonce: &[u8; 16], port: u16) -> Vec<u8> {
    let body = [&head(ty::DISCOVER_ANSWER)[..], nonce, &port.to_be_bytes()].concat();
    let mac = hmac256(disc_key, &[&body]);
    [body, mac.to_vec()].concat()
}

// ---- pairing (§5) --------------------------------------------------------------

pub fn commit(phone_eph: &[u8; 65], np: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"MVTP1 commit", phone_eph, np])
}

/// Everything both sides derive once the pairing keys are exchanged.
pub struct PairKeys {
    pub t: [u8; 32],
    pub p2c: Zeroizing<[u8; 32]>,
    pub c2p: Zeroizing<[u8; 32]>,
    pub sas4: [u8; 4],
    pub pair_key: Zeroizing<[u8; 32]>,
}

pub fn pair_keys(
    c: &[u8; 32],
    pc_eph: &[u8; 65],
    npc: &[u8; 32],
    phone_eph: &[u8; 65],
    np: &[u8; 32],
    z: &[u8; 32],
) -> PairKeys {
    let t = sha256(&[b"MVTP1 pair", c, pc_eph, npc, phone_eph, np]);
    let mut sas4 = [0u8; 4];
    hkdf(z, &t, b"MVTP1 sas", &mut sas4);
    PairKeys {
        p2c: hkdf32(z, &t, b"MVTP1 pair p2c"),
        c2p: hkdf32(z, &t, b"MVTP1 pair c2p"),
        pair_key: hkdf32(z, &t, b"MVTP1 pairkey"),
        sas4,
        t,
    }
}

/// What a PAIR_ID signature covers. role 1 = phone, 2 = PC.
pub fn pair_id_msg(role: u8, t: &[u8; 32], id_pub: &[u8; 65]) -> Vec<u8> {
    [&b"MVTP1 pair id"[..], &[role], t, id_pub].concat()
}

pub fn pair_id_payload(id: &KeyPair, role: u8, t: &[u8; 32], name: &str) -> Vec<u8> {
    let sig = id.sign(&pair_id_msg(role, t, &id.public));
    let name = trim_utf8(name, 100);
    [&id.public[..], &sig, &(name.len() as u16).to_be_bytes(), name.as_bytes()].concat()
}

/// A PAIR_ID payload, checked: (identity public key, name).
pub fn parse_pair_id(p: &[u8], role: u8, t: &[u8; 32]) -> Result<([u8; 65], String)> {
    if p.len() < 65 + 64 + 2 {
        return Err(bad("short PAIR_ID"));
    }
    let id: [u8; 65] = p[..65].try_into().unwrap();
    parse_pub(&id)?;
    let n = u16::from_be_bytes([p[129], p[130]]) as usize;
    if p.len() != 131 + n {
        return Err(bad("bad PAIR_ID length"));
    }
    if !verify(&id, &pair_id_msg(role, t, &id), &p[65..129]) {
        return Err(bad("bad PAIR_ID signature"));
    }
    let name = String::from_utf8_lossy(&p[131..]).trim().to_string();
    Ok((id, name))
}

fn trim_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ---- session handshake (§7) -----------------------------------------------------

pub fn hint(disc_key: &[u8; 32], np: &[u8; 32]) -> [u8; 8] {
    hmac256(disc_key, &[b"MVTP1 hint", np])[..8].try_into().unwrap()
}

/// HELLO1 payload parts: (phone eph, Np, hint).
pub fn parse_hello1(p: &[u8]) -> Result<([u8; 65], [u8; 32], [u8; 8])> {
    if p.len() != 1 + 65 + 32 + 8 || p[0] != VERSION {
        return Err(bad("bad HELLO1"));
    }
    let eph: [u8; 65] = p[1..66].try_into().unwrap();
    parse_pub(&eph)?;
    Ok((eph, p[66..98].try_into().unwrap(), p[98..106].try_into().unwrap()))
}

pub fn th(hello1: &[u8], pc_eph: &[u8; 65], npc: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"MVTP1 hs", hello1, pc_eph, npc])
}

pub fn th2(th: &[u8; 32], sig_pc: &[u8; 64]) -> [u8; 32] {
    sha256(&[th, sig_pc])
}

pub fn hs_pc_msg(th: &[u8; 32]) -> Vec<u8> {
    [&b"MVTP1 hs pc"[..], th].concat()
}

pub fn hs_phone_msg(th2: &[u8; 32]) -> Vec<u8> {
    [&b"MVTP1 hs phone"[..], th2].concat()
}

/// Session keys (p2c, c2p).
pub fn session_keys(z: &[u8; 32], pair_key: &[u8; 32], th2: &[u8; 32]) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
    let ikm = Zeroizing::new([&z[..], &pair_key[..]].concat());
    (hkdf32(&ikm, th2, b"MVTP1 p2c"), hkdf32(&ikm, th2, b"MVTP1 c2p"))
}

// ---- JSON messages (§8, §9) ------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Info {
    pub app: String,
    pub proto: u32,
    pub name: String,
    #[serde(default)]
    pub free: u64,
    #[serde(default)]
    pub kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OfferFolder {
    pub f: i64,
    pub parent: i64,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Mark {
    pub ms: i64,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OfferItem {
    pub i: u32,
    pub sha256: String,
    pub name: String,
    pub size: u64,
    pub kind: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub w: i64,
    #[serde(default)]
    pub h: i64,
    #[serde(default)]
    pub dur_ms: i64,
    #[serde(default)]
    pub taken: Option<i64>,
    #[serde(default)]
    pub fav: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub marks: Vec<Mark>,
    #[serde(default = "minus_one")]
    pub folder: i64,
}

fn minus_one() -> i64 {
    -1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Offer {
    pub offer: u32,
    #[serde(default = "yes")]
    pub last: bool,
    #[serde(default)]
    pub folders: Vec<OfferFolder>,
    #[serde(default)]
    pub items: Vec<OfferItem>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnswerOne {
    pub i: u32,
    pub a: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Answer {
    pub offer: u32,
    pub answers: Vec<AnswerOne>,
}

pub mod ans {
    pub const WANT: &str = "want";
    pub const HAVE: &str = "have";
    pub const CANT: &str = "cant";
    pub const NOSPACE: &str = "nospace";
}

/// Split one offer into frames that each fit (`last` false on all but the
/// final one). Folders go with the first frame that has an item using them.
pub fn offer_frames(offer: u32, folders: &[OfferFolder], items: &[OfferItem]) -> Vec<Vec<u8>> {
    // Leave room for the type byte and the tag.
    const ROOM: usize = MAX_FRAME as usize - 1 - 16;
    let mut out = Vec::new();
    let mut sent_folders = std::collections::HashSet::new();
    let mut cur_items: Vec<OfferItem> = Vec::new();
    let mut cur_folders: Vec<OfferFolder> = Vec::new();
    let by_f: std::collections::HashMap<i64, &OfferFolder> = folders.iter().map(|f| (f.f, f)).collect();
    let make = |fs: &[OfferFolder], is: &[OfferItem], last: bool| {
        serde_json::to_vec(&Offer { offer, last, folders: fs.to_vec(), items: is.to_vec() }).unwrap_or_default()
    };
    for it in items {
        // The folder path this item needs that hasn't been sent yet (parents first).
        let mut need = Vec::new();
        let mut f = it.folder;
        while f >= 0 && !sent_folders.contains(&f) && !cur_folders.iter().any(|c| c.f == f) {
            let Some(fo) = by_f.get(&f) else { break };
            need.push((*fo).clone());
            f = fo.parent;
        }
        need.reverse();
        let mut try_folders = cur_folders.clone();
        try_folders.extend(need.iter().cloned());
        let mut try_items = cur_items.clone();
        try_items.push(it.clone());
        if !cur_items.is_empty() && make(&try_folders, &try_items, false).len() > ROOM {
            out.push(make(&cur_folders, &cur_items, false));
            for f in &cur_folders {
                sent_folders.insert(f.f);
            }
            cur_items.clear();
            cur_folders.clear();
            // Recompute the path against what is now sent.
            let mut need = Vec::new();
            let mut f = it.folder;
            while f >= 0 && !sent_folders.contains(&f) {
                let Some(fo) = by_f.get(&f) else { break };
                need.push((*fo).clone());
                f = fo.parent;
            }
            need.reverse();
            cur_folders = need;
            cur_items.push(it.clone());
        } else {
            cur_folders = try_folders;
            cur_items = try_items;
        }
    }
    out.push(make(&cur_folders, &cur_items, true));
    out
}

// ---- binary payloads ---------------------------------------------------------------

pub fn item_start(r: u32, size: u64) -> Vec<u8> {
    [&r.to_be_bytes()[..], &size.to_be_bytes()].concat()
}

pub fn item_end(r: u32, sha: &[u8; 32]) -> Vec<u8> {
    [&r.to_be_bytes()[..], sha].concat()
}

pub fn ref_of(p: &[u8]) -> Option<u32> {
    p.get(..4).map(|b| u32::from_be_bytes(b.try_into().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn v() -> Value {
        serde_json::from_str(include_str!("vectors.json")).unwrap()
    }

    fn h(s: &Value) -> Vec<u8> {
        hex::decode(s.as_str().unwrap()).unwrap()
    }

    fn a<const N: usize>(s: &Value) -> [u8; N] {
        h(s).try_into().unwrap()
    }

    fn key(v: &Value, name: &str) -> KeyPair {
        KeyPair::from_scalar(&h(&v["keys"][name]["priv_scalar"])).unwrap()
    }

    #[test]
    fn hkdf_vector() {
        let v = v();
        let x = &v["hkdf"];
        let mut out = vec![0u8; 42];
        hkdf(&h(&x["ikm"]), &h(&x["salt"]), x["info_utf8"].as_str().unwrap().as_bytes(), &mut out);
        assert_eq!(out, h(&x["okm"]));
    }

    #[test]
    fn keys_vector() {
        let v = v();
        for name in [
            "phone_identity_priv",
            "pc_identity_priv",
            "phone_pair_eph_priv",
            "pc_pair_eph_priv",
            "phone_session_eph_priv",
            "pc_session_eph_priv",
        ] {
            assert_eq!(key(&v, name).public.to_vec(), h(&v["keys"][name]["pub65"]), "{name}");
        }
    }

    #[test]
    fn pairing_vector() {
        let v = v();
        let p = &v["pairing"];
        let np: [u8; 32] = a(&p["inputs"]["Np"]);
        let npc: [u8; 32] = a(&p["inputs"]["Npc"]);
        let pe = key(&v, "phone_pair_eph_priv");
        let ce = key(&v, "pc_pair_eph_priv");
        let c = commit(&pe.public, &np);
        assert_eq!(c.to_vec(), h(&p["C"]));
        // The three plain frames.
        let mut buf = Vec::new();
        write_plain(&mut buf, ty::PAIR_COMMIT, &[&[VERSION][..], &c].concat()).unwrap();
        assert_eq!(buf, h(&p["frame_PAIR_COMMIT"]));
        buf.clear();
        write_plain(&mut buf, ty::PAIR_PC, &[&ce.public[..], &npc].concat()).unwrap();
        assert_eq!(buf, h(&p["frame_PAIR_PC"]));
        buf.clear();
        write_plain(&mut buf, ty::PAIR_REVEAL, &[&pe.public[..], &np].concat()).unwrap();
        assert_eq!(buf, h(&p["frame_PAIR_REVEAL"]));
        let z = ce.ecdh(&pe.public).unwrap();
        assert_eq!(z.to_vec(), h(&p["Z"]));
        assert_eq!(*pe.ecdh(&ce.public).unwrap(), *z);
        let k = pair_keys(&c, &ce.public, &npc, &pe.public, &np, &z);
        assert_eq!(k.t.to_vec(), h(&p["T"]));
        assert_eq!(k.p2c.to_vec(), h(&p["k_pair_p2c"]));
        assert_eq!(k.c2p.to_vec(), h(&p["k_pair_c2p"]));
        assert_eq!(k.sas4.to_vec(), h(&p["sas4"]));
        assert_eq!(code6(&k.sas4), "199921");
        assert_eq!(code6(&k.sas4), p["code6"].as_str().unwrap());
        assert_eq!(k.pair_key.to_vec(), h(&p["pair_key"]));
        // Identities: our deterministic (RFC 6979) signatures match the vectors exactly.
        let phone_id = key(&v, "phone_identity_priv");
        let pc_id = key(&v, "pc_identity_priv");
        assert_eq!(pair_id_msg(1, &k.t, &phone_id.public), h(&p["sig_input_phone"]));
        assert_eq!(pair_id_msg(2, &k.t, &pc_id.public), h(&p["sig_input_pc"]));
        assert!(verify(&phone_id.public, &h(&p["sig_input_phone"]), &h(&p["sig_phone_raw64"])));
        assert!(verify(&pc_id.public, &h(&p["sig_input_pc"]), &h(&p["sig_pc_raw64"])));
        assert_eq!(pc_id.sign(&h(&p["sig_input_pc"])).to_vec(), h(&p["sig_pc_raw64"]));
        // The encrypted PAIR_ID frames.
        let mut s = Sealer::new(k.c2p.clone());
        let f = s.seal(ty::PAIR_ID, &pair_id_payload(&pc_id, 2, &k.t, "Media Vault PC")).unwrap();
        assert_eq!(f, h(&p["frame_PAIR_ID_pc_ctr0"]));
        let phone_frame = h(&p["frame_PAIR_ID_phone_ctr0"]);
        let mut r = &phone_frame[..];
        let (l, body) = read_body(&mut r).unwrap();
        let mut o = Sealer::new(k.p2c.clone());
        let (t, payload) = o.open(l, &body).unwrap();
        assert_eq!(t, ty::PAIR_ID);
        let (id, name) = parse_pair_id(&payload, 1, &k.t).unwrap();
        assert_eq!(id, phone_id.public);
        assert_eq!(name, "Telefon");
        // A wrong role fails.
        assert!(parse_pair_id(&payload, 2, &k.t).is_err());
        let conf = h(&p["frame_PAIR_CONFIRM_yes_phone_ctr1"]);
        let mut r = &conf[..];
        let (l, body) = read_body(&mut r).unwrap();
        let (t, payload) = o.open(l, &body).unwrap();
        assert_eq!((t, payload.as_slice()), (ty::PAIR_CONFIRM, &[1u8][..]));
    }

    #[test]
    fn discovery_vector() {
        let v = v();
        let d = &v["discovery"];
        let pk: [u8; 32] = a(&d["pair_key"]);
        let dk = disc_key(&pk);
        assert_eq!(dk.to_vec(), h(&d["disc_key"]));
        let nonce: [u8; 16] = a(&d["nonce"]);
        let ts = d["ts_ms"].as_u64().unwrap();
        let pkt = discover(&dk, ts, &nonce);
        assert_eq!(pkt, h(&d["DISCOVER_packet"]));
        let (t2, n2, body, mac) = split_discover(&pkt).unwrap();
        assert_eq!((t2, n2), (ts, nonce));
        assert!(discover_matches(&dk, body, mac));
        assert!(!discover_matches(&[9u8; 32], body, mac));
        assert_eq!(discover_answer(&dk, &nonce, 47630), h(&d["DISCOVER_ANSWER_packet"]));
        let pn: [u8; 16] = a(&d["pairing_nonce"]);
        assert_eq!(pair_discover(&pn), h(&d["PAIR_DISCOVER_packet"]));
        assert_eq!(parse_pair_discover(&h(&d["PAIR_DISCOVER_packet"])), Some(pn));
        assert_eq!(pair_answer(&pn, 47630), h(&d["PAIR_ANSWER_packet"]));
    }

    #[test]
    fn session_vector() {
        let v = v();
        let s = &v["session"];
        let pk: [u8; 32] = a(&s["inputs"]["pair_key"]);
        let dk = disc_key(&pk);
        let np: [u8; 32] = a(&s["inputs"]["Np"]);
        let npc: [u8; 32] = a(&s["inputs"]["Npc"]);
        let pe = key(&v, "phone_session_eph_priv");
        let ce = key(&v, "pc_session_eph_priv");
        let hn = hint(&dk, &np);
        assert_eq!(hn.to_vec(), h(&s["hint"]));
        let hello1 = [&[VERSION][..], &pe.public, &np, &hn].concat();
        let mut buf = Vec::new();
        write_plain(&mut buf, ty::HELLO1, &hello1).unwrap();
        assert_eq!(buf, h(&s["frame_HELLO1"]));
        let (e2, n2, h2) = parse_hello1(&hello1).unwrap();
        assert_eq!((e2, n2, h2), (pe.public, np, hn));
        let t = th(&hello1, &ce.public, &npc);
        assert_eq!(t.to_vec(), h(&s["TH"]));
        let pc_id = key(&v, "pc_identity_priv");
        let phone_id = key(&v, "phone_identity_priv");
        let sig_pc = pc_id.sign(&hs_pc_msg(&t));
        assert_eq!(sig_pc.to_vec(), h(&s["sig_pc_raw64"]));
        buf.clear();
        write_plain(&mut buf, ty::HELLO2, &[&ce.public[..], &npc, &sig_pc].concat()).unwrap();
        assert_eq!(buf, h(&s["frame_HELLO2"]));
        let t2 = th2(&t, &sig_pc);
        assert_eq!(t2.to_vec(), h(&s["TH2"]));
        let sig_phone: [u8; 64] = a(&s["sig_phone_raw64"]);
        assert!(verify(&phone_id.public, &hs_phone_msg(&t2), &sig_phone));
        assert!(!verify(&pc_id.public, &hs_phone_msg(&t2), &sig_phone));
        buf.clear();
        write_plain(&mut buf, ty::HELLO3, &sig_phone).unwrap();
        assert_eq!(buf, h(&s["frame_HELLO3"]));
        let z = ce.ecdh(&pe.public).unwrap();
        assert_eq!(z.to_vec(), h(&s["Z"]));
        let (p2c, c2p) = session_keys(&z, &pk, &t2);
        assert_eq!(p2c.to_vec(), h(&s["k_p2c"]));
        assert_eq!(c2p.to_vec(), h(&s["k_c2p"]));
    }

    #[test]
    fn frames_vector() {
        let v = v();
        let s = &v["session"];
        let f = &v["frames"];
        let p2c: [u8; 32] = a(&s["k_p2c"]);
        let c2p: [u8; 32] = a(&s["k_c2p"]);
        // Phone frames: open them.
        let mut o = Sealer::new(Zeroizing::new(p2c));
        for (name, ty_) in [("HELLO_INFO_phone_ctr0", ty::INFO), ("PING_phone_ctr1", ty::PING)] {
            let fr = h(&f[name]["frame"]);
            let mut r = &fr[..];
            let (l, body) = read_body(&mut r).unwrap();
            let (t, payload) = o.open(l, &body).unwrap();
            assert_eq!(t, ty_);
            if ty_ == ty::INFO {
                let info: Info = serde_json::from_slice(&payload).unwrap();
                assert_eq!(info.app, "baroalarm");
                assert_eq!(info.free, 12345678901);
            }
        }
        // PC frames: seal them at counters 7 and 8.
        let mut sl = Sealer::new(Zeroizing::new(c2p));
        sl.counter = 7;
        assert_eq!(sl.seal(ty::DATA, &h(&f["DATA_pc_ctr7"]["payload"])).unwrap(), h(&f["DATA_pc_ctr7"]["frame"]));
        assert_eq!(sl.seal(ty::ITEM_END, &h(&f["ITEM_END_pc_ctr8"]["payload"])).unwrap(), h(&f["ITEM_END_pc_ctr8"]["frame"]));
        // Tampering: one flipped bit, or the wrong counter, fails.
        let fr = h(&f["DATA_pc_ctr7"]["frame"]);
        for i in 0..fr.len() {
            let mut bad = fr.clone();
            bad[i] ^= 1;
            let mut r = &bad[..];
            if let Ok((l, body)) = read_body(&mut r) {
                let mut o = Sealer::new(Zeroizing::new(c2p));
                o.counter = 7;
                assert!(o.open(l, &body).is_err(), "byte {i}");
            }
        }
        let mut r = &fr[..];
        let (l, body) = read_body(&mut r).unwrap();
        let mut o = Sealer::new(Zeroizing::new(c2p));
        o.counter = 8;
        assert!(o.open(l, &body).is_err());
    }

    #[test]
    fn json_examples_parse() {
        let v = v();
        let o: Offer = serde_json::from_value(v["json_examples"]["OFFER"].clone()).unwrap();
        assert_eq!(o.items[0].folder, 1);
        assert_eq!(o.folders[1].parent, 0);
        assert_eq!(o.items[0].taken, Some(1751371200000));
        let a: Answer = serde_json::from_value(v["json_examples"]["ANSWER"].clone()).unwrap();
        assert_eq!(a.answers[0].a, ans::WANT);
        // taken null and a missing folder are fine.
        let o: Offer = serde_json::from_str(r#"{"offer":2,"items":[{"i":1,"sha256":"00","name":"a.jpg","size":1,"kind":"image","taken":null}]}"#).unwrap();
        assert_eq!((o.items[0].taken, o.items[0].folder, o.last), (None, -1, true));
    }

    #[test]
    fn bad_keys_rejected() {
        let mut k = key(&v(), "pc_identity_priv").public;
        assert!(parse_pub(&k).is_ok());
        k[64] ^= 1; // off the curve
        assert!(parse_pub(&k).is_err());
        let mut c = key(&v(), "pc_identity_priv").public;
        c[0] = 0x02;
        assert!(parse_pub(&c).is_err());
    }

    #[test]
    fn high_s_accepted() {
        let k = KeyPair::generate();
        let msg = b"hello";
        let sig = k.sign(msg);
        // Flip s to n - s: still a valid signature.
        let s = Signature::from_slice(&sig).unwrap();
        let (r, s_) = s.split_scalars();
        let high = Signature::from_scalars(r, -*s_.as_ref()).unwrap();
        let mut raw = [0u8; 64];
        raw.copy_from_slice(&high.to_bytes());
        assert!(verify(&k.public, msg, &sig));
        assert!(verify(&k.public, msg, &raw));
    }

    #[test]
    fn big_offers_split_to_fit() {
        let folders: Vec<OfferFolder> = (0..50)
            .map(|f| OfferFolder { f, parent: if f == 0 { -1 } else { f - 1 }, name: format!("Folder {f} ").repeat(5), tags: vec!["x".into()] })
            .collect();
        let items: Vec<OfferItem> = (0..1000u32)
            .map(|i| OfferItem {
                i,
                sha256: "ab".repeat(32),
                name: format!("A rather long file name number {i}.jpg"),
                size: 1234,
                kind: "image".into(),
                mime: "image/jpeg".into(),
                w: 100,
                h: 100,
                dur_ms: 0,
                taken: Some(1),
                fav: false,
                tags: vec!["one".into(), "two".into()],
                marks: vec![],
                folder: (i % 50) as i64,
            })
            .collect();
        let frames = offer_frames(9, &folders, &items);
        assert!(frames.len() > 1);
        let mut seen_items = 0;
        let mut known = std::collections::HashSet::new();
        for (k, f) in frames.iter().enumerate() {
            assert!(f.len() <= MAX_FRAME as usize - 17);
            let o: Offer = serde_json::from_slice(f).unwrap();
            assert_eq!(o.last, k + 1 == frames.len());
            for fo in &o.folders {
                assert!(fo.parent < 0 || known.contains(&fo.parent), "parent first");
                known.insert(fo.f);
            }
            for it in &o.items {
                assert!(known.contains(&it.folder), "item's folder known");
            }
            seen_items += o.items.len();
        }
        assert_eq!(seen_items, 1000);
    }
}
