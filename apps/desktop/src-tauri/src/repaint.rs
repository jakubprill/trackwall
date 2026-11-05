//! Showing a window, and on Windows a one-pixel resize and back when it comes out of hiding (ADR-11).
//!
//! The windows start hidden and transparent, with Mica or Acrylic behind the page. After such a window was shown, its
//! backdrop looked washed over, as if everything were selected, and the page did not repaint ("Connecting to the
//! daemon…" stayed after the UI had connected), until the user resized or clicked the window. The likely cause is that
//! WebView2 and the compositor keep the frame composed while the window was hidden; a change of size makes them compose
//! afresh, as the user's own resize did. The second step returns the size the window had, so nothing the user sees or
//! `tauri-plugin-window-state` saves changes.
//!
//! A maximized or full-screen window would leave that state if its size changed, so there only the page's web view is
//! resized, inside the window: the window keeps its size and state, and WebView2 still composes afresh.

use std::time::Duration;
use tauri::{PhysicalSize, Webview, WebviewWindow};

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

/// What gets the one-pixel resize when the window is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Nudge {
    /// The window, as the user's own resize did.
    Window,
    /// Only the page's web view, because resizing the window would take it out of maximized or full screen.
    WebView,
}

/// Only a window that was hidden has a stale frame.
fn nudge_for(before: StateBeforeShow) -> Option<Nudge> {
    if before.visible {
        None
    } else if before.maximized || before.fullscreen {
        Some(Nudge::WebView)
    } else {
        Some(Nudge::Window)
    }
}

/// The size the window or the web view holds for `NUDGE_HOLD`: one pixel wider.
fn wider(size: PhysicalSize<u32>) -> PhysicalSize<u32> {
    PhysicalSize::new(size.width + 1, size.height)
}

/// Brings the window to the screen; the state is read before `show`, which makes the window visible.
pub fn show(window: &WebviewWindow) {
    // Only Windows has the stale frame; elsewhere the state is not even read.
    let before = if cfg!(windows) { state_before_show(window) } else { None };
    let _ = window.unminimize();
    let _ = window.show();
    if let Some(nudge) = before.and_then(nudge_for) {
        apply(window, nudge);
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

/// On its own thread, because `show` can run on the main thread, which must not sleep. Window and web view calls go
/// to the main thread in order, so the resize comes after the window is visible.
fn apply(window: &WebviewWindow, nudge: Nudge) {
    let window = window.clone();
    std::thread::spawn(move || {
        let resized = match nudge {
            Nudge::Window => window.inner_size().and_then(|size| resize_and_back(size, |size| window.set_size(size), || Ok(size))),
            // Back to the window's size at that moment, not the one before: a window the user restores or takes out of
            // full screen during the hold has already fitted its web view, and the old size would clip the page.
            Nudge::WebView => {
                let webview: &Webview = window.as_ref();
                webview.size().and_then(|size| resize_and_back(size, |size| webview.set_size(size), || window.inner_size()))
            }
        };
        if let Err(err) = resized {
            crate::report_error!("repainting the window after show ({nudge:?}): {err}");
        }
    });
}

/// One pixel wider than `size` for `NUDGE_HOLD`, then `size_after`.
fn resize_and_back(
    size: PhysicalSize<u32>,
    set_size: impl Fn(PhysicalSize<u32>) -> tauri::Result<()>,
    size_after: impl FnOnce() -> tauri::Result<PhysicalSize<u32>>,
) -> tauri::Result<()> {
    set_size(wider(size))?;
    std::thread::sleep(NUDGE_HOLD);
    set_size(size_after()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HIDDEN: StateBeforeShow = StateBeforeShow { visible: false, maximized: false, fullscreen: false };

    #[test]
    fn a_hidden_window_is_resized_when_shown() {
        assert_eq!(nudge_for(HIDDEN), Some(Nudge::Window));
    }

    #[test]
    fn a_window_already_on_screen_is_not_resized() {
        assert_eq!(nudge_for(StateBeforeShow { visible: true, ..HIDDEN }), None);
        assert_eq!(nudge_for(StateBeforeShow { visible: true, maximized: true, ..HIDDEN }), None);
    }

    #[test]
    fn a_hidden_maximized_or_full_screen_window_gets_only_its_web_view_resized() {
        assert_eq!(nudge_for(StateBeforeShow { maximized: true, ..HIDDEN }), Some(Nudge::WebView));
        assert_eq!(nudge_for(StateBeforeShow { fullscreen: true, ..HIDDEN }), Some(Nudge::WebView));
    }

    #[test]
    fn the_nudge_holds_one_pixel_more_width() {
        assert_eq!(wider(PhysicalSize::new(1200, 800)), PhysicalSize::new(1201, 800));
    }
}
