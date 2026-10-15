//! The video tool: converting items (to MP4, WebM, GIF or a picture format)
//! and making an animation (GIF or MP4) from pictures, with ffmpeg.
//!
//! Nothing decrypted ever touches the disk. ffmpeg reads the items from a
//! tiny web server inside the app (127.0.0.1 only, a random port and a
//! random secret path, with Range support so MP4s with their index at the
//! end work) and writes its result to stdout, which is read into memory and
//! stored encrypted. Small text (a filter script) goes through stdin.
//!
//! The tool is `tools/ffmpeg(.exe)` next to the app, or the file named by
//! the MV_FFMPEG environment variable.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use vault_core::{ObjectId, ObjectKind};
use zeroize::Zeroizing;

use crate::import;
use crate::library;
use crate::session::Session;

/// Most pictures one animation can be made from.
pub const MAX_ANIMATION_PICTURES: usize = 300;
/// Biggest result kept in memory (it is then stored encrypted).
const MAX_OUTPUT: usize = 4 << 30;

// ---- finding the tool -----------------------------------------------------------------

/// Where ffmpeg is: MV_FFMPEG, or `tools/ffmpeg(.exe)` next to the app.
pub fn tool_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("MV_FFMPEG") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let p = exe.parent()?.join("tools").join(name);
    p.is_file().then_some(p)
}

pub fn tool_available() -> bool {
    tool_path().is_some()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub available: bool,
    /// e.g. "8.1" or "N-121234-g0123abcd"
    pub version: Option<String>,
}

pub fn info() -> ToolInfo {
    if !tool_available() {
        return ToolInfo { available: false, version: None };
    }
    match tool_path().and_then(|p| Tool::probe(&p).ok()) {
        Some(t) => ToolInfo { available: true, version: Some(t.version) },
        None => ToolInfo { available: false, version: None },
    }
}

/// A command for the tool that never opens a console window on Windows.
fn command(path: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// What this copy of ffmpeg can do.
pub struct Tool {
    path: PathBuf,
    version: String,
    encoders: Vec<String>,
    /// ffmpeg 7 and newer read option values from files with "-/option".
    new_options: bool,
}

impl Tool {
    pub fn probe(path: &Path) -> Result<Tool, String> {
        let out = |args: &[&str]| -> Result<String, String> {
            let o = command(path)
                .args(args)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .map_err(|e| format!("The video tool couldn't be started ({e})."))?;
            Ok(String::from_utf8_lossy(&o.stdout).into_owned())
        };
        let v = out(&["-hide_banner", "-version"])?;
        let version = v
            .lines()
            .next()
            .and_then(|l| l.strip_prefix("ffmpeg version "))
            .and_then(|l| l.split_whitespace().next())
            .ok_or("The video tool isn't working (it didn't say its version).")?
            .to_string();
        let encoders = out(&["-hide_banner", "-encoders"])?
            .lines()
            .filter_map(|l| {
                let mut w = l.split_whitespace();
                let flags = w.next()?;
                let name = w.next()?;
                (flags.len() == 6 && flags != "------" && name != "=").then(|| name.to_string())
            })
            .collect();
        Ok(Tool { path: path.to_path_buf(), new_options: version_is_7_or_newer(&version), version, encoders })
    }

    fn has(&self, encoder: &str) -> bool {
        self.encoders.iter().any(|e| e == encoder)
    }
}

/// "6.1.1-3ubuntu5" → false, "7.1" / "n8.0.1" / "N-121234-g…" (master) → true.
fn version_is_7_or_newer(v: &str) -> bool {
    if v.starts_with('N') || v.starts_with("git") {
        return true;
    }
    let digits: String = v.trim_start_matches('n').chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().map(|m| m >= 7).unwrap_or(true)
}

// ---- the tiny local web server --------------------------------------------------------

#[derive(Clone)]
pub enum Source {
    /// An encrypted item, decrypted while it is read.
    Object(Arc<Session>, ObjectId),
    /// Bytes already in memory (tests).
    #[cfg(test)]
    Bytes(Arc<Zeroizing<Vec<u8>>>),
}

/// Serves items to ffmpeg on 127.0.0.1 under a random secret path. Stops
/// when dropped.
pub struct Server {
    addr: SocketAddr,
    secret: String,
    files: Arc<Mutex<HashMap<String, Source>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    pub fn start() -> io::Result<Server> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let addr = listener.local_addr()?;
        let secret = hex::encode(vault_core::crypto::random_bytes::<16>());
        let files: Arc<Mutex<HashMap<String, Source>>> = Default::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (f2, s2, sec2) = (files.clone(), stop.clone(), secret.clone());
        let thread = std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(conn) = conn else { continue };
                let (f3, sec3) = (f2.clone(), sec2.clone());
                std::thread::spawn(move || {
                    let _ = handle(conn, &sec3, &f3);
                });
            }
        });
        Ok(Server { addr, secret, files, stop, thread: Some(thread) })
    }

    /// Offer something under `name` (letters, digits, dot); returns its URL.
    pub fn add(&self, name: &str, src: Source) -> String {
        self.files.lock().unwrap().insert(name.to_string(), src);
        format!("http://{}/{}/{}", self.addr, self.secret, name)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.files.lock().unwrap().clear();
        // Wake the accept loop.
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_secs(1));
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn handle(conn: TcpStream, secret: &str, files: &Mutex<HashMap<String, Source>>) -> io::Result<()> {
    conn.set_read_timeout(Some(Duration::from_secs(20)))?;
    conn.set_write_timeout(Some(Duration::from_secs(60)))?;
    let mut rd = BufReader::new(conn.try_clone()?);
    let mut w = conn;
    let mut first = String::new();
    rd.read_line(&mut first)?;
    let mut range = None;
    let mut head_bytes = first.len();
    loop {
        let mut line = String::new();
        if rd.read_line(&mut line)? == 0 {
            break;
        }
        head_bytes += line.len();
        if head_bytes > 16 * 1024 {
            return reply(&mut w, "431 Request Header Fields Too Large", &[]);
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':')
            && k.trim().eq_ignore_ascii_case("range")
        {
            range = Some(v.trim().to_string());
        }
    }
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    if method != "GET" && method != "HEAD" {
        return reply(&mut w, "405 Method Not Allowed", &[]);
    }
    let src = path
        .strip_prefix('/')
        .and_then(|p| p.strip_prefix(secret))
        .and_then(|p| p.strip_prefix('/'))
        .and_then(|name| files.lock().unwrap().get(name).cloned());
    let Some(src) = src else {
        return reply(&mut w, "404 Not Found", &[]);
    };
    let head_only = method == "HEAD";
    match src {
        Source::Object(s, oid) => {
            if s.is_closed() {
                return reply(&mut w, "403 Forbidden", &[]);
            }
            let r = s.vault().open_object(ObjectKind::Media, &oid);
            match r {
                Ok(r) => {
                    let len = r.len();
                    send(&mut w, r, len, range.as_deref(), head_only)
                }
                Err(_) => reply(&mut w, "500 Internal Server Error", &[]),
            }
        }
        #[cfg(test)]
        Source::Bytes(b) => send(&mut w, std::io::Cursor::new(&b[..]), b.len() as u64, range.as_deref(), head_only),
    }
}

fn reply(w: &mut TcpStream, status: &str, extra: &[String]) -> io::Result<()> {
    let mut h = format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n");
    for x in extra {
        h.push_str(x);
        h.push_str("\r\n");
    }
    h.push_str("\r\n");
    w.write_all(h.as_bytes())
}

/// "bytes=a-b", "bytes=a-" or "bytes=-n" → inclusive (start, end).
fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((len - n.min(len), len - 1));
    }
    let start: u64 = a.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
    (end >= start).then_some((start, end))
}

fn send<R: Read + Seek>(w: &mut TcpStream, mut r: R, len: u64, range: Option<&str>, head_only: bool) -> io::Result<()> {
    let (status, start, end) = match range {
        Some(h) => match parse_range(h, len) {
            Some((a, b)) => ("206 Partial Content", a, b),
            None => return reply(w, "416 Range Not Satisfiable", &[format!("Content-Range: bytes */{len}")]),
        },
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut h = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n"
    );
    if range.is_some() {
        h.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    h.push_str("\r\n");
    w.write_all(h.as_bytes())?;
    if head_only || count == 0 {
        return Ok(());
    }
    r.seek(SeekFrom::Start(start))?;
    let mut left = count;
    let mut buf = Zeroizing::new(vec![0u8; 256 * 1024]);
    while left > 0 {
        let want = left.min(buf.len() as u64) as usize;
        let n = r.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n])?;
        left -= n as u64;
    }
    w.flush()
}

// ---- running ffmpeg -------------------------------------------------------------------

/// Run ffmpeg with `args`; its output (stdout) comes back in memory.
/// `on_time` gets the seconds of output made so far.
fn run(
    tool: &Tool,
    args: &[String],
    stdin: Option<Vec<u8>>,
    stop: &dyn Fn() -> bool,
    on_time: &mut dyn FnMut(f64),
) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut child = command(&tool.path)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:2", "-nostats"])
        .args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("The video tool couldn't be started ({e})."))?;

    let feeder = match (stdin, child.stdin.take()) {
        (Some(data), Some(mut pipe)) => Some(std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        })),
        _ => None,
    };
    let too_big = Arc::new(AtomicBool::new(false));
    let mut out_pipe = child.stdout.take().ok_or("no output")?;
    let tb = too_big.clone();
    let reader = std::thread::spawn(move || {
        let mut out = Zeroizing::new(Vec::new());
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            match out_pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out.len() + n > MAX_OUTPUT {
                        tb.store(true, Ordering::SeqCst);
                        break;
                    }
                    out.extend_from_slice(&buf[..n]);
                }
            }
        }
        out
    });
    let time_us = Arc::new(AtomicU64::new(0));
    let err_pipe = child.stderr.take().ok_or("no messages")?;
    let t2 = time_us.clone();
    let messages = std::thread::spawn(move || {
        let mut errors = Vec::new();
        for line in BufReader::new(err_pipe).lines() {
            let Ok(line) = line else { break };
            let l = line.trim();
            match l.split_once('=') {
                Some(("out_time_us", v)) | Some(("out_time_ms", v)) => {
                    if let Ok(us) = v.trim().parse::<u64>() {
                        t2.store(us, Ordering::Relaxed);
                    }
                }
                Some((k, _)) if !k.contains(' ') && !k.is_empty() => {}
                _ if !l.is_empty() && errors.len() < 20 => {
                    // Never show the local server's secret addresses.
                    let clean: Vec<&str> = l
                        .split_whitespace()
                        .map(|w| if w.contains("://127.0.0.1") { "(the item)" } else { w })
                        .collect();
                    errors.push(clean.join(" "));
                }
                _ => {}
            }
        }
        errors
    });

    let mut stopped = false;
    let status = loop {
        if stop() || too_big.load(Ordering::SeqCst) {
            let _ = child.kill();
            stopped = true;
        }
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {}
            Err(_) => break None,
        }
        on_time(time_us.load(Ordering::Relaxed) as f64 / 1e6);
        std::thread::sleep(Duration::from_millis(100));
    };
    if let Some(f) = feeder {
        let _ = f.join();
    }
    let out = reader.join().unwrap_or_default();
    let errors = messages.join().unwrap_or_default();
    if too_big.load(Ordering::SeqCst) {
        return Err("the result would be too big (over 4 GB)".into());
    }
    if stopped {
        return Err(STOPPED.into());
    }
    match status {
        Some(st) if st.success() && !out.is_empty() => Ok(out),
        _ => {
            let why = errors
                .iter()
                .rev()
                .find(|l| !l.starts_with("Conversion failed"))
                .or(errors.last())
                .map(|l| {
                    let l: String = l.chars().take(160).collect();
                    format!(" ({l})")
                })
                .unwrap_or_default();
            Err(format!("the video tool couldn't do it{why}"))
        }
    }
}

const STOPPED: &str = "stopped";

/// Size of the first video stream, from ffmpeg's description of the input.
fn probe_size(tool: &Tool, url: &str) -> Option<(u32, u32)> {
    let o = command(&tool.path)
        .args(["-hide_banner", "-nostdin", "-i", url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&o.stderr);
    let line = text.lines().find(|l| l.contains("Stream #") && l.contains("Video:"))?;
    line.split([',', ' ', '[', ']', '(', ')']).find_map(|tok| {
        let (w, h) = tok.split_once('x')?;
        let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
        (w > 0 && h > 0 && !tok.starts_with('0')).then_some((w, h))
    })
}

// ---- items ----------------------------------------------------------------------------

struct Row {
    id: i64,
    object: String,
    folder: Option<i64>,
    kind: String,
    name: String,
    ext: String,
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<i64>,
}

fn load_row(s: &Session, id: i64) -> Result<Row, String> {
    s.db()
        .query_row(
            "SELECT id, object_id, folder_id, kind, original_name, ext, width, height, duration_ms \
             FROM media WHERE id = ? AND deleted_at IS NULL",
            [id],
            |r| {
                Ok(Row {
                    id: r.get(0)?,
                    object: r.get(1)?,
                    folder: r.get(2)?,
                    kind: r.get(3)?,
                    name: r.get(4)?,
                    ext: r.get::<_, String>(5)?.to_ascii_lowercase(),
                    width: r.get(6)?,
                    height: r.get(7)?,
                    duration_ms: r.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "it's no longer in the library".to_string())
}

fn serve_row(server: &Server, s: &Arc<Session>, row: &Row, n: usize) -> Result<String, String> {
    let oid = ObjectId::from_hex(&row.object).map_err(|e| e.to_string())?;
    let ext: String = row.ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    Ok(server.add(&format!("{n}.{ext}"), Source::Object(s.clone(), oid)))
}

/// Store a result as a new item next to `from`. An identical item already
/// in that folder is reused instead of adding a duplicate.
fn save_result(
    s: &Session,
    folder: Option<i64>,
    name: &str,
    bytes: &[u8],
    from: Option<i64>,
    size: Option<(u32, u32)>,
    duration_ms: Option<i64>,
) -> Result<i64, String> {
    let id = import::add_bytes(s, folder, name, bytes)?;
    let db = s.db();
    let (object, sha): (String, String) = db
        .query_row("SELECT object_id, sha256 FROM media WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    let same: Option<i64> = db
        .query_row(
            "SELECT id FROM media WHERE sha256 = ?1 AND IFNULL(folder_id, 0) = IFNULL(?2, 0) \
             AND deleted_at IS NULL AND id <> ?3 LIMIT 1",
            params![sha, folder, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(existing) = same {
        db.execute("DELETE FROM media WHERE id = ?", [id]).map_err(|e| e.to_string())?;
        drop(db);
        if let Ok(oid) = ObjectId::from_hex(&object) {
            let _ = s.vault().delete_object(ObjectKind::Media, &oid);
        }
        return Ok(existing);
    }
    if let Some((w, h)) = size {
        db.execute("UPDATE media SET width = ?1, height = ?2 WHERE id = ?3", params![w, h, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(d) = duration_ms {
        db.execute("UPDATE media SET duration_ms = ?1 WHERE id = ?2", params![d, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(orig) = from {
        // Same date taken and the same tags as the original.
        db.execute(
            "UPDATE media SET taken_at = (SELECT taken_at FROM media WHERE id = ?1), \
             file_mtime = (SELECT file_mtime FROM media WHERE id = ?1) WHERE id = ?2",
            params![orig, id],
        )
        .map_err(|e| e.to_string())?;
        db.execute(
            "INSERT OR IGNORE INTO media_tags(media_id, tag_id) SELECT ?1, tag_id FROM media_tags WHERE media_id = ?2",
            params![id, orig],
        )
        .map_err(|e| e.to_string())?;
    }
    drop(db);
    s.mark_dirty();
    Ok(id)
}

// ---- progress -------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgress {
    pub task: &'static str,
    /// Items finished.
    pub done: usize,
    pub total: usize,
    /// The item being worked on.
    pub name: String,
    /// Everything together, 0…1.
    pub fraction: f64,
}

// ---- convert --------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Mp4,
    Webm,
    Gif,
    Jpg,
    Png,
    Webp,
}

impl Target {
    pub fn ext(self) -> &'static str {
        match self {
            Target::Mp4 => "mp4",
            Target::Webm => "webm",
            Target::Gif => "gif",
            Target::Jpg => "jpg",
            Target::Png => "png",
            Target::Webp => "webp",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Target::Mp4 => "an MP4 video",
            Target::Webm => "a WebM video",
            Target::Gif => "a GIF",
            Target::Jpg => "a JPG picture",
            Target::Png => "a PNG picture",
            Target::Webp => "a WebP picture",
        }
    }
    fn is_picture(self) -> bool {
        matches!(self, Target::Jpg | Target::Png | Target::Webp)
    }
}

/// Which targets make sense for an item kind ("image", "gif", "video").
pub fn targets_for(kind: &str) -> &'static [Target] {
    match kind {
        "video" => &[Target::Mp4, Target::Webm, Target::Gif],
        "gif" => &[Target::Mp4, Target::Webm, Target::Gif, Target::Jpg, Target::Png, Target::Webp],
        "image" => &[Target::Jpg, Target::Png, Target::Webp],
        _ => &[],
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub ids: Vec<i64>,
    pub target: Target,
    /// Put the original in the trash once the new item is saved.
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertDone {
    pub converted: usize,
    /// The new items.
    pub created: Vec<i64>,
    /// Originals moved to the trash.
    pub replaced: usize,
    /// (name, what went wrong)
    pub failed: Vec<(String, String)>,
    pub cancelled: bool,
    pub error: Option<String>,
}

fn even_scale() -> &'static str {
    "scale=trunc(iw/2)*2:trunc(ih/2)*2"
}

/// H.264 settings for the encoders this ffmpeg has (best first). `crf` is for
/// libx264; the others get a bitrate for about the same look.
fn h264_args(tool: &Tool, crf: u32, bitrate: u64) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    if tool.has("libx264") {
        let mut a = s(&["-c:v", "libx264", "-preset", "medium", "-crf"]);
        a.push(crf.to_string());
        a.extend(s(&["-profile:v", "high"]));
        a
    } else if tool.has("libopenh264") {
        let mut a = s(&["-c:v", "libopenh264", "-b:v"]);
        a.push(bitrate.to_string());
        a
    } else if tool.has("h264_mf") {
        let mut a = s(&["-c:v", "h264_mf", "-rate_control", "quality", "-b:v"]);
        a.push(bitrate.to_string());
        a
    } else {
        s(&["-c:v", "mpeg4", "-q:v", "3"])
    }
}

/// A sensible H.264 bitrate for a size and frame rate when CRF isn't available.
fn bitrate_for(w: Option<i64>, h: Option<i64>, fps: f64, bits_per_pixel: f64) -> u64 {
    let (w, h) = (w.unwrap_or(1280).max(16) as f64, h.unwrap_or(720).max(16) as f64);
    ((w * h * fps * bits_per_pixel) as u64).clamp(300_000, 20_000_000)
}

const FRAG_MP4: &str = "frag_keyframe+empty_moov+default_base_moof";

fn convert_args(tool: &Tool, row: &Row, target: Target, url: &str) -> Result<Vec<String>, String> {
    if !targets_for(&row.kind).contains(&target) {
        return Err(match row.kind.as_str() {
            "image" => format!("a picture can't become {}", target.label()),
            "video" => format!("a video can't become {} here (use Save frame in the player)", target.label()),
            _ => "only pictures, GIFs and videos can be converted".to_string(),
        });
    }
    let same = match target {
        Target::Jpg => matches!(row.ext.as_str(), "jpg" | "jpeg"),
        Target::Mp4 => false, // re-making an MP4 fixes videos that won't play
        t => row.ext == t.ext(),
    };
    if same {
        return Err(format!("it's already {}", target.label()));
    }
    let mut a: Vec<String> = vec!["-i".into(), url.into()];
    let push = |a: &mut Vec<String>, v: &[&str]| a.extend(v.iter().map(|x| x.to_string()));
    match target {
        Target::Mp4 => {
            push(&mut a, &["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]);
            push(&mut a, &["-vf", &format!("{},format=yuv420p", even_scale())]);
            a.extend(h264_args(tool, 20, bitrate_for(row.width, row.height, 30.0, 0.12)));
            push(&mut a, &["-c:a", "aac", "-b:a", "160k", "-movflags", FRAG_MP4, "-f", "mp4", "pipe:1"]);
        }
        Target::Webm => {
            push(&mut a, &["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]);
            push(&mut a, &["-vf", &format!("{},format=yuv420p", even_scale())]);
            if tool.has("libvpx-vp9") {
                push(&mut a, &["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1"]);
            } else if tool.has("libvpx") {
                push(&mut a, &["-c:v", "libvpx", "-b:v", "3M", "-crf", "10", "-deadline", "good", "-cpu-used", "4"]);
            } else {
                return Err("this copy of the video tool can't make WebM videos".into());
            }
            if tool.has("libopus") {
                push(&mut a, &["-c:a", "libopus", "-b:a", "128k"]);
            } else {
                push(&mut a, &["-c:a", "libvorbis", "-q:a", "5"]);
            }
            push(&mut a, &["-f", "webm", "pipe:1"]);
        }
        Target::Gif => {
            push(&mut a, &[
                "-filter_complex",
                "[0:v:0]fps=15,scale='min(640,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[out]",
                "-map", "[out]", "-loop", "0", "-f", "gif", "pipe:1",
            ]);
        }
        Target::Jpg => push(&mut a, &["-map", "0:v:0", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj420p", "-f", "image2pipe", "pipe:1"]),
        Target::Png => push(&mut a, &["-map", "0:v:0", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"]),
        Target::Webp => {
            if !tool.has("libwebp") {
                return Err("this copy of the video tool can't make WebP pictures".into());
            }
            push(&mut a, &["-map", "0:v:0", "-frames:v", "1", "-c:v", "libwebp", "-quality", "90", "-f", "webp", "pipe:1"]);
        }
    }
    Ok(a)
}

fn new_name(name: &str, ext: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Converted".into());
    format!("{stem}.{ext}")
}

pub fn run_convert(
    s: &Arc<Session>,
    tool_path: &Path,
    req: &ConvertRequest,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&ToolProgress),
) -> ConvertDone {
    let mut done = ConvertDone::default();
    let tool = match Tool::probe(tool_path) {
        Ok(t) => t,
        Err(e) => {
            done.error = Some(e);
            return done;
        }
    };
    let server = match Server::start() {
        Ok(sv) => sv,
        Err(e) => {
            done.error = Some(format!("The video tool couldn't be prepared ({e})."));
            return done;
        }
    };
    let stop = || cancel.load(Ordering::SeqCst) || s.is_closed();
    let total = req.ids.len();
    let mut originals = Vec::new();
    for (i, &id) in req.ids.iter().enumerate() {
        if stop() {
            done.cancelled = true;
            break;
        }
        let row = match load_row(s, id) {
            Ok(r) => r,
            Err(e) => {
                done.failed.push((format!("Item {id}"), e));
                continue;
            }
        };
        progress(&ToolProgress { task: "convert", done: i, total, name: row.name.clone(), fraction: i as f64 / total.max(1) as f64 });
        let res = (|| -> Result<i64, String> {
            let url = serve_row(&server, s, &row, i)?;
            let args = convert_args(&tool, &row, req.target, &url)?;
            let dur = row.duration_ms.filter(|d| *d > 0).map(|d| d as f64 / 1000.0);
            let out = run(&tool, &args, None, &stop, &mut |t| {
                if let Some(d) = dur {
                    let f = (t / d).clamp(0.0, 1.0);
                    progress(&ToolProgress { task: "convert", done: i, total, name: row.name.clone(), fraction: (i as f64 + f) / total.max(1) as f64 });
                }
            })?;
            let name = new_name(&row.name, req.target.ext());
            let duration = (!req.target.is_picture()).then_some(row.duration_ms).flatten();
            let new_id = save_result(s, row.folder, &name, &out, Some(row.id), None, duration)?;
            // Saved (encrypted) before anything else happens to the original.
            s.save()?;
            Ok(new_id)
        })();
        match res {
            Ok(new_id) => {
                done.converted += 1;
                if !done.created.contains(&new_id) {
                    done.created.push(new_id);
                }
                if req.replace && new_id != row.id {
                    originals.push(row.id);
                }
            }
            Err(e) if e == STOPPED => {
                done.cancelled = true;
                break;
            }
            Err(e) => done.failed.push((row.name.clone(), e)),
        }
        progress(&ToolProgress { task: "convert", done: i + 1, total, name: row.name.clone(), fraction: (i + 1) as f64 / total.max(1) as f64 });
    }
    drop(server);
    if !originals.is_empty() && !s.is_closed() {
        let r = library::trash_items(&s.db(), &originals);
        match r {
            Ok(_) => {
                done.replaced = originals.len();
                s.mark_dirty();
            }
            Err(e) => done.error = Some(format!("The new items were saved, but the originals couldn't be moved to the trash ({e}).")),
        }
    }
    if !s.is_closed() && s.is_dirty() {
        let _ = s.save();
    }
    done
}

// ---- animation from pictures ----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnimFormat {
    Gif,
    Mp4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    /// The whole picture, with black bars.
    Bars,
    /// Fill the frame, cutting off the edges.
    Crop,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationRequest {
    /// In the order they appear.
    pub ids: Vec<i64>,
    pub format: AnimFormat,
    pub seconds_per_image: f64,
    /// 0 = the first picture's own width.
    pub width: u32,
    pub quality: Quality,
    /// GIF only (a video's looping is up to the player).
    #[serde(default = "yes")]
    pub loop_forever: bool,
    pub fit: Fit,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationDone {
    pub id: Option<i64>,
    pub name: String,
    /// Selected items that were left out: (name, why)
    pub skipped: Vec<(String, String)>,
    pub cancelled: bool,
    pub error: Option<String>,
}

fn even(x: f64) -> u32 {
    ((x / 2.0).round() as u32 * 2).max(2)
}

/// The filter graph: every picture scaled to one size and shown for the
/// same time, joined, and (GIF) given one good palette.
#[allow(clippy::too_many_arguments)]
fn animation_graph(n: usize, w: u32, h: u32, fit: Fit, gif: bool, frames_each: u32, rate: (u32, u32), q: Quality) -> String {
    let fmt = if gif { "rgb24" } else { "yuv420p" };
    let fit = match fit {
        Fit::Bars => format!("scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"),
        Fit::Crop => format!("scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}"),
    };
    let mut g = String::new();
    for i in 0..n {
        g.push_str(&format!(
            "[{i}:v:0]trim=end_frame=1,{fit},setsar=1,format={fmt},loop=loop={}:size=1:start=0[v{i}];\n",
            frames_each - 1
        ));
    }
    for i in 0..n {
        g.push_str(&format!("[v{i}]"));
    }
    let (num, den) = rate;
    g.push_str(&format!("concat=n={n}:v=1:a=0,setpts=N*{den}/{num}/TB,fps={num}/{den}"));
    if gif {
        let (colors, dither) = match q {
            Quality::Low => (64, "bayer:bayer_scale=3"),
            Quality::Medium => (128, "bayer:bayer_scale=2"),
            Quality::High => (256, "sierra2_4a"),
        };
        g.push_str(&format!(",split[a][b];[a]palettegen=max_colors={colors}[p];[b][p]paletteuse=dither={dither}[out]\n"));
    } else {
        g.push_str("[out]\n");
    }
    g
}

pub fn run_animation(
    s: &Arc<Session>,
    tool_path: &Path,
    req: &AnimationRequest,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(&ToolProgress),
) -> AnimationDone {
    let mut done = AnimationDone::default();
    let fail = |mut d: AnimationDone, e: String| {
        d.error = Some(e);
        d
    };
    let tool = match Tool::probe(tool_path) {
        Ok(t) => t,
        Err(e) => return fail(done, e),
    };
    let mut rows = Vec::new();
    for &id in &req.ids {
        match load_row(s, id) {
            Ok(r) if r.kind == "image" || r.kind == "gif" => rows.push(r),
            Ok(r) => done.skipped.push((r.name, "only pictures can be used".into())),
            Err(e) => done.skipped.push((format!("Item {id}"), e)),
        }
    }
    if rows.len() < 2 {
        return fail(done, "Pick at least two pictures.".into());
    }
    if rows.len() > MAX_ANIMATION_PICTURES {
        return fail(done, format!("That's too many pictures; an animation can have up to {MAX_ANIMATION_PICTURES}."));
    }
    let server = match Server::start() {
        Ok(sv) => sv,
        Err(e) => return fail(done, format!("The video tool couldn't be prepared ({e}).")),
    };
    let mut urls = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        match serve_row(&server, s, r, i) {
            Ok(u) => urls.push(u),
            Err(e) => return fail(done, e),
        }
    }
    let first = &rows[0];
    let size = match (first.width, first.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some((w as u32, h as u32)),
        _ => probe_size(&tool, &urls[0]),
    };
    let Some((w0, h0)) = size else {
        return fail(done, format!("“{}” couldn't be read as a picture.", first.name));
    };
    let w = even(if req.width == 0 { w0 as f64 } else { req.width as f64 }.min(4096.0));
    let h = even((w as f64 * h0 as f64 / w0 as f64).min(4096.0));

    let spp_ms = (req.seconds_per_image.clamp(0.05, 60.0) * 1000.0).round() as u32;
    let gif = req.format == AnimFormat::Gif;
    // A GIF shows each picture once for the whole time; a video repeats it
    // to keep at least 10 frames a second, which every player handles well.
    let frames_each = if gif { 1 } else { (spp_ms * 10).div_ceil(1000).max(1) };
    let rate = (frames_each * 1000, spp_ms);
    let graph = animation_graph(rows.len(), w, h, req.fit, gif, frames_each, rate, req.quality);

    let mut args: Vec<String> = Vec::new();
    for u in &urls {
        args.push("-i".into());
        args.push(u.clone());
    }
    args.push(if tool.new_options { "-/filter_complex".into() } else { "-filter_complex_script".into() });
    args.push("pipe:0".into());
    args.extend(["-map".to_string(), "[out]".to_string()]);
    if gif {
        args.extend(["-loop".into(), if req.loop_forever { "0".into() } else { "-1".into() }]);
        args.extend(["-f".into(), "gif".into(), "pipe:1".into()]);
    } else {
        let crf = match req.quality {
            Quality::Low => 28,
            Quality::Medium => 23,
            Quality::High => 18,
        };
        let bpp = match req.quality {
            Quality::Low => 0.04,
            Quality::Medium => 0.08,
            Quality::High => 0.15,
        };
        let fps = rate.0 as f64 / rate.1 as f64;
        args.extend(h264_args(&tool, crf, bitrate_for(Some(w as i64), Some(h as i64), fps, bpp)));
        args.extend(["-pix_fmt", "yuv420p", "-movflags", FRAG_MP4, "-f", "mp4", "pipe:1"].map(String::from));
    }

    let total_s = rows.len() as f64 * spp_ms as f64 / 1000.0;
    let label = format!("{} pictures", rows.len());
    progress(&ToolProgress { task: "animation", done: 0, total: 1, name: label.clone(), fraction: 0.0 });
    let stop = || cancel.load(Ordering::SeqCst) || s.is_closed();
    let out = run(&tool, &args, Some(graph.into_bytes()), &stop, &mut |t| {
        progress(&ToolProgress { task: "animation", done: 0, total: 1, name: label.clone(), fraction: (t / total_s).clamp(0.0, 0.99) });
    });
    drop(server);
    let out = match out {
        Ok(o) => o,
        Err(e) if e == STOPPED => {
            done.cancelled = true;
            return done;
        }
        Err(e) => return fail(done, format!("The animation couldn't be made: {e}.")),
    };
    let ext = if gif { "gif" } else { "mp4" };
    let name = format!("Animation {}.{ext}", crate::exporter::chrono_like_today());
    let duration = (rows.len() as u64 * spp_ms as u64) as i64;
    match save_result(s, first.folder, &name, &out, None, Some((w, h)), Some(duration)).and_then(|id| s.save().map(|_| id)) {
        Ok(id) => {
            done.id = Some(id);
            done.name = name;
            progress(&ToolProgress { task: "animation", done: 1, total: 1, name: label, fraction: 1.0 });
        }
        Err(e) => done.error = Some(format!("The animation was made but couldn't be saved ({e}).")),
    }
    done
}

// ---- saving a video's rotation ----------------------------------------------------------

/// The rotation ffmpeg reports for the first video stream, in degrees
/// counter-clockwise ("displaymatrix: rotation of -90.00 degrees"); 0 if none.
fn rotation_in(probe: &str) -> f64 {
    let mut in_video = false;
    for l in probe.lines() {
        let t = l.trim();
        if t.starts_with("Stream #") {
            if in_video {
                break;
            }
            in_video = t.contains("Video:");
            continue;
        }
        if in_video
            && let Some(rest) = t.split("rotation of ").nth(1)
            && let Some(v) = rest.split_whitespace().next().and_then(|v| v.parse::<f64>().ok())
        {
            return v;
        }
    }
    0.0
}

/// The counter-clockwise angle to store after turning a further `quarter`
/// clockwise quarter turns, in (-180, 180].
fn rotated_angle(current_ccw: f64, quarter: u8) -> i64 {
    let a = ((current_ccw / 90.0).round() as i64 * 90 - 90 * (quarter % 4) as i64).rem_euclid(360);
    if a > 180 { a - 360 } else { a }
}

/// ffmpeg arguments that copy every frame and sound as they are and only set
/// the rotation (the result streams to stdout as a fragmented MP4).
fn rotate_args(url: &str, ccw: i64, subtitles: bool) -> Vec<String> {
    let mut a: Vec<String> = vec!["-display_rotation:v:0".into(), ccw.to_string(), "-i".into(), url.into()];
    let push = |a: &mut Vec<String>, v: &[&str]| a.extend(v.iter().map(|x| x.to_string()));
    push(&mut a, &["-map", "0:v:0", "-map", "0:a?"]);
    if subtitles {
        push(&mut a, &["-map", "0:s?"]);
    }
    push(&mut a, &["-dn", "-c", "copy", "-movflags", FRAG_MP4, "-f", "mp4", "pipe:1"]);
    a
}

/// Video types whose rotation can be saved (MP4 holds it; WebM written to a
/// stream would lose its index, so it isn't offered).
pub fn can_rotate(ext: &str) -> bool {
    matches!(ext, "mp4" | "m4v")
}

/// Save a video turned `quarter` clockwise quarter turns: only the rotation in
/// the file changes, nothing is re-encoded. Through memory, like converting.
pub fn rotate_video(s: &Arc<Session>, tool_path: &Path, item: i64, quarter: u8) -> Result<crate::rotate::Turned, String> {
    let tool = Tool::probe(tool_path)?;
    let row = load_row(s, item).map_err(|e| format!("It can't be rotated: {e}."))?;
    if row.kind != "video" {
        return Err("Only videos are rotated this way.".into());
    }
    if !can_rotate(&row.ext) {
        return Err(format!("Saving the rotation works for MP4 videos; this one is {}.", row.ext.to_uppercase()));
    }
    let server = Server::start().map_err(|e| format!("The video tool couldn't be prepared ({e})."))?;
    let url = serve_row(&server, s, &row, 0)?;
    let probe = command(&tool.path)
        .args(["-hide_banner", "-nostdin", "-i", &url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("The video tool couldn't be started ({e})."))?;
    let ccw = rotated_angle(rotation_in(&String::from_utf8_lossy(&probe.stderr)), quarter);
    let stop = || s.is_closed();
    let out = match run(&tool, &rotate_args(&url, ccw, true), None, &stop, &mut |_| {}) {
        Ok(o) => o,
        // Subtitles MP4 can't hold: without them.
        Err(e) if e != STOPPED => run(&tool, &rotate_args(&url, ccw, false), None, &stop, &mut |_| {}).map_err(|_| format!("Couldn't save the rotation: {e}."))?,
        Err(e) => return Err(e),
    };
    drop(server);
    crate::rotate::replace(s, item, &out, quarter, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session;

    #[test]
    fn rotation_is_read_and_turned() {
        let probe = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '(the item)':\n  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 160x90\n      Metadata:\n        handler_name    : VideoHandler\n      Side data:\n        displaymatrix: rotation of -90.00 degrees\n  Stream #0:1[0x2](und): Audio: aac\n";
        assert_eq!(rotation_in(probe), -90.0);
        assert_eq!(rotation_in("  Stream #0:0: Video: vp9\n  Stream #0:1: Audio: opus\n      displaymatrix: rotation of 90.00 degrees\n"), 0.0);
        assert_eq!(rotation_in(""), 0.0);
        // Clockwise quarter turns lower ffmpeg's (counter-clockwise) angle.
        assert_eq!(rotated_angle(0.0, 1), -90);
        assert_eq!(rotated_angle(0.0, 3), 90);
        assert_eq!(rotated_angle(-90.0, 1), 180);
        assert_eq!(rotated_angle(180.0, 1), 90);
        assert_eq!(rotated_angle(-180.0, 2), 0);
        assert_eq!(rotated_angle(89.6, 1), 0);
        let a = rotate_args("http://x/0.mp4", -90, false);
        assert_eq!(&a[..4], &["-display_rotation:v:0", "-90", "-i", "http://x/0.mp4"]);
        assert!(a.windows(2).any(|w| w == ["-c", "copy"]));
        assert!(!a.iter().any(|x| x == "0:s?"));
        assert!(can_rotate("mp4") && can_rotate("m4v") && !can_rotate("webm"));
    }

    #[test]
    fn video_rotation_is_saved_without_re_encoding() {
        let Some(ff) = test_tool() else {
            eprintln!("ffmpeg not found: skipped");
            return;
        };
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let video_path = t.path().join("clip.mp4");
        make(&ff, &[
            "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-f", "lavfi", "-i", "sine=duration=1",
            "-c:v", "mpeg4", "-c:a", "aac", "-shortest", "-y", video_path.to_str().unwrap(),
        ]);
        let video = std::fs::read(&video_path).unwrap();
        let id = import::add_bytes(&s, None, "clip.mp4", &video).unwrap();
        s.db().execute("UPDATE media SET width = 160, height = 90, duration_ms = 1000 WHERE id = ?", [id]).unwrap();
        let probe = |data: &[u8]| -> String {
            let p = t.path().join("probe.mp4");
            std::fs::write(&p, data).unwrap();
            let o = Command::new(&ff).args(["-hide_banner", "-nostdin", "-i", p.to_str().unwrap()]).stdin(Stdio::null()).output().unwrap();
            String::from_utf8_lossy(&o.stderr).into_owned()
        };
        let packets = |data: &[u8]| -> String {
            let p = t.path().join("packets.mp4");
            std::fs::write(&p, data).unwrap();
            let o = Command::new(&ff)
                .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-i", p.to_str().unwrap(), "-map", "0:v", "-c", "copy", "-f", "framemd5", "-"])
                .stdin(Stdio::null())
                .output()
                .unwrap();
            String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.starts_with('#')).map(|l| l.rsplit(',').next().unwrap_or("").trim().to_string()).collect::<Vec<_>>().join(",")
        };

        let r = rotate_video(&s, &ff, id, 1).unwrap();
        assert!(r.lossless);
        assert_eq!((r.width, r.height), (Some(90), Some(160)));
        let (_, _, turned) = object(&s, id);
        assert_eq!(rotation_in(&probe(&turned)), -90.0, "a quarter turn clockwise");
        assert!(decodes(&ff, &turned));
        assert_eq!(packets(&turned), packets(&video), "the frames are copied, not re-encoded");
        assert!(probe(&turned).contains("Audio:"), "the sound stays");

        // Turning again builds on the stored rotation.
        let r2 = rotate_video(&s, &ff, id, 1).unwrap();
        assert_eq!(rotation_in(&probe(&object(&s, id).2)).abs(), 180.0);
        crate::rotate::undo(&s, &r2).unwrap();
        crate::rotate::undo(&s, &r).unwrap();
        assert_eq!(object(&s, id).2, video, "back to the original file");

        let webm = import::add_bytes(&s, None, "x.webm", &make(&ff, &["-f", "lavfi", "-i", "testsrc=size=32x32:rate=5:duration=1", "-c:v", "libvpx", "-f", "webm", "pipe:1"])).unwrap();
        assert!(rotate_video(&s, &ff, webm, 1).unwrap_err().contains("MP4"));
    }

    /// ffmpeg for tests: MV_FFMPEG, or the one on PATH. None = skip.
    fn test_tool() -> Option<PathBuf> {
        if let Some(p) = std::env::var_os("MV_FFMPEG") {
            let p = PathBuf::from(p);
            return p.is_file().then_some(p);
        }
        let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.is_file()))
    }

    fn vault(t: &tempfile::TempDir) -> Arc<Session> {
        let (s, _) = session::create(t.path().to_str().unwrap(), "V", "long enough pw", vault_core::KdfParams::TEST_ONLY).unwrap();
        Arc::new(s)
    }

    /// Make non-secret test media with ffmpeg straight into memory.
    fn make(ffmpeg: &Path, args: &[&str]) -> Vec<u8> {
        let o = Command::new(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-loglevel", "error"])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        o.stdout
    }

    /// The bytes decode cleanly (ffmpeg reads them from stdin).
    fn decodes(ffmpeg: &Path, data: &[u8]) -> bool {
        let mut c = Command::new(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-i", "pipe:0", "-f", "null", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut pipe = c.stdin.take().unwrap();
        let data = data.to_vec();
        let w = std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
        let ok = c.wait().unwrap().success();
        w.join().unwrap();
        ok
    }

    fn object(s: &Session, id: i64) -> (String, String, Vec<u8>) {
        let (oid, name, kind): (String, String, String) = s
            .db()
            .query_row("SELECT object_id, original_name, kind FROM media WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        let data = s.vault().read_object(ObjectKind::Media, &ObjectId::from_hex(&oid).unwrap()).unwrap();
        (name, kind, data.to_vec())
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 10), Some((0, 9)));
        assert_eq!(parse_range("bytes=4-6", 10), Some((4, 6)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=10-", 10), None);
        assert_eq!(parse_range("bytes=5-100", 10), Some((5, 9)));
        assert!(version_is_7_or_newer("N-121234-g0123"));
        assert!(version_is_7_or_newer("n8.0.1"));
        assert!(version_is_7_or_newer("7.1"));
        assert!(!version_is_7_or_newer("6.1.1-3ubuntu5"));
        assert_eq!(new_name("holiday clip.MOV.mp4", "webm"), "holiday clip.MOV.webm");
        assert_eq!(even(641.0), 642);
        assert_eq!(targets_for("image"), &[Target::Jpg, Target::Png, Target::Webp]);
    }

    #[test]
    fn server_serves_ranges_and_hides_everything_else() {
        let sv = Server::start().unwrap();
        let data: Vec<u8> = (0..=255u8).cycle().take(100_000).collect();
        let url = sv.add("0.bin", Source::Bytes(Arc::new(Zeroizing::new(data.clone()))));
        let get = |path: &str, range: Option<&str>| -> Vec<u8> {
            let mut c = TcpStream::connect(sv.addr).unwrap();
            let r = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
            write!(c, "GET {path} HTTP/1.1\r\nHost: x\r\n{r}\r\n").unwrap();
            let mut out = Vec::new();
            c.read_to_end(&mut out).unwrap();
            out
        };
        let path = url.split_once(&sv.addr.to_string()).unwrap().1.to_string();
        let full = get(&path, None);
        assert!(full.starts_with(b"HTTP/1.1 200"));
        assert!(full.ends_with(&data[data.len() - 100..]));
        let part = get(&path, Some("bytes=99990-"));
        assert!(part.starts_with(b"HTTP/1.1 206"));
        assert!(String::from_utf8_lossy(&part).contains("Content-Range: bytes 99990-99999/100000"));
        assert!(part.ends_with(&data[99_990..]));
        assert!(get("/0.bin", None).starts_with(b"HTTP/1.1 404"), "the secret path is needed");
        assert!(get(&path.replace("0.bin", "1.bin"), None).starts_with(b"HTTP/1.1 404"));
    }

    #[test]
    fn converts_a_video_to_every_format_through_memory() {
        let Some(ff) = test_tool() else {
            eprintln!("ffmpeg not found: skipped");
            return;
        };
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        // MP4 with the index at the end, so reading it needs Range requests.
        let video_path = t.path().join("test.mp4");
        make(&ff, &[
            "-f", "lavfi", "-i", "testsrc=size=161x121:rate=25:duration=2", "-f", "lavfi", "-i", "sine=duration=2",
            "-c:v", "mpeg4", "-c:a", "aac", "-shortest", "-y", video_path.to_str().unwrap(),
        ]);
        let video = std::fs::read(&video_path).unwrap();
        let folder = library::create_folder(&s.db(), None, "Clips").unwrap();
        let vid = import::add_bytes(&s, Some(folder), "test.mp4", &video).unwrap();
        s.db().execute("UPDATE media SET duration_ms = 2000 WHERE id = ?", [vid]).unwrap();
        library::tag_items(&s.db(), &[vid], &["fun".into()]).unwrap();

        let go = |ids: Vec<i64>, target: Target, replace: bool| {
            let mut last = 0.0;
            let d = run_convert(&s, &ff, &ConvertRequest { ids, target, replace }, &AtomicBool::new(false), &mut |p| {
                assert!(p.fraction >= last - 1e-9 || p.fraction == 0.0);
                last = p.fraction;
            });
            assert!(d.error.is_none(), "{d:?}");
            d
        };

        for (target, magic, kind) in [
            (Target::Mp4, &b"ftyp"[..], "video"),
            (Target::Webm, &[0x1A, 0x45, 0xDF, 0xA3][..], "video"),
            (Target::Gif, &b"GIF89a"[..], "gif"),
        ] {
            let d = go(vec![vid], target, false);
            assert_eq!(d.converted, 1, "{target:?}: {d:?}");
            let (name, k, data) = object(&s, d.created[0]);
            assert_eq!(name, format!("test.{}", target.ext()));
            assert_eq!(k, kind);
            let at = if target == Target::Mp4 { 4 } else { 0 };
            assert_eq!(&data[at..at + magic.len()], magic, "{target:?}");
            assert!(decodes(&ff, &data), "{target:?} output decodes");
            let folder_of: Option<i64> = s.db().query_row("SELECT folder_id FROM media WHERE id = ?", [d.created[0]], |r| r.get(0)).unwrap();
            assert_eq!(folder_of, Some(folder));
            if target == Target::Mp4 {
                // Plays in a browser: fragmented H.264 with an index at the end.
                assert!(data.windows(4).any(|w| w == b"moof"));
                assert!(data.windows(4).any(|w| w == b"mfra"));
                let tags = library::item_tags(&s.db(), d.created[0]).unwrap();
                assert_eq!(tags.own, vec!["fun".to_string()], "tags carry over");
            }
        }
        // Converting the same thing again doesn't add an exact duplicate.
        let before: i64 = s.db().query_row("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap();
        let again = go(vec![vid], Target::Gif, false);
        assert_eq!(again.converted, 1);
        let after: i64 = s.db().query_row("SELECT COUNT(*) FROM media WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after);

        // GIF → PNG (first frame), then replace: the GIF goes to the trash.
        let gif_id = again.created[0];
        let d = go(vec![gif_id, vid, 999_999], Target::Png, true);
        assert_eq!(d.converted, 1);
        assert_eq!(d.replaced, 1);
        assert_eq!(d.failed.len(), 2, "a video can't become a PNG; a missing item is reported: {d:?}");
        let (_, kind, png) = object(&s, d.created[0]);
        assert_eq!(kind, "image");
        assert_eq!(&png[..4], b"\x89PNG");
        let trashed: Option<i64> = s.db().query_row("SELECT deleted_at FROM media WHERE id = ?", [gif_id], |r| r.get(0)).unwrap();
        assert!(trashed.is_some());

        // PNG → JPG and WebP.
        for (target, magic) in [(Target::Jpg, &[0xFF, 0xD8][..]), (Target::Webp, &b"RIFF"[..])] {
            let d = go(vec![d.created[0]], target, false);
            assert_eq!(d.converted, 1, "{d:?}");
            let (_, kind, data) = object(&s, d.created[0]);
            assert_eq!(kind, "image");
            assert_eq!(&data[..magic.len()], magic);
        }

        // Stopping.
        let stopped = run_convert(&s, &ff, &ConvertRequest { ids: vec![vid], target: Target::Webm, replace: false }, &AtomicBool::new(true), &mut |_| {});
        assert!(stopped.cancelled);
    }

    #[test]
    fn animation_from_three_pictures() {
        let Some(ff) = test_tool() else {
            eprintln!("ffmpeg not found: skipped");
            return;
        };
        let t = tempfile::tempdir().unwrap();
        let s = vault(&t);
        let folder = library::create_folder(&s.db(), None, "Trip").unwrap();
        let a = make(&ff, &["-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"]);
        let b = make(&ff, &["-f", "lavfi", "-i", "mandelbrot=size=200x300", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
        let c = make(&ff, &["-f", "lavfi", "-i", "smptebars=size=640x360", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
        let ia = import::add_bytes(&s, Some(folder), "a.jpg", &a).unwrap();
        let ib = import::add_bytes(&s, None, "b.png", &b).unwrap();
        let ic = import::add_bytes(&s, None, "c.png", &c).unwrap();

        for (format, fit, magic) in [(AnimFormat::Gif, Fit::Bars, &b"GIF89a"[..]), (AnimFormat::Mp4, Fit::Crop, &b"ftyp"[..])] {
            let req = AnimationRequest {
                ids: vec![ia, ib, ic],
                format,
                seconds_per_image: 0.5,
                width: 161,
                quality: Quality::Medium,
                loop_forever: true,
                fit,
            };
            let mut seen = 0;
            let d = run_animation(&s, &ff, &req, &AtomicBool::new(false), &mut |_| seen += 1);
            assert!(d.error.is_none(), "{d:?}");
            assert!(seen >= 2);
            let id = d.id.unwrap();
            let (name, _, data) = object(&s, id);
            assert!(name.starts_with("Animation ") && name.ends_with(if format == AnimFormat::Gif { ".gif" } else { ".mp4" }), "{name}");
            let at = if format == AnimFormat::Mp4 { 4 } else { 0 };
            assert_eq!(&data[at..at + magic.len()], magic);
            assert!(decodes(&ff, &data));
            let (f, w, h, dur): (Option<i64>, i64, i64, i64) = s
                .db()
                .query_row("SELECT folder_id, width, height, duration_ms FROM media WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap();
            assert_eq!(f, Some(folder), "saved next to the first picture");
            assert_eq!((w, h, dur), (162, 122, 1500), "even size from the first picture's shape");
            if format == AnimFormat::Gif {
                // Three frames, each shown for 50 hundredths of a second.
                let delays = data.windows(4).filter(|w| w[0] == 0x21 && w[1] == 0xF9 && w[2] == 0x04).count();
                assert_eq!(delays, 3);
            }
        }

        let one = run_animation(
            &s,
            &ff,
            &AnimationRequest { ids: vec![ia], format: AnimFormat::Gif, seconds_per_image: 1.0, width: 0, quality: Quality::Low, loop_forever: true, fit: Fit::Bars },
            &AtomicBool::new(false),
            &mut |_| {},
        );
        assert!(one.error.is_some());
    }
}
