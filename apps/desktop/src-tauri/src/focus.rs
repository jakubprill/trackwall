//! Jumps to a repo, session, task or task proposal in the window: from the tray (ADR-26, ADR-39) and from a
//! `trackwall://` link (ADR-52). The shell keeps the last requested jump and signals the UI, and the UI takes it with
//! the `take_focus` command, both on the signal and when it starts. A link that started the app arrives before the
//! page listens for events, so a jump sent only as an event payload would be lost.
//!
//! A jump only switches the view: nothing here starts, stops or changes anything (§8, ADR-52).

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Signal for the UI that a jump is waiting (`use-focus-request.ts` has the same name).
const FOCUS_EVENT: &str = "focus-requested";

/// What to show; for the UI `{"kind":"repo"|"session"|"task"|"proposal","id":...}` (`Focus` in `use-focus-request.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Focus {
    Repo(String),
    Session(String),
    Task(String),
    Proposal(String),
}

/// The jump the UI has not taken yet. A newer jump replaces an older one: the user wants to see the last thing clicked.
#[derive(Default)]
pub struct PendingFocus(Mutex<Option<Focus>>);

impl PendingFocus {
    fn put(&self, focus: Focus) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(focus);
    }

    fn take(&self) -> Option<Focus> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Shows the window and asks the UI to switch to the target.
pub fn request(app: &AppHandle, target: Focus, show: fn(&AppHandle)) {
    show(app);
    app.state::<PendingFocus>().put(target);
    let _ = app.emit_to("main", FOCUS_EVENT, ());
}

/// The waiting jump for the UI, at most once.
#[tauri::command]
pub fn take_focus(pending: tauri::State<'_, PendingFocus>) -> Option<Focus> {
    pending.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jump_is_taken_once_and_a_newer_one_replaces_an_older_one() {
        let pending = PendingFocus::default();
        pending.put(Focus::Session("a".into()));
        pending.put(Focus::Repo("orders".into()));
        assert_eq!(pending.take(), Some(Focus::Repo("orders".into())));
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn the_ui_gets_the_kind_and_the_id() {
        assert_eq!(serde_json::to_string(&Focus::Proposal("abc".into())).unwrap(), r#"{"kind":"proposal","id":"abc"}"#);
        assert_eq!(serde_json::to_string(&Focus::Repo("orders".into())).unwrap(), r#"{"kind":"repo","id":"orders"}"#);
    }
}
