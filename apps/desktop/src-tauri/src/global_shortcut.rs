//! The global shortcut (ADR-50): Win+Alt+J on Windows, ⌃⌥J on macOS, from any app shows Trackwall and opens the next
//! session waiting for you, the same choice as Alt+J inside the window (ADR-48). Registered from Rust only: the UI gets
//! no permission of the plugin. Described in §5.4 of docs/architecture.md.

use crate::jump::{self, Jump};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Not Ctrl + Alt on Windows: that is AltGr, and a system-wide AltGr+J would stop a layout that types a character with
/// it from typing it in any app (ADR-48 keeps AltGr a key). Win + Alt is free of characters and, as far as we know, of
/// Windows shortcuts with J. On macOS Control + Option types no character, while ⌥⌘J opens a browser's console.
pub fn next_waiting() -> Shortcut {
    let modifiers = if cfg!(target_os = "macos") { Modifiers::CONTROL | Modifiers::ALT } else { Modifiers::SUPER | Modifiers::ALT };
    Shortcut::new(Some(modifiers), Code::KeyJ)
}

/// The shortcut is taken when another app holds it already (or the installed Trackwall, next to `tauri dev`):
/// Trackwall then works without it and says why in its log.
pub fn register(app: &AppHandle) {
    let registered = app.global_shortcut().on_shortcut(next_waiting(), |app, _, event| {
        if event.state == ShortcutState::Pressed {
            jump::request(app, Jump::NextWaiting);
        }
    });
    if let Err(err) = registered {
        eprintln!("[desktop] registering the global shortcut {}: {err}", next_waiting());
    }
}
