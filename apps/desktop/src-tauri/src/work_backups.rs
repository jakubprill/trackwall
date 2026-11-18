//! Work backups on this computer (ADR-281): while the app is connected to a daemon in a dev container, it makes a work
//! backup there every 4 hours (ADR-275), downloads it into a folder of this computer and keeps the newest 14. So the
//! work that lives only in the container's volume has a copy outside it, out of reach of the agents in the container,
//! without the user remembering to click "Back up now". The daemon makes the file; the app only fetches and rotates it.

use crate::daemon::{self, Connection};
use crate::daemon_state::DaemonState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

/// How often a backup is made while the app runs.
pub const EVERY: Duration = Duration::from_secs(4 * 60 * 60);
/// The first one after the start, once the connection and the daemon have settled.
const FIRST_AFTER: Duration = Duration::from_secs(5 * 60);
/// Between tries while there is no connection to a daemon, and after a failed run.
const RETRY: Duration = Duration::from_secs(10 * 60);
/// How many backups the folder keeps; older ones are removed after a new one is in place.
pub const KEEP: usize = 14;
/// Making a backup of many repos and downloading up to 1 GB through a forwarded port takes its time.
const CREATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const STATE_TIMEOUT: Duration = Duration::from_secs(30);

const FOLDER: &str = "work-backups";
const PREFIX: &str = "trackwall-backup-";
const SUFFIX: &str = ".tar.gz";
const PART: &str = ".part";

/// What the last run did, for Settings.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LastRun {
    /// A backup was saved as `file`.
    Saved {
        at: u64,
        file: String,
    },
    /// The daemon runs on this computer, where the repos are on its own disk and there is nothing to back up.
    NotInContainer {
        at: u64,
    },
    Failed {
        at: u64,
        message: String,
    },
}

#[derive(Default)]
pub struct WorkBackups {
    last: Mutex<Option<LastRun>>,
}

/// What Settings shows: where the backups go, how many there are, and the last run.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBackupsState {
    folder: String,
    files: usize,
    keep: usize,
    every_hours: u64,
    last: Option<LastRun>,
}

pub fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|dir| dir.join(FOLDER)).map_err(|e| format!("no folder for app data: {e}"))
}

/// Makes a backup every `EVERY` while the shell runs; a run without a daemon in a container tries again later.
pub fn watch(app: AppHandle, state: Arc<DaemonState>) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_AFTER);
        loop {
            let Some(conn) = state.ready() else {
                std::thread::sleep(RETRY);
                continue;
            };
            let run = folder(&app).and_then(|dir| back_up(&conn, &dir)).unwrap_or_else(|message| LastRun::Failed { at: now(), message });
            if let LastRun::Failed { message, .. } = &run {
                crate::report_error!("work backup: {message}");
            }
            let wait = until_next(&run);
            if let Ok(mut last) = app.state::<WorkBackups>().last.lock() {
                *last = Some(run);
            }
            std::thread::sleep(wait);
        }
    });
}

/// A failed run (a port forward down, the computer just woken) tries again soon rather than leave 4 hours without a copy.
fn until_next(run: &LastRun) -> Duration {
    match run {
        LastRun::Failed { .. } => RETRY,
        LastRun::Saved { .. } | LastRun::NotInContainer { .. } => EVERY,
    }
}

/// One run: ask the daemon whether it runs in a container, have it make a backup, download it and rotate the folder.
pub fn back_up(conn: &Connection, dir: &Path) -> Result<LastRun, String> {
    if !in_container(conn)? {
        return Ok(LastRun::NotInContainer { at: now() });
    }
    let file = created_file(conn)?;
    fs::create_dir_all(dir).map_err(|e| format!("making {}: {e}", dir.display()))?;
    let part = dir.join(format!("{file}{PART}"));
    let result = download(conn, &part).and_then(|()| fs::rename(&part, dir.join(&file)).map_err(|e| format!("saving {file}: {e}")));
    if let Err(message) = result {
        let _ = fs::remove_file(&part);
        return Err(message);
    }
    rotate(dir, KEEP)?;
    Ok(LastRun::Saved { at: now(), file })
}

#[derive(Deserialize)]
struct Answer<T> {
    data: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupState {
    in_container: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    file_name: String,
}

fn in_container(conn: &Connection) -> Result<bool, String> {
    let body = answer(conn, "/api/work-backup/state", STATE_TIMEOUT)?;
    Ok(serde_json::from_str::<Answer<BackupState>>(&body).map_err(|e| format!("the backup state: {e}"))?.data.in_container)
}

/// Has the daemon make a backup and returns its file name, checked to be one a backup has before it names a file here.
fn created_file(conn: &Connection) -> Result<String, String> {
    let body = answer(conn, "/api/work-backup/create", CREATE_TIMEOUT)?;
    let name = serde_json::from_str::<Answer<BackupInfo>>(&body).map_err(|e| format!("the backup: {e}"))?.data.file_name;
    if is_backup_name(&name) {
        Ok(name)
    } else {
        Err(format!("the daemon named the backup {name:?}, which is not a backup's name"))
    }
}

fn answer(conn: &Connection, path: &str, timeout: Duration) -> Result<String, String> {
    match daemon::post_within(conn, path, timeout)? {
        (200, body) => Ok(body),
        (status, body) => Err(format!("{path} answered {status}: {body}")),
    }
}

fn download(conn: &Connection, part: &Path) -> Result<(), String> {
    let mut out = fs::File::create(part).map_err(|e| format!("creating {}: {e}", part.display()))?;
    daemon::post_download(conn, "/api/work-backup/download", DOWNLOAD_TIMEOUT, &mut out)?;
    out.sync_all().map_err(|e| format!("writing {}: {e}", part.display()))
}

/// `trackwall-backup-2026-11-18-1440.tar.gz`: only letters, digits and dashes between the two, so a name from the
/// daemon cannot leave the folder or name a file of another kind.
pub fn is_backup_name(name: &str) -> bool {
    name.strip_prefix(PREFIX)
        .and_then(|rest| rest.strip_suffix(SUFFIX))
        .is_some_and(|stamp| !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

/// Keeps the newest `keep` backups of the folder and removes the rest and any download left unfinished. The names
/// carry the time they were made, so their order is their age; other files in the folder are not touched.
pub fn rotate(dir: &Path, keep: usize) -> Result<(), String> {
    let mut backups = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("reading {}: {e}", dir.display()))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let regular = entry.file_type().is_ok_and(|t| t.is_file());
        if regular && name.strip_suffix(PART).is_some_and(is_backup_name) {
            let _ = fs::remove_file(entry.path());
        } else if regular && is_backup_name(&name) {
            backups.push(name);
        }
    }
    backups.sort();
    let old = backups.len().saturating_sub(keep);
    for name in &backups[..old] {
        fs::remove_file(dir.join(name)).map_err(|e| format!("removing the old backup {name}: {e}"))?;
    }
    Ok(())
}

fn backups_in(dir: &Path) -> usize {
    fs::read_dir(dir).map(|entries| entries.flatten().filter(|e| is_backup_name(&e.file_name().to_string_lossy())).count()).unwrap_or(0)
}

fn now() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tauri::command]
pub fn work_backups(app: AppHandle, backups: tauri::State<'_, WorkBackups>) -> Result<WorkBackupsState, String> {
    let dir = folder(&app)?;
    Ok(WorkBackupsState {
        folder: dir.display().to_string(),
        files: backups_in(&dir),
        keep: KEEP,
        every_hours: EVERY.as_secs() / 3600,
        last: backups.last.lock().map(|last| last.clone()).unwrap_or(None),
    })
}

/// Shows the backups' folder in Explorer or Finder, made first so that there is one to show.
#[tauri::command]
pub fn show_work_backups(app: AppHandle) -> Result<(), String> {
    let dir = folder(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("making {}: {e}", dir.display()))?;
    crate::system_open::reveal_folder(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::DaemonLocation;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A daemon in a container as the app sees it: it answers the three requests of a run, the download with `body`
    /// announced as `announced` bytes (a daemon that fails after the headers sends fewer).
    fn fake_daemon(in_container: bool, body: &'static [u8], announced: usize) -> Connection {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut raw = Vec::new();
                let mut byte = [0u8; 1];
                while !raw.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    raw.push(byte[0]);
                }
                let request = String::from_utf8_lossy(&raw).into_owned();
                let json = |text: String| format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{text}", text.len()).into_bytes();
                let answer = if request.starts_with("POST /api/work-backup/state ") {
                    json(format!("{{\"ok\":true,\"data\":{{\"inContainer\":{in_container},\"last\":null,\"running\":false}}}}"))
                } else if request.starts_with("POST /api/work-backup/create ") {
                    json("{\"ok\":true,\"data\":{\"fileName\":\"trackwall-backup-2026-11-18-1440.tar.gz\"}}".into())
                } else {
                    let mut head = format!("HTTP/1.1 200 OK\r\nContent-Length: {announced}\r\n\r\n").into_bytes();
                    head.extend_from_slice(body);
                    head
                };
                let _ = stream.write_all(&answer);
            }
        });
        Connection::new(port, "t", DaemonLocation::Remote)
    }

    fn empty_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trackwall-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_run_saves_the_containers_backup_under_its_name() {
        let dir = empty_dir("backup-saved");
        let conn = fake_daemon(true, b"the backup's bytes", 18);

        let run = back_up(&conn, &dir).unwrap();

        assert!(matches!(run, LastRun::Saved { ref file, .. } if file == "trackwall-backup-2026-11-18-1440.tar.gz"));
        assert_eq!(fs::read(dir.join("trackwall-backup-2026-11-18-1440.tar.gz")).unwrap(), b"the backup's bytes");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_download_cut_short_leaves_no_file() {
        let dir = empty_dir("backup-cut");
        let conn = fake_daemon(true, b"half", 18);

        let error = back_up(&conn, &dir).unwrap_err();

        assert!(error.contains("ended after 4 of 18 bytes"), "{error}");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_daemon_on_this_computer_has_nothing_to_back_up() {
        let dir = empty_dir("backup-local");
        let conn = fake_daemon(false, b"", 0);

        assert!(matches!(back_up(&conn, &dir).unwrap(), LastRun::NotInContainer { .. }));
        assert!(!dir.exists());
    }

    #[test]
    fn a_failed_run_tries_again_sooner_than_the_next_backup() {
        assert_eq!(until_next(&LastRun::Failed { at: 0, message: "no answer".into() }), RETRY);
        assert_eq!(until_next(&LastRun::Saved { at: 0, file: "trackwall-backup-2026-11-18-1440.tar.gz".into() }), EVERY);
        assert_eq!(until_next(&LastRun::NotInContainer { at: 0 }), EVERY);
    }

    #[test]
    fn only_a_backups_own_name_counts() {
        assert!(is_backup_name("trackwall-backup-2026-11-18-1440.tar.gz"));
        for name in [
            "trackwall-backup-.tar.gz",
            "trackwall-backup-../x.tar.gz",
            "trackwall-backup-a b.tar.gz",
            "notes.tar.gz",
            "trackwall-backup-1.zip",
        ] {
            assert!(!is_backup_name(name), "{name}");
        }
    }

    #[test]
    fn rotating_keeps_the_newest_and_leaves_other_files() {
        let dir = std::env::temp_dir().join(format!("trackwall-rotate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for day in 1..=16 {
            fs::write(dir.join(format!("trackwall-backup-2026-11-{day:02}-0800.tar.gz")), "x").unwrap();
        }
        fs::write(dir.join("trackwall-backup-2026-11-17-0800.tar.gz.part"), "half").unwrap();
        fs::write(dir.join("my-notes.txt"), "mine").unwrap();

        rotate(&dir, KEEP).unwrap();

        let mut left: Vec<String> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        let mut expected: Vec<String> = (3..=16).map(|day| format!("trackwall-backup-2026-11-{day:02}-0800.tar.gz")).collect();
        expected.push("my-notes.txt".into());
        expected.sort();
        assert_eq!(left, expected);
        fs::remove_dir_all(&dir).unwrap();
    }
}
