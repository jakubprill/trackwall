//! Installs an update of the portable Windows build (ADR-53, §5.4). The Tauri updater installs on Windows only through
//! an NSIS or MSI installer, and Trackwall ships a folder without one, so the shell does this step itself after the
//! updater plugin has downloaded the release zip and checked its signature.
//!
//! Windows lets a running `.exe` be renamed but not overwritten or deleted. The new files are unpacked into
//! `<app folder>/.update/new`, the current ones (the running `trackwall.exe` and `trackwall-daemon.exe` among them)
//! move to `.update/old`, and the new ones move into the app folder, all by renames inside one folder, so nothing is
//! copied over a file in use. Only the files of a Trackwall build move; anything else in the folder stays where it is.
//! A failed move puts back what has moved. The next start deletes `.update`, unless it holds the only copy of the
//! previous files because putting them back failed too.
//!
//! The module has no Windows API and its tests run on every system; only Windows uses it.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Cursor};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// Working folder of an update inside the app folder.
pub const UPDATE_DIR: &str = ".update";
const NEW_DIR: &str = "new";
const OLD_DIR: &str = "old";
/// Written after a complete swap: from then on `.update/old` holds files nobody needs.
const DONE_MARKER: &str = "done";
/// The release zip holds one folder with this name (`scripts/package-portable.ts`).
const PACKAGE_ROOT: &str = "Trackwall";
/// Without these files a folder is not a Trackwall build: neither the one that runs nor the one in the package.
const REQUIRED_FILES: [&str; 2] = ["trackwall.exe", "trackwall-daemon.exe"];
/// Entries a portable build has ever shipped (`scripts/package-portable.ts`). The swap moves out only these and the
/// entries of the new package, so a file of the user's next to `trackwall.exe` is never moved, let alone deleted.
const BUILD_ENTRIES: [&str; 4] = ["trackwall.exe", "trackwall-daemon.exe", "ui", "README.txt"];
/// The previous shell is still exiting when the new one starts and holds its exe until then.
const CLEAN_UP_ATTEMPTS: u32 = 30;
const CLEAN_UP_PAUSE: Duration = Duration::from_secs(1);

/// Installing and cleaning up both work in `.update`; one at a time.
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

/// Replaces the contents of `app_dir` with the package. The running app keeps running from the moved files.
pub fn install(app_dir: &Path, package: &[u8]) -> Result<(), String> {
    let _lock = UPDATE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    check_build(app_dir).map_err(|missing| format!("{} is not a Trackwall folder: {missing} is missing.", app_dir.display()))?;
    let update = app_dir.join(UPDATE_DIR);
    remove_finished(&update)?;
    let new = update.join(NEW_DIR);
    let staged = fs::create_dir_all(&new)
        .map_err(|e| format!("{}: {e}", new.display()))
        .and_then(|()| unpack(package, &new))
        .and_then(|()| check_build(&new).map_err(|missing| format!("The update package has no {missing}.")));
    let result = staged.map_err(SwapError::LeftAsItWas).and_then(|()| swap(app_dir, &new, &update.join(OLD_DIR)));
    match result {
        // Without the marker the next start would keep `.update`, which is safe, just untidy.
        Ok(()) => {
            let _ = File::create(update.join(DONE_MARKER));
            Ok(())
        }
        // The app folder is as it was, so nothing in `.update` is still needed.
        Err(SwapError::LeftAsItWas(err)) => {
            let _ = remove_dir_if_exists(&update);
            Err(err)
        }
        // `.update/old` holds the only copy of the previous files.
        Err(SwapError::NotRestored(err)) => Err(err),
    }
}

enum SwapError {
    LeftAsItWas(String),
    NotRestored(String),
}

/// Deletes `.update` left by the previous version, retrying while its exe is still in use. Blocks; run it in a thread.
pub fn clean_up(app_dir: &Path) {
    let update = app_dir.join(UPDATE_DIR);
    for attempt in 1..=CLEAN_UP_ATTEMPTS {
        {
            let _lock = UPDATE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match remove_finished(&update) {
                Ok(()) => return,
                Err(e) if attempt == CLEAN_UP_ATTEMPTS => {
                    eprintln!("[desktop] {e}");
                    return;
                }
                Err(_) => {}
            }
        }
        std::thread::sleep(CLEAN_UP_PAUSE);
    }
}

/// Removes `.update` unless it holds the only copy of the previous files: a swap that neither finished
/// (`done`) nor put everything back (an empty `old`).
fn remove_finished(update: &Path) -> Result<(), String> {
    let old = update.join(OLD_DIR);
    let finished = update.join(DONE_MARKER).is_file() || entries(&old).map_or(true, |names| names.is_empty());
    if !finished {
        return Err(format!(
            "A previous update could not put back the app files; they are in {}. Install the release by hand (docs/release.md).",
            old.display()
        ));
    }
    remove_dir_if_exists(update).map_err(|e| {
        format!("The files of the previous update in {} cannot be removed yet ({e}). Try again in a minute.", update.display())
    })
}

/// The app folder of the running build: the folder of the exe the process started from.
pub fn app_dir() -> Result<PathBuf, String> {
    let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
    exe.parent().map(Path::to_path_buf).ok_or_else(|| format!("{} has no parent folder", exe.display()))
}

/// The first required file missing from `dir`.
fn check_build(dir: &Path) -> Result<(), &'static str> {
    match REQUIRED_FILES.into_iter().find(|name| !dir.join(name).is_file()) {
        Some(missing) => Err(missing),
        None => Ok(()),
    }
}

fn remove_dir_if_exists(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Unpacks the contents of the package's `Trackwall` folder into `into`. Every entry must lie inside that folder.
fn unpack(package: &[u8], into: &Path) -> Result<(), String> {
    let invalid = |e: zip::result::ZipError| format!("The update package is not a valid zip: {e}");
    let mut archive = zip::ZipArchive::new(Cursor::new(package)).map_err(invalid)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(invalid)?;
        let relative = entry
            .enclosed_name()
            .filter(|_| !entry.is_symlink())
            .and_then(|path| path.strip_prefix(PACKAGE_ROOT).ok().map(Path::to_path_buf))
            // `enclosed_name` lets through a `..` that stays inside the archive, such as `Trackwall/../x`.
            .filter(|relative| relative.components().all(|c| matches!(c, Component::Normal(_))))
            .ok_or_else(|| format!("The update package has an entry outside the {PACKAGE_ROOT} folder: {}", entry.name()))?;
        let target = into.join(relative);
        let written = if entry.is_dir() {
            fs::create_dir_all(&target)
        } else {
            target.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| io::copy(&mut entry, &mut File::create(&target)?).map(drop))
        };
        written.map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(())
}

/// Moves the build's entries in `app_dir` to `old`, then everything in `new` to `app_dir`.
fn swap(app_dir: &Path, new: &Path, old: &Path) -> Result<(), SwapError> {
    let io_error = |e: io::Error| SwapError::LeftAsItWas(format!("{}: {e}", app_dir.display()));
    fs::create_dir(old).map_err(io_error)?;
    let incoming = entries(new).map_err(io_error)?;
    let current: Vec<OsString> = entries(app_dir)
        .map_err(io_error)?
        .into_iter()
        .filter(|name| BUILD_ENTRIES.iter().any(|known| name == known) || incoming.contains(name))
        .collect();
    let mut moved_out = Vec::new();
    let mut moved_in = Vec::new();
    let result = move_entries(&current, app_dir, old, &mut moved_out).and_then(|()| move_entries(&incoming, new, app_dir, &mut moved_in));
    let Err(err) = result else { return Ok(()) };
    // Back in reverse order: first the new files out of the app folder, then the current ones in.
    match move_back(&moved_in, app_dir, new).and_then(|()| move_back(&moved_out, old, app_dir)) {
        Ok(()) => Err(SwapError::LeftAsItWas(format!("The update could not replace the app files ({err}). The app was left as it was."))),
        Err(restore) => Err(SwapError::NotRestored(format!(
            "The update could not replace the app files ({err}) nor put them back ({restore}). \
             The previous files are in {}; download the release again.",
            old.display()
        ))),
    }
}

fn entries(dir: &Path) -> io::Result<Vec<OsString>> {
    fs::read_dir(dir)?.map(|entry| entry.map(|e| e.file_name())).collect()
}

/// Moves `names` from `from` to `to` and records each moved name, so that a failure can be undone.
fn move_entries(names: &[OsString], from: &Path, to: &Path, moved: &mut Vec<OsString>) -> Result<(), String> {
    for name in names {
        fs::rename(from.join(name), to.join(name)).map_err(|e| format!("{}: {e}", from.join(name).display()))?;
        moved.push(name.clone());
    }
    Ok(())
}

fn move_back(names: &[OsString], from: &Path, to: &Path) -> Result<(), String> {
    names
        .iter()
        .rev()
        .try_for_each(|name| fs::rename(from.join(name), to.join(name)).map_err(|e| format!("{}: {e}", from.join(name).display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trackwall-portable-update-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn package(files: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.add_directory("Trackwall/", options).unwrap();
        for (name, text) in files {
            zip.start_file(*name, options).unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn installed_app(name: &str) -> PathBuf {
        let app = temp_dir(name);
        write(&app.join("trackwall.exe"), "shell 1");
        write(&app.join("trackwall-daemon.exe"), "daemon 1");
        write(&app.join("ui").join("index.html"), "ui 1");
        write(&app.join("ui").join("old-asset.js"), "only in 1");
        app
    }

    const NEW_BUILD: [(&str, &str); 4] = [
        ("Trackwall/trackwall.exe", "shell 2"),
        ("Trackwall/trackwall-daemon.exe", "daemon 2"),
        ("Trackwall/ui/index.html", "ui 2"),
        ("Trackwall/README.txt", "readme 2"),
    ];

    #[test]
    fn install_replaces_the_build_in_the_app_folder_and_keeps_the_previous_files_in_update_old() {
        let app = installed_app("replace");
        install(&app, &package(&NEW_BUILD)).unwrap();
        assert_eq!(fs::read_to_string(app.join("trackwall.exe")).unwrap(), "shell 2");
        assert_eq!(fs::read_to_string(app.join("trackwall-daemon.exe")).unwrap(), "daemon 2");
        assert_eq!(fs::read_to_string(app.join("ui").join("index.html")).unwrap(), "ui 2");
        assert_eq!(fs::read_to_string(app.join("README.txt")).unwrap(), "readme 2");
        assert!(!app.join("ui").join("old-asset.js").exists(), "a file only the previous build had is gone");
        assert_eq!(fs::read_to_string(app.join(".update").join("old").join("trackwall.exe")).unwrap(), "shell 1");
        assert!(app.join(".update").join("done").is_file());
        clean_up(&app);
        assert!(!app.join(".update").exists());
        fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn install_leaves_the_users_own_files_in_the_app_folder_where_they_are() {
        let app = installed_app("own-files");
        write(&app.join("notes.txt"), "the user's file");
        install(&app, &package(&NEW_BUILD)).unwrap();
        clean_up(&app);
        assert_eq!(fs::read_to_string(app.join("notes.txt")).unwrap(), "the user's file");
        assert_eq!(fs::read_to_string(app.join("trackwall.exe")).unwrap(), "shell 2");
        fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn previous_files_that_could_not_be_put_back_survive_the_next_start_and_block_the_next_install() {
        let app = installed_app("not-restored");
        // What a swap leaves when it could neither finish nor put the files back: files in `old`, no `done`.
        write(&app.join(".update").join("old").join("trackwall.exe"), "shell 1");
        clean_up_once(&app);
        assert_eq!(fs::read_to_string(app.join(".update").join("old").join("trackwall.exe")).unwrap(), "shell 1");
        let err = install(&app, &package(&NEW_BUILD)).unwrap_err();
        assert!(err.starts_with("A previous update could not put back the app files"), "{err}");
        fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn install_leaves_the_app_untouched_when_the_package_has_no_daemon() {
        let app = installed_app("no-daemon");
        let err = install(&app, &package(&[("Trackwall/trackwall.exe", "shell 2")])).unwrap_err();
        assert_eq!(err, "The update package has no trackwall-daemon.exe.");
        assert!(!app.join(".update").exists(), "nothing of the failed update is left");
        assert_eq!(fs::read_to_string(app.join("trackwall.exe")).unwrap(), "shell 1");
        assert_eq!(fs::read_to_string(app.join("ui").join("old-asset.js")).unwrap(), "only in 1");
        fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn install_rejects_an_entry_outside_the_trackwall_folder() {
        let app = installed_app("outside");
        let mut files = NEW_BUILD.to_vec();
        files.push(("Trackwall/../escaped.txt", "x"));
        let err = install(&app, &package(&files)).unwrap_err();
        assert!(err.starts_with("The update package has an entry outside the Trackwall folder"), "{err}");
        assert!(!app.join(".update").exists(), "nothing of the failed update is left");
        assert_eq!(fs::read_to_string(app.join("trackwall.exe")).unwrap(), "shell 1");
        fs::remove_dir_all(app).unwrap();
    }

    #[test]
    fn install_refuses_a_folder_that_is_not_a_trackwall_build() {
        let dir = temp_dir("not-a-build");
        write(&dir.join("trackwall.exe"), "shell 1");
        write(&dir.join("notes.txt"), "the user's file");
        let err = install(&dir, &package(&NEW_BUILD)).unwrap_err();
        assert!(err.ends_with("is not a Trackwall folder: trackwall-daemon.exe is missing."), "{err}");
        assert_eq!(fs::read_to_string(dir.join("notes.txt")).unwrap(), "the user's file");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn install_rejects_bytes_that_are_not_a_zip() {
        let app = installed_app("not-zip");
        let err = install(&app, b"not a zip").unwrap_err();
        assert!(err.starts_with("The update package is not a valid zip"), "{err}");
        assert_eq!(fs::read_to_string(app.join("trackwall.exe")).unwrap(), "shell 1");
        fs::remove_dir_all(app).unwrap();
    }

    /// `clean_up` retries for half a minute; one attempt is enough to see what it keeps.
    fn clean_up_once(app: &Path) {
        let _ = remove_finished(&app.join(UPDATE_DIR));
    }

    #[test]
    fn a_failed_move_records_what_moved_so_that_it_can_be_put_back() {
        let app = installed_app("rollback");
        let old = temp_dir("rollback-old");
        let names = [OsString::from("trackwall.exe"), OsString::from("missing.txt"), OsString::from("trackwall-daemon.exe")];
        let mut moved = Vec::new();
        assert!(move_entries(&names, &app, &old, &mut moved).is_err());
        assert_eq!(moved, vec![OsString::from("trackwall.exe")]);
        move_back(&moved, &old, &app).unwrap();
        assert_eq!(fs::read_to_string(app.join("trackwall.exe")).unwrap(), "shell 1");
        assert_eq!(fs::read_to_string(app.join("trackwall-daemon.exe")).unwrap(), "daemon 1");
        fs::remove_dir_all(app).unwrap();
        fs::remove_dir_all(old).unwrap();
    }

    /// The release zip on Windows comes from the system `tar` (bsdtar) in `scripts/package-portable.ts`, with the same arguments.
    #[cfg(windows)]
    #[test]
    fn install_unpacks_a_zip_made_by_the_windows_tar_like_the_release() {
        let app = installed_app("system-tar");
        let stage = temp_dir("system-tar-stage");
        for (name, text) in NEW_BUILD {
            write(&stage.join(name), text);
        }
        let zip = stage.join("package.zip");
        let status =
            std::process::Command::new("tar").args(["-a", "-c", "-f"]).arg(&zip).arg("Trackwall").current_dir(&stage).status().unwrap();
        assert!(status.success());
        install(&app, &fs::read(&zip).unwrap()).unwrap();
        assert_eq!(fs::read_to_string(app.join("ui").join("index.html")).unwrap(), "ui 2");
        fs::remove_dir_all(app).unwrap();
        fs::remove_dir_all(stage).unwrap();
    }

    /// The whole update rests on this: Windows refuses to overwrite or delete the exe of a running process,
    /// but renames it. The test binary is such an exe. After the rename the process still reports its starting path,
    /// which is where the shell restarts from (`tauri::process::restart` takes the path cached at start).
    #[test]
    fn the_running_exe_can_be_renamed_and_put_back() {
        let exe = std::env::current_exe().unwrap();
        let moved = exe.with_extension("renamed-by-test");
        fs::rename(&exe, &moved).unwrap();
        fs::rename(&moved, &exe).unwrap();
        assert!(exe.is_file());
    }
}
