//! Starting the dev container from the window (ADR-139): what the user's own shortcut does, without pasting an address.
//! The user saves the folder on this computer that holds the dev container's configuration and the folder inside the
//! container to open. "Start" then opens VS Code on that dev container (`dev-container+`, the address the shortcut opens;
//! the Dev Containers extension starts or builds the container, and forwards the daemon's port while its window is open),
//! finds the running container by the label the extension gives it, reads the daemon's `daemon.json` in it through
//! `docker exec`, checks the daemon like a pasted address (ADR-130) and switches the app to it. The port in `daemon.json`
//! is the one inside the container, which the dev container guide forwards to the same number (`requireLocalPort`);
//! another number fails the check rather than reaching something else.
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

const DOCKER_TIMEOUT: Duration = Duration::from_secs(20);

/// More than Docker prints for `ps` with many containers; a container cannot make the window hold more of `daemon.json`.
const MAX_OUTPUT: u64 = 256 * 1024;

/// The first start builds the image, which can take a while.
const START_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(2);

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
fn normalize(folder: &str) -> String {
    let folder = folder.trim();
    if cfg!(windows) {
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

    /// The command's output, or why it failed; never waits longer than `DOCKER_TIMEOUT`. The output is read while the
    /// command runs, so a long `docker ps` never fills the pipe and stalls it.
    fn run(&self, args: &[&str]) -> Result<String, String> {
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
        if !status.success() {
            return Err(stderr.join().unwrap_or_default().trim().chars().take(300).collect());
        }
        Ok(stdout.join().unwrap_or_default())
    }
}

fn read_in_background(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(MAX_OUTPUT).read_to_string(&mut text);
        }
        text
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

/// The id of the running container opened from `folder`, read from `docker ps` lines of id and label.
fn container_in(ps: &str, folder: &str, ignore_case: bool) -> Option<String> {
    ps.lines().find_map(|line| {
        let (id, label) = line.split_once('\t')?;
        let id_ok = (12..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit());
        (id_ok && same_folder(label, folder, ignore_case)).then(|| id.to_owned())
    })
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
    Final(String),
}

/// The daemon at `remote` accepted, or why not; a daemon of another version is final.
type Connect<'a> = &'a dyn Fn(&RemoteDaemon) -> Result<(), Miss>;

fn connect_remote(remote: &RemoteDaemon) -> Result<(), Miss> {
    match daemon::health(remote.port) {
        Some(version) if version != daemon::VERSION => Err(Miss::Final(format!(
            "Trackwall in the container is {version}, but this app is {}. Update the older one so both are the same version.",
            daemon::VERSION
        ))),
        _ => daemon::connect_remote(remote).map(drop).map_err(Miss::NotYet),
    }
}

/// One look: the container of the folder, the daemon in it, and that daemon accepted by `connect`.
fn find_daemon(docker: &Docker, folder: &str, connect: Connect) -> Result<RemoteDaemon, Miss> {
    let label = format!("{{{{.ID}}}}\t{{{{.Label \"{FOLDER_LABEL}\"}}}}");
    let ps = docker.run(&["ps", "--no-trunc", "--format", &label]).map_err(Miss::NotYet)?;
    let ignore_case = cfg!(any(windows, target_os = "macos"));
    let id =
        container_in(&ps, folder, ignore_case).ok_or_else(|| Miss::NotYet(format!("No container opened from {folder} is running.")))?;
    let text = docker
        .run(&["exec", &id, "sh", "-c", READ_DAEMON_FILE])
        .map_err(|e| Miss::NotYet(format!("Trackwall's daemon.json in the container: {e}")))?;
    let remote =
        parse_daemon_file(&text).ok_or(Miss::NotYet("Trackwall's daemon.json in the container is not one Trackwall writes.".into()))?;
    connect(&remote)?;
    Ok(remote)
}

struct Timing {
    timeout: Duration,
    poll: Duration,
}

/// Connects to the daemon of an already running container, or opens VS Code on the dev container and waits until the
/// daemon in it answers on the forwarded port; `cancelled` ends the wait.
fn start(
    docker: &Docker,
    dev: &DevContainer,
    open_editor: &dyn Fn(String) -> Result<(), String>,
    connect: Connect,
    cancelled: &AtomicBool,
    timing: Timing,
) -> Result<RemoteDaemon, String> {
    docker
        .run(&["version", "--format", "{{.Server.Version}}"])
        .map_err(|e| format!("Docker does not answer ({e}). Start Docker Desktop or Rancher Desktop and try again."))?;
    match find_daemon(docker, &dev.folder, connect) {
        Ok(remote) => return Ok(remote),
        Err(Miss::Final(reason)) => return Err(reason),
        Err(Miss::NotYet(_)) => {}
    }
    open_editor(dev.editor_url())?;
    let deadline = Instant::now() + timing.timeout;
    loop {
        std::thread::sleep(timing.poll);
        if cancelled.load(Ordering::SeqCst) {
            return Err("Starting the dev container was cancelled.".into());
        }
        match find_daemon(docker, &dev.folder, connect) {
            Ok(remote) => return Ok(remote),
            Err(Miss::Final(reason)) => return Err(reason),
            Err(Miss::NotYet(last)) if Instant::now() > deadline => {
                return Err(format!(
                    "Trackwall did not answer from the container within {} minutes. Last: {last}",
                    timing.timeout.as_secs() / 60
                ))
            }
            Err(Miss::NotYet(_)) => {}
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
    let Some(dev) = dev.map(|d| DevContainer { folder: normalize(&d.folder), open: d.open.trim().to_owned() }) else {
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

/// Starts the dev container, or finds it running, and switches the app to the Trackwall daemon in it; the app restarts.
#[tauri::command]
pub async fn start_dev_container(
    app: AppHandle,
    state: tauri::State<'_, Arc<DaemonState>>,
    starting: tauri::State<'_, DevContainerStart>,
) -> Result<(), String> {
    let dev = load(&app).ok_or("Set the dev container's folder first.")?;
    if starting.running.swap(true, Ordering::SeqCst) {
        return Err("The dev container is already starting.".into());
    }
    starting.cancelled.store(false, Ordering::SeqCst);
    let cancelled = Arc::clone(&starting.cancelled);
    let timing = Timing { timeout: START_TIMEOUT, poll: POLL_INTERVAL };
    let open_editor = |url: String| system_open::open_outside(url);
    let found =
        tauri::async_runtime::spawn_blocking(move || start(&Docker::system(), &dev, &open_editor, &connect_remote, &cancelled, timing))
            .await;
    starting.running.store(false, Ordering::SeqCst);
    let remote = found.map_err(|e| e.to_string())??;
    remote_daemon::refuse_own_daemon(&state, &remote)?;
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
        let ps = format!("{}\t/home/me/other\n{}\tc:\\Users\\me\\Dev\\ws\n", "a".repeat(64), "b".repeat(64));
        assert_eq!(container_in(&ps, r"C:\Users\me\Dev\ws\", true), Some("b".repeat(64)));
        assert_eq!(container_in(&ps, r"C:\Users\me\Dev\ws", false), None);
        assert_eq!(container_in("not-hex\t/home/me/dev\n", "/home/me/dev", false), None);
    }

    #[test]
    fn reads_the_port_and_token_from_the_daemon_file() {
        let text = format!(r#"{{"pid":12,"port":7700,"token":"{TOKEN}","startedAt":"x","version":"1"}}"#);
        assert_eq!(parse_daemon_file(&text), Some(RemoteDaemon { port: 7700, token: TOKEN.into() }));
        assert_eq!(parse_daemon_file(r#"{"port":7700,"token":"a\r\nb"}"#), None);
        assert_eq!(parse_daemon_file("cat: no such file"), None);
    }

    // A fake `docker` is a shell script, so these run on macOS and Linux; the rest of the module has no system branches
    // but the Docker program's place and its console window.
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
                "case \"$1\" in\n  version) {version} ;;\n  ps) [ -f {d}/running ] && printf '%s\\t/home/me/dev\\n' {id} ;;\n  exec) [ \"$2\" = {id} ] && cat {d}/daemon.json ;;\nesac\n",
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

        fn quick() -> Timing {
            Timing { timeout: Duration::from_secs(5), poll: Duration::from_millis(20) }
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

            let remote = start(&fake.docker, &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &GOING, quick());

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

            let remote = start(&fake.docker, &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &GOING, quick());

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

            let err = start(&fake.docker, &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &GOING, quick()).unwrap_err();

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

            let err = start(&fake.docker, &dev("/home/me/dev", "/workspaces"), &open, other_version, &GOING, quick()).unwrap_err();

            assert_eq!(err, "Trackwall in the container is 0.1.0, but this app is 0.2.0.");
            assert!(!opened.get());
        }

        #[test]
        fn gives_up_with_the_last_reason_when_the_daemon_never_answers() {
            let fake = fake("no-answer", true);
            run_daemon(&fake);
            let refuse: Connect = &|_| Err(Miss::NotYet("No Trackwall daemon answers at 127.0.0.1:7700.".into()));
            let timing = Timing { timeout: Duration::from_millis(100), poll: Duration::from_millis(20) };

            let err = start(&fake.docker, &dev("/home/me/dev", "/workspaces"), &|_| Ok(()), refuse, &GOING, timing).unwrap_err();

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

            let err = start(&fake.docker, &dev("/home/me/dev", "/workspaces"), &open, ACCEPT, &cancelled, quick()).unwrap_err();

            assert_eq!(err, "Starting the dev container was cancelled.");
        }
    }
}
