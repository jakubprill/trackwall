//! The state of the shell's connection to the daemon (§5.4): start in the background, the UI waiting for the result, retry and stop.
//! Guarantees that after `stop` the shell will not start the daemon again, so no exit path leaves an orphan.
//! With a remote daemon (ADR-130) the same states hold, but "start" only connects and "stop" leaves the daemon running.

use crate::daemon::{self, Connection};
use crate::remote_daemon::RemoteDaemon;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};

/// The answer for a UI that asks for the daemon while the shell is already closing.
const SHELL_EXITING: &str = "the app is quitting";

#[derive(Clone)]
enum Phase {
    /// No start requested yet. `setup` and `restart_if_down` always request one and `stop` ends it, so `wait` on it ends.
    Idle,
    Starting,
    Ready(Connection),
    Failed(String),
    /// The shell is closing: the daemon is being stopped or already has been. A new start is impossible.
    Stopping,
    Stopped,
}

/// The UI waits for the start result with the `daemon_connection` command; the tray and a second launch can retry or cancel the start.
pub struct DaemonState {
    /// The state directory, resolved once when the shell starts; an error reaches the UI on a start attempt.
    home: Result<PathBuf, String>,
    /// Set once in `setup`, before the first start, from the saved file; switching it restarts the app.
    remote: OnceLock<RemoteDaemon>,
    phase: Mutex<Phase>,
    changed: Condvar,
    cancel: AtomicBool,
}

impl DaemonState {
    pub fn new(home: Result<PathBuf, String>) -> Self {
        DaemonState {
            home,
            remote: OnceLock::new(),
            phase: Mutex::new(Phase::Idle),
            changed: Condvar::new(),
            cancel: AtomicBool::new(false),
        }
    }

    /// Makes the shell connect to `remote` instead of starting its own daemon; only before the first start.
    pub fn use_remote(&self, remote: RemoteDaemon) {
        let _ = self.remote.set(remote);
    }

    pub fn remote(&self) -> Option<&RemoteDaemon> {
        self.remote.get()
    }

    /// Starts in the background if there has been no start yet or the previous one failed.
    pub fn start(self: &Arc<Self>) {
        {
            let mut phase = self.lock();
            if !matches!(*phase, Phase::Idle | Phase::Failed(_)) {
                return;
            }
            *phase = Phase::Starting;
            // Under the lock, so as not to overwrite a cancel set by `stop`.
            self.cancel.store(false, Ordering::SeqCst);
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let result = match me.remote.get() {
                Some(remote) => daemon::connect_remote(remote),
                None => me.home.clone().and_then(|home| daemon::ensure_daemon(&home, &me.cancel)),
            };
            *me.lock() = match result {
                Ok(conn) => Phase::Ready(conn),
                Err(err) => {
                    // The first line says what failed; the rest is the startup log, which the daemon's own journal entry covers.
                    if !me.cancel.load(Ordering::SeqCst) {
                        crate::report_error!("starting the daemon: {}", err.lines().next().unwrap_or_default());
                    }
                    Phase::Failed(err)
                }
            };
            me.changed.notify_all();
        });
    }

    /// Like `start`, but also when the saved daemon has stopped answering (for example ended from outside the app).
    pub fn restart_if_down(self: &Arc<Self>) {
        {
            let mut phase = self.lock();
            if let Phase::Ready(conn) = &*phase {
                if daemon::health(conn.port).as_deref() == Some(daemon::VERSION) {
                    return;
                }
                *phase = Phase::Idle;
            }
        }
        self.start();
    }

    /// The connection to a running daemon without waiting; `None` during startup, after an error and while closing.
    pub fn ready(&self) -> Option<Connection> {
        match &*self.lock() {
            Phase::Ready(conn) => Some(conn.clone()),
            _ => None,
        }
    }

    /// Waits for the start to finish, also for one not requested yet: Tauri creates the windows from `tauri.conf.json`
    /// before the `setup` hook that calls `start`, so a fast UI asks while the phase is still `Idle`.
    pub fn wait(&self) -> Result<Connection, String> {
        let phase = self.wait_while(self.lock(), |p| matches!(p, Phase::Idle | Phase::Starting));
        match &*phase {
            Phase::Ready(conn) => Ok(conn.clone()),
            Phase::Failed(err) => Err(err.clone()),
            Phase::Idle | Phase::Starting => unreachable!("wait_while returns only once the start has an outcome"),
            Phase::Stopping | Phase::Stopped => Err(SHELL_EXITING.into()),
        }
    }

    /// Cancels a start in progress and stops the daemon gracefully; returns once the daemon has stopped answering.
    /// A remote daemon is not the app's to stop: it keeps running for its container and its other windows.
    /// Later calls wait for the first one to finish, so that no exit path ends the process halfway.
    pub fn stop(&self) {
        let started = {
            let phase = self.lock();
            self.cancel.store(true, Ordering::SeqCst);
            let mut phase = self.wait_while(phase, |p| matches!(p, Phase::Starting));
            if matches!(*phase, Phase::Stopping | Phase::Stopped) {
                drop(self.wait_while(phase, |p| matches!(p, Phase::Stopping)));
                return;
            }
            // After waiting the phase is no longer `Starting`, so the only question left is whether the start succeeded.
            match std::mem::replace(&mut *phase, Phase::Stopping) {
                Phase::Ready(conn) => Some(conn),
                _ => None,
            }
        };
        if self.remote.get().is_none() {
            eprintln!("[desktop] quitting the app: stopping the daemon");
            self.shutdown(started.as_ref());
        }
        *self.lock() = Phase::Stopped;
        self.changed.notify_all();
    }

    /// The saved connection may be stale (the daemon came up again on another port), and a failed start does not
    /// rule out a running daemon: then we look for it through `daemon.json`. The same daemon that did not stop in time
    /// does not get a second command, because that would only double the waiting.
    fn shutdown(&self, own: Option<&Connection>) {
        if let Some(conn) = own {
            match daemon::shutdown(conn) {
                Ok(()) => return,
                Err(err) => crate::report_error!("stopping the daemon: {err}"),
            }
        }
        let other = self.home.as_deref().ok().and_then(daemon::discover).filter(|c| own.is_none_or(|o| o.port != c.port));
        if let Some(conn) = other {
            if let Err(err) = daemon::shutdown(&conn) {
                crate::report_error!("stopping the daemon from daemon.json: {err}");
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, Phase> {
        self.phase.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wait_while<'a>(&self, guard: MutexGuard<'a, Phase>, condition: impl FnMut(&mut Phase) -> bool) -> MutexGuard<'a, Phase> {
        self.changed.wait_while(guard, condition).unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;

    /// A fake daemon: answers 200 to every request with the shell's version in health, and after `POST /api/daemon/shutdown`
    /// closes the port, like the real daemon. The channel gets whole requests.
    fn fake_daemon() -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("listening address").port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let Ok(n) = stream.read(&mut buf) else { continue };
                let request = String::from_utf8_lossy(&buf[..n]).into_owned();
                let body = format!(r#"{{"ok":true,"data":{{"version":"{}"}}}}"#, daemon::VERSION);
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes());
                let shutdown = request.starts_with("POST /api/daemon/shutdown");
                let _ = tx.send(request);
                if shutdown {
                    return;
                }
            }
        });
        (port, rx)
    }

    fn shutdown_requests(rx: &mpsc::Receiver<String>) -> Vec<String> {
        rx.try_iter().filter(|r| r.starts_with("POST /api/daemon/shutdown")).collect()
    }

    fn port_is_closed(port: u16) -> bool {
        TcpStream::connect(("127.0.0.1", port)).is_err()
    }

    fn no_home() -> Result<PathBuf, String> {
        Err("no state directory in the test".into())
    }

    fn ready(port: u16) -> DaemonState {
        let state = DaemonState::new(no_home());
        *state.lock() = Phase::Ready(Connection { base_url: format!("http://127.0.0.1:{port}"), token: "secret".into(), port });
        state
    }

    #[test]
    fn stop_shuts_down_daemon_started_by_this_shell_with_its_token() {
        let (port, rx) = fake_daemon();
        let state = ready(port);

        state.stop();

        let requests = shutdown_requests(&rx);
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("Authorization: Bearer secret\r\n"));
        assert!(port_is_closed(port));
    }

    #[test]
    fn stop_without_own_start_shuts_down_daemon_from_daemon_json() {
        let (port, rx) = fake_daemon();
        let home = std::env::temp_dir().join(format!("trackwall-desktop-test-{}", std::process::id()));
        std::fs::create_dir_all(&home).expect("test directory");
        std::fs::write(home.join("daemon.json"), format!(r#"{{"pid":1,"port":{port},"token":"secret"}}"#)).expect("daemon.json");
        let state = DaemonState::new(Ok(home.clone()));

        state.stop();
        let _ = std::fs::remove_dir_all(&home);

        let requests = shutdown_requests(&rx);
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("Authorization: Bearer secret\r\n"));
        assert!(port_is_closed(port));
    }

    #[test]
    fn after_stop_shell_neither_starts_daemon_nor_stops_it_again() {
        let (port, rx) = fake_daemon();
        let state = Arc::new(ready(port));
        state.stop();

        state.start();
        state.stop();

        assert!(matches!(*state.lock(), Phase::Stopped));
        assert_eq!(state.wait().unwrap_err(), SHELL_EXITING);
        assert_eq!(shutdown_requests(&rx).len(), 1);
    }

    #[test]
    fn ui_asking_before_the_start_waits_for_its_result() {
        let state = Arc::new(DaemonState::new(no_home()));
        let ui = {
            let state = Arc::clone(&state);
            std::thread::spawn(move || state.wait())
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!ui.is_finished());

        state.start();

        assert_eq!(ui.join().expect("waiting UI").unwrap_err(), "no state directory in the test");
    }

    #[test]
    fn ui_waiting_before_the_start_gets_an_answer_when_the_app_quits() {
        let state = Arc::new(DaemonState::new(no_home()));
        let ui = {
            let state = Arc::clone(&state);
            std::thread::spawn(move || state.wait())
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!ui.is_finished());

        state.stop();

        assert_eq!(ui.join().expect("waiting UI").unwrap_err(), SHELL_EXITING);
    }

    fn remote(port: u16, token: &str) -> RemoteDaemon {
        RemoteDaemon { port, token: token.into() }
    }

    #[test]
    fn with_a_remote_daemon_start_connects_to_it_with_its_token() {
        let (port, rx) = fake_daemon();
        let state = Arc::new(DaemonState::new(no_home()));
        state.use_remote(remote(port, "secret"));

        state.start();

        let conn = state.wait().expect("connection to the remote daemon");
        assert_eq!((conn.base_url, conn.token), (format!("http://127.0.0.1:{port}"), "secret".to_owned()));
        assert!(rx.try_iter().any(|r| r.starts_with("GET /api/daemon/info") && r.contains("Authorization: Bearer secret\r\n")));
    }

    #[test]
    fn quitting_the_app_leaves_a_remote_daemon_running() {
        let (port, rx) = fake_daemon();
        let state = Arc::new(DaemonState::new(no_home()));
        state.use_remote(remote(port, "secret"));
        state.start();
        state.wait().expect("connection to the remote daemon");

        state.stop();

        assert!(shutdown_requests(&rx).is_empty());
        assert!(!port_is_closed(port));
        assert_eq!(state.wait().unwrap_err(), SHELL_EXITING);
    }

    #[test]
    fn a_remote_daemon_that_rejects_the_token_fails_the_start_with_a_reason() {
        let port = rejecting_daemon();
        let state = Arc::new(DaemonState::new(no_home()));
        state.use_remote(remote(port, "old"));

        state.start();

        assert!(state.wait().unwrap_err().contains("did not accept the token"));
    }

    #[test]
    fn a_remote_daemon_nobody_answers_for_fails_the_start_with_a_reason() {
        let port = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0").local_addr().expect("address").port();
        let state = Arc::new(DaemonState::new(no_home()));
        state.use_remote(remote(port, "secret"));

        state.start();

        assert!(state.wait().unwrap_err().contains(&format!("No Trackwall daemon answers at 127.0.0.1:{port}")));
    }

    /// A daemon of the shell's version that answers health and rejects every token, like one restarted with a new token.
    fn rejecting_daemon() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("listening address").port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let Ok(n) = stream.read(&mut buf) else { continue };
                let health = String::from_utf8_lossy(&buf[..n]).starts_with("GET /api/health");
                let (status, body) = if health {
                    ("200 OK", format!(r#"{{"ok":true,"data":{{"version":"{}"}}}}"#, daemon::VERSION))
                } else {
                    ("401 Unauthorized", r#"{"ok":false}"#.to_owned())
                };
                let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes());
            }
        });
        port
    }

    #[test]
    fn second_stop_waits_until_first_one_finishes() {
        let state = Arc::new(DaemonState::new(no_home()));
        *state.lock() = Phase::Stopping;
        let second = {
            let state = Arc::clone(&state);
            std::thread::spawn(move || state.stop())
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!second.is_finished());

        *state.lock() = Phase::Stopped;
        state.changed.notify_all();

        second.join().expect("second stop");
    }
}
