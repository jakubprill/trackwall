//! The tray panel (ADR-50): a small window next to the tray icon with the sessions waiting for you and the task
//! proposals, opened by a left click on the icon. The window is `tray-panel` from `tauri.conf.json`, created hidden at
//! start, so its page (the UI with `#tray-panel`, `views/tray-panel` in `packages/ui`) is loaded before the first click.
//! Clicking an entry hides the panel and opens the entry in the main window (`open_from_tray_panel` in `main.rs`).
//! The panel hides when it loses the focus. Described in §5.4 of docs/architecture.md.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Rect, WebviewWindow, Window, WindowEvent};

/// Window label from `tauri.conf.json`; `capabilities/default.json` lists it next to `main`.
pub const LABEL: &str = "tray-panel";
/// Space between the icon and the panel.
const GAP: f64 = 8.0;
/// A press on the icon while the panel is open takes the focus from the panel, which hides it, and a double click
/// hides it too; the release that follows must not open the panel again.
const REOPEN_GUARD: Duration = Duration::from_millis(400);

#[derive(Default)]
pub struct PanelState {
    hidden_at: Mutex<Option<Instant>>,
    /// The press on the icon found the panel open (or just closed by that press): its release only closes.
    closing_press: AtomicBool,
}

impl PanelState {
    fn recently_hidden(&self) -> bool {
        self.hidden_at.lock().is_ok_and(|at| at.is_some_and(|at| at.elapsed() < REOPEN_GUARD))
    }

    fn mark_hidden(&self) {
        if let Ok(mut at) = self.hidden_at.lock() {
            *at = Some(Instant::now());
        }
    }
}

/// A rectangle, in physical pixels on Windows and in points on macOS.
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
pub fn panel_position(icon: Area, panel: (f64, f64), work: Area, gap: f64) -> (f64, f64) {
    let (width, height) = panel;
    let x = icon.x + icon.width / 2.0 - width / 2.0;
    let below = icon.y + icon.height / 2.0 < work.y + work.height / 2.0;
    let y = if below { icon.y + icon.height + gap } else { icon.y - height - gap };
    // `min` then `max` instead of `clamp`, which panics when the panel is larger than the work area.
    (x.min(work.x + work.width - width).max(work.x), y.min(work.y + work.height - height).max(work.y))
}

/// Left button pressed on the tray icon.
pub fn press(app: &AppHandle) {
    let state = app.state::<PanelState>();
    let open = app.get_webview_window(LABEL).is_some_and(|p| p.is_visible().unwrap_or(false));
    state.closing_press.store(open || state.recently_hidden(), Ordering::SeqCst);
}

/// Left button released on the tray icon: shows the panel next to the icon, or closes it when it was open.
pub fn release(app: &AppHandle, icon: Rect) {
    let Some(panel) = app.get_webview_window(LABEL) else { return };
    let state = app.state::<PanelState>();
    if panel.is_visible().unwrap_or(false) {
        hide(app);
    } else if !state.closing_press.swap(false, Ordering::SeqCst) && !state.recently_hidden() {
        if let Err(err) = place(&panel, icon) {
            eprintln!("[desktop] placing the tray panel: {err}");
        }
        let _ = panel.show();
        let _ = panel.set_focus();
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(LABEL) {
        app.state::<PanelState>().mark_hidden();
        let _ = panel.hide();
    }
}

/// Window events of the panel: losing the focus or closing (Alt+F4) hides it.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::Focused(false) => {}
        WindowEvent::CloseRequested { api, .. } => api.prevent_close(),
        _ => return,
    }
    window.state::<PanelState>().mark_hidden();
    let _ = window.hide();
}

/// Windows (and Linux) report the icon and the monitors in one physical coordinate space across monitors.
#[cfg(not(target_os = "macos"))]
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
        GAP * monitor.scale_factor(),
    );
    panel.set_position(tauri::PhysicalPosition::new(x, y))
}

/// macOS lays screens out in points, and reports the icon and each monitor in physical pixels of its own scale factor
/// (points times that factor), which do not add up across a Retina and a standard display. So the panel is placed in
/// points: the monitor is the one whose bounds in points hold the icon in that monitor's scale.
#[cfg(target_os = "macos")]
fn place(panel: &WebviewWindow, icon: Rect) -> tauri::Result<()> {
    let (at, size) = (icon.position.to_physical::<f64>(1.0), icon.size.to_physical::<f64>(1.0));
    let in_points = |x: f64, y: f64, width: f64, height: f64, scale: f64| Area {
        x: x / scale,
        y: y / scale,
        width: width / scale,
        height: height / scale,
    };
    let monitors = panel.available_monitors()?;
    let found = monitors.iter().find_map(|m| {
        let scale = m.scale_factor();
        let bounds =
            in_points(f64::from(m.position().x), f64::from(m.position().y), f64::from(m.size().width), f64::from(m.size().height), scale);
        let icon = in_points(at.x, at.y, size.width, size.height, scale);
        let inside = icon.x >= bounds.x && icon.x < bounds.x + bounds.width && icon.y >= bounds.y && icon.y < bounds.y + bounds.height;
        inside.then_some((m, icon, scale))
    });
    let Some((monitor, icon, scale)) = found else { return Ok(()) };
    let work = monitor.work_area();
    let outer = panel.outer_size()?.to_logical::<f64>(panel.scale_factor()?);
    let (x, y) = panel_position(
        icon,
        (outer.width, outer.height),
        in_points(f64::from(work.position.x), f64::from(work.position.y), f64::from(work.size.width), f64::from(work.size.height), scale),
        GAP,
    );
    panel.set_position(tauri::LogicalPosition::new(x, y))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANEL: (f64, f64) = (340.0, 420.0);
    const SCREEN: Area = Area { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 };

    #[test]
    fn above_an_icon_in_the_taskbar_at_the_bottom() {
        let icon = Area { x: 1700.0, y: 1044.0, width: 24.0, height: 32.0 };
        assert_eq!(panel_position(icon, PANEL, SCREEN, 8.0), (1542.0, 616.0));
    }

    #[test]
    fn below_an_icon_in_the_menu_bar_at_the_top() {
        let work = Area { x: 0.0, y: 25.0, width: 1512.0, height: 957.0 };
        let icon = Area { x: 1300.0, y: 0.0, width: 30.0, height: 24.0 };
        assert_eq!(panel_position(icon, PANEL, work, 8.0), (1145.0, 32.0));
    }

    #[test]
    fn stays_on_the_screen_next_to_an_icon_in_the_corner() {
        let icon = Area { x: 1900.0, y: 1044.0, width: 20.0, height: 32.0 };
        assert_eq!(panel_position(icon, PANEL, SCREEN, 8.0), (1580.0, 616.0));
    }

    #[test]
    fn stays_on_a_second_monitor_left_of_the_main_one() {
        let work = Area { x: -2560.0, y: 0.0, width: 2560.0, height: 1400.0 };
        let icon = Area { x: -2560.0, y: 1404.0, width: 24.0, height: 32.0 };
        assert_eq!(panel_position(icon, PANEL, work, 8.0), (-2560.0, 976.0));
    }

    #[test]
    fn a_panel_larger_than_the_work_area_starts_at_its_corner() {
        let work = Area { x: 0.0, y: 0.0, width: 300.0, height: 300.0 };
        let icon = Area { x: 280.0, y: 290.0, width: 20.0, height: 20.0 };
        assert_eq!(panel_position(icon, PANEL, work, 8.0), (0.0, 0.0));
    }
}
