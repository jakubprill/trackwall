//! Showing a window, and on Windows a one-pixel resize and back when it comes out of hiding (ADR-11).
//!
//! The windows start hidden and transparent, with Mica or Acrylic behind the page. After such a window was shown, its
//! backdrop looked washed over, as if everything were selected, and the page did not repaint ("Connecting to the
//! daemon…" stayed after the UI had connected), until the user resized or clicked the window. The likely cause is that
//! WebView2 and the compositor keep the frame composed while the window was hidden; a change of size makes them compose
//! afresh, as the user's own resize did. The second step returns the size the window had, so nothing the user sees or
//! `tauri-plugin-window-state` saves changes.

use std::time::Duration;
use tauri::{PhysicalSize, WebviewWindow};

/// How long the window keeps the bigger size: a few frames, so that WebView2, which renders in another process, and
/// the compositor see the change instead of two sizes merged into none.
const NUDGE_HOLD: Duration = Duration::from_millis(100);

/// The window's state just before it is shown.
#[derive(Clone, Copy)]
struct StateBeforeShow {
    visible: bool,
    maximized: bool,
    fullscreen: bool,
}

/// Only a window that was hidden has a stale frame. A maximized or full-screen one is left alone, because a size change
/// would take it out of that state.
fn needs_nudge(before: StateBeforeShow) -> bool {
    !before.visible && !before.maximized && !before.fullscreen
}

/// The two sizes the window goes through: one pixel wider, then the size it had.
fn nudge_sizes(size: PhysicalSize<u32>) -> [PhysicalSize<u32>; 2] {
    [PhysicalSize::new(size.width + 1, size.height), size]
}

/// Brings the window to the screen; the state is read before `show`, which makes the window visible.
pub fn show(window: &WebviewWindow) {
    // Only Windows has the stale frame; elsewhere the state is not even read.
    let before = if cfg!(windows) { state_before_show(window) } else { None };
    let _ = window.unminimize();
    let _ = window.show();
    if before.is_some_and(needs_nudge) {
        nudge(window);
    }
}

/// `None` when the window cannot be asked (it is being destroyed).
fn state_before_show(window: &WebviewWindow) -> Option<StateBeforeShow> {
    Some(StateBeforeShow {
        visible: window.is_visible().ok()?,
        maximized: window.is_maximized().ok()?,
        fullscreen: window.is_fullscreen().ok()?,
    })
}

/// On its own thread, because `show` can run on the main thread, which must not sleep. Window calls go to the main
/// thread in order, so the resize comes after the window is visible.
fn nudge(window: &WebviewWindow) {
    let window = window.clone();
    std::thread::spawn(move || {
        let Ok(size) = window.inner_size() else { return };
        let [bigger, original] = nudge_sizes(size);
        let resized = window.set_size(bigger).and_then(|()| {
            std::thread::sleep(NUDGE_HOLD);
            window.set_size(original)
        });
        if let Err(err) = resized {
            eprintln!("[desktop] repainting the window after show: {err}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const HIDDEN: StateBeforeShow = StateBeforeShow { visible: false, maximized: false, fullscreen: false };

    #[test]
    fn a_hidden_window_is_nudged_when_shown() {
        assert!(needs_nudge(HIDDEN));
    }

    #[test]
    fn a_window_already_on_screen_is_not_nudged() {
        assert!(!needs_nudge(StateBeforeShow { visible: true, ..HIDDEN }));
    }

    #[test]
    fn a_maximized_or_full_screen_window_keeps_its_state() {
        assert!(!needs_nudge(StateBeforeShow { maximized: true, ..HIDDEN }));
        assert!(!needs_nudge(StateBeforeShow { fullscreen: true, ..HIDDEN }));
    }

    #[test]
    fn the_nudge_ends_at_the_size_the_window_had() {
        let size = PhysicalSize::new(1200, 800);
        assert_eq!(nudge_sizes(size), [PhysicalSize::new(1201, 800), PhysicalSize::new(1200, 800)]);
    }
}
