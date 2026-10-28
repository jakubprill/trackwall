//! Starting Trackwall when the user signs in (ADR-65), through the `auto-launch` crate: a value in
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` on Windows (the current user only, no administrator, works for
//! the portable folder) and a LaunchAgent in `~/Library/LaunchAgents` on macOS. The system's entry is the only record
//! of the setting, so an entry turned off in Task Manager reads as off in Settings too (macOS: below). Only Settings
//! switches it, through the app commands below (§8: no MCP tool changes autostart).
//!
//! The entry starts the app with `ARG`, and such a start keeps every window hidden: the daemon, the tray and the
//! notifications are ready, and the windows come when the user opens Trackwall (`windows::restore_when_shown`).
//!
//! Not `tauri-plugin-autostart`: it builds the same crate without quotes around the Windows path, so a folder with a
//! space in it gives an ambiguous command, and on Windows it writes for all users when the app runs elevated.
//!
//! On macOS `auto-launch` reads "enabled" from the LaunchAgent file, so a Trackwall turned off under Login Items in
//! System Settings still reads as on; the file is the part Trackwall controls.

use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use std::fmt::Display;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::json_file;

/// The argument of the start entry; a start with it is a start at sign-in.
const ARG: &str = "--autostart";
/// A debug build (`tauri dev`) has its own entry, so trying the setting there does not replace the installed app's.
const DEV_APP_NAME: &str = "Trackwall-dev";
/// Left by an update before its restart (ADR-53), which repeats the arguments of the start: a shell started at sign-in
/// and updated later must come back with its windows, not hidden. It holds the time it was written, and only a marker
/// younger than `RESTART_WINDOW` counts, so one left by a restart that never came does not show the windows at the next
/// sign-in.
const RESTART_MARKER: &str = "restart-shows-windows";
const RESTART_WINDOW: Duration = Duration::from_secs(120);

fn err(e: impl Display) -> String {
    e.to_string()
}

/// Whether this start keeps the windows hidden: a start from the entry at sign-in, unless it is the restart after an
/// update. The update's marker is removed at every start.
pub fn starts_hidden(app: &AppHandle, args: impl Iterator<Item = String>) -> bool {
    let restarted = json_file::config_file(app, RESTART_MARKER).is_some_and(|marker| take_restart_marker(&marker, SystemTime::now()));
    from_sign_in_entry(args) && !restarted
}

fn from_sign_in_entry(mut args: impl Iterator<Item = String>) -> bool {
    args.any(|arg| arg == ARG)
}

/// Removes the marker and says whether it was written within `RESTART_WINDOW` before `now`; a marker from the future
/// (a clock set back since) is stale too.
fn take_restart_marker(marker: &Path, now: SystemTime) -> bool {
    let text = std::fs::read_to_string(marker).unwrap_or_default();
    let _ = std::fs::remove_file(marker);
    let Ok(written) = text.trim().parse::<u64>() else { return false };
    now.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|now| now.checked_sub(Duration::from_secs(written)))
        .is_some_and(|age| age <= RESTART_WINDOW)
}

fn write_restart_marker(marker: &Path, now: SystemTime) -> std::io::Result<()> {
    if let Some(dir) = marker.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let seconds = now.duration_since(UNIX_EPOCH).map_err(std::io::Error::other)?.as_secs();
    std::fs::write(marker, seconds.to_string())
}

/// Called right before an update restarts the app.
pub fn before_restart(app: &AppHandle) {
    let written = json_file::config_file(app, RESTART_MARKER)
        .ok_or_else(|| std::io::Error::other("no configuration directory"))
        .and_then(|marker| write_restart_marker(&marker, SystemTime::now()));
    if let Err(err) = written {
        crate::report_error!("marking the restart after an update: {err}");
    }
}

/// The program as the entry names it: in quotes on Windows, where the entry is one command line; as it is on macOS,
/// where it is an item of a list, but not a path the LaunchAgent cannot hold: `auto-launch` does not escape the XML,
/// and an app that macOS runs from a temporary copy (App Translocation, an app started from Downloads or a disk image
/// without moving it) would leave an entry that points nowhere after a restart.
fn entry_program(exe: &Path) -> Result<String, String> {
    let program = exe.to_str().ok_or_else(|| format!("the app's path is not valid Unicode: {}", exe.display()))?;
    if cfg!(windows) {
        return Ok(format!("\"{program}\""));
    }
    if cfg!(target_os = "macos") {
        if program.contains(['&', '<', '>']) {
            return Err(format!("Trackwall cannot start at sign-in from a folder whose path has &, < or >: {program}"));
        }
        if program.contains("/AppTranslocation/") {
            return Err("Move Trackwall to the Applications folder first: macOS runs it from a temporary copy now.".into());
        }
    }
    Ok(program.to_string())
}

/// The start entry of an app named `name` that runs `exe`.
fn launcher(name: &str, exe: &Path, bundle_id: &str) -> Result<AutoLaunch, String> {
    let mut builder = AutoLaunchBuilder::new();
    builder.set_app_name(name).set_app_path(&entry_program(exe)?).set_args(&[ARG]);
    #[cfg(windows)]
    builder.set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser);
    #[cfg(target_os = "macos")]
    // The bundle id lets Login Items show the app's name and icon instead of a bare program.
    builder.set_macos_launch_mode(auto_launch::MacOSLaunchMode::LaunchAgent).set_bundle_identifiers(&[bundle_id]);
    #[cfg(not(target_os = "macos"))]
    let _ = bundle_id;
    builder.build().map_err(err)
}

fn app_launcher(app: &AppHandle) -> Result<AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|e| format!("finding the app: {e}"))?;
    // The real path inside the bundle on macOS; not on Windows, where `canonicalize` gives a `\\?\` path.
    #[cfg(target_os = "macos")]
    let exe = exe.canonicalize().map_err(|e| format!("finding the app: {e}"))?;
    let name = if cfg!(debug_assertions) { DEV_APP_NAME.to_string() } else { app.package_info().name.clone() };
    launcher(&name, &exe, &app.config().identifier)
}

/// Turns the entry on or off and answers what the system has afterwards. A value for all users (`HKLM`, written by an
/// administrator) cannot be removed by the current user, so turning off reports it rather than silently staying on.
fn switch(launcher: &AutoLaunch, enabled: bool) -> Result<bool, String> {
    if enabled {
        launcher.enable().map_err(err)?;
    } else if launcher.is_enabled().map_err(err)? {
        launcher.disable().map_err(err)?;
    }
    let now = launcher.is_enabled().map_err(err)?;
    if now && !enabled {
        return Err("Trackwall still starts at sign-in for every user of this computer; an administrator can turn that off.".into());
    }
    Ok(now)
}

/// Whether the system starts Trackwall at sign-in. Async, so the registry or file read stays off the main thread.
#[tauri::command]
pub async fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app_launcher(&app)?.is_enabled().map_err(err)
}

/// Turns the start at sign-in on or off and answers what the system now has.
#[tauri::command]
pub async fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    switch(&app_launcher(&app)?, enabled)
}

/// Writes an enabled entry again with this app's path, so that it follows the portable folder when the user moves it,
/// like the link registration (ADR-52). An entry the user turned off stays off.
pub fn refresh(app: &AppHandle) {
    let refreshed = app_launcher(app).and_then(|launcher| match launcher.is_enabled().map_err(err)? {
        true => launcher.enable().map_err(err),
        false => Ok(()),
    });
    if let Err(err) = refreshed {
        crate::report_error!("refreshing the start at sign-in: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_from_the_sign_in_entry_carries_its_argument() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>().into_iter();
        assert!(from_sign_in_entry(args(&["trackwall.exe", "--autostart"])));
        assert!(!from_sign_in_entry(args(&["trackwall.exe"])));
        assert!(!from_sign_in_entry(args(&["trackwall.exe", "trackwall://session/x"])));
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_entry_quotes_a_path_with_a_space() {
        let exe = Path::new(r"C:\Users\Jan Nowak\AppData\Local\Programs\Trackwall\trackwall.exe");
        assert_eq!(entry_program(exe).as_deref(), Ok(r#""C:\Users\Jan Nowak\AppData\Local\Programs\Trackwall\trackwall.exe""#));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn on_macos_a_path_the_launch_agent_cannot_hold_is_refused() {
        assert!(entry_program(Path::new("/Users/jan/Apps & Tools/Trackwall.app/Contents/MacOS/trackwall")).is_err());
        let translocated = "/private/var/folders/ab/T/AppTranslocation/0A1B/d/Trackwall.app/Contents/MacOS/trackwall";
        assert!(entry_program(Path::new(translocated)).is_err());
        let fine = Path::new("/Applications/Trackwall.app/Contents/MacOS/trackwall");
        assert_eq!(entry_program(fine).as_deref(), Ok("/Applications/Trackwall.app/Contents/MacOS/trackwall"));
    }

    #[test]
    fn a_fresh_restart_marker_shows_the_windows_once_and_an_old_one_does_not() {
        let dir = std::env::temp_dir().join(format!("trackwall-restart-marker-{}", std::process::id()));
        let marker = dir.join(RESTART_MARKER);
        let written = SystemTime::now();
        write_restart_marker(&marker, written).expect("write");
        assert!(take_restart_marker(&marker, written + Duration::from_secs(5)));
        assert!(!take_restart_marker(&marker, written + Duration::from_secs(5)));
        write_restart_marker(&marker, written).expect("write");
        assert!(!take_restart_marker(&marker, written + Duration::from_secs(3600)));
        write_restart_marker(&marker, written).expect("write");
        assert!(!take_restart_marker(&marker, written - Duration::from_secs(3600)));
        assert!(!marker.exists());
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    /// Removes the test's entry also when an assertion fails, so no test entry starts at the next sign-in.
    #[cfg(any(windows, target_os = "macos"))]
    struct Cleanup<'a>(&'a AutoLaunch);

    #[cfg(any(windows, target_os = "macos"))]
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _ = self.0.disable();
        }
    }

    /// The real entry of the system, under a name of its own, written, read and removed again.
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn the_start_entry_is_written_read_and_removed_on_this_system() {
        let name = format!("Trackwall-test-{}", std::process::id());
        let exe = std::env::current_exe().expect("the test binary");
        let launcher = launcher(&name, &exe, "dev.trackwall.test").expect("a launcher");
        let _cleanup = Cleanup(&launcher);
        assert_eq!(switch(&launcher, true), Ok(true));
        assert_eq!(switch(&launcher, true), Ok(true));
        assert_eq!(switch(&launcher, false), Ok(false));
        assert_eq!(switch(&launcher, false), Ok(false));
    }
}
