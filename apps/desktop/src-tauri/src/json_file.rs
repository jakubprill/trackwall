//! The shell's own small files in its configuration directory, next to the window state of `tauri-plugin-window-state`:
//! the JSON files `windows.json` and `zoom.json`, and the restart marker of `autostart.rs`.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The path of the shell's file `name`; `None` when the system gives no configuration directory.
pub fn config_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(name))
}

/// The file's contents read with `parse`; a missing or unreadable file reads as empty text, so a first start or a
/// damaged file gives the parser's empty result rather than an error at start.
pub fn load<T>(path: &Path, parse: impl FnOnce(&str) -> T) -> T {
    parse(&std::fs::read_to_string(path).unwrap_or_default())
}

/// Writes `value` through a temporary file and a rename, so a crash in the middle leaves the old file, not half of
/// the new one.
pub fn save(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}
