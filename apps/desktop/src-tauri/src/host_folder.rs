//! The projects folder as this computer sees it (ADR-131): a daemon in a container keeps the repos in a volume, which
//! the host reaches under another path (with Rancher Desktop or Docker Desktop on WSL, `\\wsl.localhost\…\_data`). The
//! user sets that path once; the window then shows a repo of the container in Explorer or Finder itself, since the
//! daemon has no desktop to do it (ADR-120).
//!
//! The UI hands only the repo's path below the projects folder, segment by segment, and the shell joins it to the saved
//! folder, checks that it is a folder still below it, and reveals it rather than opening it: the volume belongs to the
//! container, which could swap the folder for a file, and Explorer or Finder would open or run that file.

use crate::{json_file, system_open};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const FILE: &str = "host-projects-folder.json";

#[derive(Serialize, Deserialize)]
struct Saved {
    path: PathBuf,
}

/// A folder on this computer: an absolute path, and on Windows a network path only into WSL, where container volumes
/// are; another server would get the user's Windows sign-in as soon as the folder is checked.
fn check_folder(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Enter the full path of the folder.".into());
    }
    if path.to_string_lossy().contains('"') {
        return Err("A folder path cannot contain \".".into());
    }
    check_server(path)
}

/// By the path's own prefix, as Windows reads it: `//server` and `\\/server` are network paths too.
#[cfg(windows)]
fn check_server(path: &Path) -> Result<(), String> {
    use std::path::{Component, Prefix};
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) => Ok(()),
            Prefix::UNC(server, _) if ["wsl.localhost", "wsl$"].iter().any(|w| server.eq_ignore_ascii_case(w)) => Ok(()),
            _ => Err(r"A network folder must be inside WSL (\\wsl.localhost\… or \\wsl$\…).".into()),
        },
        _ => Err("Enter the full path of the folder, with its drive.".into()),
    }
}

#[cfg(not(windows))]
fn check_server(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Names Windows turns into devices whatever their extension.
const DEVICE_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4",
    "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// One folder name of the repo's path below the projects folder: never a way up or out of it, nor a name Windows reads
/// as another one (a trailing dot or space is dropped, a device name is a device).
fn is_segment(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or_default().to_ascii_lowercase();
    !segment.is_empty()
        && !segment.ends_with(['.', ' '])
        && !segment.contains(['/', '\\', ':', '\0', '"'])
        && !DEVICE_NAMES.contains(&stem.as_str())
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

/// Shows the folder `segments` below the saved projects folder in Explorer or Finder: only a folder, and only one that
/// is still below the saved folder once links in the volume are followed.
#[tauri::command]
pub fn show_in_host_folder(app: AppHandle, segments: Vec<String>) -> Result<(), String> {
    let base = load(&app).ok_or("Set the projects folder on this computer in Settings › App first.")?;
    let folder = join(&base, &segments)?;
    let not_there = || format!("{} is not a folder below the projects folder on this computer.", folder.display());
    let real_base = base.canonicalize().map_err(|e| format!("{}: {e}", base.display()))?;
    let real = folder.canonicalize().map_err(|_| not_there())?;
    if !real.starts_with(&real_base) || !real.is_dir() {
        return Err(not_there());
    }
    system_open::reveal_folder(&folder)
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
        for bad in [
            &[][..],
            &[".."],
            &["shop", ".."],
            &["."],
            &["..."],
            &[".. "],
            &["shop."],
            &["shop "],
            &["a/b"],
            &[r"a\b"],
            &["C:"],
            &["x:stream"],
            &[""],
            &["a\"b"],
            &["nul"],
            &["CON.txt"],
            &["com1"],
        ] {
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
        assert!(check_folder(Path::new("//fileserver/share")).is_err());
        assert!(check_folder(Path::new(r"\\?\UNC\fileserver\share")).is_err());
        assert!(check_folder(Path::new(r"C:\Users\me\repos")).is_ok());
    }
}
