//! The extra windows that are open, saved so that the next start of the app opens them again (ADR-49): each with its
//! label, so `tauri-plugin-window-state` puts it back on its monitor, and with what it shows, so it comes back with the
//! same view and session layout. The file is the shell's own (`windows.json` next to the window state), outside the
//! daemon's state directory, because only the shell has windows.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// File name in the shell's configuration directory.
pub const FILE: &str = "windows.json";
/// More extra windows than anyone opens; a longer list in the file is cut, so a damaged file cannot open hundreds.
const MAX_WINDOWS: usize = 16;

/// What a window shows: its view and the layout of its Sessions view. Both are ids from the UI (`home`, `auto`…), a
/// short lowercase word or number, and only such a word reaches a window's address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    pub view: String,
    pub session_layout: String,
}

/// An extra window to open at start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedWindow {
    pub label: String,
    pub shown: Shown,
}

const MAX_ID_LEN: usize = 32;

/// Whether a value from the UI or the file is an id that may go into a window's address.
pub fn is_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_LEN && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

impl Shown {
    /// `None` when the view or the layout is not an id.
    pub fn new(view: &str, session_layout: &str) -> Option<Shown> {
        (is_id(view) && is_id(session_layout)).then(|| Shown { view: view.into(), session_layout: session_layout.into() })
    }
}

/// The windows from the file's text, keeping only entries whose label passes `is_label` and whose ids are valid;
/// anything else in the file, or a file that is not JSON, gives no windows rather than an error at start.
pub fn parse(text: &str, is_label: impl Fn(&str) -> bool) -> Vec<SavedWindow> {
    let Ok(windows) = serde_json::from_str::<Vec<SavedWindow>>(text) else { return Vec::new() };
    let mut valid: Vec<SavedWindow> = Vec::new();
    for w in windows {
        let ok = is_label(&w.label) && Shown::new(&w.shown.view, &w.shown.session_layout).is_some();
        if ok && !valid.iter().any(|v| v.label == w.label) && valid.len() < MAX_WINDOWS {
            valid.push(w);
        }
    }
    valid
}

pub fn load(path: &Path, is_label: impl Fn(&str) -> bool) -> Vec<SavedWindow> {
    std::fs::read_to_string(path).map(|text| parse(&text, is_label)).unwrap_or_default()
}

/// Writes the list through a temporary file and a rename, so a crash in the middle leaves the old list, not half of
/// the new one.
pub fn save(path: &Path, windows: &[SavedWindow]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(windows).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extra(label: &str) -> bool {
        label.starts_with("window-")
    }

    fn saved(label: &str, view: &str, layout: &str) -> SavedWindow {
        SavedWindow { label: label.into(), shown: Shown { view: view.into(), session_layout: layout.into() } }
    }

    #[test]
    fn a_saved_list_reads_back_the_same() {
        let dir = std::env::temp_dir().join(format!("trackwall-saved-windows-{}", std::process::id()));
        let path = dir.join(FILE);
        let windows = vec![saved("window-2", "sessions", "auto"), saved("window-3", "home", "1")];
        save(&path, &windows).expect("save");
        assert_eq!(load(&path, extra), windows);
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn a_missing_or_damaged_file_opens_no_windows() {
        assert_eq!(load(Path::new("/nonexistent/trackwall/windows.json"), extra), vec![]);
        assert_eq!(parse("{not json", extra), vec![]);
        assert_eq!(parse(r#"{"label":"window-2"}"#, extra), vec![]);
    }

    #[test]
    fn entries_with_a_foreign_label_or_a_view_that_is_not_an_id_are_dropped() {
        let text = r#"[
            {"label":"main","shown":{"view":"home","sessionLayout":"1"}},
            {"label":"window-2","shown":{"view":"home&x=1","sessionLayout":"1"}},
            {"label":"window-3","shown":{"view":"repos","sessionLayout":"Auto"}},
            {"label":"window-4","shown":{"view":"sessions","sessionLayout":"4"}}
        ]"#;
        assert_eq!(parse(text, extra), vec![saved("window-4", "sessions", "4")]);
    }

    #[test]
    fn a_label_appears_once_and_the_list_is_cut_at_the_limit() {
        let many: Vec<SavedWindow> = (2..40).map(|n| saved(&format!("window-{n}"), "home", "1")).collect();
        let mut text_windows = vec![saved("window-2", "repos", "1")];
        text_windows.extend(many);
        let text = serde_json::to_string(&text_windows).expect("json");
        let parsed = parse(&text, extra);
        assert_eq!(parsed.len(), MAX_WINDOWS);
        assert_eq!(parsed[0], saved("window-2", "repos", "1"));
        assert_eq!(parsed.iter().filter(|w| w.label == "window-2").count(), 1);
    }

    #[test]
    fn an_id_is_a_short_lowercase_word_or_number() {
        assert!(is_id("sessions"));
        assert!(is_id("4"));
        assert!(!is_id(""));
        assert!(!is_id("Home"));
        assert!(!is_id("a/b"));
        assert!(!is_id(&"a".repeat(MAX_ID_LEN + 1)));
    }
}
