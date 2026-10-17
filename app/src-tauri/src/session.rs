//! Opening, creating and locking vaults. Independent of the window toolkit so
//! it can be unit-tested.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use vault_core::db::{self, Connection};
use vault_core::{Access, Error, KdfParams, Vault};

pub const MIN_PASSWORD_CHARS: usize = 8;

/// An unlocked vault. Shared (behind an `Arc`) between commands, the import
/// worker and the media stream; dropping the last reference wipes the master
/// key from memory.
pub struct Session {
    vault: RwLock<Vault>,
    db: Mutex<Connection>,
    /// Opened with the recovery key: the user must set a new password.
    needs_new_password: AtomicBool,
    pub restored_from_backup: Option<PathBuf>,
    /// Set when the vault is locked; background work stops as soon as it sees it.
    closed: AtomicBool,
    dirty: AtomicBool,
    last_change: Mutex<Instant>,
    /// A save has been asked for and not started yet.
    save_pending: AtomicBool,
    /// When the oldest unsaved change was made (None = nothing unsaved).
    first_unsaved: Mutex<Option<Instant>>,
    /// One save at a time (the watcher, imports and commands all save).
    save_lock: Mutex<()>,
    /// Counts changes (so work that follows changes can tell when there were none).
    changes: std::sync::atomic::AtomicU64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub path: String,
    pub name: String,
    pub items: i64,
    pub folders: i64,
    pub needs_new_password: bool,
    /// False for a vault that opens without a password.
    pub has_password: bool,
    /// False for a vault without encryption (its files are ordinary files).
    pub encrypted: bool,
    /// "plain" or "encrypted" while the vault is being changed to that.
    pub converting: Option<String>,
    /// Set if the main database was damaged and a backup was used.
    pub restored_from_backup: Option<String>,
    /// Only right after unlocking: the previous opening and wrong passwords since.
    pub login: Option<crate::access::LoginInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub path: String,
    pub name: String,
    /// "ready", "missing" (drive not connected / folder gone) or "notVault".
    pub status: String,
    pub size_bytes: Option<u64>,
    /// Opens without a password (no need to ask for one).
    pub passwordless: bool,
    /// False for a vault without encryption.
    pub encrypted: bool,
}

pub fn friendly(e: Error) -> String {
    match e {
        Error::WrongKey => "That password doesn't match this vault.".into(),
        Error::NoPassword => "This vault has no password. It opens without one.".into(),
        Error::BadRecoveryPhrase(m) => format!("Those recovery words aren't valid: {m}."),
        Error::NotAVault(p) => format!("{} is not a Media Vault folder.", p.display()),
        Error::AlreadyExists(p) => format!("There is already a vault in {}.", p.display()),
        Error::UnsupportedVersion(v) => {
            format!(
                "This vault was made by a newer version of Media Vault (format {v}). Please update the app."
            )
        }
        other => other.to_string(),
    }
}

pub fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(e.path()),
                Ok(_) => total += e.metadata().map(|m| m.len()).unwrap_or(0),
                Err(_) => {}
            }
        }
    }
    total
}

pub fn describe(path: &str) -> VaultEntry {
    let p = Path::new(path);
    let (status, size) = if !p.exists() {
        ("missing", None)
    } else if !vault_core::is_vault(p) {
        ("notVault", None)
    } else {
        ("ready", Some(dir_size(p)))
    };
    let header = if status == "ready" { vault_core::read_header(p).ok() } else { None };
    let passwordless = header.as_ref().is_some_and(|h| h.is_passwordless());
    let encrypted = !header.as_ref().is_some_and(|h| h.is_plain());
    VaultEntry {
        path: path.to_string(),
        name: folder_name(p),
        status: status.into(),
        size_bytes: size,
        passwordless,
        encrypted,
    }
}

pub fn check_password(pw: &str) -> Result<(), String> {
    if pw.chars().count() < MIN_PASSWORD_CHARS {
        return Err(format!(
            "Use at least {MIN_PASSWORD_CHARS} characters. A few unrelated words make a strong, memorable password."
        ));
    }
    Ok(())
}

fn open_session(vault: Vault, needs_new_password: bool) -> Result<Session, String> {
    let (bytes, backup) = vault.load_db().map_err(friendly)?;
    let db = db::deserialize(&bytes).map_err(friendly)?;
    vault.load_index(db::load_index(&db).map_err(friendly)?);
    // A vault without encryption: where its ordinary files are.
    vault.set_media_files(db::load_plain_files(&db).map_err(friendly)?);
    Ok(Session {
        vault: RwLock::new(vault),
        db: Mutex::new(db),
        needs_new_password: AtomicBool::new(needs_new_password),
        restored_from_backup: backup,
        closed: AtomicBool::new(false),
        dirty: AtomicBool::new(false),
        last_change: Mutex::new(Instant::now()),
        first_unsaved: Mutex::new(None),
        save_pending: AtomicBool::new(false),
        save_lock: Mutex::new(()),
        // Starts somewhere new for every opening (work that remembers a count from another vault never matches).
        changes: std::sync::atomic::AtomicU64::new(
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1) | 1,
        ),
    })
}

impl Session {
    pub fn vault(&self) -> RwLockReadGuard<'_, Vault> {
        self.vault.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn vault_mut(&self) -> RwLockWriteGuard<'_, Vault> {
        self.vault.write().unwrap_or_else(|e| e.into_inner())
    }

    pub fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// False for a vault that opens without a password (it never locks by itself).
    pub fn has_password(&self) -> bool {
        self.vault().header().has_password()
    }

    pub fn needs_new_password(&self) -> bool {
        self.needs_new_password.load(Ordering::SeqCst)
    }

    pub fn set_needs_new_password(&self, v: bool) {
        self.needs_new_password.store(v, Ordering::SeqCst)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst)
    }

    /// After closing (and the last save): the vault's lock file is let go at
    /// once, so it can be opened again straight away even while some
    /// background work still holds this session; that work can't write any more.
    pub fn release(&self) {
        self.vault_mut().release();
    }

    /// Record that the library changed; it is saved shortly afterwards.
    pub fn mark_dirty(&self) {
        self.changes.fetch_add(1, Ordering::SeqCst);
        let now = Instant::now();
        *self.last_change.lock().unwrap_or_else(|e| e.into_inner()) = now;
        self.first_unsaved.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(now);
        self.dirty.store(true, Ordering::SeqCst);
    }

    /// Save right away in the background (changes made while it runs are
    /// picked up by the next save). Several requests at once make one save.
    pub fn save_soon(self: &std::sync::Arc<Self>) {
        if self.save_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let s = self.clone();
        std::thread::spawn(move || {
            s.save_pending.store(false, Ordering::SeqCst);
            if s.is_dirty() && !s.is_closed() {
                let _ = s.save();
            }
        });
    }

    /// How many changes there have been (grows with every change).
    pub fn changes(&self) -> u64 {
        self.changes.load(Ordering::SeqCst)
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::SeqCst)
    }

    /// Encrypt and save the library database now.
    pub fn save(&self) -> Result<(), String> {
        let _one_at_a_time = self.save_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.dirty.store(false, Ordering::SeqCst);
        let first = self.first_unsaved.lock().unwrap_or_else(|e| e.into_inner()).take();
        let restore_first = || {
            if let Some(f) = first {
                self.first_unsaved.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(f);
            }
        };
        // Where new encrypted files landed in the packs goes into the database too.
        let changes = self.vault().drain_index_changes();
        let bytes = {
            let db = self.db();
            if let Err(e) = db::apply_index_changes(&db, &changes) {
                self.vault().restore_index_changes(changes);
                self.dirty.store(true, Ordering::SeqCst);
                restore_first();
                return Err(format!("Couldn't save the library: {}", friendly(e)));
            }
            match db::serialize(&db) {
                Ok(b) => b,
                Err(e) => {
                    self.dirty.store(true, Ordering::SeqCst);
                    restore_first();
                    return Err(friendly(e));
                }
            }
        };
        // A backup copy at most every 10 minutes (saving happens after every change).
        self.vault().save_db_spaced(&bytes, Duration::from_secs(600)).map_err(|e| {
            self.dirty.store(true, Ordering::SeqCst);
            restore_first();
            format!("Couldn't save the library: {}", friendly(e))
        })
    }

    /// Save once changes have settled for `settle` (so a burst of edits is
    /// written once) — but never later than `max_wait` after the first
    /// unsaved change, even while background work keeps changing things.
    pub fn save_if_settled(&self, settle: Duration, max_wait: Duration) -> Result<(), String> {
        let age = self
            .last_change
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .elapsed();
        let waiting = self
            .first_unsaved
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map(|t| t.elapsed())
            .unwrap_or_default();
        if self.is_dirty() && (age >= settle || waiting >= max_wait) {
            self.save()
        } else {
            Ok(())
        }
    }

    pub fn info(&self) -> SessionInfo {
        let db = self.db();
        let count = |sql: &str| db.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
        let root = self.vault().root().to_path_buf();
        SessionInfo {
            path: root.display().to_string(),
            name: folder_name(&root),
            items: count("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL"),
            folders: count("SELECT COUNT(*) FROM folders WHERE deleted_at IS NULL"),
            needs_new_password: self.needs_new_password(),
            has_password: self.has_password(),
            encrypted: !self.vault().header().is_plain(),
            converting: self.vault().conversion().map(str::to_string),
            restored_from_backup: self
                .restored_from_backup
                .as_ref()
                .map(|p| p.display().to_string()),
            login: None,
        }
    }
}

/// Create a vault in `parent/name`. Returns the open session and the 24 words.
pub fn create(
    parent: &str,
    name: &str,
    password: &str,
    kdf: KdfParams,
) -> Result<(Session, Vec<String>), String> {
    create_with(parent, name, Some(password), kdf)
}

/// Like [`create`], but the vault has no password: it opens without asking,
/// for anyone who has the folder.
pub fn create_without_password(
    parent: &str,
    name: &str,
    kdf: KdfParams,
) -> Result<(Session, Vec<String>), String> {
    create_with(parent, name, None, kdf)
}

/// Like [`create`], but the vault has **no encryption**: media are ordinary
/// files under `Files/`; no password, no recovery key.
pub fn create_plain(parent: &str, name: &str, kdf: KdfParams) -> Result<Session, String> {
    create_inner(parent, name, None, kdf, true).map(|(s, _)| s)
}

fn create_with(
    parent: &str,
    name: &str,
    password: Option<&str>,
    kdf: KdfParams,
) -> Result<(Session, Vec<String>), String> {
    create_inner(parent, name, password, kdf, false)
}

fn create_inner(
    parent: &str,
    name: &str,
    password: Option<&str>,
    kdf: KdfParams,
    plain: bool,
) -> Result<(Session, Vec<String>), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the vault a name.".into());
    }
    if name
        .chars()
        .any(|c| r#"<>:"/\|?*"#.contains(c) || c.is_control())
        || name.ends_with('.')
    {
        return Err("A vault name can't contain < > : \" / \\ | ? * or end with a dot.".into());
    }
    if let Some(pw) = password {
        check_password(pw)?;
    }
    let parent = Path::new(parent);
    if !parent.is_dir() {
        return Err(format!("The folder {} doesn't exist.", parent.display()));
    }
    let root = parent.join(name);
    if plain {
        let vault = Vault::create_plain(&root, kdf).map_err(friendly)?;
        return Ok((open_session(vault, false)?, Vec::new()));
    }
    let (vault, phrase) = match password {
        Some(pw) => Vault::create(&root, pw, kdf),
        None => Vault::create_without_password(&root, kdf),
    }
    .map_err(friendly)?;
    let words = phrase.words().iter().map(|w| w.to_string()).collect();
    Ok((open_session(vault, false)?, words))
}

pub fn unlock(path: &str, password: &str) -> Result<Session, String> {
    let vault = Vault::unlock(Path::new(path), password, Access::ReadWrite).map_err(friendly)?;
    open_session(vault, false)
}

/// Open a vault that has no password.
pub fn open_without_password(path: &str) -> Result<Session, String> {
    let vault = Vault::open_without_password(Path::new(path), Access::ReadWrite).map_err(friendly)?;
    open_session(vault, false)
}

pub fn unlock_with_recovery(path: &str, phrase: &str) -> Result<Session, String> {
    let vault = Vault::unlock_with_recovery(Path::new(path), phrase, Access::ReadWrite)
        .map_err(friendly)?;
    // A vault without a password has no password to replace.
    let needs_new = vault.header().has_password();
    open_session(vault, needs_new)
}

/// Verify `current` against the vault on disk (slow on purpose, like unlocking).
pub fn verify_password(path: &Path, current: &str) -> Result<(), String> {
    Vault::unlock(path, current, Access::ReadOnly)
        .map(|_| ())
        .map_err(|e| match e {
            Error::WrongKey => "Your current password is not correct.".into(),
            other => friendly(other),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_vault_opens_again_while_something_still_holds_it() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = create_without_password(t.path().to_str().unwrap(), "V", KdfParams::TEST_ONLY).unwrap();
        let path = s.vault().root().display().to_string();
        let held = std::sync::Arc::new(s);
        let background = held.clone(); // e.g. a thumbnail job still running
        assert!(open_without_password(&path).is_err(), "open: locked");
        held.close();
        held.release();
        let again = open_without_password(&path).expect("opens again at once");
        // The old one can't write any more.
        assert!(background.vault().add_object(vault_core::ObjectKind::Thumbnail, &b"x"[..]).is_err());
        assert!(background.save().is_err());
        drop(again);
    }

    const KDF: KdfParams = KdfParams::TEST_ONLY;

    #[test]
    fn busy_background_work_does_not_stop_saving() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = create(t.path().to_str().unwrap(), "V", "long enough pw", KDF).unwrap();
        let path = s.vault().root().to_path_buf();
        s.db().execute("INSERT INTO folders(parent_id, name, created_at) VALUES (NULL, 'Alex', 0)", []).unwrap();
        s.mark_dirty();
        // Changes keep coming (last change is always fresh): settling alone never saves…
        s.mark_dirty();
        s.save_if_settled(Duration::from_secs(3600), Duration::from_secs(3600)).unwrap();
        assert!(s.is_dirty());
        // …but the longest wait does.
        std::thread::sleep(Duration::from_millis(20));
        s.mark_dirty();
        s.save_if_settled(Duration::from_secs(3600), Duration::from_millis(10)).unwrap();
        assert!(!s.is_dirty());
        drop(s);
        let s = unlock(path.to_str().unwrap(), "long enough pw").unwrap();
        let n: i64 = s.db().query_row("SELECT COUNT(*) FROM folders WHERE name = 'Alex'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the folder was saved");
    }

    #[test]
    fn create_lock_unlock_and_recover() {
        let t = tempfile::tempdir().unwrap();
        let parent = t.path().to_str().unwrap();
        let (s, words) = create(parent, "Photos", "long enough pw", KDF).unwrap();
        assert_eq!(words.len(), 24);
        let info = s.info();
        assert_eq!(info.name, "Photos");
        assert_eq!(info.items, 0);
        let path = info.path.clone();
        drop(s); // lock

        assert_eq!(
            unlock(&path, "wrong password").err().unwrap(),
            "That password doesn't match this vault."
        );
        let s = unlock(&path, "long enough pw").unwrap();
        assert!(!s.info().needs_new_password);
        drop(s);

        let s = unlock_with_recovery(&path, &words.join(" ")).unwrap();
        assert!(s.info().needs_new_password);
        s.vault_mut().change_password("a brand new one").unwrap();
        drop(s);
        assert!(unlock(&path, "a brand new one").is_ok());
    }

    #[test]
    fn rejects_bad_names_and_short_passwords() {
        let t = tempfile::tempdir().unwrap();
        let parent = t.path().to_str().unwrap();
        assert!(create(parent, "", "long enough pw", KDF).is_err());
        assert!(create(parent, "a/b", "long enough pw", KDF).is_err());
        assert!(
            create(parent, "ok", "short", KDF)
                .err()
                .unwrap()
                .contains("at least 8")
        );
        assert!(create(&format!("{parent}/missing"), "ok", "long enough pw", KDF).is_err());
    }

    #[test]
    fn describes_vault_states() {
        let t = tempfile::tempdir().unwrap();
        let parent = t.path().to_str().unwrap();
        let (s, _) = create(parent, "V", "long enough pw", KDF).unwrap();
        let p = s.info().path;
        drop(s);

        let d = describe(&p);
        assert_eq!(d.status, "ready");
        assert!(d.size_bytes.unwrap() > 0);
        assert_eq!(describe(&format!("{parent}/nope")).status, "missing");
        assert_eq!(describe(parent).status, "notVault");
    }

    #[test]
    fn passwordless_vault_opens_without_asking_and_round_trips() {
        let t = tempfile::tempdir().unwrap();
        let parent = t.path().to_str().unwrap();
        let (s, words) = create_without_password(parent, "Open", KDF).unwrap();
        assert!(!s.has_password());
        assert!(!s.info().has_password);
        s.db().execute("INSERT INTO folders(parent_id, name, created_at) VALUES (NULL, 'Kept', 0)", []).unwrap();
        s.mark_dirty();
        s.save().unwrap();
        let path = s.info().path;
        drop(s);

        let d = describe(&path);
        assert!(d.passwordless && d.status == "ready");
        assert_eq!(
            unlock(&path, "long enough pw").err().unwrap(),
            "This vault has no password. It opens without one."
        );
        let s = open_without_password(&path).unwrap();
        let kept = |s: &Session| -> i64 {
            s.db().query_row("SELECT COUNT(*) FROM folders WHERE name = 'Kept'", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(kept(&s), 1);
        // Set a password: now it asks.
        s.vault_mut().change_password("long enough pw").unwrap();
        assert!(s.has_password());
        drop(s);
        assert!(!describe(&path).passwordless);
        assert!(open_without_password(&path).is_err());
        let s = unlock(&path, "long enough pw").unwrap();
        assert_eq!(kept(&s), 1);
        // And off again.
        s.vault_mut().turn_password_off().unwrap();
        drop(s);
        assert!(describe(&path).passwordless);
        assert!(unlock(&path, "long enough pw").is_err());
        let s = open_without_password(&path).unwrap();
        assert_eq!(kept(&s), 1);
        drop(s);

        // The recovery key opens it, and there is no password to replace.
        let s = unlock_with_recovery(&path, &words.join(" ")).unwrap();
        assert!(!s.needs_new_password());
        assert_eq!(kept(&s), 1);
    }

    #[test]
    fn verify_password_works() {
        let t = tempfile::tempdir().unwrap();
        let (s, _) = create(t.path().to_str().unwrap(), "V", "long enough pw", KDF).unwrap();
        let root = s.vault().root().to_path_buf();
        assert!(verify_password(&root, "long enough pw").is_ok());
        assert!(verify_password(&root, "nope nope nope").is_err());
    }
}
