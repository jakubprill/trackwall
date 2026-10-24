//! The system folder picker for the projects folder (ADR-51). The window asks for it through an app command, not
//! through the dialog plugin's own commands, so the capabilities still grant no system plugin to the page (§8).

use tauri::WebviewWindow;
use tauri_plugin_dialog::{DialogExt, FilePath};

/// The chosen folder as a full path, `None` when the user closed the picker. `start` is the folder the picker opens
/// in, usually the current projects folder; the daemon checks the chosen one when it is saved.
#[tauri::command]
pub async fn pick_folder(window: WebviewWindow, start: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = window.dialog().file().set_parent(&window).set_title("Choose the projects folder");
    if let Some(dir) = start.filter(|dir| !dir.is_empty()) {
        dialog = dialog.set_directory(dir);
    }
    // The blocking picker must not run on the main thread, where the event loop draws the dialog.
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder()).await.map_err(|e| e.to_string())?;
    picked.map(folder_path).transpose()
}

/// The path the daemon gets as text; a `file:` URL is a folder on disk too, anything else is not.
fn folder_path(picked: FilePath) -> Result<String, String> {
    let path = picked.into_path().map_err(|e| format!("the picker returned a location that is not a folder on disk: {e}"))?;
    path.into_os_string().into_string().map_err(|path| format!("the folder path is not valid Unicode: {}", path.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_picked_path_or_file_url_is_the_folder_path_and_another_url_is_an_error() {
        let dir = std::env::temp_dir();
        assert_eq!(folder_path(FilePath::Path(dir.clone())), Ok(dir.to_string_lossy().into_owned()));
        let url = tauri::Url::from_directory_path(&dir).expect("the temp dir is a full path");
        assert_eq!(folder_path(FilePath::Url(url)).map(PathBuf::from), Ok(dir));
        let web = tauri::Url::parse("https://example.com/projects").expect("a valid URL");
        assert!(folder_path(FilePath::Url(web)).is_err());
    }
}
