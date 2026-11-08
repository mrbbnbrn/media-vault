//! The PC side of the Wi-Fi transfer: listening on the home network while the
//! vault is unlocked, pairing (§5), finding (§6) and the session handshake
//! (§7). One connected phone at a time; `conn.rs` takes over after the handshake.

use std::collections::VecDeque;
use std::io;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use zeroize::Zeroizing;

use super::conn::Conn;
use super::mvtp::{self, KeyPair, Sealer, ty};
use super::store::{self, Peer};
use crate::session::Session;

/// How the transfer talks to the rest of the app (the window, auto-lock).
pub struct Hooks {
    pub emit: Box<dyn Fn(&str, serde_json::Value) + Send + Sync>,
    /// A transfer is running: counts as activity, so the vault doesn't auto-lock.
    pub keep_awake: Box<dyn Fn() + Send + Sync>,
    /// Make playable copies of these received items; returns how many were made.
    pub playable: Box<dyn Fn(&Arc<Session>, &[i64]) -> usize + Send + Sync>,
}

/// Ports (0 = any free one; the tests use that).
#[derive(Clone, Copy)]
pub struct Ports {
    pub tcp: u16,
    pub udp: u16,
}

impl Default for Ports {
    fn default() -> Self {
        Ports { tcp: mvtp::TCP_PORT, udp: mvtp::UDP_PORT }
    }
}

/// How long pairing mode stays on.
const PAIRING_TIME: Duration = Duration::from_secs(120);
/// A DISCOVER's clock may be this far off (§6).
const CLOCK_SLACK_MS: i64 = 10 * 60 * 1000;
/// Seen DISCOVER nonces are remembered this long.
const REPLAY_KEEP: Duration = Duration::from_secs(20 * 60);
/// The whole handshake must be done within this.
const HANDSHAKE_TIME: Duration = Duration::from_secs(10);

// ---- what the window sees --------------------------------------------------------

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeerDto {
    pub id: String,
    pub name: String,
    pub paired_at: i64,
    pub connected: bool,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingDto {
    pub state: String,
    pub code: Option<String>,
    pub phone_name: Option<String>,
    pub expires_at: i64,
    pub message: Option<String>,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub listening: bool,
    pub port: Option<u16>,
    pub peers: Vec<PeerDto>,
    pub connected: Option<String>,
    pub pairing: Option<PairingDto>,
    pub busy: bool,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub dir: &'static str,
    pub done: usize,
    pub total: usize,
    pub bytes: u64,
    pub total_bytes: u64,
    pub current: String,
}

#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    pub dir: &'static str,
    pub done: usize,
    pub have: usize,
    pub cant: usize,
    pub failed: Vec<(String, String)>,
    pub stopped: Option<String>,
    pub folder: Option<i64>,
    pub playable: usize,
}

impl Done {
    pub fn new(dir: &'static str) -> Self {
        Done { dir, ..Default::default() }
    }
}

// ---- the running state ---------------------------------------------------------------

struct Pairing {
    until: Instant,
    expires_at: i64,
    state: &'static str,
    code: Option<String>,
    phone_name: Option<String>,
    message: Option<String>,
    /// A phone is going through pairing right now.
    busy: bool,
    /// What the user pressed for the shown code.
    user: Option<bool>,
}

struct Listeners {
    stop: Arc<AtomicBool>,
    tcp_port: u16,
    #[cfg_attr(not(test), allow(dead_code))]
    udp_port: Option<u16>,
}

pub struct Rt {
    s: Arc<Session>,
    hooks: Hooks,
    ports: Ports,
    listeners: Mutex<Option<Listeners>>,
    pairing: Mutex<Option<Pairing>>,
    conn: Mutex<Option<Arc<Conn>>>,
    replay: Mutex<VecDeque<([u8; 16], Instant)>>,
    last_progress: Mutex<Instant>,
}

static RT: Mutex<Option<Arc<Rt>>> = Mutex::new(None);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn current() -> Option<Arc<Rt>> {
    RT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn need() -> Result<Arc<Rt>, String> {
    current().ok_or_else(|| "The vault is locked.".to_string())
}

/// Addresses a phone at home can have (§6), plus this computer itself (tests).
pub fn is_home_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_link_local() || v.is_loopback(),
        IpAddr::V6(_) => false, // IPv4 only (r2)
    }
}

// ---- public API (commands and lib.rs) -----------------------------------------------------

/// A vault was unlocked: listen if a phone is paired.
pub fn on_unlock(s: Arc<Session>, hooks: Hooks, ports: Ports) {
    on_lock(); // anything left from another vault
    let rt = Arc::new(Rt {
        s,
        hooks,
        ports,
        listeners: Mutex::new(None),
        pairing: Mutex::new(None),
        conn: Mutex::new(None),
        replay: Mutex::new(VecDeque::new()),
        last_progress: Mutex::new(Instant::now() - Duration::from_secs(1)),
    });
    *RT.lock().unwrap_or_else(|e| e.into_inner()) = Some(rt.clone());
    rt.update_listening();
    rt.status_changed();
}

/// The vault is locking: tell the phone, stop everything.
pub fn on_lock() {
    let Some(rt) = RT.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
    let conn = rt.conn.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(c) = conn {
        c.bye(true, Some("This vault locked.".into()));
    }
    rt.stop_listening();
}

pub fn status() -> Status {
    match current() {
        Some(rt) => rt.status(),
        None => Status { listening: false, port: None, peers: vec![], connected: None, pairing: None, busy: false },
    }
}

pub fn pair_start() -> Result<(), String> {
    let rt = need()?;
    {
        let mut p = rt.pairing.lock().unwrap_or_else(|e| e.into_inner());
        if p.as_ref().is_some_and(|p| p.busy) {
            return Err("A phone is pairing right now.".into());
        }
        *p = Some(Pairing {
            until: Instant::now() + PAIRING_TIME,
            expires_at: now_ms() + PAIRING_TIME.as_millis() as i64,
            state: "waiting",
            code: None,
            phone_name: None,
            message: None,
            busy: false,
            user: None,
        });
    }
    rt.update_listening();
    if rt.listeners.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
        *rt.pairing.lock().unwrap_or_else(|e| e.into_inner()) = None;
        return Err("Media Vault couldn't start listening on the network. Is another copy of it running?".into());
    }
    rt.status_changed();
    // Pairing mode ends by itself.
    let rt2 = rt.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PAIRING_TIME + Duration::from_millis(200));
        let mut p = rt2.pairing.lock().unwrap_or_else(|e| e.into_inner());
        if p.as_ref().is_some_and(|p| p.state == "waiting" && p.until <= Instant::now()) {
            *p = None;
            drop(p);
            rt2.update_listening();
            rt2.status_changed();
        }
    });
    Ok(())
}

pub fn pair_confirm(yes: bool) -> Result<(), String> {
    let rt = need()?;
    let mut p = rt.pairing.lock().unwrap_or_else(|e| e.into_inner());
    match p.as_mut() {
        Some(p) if p.state == "code" => {
            p.user = Some(yes);
            if yes {
                p.state = "confirmed";
            }
        }
        _ => return Err("There's no pairing waiting for an answer.".into()),
    }
    drop(p);
    rt.status_changed();
    Ok(())
}

pub fn pair_cancel() -> Result<(), String> {
    let rt = need()?;
    {
        let mut p = rt.pairing.lock().unwrap_or_else(|e| e.into_inner());
        match p.as_mut() {
            Some(x) if x.busy => x.user = Some(false),
            _ => *p = None,
        }
    }
    rt.update_listening();
    rt.status_changed();
    Ok(())
}

pub fn forget(id: &str) -> Result<(), String> {
    let rt = need()?;
    let removed = store::forget(&rt.s.db(), id)?;
    if removed {
        rt.s.mark_dirty();
        let _ = rt.s.save();
        let conn = rt.conn.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(c) = conn.filter(|c| c.peer_id == id) {
            c.bye(false, Some("This phone was forgotten.".into()));
        }
    }
    rt.update_listening();
    rt.status_changed();
    Ok(())
}

pub fn send(media: &[i64], folders: &[i64]) -> Result<usize, String> {
    let rt = need()?;
    let conn = rt.conn.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(c) = conn.filter(|c| !c.is_closed()) else {
        return Err("Your phone isn't connected. Open Aktarım on your phone first (both on the same Wi-Fi).".into());
    };
    c.queue_send(media, folders)
}

pub fn cancel() -> Result<(), String> {
    let rt = need()?;
    if let Some(c) = rt.conn.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        c.cancel_all();
    }
    Ok(())
}

// ---- Rt: shared helpers --------------------------------------------------------------------

impl Rt {
    pub fn session(&self) -> Arc<Session> {
        self.s.clone()
    }

    pub fn vault_name(&self) -> String {
        self.s.info().name
    }

    pub fn free_bytes(&self) -> Option<u64> {
        crate::diskspace::free_bytes(self.s.vault().root())
    }

    pub fn make_playable(&self, ids: &[i64]) -> usize {
        (self.hooks.playable)(&self.s, ids)
    }

    fn emit<T: Serialize>(&self, name: &str, v: &T) {
        if let Ok(j) = serde_json::to_value(v) {
            (self.hooks.emit)(name, j);
        }
    }

    pub fn status_changed(&self) {
        self.emit("transfer-status", &self.status());
    }

    /// A few times a second at most (always when `force`).
    pub fn emit_progress(&self, p: &Progress, force: bool) {
        let mut last = self.last_progress.lock().unwrap_or_else(|e| e.into_inner());
        if force || last.elapsed() >= Duration::from_millis(250) {
            *last = Instant::now();
            drop(last);
            (self.hooks.keep_awake)();
            self.emit("transfer-progress", p);
        }
    }

    pub fn emit_done(&self, d: &Done) {
        self.emit("transfer-done", d);
        self.status_changed();
    }

    pub fn conn_closed(&self, c: &Conn) {
        let mut cur = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if cur.as_ref().is_some_and(|x| std::ptr::eq(&**x, c)) {
            *cur = None;
        }
        drop(cur);
        self.status_changed();
    }

    fn peers(&self) -> Vec<Peer> {
        store::peers(&self.s.db())
    }

    fn status(&self) -> Status {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner()).clone().filter(|c| !c.is_closed());
        let peers = if self.s.is_closed() { vec![] } else { self.peers() };
        let l = self.listeners.lock().unwrap_or_else(|e| e.into_inner());
        let pairing = self.pairing.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|p| PairingDto {
            state: p.state.into(),
            code: p.code.clone(),
            phone_name: p.phone_name.clone(),
            expires_at: p.expires_at,
            message: p.message.clone(),
        });
        Status {
            listening: l.is_some(),
            port: l.as_ref().map(|l| l.tcp_port),
            peers: peers
                .iter()
                .map(|p| PeerDto {
                    id: p.id(),
                    name: p.name.clone(),
                    paired_at: p.paired_at,
                    connected: conn.as_ref().is_some_and(|c| c.peer_id == p.id()),
                })
                .collect(),
            connected: conn.as_ref().map(|c| c.peer_name.clone()),
            pairing,
            busy: conn.as_ref().is_some_and(|c| c.busy()),
        }
    }

    fn pairing_on(&self) -> bool {
        self.pairing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|p| p.busy || p.until > Instant::now())
    }

    /// Listen while a phone is paired or pairing is on; stop otherwise.
    fn update_listening(self: &Arc<Self>) {
        if self.s.is_closed() {
            self.stop_listening();
            return;
        }
        let want = self.pairing_on() || !self.peers().is_empty();
        let running = self.listeners.lock().unwrap_or_else(|e| e.into_inner()).is_some();
        if want && !running {
            match self.start_listening() {
                Ok(l) => *self.listeners.lock().unwrap_or_else(|e| e.into_inner()) = Some(l),
                Err(e) => crate::diaglog::note(&format!("transfer: can't listen ({e})")),
            }
        } else if !want && running {
            self.stop_listening();
        }
    }

    fn stop_listening(&self) {
        if let Some(l) = self.listeners.lock().unwrap_or_else(|e| e.into_inner()).take() {
            l.stop.store(true, Ordering::SeqCst);
        }
    }

    fn start_listening(self: &Arc<Self>) -> io::Result<Listeners> {
        let tcp = TcpListener::bind(("0.0.0.0", self.ports.tcp)).or_else(|_| TcpListener::bind(("0.0.0.0", 0)))?;
        tcp.set_nonblocking(true)?;
        let tcp_port = tcp.local_addr()?.port();
        // Without the UDP port the phone can still reach a known address directly.
        let udp = UdpSocket::bind(("0.0.0.0", self.ports.udp)).ok();
        let udp_port = udp.as_ref().and_then(|u| u.local_addr().ok()).map(|a| a.port());
        let stop = Arc::new(AtomicBool::new(false));
        let (rt, st) = (self.clone(), stop.clone());
        std::thread::Builder::new().name("transfer-accept".into()).spawn(move || rt.accept_loop(tcp, st))?;
        if let Some(u) = udp {
            u.set_read_timeout(Some(Duration::from_millis(500)))?;
            let (rt, st) = (self.clone(), stop.clone());
            std::thread::Builder::new()
                .name("transfer-find".into())
                .spawn(move || rt.udp_loop(u, st, tcp_port))?;
        }
        Ok(Listeners { stop, tcp_port, udp_port })
    }

    // ---- UDP: being found (§5.1, §6) -------------------------------------------------------

    fn udp_loop(self: Arc<Self>, u: UdpSocket, stop: Arc<AtomicBool>, tcp_port: u16) {
        let mut buf = [0u8; 256];
        while !stop.load(Ordering::SeqCst) && !self.s.is_closed() {
            let Ok((n, from)) = u.recv_from(&mut buf) else { continue };
            if !is_home_address(from.ip()) {
                continue;
            }
            if let Some(reply) = self.answer_udp(&buf[..n], tcp_port) {
                let _ = u.send_to(&reply, from);
            }
        }
    }

    /// The answer to one UDP packet, or None (no reply at all).
    pub fn answer_udp(&self, p: &[u8], tcp_port: u16) -> Option<Vec<u8>> {
        if let Some(nonce) = mvtp::parse_pair_discover(p) {
            let on = self.pairing.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|x| !x.busy && x.until > Instant::now());
            return on.then(|| mvtp::pair_answer(&nonce, tcp_port));
        }
        let (ts, nonce, body, mac) = mvtp::split_discover(p)?;
        if (ts as i64 - now_ms()).abs() > CLOCK_SLACK_MS {
            return None;
        }
        let peer_key = self.peers().into_iter().filter_map(|p| p.pair_key()).find_map(|pk| {
            let dk = mvtp::disc_key(&pk);
            mvtp::discover_matches(&dk, body, mac).then_some(dk)
        })?;
        {
            let mut seen = self.replay.lock().unwrap_or_else(|e| e.into_inner());
            while seen.front().is_some_and(|(_, t)| t.elapsed() > REPLAY_KEEP) {
                seen.pop_front();
            }
            if seen.iter().any(|(n, _)| *n == nonce) {
                return None;
            }
            seen.push_back((nonce, Instant::now()));
            if seen.len() > 4096 {
                seen.pop_front();
            }
        }
        Some(mvtp::discover_answer(&peer_key, &nonce, tcp_port))
    }

    // ---- TCP --------------------------------------------------------------------------------

    fn accept_loop(self: Arc<Self>, l: TcpListener, stop: Arc<AtomicBool>) {
        while !stop.load(Ordering::SeqCst) && !self.s.is_closed() {
            match l.accept() {
                Ok((stream, from)) => {
                    if !is_home_address(from.ip()) {
                        continue;
                    }
                    let rt = self.clone();
                    let _ = std::thread::Builder::new().name("transfer-hello".into()).spawn(move || {
                        let _ = stream.set_nonblocking(false);
                        rt.handle(stream, from);
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => std::thread::sleep(Duration::from_millis(200)),
            }
        }
    }

    fn handle(self: Arc<Self>, mut stream: TcpStream, _from: SocketAddr) {
        let _ = stream.set_read_timeout(Some(HANDSHAKE_TIME));
        let _ = stream.set_write_timeout(Some(HANDSHAKE_TIME));
        let Ok((_, body)) = mvtp::read_body(&mut stream) else { return };
        match body[0] {
            ty::PAIR_COMMIT => {
                let _ = self.pair(stream, &body[1..]);
            }
            ty::HELLO1 => {
                let _ = self.handshake(stream, &body[1..]);
            }
            _ => {} // close without a word
        }
    }

    // ---- pairing (§5.2–5.4) ---------------------------------------------------------------

    fn set_pairing(&self, f: impl FnOnce(&mut Pairing)) {
        if let Some(p) = self.pairing.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            f(p);
        }
        self.status_changed();
    }

    fn pair(self: &Arc<Self>, mut stream: TcpStream, commit: &[u8]) -> mvtp::Result<()> {
        {
            let mut p = self.pairing.lock().unwrap_or_else(|e| e.into_inner());
            match p.as_mut() {
                Some(x) if !x.busy && x.until > Instant::now() && x.state == "waiting" => {
                    x.busy = true;
                    x.user = None;
                }
                _ => return Ok(()),
            }
        }
        let r = self.pair_inner(&mut stream, commit);
        let failed = match &r {
            Ok(Some(_)) => None,
            Ok(None) => Some("Pairing was cancelled.".to_string()),
            Err(mvtp::Error::Protocol(w)) => Some(format!("Pairing failed ({w}). Try again.")),
            Err(mvtp::Error::Io(_)) => Some("The phone stopped answering. Try again.".to_string()),
        };
        {
            let mut p = self.pairing.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(x) = p.as_mut() {
                x.busy = false;
                match (&r, failed) {
                    (Ok(Some(name)), _) => {
                        x.state = "done";
                        x.message = Some(format!("Paired with {name}."));
                        x.until = Instant::now();
                    }
                    (_, why) => {
                        x.state = "failed";
                        x.message = why;
                        x.until = Instant::now();
                    }
                }
            }
        }
        self.update_listening();
        self.status_changed();
        r.map(|_| ())
    }

    /// Ok(Some(phone name)) when paired and saved; Ok(None) when someone said no.
    fn pair_inner(self: &Arc<Self>, stream: &mut TcpStream, commit: &[u8]) -> mvtp::Result<Option<String>> {
        if commit.len() != 33 || commit[0] != mvtp::VERSION {
            return Err(mvtp::Error::Protocol("bad PAIR_COMMIT"));
        }
        let c: [u8; 32] = commit[1..].try_into().unwrap();
        let eph = KeyPair::generate();
        let npc: [u8; 32] = mvtp::random();
        mvtp::write_plain(stream, ty::PAIR_PC, &[&eph.public[..], &npc].concat())?;
        let reveal = mvtp::read_plain(stream, ty::PAIR_REVEAL)?;
        if reveal.len() != 97 {
            return Err(mvtp::Error::Protocol("bad PAIR_REVEAL"));
        }
        let phone_eph: [u8; 65] = reveal[..65].try_into().unwrap();
        let np: [u8; 32] = reveal[65..].try_into().unwrap();
        if mvtp::commit(&phone_eph, &np) != c {
            return Err(mvtp::Error::Protocol("the phone's commitment didn't match"));
        }
        let z = eph.ecdh(&phone_eph)?;
        let k = mvtp::pair_keys(&c, &eph.public, &npc, &phone_eph, &np, &z);
        let mut rx = Sealer::new(k.p2c.clone());
        let mut tx = Sealer::new(k.c2p.clone());
        let read_enc = |stream: &mut TcpStream, rx: &mut Sealer, want: u8| -> mvtp::Result<Zeroizing<Vec<u8>>> {
            let (l, body) = mvtp::read_body(stream)?;
            let (t, p) = rx.open(l, &body)?;
            if t != want {
                return Err(mvtp::Error::Protocol("unexpected message"));
            }
            Ok(p)
        };
        // Phone's identity first, then ours.
        let p = read_enc(stream, &mut rx, ty::PAIR_ID)?;
        let (phone_id, phone_name) = mvtp::parse_pair_id(&p, 1, &k.t)?;
        let me = store::identity_or_new(&self.s.db()).map_err(|_| mvtp::Error::Protocol("couldn't keep the pairing key"))?;
        self.s.mark_dirty();
        let pc_name = self.vault_name();
        let frame = tx.seal(ty::PAIR_ID, &mvtp::pair_id_payload(&me, 2, &k.t, &pc_name))?;
        std::io::Write::write_all(stream, &frame)?;
        let phone_name = if phone_name.is_empty() { "Phone".to_string() } else { phone_name };
        let code = mvtp::code6(&k.sas4);
        self.set_pairing(|p| {
            p.state = "code";
            p.code = Some(code.clone());
            p.phone_name = Some(phone_name.clone());
        });
        // Now both answers: the user's (here) and the phone's (a frame).
        let (ftx, frx) = std::sync::mpsc::channel::<mvtp::Result<bool>>();
        let mut rs = stream.try_clone()?;
        rs.set_read_timeout(Some(PAIRING_TIME))?;
        let mut rx2 = rx;
        std::thread::spawn(move || {
            let r = (|| {
                let (l, body) = mvtp::read_body(&mut rs)?;
                let (t, p) = rx2.open(l, &body)?;
                if t != ty::PAIR_CONFIRM || p.len() != 1 {
                    return Err(mvtp::Error::Protocol("unexpected message"));
                }
                Ok(p[0] == 1)
            })();
            let _ = ftx.send(r);
        });
        let until = Instant::now() + PAIRING_TIME;
        let mut user: Option<bool> = None;
        let mut phone: Option<bool> = None;
        let mut sent = false;
        loop {
            if self.s.is_closed() || Instant::now() > until {
                return Ok(None);
            }
            if user.is_none() {
                user = self.pairing.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|p| p.user);
            }
            if let Some(u) = user
                && !sent
            {
                let f = tx.seal(ty::PAIR_CONFIRM, &[u as u8])?;
                std::io::Write::write_all(stream, &f)?;
                sent = true;
                if !u {
                    return Ok(None);
                }
            }
            if phone.is_none() {
                match frx.recv_timeout(Duration::from_millis(100)) {
                    Ok(Ok(v)) => {
                        phone = Some(v);
                        if !v {
                            self.set_pairing(|p| p.message = Some("Cancelled on the phone.".into()));
                            return Ok(None);
                        }
                    }
                    Ok(Err(e)) => return Err(e),
                    Err(_) => {}
                }
            } else {
                std::thread::sleep(Duration::from_millis(100));
            }
            if sent && user == Some(true) && phone == Some(true) {
                break;
            }
        }
        store::add_peer(
            &self.s.db(),
            Peer {
                key: hex::encode(phone_id),
                name: phone_name.clone(),
                pair_key: hex::encode(*k.pair_key),
                paired_at: now_ms() / 1000,
            },
        )
        .map_err(|_| mvtp::Error::Protocol("couldn't save the pairing"))?;
        self.s.mark_dirty();
        let _ = self.s.save();
        Ok(Some(phone_name))
    }

    // ---- session handshake (§7) --------------------------------------------------------------

    fn handshake(self: &Arc<Self>, mut stream: TcpStream, hello1: &[u8]) -> mvtp::Result<()> {
        let (phone_eph, np, hint) = mvtp::parse_hello1(hello1)?;
        // Which paired phone is this?
        let peer = self
            .peers()
            .into_iter()
            .find(|p| p.pair_key().is_some_and(|pk| mvtp::hint(&mvtp::disc_key(&pk), &np) == hint))
            .ok_or(mvtp::Error::Protocol("unknown phone"))?;
        let phone_id = peer.public().ok_or(mvtp::Error::Protocol("bad stored key"))?;
        let pair_key = peer.pair_key().ok_or(mvtp::Error::Protocol("bad stored key"))?;
        let me = store::identity(&self.s.db()).ok_or(mvtp::Error::Protocol("no identity"))?;
        let eph = KeyPair::generate();
        let npc: [u8; 32] = mvtp::random();
        let th = mvtp::th(hello1, &eph.public, &npc);
        let sig_pc = me.sign(&mvtp::hs_pc_msg(&th));
        mvtp::write_plain(&mut stream, ty::HELLO2, &[&eph.public[..], &npc, &sig_pc].concat())?;
        let sig_phone = mvtp::read_plain(&mut stream, ty::HELLO3)?;
        let th2 = mvtp::th2(&th, &sig_pc);
        if !mvtp::verify(&phone_id, &mvtp::hs_phone_msg(&th2), &sig_phone) {
            return Err(mvtp::Error::Protocol("bad phone signature"));
        }
        let z = eph.ecdh(&phone_eph)?;
        let (p2c, c2p) = mvtp::session_keys(&z, &pair_key, &th2);
        if self.s.is_closed() {
            return Ok(());
        }
        // One connection per phone: a new one replaces the old.
        let old = self.conn.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(o) = old {
            o.bye(false, Some("Your phone connected again.".into()));
        }
        let c = Conn::start(self.clone(), stream, p2c, c2p, peer.name.clone(), peer.id())?;
        *self.conn.lock().unwrap_or_else(|e| e.into_inner()) = Some(c);
        self.status_changed();
        Ok(())
    }
}

/// Test hook: the TCP and UDP ports actually listened on.
#[cfg(test)]
pub(crate) fn test_ports() -> Option<(u16, Option<u16>)> {
    let rt = current()?;
    let l = rt.listeners.lock().unwrap_or_else(|e| e.into_inner());
    l.as_ref().map(|l| (l.tcp_port, l.udp_port))
}
