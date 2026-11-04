//! Files dropped on a window whose daemon runs on another computer (ADR-196): the page sends their bytes to the daemon,
//! which keeps them in the projects folder, because a path of this computer means nothing in a container. The page
//! never gets file system access of its own: `read_dropped_file` reads only a file the user has just dropped on that
//! same window, each path once, and only a file, not a folder, of at most `MAX_DROP_BYTES`.

use crate::lock::lock;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::{Manager, Window};

/// The same number as `MAX_DROP_BYTES` in `@trackwall/protocol`: the file is read whole into memory before it is sent.
const MAX_DROP_BYTES: u64 = 256 * 1024 * 1024;

/// The paths of each window's last drop, by window label, not read yet.
#[derive(Default)]
pub struct DroppedFiles(Mutex<HashMap<String, Vec<PathBuf>>>);

impl DroppedFiles {
    /// A new drop on `window` replaces the paths of the one before, read or not.
    pub fn dropped(&self, window: &str, paths: &[PathBuf]) {
        lock(&self.0).insert(window.to_owned(), paths.to_vec());
    }

    /// Takes `path` from the window's last drop: true once for each dropped path, false for any other.
    fn take(&self, window: &str, path: &Path) -> bool {
        let mut drops = lock(&self.0);
        let Some(paths) = drops.get_mut(window) else { return false };
        let Some(index) = paths.iter().position(|dropped| dropped == path) else { return false };
        paths.swap_remove(index);
        true
    }
}

/// Why a dropped path cannot be sent, from what it is; `None` for a file that can.
fn refusal(path: &Path, metadata: &std::fs::Metadata) -> Option<String> {
    if !metadata.is_file() {
        return Some(format!("{} is not a file; only files can be dropped on a terminal in a container", path.display()));
    }
    if metadata.len() > MAX_DROP_BYTES {
        return Some(format!(
            "{} is larger than {} MB; copy it into the container with docker cp instead",
            path.display(),
            MAX_DROP_BYTES / 1024 / 1024
        ));
    }
    None
}

/// The bytes of a file the user has just dropped on this window, as a binary answer rather than a JSON array.
#[tauri::command]
pub async fn read_dropped_file(window: Window, path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    if !window.state::<DroppedFiles>().take(window.label(), &path) {
        return Err("only a file just dropped on this window can be read".to_owned());
    }
    // Off the async runtime: a large file takes a while to read.
    let bytes = tauri::async_runtime::spawn_blocking(move || read_file(&path)).await.map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// The whole file, once it is known to be a file within the limit.
fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if let Some(refused) = refusal(path, &metadata) {
        return Err(refused);
    }
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    // The file can grow between the check and the read.
    if bytes.len() as u64 > MAX_DROP_BYTES {
        return Err(format!("{} grew past {} MB while it was read", path.display(), MAX_DROP_BYTES / 1024 / 1024));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dropped_path_can_be_taken_once_and_only_from_its_window() {
        let drops = DroppedFiles::default();
        let file = PathBuf::from("dropped.log");
        drops.dropped("main", std::slice::from_ref(&file));
        assert!(!drops.take("window-2", &file));
        assert!(!drops.take("main", Path::new("other.log")));
        assert!(drops.take("main", &file));
        assert!(!drops.take("main", &file));
    }

    #[test]
    fn a_new_drop_replaces_the_paths_of_the_one_before() {
        let drops = DroppedFiles::default();
        drops.dropped("main", &[PathBuf::from("first.log")]);
        drops.dropped("main", &[PathBuf::from("second.log")]);
        assert!(!drops.take("main", Path::new("first.log")));
        assert!(drops.take("main", Path::new("second.log")));
    }

    #[test]
    fn a_folder_or_a_file_over_the_limit_is_refused() {
        let dir = std::env::temp_dir().join(format!("trackwall-drop-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create the test folder");
        let file = dir.join("small.txt");
        std::fs::write(&file, b"hello").expect("write the test file");
        assert!(refusal(&dir, &std::fs::metadata(&dir).expect("folder metadata")).is_some_and(|r| r.contains("not a file")));
        assert_eq!(refusal(&file, &std::fs::metadata(&file).expect("file metadata")), None);
        let large = std::fs::File::create(dir.join("large.bin")).expect("create the large file");
        large.set_len(MAX_DROP_BYTES + 1).expect("grow the large file");
        let large_meta = std::fs::metadata(dir.join("large.bin")).expect("large file metadata");
        assert!(refusal(&dir.join("large.bin"), &large_meta).is_some_and(|r| r.contains("docker cp")));
        drop(large);
        std::fs::remove_dir_all(&dir).expect("remove the test folder");
    }
}
