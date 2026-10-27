//! How many sessions and task proposals wait for you, on the app's icons (ADR-65), so the number stays in sight after
//! the taskbar flash or Dock bounce (`attention.rs`) is over: the Dock badge on macOS (`set_badge_count`), an overlay
//! with the number on every window's taskbar button on Windows (`set_overlay_icon`, which takes an image, so the digits
//! are drawn here), and a dot on the tray icon on both. The count is the one the tray tooltip gives.
//!
//! The images are drawn from a 3×5 pixel font rather than from a font file, so the shell needs no font and no image
//! library for a number up to nine and "9+".

use tauri::image::Image;
use tauri::{AppHandle, Manager};

// The overlay is drawn only on Windows and tested on every system.
/// Side of the Windows overlay in pixels; the taskbar scales it to its small icon size.
#[cfg_attr(not(windows), allow(dead_code))]
const OVERLAY_SIZE: u32 = 32;
/// The dot and the overlay are the UI's warning colour (the "waiting" badges); the digits and the ring around the dot
/// are the dark ground of the UI, so both read on a light and a dark taskbar.
const WAITING: [u8; 4] = [242, 178, 51, 255];
const DARK: [u8; 4] = [24, 24, 28, 255];
/// The ring of a template icon (macOS menu bar) is a cut-out: the system recolours a template, so only its shape counts.
const CUT_OUT: [u8; 4] = [0, 0, 0, 0];

/// Rows of a 3×5 glyph, the high three bits of each row from left to right.
#[cfg_attr(not(windows), allow(dead_code))]
fn glyph(c: char) -> Option<[u8; 5]> {
    Some(match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => return None,
    })
}

/// The text on the overlay: the number up to nine, "9+" above, nothing for zero.
#[cfg_attr(not(windows), allow(dead_code))]
fn overlay_text(count: usize) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".to_string()),
    }
}

/// RGBA pixels of a square image, drawn on in place.
struct Canvas {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

impl Canvas {
    fn set(&mut self, x: u32, y: u32, color: [u8; 4]) {
        if x < self.width && y < self.height {
            let i = ((y * self.width + x) * 4) as usize;
            self.rgba[i..i + 4].copy_from_slice(&color);
        }
    }

    fn disc(&mut self, cx: f32, cy: f32, radius: f32, color: [u8; 4]) {
        for y in 0..self.height {
            for x in 0..self.width {
                let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
                if dx * dx + dy * dy <= radius * radius {
                    self.set(x, y, color);
                }
            }
        }
    }

    /// `text` centred, each glyph pixel `scale` pixels wide, one glyph pixel between glyphs.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn text(&mut self, text: &str, scale: u32, color: [u8; 4]) {
        let glyphs: Vec<[u8; 5]> = text.chars().filter_map(glyph).collect();
        let Some(chars) = u32::try_from(glyphs.len()).ok().filter(|n| *n > 0) else { return };
        let width = (chars * 4 - 1) * scale;
        let (left, top) = ((self.width.saturating_sub(width)) / 2, (self.height.saturating_sub(5 * scale)) / 2);
        for (n, rows) in (0u32..).zip(&glyphs) {
            for (row, bits) in (0u32..).zip(rows) {
                for col in 0..3 {
                    if bits & (0b100 >> col) == 0 {
                        continue;
                    }
                    for (dx, dy) in (0..scale).flat_map(|dx| (0..scale).map(move |dy| (dx, dy))) {
                        self.set(left + (n * 4 + col) * scale + dx, top + row * scale + dy, color);
                    }
                }
            }
        }
    }
}

/// The Windows overlay for `count` waiting items: the number in a disc, or `None` for zero (no overlay).
#[cfg_attr(not(windows), allow(dead_code))]
fn overlay(count: usize) -> Option<Image<'static>> {
    let text = overlay_text(count)?;
    let size = OVERLAY_SIZE;
    let mut canvas = Canvas { rgba: vec![0; (size * size * 4) as usize], width: size, height: size };
    let middle = size as f32 / 2.0;
    canvas.disc(middle, middle, middle, DARK);
    canvas.disc(middle, middle, middle - 2.0, WAITING);
    // One digit is drawn larger than two, which have to fit the disc side by side.
    canvas.text(&text, if text.len() == 1 { 4 } else { 3 }, DARK);
    Some(Image::new_owned(canvas.rgba, size, size))
}

/// The tray icon with a dot in its lower right corner. The ring around the dot keeps it apart from the icon: dark for
/// a coloured icon, cut out for a template, which the system recolours.
fn with_dot(base: &Image<'_>, template: bool) -> Image<'static> {
    let (width, height) = (base.width(), base.height());
    let mut canvas = Canvas { rgba: base.rgba().to_vec(), width, height };
    let radius = width.min(height) as f32 * 0.22;
    let ring = (width.min(height) as f32 / 16.0).max(1.0);
    let (cx, cy) = (width as f32 - radius - ring, height as f32 - radius - ring);
    canvas.disc(cx, cy, radius + ring, if template { CUT_OUT } else { DARK });
    canvas.disc(cx, cy, radius, if template { DARK } else { WAITING });
    Image::new_owned(canvas.rgba, width, height)
}

/// The tray icon as the app built it and, drawn once, the same icon with a dot.
pub struct TrayIcons {
    plain: Image<'static>,
    with_dot: Image<'static>,
    template: bool,
}

impl TrayIcons {
    pub fn new(plain: Image<'static>, template: bool) -> TrayIcons {
        let with_dot = with_dot(&plain, template);
        TrayIcons { plain, with_dot, template }
    }

    pub fn icon(&self, dot: bool) -> Image<'static> {
        if dot {
            self.with_dot.clone()
        } else {
            self.plain.clone()
        }
    }

    /// Whether the icon is a macOS template, which the system recolours.
    pub fn template(&self) -> bool {
        self.template
    }
}

/// What the icons show now, so that each changes only when it has to.
#[derive(Default)]
pub struct Badge {
    count: Option<usize>,
    /// Windows only: the visible windows that have the overlay. Windows drops a window's taskbar button while it is
    /// hidden and makes a new one, without the overlay, when it shows, so a window that shows gets it again.
    #[cfg(windows)]
    overlaid: Vec<String>,
}

impl Badge {
    pub fn update(&mut self, app: &AppHandle, tray_id: &str, icons: &TrayIcons, count: usize) {
        let before = self.count.replace(count);
        if before.map(|b| b > 0) != Some(count > 0) {
            tray_dot(app, tray_id, icons, count > 0);
        }
        #[cfg(not(windows))]
        if before != Some(count) {
            dock_badge(app, count);
        }
        #[cfg(windows)]
        {
            let visible: Vec<String> = app
                .webview_windows()
                .into_iter()
                .filter(|(label, window)| crate::windows::is_window(label) && window.is_visible().unwrap_or(false))
                .map(|(label, _)| label)
                .collect();
            let missing = needing_overlay(before != Some(count), &self.overlaid, &visible);
            let mut overlaid = overlays(app, &missing, count);
            overlaid.extend(self.overlaid.iter().filter(|label| visible.contains(label) && !missing.contains(label)).cloned());
            self.overlaid = overlaid;
        }
    }
}

/// The visible windows whose overlay has to be set: all of them when the count changed, otherwise those that have
/// none yet (shown again, or a failed attempt).
#[cfg_attr(not(windows), allow(dead_code))]
fn needing_overlay(count_changed: bool, overlaid: &[String], visible: &[String]) -> Vec<String> {
    visible.iter().filter(|label| count_changed || !overlaid.contains(label)).cloned().collect()
}

fn tray_dot(app: &AppHandle, tray_id: &str, icons: &TrayIcons, dot: bool) {
    let Some(tray) = app.tray_by_id(tray_id) else { return };
    // Both at once: a new icon set on its own is drawn as a plain image before it is marked as a template again.
    if let Err(err) = tray.set_icon_with_as_template(Some(icons.icon(dot)), icons.template) {
        crate::report_error!("changing the tray icon: {err}");
    }
}

/// The Dock badge on macOS, one for the whole app, so it goes on any one window.
#[cfg(not(windows))]
fn dock_badge(app: &AppHandle, count: usize) {
    let Some(window) = app.get_webview_window(crate::windows::MAIN) else { return };
    if let Err(err) = window.set_badge_count((count > 0).then(|| i64::try_from(count).unwrap_or(i64::MAX))) {
        crate::report_error!("setting the Dock badge: {err}");
    }
}

/// Sets the overlay on the taskbar button of these windows on Windows; returns the labels where it was set.
#[cfg(windows)]
fn overlays(app: &AppHandle, labels: &[String], count: usize) -> Vec<String> {
    let mut set = Vec::new();
    for window in labels.iter().filter_map(|label| app.get_webview_window(label)) {
        match window.set_overlay_icon(overlay(count)) {
            Ok(()) => set.push(window.label().to_string()),
            Err(err) => crate::report_error!("setting the taskbar overlay of {}: {err}", window.label()),
        }
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(image: &Image<'_>, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width() + x) * 4) as usize;
        image.rgba()[i..i + 4].try_into().expect("four bytes")
    }

    #[test]
    fn the_overlay_shows_the_number_up_to_nine_and_nine_plus_above() {
        assert_eq!(overlay_text(0), None);
        assert_eq!(overlay_text(1).as_deref(), Some("1"));
        assert_eq!(overlay_text(9).as_deref(), Some("9"));
        assert_eq!(overlay_text(10).as_deref(), Some("9+"));
        assert_eq!(overlay_text(250).as_deref(), Some("9+"));
    }

    #[test]
    fn a_window_that_shows_again_gets_the_overlay_and_a_new_count_goes_to_every_visible_window() {
        let labels = |list: &[&str]| list.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        assert_eq!(needing_overlay(false, &labels(&["window-2"]), &labels(&["main", "window-2"])), labels(&["main"]));
        assert_eq!(needing_overlay(false, &labels(&["main"]), &labels(&["main"])), labels(&[]));
        assert_eq!(needing_overlay(true, &labels(&["main"]), &labels(&["main", "window-2"])), labels(&["main", "window-2"]));
    }

    #[test]
    fn nothing_waiting_has_no_overlay() {
        assert!(overlay(0).is_none());
    }

    #[test]
    fn the_overlay_is_a_disc_with_dark_digits_and_clear_corners() {
        let image = overlay(1).expect("an overlay");
        assert_eq!((image.width(), image.height()), (OVERLAY_SIZE, OVERLAY_SIZE));
        assert_eq!(pixel(&image, 0, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(&image, 4, 16), WAITING);
        // The middle column of "1" runs through the centre of the disc.
        assert_eq!(pixel(&image, 16, 16), DARK);
    }

    #[test]
    fn every_character_of_the_overlay_has_a_glyph() {
        for count in 1..=12 {
            let text = overlay_text(count).expect("text");
            assert!(text.chars().all(|c| glyph(c).is_some()), "{text}");
        }
    }

    #[test]
    fn the_dot_goes_in_the_lower_right_corner_and_leaves_the_rest_of_the_icon() {
        let base = Image::new_owned(vec![9; 32 * 32 * 4], 32, 32);
        let dotted = with_dot(&base, false);
        assert_eq!(pixel(&dotted, 2, 2), [9, 9, 9, 9]);
        assert_eq!(pixel(&dotted, 25, 25), WAITING);
        let template = with_dot(&base, true);
        assert_eq!(pixel(&template, 25, 25), DARK);
        assert_eq!(pixel(&template, 22, 14), CUT_OUT);
    }
}
