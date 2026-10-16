//! A vault on disk: header, keys, encrypted objects and the encrypted database.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::crypto::{self, KEY_LEN, KdfParams, Key, NONCE_LEN};
use crate::error::{Error, Result};
use crate::pack::{self, CompactPlan, IndexChange, Location, PackStore, PackUsage, Slice};
use crate::stream::{
    DEFAULT_CHUNK_LOG2, ObjectId, ObjectKind, ObjectReader, ObjectWriter, WrittenObject,
};

pub const FORMAT_NAME: &str = "media-vault";
/// The newest format this program reads.
/// 1 = one file per object (media/, thumbs/); 2 = pack files (packs/);
/// 3 = like 2, but the vault may have no password (an `open_slot`).
/// Version 3 programs read all three. A vault only says 3 while it has no
/// password, so older programs refuse it with "made by a newer version"
/// instead of misreading it.
pub const FORMAT_VERSION: u32 = 3;
/// What new vaults with a password are marked as.
pub const PACKED_VERSION: u32 = 2;
/// What a vault without a password is marked as.
pub const NO_PASSWORD_VERSION: u32 = 3;
/// Text stored next to the unprotected master key in vault.json.
pub const OPEN_SLOT_WARNING: &str = "This vault has no password. This is its master key, NOT encrypted: anyone who has this folder can open the vault.";
pub const HEADER_FILE: &str = "vault.json";
pub const HEADER_BACKUP_FILE: &str = "vault.json.bak";
pub const DB_FILE: &str = "meta.db.enc";
pub const BACKUP_DIR: &str = "meta-backups";
pub const MEDIA_DIR: &str = "media";
pub const THUMB_DIR: &str = "thumbs";
pub const FORMAT_DOC_FILE: &str = "FORMAT.md";
pub const LOCK_FILE: &str = ".lock";
pub const DB_BACKUPS_KEPT: usize = 5;

/// The database always uses this fixed object id.
pub const DB_OBJECT_ID: ObjectId = ObjectId(*b"media-vault-db\0\0");

pub const FORMAT_DOC: &str = include_str!("../FORMAT.md");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeySlot {
    /// Salt for Argon2id (password) or HKDF (recovery), hex.
    pub salt: String,
    /// AES-GCM nonce used to wrap the master key, hex.
    pub nonce: String,
    /// Master key encrypted with the slot key, 48 bytes, hex.
    pub wrapped_key: String,
}

impl KeySlot {
    /// The stand-in written for "no password": all three fields empty.
    fn empty() -> KeySlot {
        KeySlot { salt: String::new(), nonce: String::new(), wrapped_key: String::new() }
    }
    fn is_empty(&self) -> bool {
        self.salt.is_empty() && self.nonce.is_empty() && self.wrapped_key.is_empty()
    }
}

/// A vault without a password: the master key itself, unencrypted, so the
/// vault opens without asking. Anyone with the folder can open such a vault.
#[derive(Clone, Serialize, Deserialize)]
pub struct OpenSlot {
    /// Always [`OPEN_SLOT_WARNING`]; only there for people reading the file.
    #[serde(default)]
    pub warning: String,
    /// The 32-byte master key, hex.
    pub master_key: String,
}

impl std::fmt::Debug for OpenSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OpenSlot { master_key: <hidden> }")
    }
}

impl Drop for OpenSlot {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.master_key.zeroize();
    }
}

/// `password_slot` is always written, as an empty slot when the vault has
/// no password, so programs from before format 3 can still read the header
/// far enough to see the version number and refuse the vault clearly.
mod password_slot_field {
    use super::KeySlot;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<KeySlot>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(slot) => slot.serialize(s),
            None => KeySlot::empty().serialize(s),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<KeySlot>, D::Error> {
        let slot: Option<KeySlot> = Option::deserialize(d)?;
        Ok(slot.filter(|s| !s.is_empty()))
    }
}

/// Contents of vault.json. Contains nothing secret, unless the vault has no
/// password (then `open_slot` holds the master key).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultHeader {
    pub format: String,
    pub version: u32,
    pub vault_id: String,
    pub created_at: u64,
    pub kdf: KdfParams,
    /// None = the vault has no password (written as an empty slot).
    #[serde(default, with = "password_slot_field")]
    pub password_slot: Option<KeySlot>,
    pub recovery_slot: KeySlot,
    /// Only in a vault without a password.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_slot: Option<OpenSlot>,
}

impl VaultHeader {
    /// True if the vault asks for a password to open.
    pub fn has_password(&self) -> bool {
        self.password_slot.is_some()
    }
    /// True if the vault opens without a password.
    pub fn is_passwordless(&self) -> bool {
        self.open_slot.is_some()
    }
}

/// The 24 recovery words. Wiped from memory when dropped.
pub struct RecoveryPhrase(pub Zeroizing<String>);

impl RecoveryPhrase {
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn words(&self) -> Vec<&str> {
        self.0.split(' ').collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Normal use. Only one program may have a vault open for writing.
    ReadWrite,
    /// Export tool / inspection. Never writes anything.
    ReadOnly,
}

/// An object encrypted in memory by [`Vault::encrypt_to_memory`], not stored
/// yet. Holds only encrypted bytes.
pub struct Encrypted {
    id: ObjectId,
    kind: ObjectKind,
    bytes: Vec<u8>,
    written: WrittenObject,
}

impl Encrypted {
    pub fn id(&self) -> ObjectId {
        self.id
    }
    /// Plaintext length and SHA-256.
    pub fn written(&self) -> &WrittenObject {
        &self.written
    }
    /// Size of the encrypted object.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// An unlocked vault. The master key is wiped from memory when this is dropped.
pub struct Vault {
    root: PathBuf,
    header: VaultHeader,
    master: Key,
    access: Access,
    packs: PackStore,
    _lock: Option<File>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn slot_aad(kind: &str, vault_id: &str) -> Vec<u8> {
    format!("media-vault/v1/slot/{kind}/{vault_id}").into_bytes()
}

fn decode_fixed<const N: usize>(s: &str, what: &str) -> Result<[u8; N]> {
    let v = hex::decode(s).map_err(|_| Error::Corrupt(format!("vault.json: {what} is not hex")))?;
    v.try_into()
        .map_err(|_| Error::Corrupt(format!("vault.json: {what} has the wrong length")))
}

/// Write a file so that it is either fully replaced or untouched, even if
/// the power goes out halfway.
pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = tmp_path(path);
    {
        let mut f = File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

fn make_slot(kek: &Key, master: &Key, salt: &[u8], aad: &[u8]) -> KeySlot {
    let (nonce, wrapped) = crypto::wrap_key(kek, master, aad);
    KeySlot {
        salt: hex::encode(salt),
        nonce: hex::encode(nonce),
        wrapped_key: hex::encode(wrapped),
    }
}

fn open_slot(kek: &Key, slot: &KeySlot, aad: &[u8]) -> Result<Option<Key>> {
    let nonce: [u8; NONCE_LEN] = decode_fixed(&slot.nonce, "nonce")?;
    let wrapped: [u8; KEY_LEN + 16] = decode_fixed(&slot.wrapped_key, "wrapped_key")?;
    Ok(crypto::unwrap_key(kek, &nonce, &wrapped, aad))
}

fn new_recovery_slot(master: &Key, vault_id: &str) -> (KeySlot, RecoveryPhrase) {
    let entropy = Zeroizing::new(crypto::random_bytes::<KEY_LEN>());
    let salt = crypto::random_bytes::<16>();
    let kek = crypto::derive_recovery_key(&entropy, &salt);
    let slot = make_slot(&kek, master, &salt, &slot_aad("recovery", vault_id));
    let words = RecoveryPhrase(Zeroizing::new(crypto::entropy_to_words(&entropy)));
    (slot, words)
}

fn new_open_slot(master: &Key) -> OpenSlot {
    OpenSlot {
        warning: OPEN_SLOT_WARNING.into(),
        master_key: hex::encode(master.as_ref()),
    }
}

fn read_open_slot(slot: &OpenSlot) -> Result<Key> {
    let raw = Zeroizing::new(
        hex::decode(&slot.master_key)
            .map_err(|_| Error::Corrupt("vault.json: open_slot.master_key is not hex".into()))?,
    );
    let arr: [u8; KEY_LEN] = raw
        .as_slice()
        .try_into()
        .map_err(|_| Error::Corrupt("vault.json: open_slot.master_key has the wrong length".into()))?;
    Ok(Zeroizing::new(arr))
}

fn new_password_slot(
    master: &Key,
    password: &str,
    kdf: &KdfParams,
    vault_id: &str,
) -> Result<KeySlot> {
    if password.is_empty() {
        return Err(Error::Invalid("password must not be empty".into()));
    }
    let salt = crypto::random_bytes::<16>();
    let kek = crypto::derive_password_key(password, &salt, kdf)?;
    Ok(make_slot(
        &kek,
        master,
        &salt,
        &slot_aad("password", vault_id),
    ))
}

/// Read vault.json, falling back to vault.json.bak if the main copy is damaged.
pub fn read_header(root: &Path) -> Result<VaultHeader> {
    let main = root.join(HEADER_FILE);
    let bak = root.join(HEADER_BACKUP_FILE);
    if !main.exists() && !bak.exists() {
        return Err(Error::NotAVault(root.to_path_buf()));
    }
    let parse = |p: &Path| -> Result<VaultHeader> {
        let h: VaultHeader = serde_json::from_slice(&fs::read(p)?)?;
        if h.format != FORMAT_NAME {
            return Err(Error::NotAVault(root.to_path_buf()));
        }
        if h.version > FORMAT_VERSION {
            return Err(Error::UnsupportedVersion(h.version));
        }
        Ok(h)
    };
    match parse(&main) {
        Ok(h) => Ok(h),
        Err(e @ Error::UnsupportedVersion(_)) => Err(e),
        Err(e) => parse(&bak).map_err(|_| e),
    }
}

/// True if `path` looks like a vault folder.
pub fn is_vault(path: &Path) -> bool {
    path.join(HEADER_FILE).is_file() || path.join(HEADER_BACKUP_FILE).is_file()
}

impl Vault {
    /// Create a new, empty vault in `root` (must not exist, or be an empty folder).
    /// Returns the vault and the recovery phrase, which must be shown to the user once.
    pub fn create(root: &Path, password: &str, kdf: KdfParams) -> Result<(Vault, RecoveryPhrase)> {
        Self::create_inner(root, Some(password), kdf)
    }

    /// Create a new, empty vault that has no password: it opens with
    /// [`Vault::open_without_password`], and anyone who has the folder can
    /// open it. The recovery key works as usual. `kdf` is kept for when a
    /// password is set later.
    pub fn create_without_password(root: &Path, kdf: KdfParams) -> Result<(Vault, RecoveryPhrase)> {
        Self::create_inner(root, None, kdf)
    }

    fn create_inner(
        root: &Path,
        password: Option<&str>,
        kdf: KdfParams,
    ) -> Result<(Vault, RecoveryPhrase)> {
        if let Some(pw) = password
            && pw.is_empty()
        {
            return Err(Error::Invalid("password must not be empty".into()));
        }
        if root.exists() {
            if is_vault(root) {
                return Err(Error::AlreadyExists(root.to_path_buf()));
            }
            if fs::read_dir(root)?.next().is_some() {
                return Err(Error::Invalid(format!(
                    "folder is not empty: {}",
                    root.display()
                )));
            }
        }
        fs::create_dir_all(root.join(pack::PACK_DIR))?;
        fs::create_dir_all(root.join(BACKUP_DIR))?;

        let master = crypto::random_key();
        let vault_id = hex::encode(crypto::random_bytes::<16>());
        let (password_slot, open_slot) = match password {
            Some(pw) => (Some(new_password_slot(&master, pw, &kdf, &vault_id)?), None),
            None => (None, Some(new_open_slot(&master))),
        };
        let (recovery_slot, phrase) = new_recovery_slot(&master, &vault_id);
        let header = VaultHeader {
            format: FORMAT_NAME.into(),
            version: if open_slot.is_some() { NO_PASSWORD_VERSION } else { PACKED_VERSION },
            vault_id,
            created_at: now_secs(),
            kdf,
            password_slot,
            recovery_slot,
            open_slot,
        };
        atomic_write(&root.join(FORMAT_DOC_FILE), FORMAT_DOC.as_bytes())?;
        let mut vault = Vault {
            root: root.to_path_buf(),
            header,
            master,
            access: Access::ReadWrite,
            packs: PackStore::new(root, true),
            _lock: None,
        };
        vault.write_header()?;
        vault.acquire_lock()?;
        let empty_db = crate::db::serialize(&crate::db::create_empty()?)?;
        vault.save_db(&empty_db)?;
        Ok((vault, phrase))
    }

    pub fn unlock(root: &Path, password: &str, access: Access) -> Result<Vault> {
        let header = read_header(root)?;
        let Some(slot) = header.password_slot.as_ref() else {
            return Err(Error::NoPassword);
        };
        let salt = hex::decode(&slot.salt)
            .map_err(|_| Error::Corrupt("vault.json: salt".into()))?;
        let kek = crypto::derive_password_key(password, &salt, &header.kdf)?;
        let master = open_slot(&kek, slot, &slot_aad("password", &header.vault_id))?
            .ok_or(Error::WrongKey)?;
        Self::finish_unlock(root, header, master, access)
    }

    /// Open a vault that has no password (see [`Vault::create_without_password`]).
    pub fn open_without_password(root: &Path, access: Access) -> Result<Vault> {
        let header = read_header(root)?;
        let Some(slot) = header.open_slot.as_ref() else {
            return Err(Error::Invalid("this vault has a password".into()));
        };
        let master = read_open_slot(slot)?;
        Self::finish_unlock(root, header, master, access)
    }

    pub fn unlock_with_recovery(root: &Path, phrase: &str, access: Access) -> Result<Vault> {
        let header = read_header(root)?;
        let entropy = crypto::words_to_entropy(phrase)?;
        let salt = hex::decode(&header.recovery_slot.salt)
            .map_err(|_| Error::Corrupt("vault.json: salt".into()))?;
        let kek = crypto::derive_recovery_key(&entropy, &salt);
        let master = open_slot(
            &kek,
            &header.recovery_slot,
            &slot_aad("recovery", &header.vault_id),
        )?
        .ok_or(Error::WrongKey)?;
        Self::finish_unlock(root, header, master, access)
    }

    fn finish_unlock(
        root: &Path,
        header: VaultHeader,
        master: Key,
        access: Access,
    ) -> Result<Vault> {
        let mut v = Vault {
            root: root.to_path_buf(),
            header,
            master,
            access,
            packs: PackStore::new(root, access == Access::ReadWrite),
            _lock: None,
        };
        if access == Access::ReadWrite {
            v.acquire_lock()?;
        }
        Ok(v)
    }

    fn acquire_lock(&mut self) -> Result<()> {
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.root.join(LOCK_FILE))?;
        match f.try_lock() {
            Ok(()) => {
                self._lock = Some(f);
                Ok(())
            }
            Err(fs::TryLockError::WouldBlock) => Err(Error::Invalid(
                "this vault is already open in another window".into(),
            )),
            Err(fs::TryLockError::Error(e)) => Err(Error::Io(e)),
        }
    }

    fn require_write(&self) -> Result<()> {
        match self.access {
            Access::ReadWrite => Ok(()),
            Access::ReadOnly => Err(Error::Invalid("vault was opened read-only".into())),
        }
    }

    fn write_header(&self) -> Result<()> {
        let json = serde_json::to_vec_pretty(&self.header)?;
        atomic_write(&self.root.join(HEADER_FILE), &json)?;
        atomic_write(&self.root.join(HEADER_BACKUP_FILE), &json)?;
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn header(&self) -> &VaultHeader {
        &self.header
    }

    /// Re-wrap the master key under a new password. Instant: no media is
    /// re-encrypted. On a vault without a password this sets one (and the
    /// unprotected copy of the key is removed).
    pub fn change_password(&mut self, new_password: &str) -> Result<()> {
        self.require_write()?;
        let slot = new_password_slot(
            &self.master,
            new_password,
            &self.header.kdf,
            &self.header.vault_id,
        )?;
        self.header.password_slot = Some(slot);
        if self.header.open_slot.take().is_some() && self.header.version >= NO_PASSWORD_VERSION {
            // Readable by older programs again.
            self.header.version = if self.has_loose_objects()? { 1 } else { PACKED_VERSION };
        }
        self.write_header()
    }

    /// Remove the password: the master key is stored unencrypted in
    /// vault.json, so the vault opens without asking, for anyone who has the
    /// folder. Instant: only vault.json changes, no media is touched. The
    /// recovery key keeps working.
    pub fn turn_password_off(&mut self) -> Result<()> {
        self.require_write()?;
        self.header.open_slot = Some(new_open_slot(&self.master));
        self.header.password_slot = None;
        self.header.version = self.header.version.max(NO_PASSWORD_VERSION);
        self.write_header()?;
        // The format description inside the vault explains the open slot.
        let doc = self.root.join(FORMAT_DOC_FILE);
        if fs::read(&doc).ok().as_deref() != Some(FORMAT_DOC.as_bytes()) {
            atomic_write(&doc, FORMAT_DOC.as_bytes())?;
        }
        Ok(())
    }

    /// Replace the recovery key. The old 24 words stop working.
    pub fn reset_recovery(&mut self) -> Result<RecoveryPhrase> {
        self.require_write()?;
        let (slot, phrase) = new_recovery_slot(&self.master, &self.header.vault_id);
        self.header.recovery_slot = slot;
        self.write_header()?;
        Ok(phrase)
    }

    // ---- objects ---------------------------------------------------------

    /// Where an object lived in format 1 (one file per object). Still read.
    pub fn object_path(&self, kind: ObjectKind, id: &ObjectId) -> PathBuf {
        let hex = id.to_hex();
        let dir = match kind {
            ObjectKind::Media => MEDIA_DIR,
            ObjectKind::Thumbnail => THUMB_DIR,
            ObjectKind::Database => return self.root.join(DB_FILE),
        };
        self.root
            .join(dir)
            .join(&hex[..2])
            .join(format!("{hex}.bin"))
    }

    /// Encrypt everything read from `source` into a new object (appended to
    /// the newest pack). Returns its id, plaintext length and SHA-256.
    pub fn add_object(
        &self,
        kind: ObjectKind,
        mut source: impl Read,
    ) -> Result<(ObjectId, WrittenObject)> {
        self.require_write()?;
        let id = ObjectId::random();
        let (written, _) = self.packs.append(kind, id, |w| {
            let mut ow = ObjectWriter::new(w, id, kind, DEFAULT_CHUNK_LOG2)?;
            std::io::copy(&mut source, &mut ow)?;
            let (_, written) = ow.finish(&self.master)?;
            Ok(written)
        })?;
        Ok((id, written))
    }

    /// Encrypt everything read from `source` into memory, on one core
    /// (for importing several files at once: each is encrypted on its own
    /// thread, then stored in order with [`Vault::add_encrypted`]). Reads
    /// the source once; the SHA-256 is computed on the way.
    /// `size_hint`: the expected plaintext length (room is made for it once).
    pub fn encrypt_to_memory(&self, kind: ObjectKind, mut source: impl Read, size_hint: u64) -> Result<Encrypted> {
        self.require_write()?;
        if kind == ObjectKind::Database {
            return Err(Error::Invalid("the database is not stored in packs".into()));
        }
        let id = ObjectId::random();
        let chunks = size_hint.div_ceil(1 << DEFAULT_CHUNK_LOG2).max(1);
        let room = size_hint.saturating_add(crate::stream::HEADER_LEN + chunks.saturating_mul(crate::crypto::TAG_LEN as u64)).min(1 << 30) as usize;
        let mut ow = ObjectWriter::new(std::io::Cursor::new(Vec::with_capacity(room)), id, kind, DEFAULT_CHUNK_LOG2)?;
        ow.set_threads(1);
        std::io::copy(&mut source, &mut ow)?;
        let (cur, written) = ow.finish(&self.master)?;
        Ok(Encrypted { id, kind, bytes: cur.into_inner(), written })
    }

    /// Store an object made by [`Vault::encrypt_to_memory`] (appended to the newest pack).
    pub fn add_encrypted(&self, e: &Encrypted) -> Result<()> {
        self.require_write()?;
        self.packs.append(e.kind, e.id, |w| {
            w.write_all(&e.bytes)?;
            Ok(())
        })?;
        Ok(())
    }

    /// Write a loose object file (used for the database).
    fn write_object_at(
        &self,
        kind: ObjectKind,
        id: ObjectId,
        mut source: impl Read,
    ) -> Result<WrittenObject> {
        self.require_write()?;
        let path = self.object_path(kind, &id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = tmp_path(&path);
        let result = (|| -> Result<WrittenObject> {
            let file = File::create(&tmp)?;
            let mut w = ObjectWriter::new(file, id, kind, DEFAULT_CHUNK_LOG2)?;
            std::io::copy(&mut source, &mut w)?;
            let (file, written) = w.finish(&self.master)?;
            file.sync_all()?;
            Ok(written)
        })();
        match result {
            Ok(w) => {
                fs::rename(&tmp, &path)?;
                Ok(w)
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(e)
            }
        }
    }

    fn open_raw(&self, kind: ObjectKind, id: &ObjectId) -> Result<Slice> {
        if let Some(s) = self.packs.open(kind, id)? {
            return Ok(s);
        }
        let path = self.object_path(kind, id);
        let f = File::open(&path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::NotFound(format!("{kind:?} {id}")),
            _ => Error::Io(e),
        })?;
        Ok(Slice::whole(f)?)
    }

    /// Open an object for random-access reading.
    pub fn open_object(&self, kind: ObjectKind, id: &ObjectId) -> Result<ObjectReader<Slice>> {
        let s = self.open_raw(kind, id)?;
        ObjectReader::open(s, &self.master, *id, Some(kind))
    }

    /// Decrypt a whole object into memory (fine for thumbnails and images).
    pub fn read_object(&self, kind: ObjectKind, id: &ObjectId) -> Result<Zeroizing<Vec<u8>>> {
        let mut r = self.open_object(kind, id)?;
        let mut out = Zeroizing::new(Vec::with_capacity(r.len() as usize));
        r.read_to_end(&mut out)?;
        Ok(out)
    }

    /// Forget an object. Its space inside a pack is freed by [`Vault::compact`].
    pub fn delete_object(&self, kind: ObjectKind, id: &ObjectId) -> Result<()> {
        self.require_write()?;
        self.packs.remove(id);
        match fs::remove_file(self.object_path(kind, id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Check every byte of an object decrypts and authenticates.
    pub fn verify_object(&self, kind: ObjectKind, id: &ObjectId) -> Result<()> {
        self.open_object(kind, id)?.verify_all()
    }

    /// Object ids stored as separate files (format 1).
    pub fn loose_objects(&self, kind: ObjectKind) -> Result<Vec<ObjectId>> {
        let dir = match kind {
            ObjectKind::Media => MEDIA_DIR,
            ObjectKind::Thumbnail => THUMB_DIR,
            ObjectKind::Database => return Ok(vec![]),
        };
        let mut out = Vec::new();
        let base = self.root.join(dir);
        if !base.exists() {
            return Ok(out);
        }
        for sub in fs::read_dir(base)? {
            let sub = sub?;
            if !sub.file_type()?.is_dir() {
                continue;
            }
            for f in fs::read_dir(sub.path())? {
                let name = f?.file_name();
                let name = name.to_string_lossy();
                if let Some(stem) = name.strip_suffix(".bin")
                    && let Ok(id) = ObjectId::from_hex(stem)
                {
                    out.push(id);
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// All object ids of a kind (packed and loose).
    pub fn list_objects(&self, kind: ObjectKind) -> Result<Vec<ObjectId>> {
        if kind == ObjectKind::Database {
            return Ok(vec![DB_OBJECT_ID]);
        }
        let mut out = self.packs.ids(kind);
        out.extend(self.loose_objects(kind)?);
        out.sort();
        out.dedup();
        Ok(out)
    }

    // ---- packs -------------------------------------------------------------

    /// Set the pack index, read from the database after unlocking.
    pub fn load_index(&self, entries: impl IntoIterator<Item = (ObjectId, Location)>) {
        self.packs.load_index(entries)
    }

    /// Index changes to write into the database before it is saved.
    pub fn drain_index_changes(&self) -> Vec<IndexChange> {
        self.packs.drain_changes()
    }

    /// Put index changes back after a failed save.
    pub fn restore_index_changes(&self, c: Vec<IndexChange>) {
        self.packs.restore_changes(c)
    }

    /// The file and byte range holding an object (for tools and tests).
    pub fn object_location(&self, kind: ObjectKind, id: &ObjectId) -> Option<(PathBuf, u64, u64)> {
        if self.packs.open(kind, id).ok().flatten().is_some()
            && let Some(l) = self.packs.location(id)
        {
            return Some((self.packs.path(l.kind, l.pack), l.offset, l.len));
        }
        let p = self.object_path(kind, id);
        let len = fs::metadata(&p).ok()?.len();
        Some((p, 0, len))
    }

    pub fn is_packed(&self, id: &ObjectId) -> bool {
        self.packs.contains(id)
    }

    /// True if objects are still stored one file each (format 1).
    pub fn has_loose_objects(&self) -> Result<bool> {
        Ok(!self.loose_objects(ObjectKind::Media)?.is_empty()
            || !self.loose_objects(ObjectKind::Thumbnail)?.is_empty())
    }

    /// Step 1 of converting a format-1 vault: copy every loose object into
    /// packs (unchanged, still encrypted). `progress(done, total)`.
    /// Then save the database, then call [`Vault::remove_packed_loose_files`].
    pub fn pack_loose_objects(&self, mut progress: impl FnMut(usize, usize)) -> Result<usize> {
        self.require_write()?;
        let mut todo = Vec::new();
        for kind in [ObjectKind::Media, ObjectKind::Thumbnail] {
            for id in self.loose_objects(kind)? {
                if !self.packs.contains(&id) {
                    todo.push((kind, id));
                }
            }
        }
        let total = todo.len();
        for (i, (kind, id)) in todo.into_iter().enumerate() {
            let f = File::open(self.object_path(kind, &id))?;
            self.packs.append_raw(kind, id, f)?;
            // Make sure the packed copy is complete and decrypts.
            self.open_object(kind, &id)?.verify_all()?;
            progress(i + 1, total);
        }
        Ok(total)
    }

    /// Step 2: delete loose files whose packed copy exists (after the database
    /// recording the packed locations has been saved). Marks the vault as format 2.
    pub fn remove_packed_loose_files(&mut self) -> Result<usize> {
        self.require_write()?;
        let mut removed = 0;
        for kind in [ObjectKind::Media, ObjectKind::Thumbnail] {
            for id in self.loose_objects(kind)? {
                if self.packs.contains(&id) {
                    fs::remove_file(self.object_path(kind, &id))?;
                    removed += 1;
                }
            }
            let dir = self.root.join(if kind == ObjectKind::Media {
                MEDIA_DIR
            } else {
                THUMB_DIR
            });
            if let Ok(rd) = fs::read_dir(&dir) {
                for sub in rd.flatten() {
                    let _ = fs::remove_dir(sub.path()); // only removes empty folders
                }
            }
            let _ = fs::remove_dir(&dir);
        }
        if self.header.version < 2 && !self.has_loose_objects()? {
            self.header.version = 2;
            self.write_header()?;
        }
        Ok(removed)
    }

    /// The master key, for tests that build old-format files.
    #[doc(hidden)]
    pub fn test_master(&self) -> &Key {
        &self.master
    }

    /// Smaller packs, for tests.
    #[doc(hidden)]
    pub fn set_pack_limit(&mut self, bytes: u64) {
        self.packs.set_limit(bytes)
    }

    pub fn pack_usage(&self) -> Result<Vec<PackUsage>> {
        self.packs.usage()
    }

    /// Step 1 of reclaiming space: copy live objects out of packs where at
    /// least `min_waste` (0..1) is unused. Save the database, then call
    /// [`Vault::finish_compact`].
    pub fn compact(&self, min_waste: f64) -> Result<CompactPlan> {
        self.require_write()?;
        self.packs.compact(min_waste)
    }

    pub fn finish_compact(&self, plan: &CompactPlan) -> Result<()> {
        self.require_write()?;
        self.packs.delete_retired(plan)
    }

    /// Find every object by reading the packs (when the index can't be trusted).
    pub fn rescan_packs(&self) -> Result<usize> {
        let map = self.packs.scan_all()?;
        let n = map.len();
        self.packs.load_index(map);
        Ok(n)
    }

    // ---- database ----------------------------------------------------------

    /// Save the (serialized SQLite) database. The previous version is kept in
    /// meta-backups/, and only the newest DB_BACKUPS_KEPT copies are retained.
    pub fn save_db(&self, sqlite_bytes: &[u8]) -> Result<()> {
        self.save_db_spaced(sqlite_bytes, std::time::Duration::ZERO)
    }

    /// Like [`Vault::save_db`], but a backup copy is only made when the newest
    /// one is older than `min_gap` (the app saves after every change, and ten
    /// backups a few seconds apart would be little use).
    pub fn save_db_spaced(&self, sqlite_bytes: &[u8], min_gap: std::time::Duration) -> Result<()> {
        self.require_write()?;
        // The database points into the packs, so they must be on disk first.
        self.packs.sync()?;
        let current = self.root.join(DB_FILE);
        let backups = self.root.join(BACKUP_DIR);
        fs::create_dir_all(&backups)?;
        let newest_ms = self
            .db_backups()?
            .last()
            .and_then(|p| p.file_name()?.to_str()?.strip_prefix("meta-")?.strip_suffix(".db.enc")?.parse::<u128>().ok());
        let due = newest_ms.is_none_or(|ms| now_millis().saturating_sub(ms) >= min_gap.as_millis());
        if current.exists() && due {
            let name = format!("meta-{:015}.db.enc", now_millis());
            fs::copy(&current, backups.join(name))?;
            self.prune_db_backups()?;
        }
        self.write_object_at(ObjectKind::Database, DB_OBJECT_ID, sqlite_bytes)?;
        Ok(())
    }

    fn prune_db_backups(&self) -> Result<()> {
        let mut list = self.db_backups()?;
        while list.len() > DB_BACKUPS_KEPT {
            let oldest = list.remove(0);
            let _ = fs::remove_file(oldest);
        }
        Ok(())
    }

    /// Database backups, oldest first.
    pub fn db_backups(&self) -> Result<Vec<PathBuf>> {
        let dir = self.root.join(BACKUP_DIR);
        let mut v: Vec<PathBuf> = match fs::read_dir(&dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("meta-") && n.ends_with(".db.enc"))
                })
                .collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        v.sort();
        Ok(v)
    }

    fn read_db_file(&self, path: &Path) -> Result<Zeroizing<Vec<u8>>> {
        let f = Slice::whole(File::open(path)?)?;
        let mut r = ObjectReader::open(f, &self.master, DB_OBJECT_ID, Some(ObjectKind::Database))?;
        let mut out = Zeroizing::new(Vec::new());
        r.read_to_end(&mut out)
            .map_err(|e| Error::Corrupt(e.to_string()))?;
        Ok(out)
    }

    /// Check that a database file (the main one or a backup) decrypts.
    pub fn verify_db_file(&self, path: &Path) -> Result<()> {
        self.read_db_file(path).map(|_| ())
    }

    /// Load the database. If the main copy is damaged, the newest backup that
    /// still decrypts is used instead, and its file name is returned so the
    /// app can tell the user.
    pub fn load_db(&self) -> Result<(Zeroizing<Vec<u8>>, Option<PathBuf>)> {
        let main_err = match self.read_db_file(&self.root.join(DB_FILE)) {
            Ok(b) => return Ok((b, None)),
            Err(e) => e,
        };
        for b in self.db_backups()?.into_iter().rev() {
            if let Ok(bytes) = self.read_db_file(&b) {
                return Ok((bytes, Some(b)));
            }
        }
        Err(main_err)
    }
}
