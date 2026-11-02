//! Starting the dev container from the window (ADR-139): what the user's own shortcut does, without pasting an address.
//! The user saves the folder on this computer that holds the dev container's configuration and the folder inside the
//! container to open. "Start" then opens VS Code on that dev container (`dev-container+`, the address the shortcut opens;
//! the Dev Containers extension starts or builds the container, and forwards the daemon's port while its window is open),
//! finds the running container by the label the extension gives it, reads the daemon's `daemon.json` in it through
//! `docker exec`, checks the daemon like a pasted address (ADR-130) and switches the app to it. The port in `daemon.json`
//! is the one inside the container, which the dev container guide forwards to the same number (`requireLocalPort`);
//! another number fails the check rather than reaching something else. A running container whose daemon does not answer
//! first gets `trackwall-container start` (the Trackwall Feature, ADR-164), once per start.
//!
//! The token never leaves this computer: it goes from the container to the shell over Docker's own channel and is saved
//! like a pasted one. Every command is built from constants and the saved folder, never from what the daemon or the
//! container reports.

use crate::daemon;
use crate::daemon_state::DaemonState;
use crate::remote_daemon::{self, RemoteDaemon};
use crate::{json_file, system_open};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const FILE: &str = "dev-container.json";

/// The label the Dev Containers extension puts on a container with the folder it was opened from.
const FOLDER_LABEL: &str = "devcontainer.local_folder";

/// Reads `daemon.json` from the daemon's state directory: `TRACKWALL_HOME` from `containerEnv`, which `docker exec`
/// sees as the daemon does, or the default under the home folder of the user `docker exec` runs as.
const READ_DAEMON_FILE: &str = r#"cat "${TRACKWALL_HOME:-$HOME/.trackwall}/daemon.json""#;

/// Starts the daemon of the Trackwall Dev Container Feature when it does not answer (ADR-164); idempotent, it prints one
/// JSON object (`ContainerStartResult` in `protocol`) within `DOCKER_TIMEOUT`. Run without `--user`: as root it runs
/// itself again as the remote user, whose `daemon.json` `READ_DAEMON_FILE` reads.
const START_TRACKWALL: [&str; 2] = ["trackwall-container", "start"];

/// What `docker exec` exits with when the command is not in the container: an image without the Feature, or a Feature
/// whose binary is gone, which the start then treats the same way and waits out.
const COMMAND_NOT_FOUND: i32 = 127;

const DOCKER_TIMEOUT: Duration = Duration::from_secs(20);

/// More than Docker prints for `ps` with many containers; a container cannot make the window hold more of `daemon.json`.
const MAX_OUTPUT: u64 = 256 * 1024;

/// The first start builds the image, which can take a while.
const START_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// How long after VS Code opened the start keeps waiting on a container whose label differs from the folder only in
/// case: VS Code fails at once when it does not reuse it, and connects within this when it does.
const OTHER_CASE_GRACE: Duration = Duration::from_secs(60);

/// The folder with the dev container's configuration and the folder inside the container VS Code opens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DevContainer {
    pub folder: String,
    pub open: String,
}

impl DevContainer {
    fn editor_url(&self) -> String {
        system_open::dev_container_url(&self.folder, &self.open)
    }
}

/// The folder inside the container is a Linux path the address carries as it is; the address as a whole must be one
/// `open_outside` takes, which decides which folders of this computer a dev container may be opened from.
fn check(dev: &DevContainer) -> Result<(), String> {
    let open_ok = dev.open.starts_with('/')
        && dev.open.len() <= 256
        && dev.open.chars().all(|c| c >= ' ' && !matches!(c, '\\' | '?' | '#' | '%'))
        && !dev.open.split('/').any(|s| s == "." || s == "..");
    if !open_ok {
        return Err("Enter the folder to open inside the container as a Linux path, such as /workspaces.".into());
    }
    if !system_open::opens(&dev.editor_url()) {
        return Err("Enter the full path of a folder on this computer, such as C:\\Users\\me\\Dev\\workspace.".into());
    }
    Ok(())
}

/// As the Dev Containers extension writes it into its label: Windows separators on Windows.
fn normalize(folder: &str, windows: bool) -> String {
    let folder = folder.trim();
    if windows {
        folder.replace('/', "\\")
    } else {
        folder.to_owned()
    }
}

/// Saved only with a configuration in it, so a typo shows at once rather than as a container that never starts.
fn has_configuration(folder: &Path) -> bool {
    folder.join(".devcontainer").join("devcontainer.json").is_file() || folder.join(".devcontainer.json").is_file()
}

fn load(app: &AppHandle) -> Option<DevContainer> {
    let path = json_file::config_file(app, FILE)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<DevContainer>(&text).ok().filter(|dev| check(dev).is_ok())
}

/// The Docker command line. A window started from Finder on macOS gets no shell `PATH`, so the usual places come first.
struct Docker {
    program: PathBuf,
    /// The script of a fake `docker` run by `sh`, which cannot fail with "text file busy" the way running a script just
    /// written can while other tests start processes.
    #[cfg(test)]
    script: Option<PathBuf>,
}

impl Docker {
    fn system() -> Docker {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let candidates = if cfg!(target_os = "macos") {
            vec![
                PathBuf::from("/usr/local/bin/docker"),
                PathBuf::from("/opt/homebrew/bin/docker"),
                PathBuf::from("/Applications/Docker.app/Contents/Resources/bin/docker"),
                home.join(".docker").join("bin").join("docker"),
                home.join(".rd").join("bin").join("docker"),
                home.join(".orbstack").join("bin").join("docker"),
            ]
        } else {
            Vec::new()
        };
        let program = candidates.into_iter().find(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("docker"));
        Docker {
            program,
            #[cfg(test)]
            script: None,
        }
    }

    /// The command's output, or why it failed; never waits longer than `DOCKER_TIMEOUT`.
    fn run(&self, args: &[&str]) -> Result<String, String> {
        let exit = self.exit(args)?;
        if exit.code != Some(0) {
            return Err(short(&exit.stderr));
        }
        Ok(exit.stdout)
    }

    /// The command's exit code and output, whatever the code; never waits longer than `DOCKER_TIMEOUT`. The output is
    /// read while the command runs, so a long `docker ps` never fills the pipe and stalls it.
    fn exit(&self, args: &[&str]) -> Result<Exit, String> {
        let mut cmd = Command::new(&self.program);
        #[cfg(test)]
        cmd.args(&self.script);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(system_open::CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("docker could not start: {e}"))?;
        let stdout = read_in_background(child.stdout.take());
        let stderr = read_in_background(child.stderr.take());
        let deadline = Instant::now() + DOCKER_TIMEOUT;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("docker {} did not answer within {} s", args[0], DOCKER_TIMEOUT.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        Ok(Exit { code: status.code(), stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() })
    }
}

/// A reason from Docker or the container, cut to a line's length and without control characters, for the window to show.
fn short(text: &str) -> String {
    text.trim().chars().filter(|c| !c.is_control()).take(300).collect()
}

struct Exit {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn read_in_background(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        // Bytes first: the cap can cut a character in two, which must not lose the whole output.
        let mut bytes = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(MAX_OUTPUT).read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Windows and the default disk of macOS compare paths without case, and the extension may write the drive letter in
/// either case.
fn same_folder(label: &str, folder: &str, ignore_case: bool) -> bool {
    let trim = |p: &str| p.trim_end_matches(['\\', '/']).to_owned();
    let (label, folder) = (trim(label), trim(folder));
    if ignore_case {
        label.eq_ignore_ascii_case(&folder)
    } else {
        label == folder
    }
}

/// A running container opened from the folder.
#[derive(Debug, PartialEq)]
struct Found {
    id: String,
    /// Its label when it names the folder only without case, e.g. `c:\...` made by the `devcontainer` CLI for `C:\...`:
    /// the Dev Containers extension compares labels with case, so it does not reuse that container and, with a
    /// `--name` in `runArgs`, cannot create its own either.
    other_case: Option<String>,
}

/// The running container opened from `folder`, read from `docker ps` lines of id and label: one whose label is the
/// folder as written first, then, where paths ignore case, one whose label differs only in case.
fn container_in(ps: &str, folder: &str, ignore_case: bool) -> Option<Found> {
    let rows: Vec<(&str, &str)> = ps
        .lines()
        .filter_map(|line| {
            let (id, label) = line.split_once('\t')?;
            let id_ok = (12..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit());
            id_ok.then_some((id, label))
        })
        .collect();
    if let Some((id, _)) = rows.iter().find(|(_, label)| same_folder(label, folder, false)) {
        return Some(Found { id: (*id).to_owned(), other_case: None });
    }
    if !ignore_case {
        return None;
    }
    let (id, label) = rows.iter().find(|(_, label)| same_folder(label, folder, true))?;
    Some(Found { id: (*id).to_owned(), other_case: Some((*label).to_owned()) })
}

/// What to do about a container VS Code does not reuse because its label differs from the folder in case; the label is
/// the container's text, shown cut to a line and never run.
fn other_case_hint(id: &str, label: &str, folder: &str) -> String {
    let (label, short_id) = (short(label), &id[..12]);
    format!(
        "A container for this folder is running with the label {label}, which differs from {folder} in case, so VS Code does not \
         reuse it. Remove it with `docker rm -f {short_id}` (this also deletes what it holds outside the mounted folders) and start again, or \
         open it from the folder it was created from."
    )
}

#[derive(Deserialize)]
struct DaemonFile {
    port: u16,
    token: String,
}

fn parse_daemon_file(text: &str) -> Option<RemoteDaemon> {
    let file = serde_json::from_str::<DaemonFile>(text).ok()?;
    remote_daemon::is_token(&file.token).then_some(RemoteDaemon { port: file.port, token: file.token })
}

/// Why a look found no daemon to connect to: one that may still come (the container or the daemon is starting), or one
/// waiting cannot fix (a daemon of another version).
#[derive(Debug, PartialEq)]
enum Miss {
    NotYet(String),
    /// Like `NotYet`, for a container whose label differs from the folder in case: final once VS Code has had
    /// `OTHER_CASE_GRACE` to reuse it.
    OtherCase(String),
    Final(String),
}

/// The daemon at `remote` accepted, or why not; a daemon of another version is final.
type Connect<'a> = &'a dyn Fn(&RemoteDaemon) -> Result<(), Miss>;

fn connect_remote(remote: &RemoteDaemon) -> Result<(), Miss> {
    match daemon::health(remote.port, daemon::Reach::Remote) {
        Some(version) if version != daemon::VERSION => Err(Miss::Final(format!(
            "Trackwall in the container is {version}, but this app is {}. Update the older one so both are the same version.",
            daemon::VERSION
        ))),
        _ => daemon::connect_remote(remote).map(drop).map_err(Miss::NotYet),
    }
}

/// The part of `ContainerStartResult` (protocol) the window acts on: whether it started, and why not.
#[derive(Deserialize)]
struct StartResult {
    ok: bool,
    error: Option<StartError>,
}

#[derive(Deserialize)]
struct StartError {
    code: StartErrorCode,
    message: String,
}

/// The stable codes of `CONTAINER_START_ERRORS` (protocol); another code is not an answer of Trackwall's.
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum StartErrorCode {
    BadArguments,
    StartFailed,
}

impl StartErrorCode {
    fn as_str(&self) -> &'static str {
        match self {
            StartErrorCode::BadArguments => "bad-arguments",
            StartErrorCode::StartFailed => "start-failed",
        }
    }
}

/// What `trackwall-container start` answered: nothing to do when the image has no Feature (the daemon may still come from
/// the user's own `postStartCommand`), a final miss when it could not start the daemon. Its message is shown, never run.
fn read_start_result(exit: &Exit) -> Result<(), Miss> {
    if exit.code == Some(COMMAND_NOT_FOUND) {
        return Ok(());
    }
    let last_line = exit.stdout.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or_default();
    match serde_json::from_str::<StartResult>(last_line) {
        Ok(StartResult { ok: true, .. }) => Ok(()),
        Ok(StartResult { error: Some(StartError { code, message }), .. }) => {
            Err(Miss::Final(format!("Trackwall in the container could not start ({}): {}", code.as_str(), short(&message))))
        }
        _ => Err(Miss::NotYet("trackwall-container start in the container did not answer as Trackwall does.".into())),
    }
}

/// The running container opened from `folder`.
fn running_container(docker: &Docker, folder: &str, ignore_case: bool) -> Result<Found, Miss> {
    let label = format!("{{{{.ID}}}}\t{{{{.Label \"{FOLDER_LABEL}\"}}}}");
    let ps = docker.run(&["ps", "--no-trunc", "--format", &label]).map_err(Miss::NotYet)?;
    container_in(&ps, folder, ignore_case).ok_or_else(|| Miss::NotYet(format!("No container opened from {folder} is running.")))
}

/// Where the start looks and how paths compare there: without case on Windows and the default disk of macOS.
struct Look<'a> {
    docker: &'a Docker,
    ignore_case: bool,
}

/// One look: the container of the folder, the daemon in it, and that daemon accepted by `connect`. With `try_start`, a
/// running container whose daemon does not answer gets `trackwall-container start` before a second look; the polls after
/// VS Code opened leave starting to the Feature's own `postStartCommand`. A container whose label differs from the folder
/// in case and whose daemon does not answer is `OtherCase` with what to do about it.
fn find_daemon(look: &Look, folder: &str, connect: Connect, try_start: bool) -> Result<RemoteDaemon, Miss> {
    let found = running_container(look.docker, folder, look.ignore_case)?;
    let id = found.id.as_str();
    let result = match daemon_in(look.docker, id, connect) {
        Err(Miss::NotYet(_)) if try_start => {
            let mut args = vec!["exec", id];
            args.extend(START_TRACKWALL);
            read_start_result(&look.docker.exit(&args).map_err(Miss::NotYet)?)?;
            daemon_in(look.docker, id, connect)
        }
        result => result,
    };
    match (result, &found.other_case) {
        (Err(Miss::NotYet(_)), Some(label)) => Err(Miss::OtherCase(other_case_hint(id, label, folder))),
        (result, _) => result,
    }
}

/// The daemon of the container `id`, accepted by `connect`.
fn daemon_in(docker: &Docker, id: &str, connect: Connect) -> Result<RemoteDaemon, Miss> {
    let text = docker
        .run(&["exec", id, "sh", "-c", READ_DAEMON_FILE])
        .map_err(|e| Miss::NotYet(format!("Trackwall's daemon.json in the container: {e}")))?;
    let remote =
        parse_daemon_file(&text).ok_or(Miss::NotYet("Trackwall's daemon.json in the container is not one Trackwall writes.".into()))?;
    connect(&remote)?;
    Ok(remote)
}

const CANCELLED: &str = "Starting the dev container was cancelled.";

struct Timing {
    timeout: Duration,
    poll: Duration,
    other_case_grace: Duration,
}

/// Connects to the daemon of an already running container, or opens VS Code on the dev container and waits until the
/// daemon in it answers on the forwarded port; `cancelled` ends the wait.
fn start(
    look: &Look,
    dev: &DevContainer,
    open_editor: &dyn Fn(String) -> Result<(), String>,
    connect: Connect,
    cancelled: &AtomicBool,
    timing: Timing,
) -> Result<RemoteDaemon, String> {
    look.docker
        .run(&["version", "--format", "{{.Server.Version}}"])
        .map_err(|e| format!("Docker does not answer ({e}). Start Docker Desktop or Rancher Desktop and try again."))?;
    let was_cancelled = || if cancelled.load(Ordering::SeqCst) { Err(CANCELLED.to_owned()) } else { Ok(()) };
    match find_daemon(look, &dev.folder, connect, true) {
        Ok(remote) => return was_cancelled().map(|()| remote),
        Err(Miss::Final(reason)) => return Err(reason),
        Err(Miss::NotYet(_) | Miss::OtherCase(_)) => {}
    }
    was_cancelled()?;
    open_editor(dev.editor_url())?;
    let opened = Instant::now();
    let deadline = opened + timing.timeout;
    loop {
        std::thread::sleep(timing.poll);
        was_cancelled()?;
        match find_daemon(look, &dev.folder, connect, false) {
            Ok(remote) => return was_cancelled().map(|()| remote),
            Err(Miss::Final(reason)) => return Err(reason),
            Err(Miss::OtherCase(hint)) if opened.elapsed() > timing.other_case_grace => return Err(hint),
            Err(Miss::NotYet(last) | Miss::OtherCase(last)) if Instant::now() > deadline => {
                return Err(format!(
                    "Trackwall did not answer from the container within {} minutes. Last: {last}",
                    timing.timeout.as_secs() / 60
                ))
            }
            Err(Miss::NotYet(_) | Miss::OtherCase(_)) => {}
        }
    }
}

/// One start at a time, which choosing another daemon cancels, so a start finishing late never overrides the choice.
#[derive(Default)]
pub struct DevContainerStart {
    running: AtomicBool,
    cancelled: Arc<AtomicBool>,
}

impl DevContainerStart {
    /// Ends a start in progress; called when the user picks a daemon some other way.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// Frees the start slot however the command ends, also when the window drops it halfway.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// The saved dev container, or `None` when the user has not set one.
#[tauri::command]
pub fn dev_container(app: AppHandle) -> Option<DevContainer> {
    load(&app)
}

/// Saves the dev container (`None` forgets it); its folder has to hold a dev container configuration now.
#[tauri::command]
pub fn set_dev_container(app: AppHandle, dev: Option<DevContainer>) -> Result<(), String> {
    let file = json_file::config_file(&app, FILE).ok_or("the system gives the app no configuration directory")?;
    let Some(dev) = dev.map(|d| DevContainer { folder: normalize(&d.folder, cfg!(windows)), open: d.open.trim().to_owned() }) else {
        return match std::fs::remove_file(&file) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {err}", file.display())),
            _ => Ok(()),
        };
    };
    check(&dev)?;
    if !has_configuration(Path::new(&dev.folder)) {
        return Err(format!("{} has no .devcontainer/devcontainer.json.", dev.folder));
    }
    json_file::save(&file, &dev).map_err(|e| format!("{}: {e}", file.display()))
}

/// Whether a start is waiting for the dev container, also one a window began before it reloaded or another window began.
#[tauri::command]
pub fn dev_container_starting(starting: tauri::State<'_, DevContainerStart>) -> bool {
    starting.is_running()
}

/// Ends the start in progress, so the user need not wait out `START_TIMEOUT` when VS Code failed in a window they did not
/// watch; the start answers that it was cancelled once the Docker call in progress returns (at most `DOCKER_TIMEOUT`).
#[tauri::command]
pub fn cancel_dev_container_start(starting: tauri::State<'_, DevContainerStart>) {
    starting.cancel();
}

/// Starts the dev container, or finds it running, and switches the app to the Trackwall daemon in it; the app restarts.
#[tauri::command]
pub async fn start_dev_container(
    app: AppHandle,
    state: tauri::State<'_, Arc<DaemonState>>,
    starting: tauri::State<'_, DevContainerStart>,
) -> Result<(), String> {
    let dev = load(&app).ok_or("Set the dev container's folder first.")?;
    if starting.running.swap(true, Ordering::SeqCst) {
        return Err("The dev container is already starting. Cancel stops that start.".into());
    }
    let _running = Running(&starting.running);
    starting.cancelled.store(false, Ordering::SeqCst);
    let cancelled = Arc::clone(&starting.cancelled);
    let timing = Timing { timeout: START_TIMEOUT, poll: POLL_INTERVAL, other_case_grace: OTHER_CASE_GRACE };
    let open_editor = |url: String| system_open::open_outside(url);
    let found = tauri::async_runtime::spawn_blocking(move || {
        let docker = Docker::system();
        let look = Look { docker: &docker, ignore_case: cfg!(any(windows, target_os = "macos")) };
        start(&look, &dev, &open_editor, &connect_remote, &cancelled, timing)
    })
    .await;
    let remote = found.map_err(|e| e.to_string())??;
    remote_daemon::refuse_own_daemon(&state, &remote)?;
    if starting.is_cancelled() {
        return Err(CANCELLED.into());
    }
    remote_daemon::switch_to(&app, &remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "Zm9vYmFyLWJhei1xdXV4LTAxMjM0NTY3ODktYWJjZGVm";

    fn dev(folder: &str, open: &str) -> DevContainer {
        DevContainer { folder: folder.into(), open: open.into() }
    }

    #[test]
    fn opens_the_address_of_the_users_own_shortcut() {
        let url = dev(r"C:\Dev\ws", "/workspaces").editor_url();
        assert_eq!(url, "vscode://vscode-remote/dev-container+433a5c4465765c7773/workspaces");
    }

    #[test]
    fn takes_a_local_folder_and_a_linux_folder_inside_the_container() {
        assert!(check(&dev(r"C:\Users\me\Dev\work space", "/workspaces")).is_ok());
        assert!(check(&dev("/Users/me/dev", "/workspaces/shop")).is_ok());
        for bad in [
            dev(r"\\wsl.localhost\rancher-desktop\home\me", "/workspaces"),
            dev("Dev", "/workspaces"),
            dev(&format!(r"C:\{}", "a".repeat(1100)), "/workspaces"),
            dev(r"C:\Dev", "workspaces"),
            dev(r"C:\Dev", "/workspaces/../etc"),
            dev(r"C:\Dev", "/workspaces?x"),
            dev(r"C:\Dev", r"\workspaces"),
        ] {
            assert!(check(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn finds_the_container_by_the_folder_it_was_opened_from() {
        let ps = format!("{}\t/home/me/other\n{}\tC:\\Users\\me\\Dev\\ws\n", "a".repeat(64), "b".repeat(64));
        assert_eq!(container_in(&ps, r"C:\Users\me\Dev\ws\", true), Some(Found { id: "b".repeat(64), other_case: None }));
        assert_eq!(container_in(&ps, r"C:\Users\me\Dev\ws", false), Some(Found { id: "b".repeat(64), other_case: None }));
        assert_eq!(container_in("not-hex\t/home/me/dev\n", "/home/me/dev", false), None);
    }

    #[test]
    fn tells_a_container_whose_label_differs_from_the_folder_only_in_case() {
        let ps = format!("{}\tc:\\Users\\me\\Dev\\ws\n", "b".repeat(64));
        let other_case = Some(Found { id: "b".repeat(64), other_case: Some(r"c:\Users\me\Dev\ws".into()) });
        assert_eq!(container_in(&ps, r"C:\Users\me\Dev\ws", true), other_case);
        assert_eq!(container_in(&ps, r"C:\Users\me\Dev\ws", false), None);
    }

    #[test]
    fn prefers_the_container_vs_code_opened_from_the_folder_as_written() {
        let ps = format!("{}\tc:\\Users\\me\\Dev\\ws\n{}\tC:\\Users\\me\\Dev\\ws\n", "a".repeat(64), "b".repeat(64));
        assert_eq!(container_in(&ps, r"C:\Users\me\Dev\ws", true), Some(Found { id: "b".repeat(64), other_case: None }));
    }

    #[test]
    fn reads_the_port_and_token_from_the_daemon_file() {
        let text = format!(r#"{{"pid":12,"port":7700,"token":"{TOKEN}","startedAt":"x","version":"1"}}"#);
        assert_eq!(parse_daemon_file(&text), Some(RemoteDaemon { port: 7700, token: TOKEN.into() }));
        assert_eq!(parse_daemon_file(r#"{"port":7700,"token":"a\r\nb"}"#), None);
        assert_eq!(parse_daemon_file("cat: no such file"), None);
    }

    #[test]
    fn writes_the_folder_with_windows_separators_on_windows_only() {
        assert_eq!(normalize(" C:/Users/me/Dev/ws ", true), r"C:\Users\me\Dev\ws");
        assert_eq!(normalize("/Users/me/dev", false), "/Users/me/dev");
    }

    // A fake `docker` is a shell script, so these run on macOS and Linux. The system branches of the module are
    // parameters tested above (separators, path case) and the Docker program's place and console window, which the
    // manual CI run on Windows and macOS builds.
    #[cfg(unix)]
    mod with_a_fake_docker {
        use super::*;
        use std::cell::{Cell, RefCell};

        struct Fake {
            dir: PathBuf,
            docker: Docker,
        }

        impl Drop for Fake {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        /// `running` marks a started container; `daemon.json` is what `docker exec` prints.
        fn fake(name: &str, docker_up: bool) -> Fake {
            let dir = std::env::temp_dir().join(format!("trackwall-dev-container-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("test directory");
            let d = dir.display();
            let version = if docker_up { "echo 27.0" } else { "echo 'Cannot connect to the Docker daemon' >&2; exit 1" };
            let script = format!(
                "case \"$1\" in\n  version) {version} ;;\n  ps) [ -f {d}/running ] && printf '%s\\t%s\\n' {id} \"$(cat {d}/label 2>/dev/null || echo /home/me/dev)\" ;;\n  exec) [ \"$2\" = {id} ] || exit 1\n    if [ \"$3 $4\" = 'trackwall-container start' ]; then\n      echo >> {d}/started; [ -f {d}/feature ] || exit 127\n      cat {d}/feature; [ -f {d}/feature-starts ] && cp {d}/feature-starts {d}/daemon.json; exit $(cat {d}/feature-code)\n    fi\n    cat {d}/daemon.json ;;\nesac\n",
                id = "c".repeat(64)
            );
            let script_path = dir.join("docker");
            std::fs::write(&script_path, script).expect("fake docker");
            Fake { dir, docker: Docker { program: PathBuf::from("/bin/sh"), script: Some(script_path) } }
        }

        fn run_daemon(fake: &Fake) {
            std::fs::write(fake.dir.join("running"), "").expect("running");
            std::fs::write(fake.dir.join("daemon.json"), format!(r#"{{"pid":1,"port":7700,"token":"{TOKEN}"}}"#)).expect("daemon.json");
        }

        /// The Trackwall Feature in the container: what `trackwall-container start` prints and exits with, and whether
        /// it starts the daemon.
        fn with_feature(fake: &Fake, output: &str, code: i32, starts_daemon: bool) {
            std::fs::write(fake.dir.join("feature"), output).expect("feature");
            std::fs::write(fake.dir.join("feature-code"), code.to_string()).expect("feature-code");
            if starts_daemon {
                std::fs::write(fake.dir.join("feature-starts"), format!(r#"{{"pid":1,"port":7700,"token":"{TOKEN}"}}"#))
                    .expect("feature-starts");
            }
        }

        fn starts(fake: &Fake) -> usize {
            std::fs::read_to_string(fake.dir.join("started")).map(|s| s.lines().count()).unwrap_or(0)
        }

        fn quick() -> Timing {
            Timing { timeout: Duration::from_secs(5), poll: Duration::from_millis(20), other_case_grace: Duration::from_secs(5) }
        }

        /// Paths compared with case, as on Linux.
        fn look(fake: &Fake) -> Look<'_> {
            Look { docker: &fake.docker, ignore_case: false }
        }

        const ACCEPT: Connect = &|_| Ok(());
        static GOING: AtomicBool = AtomicBool::new(false);

        #[test]
        fn connects_to_the_daemon_of_a_running_container_without_opening_vs_code() {
            let fake = fake("running", true);
            run_daemon(&fake);
            let opened = Cell::new(false);
            let open = |_| {
                opened.set(true);
                Ok(())
            };

            let remote = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &GOING, quick());

            assert_eq!(remote, Ok(RemoteDaemon { port: 7700, token: TOKEN.into() }));
            assert!(!opened.get());
        }

        #[test]
        fn opens_vs_code_on_the_dev_container_and_waits_for_its_daemon() {
            let fake = fake("stopped", true);
            let opened = RefCell::new(None);
            let open = |url| {
                run_daemon(&fake);
                *opened.borrow_mut() = Some(url);
                Ok(())
            };

            let remote = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &GOING, quick());

            assert_eq!(remote, Ok(RemoteDaemon { port: 7700, token: TOKEN.into() }));
            assert_eq!(opened.into_inner(), Some("vscode://vscode-remote/dev-container+2f686f6d652f6d652f646576/workspaces".into()));
        }

        #[test]
        fn says_to_start_docker_first_and_opens_nothing_while_it_does_not_answer() {
            let fake = fake("no-docker", false);
            let opened = Cell::new(false);
            let open = |_| {
                opened.set(true);
                Ok(())
            };

            let err = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &GOING, quick()).unwrap_err();

            assert!(err.starts_with("Docker does not answer (Cannot connect to the Docker daemon)"), "{err}");
            assert!(!opened.get());
        }

        #[test]
        fn stops_at_once_at_a_daemon_of_another_version_without_opening_vs_code() {
            let fake = fake("other-version", true);
            run_daemon(&fake);
            let opened = Cell::new(false);
            let open = |_| {
                opened.set(true);
                Ok(())
            };
            let other_version: Connect = &|_| Err(Miss::Final("Trackwall in the container is 0.1.0, but this app is 0.2.0.".into()));

            let err = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &open, other_version, &GOING, quick()).unwrap_err();

            assert_eq!(err, "Trackwall in the container is 0.1.0, but this app is 0.2.0.");
            assert!(!opened.get());
        }

        #[test]
        fn gives_up_with_the_last_reason_when_the_daemon_never_answers() {
            let fake = fake("no-answer", true);
            run_daemon(&fake);
            let refuse: Connect = &|_| Err(Miss::NotYet("No Trackwall daemon answers at 127.0.0.1:7700.".into()));
            let timing =
                Timing { timeout: Duration::from_millis(100), poll: Duration::from_millis(20), other_case_grace: Duration::from_secs(5) };

            let err = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &|_| Ok(()), refuse, &GOING, timing).unwrap_err();

            assert!(err.ends_with("Last: No Trackwall daemon answers at 127.0.0.1:7700."), "{err}");
        }

        #[test]
        fn stops_waiting_when_the_user_picks_another_daemon() {
            let fake = fake("cancelled", true);
            let cancelled = AtomicBool::new(false);
            let open = |_| {
                cancelled.store(true, Ordering::SeqCst);
                Ok(())
            };

            let err = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &cancelled, quick()).unwrap_err();

            assert_eq!(err, CANCELLED);
        }

        #[test]
        fn does_not_connect_when_the_user_picked_another_daemon_during_the_look() {
            let fake = fake("cancelled-late", true);
            run_daemon(&fake);
            let cancelled = AtomicBool::new(false);
            let connect_then_cancel = |_: &RemoteDaemon| {
                cancelled.store(true, Ordering::SeqCst);
                Ok(())
            };

            let err = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &|_| Ok(()), &connect_then_cancel, &cancelled, quick());

            assert_eq!(err, Err(CANCELLED.to_owned()));
        }

        /// A container the `devcontainer` CLI made for the folder with another case of its letters, as on Windows.
        fn other_case_container(fake: &Fake) -> Look<'_> {
            std::fs::write(fake.dir.join("running"), "").expect("running");
            std::fs::write(fake.dir.join("label"), "/Home/me/dev").expect("label");
            std::fs::write(fake.dir.join("daemon.json"), format!(r#"{{"pid":1,"port":7700,"token":"{TOKEN}"}}"#)).expect("daemon.json");
            Look { docker: &fake.docker, ignore_case: true }
        }

        #[test]
        fn says_to_remove_a_container_vs_code_does_not_reuse_because_its_label_differs_in_case() {
            let fake = fake("other-case", true);
            let look = other_case_container(&fake);
            let opened = Cell::new(false);
            let open = |_| {
                opened.set(true);
                Ok(())
            };
            let not_forwarded: Connect = &|_| Err(Miss::NotYet("No Trackwall daemon answers at 127.0.0.1:7700.".into()));
            let timing =
                Timing { timeout: Duration::from_secs(5), poll: Duration::from_millis(20), other_case_grace: Duration::from_millis(100) };

            let err = start(&look, &dev("/home/me/dev", "/workspaces"), &open, not_forwarded, &GOING, timing).unwrap_err();

            assert!(opened.get(), "VS Code gets its chance to reuse the container first");
            assert_eq!(
                err,
                format!(
                    "A container for this folder is running with the label /Home/me/dev, which differs from /home/me/dev in case, so VS \
                     Code does not reuse it. Remove it with `docker rm -f {}` (this also deletes what it holds outside the mounted \
                     folders) and start again, or open it from the folder it was created from.",
                    "c".repeat(12)
                )
            );
        }

        #[test]
        fn connects_to_a_container_whose_label_differs_in_case_when_its_daemon_answers() {
            let fake = fake("other-case-answers", true);
            let look = other_case_container(&fake);

            let remote = start(&look, &dev("/home/me/dev", "/workspaces"), &|_| Ok(()), ACCEPT, &GOING, quick());

            assert_eq!(remote, Ok(RemoteDaemon { port: 7700, token: TOKEN.into() }));
        }

        #[test]
        fn starts_trackwall_in_a_running_container_whose_daemon_does_not_answer_without_opening_vs_code() {
            let fake = fake("feature-starts", true);
            std::fs::write(fake.dir.join("running"), "").expect("running");
            with_feature(
                &fake,
                r#"{"ok":true,"version":"0.6.0","status":"running","port":7700,"daemon":{"version":"0.6.0","pid":1}}"#,
                0,
                true,
            );
            let opened = Cell::new(false);
            let open = |_| {
                opened.set(true);
                Ok(())
            };

            let remote = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &GOING, quick());

            assert_eq!(remote, Ok(RemoteDaemon { port: 7700, token: TOKEN.into() }));
            assert!(!opened.get());
            assert_eq!(starts(&fake), 1);
        }

        #[test]
        fn says_why_when_trackwall_in_the_container_could_not_start_and_opens_nothing() {
            let fake = fake("feature-fails", true);
            std::fs::write(fake.dir.join("running"), "").expect("running");
            with_feature(
                &fake,
                r#"{"ok":false,"version":"0.6.0","error":{"code":"start-failed","message":"The daemon exited with code 3."}}"#,
                1,
                false,
            );
            let opened = Cell::new(false);
            let open = |_| {
                opened.set(true);
                Ok(())
            };

            let err = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &GOING, quick());

            assert_eq!(err, Err("Trackwall in the container could not start (start-failed): The daemon exited with code 3.".into()));
            assert!(!opened.get());
        }

        #[test]
        fn opens_vs_code_as_before_when_the_container_has_no_trackwall_feature() {
            let fake = fake("no-feature", true);
            std::fs::write(fake.dir.join("running"), "").expect("running");
            let opened = Cell::new(false);
            let open = |_| {
                run_daemon(&fake);
                opened.set(true);
                Ok(())
            };

            let remote = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &GOING, quick());

            assert_eq!(remote, Ok(RemoteDaemon { port: 7700, token: TOKEN.into() }));
            assert!(opened.get());
            assert_eq!(starts(&fake), 1);
        }

        #[test]
        fn goes_on_waiting_when_trackwall_container_start_prints_something_else() {
            let fake = fake("feature-garbled", true);
            std::fs::write(fake.dir.join("running"), "").expect("running");
            with_feature(&fake, "not json", 126, false);
            let timing =
                Timing { timeout: Duration::from_millis(100), poll: Duration::from_millis(20), other_case_grace: Duration::from_secs(5) };

            let err = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &|_| Ok(()), ACCEPT, &GOING, timing).unwrap_err();

            assert!(err.contains("Last: Trackwall's daemon.json in the container"), "{err}");
            assert_eq!(starts(&fake), 1);
        }

        #[test]
        fn runs_trackwall_container_start_only_before_it_opens_vs_code() {
            let fake = fake("feature-once", true);
            std::fs::write(fake.dir.join("running"), "").expect("running");
            with_feature(&fake, r#"{"ok":true,"version":"0.6.0","status":"starting","port":7700}"#, 0, true);
            let refuse: Connect = &|_| Err(Miss::NotYet("No Trackwall daemon answers at 127.0.0.1:7700.".into()));
            let timing =
                Timing { timeout: Duration::from_millis(200), poll: Duration::from_millis(20), other_case_grace: Duration::from_secs(5) };

            let err = start(&look(&fake), &dev("/home/me/dev", "/workspaces"), &|_| Ok(()), refuse, &GOING, timing).unwrap_err();

            assert!(err.ends_with("Last: No Trackwall daemon answers at 127.0.0.1:7700."), "{err}");
            assert_eq!(starts(&fake), 1);
        }
    }
}
