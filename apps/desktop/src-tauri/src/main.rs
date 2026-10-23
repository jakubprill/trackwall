//! Powłoka desktopowa Pitwall: okno, tray i nadzór daemona. Cała logika żyje w daemonie (§2, §5.4).

// Bez okna konsoli w wydaniu na Windowsie.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;

use daemon::Connection;
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
            let result = daemon::pitwall_home().and_then(|home| daemon::ensure_daemon(&home, &me.cancel));
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
            "Pitwall potrzebuje Microsoft Edge WebView2 Runtime, którego nie znaleziono ({err}).\n\n\
             Zainstaluj go ze strony https://developer.microsoft.com/microsoft-edge/webview2/ \
             albo uruchom pitwall-daemon.exe --ui, żeby otworzyć Pitwall w przeglądarce."
        ));
        std::process::exit(1);
    }

    let state = Arc::new(DaemonState::default());
    let builder = tauri::Builder::default();
    // Ponowne uruchomienie pitwall.exe pokazuje istniejące okno zamiast drugiej powłoki i drugiej ikony w trayu.
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
            build_tray(app.handle())?;
            Ok(())
        })
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
            // Ostatnie okno schowane to nie powód do wyjścia; wyjście tylko z traya.
            api.prevent_exit();
        }
        _ => {
            let _ = handle;
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Pokaż Pitwall", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Wyjdź (zatrzymuje daemon)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Pitwall")
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
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// „Wyjdź” z traya: przerwanie trwającego startu, łagodne zatrzymanie daemona, potem koniec procesu okna.
fn quit_app(app: &AppHandle) {
    let state = Arc::clone(app.state::<Arc<DaemonState>>().inner());
    let app = app.clone();
    std::thread::spawn(move || {
        state.cancel.store(true, Ordering::SeqCst);
        let started = state.wait().ok();
        // Zapisane połączenie mogło się zestarzeć (daemon wstał ponownie na innym porcie), a nieudany start
        // nie wyklucza, że daemon działa: wtedy szukamy go po daemon.json.
        let stopped = started.as_ref().is_some_and(|c| daemon::shutdown(c).is_ok());
        if !stopped {
            if let Some(conn) = daemon::pitwall_home().ok().and_then(|home| daemon::discover(&home)) {
                if let Err(err) = daemon::shutdown(&conn) {
                    eprintln!("[desktop] zatrzymanie daemona: {err}");
                }
            }
        }
        app.exit(0);
    });
}

#[cfg(windows)]
fn windows_alert(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(text), wide("Pitwall"));
    // SAFETY: oba bufory są zakończone zerem i żyją do końca wywołania.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
}
