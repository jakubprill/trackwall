//! Jumps to a repo, session, task or task proposal in the window: from the tray, a system notification or the tray
//! panel (ADR-26, ADR-39, ADR-50) and from a `trackwall://` link (ADR-52), and to the next session waiting for you
//! from the global shortcut (ADR-50). The shell keeps the last requested jump and signals the UI, and the UI takes it with
//! the `take_jump` command, both on the signal and when it starts. A link that started the app arrives before the
//! page listens for events, so a jump sent only as an event payload would be lost.
//!
//! A jump to a session, task or proposal goes to the window for sessions (ADR-49: the last focused one showing
//! Sessions), a jump to a repo to the main window. Only that window takes it. A jump only switches the view: nothing
//! here starts, stops or changes anything (§8, ADR-52).

use crate::lock::lock;
use crate::windows::{self, Windows};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Signal for the UI that a jump is waiting (`use-jump-request.ts` has the same name).
const JUMP_EVENT: &str = "jump-requested";

/// What to show; for the UI `{"kind":"repo"|"session"|"task"|"proposal","id":...}` or `{"kind":"next-waiting"}`, for
/// which the UI picks the session after the selected one like Alt+J (ADR-48) (`Jump` in `use-jump-request.ts`).
/// Deserialized from the tray panel's command (`open_from_tray_panel`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Jump {
    Repo(String),
    Session(String),
    Task(String),
    Proposal(String),
    #[serde(rename = "next-waiting")]
    NextWaiting,
}

/// The jump the UI has not taken yet, with the label of the window that is to take it. A newer jump replaces an older
/// one: the user wants to see the last thing clicked.
#[derive(Default)]
pub struct PendingJump(Mutex<Option<(String, Jump)>>);

impl PendingJump {
    fn put(&self, window: &str, jump: Jump) {
        *lock(&self.0) = Some((window.to_owned(), jump));
    }

    fn take(&self, window: &str) -> Option<Jump> {
        let mut pending = lock(&self.0);
        if pending.as_ref().is_some_and(|(label, _)| label == window) {
            return pending.take().map(|(_, jump)| jump);
        }
        None
    }

    /// Drops a jump meant for a window that has closed.
    pub fn forget(&self, window: &str) {
        let mut pending = lock(&self.0);
        if pending.as_ref().is_some_and(|(label, _)| label == window) {
            *pending = None;
        }
    }
}

/// Shows the target's window and asks its UI to switch to the target. A window whose page is still loading is not
/// shown yet: its page shows it once loaded (ADR-11) and takes the jump when it starts.
pub fn request(app: &AppHandle, target: Jump) {
    let label = match target {
        Jump::Repo(_) => windows::MAIN.to_owned(),
        Jump::Session(_) | Jump::Task(_) | Jump::Proposal(_) | Jump::NextWaiting => app.state::<Windows>().session_window(),
    };
    windows::show_once_loaded(app, &label);
    app.state::<PendingJump>().put(&label, target);
    let _ = app.emit_to(label.as_str(), JUMP_EVENT, ());
}

/// The jump waiting for the calling window, at most once.
#[tauri::command]
pub fn take_jump(window: WebviewWindow, pending: tauri::State<'_, PendingJump>) -> Option<Jump> {
    pending.take(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jump_is_taken_once_and_a_newer_one_replaces_an_older_one() {
        let pending = PendingJump::default();
        pending.put("main", Jump::Session("a".into()));
        pending.put("main", Jump::Repo("orders".into()));
        assert_eq!(pending.take("main"), Some(Jump::Repo("orders".into())));
        assert_eq!(pending.take("main"), None);
    }

    #[test]
    fn only_the_target_window_takes_the_jump() {
        let pending = PendingJump::default();
        pending.put("window-2", Jump::Session("a".into()));
        assert_eq!(pending.take("main"), None);
        assert_eq!(pending.take("window-2"), Some(Jump::Session("a".into())));
    }

    #[test]
    fn a_jump_for_a_closed_window_is_dropped_and_others_are_kept() {
        let pending = PendingJump::default();
        pending.put("window-2", Jump::Session("a".into()));
        pending.forget("window-3");
        pending.forget("window-2");
        assert_eq!(pending.take("window-2"), None);
    }

    #[test]
    fn the_ui_gets_the_kind_and_the_id() {
        assert_eq!(serde_json::to_string(&Jump::Proposal("abc".into())).unwrap(), r#"{"kind":"proposal","id":"abc"}"#);
        assert_eq!(serde_json::to_string(&Jump::Repo("orders".into())).unwrap(), r#"{"kind":"repo","id":"orders"}"#);
        assert_eq!(serde_json::to_string(&Jump::NextWaiting).unwrap(), r#"{"kind":"next-waiting"}"#);
        assert_eq!(serde_json::from_str::<Jump>(r#"{"kind":"session","id":"s"}"#).unwrap(), Jump::Session("s".into()));
    }
}
