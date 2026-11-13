//! Daemon supervision (§5.4): discovery through `daemon.json`, sidecar start, `/api/health`, graceful exit, and the
//! check of a remote daemon the app connects to instead (ADR-130).
//!
//! HTTP is written by hand on `TcpStream` here, because we only talk to our own daemon on loopback,
//! and all the traffic is a few short requests. An HTTP client with TLS and async would be bigger than the rest of the shell.

use crate::remote_daemon::RemoteDaemon;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The shell's version must equal the daemon's; the build script guards this.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A generous limit: the first launch of an unsigned binary can be scanned by an antivirus for a long time (§9).
const START_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// Where the daemon is, which sets how long a request to it may take (ADR-183).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DaemonLocation {
    /// The app's own sidecar on this computer: a connection opens at once, so a short limit tells a dead daemon quickly.
    Local,
    /// A daemon in a container behind a forwarded port (ADR-130): VS Code's forward starts a `docker exec` for every new
    /// connection, which takes seconds on a busy Windows machine whose security software checks each process start.
    Remote,
}

impl DaemonLocation {
    fn timeout(self) -> Duration {
        match self {
            DaemonLocation::Local => Duration::from_millis(1500),
            DaemonLocation::Remote => Duration::from_secs(10),
        }
    }
}

/// The fields of `daemon.json` the shell needs; the version is checked through `/api/health`, not from the file.
#[derive(Debug, Clone, Deserialize)]
pub struct DaemonFile {
    pub pid: u32,
    pub port: u16,
    pub token: String,
}

/// What the UI gets through the `daemon_connection` command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub base_url: String,
    pub token: String,
    #[serde(skip)]
    pub port: u16,
    #[serde(skip)]
    pub location: DaemonLocation,
}

impl Connection {
    pub fn new(port: u16, token: &str, location: DaemonLocation) -> Self {
        Connection { base_url: format!("http://127.0.0.1:{port}"), token: token.to_owned(), port, location }
    }
}

impl From<&DaemonFile> for Connection {
    fn from(f: &DaemonFile) -> Self {
        Connection::new(f.port, &f.token, DaemonLocation::Local)
    }
}

/// The state directory in a development build is separate, so that `tauri dev` does not connect to the daemon
/// of a release (or of `bun ... --ui`), which does not let in the Vite server's origin.
const HOME_DIR_NAME: &str = if cfg!(debug_assertions) { ".trackwall-dev" } else { ".trackwall" };

/// `TRACKWALL_HOME` or `~/.trackwall`, the same as in the daemon; an empty variable means "not set".
pub fn trackwall_home() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("TRACKWALL_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(|h| PathBuf::from(h).join(HOME_DIR_NAME))
        .ok_or_else(|| format!("home directory not found ({var} is not set)"))
}

/// A running daemon of the same version described by `daemon.json`.
pub fn discover(home: &Path) -> Option<Connection> {
    read_daemon_file(home).filter(|f| health(f.port, DaemonLocation::Local).as_deref() == Some(VERSION)).map(|f| Connection::from(&f))
}

pub fn read_daemon_file(home: &Path) -> Option<DaemonFile> {
    let text = fs::read_to_string(home.join("daemon.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// The version from `GET /api/health`, or `None` when nobody answers.
pub fn health(port: u16, location: DaemonLocation) -> Option<String> {
    health_answer(port, location).ok().flatten()
}

/// What `GET /api/health` came to: the version, `None` when whatever answered is not a Trackwall daemon, or why no answer came.
fn health_answer(port: u16, location: DaemonLocation) -> Result<Option<String>, HttpError> {
    let (status, body) = http(port, location, "GET", "/api/health", None)?;
    if status != 200 {
        return Ok(None);
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else { return Ok(None) };
    if v["ok"] != serde_json::Value::Bool(true) {
        return Ok(None);
    }
    Ok(v["data"]["version"].as_str().map(str::to_owned))
}

/// Finds a running daemon or starts the sidecar and waits until it answers.
/// `cancel` stops the waiting and kills a started sidecar that does not answer yet (exit during startup).
pub fn ensure_daemon(home: &Path, cancel: &AtomicBool) -> Result<Connection, String> {
    if let Some(existing) = read_daemon_file(home) {
        match health(existing.port, DaemonLocation::Local) {
            Some(v) if v == VERSION => return Ok(Connection::from(&existing)),
            Some(v) => {
                return Err(format!(
                    "Trackwall daemon {v} is running (pid {}), but this app is {VERSION}. \
                     Stop the old daemon and click “Try again”.",
                    existing.pid
                ))
            }
            None => {} // stale file after a crash; the new daemon overwrites it
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("Daemon start cancelled.".into());
    }
    let log_path = home.join("logs").join("daemon-start.log");
    let mut child = spawn_sidecar(home, &log_path)?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            // Code 0 means that another daemon of the same version started in the meantime.
            if status.success() {
                if let Some(conn) = discover(home) {
                    return Ok(conn);
                }
            }
            return Err(format!("The daemon exited during startup ({status}).\n\n{}", log_tail(&log_path)));
        }
        if let Some(f) = read_daemon_file(home).filter(|f| f.pid == child.id()) {
            if health(f.port, DaemonLocation::Local).as_deref() == Some(VERSION) {
                return Ok(Connection::from(&f));
            }
        }
        // After the readiness check: a daemon that is already up returns to the caller and gets a graceful stop,
        // not a hard kill, after which its services would be left without a parent.
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Daemon start cancelled.".into());
        }
        if Instant::now() > deadline {
            // We do not leave behind a process nobody knows about: without this the daemon could come up a moment later,
            // and the window and tray would have no way to connect to it or stop it.
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "The daemon did not respond within {} s and was stopped. Click “Try again”.\n\n{}",
                START_TIMEOUT.as_secs(),
                log_tail(&log_path)
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// An authenticated request that changes nothing; `200` tells that the token is right. `DAEMON_INFO_PATH` in protocol.
const DAEMON_INFO_PATH: &str = "/api/daemon/info";

/// Why a remote daemon was not taken: another version, which waiting does not change, or any other reason.
#[derive(Debug, PartialEq)]
pub enum RemoteRefusal {
    OtherVersion { port: u16, version: String },
    Refused(String),
}

impl From<RemoteRefusal> for String {
    fn from(refusal: RemoteRefusal) -> String {
        match refusal {
            RemoteRefusal::OtherVersion { port, version } => format!(
                "The daemon at 127.0.0.1:{port} is Trackwall {version}, but this app is {VERSION}. Update the older one so both \
                 are the same version, and click “Try again”."
            ),
            RemoteRefusal::Refused(reason) => reason,
        }
    }
}

/// Checks a remote daemon (ADR-130): it answers, has this app's version and accepts the token.
pub fn connect_remote(remote: &RemoteDaemon) -> Result<Connection, RemoteRefusal> {
    let port = remote.port;
    match health_answer(port, DaemonLocation::Remote) {
        Err(HttpError::Unreachable(_)) => {
            return Err(RemoteRefusal::Refused(format!(
                "No Trackwall daemon answers at 127.0.0.1:{port}. Start it (for example in its container), check that the \
                 port is forwarded to this computer, and click “Try again”."
            )))
        }
        Err(HttpError::NoAnswer(why)) => {
            // Something holds the port, most often a port forward, so "nobody answers" would send the user the wrong way.
            return Err(RemoteRefusal::Refused(format!(
                "Something accepted the connection at 127.0.0.1:{port}, but no answer came back ({why}). Check the port \
                 forward to the daemon (for example forward the port again in VS Code's Ports view) and that the daemon runs \
                 behind it, and click “Try again”."
            )));
        }
        Ok(None) => {
            return Err(RemoteRefusal::Refused(format!(
                "Something answers at 127.0.0.1:{port}, but not as a Trackwall daemon. Check that this port is forwarded to \
                 Trackwall's daemon, not to another program, and click “Try again”."
            )))
        }
        Ok(Some(version)) if version != VERSION => return Err(RemoteRefusal::OtherVersion { port, version }),
        Ok(Some(_)) => {}
    }
    match http(port, DaemonLocation::Remote, "GET", DAEMON_INFO_PATH, Some(&remote.token)).map_err(|e| RemoteRefusal::Refused(e.into()))? {
        (200, _) => Ok(Connection::new(port, &remote.token, DaemonLocation::Remote)),
        (401, _) => Err(RemoteRefusal::Refused(format!(
            "The daemon at 127.0.0.1:{port} did not accept the token: it gets a new one every time it starts. \
             Paste the address with its current token."
        ))),
        (status, _) => Err(RemoteRefusal::Refused(format!("The daemon at 127.0.0.1:{port} answered {status} to the token check."))),
    }
}

/// Graceful stop: `POST /api/daemon/shutdown`, then waiting until health stops answering.
pub fn shutdown(conn: &Connection) -> Result<(), String> {
    let (status, body) = http(conn.port, conn.location, "POST", "/api/daemon/shutdown", Some(&conn.token))?;
    if status != 200 {
        return Err(format!("shutdown returned {status}: {body}"));
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if health(conn.port, conn.location).is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("daemon is still responding after {} s", STOP_TIMEOUT.as_secs()))
}

/// Why the session list did not come: the daemon refused the token, which for a remote daemon means it restarted with
/// a new one (ADR-130), or anything else, which may pass.
#[derive(Debug, PartialEq)]
pub enum SessionsError {
    TokenRefused,
    Failed(String),
}

/// The body of the `POST /api/agents/sessions` reply (the list of Copilot CLI sessions, ADR-26).
pub fn sessions(conn: &Connection) -> Result<String, SessionsError> {
    let (status, body) =
        http(conn.port, conn.location, "POST", "/api/agents/sessions", Some(&conn.token)).map_err(|e| SessionsError::Failed(e.into()))?;
    match status {
        200 => Ok(body),
        401 => Err(SessionsError::TokenRefused),
        _ => Err(SessionsError::Failed(format!("session list returned {status}"))),
    }
}

/// The body of the `POST /api/task-outcomes/list` reply (what each task's work came to, ADR-154).
pub fn task_outcomes(conn: &Connection) -> Result<String, String> {
    let (status, body) = http(conn.port, conn.location, "POST", "/api/task-outcomes/list", Some(&conn.token))?;
    if status != 200 {
        return Err(format!("task outcomes returned {status}"));
    }
    Ok(body)
}

/// The sidecar path: next to `trackwall.exe` (portable zip) or in `Contents/MacOS` (.app bundle).
fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("app directory not found")?;
    let path = dir.join(format!("trackwall-daemon{}", std::env::consts::EXE_SUFFIX));
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("{} not found next to the app. Extract the whole archive into one folder.", path.display()))
    }
}

/// The log of the daemon started before the current one, next to `daemon-start.log`.
const PREVIOUS_START_LOG: &str = "daemon-start.prev.log";

fn spawn_sidecar(home: &Path, log_path: &Path) -> Result<Child, String> {
    let exe = sidecar_path()?;
    fs::create_dir_all(log_path.parent().unwrap_or(home)).map_err(|e| format!("{}: {e}", log_path.display()))?;
    // The previous daemon's log is kept once: when it ended in a way it could not write into the error journal (killed,
    // a crash of the runtime), its last lines are still there (ADR-94).
    let _ = fs::rename(log_path, log_path.with_file_name(PREVIOUS_START_LOG));
    let log = File::create(log_path).map_err(|e| format!("{}: {e}", log_path.display()))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&exe);
    cmd.arg("--parent").arg(std::process::id().to_string());
    // Explicitly, because in a development build the shell's default directory differs from the daemon's default.
    cmd.env("TRACKWALL_HOME", home);
    // `tauri dev` loads the UI from the Vite server, which has its own origin.
    #[cfg(debug_assertions)]
    cmd.arg("--allow-origin").arg("http://127.0.0.1:5173");
    cmd.stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log_err));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Without a console window and in its own group, so that Ctrl+C in the `tauri dev` terminal does not kill the daemon.
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(crate::system_open::CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group: the daemon has to outlive closing the window and the terminal.
        cmd.process_group(0);
    }
    cmd.spawn().map_err(|e| format!("Failed to start {}: {e}", exe.display()))
}

fn log_tail(path: &Path) -> String {
    match fs::read_to_string(path) {
        Ok(text) => {
            let lines: Vec<&str> = text.lines().collect();
            let tail = lines[lines.len().saturating_sub(20)..].join("\n");
            format!("Startup log ({}):\n{tail}", path.display())
        }
        Err(_) => format!("No startup log in {}.", path.display()),
    }
}

/// Why a request to the daemon got no answer: nothing took the connection (nobody listens, or the port is refused), or
/// something took it and no complete answer came back in time (a stalled port forward, a daemon that hangs).
#[derive(Debug, PartialEq)]
enum HttpError {
    Unreachable(String),
    NoAnswer(String),
}

impl From<HttpError> for String {
    fn from(error: HttpError) -> String {
        match error {
            HttpError::Unreachable(why) | HttpError::NoAnswer(why) => why,
        }
    }
}

const NO_ANSWER_IN_TIME: &str = "the daemon did not answer in time";

/// A read or write that ran out of time is told in words: the system says "Resource temporarily unavailable" on Unix and
/// something else on Windows, which tells the user nothing.
fn io_no_answer(error: std::io::Error) -> HttpError {
    match error.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => HttpError::NoAnswer(NO_ANSWER_IN_TIME.to_owned()),
        _ => HttpError::NoAnswer(error.to_string()),
    }
}

/// A minimal HTTP/1.1 client for the daemon on 127.0.0.1: `Connection: close`, the response read until its declared end
/// or until the connection closes, the whole request within the limit of `location`, however slowly the answer trickles in.
/// Reading stops at the declared end because a port forward may keep the connection open after the daemon closed its side.
fn http(port: u16, location: DaemonLocation, method: &str, path: &str, token: Option<&str>) -> Result<(u16, String), HttpError> {
    let deadline = Instant::now() + location.timeout();
    let left = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| HttpError::NoAnswer(NO_ANSWER_IN_TIME.to_owned()))
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, location.timeout()).map_err(|e| HttpError::Unreachable(e.to_string()))?;
    stream.set_write_timeout(Some(left()?)).map_err(io_no_answer)?;
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Content-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(io_no_answer)?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    while raw.len() < MAX_RESPONSE_BYTES && !is_complete(&raw) {
        stream.set_read_timeout(Some(left()?)).map_err(io_no_answer)?;
        match stream.read(&mut chunk).map_err(io_no_answer)? {
            0 => break,
            n => raw.extend_from_slice(&chunk[..n.min(MAX_RESPONSE_BYTES - raw.len())]),
        }
    }
    parse_response(&raw).map_err(|why| HttpError::NoAnswer(why.to_owned()))
}

/// The daemon's answers to the shell are small; more is not read.
const MAX_RESPONSE_BYTES: usize = 1 << 20;

/// The head and body of a response, split at the blank line; `None` while the head has not come in full.
fn split_response(raw: &[u8]) -> Option<(String, &[u8])> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    Some((String::from_utf8_lossy(&raw[..split]).into_owned(), &raw[split + 4..]))
}

/// The value of a header of the head, its name compared without regard to case.
fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn is_chunked(head: &str) -> bool {
    header(head, "transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"))
}

/// Whether the bytes read so far hold the whole response as its head declares it: the `Content-Length` bytes, or the last
/// chunk. A response that declares neither ends only when the connection closes.
fn is_complete(raw: &[u8]) -> bool {
    let Some((head, body)) = split_response(raw) else { return false };
    if is_chunked(&head) {
        return dechunk(body).is_ok();
    }
    header(&head, "content-length").and_then(|v| v.parse::<usize>().ok()).is_some_and(|length| body.len() >= length)
}

fn parse_response(raw: &[u8]) -> Result<(u16, String), &'static str> {
    let (head, body) = split_response(raw).ok_or("incomplete HTTP response")?;
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).ok_or("missing status code")?;
    let body = if is_chunked(&head) { dechunk(body)? } else { body.to_vec() };
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

/// Decodes `Transfer-Encoding: chunked` on bytes (chunk sizes are in bytes, not characters).
fn dechunk(mut body: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::new();
    loop {
        let eol = body.windows(2).position(|w| w == b"\r\n").ok_or("malformed chunk")?;
        let size_line = String::from_utf8_lossy(&body[..eol]);
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "malformed chunk size")?;
        let rest = &body[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        out.extend_from_slice(rest.get(..size).ok_or("chunk shorter than declared")?);
        body = rest.get(size + 2..).ok_or("missing CRLF after chunk")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_response() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
        assert_eq!(parse_response(raw).unwrap(), (200, "{\"ok\":true}".to_owned()));
    }

    #[test]
    fn parses_chunked_response() {
        let raw = b"HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"ok\r\n6\r\n\":true\r\n1\r\n}\r\n0\r\n\r\n";
        assert_eq!(parse_response(raw).unwrap(), (401, "{\"ok\":true}".to_owned()));
    }

    #[test]
    fn chunk_sizes_are_bytes_not_chars() {
        let raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nż\r\n0\r\n\r\n".as_bytes();
        assert_eq!(parse_response(raw).unwrap(), (200, "ż".to_owned()));
    }

    #[test]
    fn rejects_truncated_response() {
        assert!(parse_response(b"HTTP/1.1 200 OK\r\n").is_err());
    }

    #[test]
    fn the_apps_own_daemon_that_does_not_answer_in_one_and_a_half_seconds_counts_as_down() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("listening address").port();
        // Accepts and never answers, like a forward that stalls.
        std::thread::spawn(move || {
            let held: Vec<_> = listener.incoming().flatten().collect();
            drop(held);
        });

        let asked = Instant::now();
        assert_eq!(health(port, DaemonLocation::Local), None);
        assert!(asked.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_response_that_trickles_in_byte_by_byte_still_ends_at_the_limit() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("listening address").port();
        std::thread::spawn(move || {
            if let Some(mut stream) = listener.incoming().flatten().next() {
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\n");
                while stream.write_all(b"X").is_ok() {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        });

        let asked = Instant::now();
        assert!(http(port, DaemonLocation::Local, "GET", "/api/health", None).is_err());
        assert!(asked.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_complete_answer_counts_even_when_the_connection_stays_open() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("listening address").port();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for mut stream in listener.incoming().flatten() {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let body = format!(r#"{{"ok":true,"data":{{"version":"{VERSION}"}}}}"#);
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                let _ = stream.write_all(reply.as_bytes());
                // Kept open after a full answer, as a port forward that does not pass on the daemon's close does.
                held.push(stream);
            }
        });

        let asked = Instant::now();
        assert_eq!(health(port, DaemonLocation::Remote).as_deref(), Some(VERSION));
        assert!(asked.elapsed() < Duration::from_secs(1), "took {:?}", asked.elapsed());
    }

    #[test]
    fn a_chunked_answer_ends_at_its_last_chunk_even_when_the_connection_stays_open() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("listening address").port();
        std::thread::spawn(move || {
            if let Some(mut stream) = listener.incoming().flatten().next() {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n");
                std::thread::sleep(Duration::from_secs(30));
            }
        });

        let asked = Instant::now();
        assert_eq!(http(port, DaemonLocation::Remote, "GET", "/api/health", None), Ok((200, "ok".to_owned())));
        assert!(asked.elapsed() < Duration::from_secs(1), "took {:?}", asked.elapsed());
    }

    #[test]
    fn a_port_nobody_listens_on_is_told_as_no_daemon_answering() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
            listener.local_addr().expect("listening address").port()
        };

        let Err(RemoteRefusal::Refused(reason)) = connect_remote(&RemoteDaemon { port, token: "t".into() }) else {
            panic!("a closed port was taken");
        };
        assert!(reason.starts_with(&format!("No Trackwall daemon answers at 127.0.0.1:{port}.")), "{reason}");
    }

    #[test]
    fn a_port_that_accepts_but_never_answers_is_told_as_a_connection_without_an_answer() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("listening address").port();
        // Accepts and closes at once without a byte, as a forward whose other end is not there.
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                drop(stream);
            }
        });

        let Err(RemoteRefusal::Refused(reason)) = connect_remote(&RemoteDaemon { port, token: "t".into() }) else {
            panic!("a port without an answer was taken");
        };
        assert!(reason.starts_with(&format!("Something accepted the connection at 127.0.0.1:{port}, but no answer came")), "{reason}");
        assert!(reason.contains("port forward"), "{reason}");
    }

    #[test]
    fn a_port_that_answers_but_not_as_trackwall_is_told_so() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("listening address").port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nnot found");
            }
        });

        let Err(RemoteRefusal::Refused(reason)) = connect_remote(&RemoteDaemon { port, token: "t".into() }) else {
            panic!("another program was taken for the daemon");
        };
        assert!(reason.starts_with(&format!("Something answers at 127.0.0.1:{port}, but not as a Trackwall daemon.")), "{reason}");
    }

    #[test]
    fn a_connection_that_stays_silent_ends_with_words_not_an_os_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("listening address").port();
        std::thread::spawn(move || {
            let held: Vec<_> = listener.incoming().flatten().collect();
            drop(held);
        });

        assert_eq!(
            http(port, DaemonLocation::Local, "GET", "/api/health", None),
            Err(HttpError::NoAnswer("the daemon did not answer in time".to_owned()))
        );
    }

    #[test]
    fn connection_serializes_without_port() {
        let c = Connection::new(1, "t", DaemonLocation::Local);
        assert_eq!(serde_json::to_string(&c).unwrap(), r#"{"baseUrl":"http://127.0.0.1:1","token":"t"}"#);
    }
}
