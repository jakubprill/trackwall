//! Files dropped on a window whose daemon runs on another computer (ADR-196): the page sends their bytes to the daemon,
//! which keeps them in the projects folder, because a path of this computer means nothing in a container. The page
//! never gets file system access of its own: `read_dropped_file` works only with a remote daemon, and reads only a file
//! the user dropped on that same window in the last `KEEP`, each path once, and only a file, not a folder, of at most
//! `MAX_DROP_BYTES`.

use crate::daemon_state::DaemonState;
use crate::lock::lock;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Response;
use tauri::{Manager, Window};

/// The same number as `MAX_DROP_BYTES` in `@trackwall/protocol`: the file is read whole into memory before it is sent.
const MAX_DROP_BYTES: u64 = 256 * 1024 * 1024;
/// How long a dropped path stays readable: the page reads the files one after another, each after the one before is sent.
const KEEP: Duration = Duration::from_secs(10 * 60);
/// More paths than this waiting in one window are a mistake; the oldest go first.
const MAX_WAITING: usize = 1000;

/// The dropped paths of each window, by window label, not read yet, with when they were dropped.
#[derive(Default)]
pub struct DroppedFiles(Mutex<HashMap<String, Vec<(PathBuf, Instant)>>>);

impl DroppedFiles {
    /// Adds a drop's paths to the window's; a drop during a slow send of the one before must not cut that one short.
    pub fn dropped(&self, window: &str, paths: &[PathBuf]) {
        self.dropped_at(window, paths, Instant::now());
    }

    fn dropped_at(&self, window: &str, paths: &[PathBuf], now: Instant) {
        let mut drops = lock(&self.0);
        let waiting = drops.entry(window.to_owned()).or_default();
        waiting.retain(|(_, at)| now.duration_since(*at) < KEEP);
        waiting.extend(paths.iter().map(|path| (path.clone(), now)));
        let over = waiting.len().saturating_sub(MAX_WAITING);
        waiting.drain(..over);
    }

    /// Takes `path` from the window's dropped paths: true once for each path dropped within `KEEP`, false for any other.
    fn take(&self, window: &str, path: &Path, now: Instant) -> bool {
        let mut drops = lock(&self.0);
        let Some(waiting) = drops.get_mut(window) else { return false };
        waiting.retain(|(_, at)| now.duration_since(*at) < KEEP);
        let Some(index) = waiting.iter().position(|(dropped, _)| dropped == path) else { return false };
        waiting.remove(index);
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
    // With the app's own daemon the page pastes the path itself and never needs a file's bytes.
    if window.state::<Arc<DaemonState>>().remote().is_none() {
        return Err("dropped files are read only for a daemon in a container".to_owned());
    }
    let path = PathBuf::from(path);
    if !window.state::<DroppedFiles>().take(window.label(), &path, Instant::now()) {
        return Err("only a file dropped on this window in the last 10 minutes can be read, once".to_owned());
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
        let now = Instant::now();
        let file = PathBuf::from("dropped.log");
        drops.dropped_at("main", std::slice::from_ref(&file), now);
        assert!(!drops.take("window-2", &file, now));
        assert!(!drops.take("main", Path::new("other.log"), now));
        assert!(drops.take("main", &file, now));
        assert!(!drops.take("main", &file, now));
    }

    #[test]
    fn a_new_drop_keeps_the_paths_of_the_one_before_until_they_expire() {
        let drops = DroppedFiles::default();
        let start = Instant::now();
        drops.dropped_at("main", &[PathBuf::from("first.log")], start);
        drops.dropped_at("main", &[PathBuf::from("second.log")], start + Duration::from_secs(1));
        assert!(drops.take("main", Path::new("first.log"), start + Duration::from_secs(2)));
        assert!(!drops.take("main", Path::new("second.log"), start + KEEP + Duration::from_secs(1)));
    }

    #[test]
    fn a_folder_or_a_file_over_the_limit_is_refused() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!("trackwall-drop-test-{}-{nanos}", std::process::id()));
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
