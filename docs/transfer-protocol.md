# MVTP/1 — Media Vault ⇄ Baro Alarm Wi-Fi transfer protocol

Version 1, written 2026-11-08, revision 2 (17:40: Baro Alarm review changes 1–6 applied, marked **[r2]**; 18:50: ref ranges note; test vectors unchanged; 2026-11-25: `have` counts only the target folder, §9.2). Shared by both projects; **change it in both places or not at all.**
Companion files: `transfer-vectors.json` (test vectors) and `mvtp_ref.py` (Python reference that generates and re-checks them).
Design background and decisions: `wifi-transfer-plan.md`.

Words: **phone** = Baro Alarm (always the client), **PC** = Media Vault (always the server).
`‖` = concatenate. Strings in crypto inputs are ASCII bytes, no terminator. Text fields are UTF-8.

---

## 1. Basics

| | |
|---|---|
| Byte order | **Big-endian** for every integer (u16, u32, u64) |
| Network | **IPv4 only** (UDP broadcast and TCP). IPv6 is not used. **[r2]** |
| Curve | NIST P-256 (secp256r1) for ECDH and ECDSA |
| Hash | SHA-256. `H(a, b, …)` = SHA-256 over the concatenation |
| MAC | HMAC-SHA256 |
| KDF | HKDF-SHA256 (§2) |
| Cipher | AES-256-GCM, 12-byte nonce, 16-byte tag |
| TCP port | **47630** (if busy, the PC may use any port; it is reported in discovery answers) |
| UDP port | **47631** (fixed; the PC listens, the phone sends from any port) |
| Max frame body `L` | **65 600** bytes. Anything larger → close the connection |
| File data per DATA frame | **1 … 65 536** bytes |

### 1.1 Key and signature encodings (on the wire and in vectors)
- **Public key:** uncompressed point, **65 bytes** = `04 ‖ X(32) ‖ Y(32)`. A received key that doesn't start with `04` or isn't a valid point on P-256 → close the connection. **[r2]**
  - Java/Kotlin: `X509EncodedKeySpec` wants DER. DER = fixed 26-byte prefix `3059301306072a8648ce3d020106082a8648ce3d030107034200` ‖ the 65 bytes. Going the other way, the last 65 bytes of `publicKey.encoded` are the point.
  - Rust: `p256::PublicKey::from_sec1_bytes` / `to_encoded_point(false)`.
- **Private key** (only in vectors and local storage, never sent): 32-byte scalar. Kotlin: `ECPrivateKeySpec(BigInteger(1, d), params)` with params from any P-256 key; each side may store its own key in any format it likes inside its vault.
- **ECDH result:** the 32-byte X coordinate (Java `KeyAgreement("ECDH").generateSecret()`, Rust `diffie_hellman(..).raw_secret_bytes()`).
- **ECDSA signature:** SHA-256 over the message, sent as **raw 64 bytes `r(32) ‖ s(32)`**, each left-padded with zeros.
  - Java's `SHA256withECDSA` gives DER → convert (parse the two INTEGERs, strip a leading 00, left-pad to 32). Verifying: build DER back from r and s.
  - Signers may use random k (Java does) and may produce a high s. **Verifiers must accept any valid (r, s), high s included.**

## 2. HKDF

`HKDF(ikm, salt, info, len)` = RFC 5869 with SHA-256: `PRK = HMAC(salt, ikm)`, then expand.
**Salt is always given explicitly and is never empty.** Where no salt exists, use 32 zero bytes (written `0³²`). (Java's `SecretKeySpec` refuses an empty key, so this avoids a mismatch.)

All derived values:

| Name | ikm | salt | info | len |
|---|---|---|---|---|
| `k_pair_p2c` | Z_pair | T | `MVTP1 pair p2c` | 32 |
| `k_pair_c2p` | Z_pair | T | `MVTP1 pair c2p` | 32 |
| `sas4` | Z_pair | T | `MVTP1 sas` | 4 |
| `pair_key` (stored) | Z_pair | T | `MVTP1 pairkey` | 32 |
| `disc_key` | pair_key | 0³² | `MVTP1 discovery` | 32 |
| `k_p2c` (session) | Z_sess ‖ pair_key (64 bytes) | TH2 | `MVTP1 p2c` | 32 |
| `k_c2p` (session) | Z_sess ‖ pair_key | TH2 | `MVTP1 c2p` | 32 |

`p2c` = phone → PC, `c2p` = PC → phone. Each direction has its own key.

## 3. Frames (TCP)

```
u32 L | body (L bytes)
```
- **Plain frame** (only during the handshakes in §5 and §7): `body = u8 type ‖ payload`.
- **Encrypted frame:** `body = AES-256-GCM(key, nonce, plaintext = u8 type ‖ payload, aad = the 4 bytes of L)` = ciphertext ‖ tag.
  - `L = 1 + len(payload) + 16`.
  - `nonce = 00 00 00 00 ‖ u64 counter`. Each direction has its own counter starting at **0** for each key, +1 per frame. Never reused; a frame that fails to decrypt (wrong order, missing, changed) → close the connection.
  - After 2³² frames in one direction, close and reconnect (never reached in practice).
- Read exactly 4 bytes, check `L ≤ 65 600`, read exactly L bytes. Partial reads are normal on TCP.

## 4. Message types

| Type | Name | Where | Payload |
|---|---|---|---|
| 0x01 | PAIR_DISCOVER | UDP phone→PC | §5.1 |
| 0x02 | PAIR_ANSWER | UDP PC→phone | §5.1 |
| 0x10 | DISCOVER | UDP phone→PC | §6 |
| 0x11 | DISCOVER_ANSWER | UDP PC→phone | §6 |
| 0x20 | HELLO1 | plain TCP phone→PC | §7 |
| 0x21 | HELLO2 | plain TCP PC→phone | §7 |
| 0x22 | HELLO3 | plain TCP phone→PC | §7 |
| 0x30 | INFO | enc, both | JSON (§8) |
| 0x31 | BYE | enc, both | u8 reason: 0 normal, 1 locked, 2 user closed, 3 error |
| 0x32 | PING | enc, both | empty |
| 0x33 | PONG | enc, both | empty |
| 0x40 | OFFER | enc, sender→receiver | JSON (§9) |
| 0x41 | ANSWER | enc, receiver→sender | JSON (§9) |
| 0x42 | ITEM_START | enc, sender | u32 ref ‖ u64 size |
| 0x43 | DATA | enc, sender | u32 ref ‖ 1…65 536 bytes of the file |
| 0x44 | ITEM_END | enc, sender | u32 ref ‖ sha256 (32) |
| 0x45 | ITEM_OK | enc, receiver | u32 ref |
| 0x46 | ITEM_FAILED | enc, receiver | u32 ref ‖ u8 reason: 1 hash mismatch, 2 no space, 3 write error, 4 cancelled, 5 bad data |
| 0x47 | CANCEL | enc, either | u32 ref, or `FFFFFFFF` = everything this side is sending or receiving |
| 0x48 | LOCKED | enc, either | empty |
| 0x50 | PAIR_COMMIT | plain TCP phone→PC | §5.2 |
| 0x51 | PAIR_PC | plain TCP PC→phone | §5.2 |
| 0x52 | PAIR_REVEAL | plain TCP phone→PC | §5.2 |
| 0x53 | PAIR_ID | enc (pair keys), both | §5.3 |
| 0x54 | PAIR_CONFIRM | enc (pair keys), both | u8: 1 yes, 0 no |

An unknown type in an encrypted frame is ignored (for later versions); an unknown type in a plain frame closes the connection.

## 5. Pairing (once)

The user presses **Pair a phone** on the PC (pairing mode, 2 minutes) and **Eşleştir** on the phone.

### 5.1 Finding the PC for pairing (UDP)
- Phone → broadcast `255.255.255.255:47631` and the subnet broadcast (e.g. `192.168.1.255`), 3 times, 1 s apart:
  `PAIR_DISCOVER = "MVTP" ‖ 01 (version) ‖ 01 (type) ‖ nonce(16 random)`
- PC **only in pairing mode** answers to the sender's address and port:
  `PAIR_ANSWER = "MVTP" ‖ 01 ‖ 02 ‖ the same nonce(16) ‖ u16 tcpPort`
- The phone ignores answers with a wrong nonce or from non-private addresses.

### 5.2 Commitment and key exchange (plain TCP frames)
Each side makes a fresh P-256 key pair just for pairing (`phoneEph`, `pcEph`) and 32 random bytes (`Np`, `Npc`).
1. Phone → PC **PAIR_COMMIT**: `u8 version (1) ‖ C`, where `C = H("MVTP1 commit", phoneEph65, Np)`.
2. PC → phone **PAIR_PC**: `pcEph65 ‖ Npc`.
3. Phone → PC **PAIR_REVEAL**: `phoneEph65 ‖ Np`. The PC checks C; wrong → close.
4. Both compute:
   - `T = H("MVTP1 pair", C, pcEph65, Npc, phoneEph65, Np)`
   - `Z_pair = ECDH(own eph private, peer eph public)`
   - `k_pair_p2c`, `k_pair_c2p`, `sas4`, `pair_key` (§2)
   - **6-digit code** = `u32(sas4) mod 1 000 000`, shown with leading zeros (e.g. `004217`).

The commitment means the phone is locked into its key before it sees the PC's, so a third device on the network can't try many keys to land on matching numbers.

### 5.3 Identities and confirmation (encrypted with the pair keys, counters from 0)
5. Phone → PC **PAIR_ID**: `phoneId65 ‖ sig(64) ‖ u16 nameLen ‖ name`
   sig = ECDSA(phone identity key, `"MVTP1 pair id" ‖ 01 ‖ T ‖ phoneId65`).
6. PC → phone **PAIR_ID**: same with `02` and the PC identity key.
   Each verifies the other's signature; bad → close.
   The identity key is each vault's long-term P-256 key, made the first time that vault pairs. Name: the phone sends what the user chose (default "Telefon"); the PC sends its vault name.
7. Both screens show the 6-digit code. The user compares and presses Confirm or Cancel on **each** side.
8. Each sends **PAIR_CONFIRM** (1 or 0). A side saves the pairing only after it has sent 1 **and** received 1. Then close. Timeout: 120 s from step 1.

### 5.4 What each side stores (only inside its encrypted vault)
| Field | Size |
|---|---|
| own identity private key (+ public 65) | 32 (+65) |
| peer identity public key | 65 |
| peer name | text |
| `pair_key` | 32 |
| paired at (ms) | u64 |
| last known PC address + TCP port (phone only) | text |

`disc_key` and session keys are derived when needed, not stored.

**Re-pairing [r2]:** if a pairing completes with a peer whose identity public key is already stored, that entry is **replaced** (new `pair_key`, name, paired-at), not added twice. This also repairs the case where the connection drops after the last PAIR_CONFIRM and only one side saved: the user simply pairs again. **Forget** on either side deletes the entry; the other side then simply gets no answers / failed handshakes and should offer to pair again.

## 6. Finding the paired PC (UDP)

Phone, when it wants a connection (§7 "Connection lifetime": from Baro Alarm 0.54, whenever the hidden vault is unlocked):
- Broadcast, as in §5.1, up to 3 times 1 s apart:
  `DISCOVER = "MVTP" ‖ 01 ‖ 10 ‖ u64 ts_ms ‖ nonce(16) ‖ mac(32)`
  `mac = HMAC(disc_key, all bytes before mac)`, `ts_ms` = the phone's clock (ms since 1970, UTC).
- PC (vault unlocked) tries `disc_key` of every paired phone. If one matches **and** `|ts − PC clock| ≤ 10 min` **and** the nonce wasn't seen in the last 20 min (keep a small replay cache), it answers to the sender:
  `DISCOVER_ANSWER = "MVTP" ‖ 01 ‖ 11 ‖ the same nonce(16) ‖ u16 tcpPort ‖ mac(32)`, `mac = HMAC(disc_key, all bytes before mac)`.
  Anything else gets **no reply at all**.
- Phone checks nonce and mac, then connects to the answer's source address and port.
- No valid answer after 3 tries → try the last known address directly (§7 authenticates it anyway), then show "PC bulunamadı".

Only private addresses are used: 10/8, 172.16/12, 192.168/16 (and 169.254/16 link-local). The phone binds its sockets to the Wi-Fi `Network`.

## 7. Session handshake (plain TCP frames, then encrypted)

New random ephemeral key pairs and 32-byte nonces for every connection.

1. Phone → PC **HELLO1**: `u8 version (1) ‖ phoneEph65 ‖ Np(32) ‖ hint(8)`
   `hint = first 8 bytes of HMAC(disc_key, "MVTP1 hint" ‖ Np)` — tells the PC which paired phone this is without sending a fixed id.
   The PC finds the paired phone whose hint matches; none → close silently.
2. PC → phone **HELLO2**: `pcEph65 ‖ Npc(32) ‖ sigPC(64)`
   `TH = H("MVTP1 hs", HELLO1 payload, pcEph65, Npc)`, `sigPC = ECDSA(PC identity, "MVTP1 hs pc" ‖ TH)`.
   The phone verifies sigPC with the stored PC key; bad → close.
3. Phone → PC **HELLO3**: `sigPhone(64)`
   `TH2 = H(TH, sigPC)`, `sigPhone = ECDSA(phone identity, "MVTP1 hs phone" ‖ TH2)`. The PC verifies; bad → close.
4. Both: `Z_sess = ECDH(eph)`, `k_p2c`, `k_c2p` (§2). From now on only encrypted frames, counters from 0.
5. Both send **INFO** first (§8).

Mixing `pair_key` into the session keys means even a broken signature check still wouldn't give an outsider the keys.

**Timeouts:** whole handshake 10 s. After that, if nothing has been sent for 15 s, send PING; the other answers PONG. Nothing received for 45 s → close. While a transfer runs, DATA frames count as traffic.

**Connection lifetime:** up to Baro Alarm 0.53 the phone opens it when the Aktarım page opens (or Gönder is pressed) and closes it (BYE 2) when the page closes. **From Baro Alarm 0.54 (2026-11-27, no wire change):** the phone opens it as soon as the hidden vault is unlocked (Aktarım need not be open) and keeps it while the vault stays unlocked; it sends LOCKED and closes when the vault locks. While unlocked and not connected, the phone quietly tries again (discovery as in §6) every 15 s, and at once when Wi-Fi comes back; "PC bulunamadı" is shown only on the Aktarım page. A PC send therefore works whenever the phone's vault is unlocked. One connection at a time per paired phone; a new one from the same phone replaces the old.

## 8. INFO (0x30)

JSON, UTF-8, no fixed field order. Unknown fields are ignored.
```json
{"app":"baroalarm","proto":1,"name":"Telefon","free":12345678901,"kinds":["image","gif","video"]}
```
- `app`: `"mediavault"` or `"baroalarm"`. `proto`: 1. `name`: display name. `free`: free bytes for the vault (approximate). `kinds`: kinds this side can store.

## 9. Offer and answer

Either side can send at any time after INFO. Each side sends **at most one item at a time** in its direction; both directions can run at once on the same connection.

**[r2] Limits and order:**
- **At most 1 000 items per offer.** More items → several offers, one after another.
- **One offer at a time per direction.** A side sends its next OFFER only after every `want` item of its previous offer has ended (ITEM_OK or ITEM_FAILED), or after an ANSWER with no `want` at all.

### 9.1 OFFER (0x40), JSON
```json
{"offer":1,"last":true,
 "folders":[{"f":0,"parent":-1,"name":"Tatil","tags":["yaz"]},
            {"f":1,"parent":0,"name":"Bodrum 2026","tags":[]}],
 "items":[{"i":5,"sha256":"…64 hex…","name":"IMG_0001.HEIC","size":5,"kind":"image","mime":"image/heic",
           "w":4032,"h":3024,"dur_ms":0,"taken":1751371200000,"fav":true,"tags":["deniz"],
           "marks":[{"ms":12000,"note":"intro"}],"folder":1}]}
```
- `offer`: u32, chosen by the sender, unique on this connection.
- `last`: false when one offer is split over several frames (each frame must fit in 65 600 bytes); the receiver answers after `last: true`. All frames of one offer use the same `offer` number, and folder/item numbers are unique across them.
- **folders** — the folder tree the items come from (§10):
  - `f`: number inside this offer (0, 1, 2…). `parent`: another `f`, or −1 for a top folder. A parent always appears before its children.
  - `name`: folder name. `tags`: **that folder's own tags** only.
- **items:**
  - `i`: u32 **ref**, chosen by the sender, unique on this connection; used in all later frames for this item.
    **[r2 note, 0.36]** The PC picks refs **1 … 0x3FFFFFFF**; the phone picks refs **from 0x40000001 up**. So a CANCEL ref always says which way it means (CANCEL `FFFFFFFF` still means everything).
  - `sha256`: lowercase hex of the plain file. The sender must have it (Baro: compute it if `sha` is empty, and save it).
  - `name`: original file name with extension. `size`: plain bytes. `mime`.
  - `kind`: `image`, `gif`, `video`, `pdf`, `text`.
  - `w`, `h`, `dur_ms`: 0 when unknown. `taken`: ms since 1970 UTC, or `null` → the receiver uses its own receive time. **[r2]**
  - `fav`: bool. `tags`: **the item's own tags** only (not inherited).
  - `marks`: video bookmarks `{ms, note}` (Media Vault bookmark `position_ms`/`note` ⇄ Baro `marks` `ms`/`name`). Empty for pictures.
  - `folder`: an `f`, or −1 = straight into the landing folder.
- Not sent: ids, thumbnails, preview clips, 3D/AI data, face data, weights, view counts, resume positions, trash.

### 9.2 ANSWER (0x41), JSON
```json
{"offer":1,"answers":[{"i":5,"a":"want"}]}
```
`a` is one of:
- `want` — send it.
- `have` — the receiver already has a non-trashed item with the same sha256 **in the folder this item would land in** (§10: the landing folder plus the item's path). Not sent.
  **[r2 note, 2026-11-25]** Before this note the check was "anywhere in its vault". Now a copy in another folder does
  not count: the item is sent again (`want`) and stored as a second, separate item in its target folder. Also `have`
  for a second item with the same sha256 **and the same target folder** in the same offer. A target folder that
  doesn't exist yet holds nothing, so its items are `want`. No wire change and no version bump: only the receiver's
  rule changes; a sender of any build handles `want` / `have` as before. Receivers with the new rule: Baro Alarm 0.53,
  Media Vault build-112 (planned).
- `cant` — kind not supported (the phone answers `cant` for `pdf` and `text`).
- `nospace` — not enough free space.

The receiver may answer `want` and still fail later (ITEM_FAILED).
The sender then sends the `want` items one by one, in the offer's order.

## 10. Folder tree and landing folder

- **The sender sends the path** from its top level down to the item's folder: for each item, every folder on the way is in `folders`, linked by `parent`. Selecting a whole folder sends its subtree.
- **The receiver puts the tree inside its landing folder:** **"Received from phone"** on the PC, **"Gelenler"** on the phone (created on first need, at the top level; the user may rename it — the receiver remembers it by its own id, not by name).
- Merging: a folder with the same name (case-insensitive, after trimming) and the same parent inside the landing tree is **reused**; otherwise created. Folder tags from the offer are added to the folder's tags (union, never removed).
- Folder names are cleaned by the receiver: trim, empty → "Folder", control characters removed, max 120 chars.
- **[r2] Item names** are cleaned the same way: trim, control characters and `/` `\` removed, max 200 chars **keeping the extension**, empty → "file".
- Tags are normalised by the receiver with its own rules (Baro: trim, drop `#`, spaces → `_`, Turkish lowercase).
- Folders are only created for items that actually arrive (a fully `have`/`cant` folder doesn't appear).

## 11. Sending one item

```
sender                         receiver
ITEM_START ref size  ───────▶  open a new encrypted vault entry, start SHA-256
DATA ref bytes … (≤ 64 KiB)    write each piece straight into the vault's encrypted writer
ITEM_END ref sha256  ───────▶  check: total == size, sha == ITEM_END sha == OFFER sha
                     ◀───────  ITEM_OK ref   (now in the vault + index)  or  ITEM_FAILED ref reason
```
- DATA must be in order and only for the current ref. More than `size` bytes, a wrong ref, or a gap → receiver sends ITEM_FAILED 5 and discards.
- On any failure the receiver **deletes its partial encrypted file** (Baro: `b/<id>.tmp`; Media Vault: abandons the pack write). Nothing is added to the index.
- The receiver adds an item to its index only after the hash check. Thumbnails/previews are made afterwards from its own vault copy.
- The sender moves on to the next item only after ITEM_OK or ITEM_FAILED.
- **CANCEL ref** (either side): stop that item; the receiver discards it and replies ITEM_FAILED 4. `FFFFFFFF` cancels all items in both directions on this connection; the connection stays open.
- **Resuming:** an interrupted item starts again from 0 next time. Finished items are skipped through `have` (same target folder, §9.2).

## 12. Locking and errors

- **Either vault locks** (any reason: manual, auto-lock, screen off, leaving the vault): that side sends **LOCKED** (best effort), stops everything, deletes its partial receive, wipes the session keys and closes the socket. It does not wait for the other side.
- **The other side**, on LOCKED **or** on the connection dropping for any reason: stops at once, deletes its partial receive, keeps every item already confirmed with ITEM_OK, and shows "Transfer stopped: the other side locked / disconnected".
- On the phone, the transfer job must **not** keep the key after a lock (unlike other `Vault.enqueue` jobs).
- The PC stops listening on TCP/UDP when its vault locks, and starts again on unlock.
- Any decrypt failure, bad signature, oversize frame or protocol violation → close without reply.

## 13. What the PC does with formats it can't show (local detail, not on the wire)
The original arrives and is stored unchanged. Media Vault then makes a playable copy (HEIC/HEIF/AVIF → JPEG, .mov/HEVC/mkv/avi/3gp → MP4) as a separate item in the same folder. The phone never sees this.

## 14. Test vectors (`transfer-vectors.json`)

Both implementations must reproduce every value from the given inputs:

| Section | Checks |
|---|---|
| `hkdf` | plain HKDF with a fixed salt |
| `keys` | the fixed scalars → 65-byte public keys; the X.509 DER prefix |
| `pairing` | the three plain frames, `C`, `T`, `Z`, both pair keys, `sas4`, **`code6` = 199921**, `pair_key`, both PAIR_ID signature inputs (+ raw and DER signature to verify), the encrypted PAIR_ID frames and a PAIR_CONFIRM |
| `discovery` | `disc_key`, a DISCOVER and DISCOVER_ANSWER packet with their MACs, the pairing packets |
| `session` | `hint`, HELLO1/2/3 frames, `TH`, `TH2`, both signatures (verify), `Z`, `k_p2c`, `k_c2p` |
| `frames` | INFO, PING, DATA and ITEM_END encrypted frames with given keys and counters |
| `json_examples` | OFFER and ANSWER (format only) |

Signatures in the vectors use deterministic RFC 6979 k, so they're reproducible. An implementation with random k (Java) checks them by **verifying** the given signatures, and by checking its own signatures verify with the other side's verifier. Every encrypted frame must also **fail** to decrypt with one flipped bit or a wrong counter.

`mvtp_ref.py` regenerates the file exactly (`python3 mvtp_ref.py > transfer-vectors.json`, needs `cryptography` ≥ 43) and asserts every value on the way.
