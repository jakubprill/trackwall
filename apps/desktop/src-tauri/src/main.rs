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
            if matches!(*phase, Phase::Starting | Phase::Ready(_)) {
                return;
            }
            *phase = Phase::Starting;
        }
        self.cancel.store(false, Ordering::SeqCst);
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
        // Każda droga wyjścia kończy się tutaj: „Wyjdź” z traya, ale też Cmd+Q i „Zakończ” z Docka na macOS,
        // które idą prosto przez `terminate:` z pominięciem `ExitRequested`. Bez tego daemon zostawał osierocony.
        RunEvent::Exit => {
            let state = handle.state::<Arc<DaemonState>>();
            stop_daemon(&state, daemon::trackwall_home().ok().as_deref());
        }
        _ => {}
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Pokaż Trackwall", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Wyjdź (zatrzymuje daemon)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id("main")
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

/// „Wyjdź” z traya. Daemon zatrzymuje obsługa `RunEvent::Exit`, wspólna dla wszystkich dróg wyjścia.
fn quit_app(app: &AppHandle) {
    app.exit(0);
}

/// Przerywa trwający start i łagodnie zatrzymuje daemon; blokuje, aż daemon przestanie odpowiadać (§5.4).
/// Zapisane połączenie mogło się zestarzeć (daemon wstał ponownie na innym porcie), a nieudany start
/// nie wyklucza, że daemon działa: wtedy szukamy go po `daemon.json` w `home`.
fn stop_daemon(state: &DaemonState, home: Option<&Path>) {
    state.cancel.store(true, Ordering::SeqCst);
    let started = state.wait().ok();
    if started.as_ref().is_some_and(|c| daemon::shutdown(c).is_ok()) {
        return;
    }
    if let Some(conn) = home.and_then(daemon::discover) {
        if let Err(err) = daemon::shutdown(&conn) {
            eprintln!("[desktop] zatrzymanie daemona: {err}");
        }
    }
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
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::mpsc;

    /// Daemon na niby: odpowiada na `/api/health` wersją powłoki, a po `POST /api/daemon/shutdown`
    /// zamyka port, tak jak prawdziwy daemon. Kanał dostaje kolejne linie żądań.
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
                let line = request.lines().next().unwrap_or("").to_owned();
                let body = format!(r#"{{"ok":true,"data":{{"version":"{}"}}}}"#, daemon::VERSION);
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).unwrap();
                let shutdown = line.starts_with("POST /api/daemon/shutdown") && request.contains("Bearer secret");
                tx.send(line).unwrap();
                if shutdown {
                    return;
                }
            }
        });
        (port, rx)
    }

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trackwall-desktop-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn shutdown_requests(rx: &mpsc::Receiver<String>) -> usize {
        rx.try_iter().filter(|line| line.starts_with("POST /api/daemon/shutdown")).count()
    }

    #[test]
    fn exit_stops_daemon_started_by_this_shell() {
        let (port, rx) = fake_daemon();
        let state = DaemonState::default();
        *state.lock() = Phase::Ready(Connection { base_url: format!("http://127.0.0.1:{port}"), token: "secret".into(), port });

        stop_daemon(&state, None);

        assert_eq!(shutdown_requests(&rx), 1);
        assert!(state.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn exit_without_own_start_stops_daemon_found_in_daemon_json() {
        let (port, rx) = fake_daemon();
        let home = temp_home("discover");
        std::fs::write(home.join("daemon.json"), format!(r#"{{"pid":1,"port":{port},"token":"secret"}}"#)).unwrap();

        stop_daemon(&DaemonState::default(), Some(&home));

        assert_eq!(shutdown_requests(&rx), 1);
        std::fs::remove_dir_all(home).unwrap();
    }
}
