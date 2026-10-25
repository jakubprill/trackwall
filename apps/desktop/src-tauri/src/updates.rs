//! App updates from GitHub Releases (ADR-53, §5.4). The updater plugin reads `latest.json` of the latest release,
//! downloads the package for this system and checks its minisign signature against the key in `tauri.conf.json`;
//! a package signed for another version is refused as well (`requireSignedVersion`). The UI asks for a check on its own
//! and installs only when the user clicks, because the restart stops the daemon with its services and sessions.
//!
//! macOS installs through the plugin (`.app.tar.gz`, the bundle swapped in place), the portable Windows folder through
//! `portable_update`. Then the shell restarts: `RunEvent::Exit` stops the old daemon before the new shell starts its own.

use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Another manifest instead of the one in `tauri.conf.json`, to try an update before it is the latest release, such as
/// a pre-release's `latest.json` (docs/release.md). Its packages still need the signature of the release key.
const ENDPOINT_ENV: &str = "TRACKWALL_UPDATE_ENDPOINT";
/// Event for the UI with the download progress (`Progress`; same name and shape in `packages/ui/src/lib/updates.ts`).
const PROGRESS_EVENT: &str = "update-progress";
/// Without limits a stalled proxy would leave the UI checking or installing forever. The download has no limit on its
/// total time, only on silence, because a slow line is not a stalled one (the builder's `timeout` would apply to the
/// download too, so `check_update` takes it off the update it found).
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Progress goes to the UI in steps of this size, not for every network chunk.
const PROGRESS_STEP: u64 = 1 << 20;
const INSTALLING: &str = "The update is already being installed.";

/// What the shell knows about updates; `install_update` installs exactly the update the last check found.
#[derive(Default)]
pub struct Updates(Mutex<Phase>);

#[derive(Default)]
enum Phase {
    #[default]
    NothingFound,
    Found(Box<Update>),
    /// Until the restart after success, or until a failure puts the update back.
    Installing,
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

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn check_update(app: AppHandle, updates: State<'_, Updates>) -> Result<UpdateCheck, String> {
    // A development build has the version of the last release and would offer to replace itself with it.
    if cfg!(debug_assertions) {
        return Err("Updates are off in a development build.".into());
    }
    if matches!(*updates.lock(), Phase::Installing) {
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
    if !matches!(*phase, Phase::Installing) {
        *phase = update.map_or(Phase::NothingFound, |mut u| {
            u.timeout = None;
            Phase::Found(Box::new(u))
        });
    }
    Ok(check)
}

/// Downloads, verifies and installs `version`, which the last check found, then asks for a restart. A success returns
/// before the app exits; only an error leaves the app running.
#[tauri::command]
pub async fn install_update(app: AppHandle, updates: State<'_, Updates>, version: String) -> Result<(), String> {
    let update = {
        let mut phase = updates.lock();
        match std::mem::replace(&mut *phase, Phase::Installing) {
            Phase::Found(update) if update.version == version => update,
            Phase::Installing => return Err(INSTALLING.into()),
            other => {
                *phase = other;
                return Err(format!("Trackwall {version} is not the update found last. Check for updates again."));
            }
        }
    };
    if let Err(err) = download_and_install(&app, &update).await {
        *updates.lock() = Phase::Found(update);
        return Err(err);
    }
    app.request_restart();
    Ok(())
}

async fn download_and_install(app: &AppHandle, update: &Update) -> Result<(), String> {
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let package = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if downloaded - reported >= PROGRESS_STEP || Some(downloaded) == total {
                    reported = downloaded;
                    let _ = app.emit(PROGRESS_EVENT, Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("Download of Trackwall {} failed: {e}", update.version))?;
    let update = update.clone();
    tauri::async_runtime::spawn_blocking(move || install(&update, &package)).await.map_err(|e| e.to_string())?
}

/// `download` has already checked the signature.
fn install(update: &Update, package: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    let installed = crate::portable_update::app_dir().and_then(|dir| crate::portable_update::install(&dir, package));
    #[cfg(not(windows))]
    let installed = update.install(package).map_err(|e| e.to_string());
    installed.map_err(|e| format!("Installing Trackwall {} failed: {e}", update.version))
}
