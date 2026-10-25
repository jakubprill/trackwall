//! System notifications (ADR-50): a session that starts waiting for you and new task proposals show a notification
//! while no Trackwall window has the focus, and clicking it opens that session or proposal like the tray menu does.
//!
//! The official notification plugin cannot tell the shell about a click on the desktop, and on Windows it only shows
//! toasts under an AppUserModelID that an installer registered, which the portable build does not have. So the shell
//! talks to the system directly: on Windows a toast with an activation handler under the app's own AppUserModelID,
//! which the shell registers in HKCU at start (the documented way for unpackaged apps, no Start menu shortcut); on macOS
//! an `NSUserNotification` from mac-notification-sys, with a thread per notification waiting for its click. Elsewhere
//! (Linux, only built in CI) nothing is shown. Described in §5.4 of docs/architecture.md.

use crate::attention::{News, Proposal, TaskState, Waiting};
use crate::jump::{self, Jump};
use tauri::AppHandle;

/// What one notification says and what clicking it opens.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Notice {
    title: String,
    body: String,
    target: Jump,
}

/// A session that started waiting; the words are the session state labels of the UI (`STATE_LABELS`, a test in
/// `apps/desktop/test/shell-events.test.ts` keeps them the same).
fn session_notice(waiting: &Waiting) -> Notice {
    let body = match waiting.state {
        Some(TaskState::Approval) => "Copilot CLI is asking for approval",
        Some(TaskState::Plan) => "Copilot CLI is waiting for plan approval",
        _ => "Copilot CLI is waiting for you",
    };
    Notice { title: waiting.titled(), body: body.to_owned(), target: Jump::Session(waiting.id.clone()) }
}

fn proposal_notice(proposal: &Proposal) -> Notice {
    Notice {
        title: format!("Task proposal for {}", proposal.repo),
        body: proposal.title.clone(),
        target: Jump::Proposal(proposal.id.clone()),
    }
}

/// New proposals: a main session usually proposes a plan of several tasks at once, so the proposals that arrived since
/// the previous poll make one notification with their titles (ADR-55); clicking it opens the first one, among the rest
/// of its session's proposals in the Sessions view.
fn proposals_notice(proposals: &[Proposal]) -> Option<Notice> {
    match proposals {
        [] => None,
        [only] => Some(proposal_notice(only)),
        [first, ..] => Some(Notice {
            title: format!("{} task proposals", proposals.len()),
            body: proposals.iter().map(|p| format!("{}: {}", p.repo, p.title)).collect::<Vec<_>>().join("\n"),
            target: Jump::Proposal(first.id.clone()),
        }),
    }
}

fn notices(news: &News) -> Vec<Notice> {
    news.sessions.iter().map(session_notice).chain(proposals_notice(&news.proposals)).collect()
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

/// One notification for each session that started waiting, and one for the new proposals.
pub fn show_news(app: &AppHandle, news: &News) {
    let app_id = app_id(app);
    for notice in notices(news) {
        let clicked = {
            let app = app.clone();
            let target = notice.target.clone();
            move || jump::request(&app, target.clone())
        };
        if let Err(err) = platform::show(&app_id, &notice, clicked) {
            eprintln!("[desktop] showing a system notification: {err}");
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::Notice;
    use crate::daemon;
    use crate::win_text::wide;
    use tauri_winrt_notification::Toast;
    use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

    /// The name Windows shows above the app's toasts and in its notification settings.
    const DISPLAY_NAME: &str = if cfg!(debug_assertions) { "Trackwall (dev)" } else { "Trackwall" };
    /// The icon next to that name: Windows reads it from a file, and the portable build has no loose image files.
    const ICON: &[u8] = include_bytes!("../icons/128x128.png");
    const ICON_FILE: &str = "notification-icon.png";

    pub(super) fn key(app_id: &str) -> String {
        format!(r"Software\Classes\AppUserModelId\{app_id}")
    }

    /// Registers the AppUserModelID under `HKCU\Software\Classes\AppUserModelId`, where Windows looks up the name and
    /// icon a toast of an unpackaged app is shown with. Without it Windows drops the app's toasts.
    pub fn init(app_id: &str) -> Result<(), String> {
        let key = key(app_id);
        set_string(&key, "DisplayName", DISPLAY_NAME)?;
        // The icon only decorates the toast: without it Windows shows a generic one.
        // The state directory may not exist yet on the first start: the daemon is started in parallel.
        let icon = daemon::trackwall_home().and_then(|home| {
            std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
            let path = home.join(ICON_FILE);
            std::fs::write(&path, ICON).map_err(|e| e.to_string())?;
            Ok(path)
        });
        match icon {
            Ok(path) => set_string(&key, "IconUri", &path.to_string_lossy())?,
            Err(err) => eprintln!("[desktop] writing the notification icon: {err}"),
        }
        Ok(())
    }

    pub(super) fn set_string(key: &str, name: &str, value: &str) -> Result<(), String> {
        let (key, name, data) = (wide(key), wide(name), wide(value));
        let bytes = u32::try_from(data.len() * 2).map_err(|e| e.to_string())?;
        // SAFETY: the strings end with a zero and live until the call returns; `bytes` is the size of `data` in bytes.
        let status = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), REG_SZ, data.as_ptr().cast(), bytes) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("writing {value:?} to the registry failed with code {status}"))
        }
    }

    /// The activation handler runs when the toast is clicked while it is on the screen and Trackwall runs.
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Each notification that waits for a click holds a thread (and in the library a timer on the main thread) until it
    /// is clicked, closed or cleared from the Notification Centre; past this many the next ones are shown without a click
    /// action, so that a day of uncleared notifications does not pile up threads.
    const MAX_WAITING_FOR_CLICK: usize = 8;
    static WAITING_FOR_CLICK: AtomicUsize = AtomicUsize::new(0);

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
        let wait = WAITING_FOR_CLICK.fetch_add(1, Ordering::SeqCst) < MAX_WAITING_FOR_CLICK;
        if !wait {
            WAITING_FOR_CLICK.fetch_sub(1, Ordering::SeqCst);
        }
        std::thread::spawn(move || {
            match Notification::new().title(&title).message(&body).wait_for_click(wait).send() {
                Ok(NotificationResponse::Click) => clicked(),
                Ok(_) => {}
                Err(err) => eprintln!("[desktop] showing a system notification: {err}"),
            }
            if wait {
                WAITING_FOR_CLICK.fetch_sub(1, Ordering::SeqCst);
            }
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

    fn waiting(state: Option<TaskState>) -> Waiting {
        Waiting { id: "s1".into(), repo: Some("orders-api".into()), state }
    }

    #[test]
    fn a_supervisor_notice_is_titled_supervisor() {
        let supervisor = Waiting { id: "s0".into(), repo: None, state: Some(TaskState::Input) };
        assert_eq!(session_notice(&supervisor).title, "Supervisor");
    }

    #[test]
    fn a_session_notice_names_the_repo_and_what_the_session_waits_for() {
        assert_eq!(
            session_notice(&waiting(Some(TaskState::Approval))),
            Notice {
                title: "Session in orders-api".into(),
                body: "Copilot CLI is asking for approval".into(),
                target: Jump::Session("s1".into()),
            }
        );
        assert_eq!(session_notice(&waiting(Some(TaskState::Plan))).body, "Copilot CLI is waiting for plan approval");
        assert_eq!(session_notice(&waiting(Some(TaskState::Input))).body, "Copilot CLI is waiting for you");
    }

    #[test]
    fn a_proposal_notice_shows_the_proposed_title_and_opens_the_proposal() {
        let proposal = Proposal { id: "p1".into(), repo: "billing".into(), title: "Retry failed invoices".into() };
        assert_eq!(
            proposal_notice(&proposal),
            Notice { title: "Task proposal for billing".into(), body: "Retry failed invoices".into(), target: Jump::Proposal("p1".into()) }
        );
    }

    #[test]
    fn news_become_one_notice_each_sessions_first() {
        let news = News {
            sessions: vec![waiting(Some(TaskState::Input))],
            proposals: vec![Proposal { id: "p1".into(), repo: "billing".into(), title: "t".into() }],
        };
        let targets: Vec<Jump> = notices(&news).into_iter().map(|n| n.target).collect();
        assert_eq!(targets, vec![Jump::Session("s1".into()), Jump::Proposal("p1".into())]);
    }

    #[test]
    fn proposals_that_arrive_together_make_one_notice_that_opens_the_first() {
        let news = News {
            sessions: vec![],
            proposals: vec![
                Proposal { id: "p1".into(), repo: "billing".into(), title: "Add refund endpoint".into() },
                Proposal { id: "p2".into(), repo: "web-shop".into(), title: "Show refund status".into() },
            ],
        };
        assert_eq!(
            notices(&news),
            vec![Notice {
                title: "2 task proposals".into(),
                body: "billing: Add refund endpoint\nweb-shop: Show refund status".into(),
                target: Jump::Proposal("p1".into()),
            }]
        );
    }

    /// Runs on `windows-latest` in CI: the registry value toasts depend on lands where Windows looks for it.
    #[cfg(windows)]
    #[test]
    fn registering_the_app_id_writes_its_display_name_under_hkcu() {
        use crate::win_text::wide;
        use windows_sys::Win32::System::Registry::{RegDeleteTreeW, RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
        let key = platform::key("dev.trackwall.test-registration");
        platform::set_string(&key, "DisplayName", "Trackwall test").expect("registry write");
        let (key_w, name_w) = (wide(&key), wide("DisplayName"));
        let mut buffer = [0u16; 64];
        let mut size = u32::try_from(std::mem::size_of_val(&buffer)).unwrap();
        // SAFETY: the strings end with a zero; `buffer` and `size` describe a writable buffer of `size` bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key_w.as_ptr(),
                name_w.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        // SAFETY: as above.
        unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, key_w.as_ptr()) };
        assert_eq!(status, 0);
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        assert_eq!(String::from_utf16_lossy(&buffer[..len]), "Trackwall test");
    }
}
