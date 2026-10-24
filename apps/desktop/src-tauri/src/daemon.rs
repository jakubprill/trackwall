//! Nadzór daemona (§5.4): odkrycie przez `daemon.json`, start sidecara, `/api/health`, łagodne wyjście.
//!
//! HTTP jest tu pisany ręcznie na `TcpStream`, bo rozmawiamy wyłącznie z własnym daemonem na loopbacku,
//! a cały ruch to dwa krótkie żądania. Klient HTTP z TLS i async byłby większy niż reszta powłoki.

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Wersja powłoki musi być równa wersji daemona; pilnuje tego skrypt budowania.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Hojny limit: pierwsze uruchomienie niepodpisanej binarki bywa długo skanowane przez antywirus (§9).
const START_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_millis(1500);

/// Pola z `daemon.json`, których potrzebuje powłoka; wersję sprawdzamy przez `/api/health`, nie z pliku.
#[derive(Debug, Clone, Deserialize)]
pub struct DaemonFile {
    pub pid: u32,
    pub port: u16,
    pub token: String,
}

/// To, co dostaje UI przez komendę `daemon_connection`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub base_url: String,
    pub token: String,
    #[serde(skip)]
    pub port: u16,
}

impl From<&DaemonFile> for Connection {
    fn from(f: &DaemonFile) -> Self {
        Connection { base_url: format!("http://127.0.0.1:{}", f.port), token: f.token.clone(), port: f.port }
    }
}

/// Katalog stanu w buildzie deweloperskim jest osobny, żeby `tauri dev` nie podłączał się do daemona
/// z wydania (albo z `bun ... --ui`), który nie wpuszcza originu serwera Vite.
const HOME_DIR_NAME: &str = if cfg!(debug_assertions) { ".trackwall-dev" } else { ".trackwall" };

/// `TRACKWALL_HOME` albo `~/.trackwall`, tak samo jak w daemonie; pusta zmienna znaczy „nie ustawiono”.
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

/// Działający daemon tej samej wersji opisany przez `daemon.json`.
pub fn discover(home: &Path) -> Option<Connection> {
    read_daemon_file(home).filter(|f| health(f.port).as_deref() == Some(VERSION)).map(|f| Connection::from(&f))
}

pub fn read_daemon_file(home: &Path) -> Option<DaemonFile> {
    let text = fs::read_to_string(home.join("daemon.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Wersja z `GET /api/health` albo `None`, gdy nikt nie odpowiada.
pub fn health(port: u16) -> Option<String> {
    let (status, body) = http(port, "GET", "/api/health", None).ok()?;
    if status != 200 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    if v["ok"] != serde_json::Value::Bool(true) {
        return None;
    }
    v["data"]["version"].as_str().map(str::to_owned)
}

/// Znajduje działający daemon albo uruchamia sidecar i czeka, aż odpowie.
/// `cancel` przerywa czekanie i zabija uruchomiony sidecar, który jeszcze nie odpowiada (wyjście w trakcie startu).
pub fn ensure_daemon(home: &Path, cancel: &AtomicBool) -> Result<Connection, String> {
    if let Some(existing) = read_daemon_file(home) {
        match health(existing.port) {
            Some(v) if v == VERSION => return Ok(Connection::from(&existing)),
            Some(v) => {
                return Err(format!(
                    "Trackwall daemon {v} is running (pid {}), but this app is {VERSION}. \
                     Stop the old daemon and click “Try again”.",
                    existing.pid
                ))
            }
            None => {} // nieaktualny plik po awarii; nowy daemon go nadpisze
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
            // Kod 0 oznacza, że w międzyczasie wystartował inny daemon tej samej wersji.
            if status.success() {
                if let Some(conn) = discover(home) {
                    return Ok(conn);
                }
            }
            return Err(format!("The daemon exited during startup ({status}).\n\n{}", log_tail(&log_path)));
        }
        if let Some(f) = read_daemon_file(home).filter(|f| f.pid == child.id()) {
            if health(f.port).as_deref() == Some(VERSION) {
                return Ok(Connection::from(&f));
            }
        }
        // Po sprawdzeniu gotowości: daemon, który już wstał, wraca do wywołującego i dostaje łagodne zatrzymanie,
        // a nie twarde zabicie, po którym jego serwisy zostałyby bez rodzica.
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Daemon start cancelled.".into());
        }
        if Instant::now() > deadline {
            // Nie zostawiamy procesu, którego nikt nie zna: bez tego daemon mógłby wstać chwilę później,
            // a okno i tray nie miałyby jak się z nim połączyć ani go zatrzymać.
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

/// Łagodne zatrzymanie: `POST /api/daemon/shutdown`, potem czekanie, aż health przestanie odpowiadać.
pub fn shutdown(conn: &Connection) -> Result<(), String> {
    let (status, body) = http(conn.port, "POST", "/api/daemon/shutdown", Some(&conn.token))?;
    if status != 200 {
        return Err(format!("shutdown returned {status}: {body}"));
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if health(conn.port).is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("daemon still responds after {} s", STOP_TIMEOUT.as_secs()))
}

/// Treść odpowiedzi `POST /api/agents/sessions` (lista sesji Copilot CLI, ADR-26).
pub fn sessions(conn: &Connection) -> Result<String, String> {
    let (status, body) = http(conn.port, "POST", "/api/agents/sessions", Some(&conn.token))?;
    if status != 200 {
        return Err(format!("session list returned {status}"));
    }
    Ok(body)
}

/// Ścieżka sidecara: obok `trackwall.exe` (portable zip) albo w `Contents/MacOS` (bundle .app).
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

fn spawn_sidecar(home: &Path, log_path: &Path) -> Result<Child, String> {
    let exe = sidecar_path()?;
    fs::create_dir_all(log_path.parent().unwrap_or(home)).map_err(|e| format!("{}: {e}", log_path.display()))?;
    let log = File::create(log_path).map_err(|e| format!("{}: {e}", log_path.display()))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&exe);
    cmd.arg("--parent").arg(std::process::id().to_string());
    // Jawnie, bo w buildzie deweloperskim katalog domyślny powłoki różni się od domyślnego daemona.
    cmd.env("TRACKWALL_HOME", home);
    // `tauri dev` ładuje UI z serwera Vite, który ma własny origin.
    #[cfg(debug_assertions)]
    cmd.arg("--allow-origin").arg("http://127.0.0.1:5173");
    cmd.stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log_err));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Bez okna konsoli i we własnej grupie, żeby Ctrl+C w terminalu `tauri dev` nie zabijał daemona.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Własna grupa procesów: daemon ma przeżyć zamknięcie okna i terminala.
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

/// Minimalny klient HTTP/1.1 do daemona na 127.0.0.1: `Connection: close`, odpowiedź czytana do końca.
fn http(port: u16, method: &str, path: &str, token: Option<&str>) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, IO_TIMEOUT).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(|e| e.to_string())?;
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Content-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.take(1 << 20).read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse_response(&raw)
}

fn parse_response(raw: &[u8]) -> Result<(u16, String), String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("incomplete HTTP response")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let body = &raw[split + 4..];
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).ok_or("missing status code")?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let body = if chunked { dechunk(body)? } else { body.to_vec() };
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

/// Dekoduje `Transfer-Encoding: chunked` na bajtach (rozmiary chunków są w bajtach, nie znakach).
fn dechunk(mut body: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = body.windows(2).position(|w| w == b"\r\n").ok_or("malformed chunk")?;
        let size_line = String::from_utf8_lossy(&body[..eol]);
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16).map_err(|e| e.to_string())?;
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
    fn connection_serializes_without_port() {
        let c = Connection { base_url: "http://127.0.0.1:1".into(), token: "t".into(), port: 1 };
        assert_eq!(serde_json::to_string(&c).unwrap(), r#"{"baseUrl":"http://127.0.0.1:1","token":"t"}"#);
    }
}
