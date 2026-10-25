//! The zoom of each window's page (ADR-65), so the UI can be larger on a laptop screen and smaller on an ultrawide.
//! Ctrl+= / Ctrl+- / Ctrl+0 (⌘ on macOS, where the View menu has the same items) step through the levels a browser
//! uses; the UI sends the step with `zoom_window`, because a web view cannot tell its own zoom. The level is kept per
//! window label in `zoom.json` in the shell's configuration directory, so a window comes back at its zoom like at its
//! position (ADR-49), and every page load gets it again with the attribute `ZOOM_ATTRIBUTE`, which tells the page the
//! zoom where it needs it (the drop point on macOS, `file-drop.ts`). The tray panel keeps its size.

use crate::json_file;
use crate::lock::lock;
use crate::windows;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, Webview, WebviewWindow};

/// File name in the shell's configuration directory.
const FILE: &str = "zoom.json";
/// The levels of Chromium and Safari between half and double size; a window's zoom is an index into them.
const LEVELS: [f64; 11] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];
const ACTUAL_SIZE: usize = 5;
/// The attribute on the page's root element with the zoom (`ZOOM_ATTRIBUTE` in the UI's `file-drop.ts`).
const ZOOM_ATTRIBUTE: &str = "data-zoom";

/// A step from a shortcut or the menu (`ZoomStep` in the UI's `zoom-shortcut.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ZoomStep {
    In,
    Out,
    Reset,
}

/// The level after `step`: the next one up or down, staying at the ends.
fn next(level: usize, step: ZoomStep) -> usize {
    match step {
        ZoomStep::In => (level + 1).min(LEVELS.len() - 1),
        ZoomStep::Out => level.saturating_sub(1),
        ZoomStep::Reset => ACTUAL_SIZE,
    }
}

/// The index of a zoom from the file; only the levels themselves count.
fn level_of(zoom: f64) -> Option<usize> {
    LEVELS.iter().position(|level| (level - zoom).abs() < 1e-9)
}

/// The levels from the file's text: an entry whose label is not a window's or whose value is not a level is dropped,
/// and a file that is not a JSON object gives none rather than an error at start.
fn parse(text: &str) -> BTreeMap<String, usize> {
    let Ok(entries) = serde_json::from_str::<BTreeMap<String, serde_json::Value>>(text) else { return BTreeMap::new() };
    entries
        .into_iter()
        .filter(|(label, _)| windows::is_window(label))
        .filter_map(|(label, value)| Some((label, level_of(value.as_f64()?)?)))
        .filter(|(_, level)| *level != ACTUAL_SIZE)
        .collect()
}

/// The zoom of every window label that is not at actual size, and the file it is saved in. Managed from the start
/// and loaded in `setup`, because the main window's page can start loading before `setup` runs.
#[derive(Default)]
pub struct Zooms {
    levels: Mutex<BTreeMap<String, usize>>,
    file: OnceLock<PathBuf>,
    /// Held by a step from before it reads the levels until its file is written, so steps save in the order they
    /// changed the levels, while a page loading meanwhile, which takes only the levels, never waits for the disk.
    stepping: Mutex<()>,
}

impl Zooms {
    /// Reads the saved levels.
    pub fn load(app: &AppHandle) {
        let zooms = app.state::<Zooms>();
        let Some(file) = json_file::config_file(app, FILE) else { return };
        *lock(&zooms.levels) = json_file::load(&file, parse);
        let _ = zooms.file.set(file);
    }

    fn zoom_of(&self, label: &str) -> f64 {
        LEVELS[lock(&self.levels).get(label).copied().unwrap_or(ACTUAL_SIZE)]
    }
}

fn set_zoom(webview: &Webview, zoom: f64) -> Result<(), String> {
    webview.set_zoom(zoom).map_err(|err| format!("zooming {}: {err}", webview.label()))
}

/// Zooms a page and tells it its zoom; a page that did not zoom is not told it did.
fn apply(webview: &Webview, zoom: f64) -> Result<(), String> {
    set_zoom(webview, zoom)?;
    pass_to_page(webview, zoom);
    Ok(())
}

/// Gives the main window its saved zoom after `Zooms::load`: its page may have started loading before `setup`.
pub fn apply_to_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(windows::MAIN) {
        if let Err(err) = apply(main.as_ref(), app.state::<Zooms>().zoom_of(windows::MAIN)) {
            eprintln!("[desktop] {err}");
        }
    }
}

/// Tells the page its zoom, without waiting for it.
fn pass_to_page(webview: &Webview, zoom: f64) {
    let script = format!("document.documentElement.setAttribute({ZOOM_ATTRIBUTE:?}, {:?});", zoom.to_string());
    if let Err(err) = webview.eval(script) {
        eprintln!("[desktop] passing the zoom to {}: {err}", webview.label());
    }
}

/// A window's page starts loading: it gets its label's zoom before it draws, and the attribute once it has loaded.
pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if !windows::is_window(webview.label()) {
        return;
    }
    let zoom = webview.state::<Zooms>().zoom_of(webview.label());
    match payload.event() {
        // Before the page draws; the attribute waits for the page, which would drop it while it starts.
        PageLoadEvent::Started if zoom != LEVELS[ACTUAL_SIZE] => {
            if let Err(err) = set_zoom(webview, zoom) {
                eprintln!("[desktop] {err}");
            }
        }
        PageLoadEvent::Finished => pass_to_page(webview, zoom),
        PageLoadEvent::Started => {}
    }
}

/// Zooms the window with `label` one step and saves its level.
pub fn apply_step(app: &AppHandle, label: &str, step: ZoomStep) -> Result<(), String> {
    if !windows::is_window(label) {
        return Err(format!("{label} is not a window that zooms"));
    }
    let window = app.get_webview_window(label).ok_or_else(|| format!("no window {label}"))?;
    let zooms = app.state::<Zooms>();
    let _in_order = lock(&zooms.stepping);
    let mut levels = lock(&zooms.levels);
    let level = next(levels.get(label).copied().unwrap_or(ACTUAL_SIZE), step);
    // A page the web view did not zoom keeps its level, so the file and the drop point stay true to what is shown.
    apply(window.as_ref(), LEVELS[level])?;
    if level == ACTUAL_SIZE {
        levels.remove(label);
    } else {
        levels.insert(label.to_string(), level);
    }
    let saved: BTreeMap<String, f64> = levels.iter().map(|(label, level)| (label.clone(), LEVELS[*level])).collect();
    drop(levels);
    if let Some(file) = zooms.file.get() {
        if let Err(err) = json_file::save(file, &saved) {
            eprintln!("[desktop] saving the zoom: {err}");
        }
    }
    Ok(())
}

/// A zoom shortcut pressed in a window's page. Async, so the file is written off the main thread.
#[tauri::command]
pub async fn zoom_window(window: WebviewWindow, step: ZoomStep) -> Result<(), String> {
    apply_step(window.app_handle(), window.label(), step)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zoom_after(zoom: f64, step: ZoomStep) -> f64 {
        LEVELS[next(level_of(zoom).expect("a level"), step)]
    }

    #[test]
    fn zooming_in_and_out_steps_through_the_browser_levels() {
        assert_eq!(LEVELS[ACTUAL_SIZE], 1.0);
        assert_eq!(zoom_after(1.0, ZoomStep::In), 1.1);
        assert_eq!(zoom_after(1.1, ZoomStep::In), 1.25);
        assert_eq!(zoom_after(1.0, ZoomStep::Out), 0.9);
        assert_eq!(zoom_after(0.67, ZoomStep::Out), 0.5);
        assert_eq!(zoom_after(1.75, ZoomStep::Reset), 1.0);
    }

    #[test]
    fn zoom_stops_at_half_and_double_size() {
        assert_eq!(zoom_after(2.0, ZoomStep::In), 2.0);
        assert_eq!(zoom_after(0.5, ZoomStep::Out), 0.5);
    }

    #[test]
    fn a_saved_zoom_is_kept_only_for_a_window_label_and_a_known_level() {
        let text = r#"{"main": 1.25, "window-2": 0.8, "tray-panel": 1.5, "window-3": 1.3, "window-4": "big", "window-5": 1.0}"#;
        assert_eq!(parse(text), BTreeMap::from([("main".to_string(), 7), ("window-2".to_string(), 3)]));
    }

    #[test]
    fn a_missing_or_damaged_file_leaves_every_window_at_actual_size() {
        assert!(parse("").is_empty());
        assert!(parse("[1.25]").is_empty());
        assert!(json_file::load(std::path::Path::new("no-such-dir/zoom.json"), parse).is_empty());
    }

    #[test]
    fn saved_levels_read_back_the_same() {
        let dir = std::env::temp_dir().join(format!("trackwall-zoom-{}", std::process::id()));
        let path = dir.join(FILE);
        json_file::save(&path, &BTreeMap::from([("main", 1.25), ("window-2", 0.8)])).expect("save");
        assert_eq!(json_file::load(&path, parse), BTreeMap::from([("main".to_string(), 7), ("window-2".to_string(), 3)]));
        std::fs::remove_dir_all(dir).expect("cleanup");
    }
}
