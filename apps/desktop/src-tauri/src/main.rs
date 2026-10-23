//! Powłoka desktopowa Trackwall: okno, tray i nadzór daemona. Cała logika żyje w daemonie (§2, §5.4).

// Bez okna konsoli w wydaniu na Windowsie.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;
mod window_effect;

use daemon::Connection;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

/// Stan połączenia z daemonem widziany przez powłokę.
#[derive(Clone, Default)]
enum Phase {
    #[default]
    Idle,
    Starting,
    Ready(Connection),
    Failed(String),
    /// Powłoka się zamyka i daemon został zatrzymany; nowy start jest już niemożliwy.
    Stopped,
}

/// UI czeka na wynik startu komendą `daemon_connection`; tray i drugie uruchomienie mogą start ponowić albo przerwać.
#[derive(Default)]
struct DaemonState {
    phase: Mutex<Phase>,
    changed: Condvar,
    cancel: AtomicBool,
}

impl DaemonState {
    /// Uruchamia start w tle, jeśli jeszcze nie startowano albo poprzedni start się nie udał.
    fn start(self: &Arc<Self>) {
        {
            let mut phase = self.lock();
            if matches!(*phase, Phase::Starting | Phase::Ready(_) | Phase::Stopped) {
                return;
            }
            *phase = Phase::Starting;
            // Pod blokadą, żeby nie nadpisać przerwania ustawionego przez `stop`.
            self.cancel.store(false, Ordering::SeqCst);
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let result = daemon::trackwall_home().and_then(|home| daemon::ensure_daemon(&home, &me.cancel));
            *me.lock() = match result {
                Ok(conn) => Phase::Ready(conn),
                Err(err) => Phase::Failed(err),
            };
            me.changed.notify_all();
        });
    }

    /// Jak `start`, ale także wtedy, gdy zapisany daemon przestał odpowiadać (np. zakończony spoza aplikacji).
    fn restart_if_down(self: &Arc<Self>) {
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
    fn wait(&self) -> Result<Connection, String> {
        let phase = self.changed.wait_while(self.lock(), |p| matches!(p, Phase::Starting)).unwrap_or_else(|e| e.into_inner());
        match &*phase {
            Phase::Ready(conn) => Ok(conn.clone()),
            Phase::Failed(err) => Err(err.clone()),
            Phase::Idle | Phase::Starting => Err("daemon nie był uruchamiany".into()),
            Phase::Stopped => Err("aplikacja się zamyka".into()),
        }
    }

    /// Przerywa trwający start i łagodnie zatrzymuje daemon; blokuje, aż daemon przestanie odpowiadać (§5.4).
    /// Działa raz: kolejne wywołania i późniejsze `start` nic nie robią, więc żadna droga wyjścia nie zostawi
    /// daemona uruchomionego w trakcie zamykania. Zapisane połączenie mogło się zestarzeć (daemon wstał ponownie
    /// na innym porcie), a nieudany start nie wyklucza, że daemon działa: wtedy szukamy go po `daemon.json` w `home`.
    fn stop(&self, home: Option<&Path>) {
        let previous = {
            let phase = self.lock();
            self.cancel.store(true, Ordering::SeqCst);
            let mut phase = self.changed.wait_while(phase, |p| matches!(p, Phase::Starting)).unwrap_or_else(|e| e.into_inner());
            std::mem::replace(&mut *phase, Phase::Stopped)
        };
        self.changed.notify_all();
        let stopped = match previous {
            Phase::Stopped => return,
            Phase::Ready(conn) => daemon::shutdown(&conn).is_ok(),
            Phase::Idle | Phase::Starting | Phase::Failed(_) => false,
        };
        if stopped {
            return;
        }
        if let Some(conn) = home.and_then(daemon::discover) {
            if let Err(err) = daemon::shutdown(&conn) {
                eprintln!("[desktop] zatrzymanie daemona: {err}");
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Phase> {
        self.phase.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Adres i token daemona dla UI. Token przechodzi przez IPC Tauri, nigdy przez URL (§5.2).
#[tauri::command]
async fn daemon_connection(state: tauri::State<'_, Arc<DaemonState>>) -> Result<Connection, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.wait()).await.map_err(|e| e.to_string())?
}

/// Ponowny start po błędzie albo po zniknięciu daemona (przycisk „Spróbuj ponownie” w UI).
#[tauri::command]
async fn retry_daemon(state: tauri::State<'_, Arc<DaemonState>>) -> Result<Connection, String> {
    let state = Arc::clone(&state);
    let restarter = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || restarter.restart_if_down()).await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || state.wait()).await.map_err(|e| e.to_string())?
}

fn main() {
    #[cfg(windows)]
    if let Err(err) = tauri::webview_version() {
        windows_alert(&format!(
            "Trackwall potrzebuje Microsoft Edge WebView2 Runtime, którego nie znaleziono ({err}).\n\n\
             Zainstaluj go ze strony https://developer.microsoft.com/microsoft-edge/webview2/ \
             albo uruchom trackwall-daemon.exe --ui, żeby otworzyć Trackwall w przeglądarce."
        ));
        std::process::exit(1);
    }

    let state = Arc::new(DaemonState::default());
    let builder = tauri::Builder::default();
    // Ponowne uruchomienie trackwall.exe pokazuje istniejące okno zamiast drugiej powłoki i drugiej ikony w trayu.
    // Tylko w wydaniu: identyfikator instancji jest wspólny, a `tauri dev` ma działać obok zainstalowanej aplikacji.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        let state = Arc::clone(app.state::<Arc<DaemonState>>().inner());
        std::thread::spawn(move || state.restart_if_down());
        show_main(app);
    }));
    let app = builder
        .manage(Arc::clone(&state))
        .invoke_handler(tauri::generate_handler![daemon_connection, retry_daemon])
        .setup(move |app| {
            state.start();
            let window = app.get_webview_window("main").ok_or("brak okna main z tauri.conf.json")?;
            app.manage(window_effect::apply(&window));
            window_effect::reveal_fallback(app.handle(), show_main);
            build_tray(app.handle())?;
            Ok(())
        })
        .on_page_load(|webview, payload| window_effect::on_page_load(webview, payload, show_main))
        .on_window_event(|window, event| {
            // Zamknięcie okna chowa je do traya; daemon i serwisy działają dalej.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("nie udało się zbudować aplikacji Tauri");

    app.run(|handle, event| match event {
        // macOS: kliknięcie w ikonę w Docku po schowaniu okna.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(handle),
        RunEvent::ExitRequested { code: None, api, .. } => {
            // Ostatnie okno schowane to nie powód do wyjścia.
            api.prevent_exit();
        }
        // Cmd+Q i „Zakończ” z Docka na macOS oraz wylogowanie na Windows kończą pętlę zdarzeń z pominięciem
        // `ExitRequested` i traya. Bez tego daemon zostawał osierocony. Po „Wyjdź” z traya daemon jest już zatrzymany.
        RunEvent::Exit => {
            // Pętla zdarzeń już stoi: bez schowania okno i tray wisiałyby zamrożone do końca zatrzymywania.
            for window in handle.webview_windows().values() {
                let _ = window.hide();
            }
            let _ = handle.remove_tray_by_id(TRAY_ID);
            handle.state::<Arc<DaemonState>>().stop(daemon::trackwall_home().ok().as_deref());
        }
        _ => {}
    });
}

const TRAY_ID: &str = "main";

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Pokaż Trackwall", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Wyjdź (zatrzymuje daemon)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Trackwall")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    // Okno pokazane z traya przed końcem ładowania strony nie wyskoczy drugi raz po załadowaniu.
    if let Some(applied) = app.try_state::<window_effect::AppliedEffect>() {
        applied.mark_revealed();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// „Wyjdź” z traya: zatrzymanie daemona w tle, żeby okno i tray odpowiadały, a pojedyncza instancja
/// była trzymana do końca; potem koniec procesu okna.
fn quit_app(app: &AppHandle) {
    let state = Arc::clone(app.state::<Arc<DaemonState>>().inner());
    let app = app.clone();
    std::thread::spawn(move || {
        state.stop(daemon::trackwall_home().ok().as_deref());
        app.exit(0);
    });
}

#[cfg(windows)]
fn windows_alert(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(text), wide("Trackwall"));
    // SAFETY: oba bufory są zakończone zerem i żyją do końca wywołania.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::mpsc;

    /// Daemon na niby: odpowiada 200 na każde żądanie z wersją powłoki w health, a po `POST /api/daemon/shutdown`
    /// zamyka port, tak jak prawdziwy daemon. Kanał dostaje całe żądania.
    fn fake_daemon() -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..n]).into_owned();
                let body = format!(r#"{{"ok":true,"data":{{"version":"{}"}}}}"#, daemon::VERSION);
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).unwrap();
                let shutdown = request.starts_with("POST /api/daemon/shutdown");
                tx.send(request).unwrap();
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

    fn ready(port: u16) -> DaemonState {
        let state = DaemonState::default();
        *state.lock() = Phase::Ready(Connection { base_url: format!("http://127.0.0.1:{port}"), token: "secret".into(), port });
        state
    }

    #[test]
    fn stop_shuts_down_daemon_started_by_this_shell_with_its_token() {
        let (port, rx) = fake_daemon();
        let state = ready(port);

        state.stop(None);

        let requests = shutdown_requests(&rx);
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("Authorization: Bearer secret\r\n"));
        assert!(port_is_closed(port));
    }

    #[test]
    fn stop_without_own_start_shuts_down_daemon_from_daemon_json() {
        let (port, rx) = fake_daemon();
        let home: PathBuf = std::env::temp_dir().join(format!("trackwall-desktop-test-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("daemon.json"), format!(r#"{{"pid":1,"port":{port},"token":"secret"}}"#)).unwrap();

        DaemonState::default().stop(Some(&home));
        std::fs::remove_dir_all(&home).unwrap();

        let requests = shutdown_requests(&rx);
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("Authorization: Bearer secret\r\n"));
        assert!(port_is_closed(port));
    }

    #[test]
    fn after_stop_shell_neither_starts_daemon_nor_stops_it_again() {
        let (port, rx) = fake_daemon();
        let state = Arc::new(ready(port));
        state.stop(None);

        state.start();
        state.stop(None);

        assert!(matches!(*state.lock(), Phase::Stopped));
        assert_eq!(state.wait().unwrap_err(), "aplikacja się zamyka");
        assert_eq!(shutdown_requests(&rx).len(), 1);
    }
}
