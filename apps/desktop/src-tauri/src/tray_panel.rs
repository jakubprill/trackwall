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

/// What releasing the left button on the icon does with the panel.
#[derive(Debug, PartialEq, Eq)]
pub enum Release {
    Show,
    Hide,
    Nothing,
}

/// `closing_press`: the press found the panel open or just hidden (taking the focus from the panel hides it before
/// the release, however long the press). `recently_hidden` also covers the second release of a double click on
/// Windows, which comes without a press of its own after the double click has hidden the panel.
pub fn release_action(visible: bool, closing_press: bool, recently_hidden: bool) -> Release {
    if visible {
        Release::Hide
    } else if closing_press || recently_hidden {
        Release::Nothing
    } else {
        Release::Show
    }
}

fn is_visible(panel: &WebviewWindow) -> bool {
    panel.is_visible().unwrap_or(false)
}

/// Left button pressed on the tray icon.
pub fn press(app: &AppHandle) {
    let state = app.state::<PanelState>();
    let open = app.get_webview_window(LABEL).is_some_and(|p| is_visible(&p));
    state.closing_press.store(open || state.recently_hidden(), Ordering::SeqCst);
}

/// Left button released on the tray icon: shows the panel next to the icon, or closes it when it was open.
pub fn release(app: &AppHandle, icon: Rect) {
    let Some(panel) = app.get_webview_window(LABEL) else { return };
    let state = app.state::<PanelState>();
    let closing_press = state.closing_press.swap(false, Ordering::SeqCst);
    match release_action(is_visible(&panel), closing_press, state.recently_hidden()) {
        Release::Hide => hide(app),
        Release::Nothing => {}
        Release::Show => {
            if let Err(err) = place(&panel, icon) {
                eprintln!("[desktop] placing the tray panel: {err}");
            }
            let _ = panel.show();
            let _ = panel.set_focus();
        }
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

impl Area {
    fn in_points(self, scale: f64) -> Area {
        Area { x: self.x / scale, y: self.y / scale, width: self.width / scale, height: self.height / scale }
    }

    fn holds(self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// A display as macOS reports it: bounds and work area in physical pixels of its own scale factor.
#[derive(Debug, Clone, Copy)]
pub struct Screen {
    pub bounds: Area,
    pub work: Area,
    pub scale: f64,
}

/// The display with the tray icon on macOS, where the icon comes in physical pixels of its own display's scale. Read
/// in a display's scale, the icon can fall inside more than one display (a point on the right of a Retina screen, read
/// at 2x, lands on the left half of it); the icon's height in points is the menu bar's height only in the right scale,
/// so among the displays that hold it the one whose menu bar (bounds minus work area) matches the icon wins.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn screen_for_icon(icon: Area, screens: &[Screen]) -> Option<usize> {
    let mismatch = |s: &Screen| {
        let icon = icon.in_points(s.scale);
        let menu_bar = (s.work.y - s.bounds.y) / s.scale;
        s.bounds.in_points(s.scale).holds(icon.x, icon.y).then_some((icon.height - menu_bar).abs())
    };
    screens.iter().enumerate().filter_map(|(i, s)| mismatch(s).map(|m| (i, m))).min_by(|a, b| a.1.total_cmp(&b.1)).map(|(i, _)| i)
}

/// macOS lays displays out in points and reports each one in physical pixels of its own scale factor, which do not add
/// up across a Retina and a standard display, so the panel is placed in points.
#[cfg(target_os = "macos")]
fn place(panel: &WebviewWindow, icon: Rect) -> tauri::Result<()> {
    let (at, size) = (icon.position.to_physical::<f64>(1.0), icon.size.to_physical::<f64>(1.0));
    let icon = Area { x: at.x, y: at.y, width: size.width, height: size.height };
    let area = |x: i32, y: i32, width: u32, height: u32| Area {
        x: f64::from(x),
        y: f64::from(y),
        width: f64::from(width),
        height: f64::from(height),
    };
    let screens: Vec<Screen> = panel
        .available_monitors()?
        .iter()
        .map(|m| {
            let work = m.work_area();
            Screen {
                bounds: area(m.position().x, m.position().y, m.size().width, m.size().height),
                work: area(work.position.x, work.position.y, work.size.width, work.size.height),
                scale: m.scale_factor(),
            }
        })
        .collect();
    let Some(screen) = screen_for_icon(icon, &screens).and_then(|i| screens.get(i)) else {
        eprintln!("[desktop] no display holds the tray icon at {icon:?}");
        return Ok(());
    };
    let outer = panel.outer_size()?.to_logical::<f64>(panel.scale_factor()?);
    let (x, y) = panel_position(icon.in_points(screen.scale), (outer.width, outer.height), screen.work.in_points(screen.scale), GAP);
    panel.set_position(tauri::LogicalPosition::new(x, y))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANEL: (f64, f64) = (340.0, 420.0);
    const SCREEN: Area = Area { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 };

    #[test]
    fn a_click_opens_the_closed_panel_and_closes_the_open_one() {
        assert_eq!(release_action(false, false, false), Release::Show);
        assert_eq!(release_action(true, true, false), Release::Hide);
    }

    #[test]
    fn a_press_that_took_the_focus_from_the_open_panel_does_not_reopen_it_however_long_it_lasts() {
        // The press found the panel open; losing the focus hid it before the release, maybe long ago.
        assert_eq!(release_action(false, true, false), Release::Nothing);
    }

    #[test]
    fn the_second_release_of_a_double_click_does_not_reopen_the_panel() {
        // The double click hid the panel; its second release has no press of its own.
        assert_eq!(release_action(false, false, true), Release::Nothing);
    }

    const RETINA: Screen = Screen {
        bounds: Area { x: 0.0, y: 0.0, width: 3024.0, height: 1964.0 },
        work: Area { x: 0.0, y: 48.0, width: 3024.0, height: 1916.0 },
        scale: 2.0,
    };
    const EXTERNAL: Screen = Screen {
        bounds: Area { x: 1512.0, y: 0.0, width: 1920.0, height: 1080.0 },
        work: Area { x: 1512.0, y: 24.0, width: 1920.0, height: 1056.0 },
        scale: 1.0,
    };

    #[test]
    fn an_icon_on_a_standard_display_next_to_a_retina_one_is_on_the_standard_one() {
        // 2000 px at 1x is 2000 pt on the external display; read at 2x it would be 1000 pt on the Retina one.
        let icon = Area { x: 2000.0, y: 0.0, width: 30.0, height: 24.0 };
        assert_eq!(screen_for_icon(icon, &[RETINA, EXTERNAL]), Some(1));
    }

    #[test]
    fn an_icon_on_a_retina_display_next_to_a_standard_one_is_on_the_retina_one() {
        let icon = Area { x: 2600.0, y: 0.0, width: 60.0, height: 48.0 };
        assert_eq!(screen_for_icon(icon, &[RETINA, EXTERNAL]), Some(0));
        assert_eq!(screen_for_icon(Area { x: 9000.0, ..icon }, &[RETINA, EXTERNAL]), None);
    }

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
