//! The extra windows that are open, saved so that the next start of the app opens them again (ADR-49): each with its
//! label, so `tauri-plugin-window-state` puts it back on its monitor, and with what it shows, so it comes back with the
//! same view and session layout. The file is the shell's own (`windows.json` next to the window state), outside the
//! daemon's state directory, because only the shell has windows.

use serde::{Deserialize, Serialize};

/// File name in the shell's configuration directory.
pub const FILE: &str = "windows.json";
/// More extra windows than anyone opens; a longer list in the file is cut, so a damaged file cannot open hundreds.
const MAX_WINDOWS: usize = 16;

/// What a window shows: its view and the layout of its Sessions view. Both are ids from the UI (`home`, `auto`…), a
/// short lowercase word or number, and only such a word reaches a window's address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "RawShown")]
pub struct Shown {
    view: String,
    session_layout: String,
}

/// `Shown` as it is in the file, before its ids are checked.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawShown {
    view: String,
    session_layout: String,
}

impl TryFrom<RawShown> for Shown {
    type Error = String;

    fn try_from(raw: RawShown) -> Result<Shown, String> {
        Shown::new(&raw.view, &raw.session_layout).ok_or_else(|| "not a view or session layout id".into())
    }
}

/// An extra window to open at start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedWindow {
    pub label: String,
    pub shown: Shown,
}

pub(crate) const MAX_ID_LEN: usize = 32;

/// Whether a value from the UI or the file is an id that may go into a window's address.
pub fn is_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_LEN && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

impl Shown {
    /// `None` when the view or the layout is not an id.
    pub fn new(view: &str, session_layout: &str) -> Option<Shown> {
        (is_id(view) && is_id(session_layout)).then(|| Shown { view: view.into(), session_layout: session_layout.into() })
    }

    pub fn view(&self) -> &str {
        &self.view
    }

    pub fn session_layout(&self) -> &str {
        &self.session_layout
    }
}

/// The windows from the file's text: each entry on its own, so one with an id that is not valid or a label that does
/// not pass `is_label` is dropped, a repeated label counts once and the list is cut at `MAX_WINDOWS`; a file that is
/// not a JSON list gives no windows rather than an error at start.
pub fn parse(text: &str, is_label: impl Fn(&str) -> bool) -> Vec<SavedWindow> {
    let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(text) else { return Vec::new() };
    let mut valid: Vec<SavedWindow> = Vec::new();
    for w in entries.into_iter().filter_map(|entry| serde_json::from_value::<SavedWindow>(entry).ok()) {
        if is_label(&w.label) && !valid.iter().any(|v| v.label == w.label) && valid.len() < MAX_WINDOWS {
            valid.push(w);
        }
    }
    valid
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_file;

    fn extra(label: &str) -> bool {
        label.starts_with("window-")
    }

    fn saved(label: &str, view: &str, layout: &str) -> SavedWindow {
        SavedWindow { label: label.into(), shown: Shown::new(view, layout).expect("valid ids") }
    }

    #[test]
    fn a_saved_list_reads_back_the_same() {
        let dir = std::env::temp_dir().join(format!("trackwall-saved-windows-{}", std::process::id()));
        let path = dir.join(FILE);
        let windows = vec![saved("window-2", "sessions", "auto"), saved("window-3", "home", "1")];
        json_file::save(&path, &windows).expect("save");
        assert_eq!(json_file::load(&path, |text| parse(text, extra)), windows);
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn a_missing_or_damaged_file_opens_no_windows() {
        let missing = std::env::temp_dir().join("trackwall-no-such-dir").join(FILE);
        assert_eq!(json_file::load(&missing, |text| parse(text, extra)), vec![]);
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
    fn a_repeated_label_keeps_its_first_entry() {
        let text = serde_json::to_string(&[saved("window-2", "repos", "1"), saved("window-2", "home", "1")]).expect("json");
        assert_eq!(parse(&text, extra), vec![saved("window-2", "repos", "1")]);
    }

    #[test]
    fn a_damaged_file_cannot_open_more_than_the_limit_of_windows() {
        let many: Vec<SavedWindow> = (2..40).map(|n| saved(&format!("window-{n}"), "home", "1")).collect();
        let text = serde_json::to_string(&many).expect("json");
        assert_eq!(parse(&text, extra).len(), MAX_WINDOWS);
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
