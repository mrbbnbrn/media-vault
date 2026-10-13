//! Media Vault core: everything that touches encryption and the on-disk format.
//!
//! The UI never handles keys or encrypted bytes directly; it goes through
//! [`Vault`]. The format is documented in FORMAT.md, which is also copied
//! into every vault folder.

pub mod crypto;
pub mod db;
pub mod error;
pub mod export;
pub mod multipart;
pub mod pack;
pub mod stream;
pub mod vault;

pub use crypto::KdfParams;
pub use error::{Error, Result};
pub use stream::{ObjectId, ObjectKind, ObjectReader};
pub use vault::{Access, RecoveryPhrase, Vault, is_vault, read_header};
