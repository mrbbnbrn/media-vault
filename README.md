# Media Vault

A private, encrypted media library for Windows. Repository: https://github.com/mrbbnbrn/media-vault

## Status

**Step 1 — vault core: done.**

- `crates/vault-core` — encryption, key handling, encrypted object files with
  random-access reading, encrypted SQLite library database with rotating
  backups, tag search, export.
- `crates/vault-export` — `vault-export.exe`, a standalone tool that decrypts a
  vault back into ordinary files without the main app.
- `crates/vault-core/FORMAT.md` — the on-disk format, copied into every vault.
- `tools/reference_decrypt.py` — an independent decrypter written only from
  FORMAT.md. CI checks it produces the same output as `vault-export`.

## Building

Builds run automatically on GitHub Actions (Windows and Linux) on every push.
The Windows build is attached to each run as the `MediaVault-windows` artifact.

Locally: `cargo test --workspace --release` (toolchain pinned in `rust-toolchain.toml`,
dependencies pinned in `Cargo.lock`).
