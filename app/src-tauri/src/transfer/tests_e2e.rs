//! End-to-end tests with a fake phone: a real vault, real sockets on this
//! computer, and the phone's side of MVTP/1 written out here from the
//! protocol document (so the PC side is checked against it, not against itself).

use std::io::Write;
use std::net::{TcpStream, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use sha2::{Digest, Sha256};
use vault_core::{ObjectId, ObjectKind};

use super::mvtp::{self, KeyPair, Sealer, ty};
use super::server::{self, Hooks, Ports};
use crate::session::{self, Session};

/// The transfer state is global: one test at a time.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

type Events = Arc<Mutex<Vec<(String, Value)>>>;

fn vault() -> (tempfile::TempDir, Arc<Session>, Events) {
    let t = tempfile::tempdir().unwrap();
    let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
    let s = Arc::new(s);
    let ev: Events = Arc::default();
    let ev2 = ev.clone();
    server::on_unlock(
        s.clone(),
        Hooks {
            emit: Box::new(move |n, v| ev2.lock().unwrap().push((n.to_string(), v))),
            keep_awake: Box::new(|| {}),
            playable: Box::new(|_, _| (0, vec![])),
        },
        Ports { tcp: 0, udp: 0 },
    );
    (t, s, ev)
}

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
    while !f() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn done_events(ev: &Events, dir: &str) -> Vec<Value> {
    ev.lock()
        .unwrap()
        .iter()
        .filter(|(n, v)| n == "transfer-done" && v["dir"] == dir)
        .map(|(_, v)| v.clone())
        .collect()
}

fn udp_ask(port: u16, packet: &[u8]) -> Option<Vec<u8>> {
    let u = UdpSocket::bind("127.0.0.1:0").unwrap();
    u.set_read_timeout(Some(Duration::from_millis(700))).unwrap();
    u.send_to(packet, ("127.0.0.1", port)).unwrap();
    let mut buf = [0u8; 256];
    u.recv_from(&mut buf).ok().map(|(n, _)| buf[..n].to_vec())
}

/// What the phone keeps after pairing.
struct PhonePairing {
    id: KeyPair,
    pc_id: [u8; 65],
    pair_key: [u8; 32],
}

/// The phone's side of pairing (§5). The test plays the user on both sides.
fn pair(phone_says: bool, pc_says: bool) -> Result<PhonePairing, String> {
    server::pair_start().unwrap();
    let (tcp, udp) = server::test_ports().expect("listening while pairing");
    let udp = udp.expect("udp port");
    // §5.1: find the PC.
    let n: [u8; 16] = mvtp::random();
    let ans = udp_ask(udp, &mvtp::pair_discover(&n)).expect("PAIR_ANSWER");
    assert_eq!(ans, mvtp::pair_answer(&n, tcp));
    // §5.2
    let mut s = TcpStream::connect(("127.0.0.1", tcp)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let eph = KeyPair::generate();
    let np: [u8; 32] = mvtp::random();
    let c = mvtp::commit(&eph.public, &np);
    mvtp::write_plain(&mut s, ty::PAIR_COMMIT, &[&[1u8][..], &c].concat()).unwrap();
    let pcp = mvtp::read_plain(&mut s, ty::PAIR_PC).map_err(|e| e.to_string())?;
    let pc_eph: [u8; 65] = pcp[..65].try_into().unwrap();
    let npc: [u8; 32] = pcp[65..97].try_into().unwrap();
    mvtp::write_plain(&mut s, ty::PAIR_REVEAL, &[&eph.public[..], &np].concat()).unwrap();
    let z = eph.ecdh(&pc_eph).unwrap();
    let k = mvtp::pair_keys(&c, &pc_eph, &npc, &eph.public, &np, &z);
    let mut tx = Sealer::new(k.p2c.clone());
    let mut rx = Sealer::new(k.c2p.clone());
    // §5.3
    let id = KeyPair::generate();
    s.write_all(&tx.seal(ty::PAIR_ID, &mvtp::pair_id_payload(&id, 1, &k.t, "Telefon")).unwrap()).unwrap();
    let (l, body) = mvtp::read_body(&mut s).map_err(|e| e.to_string())?;
    let (t, p) = rx.open(l, &body).unwrap();
    assert_eq!(t, ty::PAIR_ID);
    let (pc_id, pc_name) = mvtp::parse_pair_id(&p, 2, &k.t).unwrap();
    assert_eq!(pc_name, "V");
    // The PC shows the same code.
    let code = mvtp::code6(&k.sas4);
    wait_for("the code on the PC", || server::status().pairing.and_then(|p| p.code) == Some(code.clone()));
    assert_eq!(server::status().pairing.unwrap().phone_name.as_deref(), Some("Telefon"));
    server::pair_confirm(pc_says).unwrap();
    s.write_all(&tx.seal(ty::PAIR_CONFIRM, &[phone_says as u8]).unwrap()).unwrap();
    // The PC's answer.
    if pc_says {
        let (l, body) = mvtp::read_body(&mut s).map_err(|e| e.to_string())?;
        let (t, p) = rx.open(l, &body).unwrap();
        assert_eq!((t, p.as_slice()), (ty::PAIR_CONFIRM, &[1u8][..]));
    }
    wait_for("pairing to end", || {
        server::status().pairing.is_some_and(|p| p.state == "done" || p.state == "failed")
    });
    let st = server::status().pairing.unwrap();
    if st.state != "done" {
        return Err(st.message.unwrap_or_default());
    }
    Ok(PhonePairing { id, pc_id, pair_key: *k.pair_key })
}

/// A connected fake phone (§6–§7).
struct Phone {
    s: TcpStream,
    tx: Sealer,
    rx: Sealer,
}

impl Phone {
    fn connect(pp: &PhonePairing) -> Phone {
        let (_, udp) = server::test_ports().unwrap();
        let dk = mvtp::disc_key(&pp.pair_key);
        let n: [u8; 16] = mvtp::random();
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let pkt = mvtp::discover(&dk, ts, &n);
        let ans = udp_ask(udp.unwrap(), &pkt).expect("DISCOVER_ANSWER");
        assert_eq!(ans.len(), 6 + 16 + 2 + 32);
        assert_eq!(&ans[6..22], &n);
        let port = u16::from_be_bytes([ans[22], ans[23]]);
        assert_eq!(&ans[24..], &mvtp::hmac256(&*dk, &[&ans[..24]])[..]);
        assert!(udp_ask(udp.unwrap(), &pkt).is_none(), "a replayed DISCOVER gets no answer");
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let eph = KeyPair::generate();
        let np: [u8; 32] = mvtp::random();
        let hello1 = [&[1u8][..], &eph.public, &np, &mvtp::hint(&dk, &np)].concat();
        mvtp::write_plain(&mut s, ty::HELLO1, &hello1).unwrap();
        let h2 = mvtp::read_plain(&mut s, ty::HELLO2).unwrap();
        let pc_eph: [u8; 65] = h2[..65].try_into().unwrap();
        let npc: [u8; 32] = h2[65..97].try_into().unwrap();
        let sig_pc: [u8; 64] = h2[97..161].try_into().unwrap();
        let th = mvtp::th(&hello1, &pc_eph, &npc);
        assert!(mvtp::verify(&pp.pc_id, &mvtp::hs_pc_msg(&th), &sig_pc), "the PC proves who it is");
        let th2 = mvtp::th2(&th, &sig_pc);
        mvtp::write_plain(&mut s, ty::HELLO3, &pp.id.sign(&mvtp::hs_phone_msg(&th2))).unwrap();
        let z = eph.ecdh(&pc_eph).unwrap();
        let (p2c, c2p) = mvtp::session_keys(&z, &pp.pair_key, &th2);
        let mut ph = Phone { s, tx: Sealer::new(p2c), rx: Sealer::new(c2p) };
        let (t, info) = ph.recv();
        assert_eq!(t, ty::INFO);
        let info: mvtp::Info = serde_json::from_slice(&info).unwrap();
        assert_eq!(info.app, "mediavault");
        ph.send(ty::INFO, br#"{"app":"baroalarm","proto":1,"name":"Telefon","free":99999999999,"kinds":["image","gif","video"]}"#);
        ph
    }

    fn send(&mut self, t: u8, p: &[u8]) {
        let f = self.tx.seal(t, p).unwrap();
        self.s.write_all(&f).unwrap();
    }

    fn recv(&mut self) -> (u8, Vec<u8>) {
        loop {
            let (l, body) = mvtp::read_body(&mut self.s).unwrap();
            let (t, p) = self.rx.open(l, &body).unwrap();
            if t != ty::PING && t != ty::PONG {
                return (t, p.to_vec());
            }
        }
    }

    fn recv_json(&mut self, want: u8) -> Value {
        let (t, p) = self.recv();
        assert_eq!(t, want, "message type");
        serde_json::from_slice(&p).unwrap()
    }

    /// Send one file in DATA frames of `piece` bytes.
    fn send_file(&mut self, r: u32, data: &[u8], piece: usize, sha: &[u8; 32]) {
        self.send(ty::ITEM_START, &mvtp::item_start(r, data.len() as u64));
        for c in data.chunks(piece) {
            self.send(ty::DATA, &[&r.to_be_bytes()[..], c].concat());
        }
        self.send(ty::ITEM_END, &mvtp::item_end(r, sha));
    }
}

fn sha(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

fn bytes(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}

fn offer_json(offer: u32, items: &[(u32, &[u8], &str, &str, i64)]) -> Vec<u8> {
    let its: Vec<Value> = items
        .iter()
        .map(|(i, data, name, kind, folder)| {
            serde_json::json!({
                "i": i, "sha256": hex::encode(sha(data)), "name": name, "size": data.len(),
                "kind": kind, "mime": "", "w": 0, "h": 0, "dur_ms": 0, "taken": 1751371200000i64,
                "fav": true, "tags": ["deniz"], "marks": [], "folder": folder
            })
        })
        .collect();
    serde_json::to_vec(&serde_json::json!({
        "offer": offer, "last": true,
        "folders": [{"f": 0, "parent": -1, "name": "Tatil", "tags": ["yaz"]},
                    {"f": 1, "parent": 0, "name": "Bodrum 2026", "tags": []}],
        "items": its
    }))
    .unwrap()
}

fn stored(s: &Session, name: &str) -> Option<(i64, Vec<u8>, i64)> {
    let row: Option<(i64, String, i64)> = s
        .db()
        .query_row("SELECT id, object_id, folder_id FROM media WHERE original_name = ? AND deleted_at IS NULL", [name], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .ok();
    let (id, oid, folder) = row?;
    let data = s.vault().read_object(ObjectKind::Media, &ObjectId::from_hex(&oid).unwrap()).unwrap();
    Some((id, data.to_vec(), folder))
}

#[test]
fn pair_find_connect_and_transfer_both_ways() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let (_t, s, ev) = vault();
    // Nothing paired: not listening at all.
    assert!(!server::status().listening);
    let pp = pair(true, true).unwrap();
    let st = server::status();
    assert_eq!(st.peers.len(), 1);
    assert_eq!(st.peers[0].name, "Telefon");
    assert!(st.listening, "keeps listening for the paired phone");

    let mut ph = Phone::connect(&pp);
    wait_for("connected", || server::status().connected.as_deref() == Some("Telefon"));

    // ---- phone → PC: two files (one in two DATA pieces) and a PDF it can't take.
    let a = bytes(100_000, 1);
    let b = bytes(10, 2);
    ph.send(
        ty::OFFER,
        &offer_json(7, &[(1, &a, "IMG_0001.HEIC", "image", 1), (2, &b, "b.jpg", "image", -1), (3, b"%PDF", "x.pdf", "pdf", -1)]),
    );
    let ansv = ph.recv_json(ty::ANSWER);
    assert_eq!(ansv["offer"], 7);
    let got: Vec<&str> = ansv["answers"].as_array().unwrap().iter().map(|x| x["a"].as_str().unwrap()).collect();
    assert_eq!(got, ["want", "want", "cant"]);
    ph.send_file(1, &a, 65_536, &sha(&a));
    let (t, p) = ph.recv();
    assert_eq!((t, &p[..]), (ty::ITEM_OK, &1u32.to_be_bytes()[..]));
    // A damaged file: the end hash doesn't match → refused, nothing kept.
    ph.send_file(2, &b, 64, &sha(b"something else"));
    let (t, p) = ph.recv();
    assert_eq!((t, &p[..]), (ty::ITEM_FAILED, &[0, 0, 0, 2, mvtp::fail::HASH_MISMATCH][..]));
    wait_for("receive done", || !done_events(&ev, "receive").is_empty());
    let d = &done_events(&ev, "receive")[0];
    assert_eq!((d["done"].as_u64(), d["cant"].as_u64()), (Some(1), Some(1)));
    assert_eq!(d["failed"].as_array().unwrap().len(), 1);
    let (got_id, data, folder) = stored(&s, "IMG_0001.HEIC").expect("stored");
    assert_eq!(data, a, "the same bytes arrive");
    assert!(stored(&s, "b.jpg").is_none());
    // Landing folder / Tatil / Bodrum 2026, folder tag on Tatil, item tag and favourite.
    let path: (String, String, String) = s
        .db()
        .query_row(
            "SELECT f.name, p.name, g.name FROM folders f JOIN folders p ON p.id = f.parent_id JOIN folders g ON g.id = p.parent_id WHERE f.id = ?",
            [folder],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(path, ("Bodrum 2026".into(), "Tatil".into(), "Received from phone".into()));
    let fav: i64 = s.db().query_row("SELECT favourite FROM media WHERE id = ?", [got_id], |r| r.get(0)).unwrap();
    assert_eq!(fav, 1);

    // The same file offered again: "have".
    ph.send(ty::OFFER, &offer_json(8, &[(4, &a, "again.heic", "image", -1)]));
    let ansv = ph.recv_json(ty::ANSWER);
    assert_eq!(ansv["answers"][0]["a"], "have");

    // ---- PC → phone: the received file (phone says "have") and a new one.
    let c = bytes(150_000, 3);
    let top = crate::library::get_or_create_folder(&s.db(), None, "Trips").unwrap();
    let new_id = crate::import::add_bytes(&s, Some(top), "c.jpg", &c).unwrap();
    let n = server::send(&[got_id, new_id], &[]).unwrap();
    assert_eq!(n, 2);
    let off = ph.recv_json(ty::OFFER);
    assert_eq!(off["last"], true);
    let items = off["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let ra = items[0]["i"].as_u64().unwrap() as u32;
    let rc = items[1]["i"].as_u64().unwrap() as u32;
    assert_eq!(items[1]["sha256"], hex::encode(sha(&c)));
    assert_eq!(items[1]["name"], "c.jpg");
    // Folder paths: the received item's full path, and Trips.
    let names: Vec<&str> = off["folders"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"Received from phone") && names.contains(&"Trips"), "{names:?}");
    ph.send(
        ty::ANSWER,
        &serde_json::to_vec(&serde_json::json!({"offer": off["offer"], "answers": [{"i": ra, "a": "have"}, {"i": rc, "a": "want"}]}))
            .unwrap(),
    );
    let (t, p) = ph.recv();
    assert_eq!(t, ty::ITEM_START);
    assert_eq!(mvtp::ref_of(&p), Some(rc));
    assert_eq!(u64::from_be_bytes(p[4..12].try_into().unwrap()), c.len() as u64);
    let mut got = Vec::new();
    loop {
        let (t, p) = ph.recv();
        match t {
            ty::DATA => {
                assert!(p.len() - 4 <= mvtp::MAX_DATA);
                got.extend_from_slice(&p[4..]);
            }
            ty::ITEM_END => {
                assert_eq!(&p[4..], &sha(&c));
                break;
            }
            other => panic!("unexpected {other:#x}"),
        }
    }
    assert_eq!(got, c);
    ph.send(ty::ITEM_OK, &rc.to_be_bytes());
    wait_for("send done", || !done_events(&ev, "send").is_empty());
    let d = &done_events(&ev, "send")[0];
    assert_eq!((d["done"].as_u64(), d["have"].as_u64()), (Some(1), Some(1)));
    assert!(d["stopped"].is_null());

    // ---- Locking mid-file: the phone hears LOCKED, nothing half-received is kept.
    let big = bytes(400_000, 9);
    ph.send(ty::OFFER, &offer_json(9, &[(10, &big, "big.mov", "video", -1)]));
    assert_eq!(ph.recv_json(ty::ANSWER)["answers"][0]["a"], "want");
    ph.send(ty::ITEM_START, &mvtp::item_start(10, big.len() as u64));
    ph.send(ty::DATA, &[&10u32.to_be_bytes()[..], &big[..65_536]].concat());
    std::thread::sleep(Duration::from_millis(200));
    server::on_lock();
    let (t, _) = ph.recv();
    assert_eq!(t, ty::LOCKED);
    assert!(stored(&s, "big.mov").is_none());
    assert!(!server::status().listening);
    wait_for("the cut-short receive to report", || {
        done_events(&ev, "receive").iter().any(|d| d["stopped"].as_str() == Some("This vault locked."))
    });
}

#[test]
fn strangers_and_refusals() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let (_t, _s, _ev) = vault();
    // The user says no on the PC: nothing saved.
    assert!(pair(true, false).is_err());
    assert!(server::status().peers.is_empty());
    // The phone says no.
    assert!(pair(false, true).is_err());
    assert!(server::status().peers.is_empty());
    // A real pairing, then a stranger with the wrong key.
    let pp = pair(true, true).unwrap();
    let (tcp, udp) = server::test_ports().unwrap();
    let wrong = mvtp::disc_key(&[7u8; 32]);
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    assert!(udp_ask(udp.unwrap(), &mvtp::discover(&wrong, ts, &mvtp::random())).is_none(), "strangers get no reply");
    // An old DISCOVER (clock 1 hour off) gets no reply either.
    let dk = mvtp::disc_key(&pp.pair_key);
    assert!(udp_ask(udp.unwrap(), &mvtp::discover(&dk, ts - 3_600_000, &mvtp::random())).is_none());
    // Pairing packets get no reply outside pairing mode.
    assert!(udp_ask(udp.unwrap(), &mvtp::pair_discover(&mvtp::random())).is_none());
    // A HELLO1 with a hint for no known phone: closed without a word.
    let mut s = TcpStream::connect(("127.0.0.1", tcp)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let eph = KeyPair::generate();
    let np: [u8; 32] = mvtp::random();
    mvtp::write_plain(&mut s, ty::HELLO1, &[&[1u8][..], &eph.public, &np, &[0u8; 8]].concat()).unwrap();
    assert!(mvtp::read_body(&mut s).is_err());
    // The right phone, but a forged HELLO3: closed.
    let mut s = TcpStream::connect(("127.0.0.1", tcp)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let hello1 = [&[1u8][..], &eph.public, &np, &mvtp::hint(&dk, &np)].concat();
    mvtp::write_plain(&mut s, ty::HELLO1, &hello1).unwrap();
    mvtp::read_plain(&mut s, ty::HELLO2).unwrap();
    mvtp::write_plain(&mut s, ty::HELLO3, &KeyPair::generate().sign(b"nonsense")).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(server::status().connected.is_none());
    // Sending with no phone connected: a clear message.
    assert!(server::send(&[1], &[]).unwrap_err().contains("Aktarım"));
    // Forgetting the phone stops listening.
    let id = server::status().peers[0].id.clone();
    server::forget(&id).unwrap();
    assert!(server::status().peers.is_empty());
    assert!(!server::status().listening);
    server::on_lock();
}
