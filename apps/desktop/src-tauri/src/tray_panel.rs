//! The tray panel (ADR-50): a small window next to the tray icon with the sessions waiting for you and the task
//! proposals, opened by a left click on the icon. Its page is the UI with `#tray-panel` (`views/tray-panel` in
//! `packages/ui`), which reads the daemon like the main window; clicking an entry hides the panel and opens the entry
//! in the main window (`open_from_tray_panel` in `main.rs`). The panel hides when it loses the focus. It is created on
//! the first click and kept hidden after, so that later clicks show it without loading the page again.
//! Described in §5.4 of docs/architecture.md.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, PhysicalPosition, Rect, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

/// Window label; `capabilities/default.json` lists it next to `main`.
pub const LABEL: &str = "tray-panel";
/// The fragment `packages/ui/src/main.tsx` renders the panel for (`TRAY_PANEL_HASH`).
const PAGE: &str = "index.html#tray-panel";
const WIDTH: f64 = 340.0;
const HEIGHT: f64 = 420.0;
/// Space between the icon and the panel, in physical pixels.
const GAP: f64 = 8.0;
/// A click on the icon while the panel is open first takes the focus from the panel, which hides it; that same click
/// must not open the panel again.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct PanelState {
    hidden_at: Mutex<Option<Instant>>,
    building: AtomicBool,
}

/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where the panel's top left corner goes: centred on the icon, above it when the icon is in the lower half of the
/// work area (the Windows taskbar at the bottom), below it otherwise (the macOS menu bar), and always inside the work
/// area, so that a taskbar on the side or an icon in a corner does not push the panel off the screen.
pub fn panel_position(icon: Area, panel: (f64, f64), work: Area) -> (f64, f64) {
    let (width, height) = panel;
    let x = icon.x + icon.width / 2.0 - width / 2.0;
    let below = icon.y + icon.height / 2.0 < work.y + work.height / 2.0;
    let y = if below { icon.y + icon.height + GAP } else { icon.y - height - GAP };
    // `min` then `max` instead of `clamp`, which panics when the panel is larger than the work area.
    (x.min(work.x + work.width - width).max(work.x), y.min(work.y + work.height - height).max(work.y))
}

/// Left click on the tray icon: shows the panel next to the icon, or hides it when it is open.
pub fn toggle(app: &AppHandle, icon: Rect) {
    let state = app.state::<PanelState>();
    if let Some(panel) = app.get_webview_window(LABEL) {
        if panel.is_visible().unwrap_or(false) {
            hide(app);
        } else if !state.hidden_at.lock().is_ok_and(|at| at.is_some_and(|at| at.elapsed() < REOPEN_GUARD)) {
            show_at(&panel, icon);
        }
        return;
    }
    if state.building.swap(true, Ordering::SeqCst) {
        return;
    }
    // Building a window on the main thread from an event handler can deadlock on Windows (wry#583).
    let app = app.clone();
    std::thread::spawn(move || {
        match build(&app) {
            Ok(panel) => show_at(&panel, icon),
            Err(err) => eprintln!("[desktop] opening the tray panel: {err}"),
        }
        app.state::<PanelState>().building.store(false, Ordering::SeqCst);
    });
}

pub fn hide(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(LABEL) {
        let _ = panel.hide();
    }
}

/// Window events of the panel: losing the focus hides it.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != LABEL {
        return;
    }
    if let WindowEvent::Focused(false) = event {
        if let Ok(mut at) = window.state::<PanelState>().hidden_at.lock() {
            *at = Some(Instant::now());
        }
        let _ = window.hide();
    }
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
        .title("Trackwall")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .theme(Some(Theme::Dark))
        .visible(false)
        .build()
}

fn show_at(panel: &WebviewWindow, icon: Rect) {
    if let Err(err) = place(panel, icon) {
        eprintln!("[desktop] placing the tray panel: {err}");
    }
    let _ = panel.show();
    let _ = panel.set_focus();
}

fn place(panel: &WebviewWindow, icon: Rect) -> tauri::Result<()> {
    // The tray reports the icon in physical pixels already (as the positioner plugin also assumes).
    let (at, size) = (icon.position.to_physical::<f64>(1.0), icon.size.to_physical::<f64>(1.0));
    let Some(monitor) = panel.monitor_from_point(at.x, at.y)?.or(panel.primary_monitor()?) else { return Ok(()) };
    let work = monitor.work_area();
    let outer = panel.outer_size()?;
    let (x, y) = panel_position(
        Area { x: at.x, y: at.y, width: size.width, height: size.height },
        (f64::from(outer.width), f64::from(outer.height)),
        Area {
            x: f64::from(work.position.x),
            y: f64::from(work.position.y),
            width: f64::from(work.size.width),
            height: f64::from(work.size.height),
        },
    );
    panel.set_position(PhysicalPosition::new(x, y))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANEL: (f64, f64) = (340.0, 420.0);
    const SCREEN: Area = Area { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 };

    #[test]
    fn above_an_icon_in_the_taskbar_at_the_bottom() {
        let icon = Area { x: 1700.0, y: 1044.0, width: 24.0, height: 32.0 };
        assert_eq!(panel_position(icon, PANEL, SCREEN), (1542.0, 616.0));
    }

    #[test]
    fn below_an_icon_in_the_menu_bar_at_the_top() {
        let work = Area { x: 0.0, y: 25.0, width: 1512.0, height: 957.0 };
        let icon = Area { x: 1300.0, y: 0.0, width: 30.0, height: 24.0 };
        assert_eq!(panel_position(icon, PANEL, work), (1145.0, 32.0));
    }

    #[test]
    fn stays_on_the_screen_next_to_an_icon_in_the_corner() {
        let icon = Area { x: 1900.0, y: 1044.0, width: 20.0, height: 32.0 };
        assert_eq!(panel_position(icon, PANEL, SCREEN), (1580.0, 616.0));
    }

    #[test]
    fn stays_on_a_second_monitor_left_of_the_main_one() {
        let work = Area { x: -2560.0, y: 0.0, width: 2560.0, height: 1400.0 };
        let icon = Area { x: -2560.0, y: 1404.0, width: 24.0, height: 32.0 };
        assert_eq!(panel_position(icon, PANEL, work), (-2560.0, 976.0));
    }

    #[test]
    fn a_panel_larger_than_the_work_area_starts_at_its_corner() {
        let work = Area { x: 0.0, y: 0.0, width: 300.0, height: 300.0 };
        let icon = Area { x: 280.0, y: 290.0, width: 20.0, height: 20.0 };
        assert_eq!(panel_position(icon, PANEL, work), (0.0, 0.0));
    }
}
