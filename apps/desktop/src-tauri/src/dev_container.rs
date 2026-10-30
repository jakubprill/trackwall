//! Starting the dev container from the window (ADR-139): what the user's own shortcut does, without pasting an address.
//! The user saves the folder on this computer that holds the dev container's configuration and the folder inside the
//! container to open. "Start" then opens VS Code on that dev container (`dev-container+`, the address the shortcut opens;
//! the Dev Containers extension starts or builds the container, and forwards the daemon's port while its window is open),
//! finds the running container by the label the extension gives it, reads the daemon's `daemon.json` in it through
//! `docker exec`, checks the daemon like a pasted address (ADR-130) and switches the app to it.
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

/// The first start builds the image, which can take a while.
const START_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The folder with the dev container's configuration and the folder inside the container VS Code opens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DevContainer {
    pub folder: String,
    pub open: String,
}

/// The folder as `open_outside` accepts it for a `dev-container+` address: a plain local path. The folder inside the
/// container is a Linux path that the address carries as it is.
fn check(dev: &DevContainer) -> Result<(), String> {
    if !system_open::is_local_folder(&dev.folder) || dev.folder.contains('"') {
        return Err("Enter the full path of a folder on this computer, such as C:\\Users\\me\\Dev\\workspace.".into());
    }
    let open_ok = dev.open.starts_with('/')
        && dev.open.len() <= 256
        && dev.open.chars().all(|c| c >= ' ' && !matches!(c, '\\' | '?' | '#' | '%'))
        && !dev.open.split('/').any(|s| s == "." || s == "..");
    if !open_ok {
        return Err("Enter the folder to open inside the container as a Linux path, such as /workspaces.".into());
    }
    Ok(())
}

/// Saved only with a configuration in it, so a typo shows at once rather than as a container that never starts.
fn has_configuration(folder: &Path) -> bool {
    folder.join(".devcontainer").join("devcontainer.json").is_file() || folder.join(".devcontainer.json").is_file()
}

/// The address the user's shortcut opens: the folder in hex, as `devContainerEditorUrl` in protocol builds it.
fn editor_url(dev: &DevContainer) -> String {
    let hex: String = dev.folder.bytes().map(|b| format!("{b:02x}")).collect();
    format!("vscode://vscode-remote/dev-container+{hex}{}", dev.open)
}

fn load(app: &AppHandle) -> Option<DevContainer> {
    let path = json_file::config_file(app, FILE)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<DevContainer>(&text).ok().filter(|dev| check(dev).is_ok())
}

/// The Docker command line. A window started from Finder on macOS gets no shell `PATH`, so the usual places come first.
struct Docker {
    program: PathBuf,
    /// Arguments before Docker's own: the script of a fake `docker` run by `sh` in tests, which cannot fail with "text
    /// file busy" the way running a script just written can while other tests start processes.
    leading: Vec<PathBuf>,
}

impl Docker {
    fn system() -> Docker {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let candidates = if cfg!(target_os = "macos") {
            vec![
                PathBuf::from("/usr/local/bin/docker"),
                PathBuf::from("/opt/homebrew/bin/docker"),
                home.join(".docker").join("bin").join("docker"),
                home.join(".rd").join("bin").join("docker"),
            ]
        } else {
            Vec::new()
        };
        let program = candidates.into_iter().find(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("docker"));
        Docker { program, leading: Vec::new() }
    }

    /// The command's output, or why it failed; never waits longer than `DOCKER_TIMEOUT`.
    fn run(&self, args: &[&str]) -> Result<String, String> {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.leading).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("docker could not start: {e}"))?;
        let deadline = Instant::now() + DOCKER_TIMEOUT;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err(format!("docker {} did not answer within {} s", args[0], DOCKER_TIMEOUT.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        if !status.success() {
            return Err(read_all(child.stderr.take()).trim().chars().take(300).collect());
        }
        Ok(read_all(child.stdout.take()))
    }
}

/// The few lines Docker prints fit the pipe, so they are read after it exits.
fn read_all(pipe: Option<impl Read>) -> String {
    let mut text = String::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_string(&mut text);
    }
    text
}

/// Windows compares paths without case, and the extension may write the drive letter in either case.
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

/// One look: the container of the folder, the daemon in it, and that daemon accepted by `connect`.
fn find_daemon(docker: &Docker, folder: &str, connect: &dyn Fn(&RemoteDaemon) -> Result<(), String>) -> Result<RemoteDaemon, String> {
    let label = format!("{{{{.ID}}}}\t{{{{.Label \"{FOLDER_LABEL}\"}}}}");
    let ps = docker.run(&["ps", "--no-trunc", "--format", &label])?;
    let id = container_in(&ps, folder, cfg!(windows)).ok_or_else(|| format!("No container opened from {folder} is running."))?;
    let text =
        docker.run(&["exec", &id, "sh", "-c", READ_DAEMON_FILE]).map_err(|e| format!("Trackwall's daemon.json in the container: {e}"))?;
    let remote = parse_daemon_file(&text).ok_or("Trackwall's daemon.json in the container is not one Trackwall writes.")?;
    connect(&remote)?;
    Ok(remote)
}

struct Timing {
    timeout: Duration,
    poll: Duration,
}

/// Connects to the daemon of an already running container, or opens VS Code on the dev container and waits until the
/// daemon in it answers on the forwarded port.
fn start(
    docker: &Docker,
    dev: &DevContainer,
    open_editor: impl FnOnce(String) -> Result<(), String>,
    connect: &dyn Fn(&RemoteDaemon) -> Result<(), String>,
    timing: Timing,
) -> Result<RemoteDaemon, String> {
    docker
        .run(&["version", "--format", "{{.Server.Version}}"])
        .map_err(|e| format!("Docker does not answer ({e}). Start Docker Desktop or Rancher Desktop and try again."))?;
    if let Ok(remote) = find_daemon(docker, &dev.folder, connect) {
        return Ok(remote);
    }
    open_editor(editor_url(dev))?;
    let deadline = Instant::now() + timing.timeout;
    loop {
        std::thread::sleep(timing.poll);
        match find_daemon(docker, &dev.folder, connect) {
            Ok(remote) => return Ok(remote),
            Err(last) if Instant::now() > deadline => {
                return Err(format!(
                    "Trackwall did not answer from the container within {} minutes. Last: {last}",
                    timing.timeout.as_secs() / 60
                ))
            }
            Err(_) => {}
        }
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
    let Some(dev) = dev.map(|d| DevContainer { folder: d.folder.trim().to_owned(), open: d.open.trim().to_owned() }) else {
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
pub async fn start_dev_container(app: AppHandle, state: tauri::State<'_, Arc<DaemonState>>) -> Result<(), String> {
    let dev = load(&app).ok_or("Set the dev container's folder first.")?;
    let timing = Timing { timeout: START_TIMEOUT, poll: POLL_INTERVAL };
    let connect = |remote: &RemoteDaemon| daemon::connect_remote(remote).map(drop);
    let remote = tauri::async_runtime::spawn_blocking(move || start(&Docker::system(), &dev, system_open::open_outside, &connect, timing))
        .await
        .map_err(|e| e.to_string())??;
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
        let url = editor_url(&dev(r"C:\Dev\ws", "/workspaces"));
        assert_eq!(url, "vscode://vscode-remote/dev-container+433a5c4465765c7773/workspaces");
    }

    #[test]
    fn takes_a_local_folder_and_a_linux_folder_inside_the_container() {
        assert!(check(&dev(r"C:\Users\me\Dev\work space", "/workspaces")).is_ok());
        assert!(check(&dev("/Users/me/dev", "/workspaces/shop")).is_ok());
        for bad in [
            dev(r"\\wsl.localhost\rancher-desktop\home\me", "/workspaces"),
            dev("Dev", "/workspaces"),
            dev(r#"C:\a"b"#, "/workspaces"),
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
    // but the Docker program's place.
    #[cfg(unix)]
    mod with_a_fake_docker {
        use super::*;
        use std::cell::Cell;

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
                "#!/bin/sh\ncase \"$1\" in\n  version) {version} ;;\n  ps) [ -f {d}/running ] && printf '%s\\t/home/me/dev\\n' {id} ;;\n  exec) [ \"$2\" = {id} ] && cat {d}/daemon.json ;;\nesac\n",
                id = "c".repeat(64)
            );
            let script_path = dir.join("docker");
            std::fs::write(&script_path, script).expect("fake docker");
            Fake { dir, docker: Docker { program: PathBuf::from("/bin/sh"), leading: vec![script_path] } }
        }

        fn run_daemon(fake: &Fake) {
            std::fs::write(fake.dir.join("running"), "").expect("running");
            std::fs::write(fake.dir.join("daemon.json"), format!(r#"{{"pid":1,"port":7700,"token":"{TOKEN}"}}"#)).expect("daemon.json");
        }

        fn quick() -> Timing {
            Timing { timeout: Duration::from_secs(5), poll: Duration::from_millis(20) }
        }

        const ACCEPT: &dyn Fn(&RemoteDaemon) -> Result<(), String> = &|_| Ok(());

        #[test]
        fn connects_to_the_daemon_of_a_running_container_without_opening_vs_code() {
            let fake = fake("running", true);
            run_daemon(&fake);
            let opened = Cell::new(false);

            let remote = start(
                &fake.docker,
                &dev("/home/me/dev", "/workspaces"),
                |_| {
                    opened.set(true);
                    Ok(())
                },
                ACCEPT,
                quick(),
            );

            assert_eq!(remote, Ok(RemoteDaemon { port: 7700, token: TOKEN.into() }));
            assert!(!opened.get());
        }

        #[test]
        fn opens_vs_code_on_the_dev_container_and_waits_for_its_daemon() {
            let fake = fake("stopped", true);
            let opened = std::cell::RefCell::new(None);

            let remote = start(
                &fake.docker,
                &dev("/home/me/dev", "/workspaces"),
                |url| {
                    run_daemon(&fake);
                    *opened.borrow_mut() = Some(url);
                    Ok(())
                },
                ACCEPT,
                quick(),
            );

            assert_eq!(remote, Ok(RemoteDaemon { port: 7700, token: TOKEN.into() }));
            assert_eq!(opened.into_inner(), Some("vscode://vscode-remote/dev-container+2f686f6d652f6d652f646576/workspaces".into()));
        }

        #[test]
        fn says_to_start_docker_first_and_opens_nothing_while_it_does_not_answer() {
            let fake = fake("no-docker", false);
            let opened = Cell::new(false);

            let err = start(
                &fake.docker,
                &dev("/home/me/dev", "/workspaces"),
                |_| {
                    opened.set(true);
                    Ok(())
                },
                ACCEPT,
                quick(),
            )
            .unwrap_err();

            assert!(err.starts_with("Docker does not answer (Cannot connect to the Docker daemon)"), "{err}");
            assert!(!opened.get());
        }

        #[test]
        fn gives_up_with_the_last_reason_when_the_daemon_never_answers() {
            let fake = fake("no-answer", true);
            run_daemon(&fake);
            let refuse: &dyn Fn(&RemoteDaemon) -> Result<(), String> = &|_| Err("No Trackwall daemon answers at 127.0.0.1:7700.".into());
            let timing = Timing { timeout: Duration::from_millis(100), poll: Duration::from_millis(20) };

            let err = start(&fake.docker, &dev("/home/me/dev", "/workspaces"), |_| Ok(()), refuse, timing).unwrap_err();

            assert!(err.ends_with("Last: No Trackwall daemon answers at 127.0.0.1:7700."), "{err}");
        }
    }
}
