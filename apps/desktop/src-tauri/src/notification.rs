//! System notifications (ADR-50): a session that starts waiting for you and a new task proposal show a notification
//! while no Trackwall window has the focus, and clicking it opens that session or proposal like the tray menu does.
//!
//! The official notification plugin cannot tell the shell about a click on the desktop, and on Windows it only shows
//! toasts under an AppUserModelID that an installer registered, which the portable build does not have. So the shell
//! talks to the system directly: on Windows a toast with an activation handler under the app's own AppUserModelID,
//! which the shell registers in HKCU at start (the documented way for unpackaged apps, no Start menu shortcut); on macOS
//! an `NSUserNotification` from mac-notification-sys, with one thread per notification waiting for its click. Elsewhere
//! (Linux, only built in CI) nothing is shown. Described in §5.4 of docs/architecture.md.

use crate::attention::{self, Focus, Proposal, Waiting};
use tauri::AppHandle;

/// What one notification says and what clicking it opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
    pub target: Focus,
}

/// A session that started waiting; the words match the session state labels in the UI (`STATE_LABELS`).
pub fn session_notice(waiting: &Waiting) -> Notice {
    let body = match waiting.state.as_deref() {
        Some("Approval") => "Copilot CLI is asking for approval",
        Some("Plan") => "Copilot CLI is waiting for plan approval",
        _ => "Copilot CLI is waiting for you",
    };
    Notice { title: format!("Session in {}", waiting.repo), body: body.to_owned(), target: Focus::Session(waiting.id.clone()) }
}

pub fn proposal_notice(proposal: &Proposal) -> Notice {
    Notice {
        title: format!("Task proposal for {}", proposal.repo),
        body: proposal.title.clone(),
        target: Focus::Proposal(proposal.id.clone()),
    }
}

/// The name notifications are shown under: the app identifier, with a suffix in a debug build so that `tauri dev`
/// does not share the installed app's notification settings.
fn app_id(app: &AppHandle) -> String {
    let identifier = &app.config().identifier;
    if cfg!(debug_assertions) {
        format!("{identifier}.dev")
    } else {
        identifier.clone()
    }
}

/// Prepares the system for the app's notifications; once, in `setup`.
pub fn init(app: &AppHandle) {
    if let Err(err) = platform::init(&app_id(app)) {
        eprintln!("[desktop] preparing system notifications: {err}");
    }
}

/// Shows the notice; a click shows the window with its target. `show` is `show_main` from `main.rs`.
pub fn show(app: &AppHandle, notice: Notice, show: fn(&AppHandle)) {
    let clicked = {
        let app = app.clone();
        let target = notice.target.clone();
        move || attention::focus(&app, target.clone(), show)
    };
    if let Err(err) = platform::show(&app_id(app), &notice, clicked) {
        eprintln!("[desktop] showing a system notification: {err}");
    }
}

#[cfg(windows)]
mod platform {
    use super::Notice;
    use tauri_winrt_notification::Toast;
    use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

    /// The name Windows shows above the app's toasts and in its notification settings.
    const DISPLAY_NAME: &str = if cfg!(debug_assertions) { "Trackwall (dev)" } else { "Trackwall" };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Registers the AppUserModelID under `HKCU\Software\Classes\AppUserModelId`, where Windows looks up the name
    /// a toast of an unpackaged app is shown under. Without it Windows drops the app's toasts.
    pub fn init(app_id: &str) -> Result<(), String> {
        let key = wide(&format!(r"Software\Classes\AppUserModelId\{app_id}"));
        let (value, data) = (wide("DisplayName"), wide(DISPLAY_NAME));
        let bytes = u32::try_from(data.len() * 2).map_err(|e| e.to_string())?;
        // SAFETY: the strings end with a zero and live until the call returns; `bytes` is the size of `data` in bytes.
        let status = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), REG_SZ, data.as_ptr().cast(), bytes) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("registering the AppUserModelID failed with code {status}"))
        }
    }

    /// The activation handler runs while the toast is on the screen or in the notification centre and Trackwall runs.
    pub fn show(app_id: &str, notice: &Notice, clicked: impl Fn() + Send + 'static) -> Result<(), String> {
        Toast::new(app_id)
            .title(&notice.title)
            .text1(&notice.body)
            .on_activated(move |_| {
                clicked();
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Notice;
    use mac_notification_sys::{Notification, NotificationResponse};

    /// A bundled app posts under its own bundle identifier. A debug build runs outside a bundle and keeps the
    /// library's default, so its notifications show under another app's name.
    pub fn init(app_id: &str) -> Result<(), String> {
        if cfg!(debug_assertions) {
            return Ok(());
        }
        mac_notification_sys::set_application(app_id).map_err(|e| e.to_string())
    }

    /// `send` with `wait_for_click` blocks until the notification is clicked, closed or cleared, so it gets a thread.
    pub fn show(_app_id: &str, notice: &Notice, clicked: impl Fn() + Send + 'static) -> Result<(), String> {
        let Notice { title, body, .. } = notice.clone();
        std::thread::spawn(move || match Notification::new().title(&title).message(&body).wait_for_click(true).send() {
            Ok(NotificationResponse::Click) => clicked(),
            Ok(_) => {}
            Err(err) => eprintln!("[desktop] showing a system notification: {err}"),
        });
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::Notice;

    pub fn init(_app_id: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn show(_app_id: &str, _notice: &Notice, _clicked: impl Fn() + Send + 'static) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waiting(state: Option<&str>) -> Waiting {
        Waiting { id: "s1".into(), repo: "orders-api".into(), state: state.map(Into::into) }
    }

    #[test]
    fn a_session_notice_names_the_repo_and_what_the_session_waits_for() {
        assert_eq!(
            session_notice(&waiting(Some("Approval"))),
            Notice {
                title: "Session in orders-api".into(),
                body: "Copilot CLI is asking for approval".into(),
                target: Focus::Session("s1".into()),
            }
        );
        assert_eq!(session_notice(&waiting(Some("Plan"))).body, "Copilot CLI is waiting for plan approval");
        assert_eq!(session_notice(&waiting(Some("Input"))).body, "Copilot CLI is waiting for you");
    }

    #[test]
    fn a_proposal_notice_shows_the_proposed_title_and_opens_the_proposal() {
        let proposal = Proposal { id: "p1".into(), repo: "billing".into(), title: "Retry failed invoices".into() };
        assert_eq!(
            proposal_notice(&proposal),
            Notice {
                title: "Task proposal for billing".into(),
                body: "Retry failed invoices".into(),
                target: Focus::Proposal("p1".into()),
            }
        );
    }
}
