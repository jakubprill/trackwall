//! Sesje Copilot CLI, które czekają na Ciebie (ADR-26), i propozycje zadań, które czekają na decyzję (ADR-39): powłoka
//! co chwilę pyta daemon o listę sesji i, gdy któraś sesja przestaje pracować i zaczyna czekać albo przychodzi nowa
//! propozycja, zwraca uwagę użytkownika (miganie na pasku zadań, podskok w Docku), zmienia podpowiedź i menu traya.
//! Kliknięcie pozycji w menu pokazuje okno z tą sesją albo propozycją.
//!
//! Pytanie idzie z powłoki, a nie z UI: schowane okno WebView może mieć wstrzymane timery, a tray ma działać także
//! przy zamkniętym oknie. Czy sesja czeka na Ciebie, liczy daemon (`Session.needsAttention`), tak samo dla UI i traya.

use crate::daemon;
use crate::daemon_state::DaemonState;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};

const POLL: Duration = Duration::from_secs(2);
/// Zdarzenia dla UI z identyfikatorem sesji albo propozycji do pokazania (te same nazwy w `use-session-focus.ts`).
const FOCUS_SESSION_EVENT: &str = "focus-session";
const FOCUS_PROPOSAL_EVENT: &str = "focus-proposal";
/// Identyfikatory pozycji menu traya; pozycja sesji albo propozycji to prefiks i jej identyfikator.
pub const MENU_SHOW: &str = "show";
pub const MENU_QUIT: &str = "quit";
const MENU_SESSION_PREFIX: &str = "session:";
const MENU_PROPOSAL_PREFIX: &str = "proposal:";

/// Sesja, która czeka na Ciebie.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    pub id: String,
    pub repo: String,
}

/// Propozycja zadania, która czeka na decyzję (`TaskProposal` w protocol, tylko pola dla traya).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub repo: String,
    pub title: String,
}

/// Stan sesji z ostatniego pytania: identyfikator i stan z `TaskState` (albo `None` bez sygnału).
type States = HashMap<String, Option<String>>;

/// Odpowiedź daemona przełożona na to, co pokazuje tray.
#[derive(Debug)]
pub struct Snapshot {
    states: States,
    waiting: Vec<Waiting>,
    proposals: Vec<Proposal>,
}

/// Tylko te pola odpowiedzi `POST /api/agents/sessions`, których potrzebuje tray (`SessionList` w protocol).
#[derive(Deserialize)]
struct Reply {
    data: SessionList,
}

#[derive(Deserialize)]
struct SessionList {
    sessions: Vec<Session>,
    proposals: Vec<Proposal>,
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

/// Sesje i propozycje z odpowiedzi daemona: stan każdej działającej sesji, te, które czekają na Ciebie, i propozycje.
pub fn parse_sessions(body: &str) -> Option<Snapshot> {
    let reply: Reply = serde_json::from_str(body).ok()?;
    let mut states = States::new();
    let mut waiting = Vec::new();
    for s in reply.data.sessions.into_iter().filter(|s| s.run.kind == "running") {
        if s.needs_attention {
            waiting.push(Waiting { id: s.id.clone(), repo: s.repo });
        }
        states.insert(s.id, s.state.map(|c| c.state));
    }
    Some(Snapshot { states, waiting, proposals: reply.data.proposals })
}

/// Sesje, które właśnie skończyły pracę i czekają: wcześniej `Working` albo `Stale`. Sesja po starcie czeka na pierwszy
/// prompt, ale wtedy użytkownik i tak na nią patrzy, więc nie jest powodem do zwracania uwagi.
pub fn newly_waiting(previous: &States, waiting: &[Waiting]) -> Vec<Waiting> {
    waiting.iter().filter(|w| matches!(previous.get(&w.id), Some(Some(state)) if state == "Working" || state == "Stale")).cloned().collect()
}

/// Propozycje, których nie było przy poprzednim pytaniu. Przy pierwszym (`None`, start powłoki albo daemona)
/// żadna nie jest nowa, tak jak sesja, która czekała już przed startem.
pub fn new_proposals<'a>(previous: Option<&HashSet<String>>, proposals: &'a [Proposal]) -> Vec<&'a Proposal> {
    let Some(previous) = previous else { return Vec::new() };
    proposals.iter().filter(|p| !previous.contains(&p.id)).collect()
}

pub fn tooltip(waiting: &[Waiting], proposals: &[Proposal]) -> String {
    match (waiting, proposals) {
        ([], []) => "Trackwall".to_owned(),
        ([only], []) => format!("Trackwall: a session in {} is waiting for you", only.repo),
        ([], [only]) => format!("Trackwall: a task proposal for {} is waiting for your decision", only.repo),
        _ => {
            let parts: Vec<String> = [(waiting.len(), "session", "sessions"), (proposals.len(), "task proposal", "task proposals")]
                .into_iter()
                .filter(|(n, _, _)| *n > 0)
                .map(|(n, one, other)| format!("{n} {}", if n == 1 { one } else { other }))
                .collect();
            format!("Trackwall: {} are waiting for you", parts.join(" and "))
        }
    }
}

/// Tekst pozycji menu: `&` w menu oznacza klawisz skrótu, więc tytuł od agenta dostaje go podwojonego.
fn menu_text(text: &str) -> String {
    text.replace('&', "&&")
}

/// Menu traya: propozycje i sesje czekające na górze, potem stałe pozycje.
pub fn build_menu(app: &AppHandle, waiting: &[Waiting], proposals: &[Proposal]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for p in proposals {
        let label = menu_text(&format!("Proposal: {} · {}", p.repo, p.title));
        menu.append(&MenuItem::with_id(app, format!("{MENU_PROPOSAL_PREFIX}{}", p.id), label, true, None::<&str>)?)?;
    }
    for w in waiting {
        let label = menu_text(&format!("Waiting: {}", w.repo));
        menu.append(&MenuItem::with_id(app, format!("{MENU_SESSION_PREFIX}{}", w.id), label, true, None::<&str>)?)?;
    }
    if !waiting.is_empty() || !proposals.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, MENU_SHOW, "Show Trackwall", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, MENU_QUIT, "Quit (stops the daemon)", true, None::<&str>)?)?;
    Ok(menu)
}

/// Co pokazać po kliknięciu pozycji menu traya.
#[derive(Debug, PartialEq, Eq)]
pub enum Focus<'a> {
    Session(&'a str),
    Proposal(&'a str),
}

/// Sesja albo propozycja z pozycji menu traya; `None` dla stałych pozycji.
pub fn focus_from_menu(id: &str) -> Option<Focus<'_>> {
    if let Some(session) = id.strip_prefix(MENU_SESSION_PREFIX) {
        return Some(Focus::Session(session));
    }
    id.strip_prefix(MENU_PROPOSAL_PREFIX).map(Focus::Proposal)
}

/// Pokazuje okno i prosi UI o przełączenie na sesję albo propozycję.
pub fn focus(app: &AppHandle, target: Focus<'_>, show: fn(&AppHandle)) {
    show(app);
    let _ = match target {
        Focus::Session(id) => app.emit_to("main", FOCUS_SESSION_EVENT, id),
        Focus::Proposal(id) => app.emit_to("main", FOCUS_PROPOSAL_EVENT, id),
    };
}

/// Wątek pytający daemon o sesje, dopóki działa powłoka.
pub fn watch(app: AppHandle, state: Arc<DaemonState>, tray_id: &'static str) {
    std::thread::spawn(move || {
        let mut previous = States::new();
        let mut known: Option<HashSet<String>> = None;
        let mut shown: (Vec<Waiting>, Vec<Proposal>) = (Vec::new(), Vec::new());
        loop {
            std::thread::sleep(POLL);
            let Some(conn) = state.ready() else { continue };
            let Some(now) = daemon::sessions(&conn).ok().and_then(|body| parse_sessions(&body)) else { continue };
            if !newly_waiting(&previous, &now.waiting).is_empty() || !new_proposals(known.as_ref(), &now.proposals).is_empty() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.request_user_attention(Some(UserAttentionType::Informational));
                }
            }
            known = Some(now.proposals.iter().map(|p| p.id.clone()).collect());
            if (&now.waiting, &now.proposals) != (&shown.0, &shown.1) {
                if let Some(tray) = app.tray_by_id(tray_id) {
                    let _ = tray.set_tooltip(Some(tooltip(&now.waiting, &now.proposals)));
                    if let Ok(menu) = build_menu(&app, &now.waiting, &now.proposals) {
                        let _ = tray.set_menu(Some(menu));
                    }
                }
                shown = (now.waiting, now.proposals);
            }
            previous = now.states;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(sessions: &str, proposals: &str) -> String {
        format!(r#"{{"ok":true,"data":{{"sessions":[{sessions}],"proposals":[{proposals}]}}}}"#)
    }

    fn session(id: &str, run: &str, state: Option<&str>) -> String {
        let attention = run == "running" && matches!(state, Some("Input" | "Approval" | "Plan"));
        let state = state.map(|s| format!(r#"{{"state":"{s}","source":"hook","confidence":"high","at":"x","reason":"r"}}"#));
        format!(
            r#"{{"id":"{id}","repo":"repo-{id}","startedAt":"x","run":{{"kind":"{run}"}},"state":{},"windowTitle":null,"needsAttention":{attention}}}"#,
            state.unwrap_or_else(|| "null".into())
        )
    }

    fn proposal_json(id: &str) -> String {
        format!(r#"{{"id":"{id}","repo":"repo-{id}","title":"Fix {id}","prompt":"p","proposedBy":{{"session":null}},"createdAt":"x"}}"#)
    }

    fn proposal(id: &str) -> Proposal {
        Proposal { id: id.into(), repo: format!("repo-{id}"), title: format!("Fix {id}") }
    }

    fn waiting(id: &str) -> Waiting {
        Waiting { id: id.into(), repo: format!("repo-{id}") }
    }

    #[test]
    fn waiting_sessions_are_the_ones_daemon_marks_as_needing_attention() {
        let list = [
            session("a", "running", Some("Working")),
            session("b", "running", Some("Approval")),
            session("c", "exited", Some("Input")),
            session("d", "running", None),
        ];
        let now = parse_sessions(&body(&list.join(","), &proposal_json("p"))).expect("poprawna odpowiedź");
        assert_eq!(now.waiting, vec![waiting("b")]);
        assert_eq!(now.proposals, vec![proposal("p")]);
        assert_eq!(now.states.len(), 3);
        assert_eq!(now.states["d"], None);
    }

    #[test]
    fn only_sessions_that_stopped_working_are_newly_waiting() {
        let before =
            parse_sessions(&body(&[session("a", "running", Some("Working")), session("b", "running", None)].join(","), "")).unwrap();
        let now =
            parse_sessions(&body(&[session("a", "running", Some("Input")), session("b", "running", Some("Input"))].join(","), "")).unwrap();
        assert_eq!(newly_waiting(&before.states, &now.waiting), vec![waiting("a")]);
        assert_eq!(newly_waiting(&States::new(), &now.waiting), vec![]);
    }

    #[test]
    fn a_proposal_is_new_only_when_it_was_not_there_on_the_previous_poll() {
        let now = [proposal("p1"), proposal("p2")];
        let before: HashSet<String> = ["p1".to_owned()].into();
        assert_eq!(new_proposals(Some(&before), &now), vec![&now[1]]);
        assert_eq!(new_proposals(None, &now), Vec::<&Proposal>::new());
    }

    #[test]
    fn error_response_is_not_a_list() {
        assert!(parse_sessions(r#"{"ok":false,"error":{"code":"internal","message":"x"}}"#).is_none());
    }

    #[test]
    fn tooltip_names_the_only_waiting_item_or_counts_them() {
        assert_eq!(tooltip(&[], &[]), "Trackwall");
        assert_eq!(tooltip(&[waiting("a")], &[]), "Trackwall: a session in repo-a is waiting for you");
        assert_eq!(tooltip(&[], &[proposal("p")]), "Trackwall: a task proposal for repo-p is waiting for your decision");
        assert_eq!(tooltip(&[waiting("a"), waiting("b")], &[]), "Trackwall: 2 sessions are waiting for you");
        assert_eq!(
            tooltip(&[waiting("a")], &[proposal("p"), proposal("q")]),
            "Trackwall: 1 session and 2 task proposals are waiting for you"
        );
        assert_eq!(tooltip(&[], &[proposal("p"), proposal("q")]), "Trackwall: 2 task proposals are waiting for you");
    }

    #[test]
    fn menu_item_points_at_a_session_or_a_proposal() {
        assert_eq!(focus_from_menu("session:abc"), Some(Focus::Session("abc")));
        assert_eq!(focus_from_menu("proposal:abc"), Some(Focus::Proposal("abc")));
        assert_eq!(focus_from_menu(MENU_SHOW), None);
        assert_eq!(menu_text("Fix A & B"), "Fix A && B");
    }
}
