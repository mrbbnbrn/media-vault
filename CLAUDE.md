# Media Vault

A dark, fully offline, encrypted media library for Windows. The user makes folders and person folders, imports
pictures, GIFs and videos, and browses them with a viewer, slideshows, favourites, tags, weights, face recognition,
3D photos, a large Multi-screen section, a discovery river, and a Wi-Fi transfer with the user's Android phone app.

- Backend: **Tauri 2 + Rust**, `app/src-tauri` (crate `media-vault-app`).
- Window: **React 19 + TypeScript + Vite**, `app/src`.
- Core vault: `crates/vault-core` (encryption, packs, SQLite schema). `crates/vault-export` is the standalone export tool.
- Target: Windows 11, WebView2. Development and most tests run on Linux.

## Rules that must not break

1. **Originals are never deleted or changed.** Edits, rotations and conversions are saved as copies.
2. **Nothing decrypted is ever written to disk** in an encrypted vault. Media, thumbnails, maps, caches and the
   database are decrypted in memory only. ffmpeg reads from the in-app `127.0.0.1` server and writes to stdout
   (`videotool.rs`); never give it a temp file. The one exception is a vault the user made without encryption,
   whose media are ordinary files under `Files/`.
3. **Fully offline.** No internet, accounts, telemetry or update checks. The only networking is the phone transfer,
   on private home-network addresses (IPv4), and only while the vault is unlocked and a phone is paired or pairing.
4. **The vault format is a promise.** `crates/vault-core/FORMAT.md` is copied into every vault and must stay exact.
   Any format change needs: FORMAT.md, `vault-export`, `tools/reference_decrypt.py`, and an in-place upgrade path.
5. **The phone protocol (MVTP/1) is shared with another project.** Don't change `transfer/mvtp.rs` wire behaviour or
   `transfer/vectors.json` unless the same change is agreed for the phone app. The vector tests must keep passing.
6. **On lock:** keys and decrypted data are wiped, background work stops, the phone is told (`transfer::stop()`).
7. Dark UI only, teal accent `#2ec4b6`. UI text in plain, friendly English without jargon.
8. Don't bring back removed features: smart search, Living subject, A light that stays put, Out of the frame.

## Build and test

```bash
# once, on a fresh Linux machine
apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev
cd app && npm ci

# checks before every commit
cd app && npx tsc --noEmit -p .          # must be clean
cd app && npx vitest run                 # window tests
cd app/src-tauri && cargo test -q --lib  # backend tests (first build takes 10+ minutes)
cd app/src-tauri && cargo clippy -q --lib --tests   # must be clean
cargo test -q -p vault-core              # from the repo root
```

- The toolchain is pinned to Rust 1.97.0 (`rust-toolchain.toml`). If it can't be downloaded and the installed
  `stable` is the same version, prefix cargo with `RUSTUP_TOOLCHAIN=stable`.
- `npm run lint` isn't configured. `cargo fmt --check` shows old unrelated diffs: don't mass-reformat.
- Run one area: `cargo test -q --lib transfer::` (protocol vectors plus a fake phone over real sockets).

**Demo in a browser (no backend):** `cd app && npx vite --port 5176 --strictPort`, then open
`http://localhost:5176/?demo`, password `password`. Every backend call is mocked in `app/src/apimock.ts`.
Extras: `?demo&beatdemo` (fake music beats), `?demo&phone` (a paired, connected phone), `window.__fakeReceive(n)`.

**CI and releases:** every push to `main` runs `.github/workflows/build.yml` and publishes a GitHub Release
`build-N` (Windows zip); it stays a draft until the Linux and Windows tests pass.
- Push only finished batches, and never while a previous build's Windows tests are still running.
- `[quick]` in the last commit message skips the Windows test run; use it only for small fixes, and never write
  that word in brackets otherwise. `[skip ci]` is for commits that need no release (docs, housekeeping).

## Key files

**Window (`app/src`)**
- `main.tsx` imports `keyguard.ts` first. `App.tsx` is the shell (global keys, mouse back/forward, lock).
- `api.ts` (every backend call), `apitypes.ts` (types, defaults), `apimock.ts` (demo mocks).
- `screens/Library.tsx` with `screens/library/*`. `mediaActions(folders, ids, anchor)` is the **one** action list
  for every item menu and the bottom bar: add menu entries there.
- `components/Player.tsx` (the viewer and every multi-screen window), `screens/Viewer.tsx` (slideshow settings).
- `presets.ts`: `PlaybackSettings`. New fields must read old saves safely (normalize).
- `transitions.ts`, `components/ItemTransition.tsx`; `beats.ts`, `beatdrop.ts`; `looks.ts`, `components/MediaLooks.tsx`.
- `screens/MultiScreen.tsx`, `shapes.ts`, `components/{Wall,MosaicWall,BreatheShow,GridModes}.tsx`.
- `components/river/*`; 3D: `depth.ts`, `subject.ts`, `inpaint.ts`, `layers.ts`, `plate.ts`, `derived.ts`.
- Phone transfer: `transfer.ts`, `transferlogic.ts`, `components/PhoneTransfer.tsx`, `phoneoriginal.ts`.
- Shared helpers to reuse, not copy: `messages.ts` (`say(text, 'note'|'done'|'problem')`), `text.ts` (`errText`,
  `fold`), `components/Dialogs.tsx` (Modal, ContextMenu, Dropdown), `keylayers.ts` (`useLayer`), `calm.ts`,
  `bgpace.ts` (`giveWay`), `jobs.ts`, `perf.ts`.
- Styles: `styles.css` holds the theme variables (`--z-*`, `--fs-*`, colours); `screens.css` only imports
  `styles/*.css`. Put rules in the matching file.

**Backend (`app/src-tauri/src`)**
- `lib.rs`: setup, `generate_handler!`, unlock/lock plumbing. `session.rs`: the open vault (`Session`).
- Commands: `cmd_vault.rs`, `cmd_library.rs`, `cmd_media.rs`, `cmd_faces.rs`, `cmd_misc.rs`, plus feature modules.
- `library.rs` (folders, tags, queries), `import.rs`, `storage.rs`, `config.rs` (app settings, cleaned on load).
- `videotool.rs` (ffmpeg), `faces*.rs`, `depth.rs`, `subject.rs`, `inpaint.rs`, `gpuroom.rs` (models sharing the
  graphics card), `derived.rs`, `encryption.rs` + `plainfiles.rs` (vaults without encryption), `userbusy.rs`.
- `transfer/`: `mvtp.rs` (protocol, vectors), `store.rs` (identity, paired phones, landing folder), `items.rs`
  (offer, answer, record), `server.rs` (listening, pairing, handshake), `conn.rs` (one connected phone),
  `playable.rs` (JPEG/MP4 copies of HEIC/MOV and similar), `tests_e2e.rs`.

**Core (`crates/vault-core/src`)**: `crypto.rs`, `vault.rs`, `pack.rs`, `stream.rs`, `db.rs` (schema).

**Adding a backend command:** write it, add it to `generate_handler!` in `lib.rs`, add a wrapper in `api.ts`,
and add a mock in `apimock.ts`. All four, or the demo and tests break.

## Data formats

**Vault on disk** (full byte-level description: `crates/vault-core/FORMAT.md`; read it before touching storage)
- `vault.json` (+ `.bak`): header. `version` 1 = one file per object, 2 = packs, 3 = packs without a password,
  4 = not encrypted (media as files under `Files/`).
- `packs/media-NNNNNN.pack`, `packs/thumbs-NNNNNN.pack`: about 1 GiB each, magic `MVPK`, entries `MVPE`.
- `meta.db.enc`: the SQLite library, encrypted as one object; `meta-backups/` keeps up to 5 older ones.
- Crypto: AES-256-GCM (content in 1 MiB chunks, a key per item), Argon2id for the password, HKDF-SHA256,
  a random 256-bit master key wrapped by the password and by a 24-word BIP-39 recovery key.

**Library database** (`db.rs`, `SCHEMA_VERSION = 20`)
- Main tables: `folders`, `media`, `objects`, `tags`, `media_tags`, `folder_tags`, `faces`, `bookmarks`,
  `derived`, `plain_files`, `free_layouts`, `settings`, `presets`, `layouts`.
- `media.kind` is `image | gif | video | text | pdf`. A file lives in exactly one folder. Folder tags are inherited,
  never copied onto items. `deleted_at` set = in the trash. `sha256` is lowercase hex. Times are unix seconds.
- A schema change bumps `SCHEMA_VERSION` and upgrades old libraries in place on unlock. Tables created with
  `IF NOT EXISTS` and keys in `settings` don't need a bump.
- Settings keys used by features include `transfer.identity`, `transfer.peers`, `transfer.landing`,
  `playable:<id>`, `faces_off_folders`, `previews_off_folders`.

**Phone transfer (MVTP/1 revision 2)**
- The phone is always the client; this app listens on TCP 47630 and UDP 47631.
- P-256 ECDH + ECDSA, HKDF-SHA256, AES-256-GCM frames, big-endian, file data in pieces of at most 64 KiB.
- Pairing by a 6-digit code shown on both sides. Item refs chosen by the PC stay below `0x40000000`.
- Received items land in "Received from phone"; duplicates are skipped by SHA-256.

## Conventions

- New overlays use `useLayer` and check `layer.mine()` in key handlers; Esc/Backspace/mouse-back leave the top layer.
- Background loops call `giveWay()` (window) or check `userbusy` (backend) so the UI stays smooth.
- Long jobs show in the jobs ring (`jobs.ts`), can be stopped, and stop when the vault locks.
- Background-driven refreshes go through `calm.ts`; don't reload the library on every event.
- WebGL: `Depth3D` shares one context; `MediaLooks` uses one per window. WebView2 limits the total.
- Shell: stop servers by exact pid (never `pkill -f`); don't `git reset --hard`.
- Commit only complete, checked work. Keep changes small and in the existing style; comments explain why.
