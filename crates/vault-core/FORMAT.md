# Media Vault — storage format (versions 1, 2, 3 and 4)

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
vault.json                header: salts, settings, encrypted master key (secret only
                          in a vault without a password, see "No password" below)
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

`version` is 1 for vaults that store one file per object (see above), 2 for
vaults with pack files, and 3 for a vault with pack files that has **no
password** (see "No password" below). A program must refuse a version it
doesn't know.

```json
{
  "format": "media-vault",
  "version": 2,
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

**No password** (version 3)

A vault can be made, or switched, to open without a password. Then
`password_slot` has all three fields empty (`""`) and there is an extra
`open_slot` holding the master key itself, **not encrypted**:

```json
  "password_slot": { "salt": "", "nonce": "", "wrapped_key": "" },
  "recovery_slot": { "salt": "<hex>", "nonce": "<hex>", "wrapped_key": "<hex>" },
  "open_slot": {
    "warning": "This vault has no password. This is its master key, NOT encrypted: anyone who has this folder can open the vault.",
    "master_key": "<64 hex chars>"
  }
```

`master = open_slot.master_key` (32 bytes, hex). The recovery slot works as
usual. Anyone who has a copy of the folder can open such a vault. Setting a
password again writes a normal `password_slot`, removes `open_slot` and sets
`version` back to 2 (or 1 if objects are still stored one file each);
media is never re-encrypted when switching. The empty `password_slot` is
only kept so that programs made before version 3 can still read the version
number and refuse the vault.

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

## Vaults without encryption (version 4)

A vault can be made without encryption, and an encrypted vault can be changed
to one without (and back). `vault.json` then says `"plain": true` and
`"version": 4`; it has no password and no recovery key (their slots are empty).

- **Media are ordinary files** under `Files/`, in folders named like the
  vault's folders, with their original names (a number is added to tell
  apart files with the same name). Items in the trash are in `Files/.trash/`.
  A file that was just added waits in `Files/.new/` under its object id until
  the app puts it in its folder. The table `plain_files` in the database says
  where each file is (`path`, and `prev` while a move may not have happened yet).
  Moving or renaming these files outside the app makes the app lose them.
- **Everything else** (thumbnails, preview clips, saved depth maps and
  outlines, the database) is stored as before, in the packs and
  `meta.db.enc`, but as **version 2 objects**: the same 83-byte header with
  version byte 2 and bytes 16..83 zero, followed by the plain bytes (no tags).
  `meta.db.enc` is then simply a SQLite database after an 83-byte header.

While a vault is being changed, `vault.json` has `"converting": "plain"` or
`"converting": "encrypted"` and version 4. Both kinds of object can be present
then; each object's version byte (and the files under `Files/`) tells which.

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
- `faces(id, media_id, frame_ms, x, y, w, h, score, descriptor, person_id, model, auto, named_at, hidden)` —
  faces found by face recognition; position as fractions of the picture. `model` 0 = the
  built-in face-api (`descriptor` = 128 little-endian float32 values), 1 = InsightFace
  buffalo_l (512 values, unit length). `person_id` = the person folder it shows; `auto` = 1 if
  the app named it on its own (`named_at`, seconds), 0 if you confirmed it; `hidden` = 1 for
  people marked "not important". `face_rejects(face_id, folder_id)` remembers "not this person",
  `face_not_same(a, b)` "these two people are not the same". `media.faces_model` = the model
  that scanned the item (-1 = waiting to be scanned again with the new model).
- `media.thumb_object_id` — the item's thumbnail (at most 640 px on the longest side),
  stored as an object of kind 2. Older thumbnails are JPEG, newer ones lossy WebP; tell them
  apart by their first bytes (`FF D8 FF` = JPEG, `RIFF····WEBP` = WebP). NULL = not made yet,
  '' = couldn't be made. Can be deleted; the app makes it again.
- `media.preview_object_id` — a video's preview clip: one picture holding 48 small frames
  (8 across, 6 down), JPEG (older) or WebP, stored like a thumbnail. Can be deleted; the app
  makes it again.
- `thumb_bundles(object_id, folder_id, size, items, bytes, members, made_at)` (v14) —
  *derived data, only there to make grids faster*: "thumbnail pages", each one object of
  kind 2 holding up to 96 thumbnails of one folder (`folder_id` NULL = top level) packed
  together, so a grid decrypts one object per page instead of one per tile. `size` 1 = small
  copies (at most 256 px, WebP) made from the thumbnails (what the app makes), 0 = the stored
  thumbnails exactly as they are.
  `members` = the 16-byte thumbnail object ids it holds, one after another. The decrypted
  object is: `MVTP` (4 bytes), version 1 (1 byte), size (1 byte), 2 reserved bytes, `n` (u32
  little-endian), then `n` entries of thumbnail object id (16 bytes) | offset (u32) | length
  (u32) — offsets counted from the end of that table — then the pictures back to back. The
  item's own thumbnail object stays the original; pages can all be deleted (rows and objects)
  at any time and the app makes them again.
- `media.sketch` (v11) — a tiny colour sketch of the thumbnail (a few cells of colour as text), drawn blurred while the thumbnail loads; NULL = not made yet.
- `media.tiny_object_id` (v12) — a video's tiny preview video: silent, about 426×240, a few
  seconds made of short pieces spread through the video (WebM/VP9 or MP4/H.264, recognised by
  its first bytes), stored like a thumbnail. NULL = not made yet, '' = couldn't be made. Can be
  deleted; the app makes it again.
- `clip(media_id, vec, f16)` — smart-search vectors of an item: one or more groups of 512
  values (each unit length, CLIP ViT-B/32 space); videos have the thumbnail plus moments
  from their preview clip. `f16` = 1 (v13 on): little-endian IEEE 754 half-precision
  (16-bit) floats; 0: little-endian float32
- `folder_stats(folder_id, items, bytes)` (v13) — how many items (not in the trash) are
  directly in each folder and their total size, kept up to date by triggers on `media`
- `face_graph(model, data)` (v13) — which faces look alike (each face's closest look-alikes
  and how alike), saved so it isn't worked out again at every unlock; the app checks it
  against the faces (by a checksum of each fingerprint) and rebuilds what doesn't match
- `folders.banner_media_id`, `folders.banner_y` (v15) — a folder's banner: the item shown wide at the
  top of the folder and where in it to look (0 = top, 1 = bottom); NULL = no banner.
- `folders.cover_x`, `folders.cover_y`, `folders.cover_zoom` (v16) — the hand-set framing of a folder's
  cover ("Adjust cover…"): the point of the picture kept in view (0–1 across and down, placed like CSS
  `object-position`) and the zoom (1 = just fills the card, up to 8). All three NULL = automatic
  (centred, or centred on the face for person folders). Cleared when the cover changes to another item.
- `faces.px`, `faces.sharp`, `faces.turn` (v17) — what tells a "poor face" (too small, too
  blurry or turned too far away to be trusted): the face's height in the item's own pixels,
  its sharpness (variance of the Laplacian of a grey crop at most 64 px across; -1 = couldn't
  be measured) and how far it is turned (degrees; 0 = straight at the camera, 90 = side on,
  from the five face points). NULL = not measured yet and counts as fine. Whether a face is
  poor is not stored: the app decides it from its settings each time, so changing them never
  changes these rows. The upgrade fills `px` from `media.height`; the rest is measured later.
- `derived(media_id, kind, model, object_id, source, bytes, made_at)` (v18) — *derived data*:
  depth maps (`kind` 'depth') and subject outlines ('outline') saved for still pictures so they
  needn't be made again, one per item, kind and model id (e.g. 'v2-small', 'birefnet'). Each is an
  object of kind 2 holding exactly what the app's estimate gave: width (u32 little-endian),
  height (u32 little-endian), then one byte per pixel (depth: 255 = nearest; outline: 255 =
  subject). `source` = the item's `object_id` when it was made (after a rotation the item has a
  new file and the old map is ignored). Rows go when their item is deleted for good, and their
  objects with the item's other files; all can be deleted at any time.
- `media.phash`, `media.sharpness`, `media.phash_state` — a picture fingerprint for finding
  look-alikes: a 64-bit perceptual hash (DCT of the 32×32 grey thumbnail, top-left 8×8
  above their median) and the variance of the Laplacian of a 64×64 grey copy
- `media.copy_of` — a free copy: several items may share one stored file (`object_id`);
  `copy_of` is the id of the original (NULL = an original). A stored file is only removed
  when no item uses it any more. `media.note`, `folders.note` — your notes;
  `media.resume_ms` — where a video was left off; `media.elo`, `media.duels` — duel ranking;
  `tags.color` — a tag's colour
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

1. Get the master key from `vault.json` (password, recovery or open slot).
2. Decrypt `meta.db.enc`, open it in SQLite, find the row in `media`.
3. Find that `object_id` in the packs (table `objects`, or by walking the
   packs), or in `media/<first two chars>/<object_id>.bin` for old vaults.
4. Decrypt it and save it under `original_name`.
