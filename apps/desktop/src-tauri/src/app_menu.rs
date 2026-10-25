//! The menu bar of the app on macOS (ADR-49): the app menu with Settings, Edit, View with the views of the activity
//! bar, and Window, which macOS fills with the open windows (`WINDOW_SUBMENU_ID`). Windows has no menu bar, because
//! there it would be a bar inside every window. A click on a Trackwall item goes to the last focused window as the
//! event `APP_MENU_EVENT`, and that window's UI acts on it (`use-app-menu.ts`); the other items are the system's own.

use crate::windows::{self, Windows};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The views of the activity bar in its order, with their labels and shortcuts: the same as `VIEWS` in
/// `packages/ui/src/App.tsx` (`apps/desktop/test/shell-events.test.ts` keeps them equal). Settings is in the app menu.
const VIEWS: [MenuView; 5] = [
    MenuView { id: "home", label: "Home", shortcut: "1" },
    MenuView { id: "repos", label: "Repos", shortcut: "2" },
    MenuView { id: "sessions", label: "Sessions", shortcut: "3" },
    MenuView { id: "graph", label: "Overview", shortcut: "4" },
    MenuView { id: "daemon", label: "Daemon", shortcut: "9" },
];
const SETTINGS: MenuView = MenuView { id: "settings", label: "Settings…", shortcut: "," };

/// The event with a `MenuCommand` for the window's UI.
const APP_MENU_EVENT: &str = "app-menu";
/// Ids of Trackwall's items; menu item ids are shared by every menu of the app, so they carry a prefix.
const VIEW_ITEM_PREFIX: &str = "app-menu-view:";
const NEW_WINDOW_ITEM: &str = "app-menu-new-window";

// Only the macOS menu bar shows the label and the shortcut; elsewhere the views only check menu ids.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct MenuView {
    id: &'static str,
    label: &'static str,
    shortcut: &'static str,
}

/// What a Trackwall item asks the window to do: show a view, or open its current view in a new window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum MenuCommand {
    View { view: String },
    NewWindow,
}

/// The command of a menu item, `None` for an item that is not Trackwall's (the system's, the tray's, a context menu's).
fn command(item_id: &str) -> Option<MenuCommand> {
    if item_id == NEW_WINDOW_ITEM {
        return Some(MenuCommand::NewWindow);
    }
    let view = item_id.strip_prefix(VIEW_ITEM_PREFIX)?;
    VIEWS.iter().chain([&SETTINGS]).any(|v| v.id == view).then(|| MenuCommand::View { view: view.to_string() })
}

/// Sends a click on a Trackwall item to the last focused window, shown first, because the app can be active with all
/// its windows hidden (main window closed to the tray).
pub fn handle(app: &AppHandle, item_id: &str) {
    let Some(command) = command(item_id) else { return };
    let label = app.state::<Windows>().last_focused();
    windows::show(app, &label);
    if let Err(err) = app.emit_to(label.as_str(), APP_MENU_EVENT, command) {
        eprintln!("[desktop] sending a menu command to {label}: {err}");
    }
}

/// The menu bar, given to the builder on macOS. Edit is needed for copy and paste in the web view, which the system
/// routes through the menu's key equivalents.
#[cfg(target_os = "macos")]
pub fn build(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
    let item = |view: &MenuView| {
        MenuItem::with_id(app, format!("{VIEW_ITEM_PREFIX}{}", view.id), view.label, true, Some(format!("CmdOrCtrl+{}", view.shortcut)))
    };
    let separator = || PredefinedMenuItem::separator(app);
    let info = app.package_info();
    let about = AboutMetadata { name: Some(info.name.clone()), version: Some(info.version.to_string()), ..Default::default() };
    let app_menu = Submenu::with_items(
        app,
        info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &separator()?,
            &item(&SETTINGS)?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[])?;
    for v in &VIEWS {
        view.append(&item(v)?)?;
    }
    view.append_items(&[&separator()?, &PredefinedMenuItem::fullscreen(app, None)?])?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &MenuItem::with_id(app, NEW_WINDOW_ITEM, "New Window", true, Some("CmdOrCtrl+N"))?,
            &separator()?,
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &separator()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window, &help])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_item_shows_its_view_and_the_new_window_item_opens_one() {
        assert_eq!(command("app-menu-view:sessions"), Some(MenuCommand::View { view: "sessions".into() }));
        assert_eq!(command("app-menu-view:settings"), Some(MenuCommand::View { view: "settings".into() }));
        assert_eq!(command("app-menu-new-window"), Some(MenuCommand::NewWindow));
    }

    #[test]
    fn items_of_other_menus_and_unknown_views_are_not_commands() {
        assert_eq!(command("quit"), None);
        assert_eq!(command("new-window"), None);
        assert_eq!(command("app-menu-view:nothing"), None);
    }

    #[test]
    fn the_window_gets_the_command_as_tagged_json() {
        assert_eq!(serde_json::to_string(&MenuCommand::View { view: "home".into() }).expect("json"), r#"{"kind":"view","view":"home"}"#);
        assert_eq!(serde_json::to_string(&MenuCommand::NewWindow).expect("json"), r#"{"kind":"new-window"}"#);
    }
}
