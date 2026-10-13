//! Small, boring wrappers around the standard primitives the vault uses:
//! AES-256-GCM, Argon2id, HKDF-SHA256 and SHA-256.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Error, Result};

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;

/// A 256-bit secret key. Wiped from memory when dropped.
pub type Key = Zeroizing<[u8; KEY_LEN]>;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("operating system random number generator failed");
    out
}

pub fn random_key() -> Key {
    Zeroizing::new(random_bytes::<KEY_LEN>())
}

fn cipher(key: &[u8; KEY_LEN]) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(key).expect("key is 32 bytes")
}

/// AES-256-GCM encrypt. Output is ciphertext followed by the 16-byte tag.
pub fn seal(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    cipher(key)
        .encrypt(&Nonce::from(*nonce), Payload { msg: plaintext, aad })
        .expect("AES-GCM encryption cannot fail for these sizes")
}

/// AES-256-GCM decrypt and authenticate. Fails if anything was changed.
pub fn open(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], aad: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
    cipher(key)
        .decrypt(&Nonce::from(*nonce), Payload { msg: ciphertext, aad })
        .ok()
}

/// Encrypt one key under another ("key wrapping").
pub fn wrap_key(kek: &[u8; KEY_LEN], key: &[u8; KEY_LEN], aad: &[u8]) -> ([u8; NONCE_LEN], [u8; KEY_LEN + TAG_LEN]) {
    let nonce = random_bytes::<NONCE_LEN>();
    let ct = seal(kek, &nonce, aad, key);
    (nonce, ct.try_into().expect("48 bytes"))
}

pub fn unwrap_key(kek: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], wrapped: &[u8], aad: &[u8]) -> Option<Key> {
    let pt = Zeroizing::new(open(kek, nonce, aad, wrapped)?);
    let arr: [u8; KEY_LEN] = pt.as_slice().try_into().ok()?;
    Some(Zeroizing::new(arr))
}

/// Argon2id settings, stored in vault.json so they can be raised later
/// without breaking existing vaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub alg: KdfAlg,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KdfAlg {
    Argon2id,
}

impl KdfParams {
    /// Default for real vaults: 256 MiB, 3 passes. Roughly 1 second on a
    /// typical desktop, and very expensive to run billions of times.
    pub const STANDARD: KdfParams = KdfParams {
        alg: KdfAlg::Argon2id,
        memory_kib: 256 * 1024,
        iterations: 3,
        parallelism: 4,
    };

    /// Cheap settings for automated tests only.
    pub const TEST_ONLY: KdfParams = KdfParams {
        alg: KdfAlg::Argon2id,
        memory_kib: 8 * 1024,
        iterations: 1,
        parallelism: 1,
    };
}

pub fn derive_password_key(password: &str, salt: &[u8], p: &KdfParams) -> Result<Key> {
    let params = argon2::Params::new(p.memory_kib, p.iterations, p.parallelism, Some(KEY_LEN))
        .map_err(|e| Error::Invalid(format!("Argon2 parameters: {e}")))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| Error::Invalid(format!("Argon2: {e}")))?;
    Ok(out)
}

/// The recovery key is already 256 random bits, so no slow hashing is
/// needed; HKDF just turns it into a key-wrapping key.
pub fn derive_recovery_key(recovery_entropy: &[u8; KEY_LEN], salt: &[u8]) -> Key {
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), recovery_entropy);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    hk.expand(b"media-vault/v1/recovery-kek", out.as_mut())
        .expect("32 bytes is a valid HKDF output length");
    out
}

/// Turn 32 random bytes into 24 English words (BIP-39 word list).
pub fn entropy_to_words(entropy: &[u8; KEY_LEN]) -> String {
    let m = bip39::Mnemonic::from_entropy(entropy).expect("32 bytes is valid BIP-39 entropy");
    m.words().collect::<Vec<_>>().join(" ")
}

/// Parse 24 words back into 32 bytes. Tolerates extra spaces, line breaks,
/// numbering ("1. abandon") and capital letters.
pub fn words_to_entropy(phrase: &str) -> Result<Key> {
    let cleaned: Vec<String> = phrase
        .split_whitespace()
        .filter_map(|w| {
            let w = w.trim_matches(|c: char| !c.is_ascii_alphabetic()).to_ascii_lowercase();
            (!w.is_empty()).then_some(w)
        })
        .collect();
    if cleaned.len() != 24 {
        return Err(Error::BadRecoveryPhrase(format!("expected 24 words, got {}", cleaned.len())));
    }
    let m = bip39::Mnemonic::parse_normalized(&cleaned.join(" "))
        .map_err(|e| Error::BadRecoveryPhrase(e.to_string()))?;
    let ent = Zeroizing::new(m.to_entropy());
    let arr: [u8; KEY_LEN] = ent
        .as_slice()
        .try_into()
        .map_err(|_| Error::BadRecoveryPhrase("not a 24-word phrase".into()))?;
    Ok(Zeroizing::new(arr))
}
