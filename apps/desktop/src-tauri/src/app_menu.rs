//! The menu bar of the app on macOS (ADR-49): the app menu with Settings, Edit, View with the views of the activity
//! bar and the zoom of the page (ADR-65), and Window, which macOS fills with the open windows (`WINDOW_SUBMENU_ID`).
//! Windows has no menu bar, because there it would be a bar inside every window. A click on a Trackwall item goes to
//! the last focused window: a zoom item zooms it here (`zoom.rs`), any other item is the event `APP_MENU_EVENT`, and
//! that window's UI acts on it (`use-app-menu.ts`); the other items are the system's own.

use crate::windows::{self, Windows};
use crate::zoom::{self, ZoomStep};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The views of the activity bar in its order, with their labels and shortcuts: the same as `VIEWS` in
/// `packages/ui/src/App.tsx` (`apps/desktop/test/shell-events.test.ts` keeps them equal). The menu bar has to exist
/// before any page loads, and a menu set from a page would send its clicks to that page, so the table is here and not
/// in the UI. Settings is in the app menu.
const VIEWS: [MenuView; 5] = [
    MenuView { id: "home", label: "Home", shortcut: "1" },
    MenuView { id: "repos", label: "Repos", shortcut: "2" },
    MenuView { id: "sessions", label: "Sessions", shortcut: "3" },
    MenuView { id: "graph", label: "Overview", shortcut: "4" },
    MenuView { id: "daemon", label: "Daemon", shortcut: "9" },
];
const SETTINGS: MenuView = MenuView { id: "settings", label: "Settings", shortcut: "," };

/// The event with a `MenuCommand` for the window's UI.
const APP_MENU_EVENT: &str = "app-menu";
/// Ids of Trackwall's items; menu item ids are shared by every menu of the app, so they carry a prefix.
const VIEW_ITEM_PREFIX: &str = "app-menu-view:";
const NEW_WINDOW_ITEM: &str = "app-menu-new-window";
/// The zoom items of View (ADR-65). Their shortcuts are the keys of `zoom-shortcut.ts`, shown here as a reminder: the
/// page takes those keys first, so the items act only when the page did not.
const ZOOM_ITEMS: [(&str, &str, &str, ZoomStep); 3] = [
    ("app-menu-zoom-reset", "Actual Size", "CmdOrCtrl+0", ZoomStep::Reset),
    ("app-menu-zoom-in", "Zoom In", "CmdOrCtrl+=", ZoomStep::In),
    ("app-menu-zoom-out", "Zoom Out", "CmdOrCtrl+-", ZoomStep::Out),
];

// Only the macOS menu bar shows the shortcut.
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

/// The name of a view, for a window's title; `None` for an id that is not a view.
pub fn view_name(id: &str) -> Option<&'static str> {
    VIEWS.iter().chain([&SETTINGS]).find(|v| v.id == id).map(|v| v.label)
}

/// The page's command of a menu item, `None` for any other item.
fn command(item_id: &str) -> Option<MenuCommand> {
    if item_id == NEW_WINDOW_ITEM {
        return Some(MenuCommand::NewWindow);
    }
    let view = item_id.strip_prefix(VIEW_ITEM_PREFIX)?;
    view_name(view).map(|_| MenuCommand::View { view: view.to_string() })
}

/// What a click on a Trackwall item does: a command for the window's page, or a zoom step, which the shell does
/// itself, because the zoom is the shell's (`zoom.rs`).
#[derive(Debug, PartialEq, Eq)]
enum MenuAction {
    Page(MenuCommand),
    Zoom(ZoomStep),
}

/// The action of a menu item, `None` for an item that is not Trackwall's (the system's, the tray's, a context menu's).
fn action(item_id: &str) -> Option<MenuAction> {
    if let Some((.., step)) = ZOOM_ITEMS.iter().find(|(id, ..)| *id == item_id) {
        return Some(MenuAction::Zoom(*step));
    }
    command(item_id).map(MenuAction::Page)
}

/// Acts on a click on a Trackwall item in the last focused window. A command for the page shows the window first,
/// because the app can be active with all its windows hidden (main window closed to the tray); a window whose page is
/// still loading shows itself (ADR-11) and has no listener yet, so a click in that second is lost and the user clicks
/// again.
pub fn handle(app: &AppHandle, item_id: &str) {
    let Some(action) = action(item_id) else { return };
    let label = app.state::<Windows>().last_focused();
    match action {
        // Off the main thread, where menu events run, because the step saves the zoom file.
        MenuAction::Zoom(step) => {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(err) = zoom::apply_step(&app, &label, step) {
                    eprintln!("[desktop] zooming {label}: {err}");
                }
            });
        }
        MenuAction::Page(command) => {
            windows::show_once_loaded(app, &label);
            if let Err(err) = app.emit_to(label.as_str(), APP_MENU_EVENT, command) {
                eprintln!("[desktop] sending a menu command to {label}: {err}");
            }
        }
    }
}

/// The menu bar, given to the builder on macOS. Edit is needed for copy and paste in the web view, which the system
/// routes through the menu's key equivalents.
#[cfg(target_os = "macos")]
pub fn build(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
    let item = |view: &MenuView, text: &str| {
        MenuItem::with_id(app, format!("{VIEW_ITEM_PREFIX}{}", view.id), text, true, Some(format!("CmdOrCtrl+{}", view.shortcut)))
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
            &item(&SETTINGS, &format!("{}…", SETTINGS.label))?,
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
        view.append(&item(v, v.label)?)?;
    }
    view.append(&separator()?)?;
    for (id, text, shortcut, _) in ZOOM_ITEMS {
        view.append(&MenuItem::with_id(app, id, text, true, Some(shortcut))?)?;
    }
    view.append_items(&[&separator()?, &PredefinedMenuItem::fullscreen(app, None)?])?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &MenuItem::with_id(app, NEW_WINDOW_ITEM, "New Window", true, Some("CmdOrCtrl+Shift+N"))?,
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
    fn a_zoom_item_zooms_in_the_shell_and_a_view_item_goes_to_the_page() {
        assert_eq!(action("app-menu-zoom-in"), Some(MenuAction::Zoom(ZoomStep::In)));
        assert_eq!(action("app-menu-zoom-reset"), Some(MenuAction::Zoom(ZoomStep::Reset)));
        assert_eq!(action("app-menu-view:home"), Some(MenuAction::Page(MenuCommand::View { view: "home".into() })));
        assert_eq!(action("quit"), None);
    }

    #[test]
    fn a_view_has_its_activity_bar_name() {
        assert_eq!(view_name("graph"), Some("Overview"));
        assert_eq!(view_name("settings"), Some("Settings"));
        assert_eq!(view_name("nothing"), None);
    }

    #[test]
    fn items_of_other_menus_and_unknown_views_are_not_commands() {
        assert_eq!(command("quit"), None);
        assert_eq!(command("new-window"), None);
        assert_eq!(command("app-menu-view:nothing"), None);
    }

    /// The JSON the UI gets for each command. No `_` arm, so a new command needs its JSON here, and
    /// `apps/desktop/test/shell-events.test.ts` compares these kinds with the UI's schema.
    fn sent_as(command: &MenuCommand) -> &'static str {
        match command {
            MenuCommand::View { .. } => r#"{"kind":"view","view":"home"}"#,
            MenuCommand::NewWindow => r#"{"kind":"new-window"}"#,
        }
    }

    #[test]
    fn the_window_gets_the_command_as_tagged_json() {
        for command in [MenuCommand::View { view: "home".into() }, MenuCommand::NewWindow] {
            assert_eq!(serde_json::to_string(&command).expect("json"), sent_as(&command));
        }
    }
}
