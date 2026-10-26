//! App updates from GitHub Releases (ADR-53, §5.4). The updater plugin reads `latest.json` of the latest release,
//! downloads the package for this system and checks its minisign signature against the key in `tauri.conf.json`;
//! a package signed for another version is refused as well (`requireSignedVersion`). The UI asks for a check on its own
//! and installs only when the user clicks, because the restart stops the daemon with its services and sessions.
//!
//! macOS installs through the plugin (`.app.tar.gz`, the bundle swapped in place), the portable Windows folder through
//! `portable_update`. Then the shell restarts: `RunEvent::Exit` stops the old daemon before the new shell starts its own.

use crate::autostart;
use serde::Serialize;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;

/// Another manifest instead of the one in `tauri.conf.json`, to try an update before it is the latest release, such as
/// a pre-release's `latest.json` (docs/release.md). Its packages still need the signature of the release key.
const ENDPOINT_ENV: &str = "TRACKWALL_UPDATE_ENDPOINT";
/// Event for the UI with the stage of the install (`Progress`; same name and shape in `packages/ui/src/lib/updates.ts`).
const PROGRESS_EVENT: &str = "update-progress";
/// Without limits a stalled proxy would leave the UI checking or installing forever. The download has no limit on its
/// total time, only on silence, because a slow line is not a stalled one (the builder's `timeout` would apply to the
/// download too, so `check_update` takes it off the update it found).
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Download progress goes to the UI at most this often, not for every network chunk. Time and not a number of bytes,
/// so that a slow line (a proxy that lets the package through a few kilobytes at a time) still shows that it moves.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const INSTALLING: &str = "The update is already being installed.";
const CANCELLED: &str = "The update was cancelled.";

/// What the shell knows about updates; `install_update` installs exactly the update the last check found.
#[derive(Default)]
pub struct Updates(Mutex<Phase>);

#[derive(Default)]
enum Phase {
    #[default]
    NothingFound,
    Found(Box<Update>),
    /// Until the restart after success, or until a failure or `cancel_update` puts the update back. The download
    /// stops when this is notified; once the package is checked, the install goes on to the end.
    Installing(Arc<Notify>),
}

impl Updates {
    fn lock(&self) -> MutexGuard<'_, Phase> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// What `check_update` tells the UI (`UpdateCheck` in `updates.ts`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    current_version: &'static str,
    /// The newer version, or `None` when this one is the latest.
    available: Option<String>,
}

/// Where the install is, in the order of the stages.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "stage", rename_all = "kebab-case")]
enum Progress {
    /// Before the first bytes of the package arrive.
    Connecting,
    Downloading {
        downloaded: u64,
        total: Option<u64>,
    },
    /// The signature of the downloaded package.
    Verifying,
    /// Unpacking and replacing the app's files.
    Installing,
    Restarting,
}

#[tauri::command]
pub async fn check_update(app: AppHandle, updates: State<'_, Updates>) -> Result<UpdateCheck, String> {
    // A development build has the version of the last release and would offer to replace itself with it.
    if cfg!(debug_assertions) {
        return Err("Updates are off in a development build.".into());
    }
    if matches!(*updates.lock(), Phase::Installing(_)) {
        return Err(INSTALLING.into());
    }
    let mut updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| client.connect_timeout(CONNECT_TIMEOUT).read_timeout(READ_TIMEOUT));
    if let Some(endpoint) = std::env::var(ENDPOINT_ENV).ok().filter(|v| !v.is_empty()) {
        let url = endpoint.parse().map_err(|e| format!("{ENDPOINT_ENV} is not a URL: {e}"))?;
        updater = updater.endpoints(vec![url]).map_err(|e| format!("{ENDPOINT_ENV}: {e}"))?;
    }
    let update = updater.build().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("Update check failed: {e}"))?;
    let check = UpdateCheck { current_version: crate::daemon::VERSION, available: update.as_ref().map(|u| u.version.clone()) };
    let mut phase = updates.lock();
    // An install that started while this check was on the way keeps its update.
    if !matches!(*phase, Phase::Installing(_)) {
        *phase = update.map_or(Phase::NothingFound, |mut u| {
            u.timeout = None;
            Phase::Found(Box::new(u))
        });
    }
    Ok(check)
}

/// Downloads, verifies and installs `version`, which the last check found, then asks for a restart. A success returns
/// before the app exits; only an error or `cancel_update` leaves the app running.
#[tauri::command]
pub async fn install_update(app: AppHandle, updates: State<'_, Updates>, version: String) -> Result<(), String> {
    let cancel = Arc::new(Notify::new());
    let update = {
        let mut phase = updates.lock();
        match std::mem::replace(&mut *phase, Phase::Installing(Arc::clone(&cancel))) {
            Phase::Found(update) if update.version == version => update,
            installing @ Phase::Installing(_) => {
                *phase = installing;
                return Err(INSTALLING.into());
            }
            other => {
                *phase = other;
                return Err(format!("Trackwall {version} is not the update found last. Check for updates again."));
            }
        }
    };
    if let Err(err) = download_and_install(&app, &update, &cancel).await {
        eprintln!("[desktop] update {}: {err}", update.version);
        *updates.lock() = Phase::Found(update);
        return Err(err);
    }
    autostart::before_restart(&app);
    app.request_restart();
    Ok(())
}

/// Every way out but success goes back through `install_update`, which puts the update back.
async fn download_and_install(app: &AppHandle, update: &Update, cancel: &Notify) -> Result<(), String> {
    let report = |progress: Progress| {
        // The download would fill the log four times a second; `download` logs its first bytes instead.
        if !matches!(progress, Progress::Downloading { .. }) {
            eprintln!("[desktop] update {}: {progress:?}", update.version);
        }
        let _ = app.emit(PROGRESS_EVENT, progress);
    };
    let package = until_cancelled(download(update, &report), cancel).await?;
    report(Progress::Installing);
    let to_install = update.clone();
    tauri::async_runtime::spawn_blocking(move || install(&to_install, &package)).await.map_err(|e| e.to_string())??;
    report(Progress::Restarting);
    Ok(())
}

/// `work`, unless `cancel` is notified first, also before this is first polled (`notify_one` keeps the permit).
async fn until_cancelled<T>(work: impl Future<Output = Result<T, String>>, cancel: &Notify) -> Result<T, String> {
    tokio::select! {
        result = work => result,
        () = cancel.notified() => Err(CANCELLED.into()),
    }
}

/// Stops the download of the update being installed; `install_update` then fails with "cancelled" and the update can
/// be installed again. Once the package is downloaded and checked, the install is not stopped halfway.
#[tauri::command]
pub fn cancel_update(updates: State<'_, Updates>) {
    if let Phase::Installing(cancel) = &*updates.lock() {
        cancel.notify_one();
    }
}

/// The package, its signature checked (`Update::download` does that before it returns).
async fn download(update: &Update, report: &impl Fn(Progress)) -> Result<Vec<u8>, String> {
    report(Progress::Connecting);
    let mut downloaded = 0u64;
    let mut throttle = Throttle::default();
    update
        .download(
            |chunk, total| {
                if downloaded == 0 {
                    eprintln!("[desktop] update {}: the first bytes came, {total:?} in all", update.version);
                }
                downloaded += chunk as u64;
                if throttle.due(Instant::now()) {
                    report(Progress::Downloading { downloaded, total });
                }
            },
            || report(Progress::Verifying),
        )
        .await
        .map_err(|e| format!("Download of Trackwall {} failed: {e}", update.version))
}

/// Lets through the first report of the download and then one at most every `PROGRESS_EVERY`. The last one needs no
/// exception: `Verifying` follows it at once.
#[derive(Default)]
struct Throttle {
    last: Option<Instant>,
}

impl Throttle {
    fn due(&mut self, now: Instant) -> bool {
        let due = self.last.is_none_or(|last| now.duration_since(last) >= PROGRESS_EVERY);
        if due {
            self.last = Some(now);
        }
        due
    }
}

/// `download` has already checked the signature.
fn install(update: &Update, package: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    let installed = crate::portable_update::app_dir().and_then(|dir| crate::portable_update::install(&dir, package));
    #[cfg(not(windows))]
    let installed = update.install(package).map_err(|e| e.to_string());
    installed.map_err(|e| format!("Installing Trackwall {} failed: {e}", update.version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_download_reports_its_first_chunk_then_at_most_four_times_a_second() {
        let start = Instant::now();
        let mut throttle = Throttle::default();
        assert!(throttle.due(start));
        assert!(!throttle.due(start + Duration::from_millis(100)));
        assert!(throttle.due(start + Duration::from_millis(250)));
        assert!(!throttle.due(start + Duration::from_millis(400)));
        assert!(throttle.due(start + Duration::from_millis(500)));
    }

    #[test]
    fn a_cancel_before_the_download_is_first_polled_still_stops_it() {
        let cancel = Notify::new();
        cancel.notify_one();
        let result = tauri::async_runtime::block_on(until_cancelled(std::future::pending::<Result<(), String>>(), &cancel));
        assert_eq!(result, Err(CANCELLED.to_string()));
    }

    #[test]
    fn a_download_that_finishes_without_a_cancel_gives_its_package() {
        let cancel = Notify::new();
        let result = tauri::async_runtime::block_on(until_cancelled(async { Ok(vec![1u8, 2]) }, &cancel));
        assert_eq!(result, Ok(vec![1, 2]));
    }

    #[test]
    fn the_ui_gets_the_stage_by_name_and_the_download_with_its_sizes() {
        let json = |p: Progress| serde_json::to_string(&p).expect("serialize");
        assert_eq!(json(Progress::Connecting), r#"{"stage":"connecting"}"#);
        assert_eq!(json(Progress::Downloading { downloaded: 5, total: Some(10) }), r#"{"stage":"downloading","downloaded":5,"total":10}"#);
        assert_eq!(json(Progress::Downloading { downloaded: 5, total: None }), r#"{"stage":"downloading","downloaded":5,"total":null}"#);
        assert_eq!(json(Progress::Verifying), r#"{"stage":"verifying"}"#);
        assert_eq!(json(Progress::Restarting), r#"{"stage":"restarting"}"#);
    }
}
