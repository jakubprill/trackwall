//! Sesje Copilot CLI, które czekają na Ciebie (ADR-26): powłoka co chwilę pyta daemon o listę sesji i, gdy któraś
//! przestaje pracować i zaczyna czekać, zwraca uwagę użytkownika (miganie na pasku zadań, podskok w Docku), zmienia
//! podpowiedź i menu traya. Kliknięcie pozycji w menu pokazuje okno z tą sesją.
//!
//! Pytanie idzie z powłoki, a nie z UI: schowane okno WebView może mieć wstrzymane timery, a tray ma działać także
//! przy zamkniętym oknie. Czy sesja czeka na Ciebie, liczy daemon (`Session.needsAttention`), tak samo dla UI i traya.

use crate::daemon;
use crate::daemon_state::DaemonState;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

const POLL: Duration = Duration::from_secs(2);
/// Zdarzenie dla UI z identyfikatorem sesji do pokazania (`FOCUS_SESSION_EVENT` w `use-session-focus.ts`).
const FOCUS_SESSION_EVENT: &str = "focus-session";
/// Identyfikatory pozycji menu traya; pozycja sesji to prefiks i identyfikator sesji.
pub const MENU_SHOW: &str = "show";
pub const MENU_QUIT: &str = "quit";
const MENU_SESSION_PREFIX: &str = "session:";

/// Sesja, która czeka na Ciebie.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    pub id: String,
    pub repo: String,
}

/// Stan sesji z ostatniego pytania: identyfikator i stan z `TaskState` (albo `None` bez sygnału).
type States = HashMap<String, Option<String>>;

/// Tylko te pola odpowiedzi `POST /api/agents/sessions`, których potrzebuje tray (`SessionList` w protocol).
#[derive(Deserialize)]
struct Reply {
    data: SessionList,
}

#[derive(Deserialize)]
struct SessionList {
    sessions: Vec<Session>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    repo: String,
    run: Run,
    state: Option<StateChange>,
    needs_attention: bool,
}

#[derive(Deserialize)]
struct Run {
    kind: String,
}

#[derive(Deserialize)]
struct StateChange {
    state: String,
}

/// Sesje z odpowiedzi daemona: stan każdej działającej sesji i te, które czekają na Ciebie.
pub fn parse_sessions(body: &str) -> Option<(States, Vec<Waiting>)> {
    let reply: Reply = serde_json::from_str(body).ok()?;
    let mut states = States::new();
    let mut waiting = Vec::new();
    for s in reply.data.sessions.into_iter().filter(|s| s.run.kind == "running") {
        if s.needs_attention {
            waiting.push(Waiting { id: s.id.clone(), repo: s.repo });
        }
        states.insert(s.id, s.state.map(|c| c.state));
    }
    Some((states, waiting))
}

/// Sesje, które właśnie skończyły pracę i czekają: wcześniej `Working` albo `Stale`. Sesja po starcie czeka na pierwszy
/// prompt, ale wtedy użytkownik i tak na nią patrzy, więc nie jest powodem do zwracania uwagi.
pub fn newly_waiting(previous: &States, waiting: &[Waiting]) -> Vec<Waiting> {
    waiting.iter().filter(|w| matches!(previous.get(&w.id), Some(Some(state)) if state == "Working" || state == "Stale")).cloned().collect()
}

pub fn tooltip(waiting: &[Waiting]) -> String {
    match waiting {
        [] => "Trackwall".to_owned(),
        [only] => format!("Trackwall: sesja {} czeka na Ciebie", only.repo),
        _ => format!("Trackwall: {} na Ciebie", count_label(waiting.len(), "sesja czeka", "sesje czekają", "sesji czeka")),
    }
}

/// Liczba z polską formą: 1 sesja, 2–4 sesje (ale 12–14 sesji), 5 sesji; to samo co `countLabel` w UI (`format.ts`).
fn count_label(n: usize, one: &str, few: &str, many: &str) -> String {
    let form = if n == 1 {
        one
    } else if (2..=4).contains(&(n % 10)) && !(12..=14).contains(&(n % 100)) {
        few
    } else {
        many
    };
    format!("{n} {form}")
}

/// Menu traya: sesje czekające na górze, potem stałe pozycje.
pub fn build_menu(app: &AppHandle, waiting: &[Waiting]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for w in waiting {
        let label = format!("Czeka: {}", w.repo);
        menu.append(&MenuItem::with_id(app, format!("{MENU_SESSION_PREFIX}{}", w.id), label, true, None::<&str>)?)?;
    }
    if !waiting.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, MENU_SHOW, "Pokaż Trackwall", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, MENU_QUIT, "Wyjdź (zatrzymuje daemon)", true, None::<&str>)?)?;
    Ok(menu)
}

/// Identyfikator sesji z pozycji menu traya albo `None` dla stałych pozycji.
pub fn session_from_menu(id: &str) -> Option<&str> {
    id.strip_prefix(MENU_SESSION_PREFIX)
}

/// Pokazuje okno i prosi UI o przełączenie na sesję.
pub fn focus_session(app: &AppHandle, session: &str, show: fn(&AppHandle)) {
    show(app);
    let _ = app.emit_to("main", FOCUS_SESSION_EVENT, session);
}

/// Wątek pytający daemon o sesje, dopóki działa powłoka.
pub fn watch(app: AppHandle, state: Arc<DaemonState>, tray_id: &'static str) {
    std::thread::spawn(move || {
        let mut previous = States::new();
        let mut shown: Vec<Waiting> = Vec::new();
        loop {
            std::thread::sleep(POLL);
            let Some(conn) = state.ready() else { continue };
            let Some((states, waiting)) = daemon::sessions(&conn).ok().and_then(|body| parse_sessions(&body)) else { continue };
            if !newly_waiting(&previous, &waiting).is_empty() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.request_user_attention(Some(UserAttentionType::Informational));
                }
            }
            if waiting != shown {
                if let Some(tray) = app.tray_by_id(tray_id) {
                    let _ = tray.set_tooltip(Some(tooltip(&waiting)));
                    if let Ok(menu) = build_menu(&app, &waiting) {
                        let _ = tray.set_menu(Some(menu));
                    }
                }
                shown = waiting;
            }
            previous = states;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(sessions: &str) -> String {
        format!(r#"{{"ok":true,"data":{{"sessions":[{sessions}]}}}}"#)
    }

    fn session(id: &str, run: &str, state: Option<&str>) -> String {
        let attention = run == "running" && matches!(state, Some("Input" | "Approval" | "Plan"));
        let state = state.map(|s| format!(r#"{{"state":"{s}","source":"hook","confidence":"high","at":"x","reason":"r"}}"#));
        format!(
            r#"{{"id":"{id}","repo":"repo-{id}","startedAt":"x","run":{{"kind":"{run}"}},"state":{},"windowTitle":null,"needsAttention":{attention}}}"#,
            state.unwrap_or_else(|| "null".into())
        )
    }

    #[test]
    fn waiting_sessions_are_the_ones_daemon_marks_as_needing_attention() {
        let list = [
            session("a", "running", Some("Working")),
            session("b", "running", Some("Approval")),
            session("c", "exited", Some("Input")),
            session("d", "running", None),
        ];
        let (states, waiting) = parse_sessions(&body(&list.join(","))).expect("poprawna odpowiedź");
        assert_eq!(waiting, vec![Waiting { id: "b".into(), repo: "repo-b".into() }]);
        assert_eq!(states.len(), 3);
        assert_eq!(states["d"], None);
    }

    #[test]
    fn only_sessions_that_stopped_working_are_newly_waiting() {
        let (before, _) =
            parse_sessions(&body(&[session("a", "running", Some("Working")), session("b", "running", None)].join(","))).unwrap();
        let (_, now) =
            parse_sessions(&body(&[session("a", "running", Some("Input")), session("b", "running", Some("Input"))].join(","))).unwrap();
        assert_eq!(newly_waiting(&before, &now), vec![Waiting { id: "a".into(), repo: "repo-a".into() }]);
        assert_eq!(newly_waiting(&States::new(), &now), vec![]);
    }

    #[test]
    fn error_response_is_not_a_list() {
        assert!(parse_sessions(r#"{"ok":false,"error":{"code":"internal","message":"x"}}"#).is_none());
    }

    #[test]
    fn tooltip_names_the_only_waiting_session_or_counts_them() {
        let w = |id: &str| Waiting { id: id.into(), repo: format!("repo-{id}") };
        assert_eq!(tooltip(&[]), "Trackwall");
        assert_eq!(tooltip(&[w("a")]), "Trackwall: sesja repo-a czeka na Ciebie");
        assert_eq!(tooltip(&[w("a"), w("b")]), "Trackwall: 2 sesje czekają na Ciebie");
        assert_eq!(tooltip(&["a", "b", "c", "d", "e"].map(w)), "Trackwall: 5 sesji czeka na Ciebie");
        assert_eq!(count_label(12, "sesja", "sesje", "sesji"), "12 sesji");
        assert_eq!(count_label(22, "sesja", "sesje", "sesji"), "22 sesje");
        assert_eq!(session_from_menu("session:abc"), Some("abc"));
        assert_eq!(session_from_menu(MENU_SHOW), None);
    }
}
