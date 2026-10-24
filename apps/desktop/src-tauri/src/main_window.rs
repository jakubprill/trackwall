//! The main window: showing it, and showing it with a session, a task proposal or the next waiting session that the
//! UI switches to (`focus-session`). The tray menu, system notifications, the global shortcut and the tray panel all
//! lead here (ADR-26, ADR-39, ADR-50).

use crate::window_effect;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Window label from `tauri.conf.json`.
pub const LABEL: &str = "main";
/// Event for the UI with what to show (`Focus`; same name and shape in `use-session-focus.ts`).
const FOCUS_EVENT: &str = "focus-session";

/// What to show; for the UI `{"kind":"session"|"proposal","id":...}` or `{"kind":"next-waiting"}`, where the UI picks
/// the session after the selected one like Alt+J (ADR-48).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "kebab-case")]
pub enum Focus {
    Session(String),
    Proposal(String),
    NextWaiting,
}

pub fn show(app: &AppHandle) {
    // A window shown from the tray before its page has loaded does not pop up again after the load.
    if let Some(applied) = app.try_state::<window_effect::AppliedEffect>() {
        applied.mark_revealed();
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Shows the window and asks the UI to switch to the target.
pub fn focus(app: &AppHandle, target: Focus) {
    show(app);
    let _ = app.emit_to(LABEL, FOCUS_EVENT, target);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_reaches_the_ui_in_the_shape_of_use_session_focus() {
        assert_eq!(serde_json::to_string(&Focus::Proposal("abc".into())).unwrap(), r#"{"kind":"proposal","id":"abc"}"#);
        assert_eq!(serde_json::to_string(&Focus::NextWaiting).unwrap(), r#"{"kind":"next-waiting"}"#);
        assert_eq!(serde_json::from_str::<Focus>(r#"{"kind":"session","id":"s"}"#).unwrap(), Focus::Session("s".into()));
    }
}
