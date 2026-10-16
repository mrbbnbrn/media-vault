use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("wrong password or recovery key")]
    WrongKey,

    #[error("this vault has no password; it opens without one")]
    NoPassword,

    #[error("invalid recovery phrase: {0}")]
    BadRecoveryPhrase(String),

    #[error("data is damaged or has been tampered with ({0})")]
    Corrupt(String),

    #[error("not a Media Vault folder: {0}")]
    NotAVault(PathBuf),

    #[error("a vault already exists at {0}")]
    AlreadyExists(PathBuf),

    #[error("this vault uses format version {0}, which this program does not understand")]
    UnsupportedVersion(u32),

    #[error("object not found: {0}")]
    NotFound(String),

    #[error("invalid argument: {0}")]
    Invalid(String),

    #[error("disk error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("vault header is unreadable: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<Error> for std::io::Error {
    fn from(e: Error) -> Self {
        match e {
            Error::Io(io) => io,
            other => std::io::Error::new(std::io::ErrorKind::InvalidData, other.to_string()),
        }
    }
}
