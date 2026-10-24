//! Jumps to a repo, session, task or task proposal in the window: from the tray (ADR-26, ADR-39) and from a
//! `trackwall://` link (ADR-52). The shell keeps the last requested jump and signals the UI, and the UI takes it with
//! the `take_jump` command, both on the signal and when it starts. A link that started the app arrives before the
//! page listens for events, so a jump sent only as an event payload would be lost.
//!
//! A jump to a session, task or proposal goes to the window for sessions (ADR-49: the last focused one showing
//! Sessions), a jump to a repo to the main window. Only that window takes it. A jump only switches the view: nothing
//! here starts, stops or changes anything (§8, ADR-52).

use crate::lock::lock;
use crate::window_effect::WindowEffects;
use crate::windows::{self, Windows};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Signal for the UI that a jump is waiting (`use-jump-request.ts` has the same name).
const JUMP_EVENT: &str = "jump-requested";

/// What to show; for the UI `{"kind":"repo"|"session"|"task"|"proposal","id":...}` (`Jump` in `use-jump-request.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Jump {
    Repo(String),
    Session(String),
    Task(String),
    Proposal(String),
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
}

/// Shows the target's window and asks its UI to switch to the target. A window whose page is still loading is not
/// shown yet: its page shows it once loaded (ADR-11) and takes the jump when it starts.
pub fn request(app: &AppHandle, target: Jump) {
    let label = match target {
        Jump::Repo(_) => windows::MAIN.to_owned(),
        Jump::Session(_) | Jump::Task(_) | Jump::Proposal(_) => app.state::<Windows>().session_window(),
    };
    if !app.state::<WindowEffects>().reveal_pending(&label) {
        windows::show(app, &label);
    }
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
    fn the_ui_gets_the_kind_and_the_id() {
        assert_eq!(serde_json::to_string(&Jump::Proposal("abc".into())).unwrap(), r#"{"kind":"proposal","id":"abc"}"#);
        assert_eq!(serde_json::to_string(&Jump::Repo("orders".into())).unwrap(), r#"{"kind":"repo","id":"orders"}"#);
    }
}
