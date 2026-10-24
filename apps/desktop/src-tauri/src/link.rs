//! `trackwall://` links (ADR-52): `trackwall://repo/<repo id>`, `trackwall://session/<session id>` and
//! `trackwall://task/<task id>` (also a task proposal, which has the id of the task it becomes) show that thing in the
//! window, so an agent or a notification can point the user at it.
//!
//! A link comes from anywhere (a web page, a chat, an agent's text), so it is untrusted. The shell checks the shape
//! (scheme, kind, one id of safe characters, nothing else) and the UI checks the id against the protocol schemas
//! (`RepoId`, `SessionId`, `TaskId`), which stay the only definition of an id. Anything else only shows the window. A
//! link never starts, stops or changes anything. macOS takes the scheme from `Info.plist` (`plugins.deep-link` in
//! `tauri.conf.json`); Windows has no installer (portable zip), so a release build registers the scheme for the current
//! user at every start, which also follows the folder when the user moves it.

use crate::jump::{self, Jump};
use tauri::{AppHandle, Url};
use tauri_plugin_deep_link::DeepLinkExt;

/// The scheme, also in `tauri.conf.json` and as `TRACKWALL_LINK_SCHEME` in protocol.
const SCHEME: &str = "trackwall";

/// Longer than any id (a `RepoId` has at most 64 characters, a UUID 36).
const MAX_ID: usize = 64;

/// The jump a link asks for; `None` for anything that is not a Trackwall link of a known kind with one id.
pub fn parse(url: &Url) -> Option<Jump> {
    if url.scheme() != SCHEME || url.query().is_some() || url.fragment().is_some() || url.port().is_some() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let mut segments = url.path_segments()?.filter(|s| !s.is_empty());
    let (Some(id), None) = (segments.next(), segments.next()) else { return None };
    if id.len() > MAX_ID || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
        return None;
    }
    // The `url` crate keeps the host of a custom scheme as written; the kind is matched without case like the scheme.
    let id = id.to_owned();
    match url.host_str()?.to_ascii_lowercase().as_str() {
        "repo" => Some(Jump::Repo(id)),
        "session" => Some(Jump::Session(id.to_ascii_lowercase())),
        "task" => Some(Jump::Task(id.to_ascii_lowercase())),
        _ => None,
    }
}

/// Opens the links that reach the app from now on, and the one that started it. `show` shows the main window for a
/// link that is not a jump, unless its page is still loading.
pub fn listen(app: &AppHandle, show: fn(&AppHandle)) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| open(&handle, event.urls(), show));
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        open(app, urls, show);
    }
    register(app);
}

/// The last link wins, like a newer tray jump replaces an older one.
fn open(app: &AppHandle, urls: Vec<Url>, show: fn(&AppHandle)) {
    match urls.last().and_then(parse) {
        Some(target) => jump::request(app, target),
        None => show(app),
    }
}

/// Whether a second start carries a link (the deep-link plugin's rule: one argument, a URL with the scheme). The link
/// then shows its own window, and the second start must not bring the main window over it.
#[cfg_attr(debug_assertions, allow(dead_code))] // the single instance is release-only (`main.rs`)
pub fn in_args(args: &[String]) -> bool {
    matches!(args, [_, arg] if Url::parse(arg).is_ok_and(|url| url.scheme() == SCHEME))
}

/// A link clicked inside a window, e.g. in a session terminal: the same check as a link from outside, without the
/// round trip through the system.
#[tauri::command]
pub fn open_link(app: AppHandle, url: String) {
    if let Some(target) = Url::parse(&url).ok().as_ref().and_then(parse) {
        jump::request(&app, target);
    }
}

/// Windows release builds only: `tauri dev` must not take the scheme away from the installed app (the same reason
/// the single instance is release-only in `main.rs`).
#[cfg(all(windows, not(debug_assertions)))]
fn register(app: &AppHandle) {
    if let Err(err) = app.deep_link().register(SCHEME) {
        eprintln!("trackwall: could not register the {SCHEME}:// links: {err}");
    }
}

#[cfg(not(all(windows, not(debug_assertions))))]
fn register(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10";

    fn jump(link: &str) -> Option<Jump> {
        parse(&Url::parse(link).expect("a URL"))
    }

    #[test]
    fn a_link_names_a_repo_a_session_or_a_task() {
        assert_eq!(jump("trackwall://repo/orders-api"), Some(Jump::Repo("orders-api".into())));
        assert_eq!(jump(&format!("trackwall://session/{ID}")), Some(Jump::Session(ID.into())));
        assert_eq!(jump(&format!("trackwall://task/{ID}")), Some(Jump::Task(ID.into())));
    }

    #[test]
    fn a_trailing_slash_and_letter_case_in_the_kind_and_the_uuid_are_accepted() {
        assert_eq!(jump("trackwall://repo/orders-api/"), Some(Jump::Repo("orders-api".into())));
        assert_eq!(jump("TrackWall://Repo/orders-api"), Some(Jump::Repo("orders-api".into())));
        assert_eq!(jump(&format!("trackwall://SESSION/{}", ID.to_uppercase())), Some(Jump::Session(ID.into())));
    }

    #[test]
    fn the_ui_checks_the_id_against_the_protocol_schemas() {
        // The shell checks only the characters; `Orders` is not a `RepoId`, and the UI drops the jump.
        assert_eq!(jump("trackwall://repo/Orders"), Some(Jump::Repo("Orders".into())));
    }

    #[test]
    fn a_second_start_carries_a_link_only_as_its_one_argument() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert!(in_args(&args(&["trackwall.exe", "trackwall://repo/orders"])));
        assert!(!in_args(&args(&["trackwall.exe"])));
        assert!(!in_args(&args(&["trackwall.exe", "trackwall://repo/orders", "--x"])));
        assert!(!in_args(&args(&["trackwall.exe", "--help"])));
    }

    #[test]
    fn anything_else_is_not_a_jump() {
        for link in [
            "https://repo/orders-api",
            "trackwall://repo",
            "trackwall://repo/",
            "trackwall://repo/a/b",
            "trackwall://repo/orders?run=1",
            "trackwall://repo/orders#x",
            "trackwall://user@repo/orders",
            "trackwall://repo:1/orders",
            "trackwall://repo/%2e%2e",
            "trackwall://repo/a%20b",
            "trackwall://proposal/0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10",
            "trackwall://settings/x",
            "trackwall:repo/orders",
        ] {
            assert_eq!(jump(link), None, "{link}");
        }
        assert_eq!(jump(&format!("trackwall://repo/{}", "a".repeat(65))), None);
    }
}
