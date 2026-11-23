# Media Vault — guide for Claude Code

This repo is **Media Vault**, the user's Windows desktop app. It is one of three apps that share files with each other:

| App | Where | Role in file sharing |
|---|---|---|
| **Media Vault** (this repo) | Windows PC | Server: listens on the home network while its vault is unlocked |
| **Baro Alarm** (Android, Kotlin) | Phone; separate Claude project "Notes and alarm android app" | Client: hidden vault, page "Aktarım" |
| Phone launcher's file manager (Android) | Phone; separate project | Not connected yet. Nothing in this repo knows about it |

The shared protocol is **MVTP/1 revision 2**, in `docs/transfer-protocol.md`. It is a contract between projects:
see "Sharing and networking" below before changing anything in it.

## 0. Where the code lives and how work is done (GitHub)

- **The code lives only on GitHub:** https://github.com/mrbbnbrn/media-vault (public), branch **`main`**. There is no
  other copy of the source. The user's PC runs the released app; it doesn't build it.
- **A copy of this file** sits in the user's shared folder `C:\Users\PC\OneDrive\ALL CLAUDE\CONNECTED APPS\Media Vault\`
  (next to the other apps' guides). That copy is for reading only: change this file in the repo, then copy it there.
- **Getting the code:**
  - Claude Code in the cloud (the usual way): attach the repo `mrbbnbrn/media-vault` with push access, then
    `git clone https://github.com/mrbbnbrn/media-vault /home/claude/media-vault`.
  - On the user's Windows PC (only if asked): clone **outside OneDrive** (e.g. `C:\dev\media-vault`), because
    `node_modules` and `target` must not sync. Building there needs Rust 1.97 (rustup), Node 22, and the Visual Studio
    C++ build tools.
- **Every working session:** `git pull` first → change → run the checks in section 4 → commit on `main` → push when
  the batch is finished. There are no pull requests or feature branches for normal work; helper agents may use
  temporary local branches/worktrees that are merged into `main` with `--no-ff` before pushing.
- **Commit messages:** a plain title; `[skip ci]` for docs and notes; `[quick]` only for small fixes (section 4). End
  every commit message with the attribution lines the session gives (e.g. `Co-Authored-By: Claude … <noreply@anthropic.com>`
  and the session link).
- **Each push to `main` builds and releases** (section 4). After pushing:
  ```bash
  gh run list -L 1                                   # the new run
  gh run watch <run id> --exit-status                # wait for it
  gh api 'repos/mrbbnbrn/media-vault/releases?per_page=1' -q '.[0].tag_name'   # e.g. build-101
  ```
  In cloud sessions GitHub's GraphQL is blocked, so `gh release list` fails: use `gh api` (REST) as above. Failing Rust
  tests on CI show as annotations: `gh api repos/mrbbnbrn/media-vault/check-runs/<job id>/annotations`.
- **Then tell the user** the build number. They update by downloading `MediaVault-app-windows.zip` from that release,
  closing the app and unzipping it over their MediaVault folder.

---

## 1. What the app does

A dark, fully offline, encrypted media library. The user makes folders and **person folders**, imports pictures, GIFs,
videos, PDFs and text files, and browses them. Everything lives in an encrypted **vault** (a folder on any drive);
several vaults can exist, one is open at a time.

Main features:
- **Library:** folders with covers, tags (folder tags are inherited), favourites, weights (0–1000), notes, trash
  (30 days), sorting, search, free copies, duplicate detection, rubber-band selection, tabs, drag in/out of Explorer.
- **Import:** files, folders, `.7z` and split archives (including password-protected), all streamed straight into the
  vault. Duplicates in the same folder are skipped by SHA-256.
- **Viewer:** pictures, GIFs, videos, PDF, text; zoom, bookmarks, an editor that saves copies, MP4 cutter, GIF maker,
  AI upscaler, rotate, info panel.
- **Slideshows:** many transitions (including edit-style ones), beat sync to the PC's own sound, beat drop, montage,
  speed ramp, looks (Mirror world, Echo trail), per-folder settings and resume.
- **Multi-screen:** many player windows in grids and shapes, a free-form layout editor, and modes Wall, Mosaic, Breathe,
  Breathing, Pulse, Parallax.
- **Faces:** offline face recognition, People page, auto-naming, sort into person folders, face wall, best faces,
  face time-lapse.
- **3D photos:** depth models, subject outlines, Lift-off, Layered 3D, background fill; all results saved encrypted.
  Videos and GIFs get the same 3D once **prepared** (every frame worked out once, saved, then played frame-exact).
- **Discovery river**, museum, memories, duel, slot machine, statistics, today's pick.
- **Phone transfer:** pair a phone once, then send pictures and videos both ways over home Wi-Fi.
- **Safety:** auto-lock (idle, Windows lock, minimise), panic key Ctrl+Shift+L, hide from screenshots, 24-word recovery
  key, vaults with no password or no encryption (user's choice), library backups.
- **Rescue:** `vault-export.exe` and `tools/reference_decrypt.py` can decrypt a vault without the app.

## 2. Tech stack and versions

| Part | Version / choice |
|---|---|
| Rust | **1.97.0**, pinned in `rust-toolchain.toml`; edition 2024; Cargo workspace, `Cargo.lock` committed |
| App shell | **Tauri 2.12.3** (wry 0.57), plugins dialog, notification 2.5.0, global-shortcut |
| Web engine | **Microsoft WebView2**. The full package ships its own copy in `WebView2\`; falls back to Windows' own |
| Window UI | **React 19.3**, **TypeScript 5.9.3**, **Vite 7.3.7**, **Vitest 3.2.7**, Node **22** |
| Window libs | three 0.186.1, pdfjs-dist 6.4.299, gifenc 1.0.3, IBM Plex fonts (bundled) |
| Database | SQLite through **rusqlite 0.40.2** (bundled), held in memory, saved as one encrypted object |
| Crypto (vault) | RustCrypto: aes-gcm 0.11, argon2 0.6, hkdf 0.13, sha2 0.11, bip39 3.0, zeroize |
| Crypto (transfer) | p256 0.14 (ECDH, ECDSA), hmac 0.13, hkdf 0.13, sha2 0.11, getrandom 0.4 |
| Media | image 0.25.10 (jpeg/png/webp/gif), libwebp-sys 0.14.4, jpeg-encoder 0.7, sevenz-rust2 0.24 (AES) |
| AI | ort 2.0.0-rc.14 → **ONNX Runtime 1.24.4 + DirectML**, loaded at run time from optional model packs |
| Video tool | ffmpeg (BtbN LGPL win64 build `autobuild-2026-09-30-13-08`), optional, in `tools\` |
| Windows APIs | windows 0.62, windows-sys 0.61, webview2-com 0.39 |
| Target | Windows 10/11 x64. Development and most tests run on Linux |

## 3. Folder structure and key files

```
Cargo.toml, Cargo.lock, rust-toolchain.toml   workspace: crates/vault-core, crates/vault-export, app/src-tauri
crates/vault-core/       the vault: crypto, packs, encrypted objects, SQLite schema
  FORMAT.md              the on-disk format, byte by byte; copied into every vault
  src/crypto.rs          AES-GCM seal/open, key wrapping, HKDF
  src/vault.rs           create/open/unlock a vault, add/read/delete objects
  src/pack.rs            ~1 GiB pack files holding many encrypted objects
  src/stream.rs          chunked (1 MiB) streaming encryption, random-access reading
  src/db.rs              library schema (SCHEMA_VERSION = 21) and in-place upgrades
  src/export.rs          list and export items (used by vault-export)
  src/multipart.rs       reading split archives as one stream
  examples/make_demo_vault.rs   makes a test vault (used by CI)
crates/vault-export/     vault-export.exe: info / verify / export / dump-db without the app
tools/reference_decrypt.py   independent Python decrypter written only from FORMAT.md (CI compares it)
docs/transfer-protocol.md    MVTP/1 r2, the phone protocol (shared with the phone apps)
docs/mvtp_ref.py             Python reference that regenerates and checks the protocol test vectors
packaging/README.txt     the readme shipped next to MediaVault.exe
.github/workflows/build.yml  test + package + release on every push to main
.github/workflows/*.yml  model-pack builds (depth, subject, inpaint, faces, upscaler)

app/src-tauri/           Rust backend (crate media-vault-app, binary MediaVault)
  tauri.conf.json        window, CSP, identifier app.mediavault.desktop
  capabilities/default.json   what the window may call
  selftest/              sample media for the built-in self-test
  src/main.rs            entry point (mimalloc)
  src/lib.rs             setup, generate_handler! (every command), unlock/lock plumbing
  src/session.rs         the open vault: Session (db, vault, save, is_closed)
  src/cmd_vault.rs       create/unlock/lock/recover/password commands
  src/cmd_library.rs     folders, items, tags, moves, trash
  src/cmd_media.rs       viewer-side commands (rotate, saves, conversions)
  src/cmd_faces.rs, cmd_similar.rs, cmd_misc.rs   faces, look-alikes, everything else
  src/library.rs         folder/tag/query helpers (get_or_create_folder, tag_items, tag_folder)
  src/import.rs          importing files/folders/archives; supported extension lists
  src/protocol.rs        vault:// and local:// URL schemes: decrypted media streamed to the window, Range support
  src/config.rs          app settings (config.json), cleaned on load
  src/storage.rs         reclaiming space, compaction, storage reports
  src/videotool.rs       ffmpeg runs (input from the in-app server, output to stdout)
  src/faces*.rs, faceid*.rs   face detection and recognition
  src/depth.rs, subject.rs, inpaint.rs, upscale*.rs   ONNX models; gpuroom.rs shares the graphics card
  src/derived.rs         saved depth maps, outlines, plates, videos' prepared 3D ("track") (encrypted)
  src/video3d.rs         prepared 3D for videos: ffmpeg decodes frames (+ exact times) for the window
  src/encryption.rs, plainfiles.rs   turning encryption on/off; vaults without encryption
  src/picture.rs, thumbpages.rs, sketch.rs   native decoding, thumbnails, thumbnail pages
  src/userbusy.rs        background work steps aside while the user is busy
  src/diaglog.rs, crashguard.rs, selftest.rs   diagnostics log, WebView2 crash recovery, CI self-test
  src/transfer/          phone transfer (see section 6)
    mod.rs               commands + start/stop hooks
    mvtp.rs              the protocol: crypto, frames, packets, messages; vector tests
    vectors.json         shared test vectors (identical to the phone projects' copy)
    store.rs             identity key, paired phones, landing folder (inside the encrypted library)
    items.rs             what to offer, answering offers, recording received items, name cleaning
    server.rs            listening, UDP discovery answers, pairing, session handshake, status for the window
    conn.rs              one connected phone: keep-alive, receiving into the vault, sending from it
    playable.rs          JPEG/MP4 copies of HEIC/MOV etc. (originals kept)
    tests_e2e.rs         a fake phone over real sockets

app/src/                 React window
  main.tsx               imports keyguard.ts first
  App.tsx                shell: screens, global keys, mouse back/forward, lock
  api.ts / apitypes.ts   every backend call / types and defaults
  apimock.ts, mock*.ts   demo mocks (browser demo, tests)
  screens/Library.tsx    the library; mediaActions(...) = the ONE action list for all item menus
  screens/Viewer.tsx, components/Player.tsx   viewer, slideshow settings, every player window
  screens/MultiScreen.tsx, Settings.tsx, Start.tsx, CreateVault.tsx, Recover.tsx
  components/PhoneTransfer.tsx, transfer.ts, transferlogic.ts, mocktransfer.ts, phoneoriginal.ts   phone transfer UI
  presets.ts             PlaybackSettings (normalize old saves)
  video3d.ts, video3dworker.ts, video3dmath.ts   preparing 3D for videos/GIFs (queue, calming, tiles, encoding)
  track3d.ts, trackformat.ts   prepared 3D: saved format, finding it, TrackPlayer (frame-exact decoding)
  components/Prepare3D.tsx     "Prepare 3D" dialog + Settings → AI & 3D → Videos and GIFs
  (plan and as-built notes: docs/video-3d-plan.md)
  messages.ts, text.ts, components/Dialogs.tsx, keylayers.ts, calm.ts, bgpace.ts, jobs.ts   shared helpers
  styles.css + styles/*.css   theme variables and styles
```

## 4. Build, run and test

**One-time setup (Linux)**
```bash
apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev
cd app && npm ci
```
If the pinned toolchain can't be downloaded and the installed `stable` is 1.97.0, prefix cargo with
`RUSTUP_TOOLCHAIN=stable`.

**Checks before every commit** (all must pass)
```bash
cd app && npx tsc --noEmit -p .                   # clean
cd app && npx vitest run                          # ~586 window tests
cd app/src-tauri && cargo test -q --lib           # ~340 backend tests; first build 10+ minutes
cd app/src-tauri && cargo clippy -q --lib --tests # clean (CI uses -D warnings on the whole workspace)
cargo test -q -p vault-core                       # from the repo root
```
- One area only: `cargo test -q --lib transfer::` (protocol vectors + fake phone).
- `npm run lint` isn't configured. `cargo fmt --check` shows old unrelated diffs: don't mass-reformat.
- CI runs `cargo test --workspace --release --locked` and `cargo clippy --workspace --all-targets --locked -- -D warnings`.

**Browser demo (no backend, no device)**
```bash
cd app && npx vite --port 5176 --strictPort      # then open http://localhost:5176/?demo, password: password
```
Extras in the address: `beatdemo` (fake music), `phone` (a paired, connected phone), `people`, `griddemo=N`.
In the console: `window.__fakeReceive(n)`, `window.__fakeDisconnect(true|false)`, `window.__fakeBeat(strength, level)`.

**Run the real app**
- Windows: `cd app && npx tauri dev` (starts Vite on 5173 itself), or `npx tauri build --no-bundle` →
  `target\release\MediaVault.exe`. Linux builds run for testing only.
- Self-test (what CI runs on Windows): `MV_SELFTEST=1 MediaVault.exe`, result in `MV_SELFTEST_OUT` or stdout, exit 0 = pass.
- Model packs and ffmpeg are optional; for local tests point to them with `MV_FFMPEG`, `MV_FACES`, `MV_DEPTH`,
  `MV_SUBJECT`, `MV_INPAINT`, `MV_UPSCALER` (folder paths).

**Things that wait for input**
- `vault-export info|verify|export|dump-db <vault> …` asks for the password on the terminal (no echo). With
  `--recovery` it reads the 24 words from stdin. A vault without a password opens without asking.
- The app itself waits for a password on its start screen. No device needs to be connected for anything; the phone
  transfer is tested with the fake phone in `tests_e2e.rs`.

**Releases:** every push to `main` runs `.github/workflows/build.yml` → GitHub Release `build-N`
(`MediaVault-app-windows.zip`; the web engine and video tool are separate one-time downloads). The release stays a
draft until the Linux and Windows tests pass.
- Push only finished batches, never while a previous build's Windows tests still run (`gh run list -L 1`).
- `[quick]` in the last commit message skips the Windows tests (small fixes only; never write that word in brackets
  otherwise). `[skip ci]` = no build, no release (docs, notes, housekeeping).

## 5. Data formats and where data is stored

**A vault** (any folder the user picks; full byte layout in `crates/vault-core/FORMAT.md`)
```
vault.json, vault.json.bak   header: format, version, vault_id, kdf settings, wrapped master key slots
meta.db.enc                  the SQLite library, encrypted as one object
meta-backups/                up to 5 older library copies
packs/media-NNNNNN.pack      encrypted media (~1 GiB each; magic MVPK, entries MVPE)
packs/thumbs-NNNNNN.pack     encrypted thumbnails, previews, derived data
Files/                       only in a vault without encryption (version 4): ordinary files
FORMAT.md                    format description;  .lock  one writer at a time
```
- `version`: 1 = one file per object, 2 = packs, 3 = packs without a password, 4 = not encrypted.
- One random 256-bit master key, wrapped by the password (Argon2id) and by a 24-word BIP-39 recovery key (HKDF).
  Each object has its own key; content is AES-256-GCM in 1 MiB chunks.
- **No other app may write into a vault.** Other apps exchange files with it only through the phone transfer.

**The library database** (inside `meta.db.enc`; `crates/vault-core/src/db.rs`, `SCHEMA_VERSION = 21`)

| Table | Fields worth knowing |
|---|---|
| `folders` | id, parent_id (NULL = top), name (unique per parent, case-insensitive), sort_order, created_at (s), cover_media_id, pinned, color, emoji, person (1 = person folder), deleted_at (**ms**) |
| `media` | id, object_id, folder_id, kind (`image` `gif` `video` `text` `pdf`), original_name, ext, size, width, height, duration_ms, sha256 (lowercase hex), imported_at (s), taken_at (s; 0 = unknown), file_mtime (s), favourite, weight, views, last_viewed_at, deleted_at (**ms**) |
| `tags`, `media_tags`, `folder_tags` | tag names; an item's own tags; a folder's own tags (inherited by everything inside, never copied onto items) |
| `bookmarks` | media_id, position_ms, note — video bookmarks |
| `objects` | object_id, kind, pack, offset, length — where each encrypted object lives |
| `faces`, `face_rejects`, `face_not_same`, `face_graph` | detected faces, names, answers |
| `derived` | saved depth maps, outlines, plates per item and model |
| `settings` | key/value. Feature keys: `transfer.identity`, `transfer.peers`, `transfer.landing`, `playable:<id>`, `faces_off_folders`, `previews_off_folders` |
| also | `presets`, `layouts`, `free_layouts`, `plain_files`, `thumb_bundles`, `folder_stats`, `clip` (unused) |

- A schema change bumps `SCHEMA_VERSION` and upgrades old libraries in place at unlock. New `IF NOT EXISTS` tables and
  new `settings` keys don't need a bump.

**App settings on the PC** (no secrets, no media)
- `config.json` (+ `config.json.bak`) in the `data` folder next to `MediaVault.exe` when that folder is writable
  (portable mode), else `%APPDATA%\MediaVault\`. JSON, camelCase keys (`lock`, `viewer`, `look`, `accent`, `vaults`,
  `lastVault`, `poorFaces`, …). Read with defaults for missing keys and cleaned on load (`config.rs`).
- Same folder: `diagnostics.log` (steps and sizes only), `gpu-fit.json` (model sizes on the graphics card).
- Window-only conveniences use `localStorage` (e.g. `mv-prep-inuse`); never pictures.

## 6. Sharing and networking

Everything here follows `docs/transfer-protocol.md` (MVTP/1 r2). Summary:
- **Roles:** the phone app is always the client and never listens. Media Vault is the server.
- **When it listens:** only while a vault is unlocked **and** (a phone is paired **or** pairing mode is on). It stops
  on lock and when the last phone is forgotten. Only private IPv4 addresses (10/8, 172.16/12, 192.168/16, 169.254/16,
  loopback) are accepted; IPv6 is not used.
- **Ports:** TCP **47630** (falls back to any free port, reported in discovery answers), UDP **47631**.
- **Discovery:** the phone broadcasts `PAIR_DISCOVER` (only answered in pairing mode) or `DISCOVER` with an HMAC made
  from the pair key, a timestamp (±10 min) and a nonce (replay cache 20 min). Strangers get no reply at all.
- **Pairing:** user presses "Pair a phone" on the PC (2 minutes). Commit → keys → reveal, then a **6-digit code** shown
  on both screens; the user confirms on both. Each side stores the other's P-256 identity key and a 32-byte pair key
  **inside its encrypted vault**. Re-pairing with a known key replaces the entry.
- **Session:** fresh ECDH each connection, signatures from both identity keys, HKDF → one AES-256-GCM key per
  direction. Frames: `u32 length | body`, max 65 600 bytes, nonce = counter. PING after 15 s idle, close after 45 s silent.
- **Messages:** JSON `INFO`, `OFFER` (≤1000 items, with folder tree and each folder's own tags), `ANSWER`
  (`want` / `have` / `cant` / `nospace`), then binary `ITEM_START`, `DATA` (≤64 KiB), `ITEM_END` (SHA-256), `ITEM_OK` /
  `ITEM_FAILED`, `CANCEL`, `LOCKED`, `BYE`.
- **Item fields:** sha256, name, size, kind (`image` `gif` `video` `pdf` `text`), mime, w, h, dur_ms, taken (ms or null),
  fav, tags (own only), marks `{ms, note}`, folder. Item refs chosen by the PC are `1…0x3FFFFFFF`; the phone's start at
  `0x40000001`.
- **This app as receiver:** takes `image`, `gif`, `video`; skips anything whose SHA-256 is already in the vault; stores
  into **"Received from phone"** (remembered by id, recreated if deleted) keeping the sender's folders; HEIC/HEIF/AVIF/
  BMP/TIFF and MOV/MKV/3GP/AVI/TS/… are kept as originals plus a playable JPEG/MP4 copy.
- **One phone connected at a time** (a new connection replaces the old). Several phones can be paired; each is told
  apart by its identity key, and `INFO.app` names the app (`"mediavault"`, `"baroalarm"`). A new app (e.g. the launcher's
  file manager) can use the same protocol as another client, with its own identity and pairing.
- **Windows permissions:** the first listen triggers the Windows firewall prompt (choose "Private networks"). Routers
  with Wi-Fi client isolation block it.
- **Tests:** `transfer/vectors.json` must equal the phone projects' copy; `docs/mvtp_ref.py` regenerates it byte for byte.
- **Other networking:** none. The window talks to the backend only through Tauri IPC and the `vault://` / `local://`
  schemes (in-process). ffmpeg reads from a `127.0.0.1` server inside the app.

## 7. Rules that must not break

1. **Originals are never deleted or changed.** Edits, rotations and conversions are saved as copies.
2. **Nothing decrypted is ever written to disk** in an encrypted vault (media, thumbnails, maps, caches, database,
   transfer data). ffmpeg never gets a temp file. Only a vault the user made without encryption keeps plain files.
3. **Fully offline.** No internet, accounts, telemetry or update checks. The phone transfer is home-network only.
4. **The vault format is a promise.** A format change needs FORMAT.md, `vault-export`, `tools/reference_decrypt.py`
   and an in-place upgrade, together.
5. **The phone protocol changes only with the phone projects.** A change to `docs/transfer-protocol.md`,
   `transfer/mvtp.rs` wire behaviour or `vectors.json` must be agreed for every app that speaks it, and copied to them.
   The user carries messages between project chats: write a paste-ready prompt for the other chat.
6. **Lock means lock:** keys and decrypted data are wiped, background work stops, the phone gets `LOCKED`, the
   transfer stops listening. Both vaults must be unlocked for a transfer.
7. **One action list:** item and folder menu entries go into `mediaActions` (Library.tsx), not into one menu only.
8. **New backend command = four places:** the command, `generate_handler!` in `lib.rs`, a wrapper in `api.ts`, a mock
   in `apimock.ts`.
9. **Settings style:** new fields read old saves safely (serde defaults in `config.rs`, `normalize` in `presets.ts`);
   settings live in Settings pages (Appearance, Viewer, Security, Storage, Background work, AI & 3D, Phone transfer,
   About); per-vault data goes in the library's `settings` table, never in plain files.
10. **UI:** dark only, teal accent `#2ec4b6`; plain, friendly English without jargon; messages through
    `say(text, 'note'|'done'|'problem')`; overlays use `useLayer` and check `layer.mine()`; long jobs show in the jobs
    ring, can be stopped and stop on lock; background refreshes go through `calm.ts`.
11. **Removed on purpose, don't bring back:** smart search, Living subject, A light that stays put, Out of the frame.
12. **Shell:** stop processes by exact pid (never `pkill -f` / `pgrep -f`); no `git reset --hard`; don't mass-reformat.

## 8. Notes, state and how to record changes

The project's notes live in the **claude.ai Project "A windows media browsing program"**, folder `claude/`:
- `claude/context.md` — **read first**: current build, how the user likes to work, code map, open threads.
- `claude/pending-changes.md` — build-by-build log (newest first) and the user's working preferences.
- `claude/spec.md` (older, up to build 92), `claude/wifi-transfer-plan.md`, `claude/transfer-protocol.md`,
  `claude/transfer-vectors.json`, `claude/mvtp_ref.py`, idea lists `claude/ideas-*.md` (next free idea number in
  context.md).

How to record changes:
- **With the Projects tool:** `project_read` the doc, change it, `project_write` the whole doc back. After each build,
  add an entry at the top of `pending-changes.md` (⏳ waiting, 🚀 pushed, ✅ released) and update the build number,
  build history and open threads in `context.md`.
- **Without it (plain Claude Code):** add a dated line to "Recent changes" below and say so in the commit message;
  the next chat with the Project folds it into the notes. Protocol changes also go into `docs/transfer-protocol.md`.
- How the user works: plain short answers; S / M / B estimates (minutes / ~1 h / several hours); collect requests and
  build only after "go" (small bug fixes right away); ask questions directly; push once per finished batch.

### Recent changes
- 2026-11-23 (Claude Code on the user's PC, later): **More layers fix** after the user saw the background behind
  near things left unfilled: on soft depth edges (real depth models) a jump made thin extra rim layers and the cut sat
  off-centre; now one cut per jump in its middle, the fill reaches everywhere behind nearer things, small bits merged
  until none left; saved layers get `r2` in their tag (older ones made again). `layersmath.ts`, `looklayers.ts`,
  tests. Details: `docs/picture-3d-looks-plan.md` "Fix after the user's first try". Not tried in the real app yet.
- 2026-11-23 (Claude Code on the user's PC; fold into the Project notes): **five 3D looks for pictures**
  (`docs/picture-3d-looks-plan.md`, approved by the user; as-built notes at its end). All pictures only, off by
  default, each its own switch in 3D ▾ (now in groups: Motion · Subject · Looks · Edges and layers · Save) and its
  settings in 3D photo settings: **Focus** (lens blur by depth in a second pass; on the subject / under the mouse /
  the biggest face; focus pull; blur, sharp range, round lights, miniature), **Depth light** (light and crease shade
  from the depth texture's new facing/crease channels; follows the camera / mouse / slow sweep / one side; none near
  depth jumps), **Border fill** (a painted border, Simple / MI-GAN / LaMa; less zoom or bigger moves, switchable;
  plain edges carried on), **More layers** (the picture cut at real depth jumps into up to 3–4 layers, each with its
  band behind nearer things filled and its own depth; slopes never cut), **Wiggle** (the camera jumps between 2–4
  views; 3D ▾ → Save wiggle as GIF saves those views next to the picture, Ctrl+Z undoes). Border fill and More layers
  are made off the window's thread (`lookworker.ts`, `looklayers.ts`), saved as `derived` kind `plate` with their
  own tags (no schema change), and made by Prepare 3D data too. Config: `depthFocus*`, `depthLight*`,
  `depthBorder*`, `depthMulti*`, `depthWiggle*` (`config.rs`, cleaned on load). Checked: tsc, 630 vitest, the looks
  drawn in Chromium on a generated scene; CI (Rust + Linux/Windows tests) passed. Released as **build-108**. Not tried
  in the real app yet.
- 2026-11-23 (Claude Code on the user's PC; fold into the Project notes): **video 3D: the Prepare 3D window** (asked
  by the user). Prepare 3D (viewer 3D ▾, or right-click a video, a selection or a folder) opens a window where each
  effect is ticked with its model: Depth (always; depth model), Lift-off (+ amount), 3D only on the subject, Sharper
  depth edges (+ strength), Layered 3D (fill model + fill every 1st/2nd/3rd frame), the outline model (when a ticked
  effect needs it), 3D detail, frames, calmer camera; live estimate; remembers the last choices (config
  `video3d_lift`, `_lift_amount`, `_subject_only`, `_edges`, `_edges_amount`, `_layered`; `video3d_parts` retired).
  **Each video keeps its choices** in its track index (`TrackIndex.choices`, `trackformat.ts`) and plays with only
  those (`trackLook`): the pictures' Lift-off / Layered 3D / … switches never apply to videos and GIFs (greyed out in
  3D ▾ for them). Old prepared videos (no choices) play with everything their 3D holds. **Preparing again replaces**
  what the video had (`forgetOthers`); when the models and baked parts are the same, only how it plays (Lift-off,
  3D only on the subject, calmer camera) is saved, with nothing to prepare. Settings → AI & 3D → Videos and GIFs now
  only shows what's being prepared, the space, Stop and "Delete all 3D data for videos and GIFs". Files:
  `Prepare3D.tsx`, `video3d.ts`, `trackformat.ts`, `Player.tsx`, `DepthSettings.tsx`, `Depth3D.tsx`, `apitypes.ts`,
  `config.rs`, tests. Checked: tsc, 603 vitest, the window in the browser demo. Released as build-107; the user
  tried it in the app: works.
- 2026-11-23 (Claude Code on the user's PC; fold into the Project notes): **video 3D: choices and speed.** Settings →
  AI & 3D → Videos and GIFs: **What to prepare** (depth only / + outline / everything), **Fill the background** on
  every 1st/2nd/3rd frame (frames between reuse the fill; a new scene always gets its own), and **models for videos**
  (depth, outline, fill; "same as pictures" by default). **Batching:** `depth_estimate_many` / `subject_estimate_many`
  (several frames per call, one turn on the card; depth runs them as one batch when the model takes it, else one
  by one inside the call). **Video depth model** "Video (steady)" = Video Depth Anything Small (Apache-2.0):
  depth.json `"frames": 32`, run as 1 × 32 × 3 × 518 × 518 with one depth range per run; preparing sends runs of 32
  that overlap by 8 and lines each run up with the one before (`alignTo`). It is offered for videos only (pictures'
  list hides it; never picked automatically). Its pack is built by `.github/workflows/videodepth.yml` +
  `.github/scripts/vda_export.py` (converted from PyTorch, checked against it; runs by hand or when those files
  change) → `MediaVault-depth-vda-small-windows.zip` on a `depth-models-<date>` pre-release. Tags carry the parts
  (`noplate`, `_n<k>`). 600 window tests; settings checked in the browser demo. Rust not compiled here (CI);
  the video model not tried in the app (DirectML may refuse it: then it runs on the processor, slowly).
  Released as **build-105**. The pack workflow needed a 12 GB swap file and a newer `ml_dtypes`; it then passed
  (ONNX = PyTorch, correlation 1.00000; background drift between frames ~1 %; model.onnx 678 MB) and uploaded
  `MediaVault-depth-vda-small-windows.zip` (124 MB) to the `depth-models-2026-11-22` pre-release. `build.yml` now
  skips pushes that only change `videodepth.yml` / `vda_export.py`.
- 2026-11-23 (Claude Code on the user's PC; fold into the Project notes): **video 3D fixes after the user's first
  test** (dark specks with Lift-off / the subject layer, slow preparing). Shader reads a video's outline without the
  codec's faint noise (`smoothstep` in `mask()`); the last prepared frame is kept up to 4 frames while the next one
  decodes (no flat flash). Preparing: works in blocks of 24 frames, one model over the block at a time (the card
  keeps one model loaded when they don't all fit, so depth → outline → fill per frame could reload them every
  frame); each frame is also calmed with the 2 frames after it (worker finishes frames 2 late); stored outline
  snapped clean (`cleanMask`); encoder budget 0.05 → 0.09 bits/pixel. Tags now end `_v2` (`TRACK_WAY`): videos
  prepared before still play, the 3D menu offers "Prepare 3D again". 599 window tests; worker/player/shader checked
  in Chromium (0 background specks from noisy outlines). Not tried in the app yet.
- 2026-11-22 (Claude Code on the user's PC; fold into the Project notes): **prepared 3D for videos and GIFs**
  (`docs/video-3d-plan.md`, approved by the user). Live video depth, "Delay videos slightly" (and
  `playeraudio.ts`) and GIF depth-on-open are gone. A video/GIF is prepared once when asked (viewer 3D ▾ → Prepare
  3D…, or right-click → 3D data → Prepare 3D for videos and GIFs…): ffmpeg decodes its frames with their times
  (`video3d.rs`), each frame goes through the depth, outline and fill models in use, is calmed over time (only
  where nothing moved; steady depth range; background seen earlier fills behind the subject), packed into 3 × 2
  tiles and encoded with WebCodecs in a worker; 48-frame pieces + an index are saved as `derived` kind `track`
  (tag = models + settings). Playing: `TrackPlayer` decodes ahead and hands each video frame (rVFC `mediaTime`) its
  own prepared frame; the shader reads all maps from that one texture, so Lift-off, Layered 3D, 3D only on the
  subject and sharper edges work on videos. Settings → AI & 3D → Videos and GIFs: detail 512/768/1024, every
  frame / every 2nd, calmer camera, size + "Delete all 3D data for videos and GIFs"; Delete 3D data… lists them too;
  the pictures' clear/redo leave them alone (`derived_clear` kind "pictures"). Config: `depthVideoDelay` replaced by
  `video3dSize`, `video3dEvery`, `video3dCalm`. Window: 597 tests pass; worker/player/shader checked in Chromium.
  Rust not compiled on that PC (CI first); nothing tried in the real app yet.
  **Library schema 21** (same day, after CI): the v18 `derived` table's CHECK only took 'depth' and 'outline', so
  Layered 3D's saved layers ('plate', 'fore') were always refused (silently: plate.ts only warns) and 'track' too.
  v21 makes the table again with all five kinds, keeping every row (`db.rs`, FORMAT.md). Older builds can't open a
  library once a v21 build has opened it.
- 2026-11-22 (Claude Code on the user's PC; fold into the Project notes): 12 bugs fixed, found by checking an outside
  review against the code. Vault: reclaiming space right after unlock no longer copies the last pack onto itself
  (`pack.rs` `compact_until`; reported freed bytes now true); removing objects marks the library for saving
  (`import::remove_objects`, `storage::delete_folder_previews`), so the pack index change can't be lost on lock/exit.
  Faces: no deadlock between "delete face data" and a running analysis (`delete_faces_of` only `try_lock`s CACHE);
  "Not the same person" pairs (person folder ids) are no longer deleted by face ids: trigger now
  `face_not_same_folder_gone` on `folders`, the old `face_not_same_gone` is dropped whenever found (no version bump).
  Transfer (no wire change): the receive frees itself right after the last ITEM_OK, before saving and playable copies,
  so the phone's next OFFER isn't refused (copies one batch at a time; an OFFER in the last moment waits ≤3 s);
  `transfer_cancel` is async and never blocks; a handshake during lock keeps no connection, `read_full` stops on lock;
  failed pairing shuts its socket. Window: Delete 3D data shows and names all 4 kinds (plate/fore were deleted
  unseen); drag-move ends without dropping on pointercancel/blur (drag-out to Explorer moved items); timing panel is
  Ctrl+Shift+Alt+T so Ctrl+Shift+T reopens tabs; video preview players are emptied on lock. `reference_decrypt.py`:
  duplicate names get " (2)" like vault-export. New tests: pack, db, 3 fake-phone, dragmove, videopool, keylayers.
  Rust was not compiled on that PC (no toolchain): CI was the first compile.
- 2026-11-15: section 0 (GitHub way of working); a copy of this file placed in `CONNECTED APPS\Media Vault\`.
- 2026-11-15: CLAUDE.md written; `docs/transfer-protocol.md` and `docs/mvtp_ref.py` added (copies of the Project docs).
- Build 100 (2026-11-08): PC item refs stay below 0x40000000; CANCEL routed by ref range.
- Build 99 (2026-11-08): phone transfer, PC side (`app/src-tauri/src/transfer/`, Settings → Phone transfer).
