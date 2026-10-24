//! Trackwall windows (ADR-49): the main window from `tauri.conf.json` and extra windows the user opens on other
//! monitors. Every window is the same UI with its own view, connected to the same daemon. Extra windows have stable
//! labels (`window-2`, `window-3`…, the lowest free number), so `tauri-plugin-window-state` gives a reopened window
//! the monitor, size and position of the last window with that label. The shell remembers which windows show the
//! Sessions view and in which order they were last focused, to pick the window for a session from the tray (§5.4).

use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Label of the window from `tauri.conf.json`; it hides to the tray instead of closing.
pub const MAIN: &str = "main";
/// Extra window labels are this prefix plus a number from 2; `capabilities/default.json` allows `window-*`.
const EXTRA_PREFIX: &str = "window-";
/// The view of a window opened from the tray.
pub const NEW_WINDOW_VIEW: &str = "home";
/// Query parameter with the view an extra window starts with; read by `viewFromLocation` in the UI.
const VIEW_PARAM: &str = "view";
/// A view id is a short lowercase word (`home`, `sessions`…); anything else never reaches the window URL.
const MAX_VIEW_LEN: usize = 32;

/// Which windows show Sessions and the order of focus, most recently focused last.
#[derive(Default)]
pub struct Windows(Mutex<Registry>);

#[derive(Default, Debug)]
struct Registry {
    focus_order: Vec<String>,
    showing_sessions: Vec<String>,
}

impl Registry {
    fn focused(&mut self, label: &str) {
        self.focus_order.retain(|l| l != label);
        self.focus_order.push(label.to_string());
    }

    fn shows_sessions(&mut self, label: &str, shows: bool) {
        self.showing_sessions.retain(|l| l != label);
        if shows {
            self.showing_sessions.push(label.to_string());
        }
    }

    fn closed(&mut self, label: &str) {
        self.focus_order.retain(|l| l != label);
        self.showing_sessions.retain(|l| l != label);
    }

    /// The window for a session or proposal from the tray: the last focused window that shows Sessions, otherwise
    /// the last focused window, otherwise the main window.
    fn session_window(&self) -> &str {
        let last_focused = |among: &dyn Fn(&str) -> bool| self.focus_order.iter().rev().find(|l| among(l)).map(String::as_str);
        last_focused(&|l| self.showing_sessions.iter().any(|s| s == l))
            .or_else(|| self.showing_sessions.last().map(String::as_str))
            .or_else(|| last_focused(&|_| true))
            .unwrap_or(MAIN)
    }
}

impl Windows {
    fn with<T>(&self, f: impl FnOnce(&mut Registry) -> T) -> T {
        // A panic while holding the lock leaves the registry consistent (every change is a single step), so the
        // poisoned value is still usable.
        let mut registry = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut registry)
    }

    pub fn focused(&self, label: &str) {
        self.with(|r| r.focused(label));
    }

    pub fn shows_sessions(&self, label: &str, shows: bool) {
        self.with(|r| r.shows_sessions(label, shows));
    }

    pub fn closed(&self, label: &str) {
        self.with(|r| r.closed(label));
    }

    pub fn session_window(&self) -> String {
        self.with(|r| r.session_window().to_string())
    }
}

/// The lowest free extra window label, so that a reopened window takes the place of the one closed before.
fn next_label<'a>(open: impl IntoIterator<Item = &'a str>) -> String {
    let taken: Vec<&str> = open.into_iter().collect();
    let mut n = 2;
    loop {
        let label = format!("{EXTRA_PREFIX}{n}");
        if !taken.contains(&label.as_str()) {
            return label;
        }
        n += 1;
    }
}

/// The UI page of an extra window that starts with `view`; `None` for something that is not a view id.
fn window_url(view: &str) -> Option<String> {
    let is_view_id = !view.is_empty() && view.len() <= MAX_VIEW_LEN && view.bytes().all(|b| b.is_ascii_lowercase());
    is_view_id.then(|| format!("index.html?{VIEW_PARAM}={view}"))
}

/// Opens an extra window with `view`, built from the main window's configuration (size, minimum size,
/// transparency, theme) and hidden until its page has loaded, like the main window (ADR-11).
///
/// Must not run on the main thread: on Windows building a window there deadlocks (Tauri docs), so the tray calls it
/// from the async runtime and the UI through an async command.
pub fn open(app: &AppHandle, view: &str) -> Result<WebviewWindow, String> {
    let url = window_url(view).ok_or_else(|| format!("not a view id: {view:?}"))?;
    let config = app.config().app.windows.iter().find(|w| w.label == MAIN).ok_or("missing window main from tauri.conf.json")?;
    let label = next_label(app.webview_windows().keys().map(String::as_str));
    let mut window_config = config.clone();
    window_config.label = label;
    window_config.url = WebviewUrl::App(url.into());
    WebviewWindowBuilder::from_config(app, &window_config).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())
}

/// Shows and focuses a window, also one hidden to the tray or minimized.
pub fn show(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_window_takes_the_lowest_free_number() {
        assert_eq!(next_label(["main"]), "window-2");
        assert_eq!(next_label(["main", "window-2", "window-3"]), "window-4");
        assert_eq!(next_label(["main", "window-3"]), "window-2");
    }

    #[test]
    fn a_view_id_becomes_the_view_parameter_of_the_page() {
        assert_eq!(window_url("sessions").as_deref(), Some("index.html?view=sessions"));
    }

    #[test]
    fn anything_but_a_lowercase_word_is_not_a_view_id() {
        assert_eq!(window_url(""), None);
        assert_eq!(window_url("home&token=x"), None);
        assert_eq!(window_url("../index"), None);
        assert_eq!(window_url("Sessions"), None);
        assert_eq!(window_url(&"a".repeat(MAX_VIEW_LEN + 1)), None);
    }

    #[test]
    fn a_session_goes_to_the_last_focused_window_that_shows_sessions() {
        let mut r = Registry::default();
        r.shows_sessions("main", true);
        r.shows_sessions("window-2", true);
        r.focused("window-2");
        r.focused("main");
        r.focused("window-3");
        assert_eq!(r.session_window(), "main");
    }

    #[test]
    fn a_window_showing_sessions_wins_even_if_it_was_never_focused() {
        let mut r = Registry::default();
        r.focused("main");
        r.shows_sessions("window-2", true);
        assert_eq!(r.session_window(), "window-2");
    }

    #[test]
    fn without_sessions_on_screen_a_session_goes_to_the_last_focused_window() {
        let mut r = Registry::default();
        r.focused("window-2");
        r.focused("main");
        r.focused("window-2");
        assert_eq!(r.session_window(), "window-2");
        r.shows_sessions("window-2", true);
        r.shows_sessions("window-2", false);
        assert_eq!(r.session_window(), "window-2");
    }

    #[test]
    fn a_closed_window_no_longer_gets_sessions() {
        let mut r = Registry::default();
        r.focused("main");
        r.shows_sessions("window-2", true);
        r.focused("window-2");
        r.closed("window-2");
        assert_eq!(r.session_window(), "main");
    }

    #[test]
    fn with_no_windows_known_a_session_goes_to_the_main_window() {
        assert_eq!(Registry::default().session_window(), MAIN);
    }
}
