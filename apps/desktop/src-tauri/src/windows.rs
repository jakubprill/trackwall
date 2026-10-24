//! Trackwall windows (ADR-49): the main window from `tauri.conf.json` and extra windows the user opens on other
//! monitors. Every window is the same UI with its own view, connected to the same daemon. Extra windows have stable
//! labels (`window-2`, `window-3`…, the lowest free number), so `tauri-plugin-window-state` gives a reopened window
//! the monitor, size and position of the last window with that label. The shell remembers which windows show the
//! Sessions view and in which order they were last focused, to pick the window for a session from the tray (§5.4).

use crate::window_effect::WindowEffects;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::AppHandleExt;

/// Label of the window from `tauri.conf.json`; it hides to the tray instead of closing.
pub const MAIN: &str = "main";
/// Extra window labels are this prefix plus a number from 2; `capabilities/default.json` allows `window-*`.
const EXTRA_PREFIX: &str = "window-";
/// Query parameter with the view an extra window starts with; read by `viewFromLocation` in the UI.
const VIEW_PARAM: &str = "view";
/// A view id is a short lowercase word (`home`, `sessions`…); anything else never reaches the window URL.
const MAX_VIEW_LEN: usize = 32;

/// Which windows show Sessions and the order of focus, most recently focused last. `opening` makes opening windows
/// one at a time, so two quick opens do not pick the same free label; it is separate from the registry, which the main
/// thread locks on focus while `open` waits for the main thread to build the window.
#[derive(Default)]
pub struct Windows {
    registry: Mutex<Registry>,
    opening: Mutex<()>,
}

/// Locks a mutex that a panic cannot leave half-changed (every change under these locks is a single step), so a
/// poisoned value is still usable.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
        self.focus_order
            .iter()
            .rev()
            .find(|l| self.showing_sessions.contains(l))
            .or(self.showing_sessions.last())
            .or(self.focus_order.last())
            .map_or(MAIN, String::as_str)
    }
}

impl Windows {
    fn with<T>(&self, f: impl FnOnce(&mut Registry) -> T) -> T {
        f(&mut lock(&self.registry))
    }

    pub fn focused(&self, label: &str) {
        self.with(|r| r.focused(label));
    }

    pub fn shows_sessions(&self, label: &str, shows: bool) {
        self.with(|r| r.shows_sessions(label, shows));
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

/// The UI page of an extra window that starts with `view`, or with the UI's first view without one; `None` for
/// something that is not a view id.
fn window_url(view: Option<&str>) -> Option<String> {
    let Some(view) = view else { return Some("index.html".into()) };
    let is_view_id = !view.is_empty() && view.len() <= MAX_VIEW_LEN && view.bytes().all(|b| b.is_ascii_lowercase());
    is_view_id.then(|| format!("index.html?{VIEW_PARAM}={view}"))
}

/// Opens an extra window with `view`, built from the main window's configuration (size, minimum size,
/// transparency, theme) and hidden until its page has loaded, like the main window (ADR-11).
///
/// Must not run on the main thread: on Windows building a window there deadlocks (Tauri docs), so the tray calls it
/// from the async runtime and the UI through an async command.
/// It gets the same background effect and reveal after page load as the main window (ADR-11): its effect entry exists
/// before the window, the effect is applied on the main thread and a fallback timer shows it if the page never loads.
pub fn open(app: &AppHandle, view: Option<&str>) -> Result<(), String> {
    let url = window_url(view).ok_or_else(|| format!("not a view id: {view:?}"))?;
    let config = app.config().app.windows.iter().find(|w| w.label == MAIN).ok_or("missing window main from tauri.conf.json")?;
    let window = {
        let windows = app.state::<Windows>();
        let _one_at_a_time = lock(&windows.opening);
        let label = next_label(app.webview_windows().keys().map(String::as_str));
        app.state::<WindowEffects>().register(&label);
        let mut window_config = config.clone();
        window_config.label = label.clone();
        window_config.url = WebviewUrl::App(url.into());
        let built = WebviewWindowBuilder::from_config(app, &window_config).and_then(|builder| builder.build());
        built.inspect_err(|_| app.state::<WindowEffects>().forget(&label)).map_err(|e| e.to_string())?
    };
    let label = window.label().to_string();
    let effects_app = app.clone();
    app.run_on_main_thread(move || {
        let applied = effects_app.state::<WindowEffects>().apply(&window);
        crate::window_effect::reveal_fallback(&effects_app, window.label(), applied);
    })
    .map_err(|e| format!("applying the effect of {label}: {e}"))
}

/// A window is gone: it no longer gets sessions, and the position and size of an extra window are saved now, not
/// only when the shell exits, so a reopened window finds them after a crash too.
pub fn closed(app: &AppHandle, label: &str) {
    app.state::<Windows>().with(|r| r.closed(label));
    app.state::<WindowEffects>().forget(label);
    if let Err(err) = app.save_window_state(crate::WINDOW_STATE_FLAGS) {
        eprintln!("[desktop] saving the window state: {err}");
    }
}

/// Shows and focuses a window, also one hidden to the tray or minimized; one shown before its page has loaded does
/// not pop up again after loading.
pub fn show(app: &AppHandle, label: &str) {
    app.state::<WindowEffects>().mark_revealed(label);
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
        assert_eq!(window_url(Some("sessions")).as_deref(), Some("index.html?view=sessions"));
    }

    #[test]
    fn a_window_without_a_view_opens_the_first_view_of_the_ui() {
        assert_eq!(window_url(None).as_deref(), Some("index.html"));
    }

    #[test]
    fn anything_but_a_lowercase_word_is_not_a_view_id() {
        assert_eq!(window_url(Some("")), None);
        assert_eq!(window_url(Some("home&token=x")), None);
        assert_eq!(window_url(Some("../index")), None);
        assert_eq!(window_url(Some("Sessions")), None);
        assert_eq!(window_url(Some(&"a".repeat(MAX_VIEW_LEN + 1))), None);
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
