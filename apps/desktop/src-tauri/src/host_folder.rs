//! The projects folder as this computer sees it (ADR-131): a daemon in a container keeps the repos in a volume, which
//! the host reaches under another path (with Rancher Desktop or Docker Desktop on WSL, `\\wsl.localhost\…\_data`). The
//! user sets that path once; the window then shows a repo of the container in Explorer or Finder itself, since the
//! daemon has no desktop to do it (ADR-120).
//!
//! The UI hands only the repo's path below the projects folder, segment by segment, and the shell joins it to the saved
//! folder and opens it only if it is a folder there: a file handed to Explorer would be opened or run.

use crate::json_file;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::AppHandle;

const FILE: &str = "host-projects-folder.json";

#[derive(Serialize, Deserialize)]
struct Saved {
    path: PathBuf,
}

/// A folder on this computer: an absolute path, and on Windows a network path only into WSL, where container volumes
/// are; another server would get the user's Windows sign-in when Explorer opens it.
fn check_folder(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Enter the full path of the folder.".into());
    }
    let text = path.to_string_lossy();
    if text.contains('"') {
        return Err("A folder path cannot contain \".".into());
    }
    if let Some(rest) = text.strip_prefix(r"\\") {
        let server = rest.split(['\\', '/']).next().unwrap_or_default().to_ascii_lowercase();
        if server != "wsl.localhost" && server != "wsl$" {
            return Err(r"A network folder must be inside WSL (\\wsl.localhost\… or \\wsl$\…).".into());
        }
    }
    Ok(())
}

/// One folder name of the repo's path below the projects folder: never a way up or out of it.
fn is_segment(segment: &str) -> bool {
    !segment.is_empty() && segment != "." && segment != ".." && !segment.contains(['/', '\\', ':', '\0', '"'])
}

fn join(base: &Path, segments: &[String]) -> Result<PathBuf, String> {
    if segments.is_empty() || !segments.iter().all(|s| is_segment(s)) {
        return Err("not a folder below the projects folder".into());
    }
    Ok(segments.iter().fold(base.to_path_buf(), |path, segment| path.join(segment)))
}

fn load(app: &AppHandle) -> Option<PathBuf> {
    let path = json_file::config_file(app, FILE)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Saved>(&text).ok().map(|saved| saved.path).filter(|path| check_folder(path).is_ok())
}

/// The saved folder, or `None` when the user has not set one.
#[tauri::command]
pub fn host_projects_folder(app: AppHandle) -> Option<String> {
    load(&app).map(|path| path.to_string_lossy().into_owned())
}

/// Saves the folder (`None` forgets it); it has to exist now, so a typo shows at once rather than at the first click.
#[tauri::command]
pub fn set_host_projects_folder(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let file = json_file::config_file(&app, FILE).ok_or("the system gives the app no configuration directory")?;
    let Some(path) = path.map(|p| PathBuf::from(p.trim())) else {
        return match std::fs::remove_file(&file) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {err}", file.display())),
            _ => Ok(()),
        };
    };
    check_folder(&path)?;
    if !path.is_dir() {
        return Err(format!("{} is not a folder this computer can open.", path.display()));
    }
    json_file::save(&file, &Saved { path }).map_err(|e| format!("{}: {e}", file.display()))
}

/// Shows the folder `segments` below the saved projects folder in Explorer, Finder or the Linux file manager.
#[tauri::command]
pub fn show_in_host_folder(app: AppHandle, segments: Vec<String>) -> Result<(), String> {
    let base = load(&app).ok_or("Set the projects folder on this computer in Settings › App first.")?;
    let folder = join(&base, &segments)?;
    if !folder.is_dir() {
        return Err(format!("{} is not a folder on this computer.", folder.display()));
    }
    let mut cmd = command(&folder);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().map(drop).map_err(|e| format!("could not open the folder: {e}"))
}

/// Explorer splits its command line at commas, so the path goes in quotes, as it is (the daemon's `folderCommand`).
#[cfg(windows)]
fn command(folder: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("explorer.exe");
    cmd.raw_arg(format!("\"{}\"", folder.display()));
    cmd
}

#[cfg(not(windows))]
fn command(folder: &Path) -> Command {
    let mut cmd = Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" });
    cmd.arg(folder);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segments(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn a_repo_lies_below_the_saved_folder() {
        let base = std::env::temp_dir().join("projects");
        assert_eq!(join(&base, &segments(&["shop", "orders-api"])).unwrap(), base.join("shop").join("orders-api"));
    }

    #[test]
    fn no_segment_leads_up_or_out_of_the_saved_folder() {
        let base = std::env::temp_dir().join("projects");
        for bad in [&[][..], &[".."], &["shop", ".."], &["."], &["a/b"], &[r"a\b"], &["C:"], &[""], &["a\"b"]] {
            assert!(join(&base, &segments(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_folder_must_be_a_full_path_without_quotes() {
        assert!(check_folder(Path::new("projects")).is_err());
        assert!(check_folder(&std::env::temp_dir()).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn a_network_folder_must_be_inside_wsl() {
        assert!(check_folder(Path::new(r"\\wsl.localhost\rancher-desktop\var\lib\docker\volumes\repos\_data")).is_ok());
        assert!(check_folder(Path::new(r"\\wsl$\docker-desktop-data\data\docker\volumes\repos\_data")).is_ok());
        assert!(check_folder(Path::new(r"\\fileserver\share")).is_err());
    }
}
