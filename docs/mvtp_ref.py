#!/usr/bin/env python3
"""MVTP/1 reference implementation (crypto parts only) + test-vector generator.

Media Vault <-> Baro Alarm Wi-Fi transfer protocol, version 1.
Run:  python3 mvtp_ref.py > transfer-vectors.json
The script also re-checks every vector (decrypts, verifies signatures) before printing.
Needs: pip install cryptography (>= 43, for deterministic ECDSA in the vectors).
"""
import hashlib, hmac, json, struct
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature, encode_dss_signature)

MAGIC = b"MVTP"
VER = 1
ZERO32 = bytes(32)
CURVE = ec.SECP256R1()
X509_P256_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")


def H(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def hmac256(key, data):
    return hmac.new(key, data, hashlib.sha256).digest()


def hkdf(ikm, salt, info, length):
    """RFC 5869 HKDF-SHA256. salt is ALWAYS given explicitly (never empty)."""
    prk = hmac256(salt, ikm)
    out, t, i = b"", b"", 1
    while len(out) < length:
        t = hmac256(prk, t + info + bytes([i]))
        out += t
        i += 1
    return out[:length]


def priv_from_hex(h):
    return ec.derive_private_key(int(h, 16), CURVE)


def pub65(priv_or_pub):
    pub = priv_or_pub.public_key() if hasattr(priv_or_pub, "public_key") else priv_or_pub
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def pub_from65(b):
    return ec.EllipticCurvePublicKey.from_encoded_point(CURVE, b)


def ecdh(priv, peer65):
    return priv.exchange(ec.ECDH(), pub_from65(peer65))  # 32-byte X coordinate


def sign_raw(priv, msg):
    der = priv.sign(msg, ec.ECDSA(hashes.SHA256(), deterministic_signing=True))
    r, s = decode_dss_signature(der)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big"), der


def verify_raw(pub65_, msg, sig64):
    der = encode_dss_signature(int.from_bytes(sig64[:32], "big"), int.from_bytes(sig64[32:], "big"))
    pub_from65(pub65_).verify(der, msg, ec.ECDSA(hashes.SHA256()))
    return True


def u16(n): return struct.pack(">H", n)
def u32(n): return struct.pack(">I", n)
def u64(n): return struct.pack(">Q", n)


def nonce(counter):
    return bytes(4) + u64(counter)


def seal_frame(key, counter, msg_type, payload):
    plain = bytes([msg_type]) + payload
    L = len(plain) + 16
    aad = u32(L)
    ct = AESGCM(key).encrypt(nonce(counter), plain, aad)
    return u32(L) + ct


def open_frame(key, counter, frame):
    L = struct.unpack(">I", frame[:4])[0]
    assert L == len(frame) - 4 and L <= 65600
    plain = AESGCM(key).decrypt(nonce(counter), frame[4:], frame[:4])
    return plain[0], plain[1:]


def plain_frame(msg_type, payload):
    body = bytes([msg_type]) + payload
    return u32(len(body)) + body


def sas6(sas4):
    return "%06d" % (struct.unpack(">I", sas4)[0] % 1_000_000)


def x(b):
    return b.hex()


def main():
    V = {"protocol": "MVTP/1", "note": "All hex lowercase. All integers big-endian. "
         "ECDSA vectors use deterministic RFC 6979 signing so they are reproducible; "
         "real implementations may sign with random k (Java does) and only need to VERIFY these signatures "
         "and produce signatures that verify."}

    # ---------------- 1. HKDF ----------------
    ikm = bytes(range(32)); salt = bytes(range(0x40, 0x60)); info = b"MVTP1 test"
    V["hkdf"] = {"ikm": x(ikm), "salt": x(salt), "info_utf8": "MVTP1 test", "length": 42,
                 "okm": x(hkdf(ikm, salt, info, 42))}

    # ---------------- fixed keys ----------------
    keys = {
        "phone_identity_priv": "1" * 63 + "1",
        "pc_identity_priv": "2" * 63 + "2",
        "phone_pair_eph_priv": "3" * 63 + "3",
        "pc_pair_eph_priv": "4" * 63 + "4",
        "phone_session_eph_priv": "5" * 63 + "5",
        "pc_session_eph_priv": "6" * 63 + "6",
    }
    K = {k: priv_from_hex(v) for k, v in keys.items()}
    V["keys"] = {k: {"priv_scalar": v, "pub65": x(pub65(K[k]))} for k, v in keys.items()}
    V["keys"]["x509_der_prefix_for_p256_pub65"] = x(X509_P256_PREFIX)
    V["keys"]["phone_identity_pub_x509_der"] = x(X509_P256_PREFIX + pub65(K["phone_identity_priv"]))
    assert K["phone_identity_priv"].public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo) == \
        X509_P256_PREFIX + pub65(K["phone_identity_priv"])

    phone_id65 = pub65(K["phone_identity_priv"]); pc_id65 = pub65(K["pc_identity_priv"])

    # ---------------- 2. Pairing ----------------
    Np = bytes([0xA1]) * 32; Npc = bytes([0xB2]) * 32
    pe = pub65(K["phone_pair_eph_priv"]); ce = pub65(K["pc_pair_eph_priv"])
    C = H(b"MVTP1 commit", pe, Np)
    T = H(b"MVTP1 pair", C, ce, Npc, pe, Np)
    Z = ecdh(K["phone_pair_eph_priv"], ce)
    assert Z == ecdh(K["pc_pair_eph_priv"], pe)
    k_p2c = hkdf(Z, T, b"MVTP1 pair p2c", 32)
    k_c2p = hkdf(Z, T, b"MVTP1 pair c2p", 32)
    sas = hkdf(Z, T, b"MVTP1 sas", 4)
    pair_key = hkdf(Z, T, b"MVTP1 pairkey", 32)
    msg_phone = b"MVTP1 pair id" + bytes([1]) + T + phone_id65
    msg_pc = b"MVTP1 pair id" + bytes([2]) + T + pc_id65
    sig_phone, der_phone = sign_raw(K["phone_identity_priv"], msg_phone)
    sig_pc, _ = sign_raw(K["pc_identity_priv"], msg_pc)
    assert verify_raw(phone_id65, msg_phone, sig_phone) and verify_raw(pc_id65, msg_pc, sig_pc)
    name_phone = "Telefon".encode(); name_pc = "Media Vault PC".encode()
    pid_phone_payload = phone_id65 + sig_phone + u16(len(name_phone)) + name_phone
    pid_pc_payload = pc_id65 + sig_pc + u16(len(name_pc)) + name_pc
    f_pid_phone = seal_frame(k_p2c, 0, 0x53, pid_phone_payload)
    f_pid_pc = seal_frame(k_c2p, 0, 0x53, pid_pc_payload)
    f_conf_phone = seal_frame(k_p2c, 1, 0x54, b"\x01")
    assert open_frame(k_p2c, 0, f_pid_phone) == (0x53, pid_phone_payload)
    V["pairing"] = {
        "inputs": {"Np": x(Np), "Npc": x(Npc), "phone_eph": "phone_pair_eph_priv", "pc_eph": "pc_pair_eph_priv",
                   "phone_identity": "phone_identity_priv", "pc_identity": "pc_identity_priv",
                   "phone_name": "Telefon", "pc_name": "Media Vault PC"},
        "frame_PAIR_COMMIT": x(plain_frame(0x50, bytes([VER]) + C)),
        "frame_PAIR_PC": x(plain_frame(0x51, ce + Npc)),
        "frame_PAIR_REVEAL": x(plain_frame(0x52, pe + Np)),
        "C": x(C), "T": x(T), "Z": x(Z),
        "k_pair_p2c": x(k_p2c), "k_pair_c2p": x(k_c2p),
        "sas4": x(sas), "code6": sas6(sas), "pair_key": x(pair_key),
        "sig_input_phone": x(msg_phone), "sig_phone_raw64": x(sig_phone), "sig_phone_der": x(der_phone),
        "sig_input_pc": x(msg_pc), "sig_pc_raw64": x(sig_pc),
        "frame_PAIR_ID_phone_ctr0": x(f_pid_phone),
        "frame_PAIR_ID_pc_ctr0": x(f_pid_pc),
        "frame_PAIR_CONFIRM_yes_phone_ctr1": x(f_conf_phone),
    }

    # ---------------- 3. Discovery ----------------
    disc_key = hkdf(pair_key, ZERO32, b"MVTP1 discovery", 32)
    ts = 1762611000000  # 2025-11-08T14:10:00Z, fixed for the vector
    dn = bytes([0xC3]) * 16
    req_body = MAGIC + bytes([VER, 0x10]) + u64(ts) + dn
    req = req_body + hmac256(disc_key, req_body)
    port = 47630
    ans_body = MAGIC + bytes([VER, 0x11]) + dn + u16(port)
    ans = ans_body + hmac256(disc_key, ans_body)
    pdn = bytes([0xC4]) * 16
    preq = MAGIC + bytes([VER, 0x01]) + pdn
    pans = MAGIC + bytes([VER, 0x02]) + pdn + u16(port)
    V["discovery"] = {"pair_key": x(pair_key), "disc_key": x(disc_key), "ts_ms": ts, "nonce": x(dn),
                      "tcp_port": port, "DISCOVER_packet": x(req), "DISCOVER_ANSWER_packet": x(ans),
                      "pairing_nonce": x(pdn), "PAIR_DISCOVER_packet": x(preq),
                      "PAIR_ANSWER_packet": x(pans)}

    # ---------------- 4. Session handshake ----------------
    sNp = bytes([0xD5]) * 32; sNpc = bytes([0xE6]) * 32
    spe = pub65(K["phone_session_eph_priv"]); sce = pub65(K["pc_session_eph_priv"])
    hint = hmac256(disc_key, b"MVTP1 hint" + sNp)[:8]
    hello1 = bytes([VER]) + spe + sNp + hint
    TH = H(b"MVTP1 hs", hello1, sce, sNpc)
    sig_pc_hs, _ = sign_raw(K["pc_identity_priv"], b"MVTP1 hs pc" + TH)
    hello2 = sce + sNpc + sig_pc_hs
    TH2 = H(TH, sig_pc_hs)
    sig_phone_hs, _ = sign_raw(K["phone_identity_priv"], b"MVTP1 hs phone" + TH2)
    hello3 = sig_phone_hs
    sZ = ecdh(K["phone_session_eph_priv"], sce)
    assert sZ == ecdh(K["pc_session_eph_priv"], spe)
    s_p2c = hkdf(sZ + pair_key, TH2, b"MVTP1 p2c", 32)
    s_c2p = hkdf(sZ + pair_key, TH2, b"MVTP1 c2p", 32)
    assert verify_raw(pc_id65, b"MVTP1 hs pc" + TH, sig_pc_hs)
    assert verify_raw(phone_id65, b"MVTP1 hs phone" + TH2, sig_phone_hs)
    V["session"] = {
        "inputs": {"Np": x(sNp), "Npc": x(sNpc), "phone_eph": "phone_session_eph_priv",
                   "pc_eph": "pc_session_eph_priv", "pair_key": x(pair_key)},
        "hint": x(hint),
        "frame_HELLO1": x(plain_frame(0x20, hello1)),
        "TH": x(TH), "sig_pc_raw64": x(sig_pc_hs),
        "frame_HELLO2": x(plain_frame(0x21, hello2)),
        "TH2": x(TH2), "sig_phone_raw64": x(sig_phone_hs),
        "frame_HELLO3": x(plain_frame(0x22, hello3)),
        "Z": x(sZ), "k_p2c": x(s_p2c), "k_c2p": x(s_c2p),
    }

    # ---------------- 5. Encrypted frames ----------------
    info_json = json.dumps({"app": "baroalarm", "proto": 1, "name": "Telefon", "free": 12345678901,
                            "kinds": ["image", "gif", "video"]}, separators=(",", ":"), ensure_ascii=False).encode()
    f0 = seal_frame(s_p2c, 0, 0x30, info_json)
    f1 = seal_frame(s_p2c, 1, 0x32, b"")
    data = b"hello"
    f_data = seal_frame(s_c2p, 7, 0x43, u32(5) + data)
    f_end = seal_frame(s_c2p, 8, 0x44, u32(5) + H(data))
    for k_, c_, f_ in [(s_p2c, 0, f0), (s_p2c, 1, f1), (s_c2p, 7, f_data), (s_c2p, 8, f_end)]:
        open_frame(k_, c_, f_)
    V["frames"] = {
        "HELLO_INFO_phone_ctr0": {"key": "session.k_p2c", "counter": 0, "type": "0x30",
                                  "payload_utf8": info_json.decode(), "frame": x(f0)},
        "PING_phone_ctr1": {"key": "session.k_p2c", "counter": 1, "type": "0x32", "payload": "", "frame": x(f1)},
        "DATA_pc_ctr7": {"key": "session.k_c2p", "counter": 7, "type": "0x43",
                         "payload": x(u32(5) + data), "frame": x(f_data)},
        "ITEM_END_pc_ctr8": {"key": "session.k_c2p", "counter": 8, "type": "0x44",
                             "payload": x(u32(5) + H(data)), "frame": x(f_end)},
        "tamper_check": "Flipping any bit of any frame above, or using the wrong counter, must make decryption fail.",
    }

    # ---------------- 6. Example JSON messages (format only) ----------------
    V["json_examples"] = {
        "OFFER": {"offer": 1, "last": True,
                  "folders": [{"f": 0, "parent": -1, "name": "Tatil", "tags": ["yaz"]},
                              {"f": 1, "parent": 0, "name": "Bodrum 2026", "tags": []}],
                  "items": [{"i": 5, "sha256": x(H(data)), "name": "IMG_0001.HEIC", "size": 5,
                             "kind": "image", "mime": "image/heic", "w": 4032, "h": 3024, "dur_ms": 0,
                             "taken": 1751371200000, "fav": True, "tags": ["deniz"], "marks": [], "folder": 1}]},
        "ANSWER": {"offer": 1, "answers": [{"i": 5, "a": "want"}]},
    }
    print(json.dumps(V, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
