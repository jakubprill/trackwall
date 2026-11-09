//! The theme of the shell's windows (ADR-235): dark, light, or the system's. The UI owns the choice (`theme.ts`, in the
//! page's storage, which every window shares) and sends it with `set_theme` at start and on every change; the shell
//! keeps the last one in `theme.json` only so that a window gets its native theme (title bar, Mica, vibrancy, the web
//! view's `prefers-color-scheme`) before its page loads. With the system's theme the windows follow the system, and the
//! web view tells the page when it changes.

use crate::json_file;
use crate::lock::lock;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, Theme};

/// File name in the shell's configuration directory.
const FILE: &str = "theme.json";

/// The choice in Settings (`ThemeChoice` in the UI's `theme.ts`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeChoice {
    /// The default, as before there was a choice.
    #[default]
    Dark,
    Light,
    System,
}

impl ThemeChoice {
    /// The theme a window is given; `None` follows the system.
    pub fn native(self) -> Option<Theme> {
        match self {
            ThemeChoice::Dark => Some(Theme::Dark),
            ThemeChoice::Light => Some(Theme::Light),
            ThemeChoice::System => None,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Saved {
    theme: ThemeChoice,
}

/// The choice from the file's text; a missing or damaged file, or a value this shell does not know, is dark.
fn parse(text: &str) -> ThemeChoice {
    serde_json::from_str::<Saved>(text).map(|saved| saved.theme).unwrap_or_default()
}

/// The last choice the UI sent, and the file it is kept in.
#[derive(Default)]
pub struct Themes {
    choice: Mutex<ThemeChoice>,
    file: OnceLock<PathBuf>,
}

impl Themes {
    /// Reads the last choice and gives it to the windows that exist at start (the main window and the tray panel).
    pub fn load(app: &AppHandle) {
        let themes = app.state::<Themes>();
        let Some(path) = json_file::config_file(app, FILE) else { return };
        let choice = json_file::load(&path, parse);
        *lock(&themes.choice) = choice;
        let _ = themes.file.set(path);
        give_to_windows(app, choice);
    }

    /// The theme a new window is built with.
    pub fn native(app: &AppHandle) -> Option<Theme> {
        lock(&app.state::<Themes>().choice).native()
    }
}

fn give_to_windows(app: &AppHandle, choice: ThemeChoice) {
    for (label, window) in app.webview_windows() {
        if let Err(err) = window.set_theme(choice.native()) {
            crate::report_error!("giving {label} the theme: {err}");
        }
    }
}

/// Gives every window the choice and keeps it for the next start; an unchanged choice (each window sends it when its page
/// starts) changes nothing.
#[tauri::command]
pub fn set_theme(app: AppHandle, choice: ThemeChoice) -> Result<(), String> {
    let themes = app.state::<Themes>();
    let mut current = lock(&themes.choice);
    if *current == choice {
        return Ok(());
    }
    *current = choice;
    give_to_windows(&app, choice);
    let path = themes.file.get().ok_or("the system gives the app no configuration directory to save the theme in")?;
    json_file::save(path, &Saved { theme: choice }).map_err(|e| format!("saving the theme: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_choice_is_read_back() {
        assert_eq!(parse(r#"{"theme":"system"}"#), ThemeChoice::System);
        assert_eq!(parse(r#"{"theme":"light"}"#), ThemeChoice::Light);
    }

    #[test]
    fn a_missing_damaged_or_unknown_file_is_dark() {
        assert_eq!(parse(""), ThemeChoice::Dark);
        assert_eq!(parse("{"), ThemeChoice::Dark);
        assert_eq!(parse(r#"{"theme":"sepia"}"#), ThemeChoice::Dark);
    }

    #[test]
    fn the_system_choice_leaves_the_window_to_the_system() {
        assert_eq!(ThemeChoice::Dark.native(), Some(Theme::Dark));
        assert_eq!(ThemeChoice::Light.native(), Some(Theme::Light));
        assert_eq!(ThemeChoice::System.native(), None);
    }

    #[test]
    fn the_choice_has_the_ui_s_names() {
        assert_eq!(serde_json::to_string(&ThemeChoice::System).expect("serialized"), r#""system""#);
    }
}
