//! `trackwall://` links (ADR-52): `trackwall://repo/<repo id>`, `trackwall://session/<session id>` and
//! `trackwall://task/<task id>` (also a task proposal, which has the id of the task it becomes) show that thing in the
//! window, so an agent or a notification can point the user at it.
//!
//! A link comes from anywhere (a web page, a chat, an agent's text), so it is untrusted: only the exact shape above
//! with a valid id becomes a jump, and any other link only shows the window. A link never starts, stops or changes
//! anything. macOS takes the scheme from `Info.plist` (`plugins.deep-link` in `tauri.conf.json`); Windows has no
//! installer (portable zip), so a release build registers the scheme for the current user at every start, which also
//! follows the folder when the user moves it.

use crate::focus::{self, Focus};
use crate::window_effect;
use tauri::{AppHandle, Url};
use tauri_plugin_deep_link::DeepLinkExt;

/// The scheme, also in `tauri.conf.json` and as `TRACKWALL_LINK_SCHEME` in protocol.
const SCHEME: &str = "trackwall";

/// The jump a link asks for; `None` for anything that is not exactly a Trackwall link with a valid id.
pub fn parse(url: &Url) -> Option<Focus> {
    if url.scheme() != SCHEME || url.query().is_some() || url.fragment().is_some() || url.port().is_some() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let mut segments = url.path_segments()?.filter(|s| !s.is_empty());
    let (Some(id), None) = (segments.next(), segments.next()) else { return None };
    match url.host_str()? {
        "repo" if is_repo_id(id) => Some(Focus::Repo(id.to_owned())),
        "session" if is_uuid(id) => Some(Focus::Session(id.to_ascii_lowercase())),
        "task" if is_uuid(id) => Some(Focus::Task(id.to_ascii_lowercase())),
        _ => None,
    }
}

/// `RepoId` in protocol: lowercase letters, digits, '.', '_' and '-', starting with a letter or digit, at most 64.
fn is_repo_id(id: &str) -> bool {
    let first = id.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    first && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

/// A UUID in its text form (`SessionId` and `TaskId` in protocol).
fn is_uuid(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() })
}

/// Opens the links that reach the app from now on, and the one that started it.
pub fn listen(app: &AppHandle, show: fn(&AppHandle)) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| open(&handle, event.urls(), show));
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        open(app, urls, show);
    }
    register(app);
}

/// The last link wins, like a newer tray jump replaces an older one. A link that starts the app comes before the page
/// has loaded; the page then shows the window itself (ADR-11) and takes the jump when it starts.
fn open(app: &AppHandle, urls: Vec<Url>, show: fn(&AppHandle)) {
    let show: fn(&AppHandle) = if window_effect::reveal_pending(app) { |_| {} } else { show };
    match urls.last().and_then(parse) {
        Some(target) => focus::request(app, target, show),
        None => show(app),
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

    fn jump(link: &str) -> Option<Focus> {
        parse(&Url::parse(link).expect("a URL"))
    }

    #[test]
    fn a_link_names_a_repo_a_session_or_a_task() {
        assert_eq!(jump("trackwall://repo/orders-api"), Some(Focus::Repo("orders-api".into())));
        assert_eq!(jump(&format!("trackwall://session/{ID}")), Some(Focus::Session(ID.into())));
        assert_eq!(jump(&format!("trackwall://task/{ID}")), Some(Focus::Task(ID.into())));
    }

    #[test]
    fn a_trailing_slash_and_an_uppercase_uuid_are_accepted() {
        assert_eq!(jump("trackwall://repo/orders-api/"), Some(Focus::Repo("orders-api".into())));
        assert_eq!(jump(&format!("trackwall://session/{}", ID.to_uppercase())), Some(Focus::Session(ID.into())));
    }

    #[test]
    fn anything_else_is_not_a_jump() {
        for link in [
            "https://repo/orders-api",
            "trackwall://repo",
            "trackwall://repo/",
            "trackwall://repo/Orders",
            "trackwall://repo/-orders",
            "trackwall://repo/a/b",
            "trackwall://repo/orders?run=1",
            "trackwall://repo/orders#x",
            "trackwall://user@repo/orders",
            "trackwall://repo:1/orders",
            "trackwall://repo/%2e%2e",
            "trackwall://session/not-a-uuid",
            "trackwall://proposal/0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10",
            "trackwall://settings/x",
            "trackwall:repo/orders",
        ] {
            assert_eq!(jump(link), None, "{link}");
        }
        assert_eq!(jump(&format!("trackwall://repo/{}", "a".repeat(65))), None);
    }
}
