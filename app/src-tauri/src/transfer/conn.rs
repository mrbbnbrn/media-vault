//! One connected phone (§7 onwards): the encrypted frames, keep-alive, and
//! both directions — receiving into the vault and sending from it.
//!
//! Threads: the reader (owns the read half, keep-alive, dispatch), the
//! receiver (puts incoming items into the vault) and the sender (offers and
//! streams items to the phone). Writing goes through one lock.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use vault_core::{ObjectId, ObjectKind};

use super::items::{self, Outgoing, Tree};
use super::mvtp::{self, Answer, Info, Offer, OfferFolder, OfferItem, Sealer, ans, bye, fail, ty};
use super::server::{Done, Progress, Rt};

/// Nothing sent for this long: send a PING (§7).
const PING_AFTER: Duration = Duration::from_secs(15);
/// Nothing received for this long: the connection is gone.
const DEAD_AFTER: Duration = Duration::from_secs(45);
/// How long the phone may take to answer an offer or confirm an item.
const ANSWER_WAIT: Duration = Duration::from_secs(120);
const ITEM_WAIT: Duration = Duration::from_secs(600);
/// Received items are saved into the library at least this often.
const SAVE_EVERY: Duration = Duration::from_secs(20);

struct Writer {
    stream: TcpStream,
    sealer: Sealer,
}

/// What the reader hands the receiver.
enum Rx {
    Start(u32, u64),
    Data(u32, Vec<u8>),
    End(u32, [u8; 32]),
    Cancel(u32),
    Abort,
}

/// What the reader hands the sender.
enum Tx {
    Answer(Answer),
    Ok(u32),
    Failed(u32, u8),
    Cancel(u32),
    Abort,
}

struct Job {
    folders: Vec<OfferFolder>,
    items: Vec<Outgoing>,
}

pub struct Conn {
    rt: Arc<Rt>,
    pub peer_name: String,
    pub peer_id: String,
    writer: Mutex<Writer>,
    stream: TcpStream,
    closed: AtomicBool,
    last_tx: Mutex<Instant>,
    pub info: Mutex<Option<Info>>,
    // Receiving.
    rx: Mutex<Option<SyncSender<Rx>>>,
    recv_busy: AtomicBool,
    // Sending.
    tx: Mutex<Option<Sender<Tx>>>,
    queue: Mutex<VecDeque<Job>>,
    send_busy: AtomicBool,
    cancel_send: AtomicBool,
    next_ref: Mutex<u32>,
    next_offer: Mutex<u32>,
    /// Why it ended (shown to the user).
    pub ended: Mutex<Option<String>>,
}

impl Conn {
    pub fn start(
        rt: Arc<Rt>,
        stream: TcpStream,
        p2c: zeroize::Zeroizing<[u8; 32]>,
        c2p: zeroize::Zeroizing<[u8; 32]>,
        peer_name: String,
        peer_id: String,
    ) -> io::Result<Arc<Conn>> {
        stream.set_nodelay(true).ok();
        stream.set_write_timeout(Some(Duration::from_secs(30)))?;
        stream.set_read_timeout(Some(Duration::from_millis(500)))?;
        let c = Arc::new(Conn {
            writer: Mutex::new(Writer { stream: stream.try_clone()?, sealer: Sealer::new(c2p) }),
            stream: stream.try_clone()?,
            rt,
            peer_name,
            peer_id,
            closed: AtomicBool::new(false),
            last_tx: Mutex::new(Instant::now()),
            info: Mutex::new(None),
            rx: Mutex::new(None),
            recv_busy: AtomicBool::new(false),
            tx: Mutex::new(None),
            queue: Mutex::new(VecDeque::new()),
            send_busy: AtomicBool::new(false),
            cancel_send: AtomicBool::new(false),
            next_ref: Mutex::new(1),
            next_offer: Mutex::new(1),
            ended: Mutex::new(None),
        });
        // Our INFO first (§7 step 5).
        let info = Info {
            app: "mediavault".into(),
            proto: 1,
            name: c.rt.vault_name(),
            free: c.rt.free_bytes().unwrap_or(0),
            kinds: items::KINDS.iter().map(|k| k.to_string()).collect(),
        };
        c.send(ty::INFO, &serde_json::to_vec(&info).unwrap_or_default())?;
        let reader = c.clone();
        std::thread::Builder::new()
            .name("transfer-read".into())
            .spawn(move || {
                let mut rx = Sealer::new(p2c);
                let why = reader.read_loop(stream, &mut rx);
                reader.close(why);
            })?;
        Ok(c)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn busy(&self) -> bool {
        self.recv_busy.load(Ordering::SeqCst) || self.send_busy.load(Ordering::SeqCst)
    }

    /// Send one encrypted frame.
    pub fn send(&self, msg_type: u8, payload: &[u8]) -> io::Result<()> {
        if self.is_closed() {
            return Err(io::Error::new(io::ErrorKind::NotConnected, "closed"));
        }
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let frame = w.sealer.seal(msg_type, payload).map_err(|e| io::Error::other(e.to_string()))?;
        w.stream.write_all(&frame)?;
        *self.last_tx.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        Ok(())
    }

    /// End the connection (once). `why` is shown to the user if a transfer was cut short.
    pub fn close(&self, why: Option<String>) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        *self.ended.lock().unwrap_or_else(|e| e.into_inner()) = why;
        let _ = self.stream.shutdown(Shutdown::Both);
        if let Some(tx) = self.rx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.try_send(Rx::Abort);
        }
        if let Some(tx) = self.tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(Tx::Abort);
        }
        self.rt.conn_closed(self);
    }

    /// Say goodbye (BYE or LOCKED) and close.
    pub fn bye(&self, locked: bool, why: Option<String>) {
        if locked {
            let _ = self.send(ty::LOCKED, &[]);
        } else {
            let _ = self.send(ty::BYE, &[bye::NORMAL]);
        }
        self.close(why);
    }

    // ---- reading -----------------------------------------------------------------------

    /// Read exactly `buf`, sending PINGs while idle and giving up when the
    /// other side has been silent too long or we are closing.
    fn read_full(&self, r: &mut TcpStream, buf: &mut [u8], last_rx: &mut Instant) -> io::Result<()> {
        let mut got = 0;
        while got < buf.len() {
            if self.is_closed() {
                return Err(io::Error::new(io::ErrorKind::NotConnected, "closed"));
            }
            match r.read(&mut buf[got..]) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the phone disconnected")),
                Ok(n) => {
                    got += n;
                    *last_rx = Instant::now();
                }
                Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                    if last_rx.elapsed() > DEAD_AFTER {
                        return Err(io::Error::new(io::ErrorKind::TimedOut, "the phone stopped answering"));
                    }
                    let idle = self.last_tx.lock().unwrap_or_else(|e| e.into_inner()).elapsed();
                    if idle > PING_AFTER {
                        self.send(ty::PING, &[])?;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    fn read_loop(self: &Arc<Self>, mut r: TcpStream, rx: &mut Sealer) -> Option<String> {
        let mut last_rx = Instant::now();
        let mut pending: Option<(Vec<OfferFolder>, Vec<OfferItem>, u32)> = None;
        loop {
            let mut len = [0u8; 4];
            if let Err(e) = self.read_full(&mut r, &mut len, &mut last_rx) {
                return (!self.is_closed()).then(|| e.to_string());
            }
            let l = u32::from_be_bytes(len);
            if !(17..=mvtp::MAX_FRAME).contains(&l) {
                return Some("The phone sent something unexpected.".into());
            }
            let mut body = vec![0u8; l as usize];
            if let Err(e) = self.read_full(&mut r, &mut body, &mut last_rx) {
                return (!self.is_closed()).then(|| e.to_string());
            }
            let (t, p) = match rx.open(l, &body) {
                Ok(x) => x,
                Err(_) => return Some("The connection was damaged.".into()),
            };
            match t {
                ty::PING => {
                    let _ = self.send(ty::PONG, &[]);
                }
                ty::PONG => {}
                ty::INFO => {
                    if let Ok(i) = serde_json::from_slice::<Info>(&p) {
                        *self.info.lock().unwrap_or_else(|e| e.into_inner()) = Some(i);
                    }
                }
                ty::BYE => {
                    return match p.first() {
                        Some(&bye::LOCKED) => Some("Your phone locked its vault.".into()),
                        Some(&bye::USER_CLOSED) => Some("Aktarım was closed on the phone.".into()),
                        _ => None,
                    };
                }
                ty::LOCKED => return Some("Your phone locked its vault.".into()),
                ty::OFFER => {
                    let Ok(o) = serde_json::from_slice::<Offer>(&p) else {
                        return Some("The phone sent an offer this version doesn't understand.".into());
                    };
                    if self.recv_busy.load(Ordering::SeqCst) {
                        // One offer at a time per direction (r2): a new one now is a mistake.
                        return Some("The phone sent a new offer too early.".into());
                    }
                    let (mut fs, mut is, _) = pending.take().unwrap_or((Vec::new(), Vec::new(), o.offer));
                    fs.extend(o.folders);
                    is.extend(o.items);
                    if is.len() > mvtp::MAX_OFFER_ITEMS {
                        return Some("The phone offered too many items at once.".into());
                    }
                    if o.last {
                        self.take_offer(o.offer, fs, is);
                    } else {
                        pending = Some((fs, is, o.offer));
                    }
                }
                ty::ITEM_START => {
                    if p.len() != 12 {
                        return Some("bad ITEM_START".into());
                    }
                    let r_ = mvtp::ref_of(&p).unwrap_or(0);
                    let size = u64::from_be_bytes(p[4..12].try_into().unwrap());
                    self.to_receiver(Rx::Start(r_, size));
                }
                ty::DATA => {
                    if p.len() < 5 {
                        return Some("bad DATA".into());
                    }
                    self.to_receiver(Rx::Data(mvtp::ref_of(&p).unwrap_or(0), p[4..].to_vec()));
                }
                ty::ITEM_END => {
                    if p.len() != 36 {
                        return Some("bad ITEM_END".into());
                    }
                    self.to_receiver(Rx::End(mvtp::ref_of(&p).unwrap_or(0), p[4..36].try_into().unwrap()));
                }
                ty::ANSWER => {
                    if let Ok(a) = serde_json::from_slice::<Answer>(&p) {
                        self.to_sender(Tx::Answer(a));
                    }
                }
                ty::ITEM_OK => {
                    if let Some(r_) = mvtp::ref_of(&p) {
                        self.to_sender(Tx::Ok(r_));
                    }
                }
                ty::ITEM_FAILED => {
                    if p.len() >= 5 {
                        self.to_sender(Tx::Failed(mvtp::ref_of(&p).unwrap_or(0), p[4]));
                    }
                }
                ty::CANCEL => {
                    if let Some(r_) = mvtp::ref_of(&p) {
                        // The ref may be one we send or one we receive (or all).
                        self.to_sender(Tx::Cancel(r_));
                        self.to_receiver(Rx::Cancel(r_));
                    }
                }
                _ => {} // unknown encrypted types are ignored (§4)
            }
        }
    }

    fn to_receiver(&self, m: Rx) {
        let tx = self.rx.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match tx {
            // Blocks when the vault is slower than the network: the phone then waits too.
            Some(tx) => {
                let _ = tx.send(m);
            }
            None => {
                // Data for nothing we expect.
                if matches!(m, Rx::Start(..) | Rx::Data(..) | Rx::End(..)) {
                    let _ = self.send(ty::ITEM_FAILED, &[&match m {
                        Rx::Start(r, _) | Rx::Data(r, _) | Rx::End(r, _) => r,
                        _ => 0,
                    }
                    .to_be_bytes()[..], &[fail::BAD_DATA]]
                    .concat());
                }
            }
        }
    }

    fn to_sender(&self, m: Tx) {
        if let Some(tx) = self.tx.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tx.send(m);
        }
    }

    // ---- receiving -----------------------------------------------------------------------

    /// A whole offer arrived: answer it and get ready for the wanted items.
    fn take_offer(self: &Arc<Self>, offer: u32, folders: Vec<OfferFolder>, its: Vec<OfferItem>) {
        let o = Offer { offer, last: true, folders, items: its };
        let free = self.rt.free_bytes();
        let a = {
            let s = self.rt.session();
            let db = s.db();
            items::answer(&db, &o, free)
        };
        let mut done = Done::new("receive");
        let mut wanted = Vec::new();
        for x in &a.answers {
            match x.a.as_str() {
                ans::WANT => wanted.push(x.i),
                ans::HAVE => done.have += 1,
                ans::CANT => done.cant += 1,
                _ => {
                    let name = o.items.iter().find(|i| i.i == x.i).map(|i| i.name.clone()).unwrap_or_default();
                    done.failed.push((name, "There isn't enough free space on the vault's drive.".into()));
                }
            }
        }
        if self.send(ty::ANSWER, &serde_json::to_vec(&a).unwrap_or_default()).is_err() {
            return;
        }
        if wanted.is_empty() {
            self.rt.emit_done(&done);
            return;
        }
        let (tx, rx_) = mpsc::sync_channel::<Rx>(48);
        *self.rx.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        self.recv_busy.store(true, Ordering::SeqCst);
        self.rt.status_changed();
        let me = self.clone();
        let _ = std::thread::Builder::new().name("transfer-receive".into()).spawn(move || {
            me.receive(o, wanted, rx_, done);
            *me.rx.lock().unwrap_or_else(|e| e.into_inner()) = None;
            me.recv_busy.store(false, Ordering::SeqCst);
            me.rt.status_changed();
        });
    }

    fn reply_failed(&self, r: u32, why: u8) {
        let _ = self.send(ty::ITEM_FAILED, &[&r.to_be_bytes()[..], &[why]].concat());
    }

    fn receive(self: &Arc<Self>, o: Offer, wanted: Vec<u32>, rx: Receiver<Rx>, mut done: Done) {
        let s = self.rt.session();
        let by_ref: HashMap<u32, &OfferItem> = o.items.iter().map(|i| (i.i, i)).collect();
        let mut left: std::collections::HashSet<u32> = wanted.iter().copied().collect();
        let total_bytes: u64 = wanted.iter().filter_map(|r| by_ref.get(r)).map(|i| i.size).sum();
        let mut prog = Progress {
            dir: "receive",
            done: 0,
            total: wanted.len(),
            bytes: 0,
            total_bytes,
            current: String::new(),
        };
        let mut tree = Tree::default();
        tree.add(&o.folders);
        let landing = match super::store::landing_folder(&s.db()) {
            Ok(l) => l,
            Err(e) => {
                done.stopped = Some(e);
                self.rt.emit_done(&done);
                return;
            }
        };
        done.folder = Some(landing);
        let mut received = Vec::new();
        let mut last_save = Instant::now();
        let mut skip: Option<u32> = None; // an item being thrown away: ignore its frames
        let mut stopped: Option<String> = None;
        while !left.is_empty() {
            let m = match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(m) => m,
                Err(RecvTimeoutError::Timeout) => {
                    if s.is_closed() {
                        stopped = Some("This vault locked.".into());
                        break;
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            };
            match m {
                Rx::Abort => break,
                Rx::Cancel(r) if r == mvtp::CANCEL_ALL => {
                    for r in left.drain() {
                        self.reply_failed(r, fail::CANCELLED);
                    }
                    stopped = Some("Cancelled.".into());
                }
                Rx::Cancel(_) => {}
                Rx::Data(r, _) | Rx::End(r, _) if skip == Some(r) => {
                    if let Rx::End(..) = m {
                        skip = None;
                    }
                }
                Rx::Data(r, _) | Rx::End(r, _) => {
                    // Frames for an item that never started.
                    self.reply_failed(r, fail::BAD_DATA);
                }
                Rx::Start(r, size) => {
                    let Some(it) = by_ref.get(&r).copied().filter(|_| left.contains(&r)) else {
                        self.reply_failed(r, fail::BAD_DATA);
                        skip = Some(r);
                        continue;
                    };
                    if size != it.size {
                        self.reply_failed(r, fail::BAD_DATA);
                        left.remove(&r);
                        skip = Some(r);
                        done.failed.push((it.name.clone(), "The phone sent a different size than it offered.".into()));
                        continue;
                    }
                    prog.current = items::clean_item_name(&it.name);
                    match self.receive_one(&s, &rx, it, &mut prog) {
                        One::Stored(object_id, sha_hex) => {
                            let r2 = {
                                let db = s.db();
                                tree.folder(&db, landing, it.folder)
                                    .and_then(|f| items::insert_received(&db, f, &object_id, it, &sha_hex, it.size))
                            };
                            match r2 {
                                Ok(id) => {
                                    s.mark_dirty();
                                    received.push(id);
                                    done.done += 1;
                                    let _ = self.send(ty::ITEM_OK, &r.to_be_bytes());
                                }
                                Err(e) => {
                                    if let Ok(oid) = ObjectId::from_hex(&object_id) {
                                        let _ = s.vault().delete_object(ObjectKind::Media, &oid);
                                    }
                                    done.failed.push((it.name.clone(), e));
                                    self.reply_failed(r, fail::WRITE_ERROR);
                                }
                            }
                        }
                        One::Failed(why, msg, skip_rest) => {
                            self.reply_failed(r, why);
                            if let Some(m) = msg {
                                done.failed.push((it.name.clone(), m));
                            }
                            if skip_rest {
                                skip = Some(r);
                            }
                        }
                        One::Cancelled => {
                            self.reply_failed(r, fail::CANCELLED);
                            skip = Some(r);
                        }
                        One::Stop(why) => {
                            stopped = why;
                            break;
                        }
                    }
                    left.remove(&r);
                    prog.done += 1;
                    self.rt.emit_progress(&prog, true);
                    if last_save.elapsed() > SAVE_EVERY {
                        last_save = Instant::now();
                        let _ = s.save();
                    }
                }
            }
        }
        if !left.is_empty() && stopped.is_none() {
            stopped = self.ended.lock().unwrap_or_else(|e| e.into_inner()).clone().or(Some("The connection to the phone was lost.".into()));
        }
        if !s.is_closed() && !received.is_empty() {
            let _ = s.save();
        }
        done.stopped = stopped;
        // Playable copies of formats this app can't show (the original stays).
        if !received.is_empty() && !s.is_closed() {
            let (n, fails) = self.rt.make_playable(&received);
            done.playable = n;
            done.failed.extend(fails);
        }
        self.rt.emit_done(&done);
    }

    /// Stream one item straight into the vault.
    fn receive_one(&self, s: &crate::session::Session, rx: &Receiver<Rx>, it: &OfferItem, prog: &mut Progress) -> One {
        let mut reader = ChanReader {
            rx,
            r: it.i,
            remaining: it.size,
            buf: Vec::new(),
            pos: 0,
            hasher: Sha256::new(),
            outcome: None,
            closed: &|| s.is_closed(),
            conn: self,
            prog,
            rt: &self.rt,
        };
        let stored = s.vault().add_object(ObjectKind::Media, &mut reader);
        let outcome = reader.outcome.take();
        let (id, written) = match stored {
            Ok(x) => x,
            Err(e) => {
                return match outcome {
                    Some(Outcome::Abort) => One::Stop(None),
                    Some(Outcome::Locked) => One::Stop(Some("This vault locked.".into())),
                    Some(Outcome::Cancelled) => One::Cancelled,
                    Some(Outcome::Bad) => One::Failed(fail::BAD_DATA, Some("The phone sent the file wrongly.".into()), true),
                    None => {
                        let e = e.to_string();
                        let full = crate::diskspace::is_full_error(&e);
                        One::Failed(
                            if full { fail::NO_SPACE } else { fail::WRITE_ERROR },
                            Some(if full { "The vault's drive is full.".into() } else { e }),
                            true,
                        )
                    }
                };
            }
        };
        let ours: [u8; 32] = reader.hasher.finalize().into();
        let drop_it = || {
            let _ = s.vault().delete_object(ObjectKind::Media, &id);
        };
        // The end frame must come next.
        let end = loop {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(Rx::End(r, sha)) if r == it.i => break Some(sha),
                Ok(Rx::Abort) | Err(RecvTimeoutError::Disconnected) => {
                    drop_it();
                    return One::Stop(None);
                }
                Ok(Rx::Cancel(r)) if r == it.i || r == mvtp::CANCEL_ALL => {
                    drop_it();
                    return One::Cancelled;
                }
                Ok(Rx::Cancel(_)) => {}
                Ok(_) => break None,
                Err(RecvTimeoutError::Timeout) => {
                    if s.is_closed() {
                        drop_it();
                        return One::Stop(Some("This vault locked.".into()));
                    }
                }
            }
        };
        let offered = it.sha256.to_ascii_lowercase();
        match end {
            Some(sha)
                if sha == ours
                    && hex::encode(ours) == offered
                    && written.sha256_hex == offered
                    && written.plaintext_len == it.size =>
            {
                One::Stored(id.to_hex(), offered)
            }
            Some(_) => {
                drop_it();
                One::Failed(fail::HASH_MISMATCH, Some("The file arrived damaged.".into()), false)
            }
            None => {
                drop_it();
                One::Failed(fail::BAD_DATA, Some("The phone sent the file wrongly.".into()), true)
            }
        }
    }

    // ---- sending ---------------------------------------------------------------------------

    /// Queue items to send to the phone. Returns how many.
    pub fn queue_send(self: &Arc<Self>, media: &[i64], folders: &[i64]) -> Result<usize, String> {
        let first = *self.next_ref.lock().unwrap_or_else(|e| e.into_inner());
        let ob = {
            let s = self.rt.session();
            let db = s.db();
            items::outbox(&db, media, folders, first)?
        };
        let n = ob.items.len();
        if n == 0 {
            return Err("There's nothing to send in what you picked.".into());
        }
        *self.next_ref.lock().unwrap_or_else(|e| e.into_inner()) = first.wrapping_add(n as u32);
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).push_back(Job { folders: ob.folders, items: ob.items });
        if !self.send_busy.swap(true, Ordering::SeqCst) {
            self.cancel_send.store(false, Ordering::SeqCst);
            let (tx, rx) = mpsc::channel::<Tx>();
            *self.tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
            let me = self.clone();
            let _ = std::thread::Builder::new().name("transfer-send".into()).spawn(move || {
                me.send_all(rx);
                *me.tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
                me.send_busy.store(false, Ordering::SeqCst);
                me.rt.status_changed();
            });
            self.rt.status_changed();
        }
        Ok(n)
    }

    /// Stop everything in both directions (the connection stays).
    pub fn cancel_all(&self) {
        self.cancel_send.store(true, Ordering::SeqCst);
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).clear();
        let _ = self.send(ty::CANCEL, &mvtp::CANCEL_ALL.to_be_bytes());
        // Our own receive stops too.
        self.to_receiver(Rx::Cancel(mvtp::CANCEL_ALL));
    }

    fn send_all(self: &Arc<Self>, rx: Receiver<Tx>) {
        loop {
            let job = self.queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
            let Some(job) = job else { break };
            let mut done = Done::new("send");
            let total_bytes = job.items.iter().map(|i| i.item.size).sum();
            let mut prog = Progress { dir: "send", done: 0, total: job.items.len(), bytes: 0, total_bytes, current: String::new() };
            let stop = self.send_job(&job, &rx, &mut done, &mut prog);
            done.stopped = stop;
            if self.cancel_send.load(Ordering::SeqCst) && done.stopped.is_none() {
                done.stopped = Some("Cancelled.".into());
            }
            self.rt.emit_done(&done);
            if self.is_closed() {
                break;
            }
        }
    }

    /// Wait for one sender message, giving up on close, lock or timeout.
    fn wait(&self, rx: &Receiver<Tx>, limit: Duration) -> Result<Tx, Option<String>> {
        let until = Instant::now() + limit;
        loop {
            if self.rt.session().is_closed() {
                return Err(Some("This vault locked.".into()));
            }
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(Tx::Abort) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.ended.lock().unwrap_or_else(|e| e.into_inner()).clone().or(Some("The connection to the phone was lost.".into())));
                }
                Ok(m) => return Ok(m),
                Err(RecvTimeoutError::Timeout) if Instant::now() > until => {
                    return Err(Some("The phone stopped answering.".into()));
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn send_job(&self, job: &Job, rx: &Receiver<Tx>, done: &mut Done, prog: &mut Progress) -> Option<String> {
        let s = self.rt.session();
        // At most 1000 items per offer; the next offer only after this one ends (r2).
        for chunk in job.items.chunks(mvtp::MAX_OFFER_ITEMS) {
            if self.cancel_send.load(Ordering::SeqCst) {
                return None;
            }
            let offer_no = {
                let mut n = self.next_offer.lock().unwrap_or_else(|e| e.into_inner());
                *n = n.wrapping_add(1);
                *n
            };
            let its: Vec<OfferItem> = chunk.iter().map(|o| o.item.clone()).collect();
            for f in mvtp::offer_frames(offer_no, &job.folders, &its) {
                if let Err(e) = self.send(ty::OFFER, &f) {
                    return Some(e.to_string());
                }
            }
            let answer = loop {
                match self.wait(rx, ANSWER_WAIT) {
                    Ok(Tx::Answer(a)) if a.offer == offer_no => break a,
                    Ok(_) => continue,
                    Err(why) => return why,
                }
            };
            let said: HashMap<u32, &str> = answer.answers.iter().map(|a| (a.i, a.a.as_str())).collect();
            for o in chunk {
                let it = &o.item;
                match said.get(&it.i).copied() {
                    Some(ans::WANT) => {}
                    Some(ans::HAVE) => {
                        done.have += 1;
                        prog.done += 1;
                        prog.bytes += it.size;
                        continue;
                    }
                    Some(ans::NOSPACE) => {
                        done.failed.push((it.name.clone(), "There isn't enough space on the phone.".into()));
                        prog.done += 1;
                        prog.bytes += it.size;
                        continue;
                    }
                    _ => {
                        done.cant += 1;
                        prog.done += 1;
                        prog.bytes += it.size;
                        continue;
                    }
                }
                if self.cancel_send.load(Ordering::SeqCst) {
                    return None;
                }
                prog.current = it.name.clone();
                match self.send_one(&s, o, rx, prog) {
                    Ok(true) => done.done += 1,
                    Ok(false) => {}
                    Err(Sent::Failed(why)) => done.failed.push((it.name.clone(), why)),
                    Err(Sent::Stop(why)) => return why,
                }
                prog.done += 1;
                self.rt.emit_progress(prog, true);
            }
        }
        None
    }

    /// Stream one item to the phone and wait for its answer.
    /// Ok(true) = stored there, Ok(false) = cancelled.
    fn send_one(&self, s: &crate::session::Session, o: &Outgoing, rx: &Receiver<Tx>, prog: &mut Progress) -> Result<bool, Sent> {
        let it = &o.item;
        let oid = ObjectId::from_hex(&o.object_id).map_err(|e| Sent::Failed(e.to_string()))?;
        let mut reader = s.vault().open_object(ObjectKind::Media, &oid).map_err(|e| Sent::Failed(e.to_string()))?;
        self.send(ty::ITEM_START, &mvtp::item_start(it.i, it.size)).map_err(|e| Sent::Stop(Some(e.to_string())))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; mvtp::MAX_DATA];
        let mut sent: u64 = 0;
        let start_bytes = prog.bytes;
        let mut cancelled = false;
        while sent < it.size {
            if s.is_closed() {
                return Err(Sent::Stop(Some("This vault locked.".into())));
            }
            // A cancel from either side stops this item.
            if self.cancel_send.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            while let Ok(m) = rx.try_recv() {
                match m {
                    Tx::Cancel(r) if r == it.i || r == mvtp::CANCEL_ALL => cancelled = true,
                    Tx::Failed(r, _) if r == it.i => cancelled = true,
                    Tx::Abort => return Err(Sent::Stop(self.ended.lock().unwrap_or_else(|e| e.into_inner()).clone())),
                    _ => {}
                }
            }
            if cancelled {
                break;
            }
            let want = ((it.size - sent) as usize).min(buf.len());
            let n = read_some(&mut reader, &mut buf[..want]).map_err(|e| Sent::Failed(e.to_string()))?;
            if n == 0 {
                return Err(Sent::Failed("The file is shorter than the library says.".into()));
            }
            hasher.update(&buf[..n]);
            self.send(ty::DATA, &[&it.i.to_be_bytes()[..], &buf[..n]].concat())
                .map_err(|e| Sent::Stop(Some(e.to_string())))?;
            sent += n as u64;
            prog.bytes = start_bytes + sent;
            self.rt.emit_progress(prog, false);
        }
        prog.bytes = start_bytes + it.size;
        if cancelled {
            let _ = self.send(ty::CANCEL, &it.i.to_be_bytes());
        } else {
            let sha: [u8; 32] = hasher.finalize().into();
            self.send(ty::ITEM_END, &mvtp::item_end(it.i, &sha)).map_err(|e| Sent::Stop(Some(e.to_string())))?;
        }
        loop {
            match self.wait(rx, ITEM_WAIT) {
                Ok(Tx::Ok(r)) if r == it.i => return Ok(!cancelled),
                Ok(Tx::Failed(r, why)) if r == it.i => {
                    if cancelled || why == fail::CANCELLED {
                        return Ok(false);
                    }
                    return Err(Sent::Failed(match why {
                        fail::HASH_MISMATCH => "It arrived damaged on the phone.".into(),
                        fail::NO_SPACE => "There isn't enough space on the phone.".into(),
                        fail::WRITE_ERROR => "The phone couldn't save it.".into(),
                        _ => "The phone refused it.".into(),
                    }));
                }
                Ok(_) => {}
                Err(why) => return Err(Sent::Stop(why)),
            }
        }
    }
}

enum Sent {
    Failed(String),
    Stop(Option<String>),
}

fn read_some(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

enum One {
    Stored(String, String),
    /// (reason, message for the user, the rest of its frames still come)
    Failed(u8, Option<String>, bool),
    Cancelled,
    Stop(Option<String>),
}

enum Outcome {
    Abort,
    Locked,
    Cancelled,
    Bad,
}

/// Feeds one item's DATA frames to the vault writer as a plain `Read`.
struct ChanReader<'a> {
    rx: &'a Receiver<Rx>,
    r: u32,
    remaining: u64,
    buf: Vec<u8>,
    pos: usize,
    hasher: Sha256,
    outcome: Option<Outcome>,
    closed: &'a dyn Fn() -> bool,
    conn: &'a Conn,
    prog: &'a mut Progress,
    rt: &'a Arc<Rt>,
}

impl ChanReader<'_> {
    fn stop(&mut self, o: Outcome) -> io::Error {
        self.outcome = Some(o);
        io::Error::other("transfer stopped")
    }
}

impl Read for ChanReader<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.buf.len() {
            if self.remaining == 0 {
                return Ok(0);
            }
            loop {
                if (self.closed)() {
                    return Err(self.stop(Outcome::Locked));
                }
                match self.rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(Rx::Data(r, b)) if r == self.r => {
                        if b.is_empty() || b.len() as u64 > self.remaining {
                            return Err(self.stop(Outcome::Bad));
                        }
                        self.remaining -= b.len() as u64;
                        self.hasher.update(&b);
                        self.prog.bytes += b.len() as u64;
                        self.rt.emit_progress(self.prog, false);
                        self.buf = b;
                        self.pos = 0;
                        break;
                    }
                    Ok(Rx::Cancel(r)) if r == self.r || r == mvtp::CANCEL_ALL => return Err(self.stop(Outcome::Cancelled)),
                    Ok(Rx::Cancel(_)) => {}
                    Ok(Rx::Abort) | Err(RecvTimeoutError::Disconnected) => return Err(self.stop(Outcome::Abort)),
                    Ok(_) => return Err(self.stop(Outcome::Bad)),
                    Err(RecvTimeoutError::Timeout) => {
                        if self.conn.is_closed() {
                            return Err(self.stop(Outcome::Abort));
                        }
                    }
                }
            }
        }
        let n = (self.buf.len() - self.pos).min(out.len());
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}
