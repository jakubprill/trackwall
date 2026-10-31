//! The Trackwall desktop shell: windows, tray and daemon supervision. All logic lives in the daemon (§2, §5.4).

// No console window in the release build on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_menu;
mod attention;
mod autostart;
mod badge;
mod clipboard;
mod daemon;
mod daemon_state;
mod dev_container;
mod error_journal;
mod folder_picker;
mod global_shortcut;
mod host_folder;
mod json_file;
mod jump;
mod link;
mod lock;
mod notification;
mod pipelines;
mod repaint;
mod saved_windows;
mod tray_panel;
#[cfg(windows)]
mod win_text;
// Tested on every system, used only on Windows (ADR-53).
#[cfg_attr(not(windows), allow(dead_code))]
mod portable_update;
mod remote_daemon;
mod system_open;
mod updates;
mod window_effect;
mod windows;
mod zoom;

use badge::TrayIcons;
use daemon::Connection;
use daemon_state::DaemonState;
use std::sync::Arc;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Window, WindowEvent};
use tray_panel::PanelState;
use window_effect::WindowEffects;
use windows::Windows;

/// Id of the tray icon: needed to remove it on exit.
const TRAY_ID: &str = "main";

/// The daemon's address and token for the UI. The token goes through Tauri IPC, never through a URL (§5.2).
#[tauri::command]
async fn daemon_connection(state: tauri::State<'_, Arc<DaemonState>>) -> Result<Connection, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.wait()).await.map_err(|e| e.to_string())?
}

/// Start again after an error or after the daemon disappeared (the "Try again" button in the UI).
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

/// A click in the tray panel (ADR-50): hides the panel and jumps to the entry, or shows the main window for "Open
/// Trackwall".
#[tauri::command]
fn open_from_tray_panel(app: AppHandle, target: Option<jump::Jump>) {
    tray_panel::hide(&app);
    match target {
        Some(target) => jump::request(&app, target),
        None => show_main(&app),
    }
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

    let home = daemon::trackwall_home();
    if let Ok(home) = &home {
        error_journal::init(home);
    }
    let state = Arc::new(DaemonState::new(home));
    let builder = tauri::Builder::default();
    // Launching trackwall.exe again shows the existing window instead of a second shell and a second tray icon.
    // Only in a release: the instance id is shared, and `tauri dev` has to run next to the installed app.
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::clone(&state))
        .manage(PanelState::default())
        .manage(dev_container::DevContainerStart::default())
        .manage(WindowEffects::default())
        .manage(Windows::default())
        .manage(jump::PendingJump::default())
        .manage(updates::Updates::default())
        .manage(zoom::Zooms::default())
        .invoke_handler(tauri::generate_handler![
            daemon_connection,
            retry_daemon,
            open_window,
            window_shows,
            jump::take_jump,
            link::open_link,
            system_open::open_outside,
            dev_container::dev_container,
            dev_container::set_dev_container,
            dev_container::start_dev_container,
            host_folder::host_projects_folder,
            host_folder::set_host_projects_folder,
            host_folder::show_in_host_folder,
            remote_daemon::remote_daemon_port,
            remote_daemon::use_remote_daemon,
            remote_daemon::use_own_daemon,
            clipboard::copy_text,
            open_from_tray_panel,
            folder_picker::pick_projects_folder,
            updates::check_update,
            updates::install_update,
            updates::cancel_update,
            autostart::autostart_enabled,
            autostart::set_autostart,
            zoom::zoom_window
        ])
        .setup(move |app| {
            if let Some(remote) = remote_daemon::load(app.handle()) {
                state.use_remote(remote);
            }
            state.start();
            // Files of the version this one replaced (ADR-53); in the background, because they are freed only once it exits.
            #[cfg(windows)]
            if let Ok(dir) = portable_update::app_dir() {
                std::thread::spawn(move || portable_update::clean_up(&dir));
            }
            zoom::Zooms::load(app.handle());
            zoom::apply_to_main(app.handle());
            let window = app.get_webview_window(windows::MAIN).ok_or("missing window main from tauri.conf.json")?;
            app.state::<WindowEffects>().apply(&window);
            let tray_icons = build_tray(app.handle())?;
            // A start at sign-in (ADR-65) keeps the windows hidden until the user opens Trackwall.
            if autostart::starts_hidden(app.handle(), std::env::args()) {
                app.state::<WindowEffects>().mark_revealed(windows::MAIN);
                windows::restore_when_shown(app.handle());
            } else {
                windows::restore(app.handle());
            }
            let refreshing = app.handle().clone();
            std::thread::spawn(move || autostart::refresh(&refreshing));
            notification::init(app.handle());
            global_shortcut::register(app.handle());
            attention::watch(app.handle().clone(), Arc::clone(&state), TRAY_ID, tray_icons);
            link::listen(app.handle());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // The tray panel paints its own opaque background and is shown by `tray_panel`, not by the window effect.
            if webview.label() != tray_panel::LABEL {
                window_effect::on_page_load(webview, payload);
            }
            zoom::on_page_load(webview, payload);
        })
        .on_menu_event(|app, event| app_menu::handle(app, event.id.as_ref()))
        .on_window_event(|window, event| match event {
            // The tray panel is not a window for sessions or links: it handles its own events (ADR-50).
            _ if window.label() == tray_panel::LABEL => tray_panel::on_window_event(window, event),
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
        // macOS: a click on the Dock icon after the window was hidden.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(handle),
        RunEvent::ExitRequested { code: None, api, .. } => {
            // Hiding the last window is no reason to exit.
            api.prevent_exit();
        }
        // Cmd+Q and "Quit" from the Dock on macOS (and, according to the tao code, the end of a Windows session too) end the
        // event loop bypassing `ExitRequested` and the tray. Without this the daemon was left orphaned. After "Quit" from
        // the tray the daemon is already stopped.
        // The restart after an update (ADR-53) comes this way too, so the new shell never finds the old daemon running.
        RunEvent::Exit => {
            // The event loop has already stopped: without hiding them, the window and tray would hang frozen until the stop finishes.
            hide_shell(handle);
            handle.state::<Arc<DaemonState>>().stop();
        }
        _ => {}
    });
}

/// The tray icon with its menu; returns its image, which gets a dot while something waits (`badge.rs`).
fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcons> {
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
                        crate::report_error!("opening a window: {err}");
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
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Down, .. } => {
                tray_panel::press(tray.app_handle());
            }
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } => {
                tray_panel::release(tray.app_handle(), rect);
            }
            // Windows only: a double click opens the main window, as a click did before the panel (ADR-50).
            TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                tray_panel::double_click(tray.app_handle());
                show_main(tray.app_handle());
            }
            _ => {}
        });
    // The macOS menu bar expects a monochrome template, which the system recolours for a light or dark bar itself.
    // Outside macOS the coloured app icon stays: the Windows and Linux notification area can be light or dark, and it reads on both.
    let icons = if cfg!(target_os = "macos") {
        TrayIcons::new(tauri::include_image!("icons/tray-template.png"), true)
    } else {
        let icon = app.default_window_icon().ok_or_else(|| tauri::Error::AssetNotFound("the app icon".into()))?;
        TrayIcons::new(icon.clone().to_owned(), false)
    };
    tray = tray.icon(icons.icon(false)).icon_as_template(icons.template());
    tray.build(app)?;
    Ok(icons)
}

fn show_main(app: &AppHandle) {
    windows::show(app, windows::MAIN);
}

/// "Quit" from the tray: stops the daemon in the background, so that the event loop keeps running and the single
/// instance is held to the end; then the window process ends.
fn quit_app(app: &AppHandle) {
    hide_shell(app);
    let state = Arc::clone(app.state::<Arc<DaemonState>>().inner());
    let app = app.clone();
    std::thread::spawn(move || {
        state.stop();
        app.exit(0);
    });
}

/// Hides the windows and the tray icon, so that a closing shell no longer takes clicks.
fn hide_shell(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    let _ = app.remove_tray_by_id(TRAY_ID);
}

#[cfg(windows)]
fn windows_alert(text: &str) {
    use win_text::wide;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let (text, title) = (wide(text), wide("Trackwall"));
    // SAFETY: both buffers are null-terminated and live until the end of the call.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
}
