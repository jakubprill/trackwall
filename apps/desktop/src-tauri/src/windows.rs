//! Trackwall windows (ADR-49): the main window from `tauri.conf.json` and extra windows the user opens on other
//! monitors. Every window is the same UI with its own view, connected to the same daemon. Extra windows have stable
//! labels (`window-2`, `window-3`…, the lowest free number), so `tauri-plugin-window-state` gives a reopened window
//! the monitor, size and position of the last window with that label. The shell remembers what each window shows and
//! in which order they were last focused, to pick the window for a session from the tray (§5.4), and saves the open
//! extra windows so that the next start opens them again (`saved_windows`).

use crate::jump::PendingJump;
use crate::lock::lock;
use crate::saved_windows::{self, SavedWindow, Shown};
use crate::window_effect::WindowEffects;
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Label of the window from `tauri.conf.json`; it hides to the tray instead of closing.
pub const MAIN: &str = "main";
/// Extra window labels are this prefix plus a number from 2; `capabilities/default.json` allows `window-*`.
const EXTRA_PREFIX: &str = "window-";
/// Query parameters with the view and session layout an extra window starts with; read by `app-window.ts` in the UI.
const VIEW_PARAM: &str = "view";
const SESSION_LAYOUT_PARAM: &str = "sessionLayout";
/// What `tauri-plugin-window-state` keeps per window: where it was and how big, not whether it was visible, which
/// stays with the reveal after page load (ADR-11).
pub const STATE_FLAGS: StateFlags = StateFlags::POSITION.union(StateFlags::SIZE).union(StateFlags::MAXIMIZED).union(StateFlags::FULLSCREEN);

/// What each window shows (which ones show Sessions, and for extra windows the list saved for the next start) and the
/// order of focus, most recently focused last. `opening` makes opening windows one at a time, so two quick opens do
/// not pick the same free label; it is separate from the registry, which the main thread locks on focus while `open`
/// waits for the main thread to build the window.
#[derive(Default)]
pub struct Windows {
    registry: Mutex<Registry>,
    opening: Mutex<()>,
}

#[derive(Default, Debug)]
struct Registry {
    focus_order: Vec<String>,
    showing_sessions: Vec<String>,
    /// What each open extra window shows, the list that is saved for the next start.
    extra_shown: BTreeMap<String, Shown>,
}

impl Registry {
    fn focused(&mut self, label: &str) {
        self.focus_order.retain(|l| l != label);
        self.focus_order.push(label.to_string());
    }

    fn shows(&mut self, label: &str, shown: Shown) {
        self.showing_sessions.retain(|l| l != label);
        if shown.view() == SESSIONS_VIEW {
            self.showing_sessions.push(label.to_string());
        }
        if is_extra(label) {
            self.extra_shown.insert(label.to_string(), shown);
        }
    }

    /// The user closed an extra window, so the next start does not open it again.
    fn closed_by_user(&mut self, label: &str) {
        self.extra_shown.remove(label);
    }

    /// Windows from the last run that are about to open; they are in the saved list before they report.
    fn restoring(&mut self, saved: &[SavedWindow]) {
        for w in saved {
            self.extra_shown.insert(w.label.clone(), w.shown.clone());
        }
    }

    fn saved(&self) -> Vec<SavedWindow> {
        self.extra_shown.iter().map(|(label, shown)| SavedWindow { label: label.clone(), shown: shown.clone() }).collect()
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

    pub fn session_window(&self) -> String {
        self.with(|r| r.session_window().to_string())
    }
}

/// The view id of Sessions in the UI (`App.tsx`).
const SESSIONS_VIEW: &str = "sessions";

/// A label `next_label` can give: the prefix and a number from 2, written without a sign or leading zero.
fn is_extra(label: &str) -> bool {
    label.strip_prefix(EXTRA_PREFIX).is_some_and(|n| n.parse::<u32>().is_ok_and(|parsed| parsed >= 2 && parsed.to_string() == n))
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

/// The UI page of an extra window: the view and session layout it starts with, each only if it is an id, or the UI's
/// defaults without them; `None` for something that is not an id.
fn window_url(view: Option<&str>, session_layout: Option<&str>) -> Option<String> {
    let mut params = Vec::new();
    for (name, value) in [(VIEW_PARAM, view), (SESSION_LAYOUT_PARAM, session_layout)] {
        if let Some(value) = value {
            if !saved_windows::is_id(value) {
                return None;
            }
            params.push(format!("{name}={value}"));
        }
    }
    Some(if params.is_empty() { "index.html".into() } else { format!("index.html?{}", params.join("&")) })
}

/// Opens an extra window with `view` under the lowest free label.
pub fn open(app: &AppHandle, view: Option<&str>) -> Result<(), String> {
    let url = window_url(view, None).ok_or_else(|| format!("not a view id: {view:?}"))?;
    build(app, None, url)
}

/// Opens the extra windows saved at the last run, each under its own label and with what it showed. Runs in the async
/// runtime, because windows are not built on the main thread.
///
/// The saved list goes into the registry before the first window is built, so a report from one restored window or
/// a closed one does not save a list without the others still loading; opening is held for the whole restore, so a
/// "New window" meanwhile cannot take a saved label. A window that cannot be built stays in the list: the failure
/// may be the app quitting in the middle of the restore, and the file's entries are already checked by `parse`.
pub fn restore(app: &AppHandle) {
    let Some(path) = saved_path(app) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let windows = app.state::<Windows>();
        let _one_at_a_time = lock(&windows.opening);
        let saved = saved_windows::load(&path, is_extra);
        windows.with(|r| r.restoring(&saved));
        for w in saved {
            let url = window_url(Some(w.shown.view()), Some(w.shown.session_layout()));
            let opened = url.ok_or_else(|| "not an id".to_string()).and_then(|url| build_while_opening(&app, Some(w.label.clone()), url));
            if let Err(err) = opened {
                eprintln!("[desktop] reopening {}: {err}", w.label);
            }
        }
    });
}

/// Builds an extra window from the main window's configuration (size, minimum size, transparency, theme), hidden
/// until its page has loaded, with the same background effect and reveal as the main window (ADR-11): its effect
/// entry exists before the window, the effect is applied on the main thread and a fallback timer shows it if the page
/// never loads.
///
/// Must not run on the main thread: on Windows building a window there deadlocks (Tauri docs), so the tray and the
/// restore call it from the async runtime and the UI through an async command.
fn build(app: &AppHandle, label: Option<String>, url: String) -> Result<(), String> {
    let windows = app.state::<Windows>();
    let _one_at_a_time = lock(&windows.opening);
    build_while_opening(app, label, url)
}

/// `build` for a caller that holds `Windows::opening`.
fn build_while_opening(app: &AppHandle, label: Option<String>, url: String) -> Result<(), String> {
    let config = app.config().app.windows.iter().find(|w| w.label == MAIN).ok_or("missing window main from tauri.conf.json")?;
    let window = {
        let taken = || app.webview_windows().keys().cloned().collect::<Vec<_>>();
        let label = match label {
            Some(label) if taken().contains(&label) => return Err(format!("{label} is already open")),
            Some(label) => label,
            None => next_label(taken().iter().map(String::as_str)),
        };
        app.state::<WindowEffects>().register(&label);
        let mut window_config = config.clone();
        window_config.label = label.clone();
        window_config.url = WebviewUrl::App(url.into());
        let built = WebviewWindowBuilder::from_config(app, &window_config).and_then(|builder| builder.build());
        built.inspect_err(|_| app.state::<WindowEffects>().forget(&label)).map_err(|e| e.to_string())?
    };
    let label = window.label().to_string();
    let effects_app = app.clone();
    app.run_on_main_thread(move || effects_app.state::<WindowEffects>().apply(&window))
        .map_err(|e| format!("applying the effect of {label}: {e}"))
}

/// A window reports what it shows; an extra window's change is saved for the next start.
pub fn shows(app: &AppHandle, label: &str, shown: Shown) {
    app.state::<Windows>().with(|r| {
        r.shows(label, shown);
        if is_extra(label) {
            persist(app, &r.saved());
        }
    });
}

/// The user closed an extra window (not the app quitting, which closes windows without asking): the next start does
/// not open it.
pub fn closed_by_user(app: &AppHandle, label: &str) {
    app.state::<Windows>().with(|r| {
        r.closed_by_user(label);
        persist(app, &r.saved());
    });
}

fn saved_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(saved_windows::FILE))
}

/// Called with the registry locked, so two threads never write the file at once and the last write is the newest list.
fn persist(app: &AppHandle, saved: &[SavedWindow]) {
    let written = saved_path(app)
        .ok_or_else(|| std::io::Error::other("no configuration directory"))
        .and_then(|path| saved_windows::save(&path, saved));
    if let Err(err) = written {
        eprintln!("[desktop] saving the open windows: {err}");
    }
}

/// A window is gone: it no longer gets sessions, and the position and size of an extra window are saved now, not
/// only when the shell exits, so a reopened window finds them after a crash too.
pub fn closed(app: &AppHandle, label: &str) {
    app.state::<Windows>().with(|r| r.closed(label));
    app.state::<WindowEffects>().forget(label);
    // Labels are reused: a new window with this label must not take a jump meant for the closed one.
    app.state::<PendingJump>().forget(label);
    if let Err(err) = app.save_window_state(STATE_FLAGS) {
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

/// Shows a window unless its page is still loading: the page then shows it itself (ADR-11), and showing it earlier
/// would flash the opaque background. For a link or a second start, which can come before the page has loaded.
pub fn show_once_loaded(app: &AppHandle, label: &str) {
    if !app.state::<WindowEffects>().reveal_pending(label) {
        show(app, label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions() -> Shown {
        Shown::new("sessions", "auto").expect("valid ids")
    }

    fn home() -> Shown {
        Shown::new("home", "1").expect("valid ids")
    }

    #[test]
    fn only_extra_windows_are_saved_for_the_next_start_with_what_they_show() {
        let mut r = Registry::default();
        r.shows("main", sessions());
        r.shows("window-3", home());
        r.shows("window-2", home());
        r.shows("window-2", sessions());
        assert_eq!(
            r.saved(),
            [SavedWindow { label: "window-2".into(), shown: sessions() }, SavedWindow { label: "window-3".into(), shown: home() }]
        );
    }

    #[test]
    fn a_restored_window_reporting_first_keeps_the_others_still_opening_in_the_list() {
        let mut r = Registry::default();
        r.restoring(&[
            SavedWindow { label: "window-2".into(), shown: home() },
            SavedWindow { label: "window-3".into(), shown: sessions() },
        ]);
        r.shows("window-2", sessions());
        assert_eq!(
            r.saved(),
            [SavedWindow { label: "window-2".into(), shown: sessions() }, SavedWindow { label: "window-3".into(), shown: sessions() }]
        );
    }

    #[test]
    fn a_window_the_user_closed_is_not_reopened_but_one_closed_by_quitting_is() {
        let mut r = Registry::default();
        r.shows("window-2", home());
        r.shows("window-3", sessions());
        r.closed_by_user("window-2");
        r.closed("window-2");
        r.closed("window-3");
        assert_eq!(r.saved(), [SavedWindow { label: "window-3".into(), shown: sessions() }]);
    }

    #[test]
    fn an_extra_window_label_is_the_prefix_and_a_number_from_two() {
        assert!(is_extra("window-2"));
        assert!(is_extra("window-12"));
        assert!(!is_extra("main"));
        assert!(!is_extra("window-1"));
        assert!(!is_extra("window-x"));
        assert!(!is_extra("window-02"));
        assert!(!is_extra("window-+2"));
    }

    #[test]
    fn a_new_window_takes_the_lowest_free_number() {
        assert_eq!(next_label(["main"]), "window-2");
        assert_eq!(next_label(["main", "window-2", "window-3"]), "window-4");
        assert_eq!(next_label(["main", "window-3"]), "window-2");
    }

    #[test]
    fn a_view_id_becomes_the_view_parameter_of_the_page() {
        assert_eq!(window_url(Some("sessions"), None).as_deref(), Some("index.html?view=sessions"));
        assert_eq!(window_url(Some("sessions"), Some("auto")).as_deref(), Some("index.html?view=sessions&sessionLayout=auto"));
    }

    #[test]
    fn a_window_without_a_view_opens_the_first_view_of_the_ui() {
        assert_eq!(window_url(None, None).as_deref(), Some("index.html"));
    }

    #[test]
    fn anything_but_a_lowercase_word_or_number_is_not_a_view_id() {
        assert_eq!(window_url(Some(""), None), None);
        assert_eq!(window_url(Some("home&token=x"), None), None);
        assert_eq!(window_url(Some("../index"), None), None);
        assert_eq!(window_url(Some("Sessions"), None), None);
        assert_eq!(window_url(Some(&"a".repeat(saved_windows::MAX_ID_LEN + 1)), None), None);
    }

    #[test]
    fn a_session_goes_to_the_last_focused_window_that_shows_sessions() {
        let mut r = Registry::default();
        r.shows("main", sessions());
        r.shows("window-2", sessions());
        r.focused("window-2");
        r.focused("main");
        r.focused("window-3");
        assert_eq!(r.session_window(), "main");
    }

    #[test]
    fn a_window_showing_sessions_wins_even_if_it_was_never_focused() {
        let mut r = Registry::default();
        r.focused("main");
        r.shows("window-2", sessions());
        assert_eq!(r.session_window(), "window-2");
    }

    #[test]
    fn without_sessions_on_screen_a_session_goes_to_the_last_focused_window() {
        let mut r = Registry::default();
        r.focused("window-2");
        r.focused("main");
        r.focused("window-2");
        assert_eq!(r.session_window(), "window-2");
        r.shows("window-2", sessions());
        r.shows("window-2", home());
        assert_eq!(r.session_window(), "window-2");
    }

    #[test]
    fn a_closed_window_no_longer_gets_sessions() {
        let mut r = Registry::default();
        r.focused("main");
        r.shows("window-2", sessions());
        r.focused("window-2");
        r.closed("window-2");
        assert_eq!(r.session_window(), "main");
    }

    #[test]
    fn with_no_windows_known_a_session_goes_to_the_main_window() {
        assert_eq!(Registry::default().session_window(), MAIN);
    }
}
