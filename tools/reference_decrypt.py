#!/usr/bin/env python3
"""
Independent Media Vault decrypter, written only from FORMAT.md.

It shares no code with the app. It exists for two reasons:
  1. The test suite runs it to prove FORMAT.md is complete and correct.
  2. It is a second, last-resort way to get files out of a vault.

Requirements:  pip install cryptography argon2-cffi mnemonic
Usage:         python reference_decrypt.py <vault folder> <output folder> [--recovery]
"""
import getpass
import json
import os
import sqlite3
import struct
import sys
import tempfile

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from mnemonic import Mnemonic

HEADER_LEN = 83
DB_OBJECT_ID = b"media-vault-db\x00\x00"


def master_from_password(h, password):
    s, k = h["password_slot"], h["kdf"]
    kek = hash_secret_raw(password.encode("utf-8"), bytes.fromhex(s["salt"]),
                          time_cost=k["iterations"], memory_cost=k["memory_kib"],
                          parallelism=k["parallelism"], hash_len=32, type=Type.ID, version=0x13)
    aad = ("media-vault/v1/slot/password/" + h["vault_id"]).encode()
    return AESGCM(kek).decrypt(bytes.fromhex(s["nonce"]), bytes.fromhex(s["wrapped_key"]), aad)


def master_from_recovery(h, words):
    words = " ".join(w.strip(".,0123456789").lower() for w in words.split() if w.strip(".,0123456789"))
    entropy = Mnemonic("english").to_entropy(words)
    s = h["recovery_slot"]
    kek = HKDF(algorithm=SHA256(), length=32, salt=bytes.fromhex(s["salt"]),
               info=b"media-vault/v1/recovery-kek").derive(bytes(entropy))
    aad = ("media-vault/v1/slot/recovery/" + h["vault_id"]).encode()
    return AESGCM(kek).decrypt(bytes.fromhex(s["nonce"]), bytes.fromhex(s["wrapped_key"]), aad)


def walk_packs(vault):
    """Map object id (bytes) -> (pack path, offset, length), by walking every pack."""
    found = {}
    packs = os.path.join(vault, "packs")
    if not os.path.isdir(packs):
        return found
    for name in sorted(os.listdir(packs)):
        if not name.endswith(".pack"):
            continue
        path = os.path.join(packs, name)
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            assert f.read(4) == b"MVPK", "not a pack"
            pos = 16
            while pos + 28 <= size:
                f.seek(pos)
                h = f.read(28)
                if h[:4] != b"MVPE":
                    break
                oid, n = h[4:20], struct.unpack("<Q", h[20:28])[0]
                if n == 0 or pos + 28 + n > size:
                    break  # interrupted write at the end
                found[oid] = (path, pos + 28, n)
                pos += 28 + n
    return found


def decrypt_object(master, path, object_id, out, offset=0, entry_len=None):
    with open(path, "rb") as f:
        f.seek(offset)
        head = f.read(HEADER_LEN)
        assert head[:4] == b"MVOB" and head[4] == 1, "not an object file"
        c = head[6]
        length = struct.unpack("<Q", head[8:16])[0]
        prefix = head[16:23]
        data_key = AESGCM(master).decrypt(head[23:35], head[35:83], head[:23] + object_id)
        aead = AESGCM(data_key)
        size = 1 << c
        n = max(1, -(-length // size))
        aad = head[:8] + prefix + object_id
        for i in range(n):
            last = i == n - 1
            plain = length - i * size if last else size
            ct = f.read(plain + 16)
            nonce = prefix + struct.pack(">I", i) + bytes([1 if last else 0])
            out.write(aead.decrypt(nonce, ct, aad))
        if entry_len is None:
            assert f.read(1) == b"", "unexpected extra data"
        else:
            assert f.tell() == offset + entry_len, "object length mismatch"


def main():
    vault, dest = sys.argv[1], sys.argv[2]
    h = json.load(open(os.path.join(vault, "vault.json")))
    if "--recovery" in sys.argv:
        master = master_from_recovery(h, sys.stdin.read() if not sys.stdin.isatty() else input("Recovery words: "))
    else:
        master = master_from_password(h, sys.stdin.readline().rstrip("\n") if not sys.stdin.isatty() else getpass.getpass())

    with tempfile.TemporaryDirectory() as tmp:
        dbpath = os.path.join(tmp, "library.db")
        with open(dbpath, "wb") as out:
            decrypt_object(master, os.path.join(vault, "meta.db.enc"), DB_OBJECT_ID, out)
        db = sqlite3.connect(dbpath)
        packed = walk_packs(vault)
        folders = {i: (p, n) for i, p, n in db.execute("SELECT id, parent_id, name FROM folders")}

        def folder_path(fid):
            parts = []
            while fid is not None:
                parent, name = folders[fid]
                parts.append(name)
                fid = parent
            return os.path.join(dest, *reversed(parts))

        count = 0
        for obj, name, fid in db.execute("SELECT object_id, original_name, folder_id FROM media"):
            d = folder_path(fid)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, name), "xb") as out:
                oid = bytes.fromhex(obj)
                if oid in packed:
                    path, off, n = packed[oid]
                    decrypt_object(master, path, oid, out, off, n)
                else:  # vaults from the first app version: one file per object
                    decrypt_object(master, os.path.join(vault, "media", obj[:2], obj + ".bin"), oid, out)
            count += 1
        db.close()
    print(f"exported {count} files")


if __name__ == "__main__":
    main()
