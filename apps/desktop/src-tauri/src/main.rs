//! Powłoka desktopowa Pitwall: okno, tray i nadzór daemona. Cała logika żyje w daemonie (§2, §5.4).

// Bez okna konsoli w wydaniu na Windowsie.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;

use daemon::Connection;
use std::sync::{Arc, Condvar, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

/// Wynik startu daemona; UI czeka na niego komendą `daemon_connection`.
#[derive(Default)]
struct DaemonState {
    result: Mutex<Option<Result<Connection, String>>>,
    ready: Condvar,
}

impl DaemonState {
    fn set(&self, r: Result<Connection, String>) {
        *self.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
        self.ready.notify_all();
    }

    fn wait(&self) -> Result<Connection, String> {
        let guard = self.result.lock().unwrap_or_else(|e| e.into_inner());
        let guard = self.ready.wait_while(guard, |r| r.is_none()).unwrap_or_else(|e| e.into_inner());
        guard.clone().unwrap_or_else(|| Err("brak wyniku startu daemona".into()))
    }

    fn current(&self) -> Option<Connection> {
        self.result.lock().unwrap_or_else(|e| e.into_inner()).clone().and_then(Result::ok)
    }
}

/// Adres i token daemona dla UI. Token przechodzi przez IPC Tauri, nigdy przez URL (§5.2).
#[tauri::command]
async fn daemon_connection(state: tauri::State<'_, Arc<DaemonState>>) -> Result<Connection, String> {
    let state = Arc::clone(&state);
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
    let app = tauri::Builder::default()
        // Ponowne uruchomienie pitwall.exe pokazuje istniejące okno zamiast drugiej powłoki i drugiej ikony w trayu.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .manage(Arc::clone(&state))
        .invoke_handler(tauri::generate_handler![daemon_connection])
        .setup(move |app| {
            let starter = Arc::clone(&state);
            std::thread::spawn(move || starter.set(daemon::pitwall_home().and_then(|home| daemon::ensure_daemon(&home))));
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

/// „Wyjdź” z traya: łagodne zatrzymanie daemona, potem koniec procesu okna.
fn quit_app(app: &AppHandle) {
    let state = Arc::clone(app.state::<Arc<DaemonState>>().inner());
    let app = app.clone();
    std::thread::spawn(move || {
        // Gdy start się nie udał, daemon mógł mimo to wstać (np. inna powłoka go uruchomiła): szukamy go po daemon.json.
        let conn = state.current().or_else(|| daemon::pitwall_home().ok().and_then(|home| daemon::discover(&home)));
        if let Some(conn) = conn {
            if let Err(err) = daemon::shutdown(&conn) {
                eprintln!("[desktop] zatrzymanie daemona: {err}");
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
