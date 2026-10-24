//! App updates from GitHub Releases (ADR-53, §5.4). The updater plugin reads `latest.json` of the latest release,
//! downloads the package for this system and checks its minisign signature against the key in `tauri.conf.json`;
//! a package signed for another version is refused as well (`requireSignedVersion`). The UI checks on its own and
//! installs only when the user clicks, because the restart stops the daemon with its services and sessions.
//!
//! macOS installs through the plugin (`.app.tar.gz`, the bundle swapped in place), the portable Windows folder through
//! `portable_update`. Then the shell restarts: `RunEvent::Exit` stops the old daemon before the new shell starts its own.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Another manifest instead of the one in `tauri.conf.json`, to try an update before it is the latest release, such as
/// a pre-release's `latest.json` (docs/release.md). Its packages still need the signature of the release key.
const ENDPOINT_ENV: &str = "TRACKWALL_UPDATE_ENDPOINT";
/// Event for the UI with the download progress (`Progress`; same name and shape in `packages/ui/src/lib/updates.ts`).
const PROGRESS_EVENT: &str = "update-progress";

/// The update found by the last check; `install_update` installs exactly this one.
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
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
    let mut updater = app.updater_builder();
    if let Some(endpoint) = std::env::var(ENDPOINT_ENV).ok().filter(|v| !v.is_empty()) {
        let url = endpoint.parse().map_err(|e| format!("{ENDPOINT_ENV} is not a URL: {e}"))?;
        updater = updater.endpoints(vec![url]).map_err(|e| format!("{ENDPOINT_ENV}: {e}"))?;
    }
    let update = updater.build().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("Update check failed: {e}"))?;
    let check = UpdateCheck { current_version: crate::daemon::VERSION, available: update.as_ref().map(|u| u.version.clone()) };
    *updates.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = update;
    Ok(check)
}

/// Downloads, verifies and installs the checked update, then restarts the app. Returns only on failure.
#[tauri::command]
pub async fn install_update(app: AppHandle, updates: State<'_, Updates>) -> Result<(), String> {
    let update = updates.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let update = update.ok_or("No update to install. Check for updates first.")?;
    if updates.installing.swap(true, Ordering::SeqCst) {
        return Err("The update is already being installed.".into());
    }
    if let Err(err) = download_and_install(&app, update).await {
        updates.installing.store(false, Ordering::SeqCst);
        return Err(err);
    }
    // `installing` stays set: the next click would find the new files in place and nothing to install.
    app.request_restart();
    Ok(())
}

async fn download_and_install(app: &AppHandle, update: Update) -> Result<(), String> {
    let mut downloaded = 0u64;
    let package = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(PROGRESS_EVENT, Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("Download of Trackwall {} failed: {e}", update.version))?;
    tauri::async_runtime::spawn_blocking(move || install(&update, &package)).await.map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn install(_update: &Update, package: &[u8]) -> Result<(), String> {
    // `download` has already checked the signature.
    crate::portable_update::install(&crate::portable_update::app_dir()?, package)
}

#[cfg(not(windows))]
fn install(update: &Update, package: &[u8]) -> Result<(), String> {
    update.install(package).map_err(|e| format!("Installing Trackwall {} failed: {e}", update.version))
}
