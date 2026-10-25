//! Copilot CLI sessions that are waiting for you (ADR-26) and task proposals waiting for a decision (ADR-39): the shell
//! asks the daemon for the session list every few seconds and, when a session stops working and starts waiting or a new
//! proposal arrives, draws the user's attention (taskbar flash, Dock bounce) and updates the tray tooltip and menu.
//! Clicking a menu item shows the window for sessions (ADR-49) with that session or proposal. While no Trackwall window has the focus, the
//! same moments also show a system notification (ADR-50, `notification.rs`).
//!
//! Pytanie idzie z powłoki, a nie z UI: schowane okno WebView może mieć wstrzymane timery, a tray ma działać także
//! przy zamkniętym oknie. Czy sesja czeka na Ciebie, liczy daemon (`Session.needsAttention`), tak samo dla UI i traya.
//! The daemon also clears it, without a state change, once the user has seen an ended turn (ADR-47).

use crate::daemon;
use crate::daemon_state::DaemonState;
use crate::jump::Jump;
use crate::notification;
use crate::windows::Windows;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager, UserAttentionType};

const POLL: Duration = Duration::from_secs(2);
/// Tray menu item ids; a session or proposal item is a prefix plus its id.
pub const MENU_SHOW: &str = "show";
pub const MENU_NEW_WINDOW: &str = "new-window";
pub const MENU_QUIT: &str = "quit";
const MENU_SESSION_PREFIX: &str = "session:";
const MENU_PROPOSAL_PREFIX: &str = "proposal:";

/// A session that is waiting for you, with its state (`None` without a signal).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    pub id: String,
    /// `None` for the supervisor, the session in the projects folder (ADR-58).
    pub repo: Option<String>,
    pub state: Option<TaskState>,
}

impl Waiting {
    /// Where the session works, for the menu: its repo, or the supervisor.
    pub fn place(&self) -> &str {
        self.repo.as_deref().unwrap_or("supervisor")
    }

    /// The session in a sentence: "a session in <repo>", or "the supervisor".
    fn described(&self) -> String {
        self.repo.as_ref().map_or_else(|| "the supervisor".to_owned(), |repo| format!("a session in {repo}"))
    }
}

/// `TaskState` from protocol; a state this shell does not know yet reads as `Unknown` instead of failing the reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum TaskState {
    Working,
    Input,
    Approval,
    Plan,
    Done,
    Error,
    Stale,
    #[serde(other)]
    Unknown,
}

/// A task proposal waiting for a decision (`TaskProposal` in protocol, only the fields the tray needs).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub repo: String,
    pub title: String,
}

/// Stan sesji z ostatniego pytania: identyfikator i stan (albo `None` bez sygnału).
type States = HashMap<String, Option<TaskState>>;

/// The daemon's reply translated into what the tray shows.
#[derive(Debug)]
pub struct Snapshot {
    states: States,
    waiting: Vec<Waiting>,
    proposals: Vec<Proposal>,
    /// Ids of proposals and tasks: a proposal being approved is already a task, and after a failed start it comes back
    /// as a proposal with the same id, which is not new.
    known: HashSet<String>,
}

/// Tylko te pola odpowiedzi `POST /api/agents/sessions`, których potrzebuje tray (`SessionList` w protocol).
#[derive(Deserialize)]
struct Reply {
    data: SessionList,
}

#[derive(Deserialize)]
struct SessionList {
    sessions: Vec<Session>,
    tasks: Vec<TaskRef>,
    proposals: Vec<Proposal>,
}

#[derive(Deserialize)]
struct TaskRef {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    repo: Option<String>,
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
    state: TaskState,
}

/// Sessions and proposals from the daemon's reply: the state of every running session, the waiting ones, and proposals.
pub fn parse_sessions(body: &str) -> Option<Snapshot> {
    let reply: Reply = serde_json::from_str(body).ok()?;
    let mut states = States::new();
    let mut waiting = Vec::new();
    for s in reply.data.sessions.into_iter().filter(|s| s.run.kind == "running") {
        let state = s.state.map(|c| c.state);
        if s.needs_attention {
            waiting.push(Waiting { id: s.id.clone(), repo: s.repo, state });
        }
        states.insert(s.id, state);
    }
    let known = reply.data.proposals.iter().map(|p| p.id.clone()).chain(reply.data.tasks.into_iter().map(|t| t.id)).collect();
    Some(Snapshot { states, waiting, proposals: reply.data.proposals, known })
}

/// Sessions that just finished working and wait: `Working` or `Stale` before. A session after start waits for its first
/// prompt while the user looks at it anyway, and a turn that ends in a window the user is looking at never waits (the
/// daemon marks it seen, ADR-47), so the window flashes only for unseen ends of turns.
pub fn newly_waiting(previous: &States, waiting: &[Waiting]) -> Vec<Waiting> {
    waiting.iter().filter(|w| matches!(previous.get(&w.id), Some(Some(TaskState::Working | TaskState::Stale)))).cloned().collect()
}

/// Proposals that were neither a proposal nor a task at the previous poll. At the first poll after the shell starts
/// (`None`) none is new, just like a session that was already waiting before the start.
pub fn new_proposals<'a>(previous: Option<&Snapshot>, proposals: &'a [Proposal]) -> Vec<&'a Proposal> {
    let Some(previous) = previous else { return Vec::new() };
    proposals.iter().filter(|p| !previous.known.contains(&p.id)).collect()
}

pub fn tooltip(waiting: &[Waiting], proposals: &[Proposal]) -> String {
    match (waiting, proposals) {
        ([], []) => "Trackwall".to_owned(),
        ([only], []) => format!("Trackwall: {} is waiting for you", only.described()),
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

/// Menu item text: `&` marks a mnemonic in menus, so it is doubled in a title that comes from an agent.
fn menu_text(text: &str) -> String {
    text.replace('&', "&&")
}

/// Tray menu: proposals and waiting sessions at the top, then the fixed items.
pub fn build_menu(app: &AppHandle, waiting: &[Waiting], proposals: &[Proposal]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for p in proposals {
        let label = menu_text(&format!("Proposal: {} · {}", p.repo, p.title));
        menu.append(&MenuItem::with_id(app, format!("{MENU_PROPOSAL_PREFIX}{}", p.id), label, true, None::<&str>)?)?;
    }
    for w in waiting {
        let label = menu_text(&format!("Waiting: {}", w.place()));
        menu.append(&MenuItem::with_id(app, format!("{MENU_SESSION_PREFIX}{}", w.id), label, true, None::<&str>)?)?;
    }
    if !waiting.is_empty() || !proposals.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, MENU_SHOW, "Show Trackwall", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, MENU_NEW_WINDOW, "New window", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, MENU_QUIT, "Quit (stops the daemon)", true, None::<&str>)?)?;
    Ok(menu)
}

/// The session or proposal of a tray menu item; `None` for the fixed items.
pub fn jump_from_menu(id: &str) -> Option<Jump> {
    if let Some(session) = id.strip_prefix(MENU_SESSION_PREFIX) {
        return Some(Jump::Session(session.to_owned()));
    }
    id.strip_prefix(MENU_PROPOSAL_PREFIX).map(|proposal| Jump::Proposal(proposal.to_owned()))
}

/// What deserves the user's attention since the previous poll.
#[derive(Debug, PartialEq, Eq)]
pub struct News {
    /// Sessions that just started waiting (`newly_waiting`).
    pub sessions: Vec<Waiting>,
    /// Proposals that are new (`new_proposals`).
    pub proposals: Vec<Proposal>,
}

impl News {
    pub fn between(previous: Option<&Snapshot>, now: &Snapshot) -> News {
        let no_states = States::new();
        let previous_states = previous.map_or(&no_states, |p| &p.states);
        News {
            sessions: newly_waiting(previous_states, &now.waiting),
            proposals: new_proposals(previous, &now.proposals).into_iter().cloned().collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty() && self.proposals.is_empty()
    }
}

/// Polls in a row without a new proposal before the held proposals are announced (ADR-55).
const QUIET_POLLS: u32 = 3;

/// New proposals held back while a main session is still proposing: it writes a plan of several tasks with a few
/// seconds between `propose_task` calls, and one notification for the plan says more than one per task (ADR-55). They
/// are announced after `QUIET_POLLS` polls without a new one, about six seconds, and only those still waiting.
#[derive(Debug, Default)]
pub struct HeldProposals {
    held: Vec<Proposal>,
    quiet: u32,
}

impl HeldProposals {
    /// Takes the new proposals of a poll and returns the ones to announce now.
    pub fn after_poll(&mut self, new: Vec<Proposal>, waiting: &[Proposal]) -> Vec<Proposal> {
        if !new.is_empty() {
            self.held.extend(new);
            self.quiet = 0;
            return Vec::new();
        }
        if self.held.is_empty() {
            return Vec::new();
        }
        self.quiet += 1;
        if self.quiet < QUIET_POLLS {
            return Vec::new();
        }
        self.quiet = 0;
        std::mem::take(&mut self.held).into_iter().filter(|p| waiting.iter().any(|w| w.id == p.id)).collect()
    }
}

fn any_window_focused(app: &AppHandle) -> bool {
    app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false))
}

/// The thread that asks the daemon for sessions while the shell runs.
pub fn watch(app: AppHandle, state: Arc<DaemonState>, tray_id: &'static str) {
    std::thread::spawn(move || {
        let mut last: Option<Snapshot> = None;
        let mut held = HeldProposals::default();
        loop {
            std::thread::sleep(POLL);
            let Some(conn) = state.ready() else { continue };
            let Some(now) = daemon::sessions(&conn).ok().and_then(|body| parse_sessions(&body)) else { continue };
            let mut news = News::between(last.as_ref(), &now);
            news.proposals = held.after_poll(std::mem::take(&mut news.proposals), &now.proposals);
            if !news.is_empty() {
                if let Some(window) = app.get_webview_window(&app.state::<Windows>().session_window()) {
                    let _ = window.request_user_attention(Some(UserAttentionType::Informational));
                }
                // The user looking at Trackwall sees the badges; a notification on top of that would only be noise.
                if !any_window_focused(&app) {
                    notification::show_news(&app, &news);
                }
            }
            if last.as_ref().is_none_or(|l| l.waiting != now.waiting || l.proposals != now.proposals) {
                if let Some(tray) = app.tray_by_id(tray_id) {
                    let _ = tray.set_tooltip(Some(tooltip(&now.waiting, &now.proposals)));
                    if let Ok(menu) = build_menu(&app, &now.waiting, &now.proposals) {
                        let _ = tray.set_menu(Some(menu));
                    }
                }
            }
            last = Some(now);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(sessions: &str, proposals: &str) -> String {
        body_with_tasks(sessions, "", proposals)
    }

    fn body_with_tasks(sessions: &str, tasks: &str, proposals: &str) -> String {
        format!(r#"{{"ok":true,"data":{{"sessions":[{sessions}],"tasks":[{tasks}],"proposals":[{proposals}]}}}}"#)
    }

    fn session(id: &str, run: &str, state: Option<&str>) -> String {
        // The daemon decides `needsAttention` (ADR-47); here an unseen `Input`, `Approval` or `Plan` stands for it.
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

    fn waiting(id: &str, state: TaskState) -> Waiting {
        Waiting { id: id.into(), repo: Some(format!("repo-{id}")), state: Some(state) }
    }

    #[test]
    fn the_supervisor_has_no_repo_and_is_named_as_the_supervisor() {
        let supervisor = r#"{"id":"s","repo":null,"startedAt":"x","run":{"kind":"running"},"state":{"state":"Input","source":"hook","confidence":"high","at":"x","reason":"r"},"windowTitle":null,"needsAttention":true}"#;
        let now = parse_sessions(&body(supervisor, "")).expect("a valid reply");
        assert_eq!(now.waiting, vec![Waiting { id: "s".into(), repo: None, state: Some(TaskState::Input) }]);
        assert_eq!(now.waiting[0].place(), "supervisor");
        assert_eq!(tooltip(&now.waiting, &[]), "Trackwall: the supervisor is waiting for you");
    }

    #[test]
    fn waiting_sessions_are_the_ones_daemon_marks_as_needing_attention() {
        let list = [
            session("a", "running", Some("Working")),
            session("b", "running", Some("Approval")),
            session("c", "exited", Some("Input")),
            session("d", "running", None),
        ];
        let now = parse_sessions(&body(&list.join(","), &proposal_json("p"))).expect("a valid reply");
        assert_eq!(now.waiting, vec![waiting("b", TaskState::Approval)]);
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
        assert_eq!(newly_waiting(&before.states, &now.waiting), vec![waiting("a", TaskState::Input)]);
        assert_eq!(newly_waiting(&States::new(), &now.waiting), vec![]);
    }

    #[test]
    fn a_proposal_is_new_only_when_it_was_not_there_on_the_previous_poll() {
        let before = parse_sessions(&body("", &proposal_json("p1"))).unwrap();
        let now = parse_sessions(&body("", &[proposal_json("p1"), proposal_json("p2")].join(","))).unwrap();
        assert_eq!(new_proposals(Some(&before), &now.proposals), vec![&proposal("p2")]);
        assert_eq!(new_proposals(None, &now.proposals), Vec::<&Proposal>::new());
    }

    #[test]
    fn proposals_are_announced_together_once_the_main_session_stops_proposing() {
        let mut held = HeldProposals::default();
        let waiting = [proposal("p1"), proposal("p2")];
        assert_eq!(held.after_poll(vec![proposal("p1")], &waiting), vec![]);
        assert_eq!(held.after_poll(vec![], &waiting), vec![]);
        assert_eq!(held.after_poll(vec![proposal("p2")], &waiting), vec![]);
        assert_eq!(held.after_poll(vec![], &waiting), vec![]);
        assert_eq!(held.after_poll(vec![], &waiting), vec![]);
        assert_eq!(held.after_poll(vec![], &waiting), vec![proposal("p1"), proposal("p2")]);
        assert_eq!(held.after_poll(vec![], &waiting), vec![]);
    }

    #[test]
    fn a_held_proposal_the_user_has_already_decided_on_is_not_announced() {
        let mut held = HeldProposals::default();
        assert_eq!(held.after_poll(vec![proposal("p1"), proposal("p2")], &[proposal("p1"), proposal("p2")]), vec![]);
        for _ in 1..QUIET_POLLS {
            assert_eq!(held.after_poll(vec![], &[proposal("p2")]), vec![]);
        }
        assert_eq!(held.after_poll(vec![], &[proposal("p2")]), vec![proposal("p2")]);
    }

    #[test]
    fn a_proposal_back_after_a_failed_start_is_not_new() {
        // While being approved the proposal is already a task; after a failed start it comes back as a proposal.
        let approving = parse_sessions(&body_with_tasks("", r#"{"id":"p"}"#, "")).unwrap();
        let back = parse_sessions(&body("", &proposal_json("p"))).unwrap();
        assert_eq!(new_proposals(Some(&approving), &back.proposals), Vec::<&Proposal>::new());
    }

    #[test]
    fn a_state_the_shell_does_not_know_does_not_break_the_reply() {
        let now = parse_sessions(&body(&session("a", "running", Some("Thinking")), "")).expect("a valid reply");
        assert_eq!(now.states["a"], Some(TaskState::Unknown));
    }

    #[test]
    fn error_response_is_not_a_list() {
        assert!(parse_sessions(r#"{"ok":false,"error":{"code":"internal","message":"x"}}"#).is_none());
    }

    #[test]
    fn tooltip_names_the_only_waiting_item_or_counts_them() {
        assert_eq!(tooltip(&[], &[]), "Trackwall");
        assert_eq!(tooltip(&[waiting("a", TaskState::Input)], &[]), "Trackwall: a session in repo-a is waiting for you");
        assert_eq!(tooltip(&[], &[proposal("p")]), "Trackwall: a task proposal for repo-p is waiting for your decision");
        assert_eq!(
            tooltip(&[waiting("a", TaskState::Input), waiting("b", TaskState::Input)], &[]),
            "Trackwall: 2 sessions are waiting for you"
        );
        assert_eq!(
            tooltip(&[waiting("a", TaskState::Input)], &[proposal("p"), proposal("q")]),
            "Trackwall: 1 session and 2 task proposals are waiting for you"
        );
        assert_eq!(tooltip(&[], &[proposal("p"), proposal("q")]), "Trackwall: 2 task proposals are waiting for you");
    }

    #[test]
    fn menu_item_points_at_a_session_or_a_proposal() {
        assert_eq!(jump_from_menu("session:abc"), Some(Jump::Session("abc".into())));
        assert_eq!(jump_from_menu("proposal:abc"), Some(Jump::Proposal("abc".into())));
        assert_eq!(jump_from_menu(MENU_SHOW), None);
        assert_eq!(menu_text("Fix A & B"), "Fix A && B");
    }

    #[test]
    fn news_are_the_sessions_that_started_waiting_and_the_new_proposals() {
        let before = parse_sessions(&body(&session("a", "running", Some("Working")), &proposal_json("p1"))).unwrap();
        let now = parse_sessions(&body(&session("a", "running", Some("Approval")), &[proposal_json("p1"), proposal_json("p2")].join(",")))
            .unwrap();
        assert_eq!(
            News::between(Some(&before), &now),
            News { sessions: vec![waiting("a", TaskState::Approval)], proposals: vec![proposal("p2")] }
        );
        assert!(News::between(Some(&now), &now).is_empty());
        assert!(News::between(None, &now).is_empty());
    }
}
