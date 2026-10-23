//! Stan połączenia powłoki z daemonem (§5.4): start w tle, czekanie UI na wynik, ponowienie i zatrzymanie.
//! Gwarantuje, że po `stop` powłoka nie uruchomi już daemona, więc żadna droga wyjścia nie zostawi sieroty.

use crate::daemon::{self, Connection};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

#[derive(Clone)]
enum Phase {
    Idle,
    Starting,
    Ready(Connection),
    Failed(String),
    /// Powłoka się zamyka: trwa zatrzymywanie daemona albo już się skończyło. Nowy start jest niemożliwy.
    Stopping,
    Stopped,
}

/// UI czeka na wynik startu komendą `daemon_connection`; tray i drugie uruchomienie mogą start ponowić albo przerwać.
pub struct DaemonState {
    /// Katalog stanu ustalony raz przy starcie powłoki; błąd trafia do UI przy próbie startu.
    home: Result<PathBuf, String>,
    phase: Mutex<Phase>,
    changed: Condvar,
    cancel: AtomicBool,
}

impl DaemonState {
    pub fn new(home: Result<PathBuf, String>) -> Self {
        DaemonState { home, phase: Mutex::new(Phase::Idle), changed: Condvar::new(), cancel: AtomicBool::new(false) }
    }

    /// Uruchamia start w tle, jeśli jeszcze nie startowano albo poprzedni start się nie udał.
    pub fn start(self: &Arc<Self>) {
        {
            let mut phase = self.lock();
            if !matches!(*phase, Phase::Idle | Phase::Failed(_)) {
                return;
            }
            *phase = Phase::Starting;
            // Pod blokadą, żeby nie nadpisać przerwania ustawionego przez `stop`.
            self.cancel.store(false, Ordering::SeqCst);
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let result = me.home.clone().and_then(|home| daemon::ensure_daemon(&home, &me.cancel));
            *me.lock() = match result {
                Ok(conn) => Phase::Ready(conn),
                Err(err) => Phase::Failed(err),
            };
            me.changed.notify_all();
        });
    }

    /// Jak `start`, ale także wtedy, gdy zapisany daemon przestał odpowiadać (np. zakończony spoza aplikacji).
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

    /// Czeka na koniec trwającego startu. `Idle` oznacza, że start nie był zlecony.
    pub fn wait(&self) -> Result<Connection, String> {
        let phase = self.changed.wait_while(self.lock(), |p| matches!(p, Phase::Starting)).unwrap_or_else(|e| e.into_inner());
        match &*phase {
            Phase::Ready(conn) => Ok(conn.clone()),
            Phase::Failed(err) => Err(err.clone()),
            Phase::Idle | Phase::Starting => Err("daemon nie był uruchamiany".into()),
            Phase::Stopping | Phase::Stopped => Err("aplikacja się zamyka".into()),
        }
    }

    /// Przerywa trwający start i łagodnie zatrzymuje daemon; wraca, gdy daemon przestał odpowiadać.
    /// Kolejne wywołania czekają na koniec pierwszego, żeby żadna droga wyjścia nie zakończyła procesu w połowie.
    pub fn stop(&self) {
        let own = {
            let phase = self.lock();
            self.cancel.store(true, Ordering::SeqCst);
            let mut phase = self.changed.wait_while(phase, |p| matches!(p, Phase::Starting)).unwrap_or_else(|e| e.into_inner());
            if matches!(*phase, Phase::Stopping | Phase::Stopped) {
                drop(self.changed.wait_while(phase, |p| matches!(p, Phase::Stopping)).unwrap_or_else(|e| e.into_inner()));
                return;
            }
            // Po czekaniu faza nie jest już `Starting`, więc zostaje tylko pytanie, czy start się udał.
            match std::mem::replace(&mut *phase, Phase::Stopping) {
                Phase::Ready(conn) => Some(conn),
                _ => None,
            }
        };
        self.shutdown(own.as_ref());
        *self.lock() = Phase::Stopped;
        self.changed.notify_all();
    }

    /// Zapisane połączenie mogło się zestarzeć (daemon wstał ponownie na innym porcie), a nieudany start
    /// nie wyklucza, że daemon działa: wtedy szukamy go po `daemon.json`. Ten sam daemon, który nie zdążył się
    /// zatrzymać, nie dostaje drugiego polecenia, bo to tylko podwoiłoby czekanie.
    fn shutdown(&self, own: Option<&Connection>) {
        if let Some(conn) = own {
            match daemon::shutdown(conn) {
                Ok(()) => return,
                Err(err) => eprintln!("[desktop] zatrzymanie daemona: {err}"),
            }
        }
        let other = self.home.as_deref().ok().and_then(daemon::discover).filter(|c| own.is_none_or(|o| o.port != c.port));
        if let Some(conn) = other {
            if let Err(err) = daemon::shutdown(&conn) {
                eprintln!("[desktop] zatrzymanie daemona z daemon.json: {err}");
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, Phase> {
        self.phase.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;

    /// Daemon na niby: odpowiada 200 na każde żądanie z wersją powłoki w health, a po `POST /api/daemon/shutdown`
    /// zamyka port, tak jak prawdziwy daemon. Kanał dostaje całe żądania.
    fn fake_daemon() -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("adres nasłuchu").port();
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
        Err("brak katalogu stanu w teście".into())
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
        std::fs::create_dir_all(&home).expect("katalog testowy");
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
        assert_eq!(state.wait().unwrap_err(), "aplikacja się zamyka");
        assert_eq!(shutdown_requests(&rx).len(), 1);
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

        second.join().expect("drugie zatrzymanie");
    }
}
