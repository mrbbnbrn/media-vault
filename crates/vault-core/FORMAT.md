# Media Vault — storage format, version 1

This file is copied into every vault so the format is never lost. It describes
everything needed to decrypt the vault with any programming language, without
the Media Vault app. Only public, standard algorithms are used:

- **AES-256-GCM** (NIST SP 800-38D), 12-byte nonce, 16-byte tag appended to the ciphertext
- **Argon2id**, version 0x13 (RFC 9106)
- **HKDF-SHA256** (RFC 5869)
- **BIP-39** English word list, for the 24-word recovery key
- **SQLite 3** database file format

The easiest way to get your files out is `vault-export.exe` (shipped with the
app). This document is the fallback if that tool is ever unavailable.

## Folder layout

```
vault.json                header (not secret): salts, settings, encrypted master key
vault.json.bak            identical copy of vault.json
meta.db.enc               the library database (encrypted object, kind 3)
meta-backups/             up to 5 previous versions of meta.db.enc (same format)
packs/media-NNNNNN.pack   encrypted media files, many per pack (about 1 GiB each)
packs/thumbs-NNNNNN.pack  encrypted thumbnails
FORMAT.md                 this file
.lock                     empty; prevents two programs writing at once
```

Vaults made by the first version of the app (`"version": 1` in vault.json)
store every object as its own file instead: `media/xx/<id>.bin` and
`thumbs/xx/<id>.bin`, where `xx` is the first 2 hex characters of `<id>`.
A vault being converted can contain both; check the packs first.

`<id>` is 16 random bytes written as 32 lowercase hex characters.

## Pack files

A pack is a 16-byte header followed by entries, back to back:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `MVPK` |
| 4 | 1 | pack format version = 1 |
| 5 | 1 | kind: 1 = media, 2 = thumbnails |
| 6 | 10 | reserved |

Each entry:

| Size | Field |
|---|---|
| 4 | magic `MVPE` |
| 16 | object id bytes |
| 8 | `n` = object length in bytes, u64 little-endian |
| n | the encrypted object, exactly as described below |

To find an object, either look it up in the database table `objects`
(`object_id`, `kind`, `pack` number, `offset` of the object's first byte,
`length`), or simply walk every pack from byte 16, entry by entry, and match
the id. An incomplete entry at the very end of a pack (an interrupted write)
is ignored. Deleted objects stay in their pack until space is reclaimed;
if the same id appears twice, either copy is valid.

## vault.json

```json
{
  "format": "media-vault",
  "version": 1,
  "vault_id": "<32 hex chars>",
  "created_at": <unix seconds>,
  "kdf": { "alg": "argon2id", "memory_kib": 262144, "iterations": 3, "parallelism": 4 },
  "password_slot": { "salt": "<hex>", "nonce": "<hex>", "wrapped_key": "<hex>" },
  "recovery_slot": { "salt": "<hex>", "nonce": "<hex>", "wrapped_key": "<hex>" }
}
```

Everything is protected by one random 32-byte **master key**. It is stored
twice, encrypted ("wrapped") by two different keys:

**Password slot**

1. `kek = Argon2id(password as UTF-8, salt = password_slot.salt, m = memory_kib, t = iterations, p = parallelism, output 32 bytes)`
2. `master = AES-256-GCM-decrypt(key = kek, nonce = password_slot.nonce, ciphertext = password_slot.wrapped_key, aad = "media-vault/v1/slot/password/" + vault_id)`

**Recovery slot**

1. Convert the 24 recovery words to 32 bytes of entropy using the BIP-39
   English word list (the standard 24-word / 256-bit mnemonic; the last word
   contains a checksum).
2. `kek = HKDF-SHA256(ikm = entropy, salt = recovery_slot.salt, info = "media-vault/v1/recovery-kek", length 32)`
3. `master = AES-256-GCM-decrypt(key = kek, nonce = recovery_slot.nonce, ciphertext = recovery_slot.wrapped_key, aad = "media-vault/v1/slot/recovery/" + vault_id)`

The aad strings are ASCII; `vault_id` is the hex text exactly as in the file.
If decryption fails, the password or recovery words are wrong.

## Encrypted objects (`.bin` files and `meta.db.enc`)

Each object has its own random 32-byte **data key**. Integers are little-endian.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `MVOB` |
| 4 | 1 | object format version = 1 |
| 5 | 1 | kind: 1 = media, 2 = thumbnail, 3 = database |
| 6 | 1 | `c` = log2 of chunk size (normally 20, i.e. 1 MiB) |
| 7 | 1 | reserved, 0 |
| 8 | 8 | `L` = original (plaintext) length in bytes, u64 |
| 16 | 7 | nonce prefix |
| 23 | 12 | key nonce |
| 35 | 48 | wrapped data key |
| 83 | … | chunks |

**Object id bytes.** For media and thumbnails, the 16 bytes of the object id
(the `object_id` hex in the database, the id in the pack entry, or the old
file name). For the database, the ASCII bytes `media-vault-db` followed by two
zero bytes.

**Data key.** `data_key = AES-256-GCM-decrypt(key = master, nonce = key nonce, ciphertext = wrapped data key, aad = header bytes 0..23 || object id bytes)`

**Chunks.** The plaintext is split into chunks of `2^c` bytes; the last chunk
holds the remainder (an empty file has one empty chunk). Number of chunks
`N = max(1, ceil(L / 2^c))`. Each chunk is stored as AES-GCM ciphertext
followed by its 16-byte tag, so chunk `i` starts at byte
`83 + i × (2^c + 16)`.

For chunk `i` (counting from 0):

- nonce = nonce prefix (7 bytes) || `i` as 4-byte **big-endian** || 1 byte: 1 if this is the last chunk, else 0
- aad = header bytes 0..8 || nonce prefix (7 bytes) || object id bytes (16)

Concatenate the decrypted chunks to get the original file.

## The database

Decrypting `meta.db.enc` gives a normal SQLite 3 database file. Save it as
`library.db` and open it with any SQLite tool. Key tables:

- `folders(id, parent_id, name, pinned, color, emoji, person, deleted_at, …)` — the folder tree; `parent_id` NULL = top level;
  `person` = 1 marks a person folder for face recognition
- `media(id, object_id, thumb_object_id, folder_id, kind, original_name, ext, size, sha256, favourite, weight, taken_at, views, deleted_at, …)`
  — `kind` is image, gif, video, text or pdf; `folder_id` NULL = top level.
  A non-NULL `deleted_at` (milliseconds) means the item or folder is in the app's
  trash; it is still fully stored and can be recovered like anything else.
- `bookmarks(id, media_id, position_ms, note)` — bookmarks inside videos
- `faces(id, media_id, frame_ms, x, y, w, h, score, descriptor, person_id)` — faces found by
  face recognition; position as fractions of the picture, `descriptor` = 128 little-endian
  float32 values, `person_id` = the person folder it was confirmed for.
  `face_rejects(face_id, folder_id)` remembers "not this person".
- `media.preview_object_id` — a video's preview clip: one JPEG holding 48 small frames
  (8 across, 6 down), stored like a thumbnail. Can be deleted; the app makes it again.
- `clip(media_id, vec)` — smart-search vectors of an item: one or more groups of 512
  little-endian float32 values (each unit length, CLIP ViT-B/32 space); videos have the
  thumbnail plus moments from their preview clip
- `media.phash`, `media.sharpness`, `media.phash_state` — a picture fingerprint for finding
  look-alikes: a 64-bit perceptual hash (DCT of the 32×32 grey thumbnail, top-left 8×8
  above their median) and the variance of the Laplacian of a 64×64 grey copy
- `objects(object_id, kind, pack, offset, length)` — where each object is in the packs
- `tags`, `media_tags`, `folder_tags` — tags; folder tags apply to everything inside
- `presets`, `layouts`, `settings` — app settings

Nothing in these tables is needed to get your files back; they can all be
rebuilt by the app.

The vault folder may also hold `attempts.json`: the times of recent wrong
passwords (shown after the next successful unlock). It holds only times, no
other information, and is not encrypted because it is written before the
vault is open.

If `meta.db.enc` is damaged, use the newest file in `meta-backups/`; it has the
same format.

## Recovering a file by hand

1. Get the master key from `vault.json` (password or recovery slot).
2. Decrypt `meta.db.enc`, open it in SQLite, find the row in `media`.
3. Find that `object_id` in the packs (table `objects`, or by walking the
   packs), or in `media/<first two chars>/<object_id>.bin` for old vaults.
4. Decrypt it and save it under `original_name`.
