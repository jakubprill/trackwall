//! A remote daemon (ADR-130): a daemon the app connects to instead of starting its own, for example one in a dev
//! container whose port is forwarded to 127.0.0.1 of this computer. The app neither starts nor stops it.
//!
//! The user pastes the address the daemon's page opens with (`http://127.0.0.1:<port>/#token=<token>`); the port and
//! token go into `remote-daemon.json` in the shell's configuration directory, which decides the mode at every start.
//! Switching the mode restarts the app, so the daemon of one mode never outlives the switch unnoticed.

use crate::daemon;
use crate::daemon_state::DaemonState;
use crate::{autostart, json_file};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Url};

const FILE: &str = "remote-daemon.json";

/// The longest token accepted; the daemon's own is 43 characters (32 random bytes in base64url).
const MAX_TOKEN_LEN: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteDaemon {
    pub port: u16,
    pub token: String,
}

/// The token goes into an HTTP header written by hand (`daemon.rs`), so only base64url characters pass: a line break
/// would let a pasted address add headers of its own.
fn is_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= MAX_TOKEN_LEN && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Reads the address of the daemon's page. Only a loopback address with its port is accepted: the app talks to the
/// daemon on 127.0.0.1 alone, and the token must never reach another host.
pub fn parse_address(address: &str) -> Result<RemoteDaemon, String> {
    let url = Url::parse(address.trim()).map_err(|_| "Paste the whole address, starting with http://127.0.0.1:".to_owned())?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
        return Err("The address must start with http://127.0.0.1: or http://localhost: (a forwarded port on this computer).".into());
    }
    let port = url.port().ok_or("The address has no port, as in http://127.0.0.1:7700/#token=….")?;
    let token = url
        .fragment()
        .and_then(|fragment| fragment.split('&').find_map(|pair| pair.strip_prefix("token=")))
        .ok_or("The address has no token: copy it with the part after #token=.")?;
    if !is_token(token) {
        return Err("The token in the address is not one Trackwall gives out.".into());
    }
    Ok(RemoteDaemon { port, token: token.to_owned() })
}

/// The saved remote daemon; a missing file means the app runs its own daemon, and a damaged one is reported and
/// ignored, so the app still starts.
pub fn load(app: &AppHandle) -> Option<RemoteDaemon> {
    let path = json_file::config_file(app, FILE)?;
    let text = std::fs::read_to_string(&path).ok()?;
    let saved = parse_file(&text);
    if saved.is_none() {
        crate::report_error!("{} is damaged; the app starts its own daemon", path.display());
    }
    saved
}

fn parse_file(text: &str) -> Option<RemoteDaemon> {
    serde_json::from_str::<RemoteDaemon>(text).ok().filter(|saved| is_token(&saved.token))
}

/// The port of the remote daemon the app uses, or `None` when it runs its own; the token stays in the shell.
#[tauri::command]
pub fn remote_daemon_port(state: tauri::State<'_, Arc<DaemonState>>) -> Option<u16> {
    state.remote().map(|remote| remote.port)
}

/// Connects to the daemon at the pasted address: checks first that it answers with this app's version and accepts
/// the token, so a wrong address leaves the app as it was, then saves it and restarts the app, which stops the app's own
/// daemon.
#[tauri::command]
pub async fn use_remote_daemon(app: AppHandle, address: String) -> Result<(), String> {
    let remote = parse_address(&address)?;
    let checked = remote.clone();
    tauri::async_runtime::spawn_blocking(move || daemon::connect_remote(&checked)).await.map_err(|e| e.to_string())??;
    let path = json_file::config_file(&app, FILE).ok_or("the system gives the app no configuration directory")?;
    json_file::save(&path, &remote).map_err(|e| format!("{}: {e}", path.display()))?;
    restart(&app);
    Ok(())
}

/// Forgets the remote daemon and restarts the app, which then starts its own.
#[tauri::command]
pub fn use_own_daemon(app: AppHandle) -> Result<(), String> {
    if let Some(path) = json_file::config_file(&app, FILE) {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("{}: {err}", path.display())),
        }
    }
    restart(&app);
    Ok(())
}

/// Like the restart after an update: the marker keeps a start at sign-in from hiding the windows again.
fn restart(app: &AppHandle) {
    autostart::before_restart(app);
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "Zm9vYmFyLWJhei1xdXV4LTAxMjM0NTY3ODktYWJjZGVm";

    #[test]
    fn reads_the_port_and_token_from_the_address_of_the_daemons_page() {
        let remote = parse_address(&format!("http://127.0.0.1:7700/#token={TOKEN}")).unwrap();
        assert_eq!(remote, RemoteDaemon { port: 7700, token: TOKEN.into() });
    }

    #[test]
    fn accepts_localhost_and_spaces_around_a_pasted_address() {
        let remote = parse_address(&format!("  http://localhost:7701/#token={TOKEN}\n")).unwrap();
        assert_eq!(remote.port, 7701);
    }

    #[test]
    fn rejects_an_address_outside_this_computer() {
        for address in [
            format!("http://192.168.1.5:7700/#token={TOKEN}"),
            format!("http://127.0.0.1.example.com:7700/#token={TOKEN}"),
            format!("https://127.0.0.1:7700/#token={TOKEN}"),
        ] {
            assert!(parse_address(&address).is_err(), "{address}");
        }
    }

    #[test]
    fn rejects_an_address_without_port_or_token() {
        assert!(parse_address(&format!("http://127.0.0.1/#token={TOKEN}")).is_err());
        assert!(parse_address("http://127.0.0.1:7700/").is_err());
        assert!(parse_address("http://127.0.0.1:7700/#token=").is_err());
        assert!(parse_address("127.0.0.1:7700").is_err());
    }

    #[test]
    fn rejects_a_token_that_could_add_a_header() {
        assert!(parse_address("http://127.0.0.1:7700/#token=abc%0D%0AX-Evil:%201").is_err());
        assert!(parse_address("http://127.0.0.1:7700/#token=abc def").is_err());
    }

    #[test]
    fn a_saved_file_reads_back_and_a_damaged_one_reads_as_none() {
        let saved = serde_json::to_string(&RemoteDaemon { port: 7700, token: TOKEN.into() }).unwrap();
        assert_eq!(parse_file(&saved), Some(RemoteDaemon { port: 7700, token: TOKEN.into() }));
        assert_eq!(parse_file(r#"{"port":7700,"token":"a\r\nb"}"#), None);
        assert_eq!(parse_file("{"), None);
    }
}
