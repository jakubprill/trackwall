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
    write(path, value, false)
}

/// Like `save`, for a file with a secret: on macOS and Linux only its owner can read it, like the daemon's `daemon.json`;
/// on Windows the profile folder is already the user's own.
pub fn save_private(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    write(path, value, true)
}

fn write(path: &Path, value: &impl Serialize, private: bool) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    std::io::Write::write_all(&mut options.open(&tmp)?, text.as_bytes())?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_private_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("trackwall-json-file-test-{}", std::process::id()));
        let path = dir.join("secret.json");

        save_private(&path, &serde_json::json!({ "token": "t" })).expect("saved");
        let mode = std::fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        let text = std::fs::read_to_string(&path).expect("read back");
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(mode, 0o600);
        assert!(text.contains(r#""token": "t""#));
    }
}
