//! The global shortcut (ADR-50): Ctrl+Alt+J (⌃⌥J on macOS) from any app shows Trackwall and opens the next session
//! waiting for you, the same choice as Alt+J inside the window (ADR-48). Registered from Rust only: the UI gets no
//! permission of the plugin. Described in §5.4 of docs/architecture.md.

use crate::attention::{self, Focus};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Ctrl + Alt, not Ctrl + Shift: Ctrl+Shift+J opens the developer tools in Chromium browsers, which the shortcut
/// would take from them system-wide.
pub fn next_waiting() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyJ)
}

/// The shortcut is taken when another app holds it already (or the installed Trackwall, next to `tauri dev`):
/// Trackwall then works without it and says why in its log.
pub fn register(app: &AppHandle, show: fn(&AppHandle)) {
    let registered = app.global_shortcut().on_shortcut(next_waiting(), move |app, _, event| {
        if event.state == ShortcutState::Pressed {
            attention::focus(app, Focus::NextWaiting, show);
        }
    });
    if let Err(err) = registered {
        eprintln!("[desktop] registering the global shortcut {}: {err}", next_waiting());
    }
}
