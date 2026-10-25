//! The Trackwall desktop shell: windows, tray and daemon supervision. All logic lives in the daemon (§2, §5.4).

// Bez okna konsoli w wydaniu na Windowsie.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_menu;
mod attention;
mod daemon;
mod daemon_state;
mod jump;
mod link;
mod lock;
mod saved_windows;
mod window_effect;
mod windows;

use daemon::Connection;
use daemon_state::DaemonState;
use std::sync::Arc;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Window, WindowEvent};
use window_effect::WindowEffects;
use windows::Windows;

/// Identyfikator ikony w trayu: potrzebny, żeby usunąć ją przy wyjściu.
const TRAY_ID: &str = "main";

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

/// Opens an extra window with `view` (ADR-49). Async, because building a window on the main thread deadlocks on Windows.
#[tauri::command]
async fn open_window(app: AppHandle, view: String) -> Result<(), String> {
    windows::open(&app, Some(&view))
}

/// What the window shows (its view and session layout): the tray sends sessions to a window that shows Sessions, extra
/// windows come back with it at the next start, and the view's name goes into the window's title, which the taskbar
/// and the Window menu of macOS show.
#[tauri::command]
fn window_shows(window: Window, view: String, session_layout: String) -> Result<(), String> {
    let shown = saved_windows::Shown::new(&view, &session_layout).ok_or("not a view or session layout id")?;
    let view_name = app_menu::view_name(&view).ok_or("not a view")?;
    let title = windows::title(view_name, &window.app_handle().package_info().name);
    windows::shows(window.app_handle(), window.label(), shown);
    window.set_title(&title).map_err(|e| e.to_string())
}

fn main() {
    #[cfg(windows)]
    if let Err(err) = tauri::webview_version() {
        windows_alert(&format!(
            "Trackwall needs the Microsoft Edge WebView2 Runtime, which was not found ({err}).\n\n\
             Install it from https://developer.microsoft.com/microsoft-edge/webview2/ \
             or run trackwall-daemon.exe --ui to open Trackwall in your browser."
        ));
        std::process::exit(1);
    }

    let state = Arc::new(DaemonState::new(daemon::trackwall_home()));
    let builder = tauri::Builder::default();
    // Ponowne uruchomienie trackwall.exe pokazuje istniejące okno zamiast drugiej powłoki i drugiej ikony w trayu.
    // Tylko w wydaniu: identyfikator instancji jest wspólny, a `tauri dev` ma działać obok zainstalowanej aplikacji.
    // On Windows a `trackwall://` link starts a second trackwall.exe; the plugin's `deep-link` feature hands the link
    // to the first instance before this callback (ADR-52), and the link shows its own window.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        let state = Arc::clone(app.state::<Arc<DaemonState>>().inner());
        std::thread::spawn(move || state.restart_if_down());
        if !link::in_args(&args) {
            windows::show_once_loaded(app, windows::MAIN);
        }
    }));
    // The menu bar on macOS (ADR-49); without one Tauri sets its default menu there.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu::build);
    let app = builder
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(windows::STATE_FLAGS).build())
        .plugin(tauri_plugin_deep_link::init())
        .manage(Arc::clone(&state))
        .manage(WindowEffects::default())
        .manage(Windows::default())
        .manage(jump::PendingJump::default())
        .invoke_handler(tauri::generate_handler![
            daemon_connection,
            retry_daemon,
            open_window,
            window_shows,
            jump::take_jump,
            link::open_link
        ])
        .setup(move |app| {
            state.start();
            let window = app.get_webview_window(windows::MAIN).ok_or("missing window main from tauri.conf.json")?;
            app.state::<WindowEffects>().apply(&window);
            build_tray(app.handle())?;
            windows::restore(app.handle());
            attention::watch(app.handle().clone(), Arc::clone(&state), TRAY_ID);
            link::listen(app.handle());
            Ok(())
        })
        .on_page_load(window_effect::on_page_load)
        .on_menu_event(|app, event| app_menu::handle(app, event.id.as_ref()))
        .on_window_event(|window, event| match event {
            // Closing the main window hides it to the tray; the daemon and services keep running. An extra window closes.
            WindowEvent::CloseRequested { api, .. } if window.label() == windows::MAIN => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::CloseRequested { .. } => windows::closed_by_user(window.app_handle(), window.label()),
            WindowEvent::Focused(true) => window.state::<Windows>().focused(window.label()),
            WindowEvent::Destroyed => windows::closed(window.app_handle(), window.label()),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri app");

    app.run(|handle, event| match event {
        // macOS: kliknięcie w ikonę w Docku po schowaniu okna.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(handle),
        RunEvent::ExitRequested { code: None, api, .. } => {
            // Ostatnie okno schowane to nie powód do wyjścia.
            api.prevent_exit();
        }
        // Cmd+Q i „Zakończ” z Docka na macOS (a według kodu tao także koniec sesji Windows) kończą pętlę zdarzeń
        // z pominięciem `ExitRequested` i traya. Bez tego daemon zostawał osierocony. Po „Quit” z traya daemon jest już zatrzymany.
        RunEvent::Exit => {
            // Pętla zdarzeń już stoi: bez schowania okno i tray wisiałyby zamrożone do końca zatrzymywania.
            hide_shell(handle);
            handle.state::<Arc<DaemonState>>().stop();
        }
        _ => {}
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = attention::build_menu(app, &[], &[])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(attention::tooltip(&[], &[]))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            attention::MENU_SHOW => show_main(app),
            attention::MENU_NEW_WINDOW => {
                // Not on the main thread, where the menu event runs: building a window there deadlocks on Windows.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = windows::open(&app, None) {
                        eprintln!("[desktop] opening a window: {err}");
                    }
                });
            }
            attention::MENU_QUIT => quit_app(app),
            id => {
                if let Some(target) = attention::jump_from_menu(id) {
                    jump::request(app, target);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    // Pasek menu macOS oczekuje jednobarwnego szablonu, który system sam przebarwia do jasnego i ciemnego paska.
    // Poza macOS zostaje kolorowa ikona aplikacji: zasobnik Windows i Linuksa bywa jasny albo ciemny, a ona jest czytelna na obu.
    if cfg!(target_os = "macos") {
        tray = tray.icon(tauri::include_image!("icons/tray-template.png")).icon_as_template(true);
    } else if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    windows::show(app, windows::MAIN);
}

/// „Quit” z traya: zatrzymanie daemona w tle, żeby pętla zdarzeń działała, a pojedyncza instancja
/// była trzymana do końca; potem koniec procesu okna.
fn quit_app(app: &AppHandle) {
    hide_shell(app);
    let state = Arc::clone(app.state::<Arc<DaemonState>>().inner());
    let app = app.clone();
    std::thread::spawn(move || {
        state.stop();
        app.exit(0);
    });
}

/// Chowa okna i ikonę w trayu, żeby zamykająca się powłoka nie przyjmowała już kliknięć.
fn hide_shell(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    let _ = app.remove_tray_by_id(TRAY_ID);
}

#[cfg(windows)]
fn windows_alert(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(text), wide("Trackwall"));
    // SAFETY: oba bufory są zakończone zerem i żyją do końca wywołania.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
}
