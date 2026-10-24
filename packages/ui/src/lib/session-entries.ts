import type { ProposedBy, Session, SessionList, Task, TaskProposal } from "@trackwall/protocol";

/**
 * Pozycje listy w widoku „Sesje” (§4.4, ADR-31): sesja w korzeniu repo albo zadanie z ostatnią sesją, jeśli ma ją
 * w tym działaniu daemona. Zadanie nie zna swojej sesji, to sesja wskazuje zadanie (`Session.task`). Zadanie jest
 * jedną pozycją, choć po wznowieniu ma nową sesję, a bez sesji (po restarcie daemona albo zamknięciu sesji) zostaje
 * na liście do zakończenia. Propozycja zadania (ADR-39) czeka na decyzję użytkownika i nie ma jeszcze ani worktree,
 * ani sesji; zatwierdzona staje się zadaniem z tym samym identyfikatorem.
 */
export type SessionEntry =
  | { kind: "proposal"; proposal: TaskProposal }
  | { kind: "session"; session: Session }
  | { kind: "task"; task: Task; session: Session | undefined };

/** Co pokazuje prawa część widoku: formularz nowej sesji, wybraną pozycję, a bez wyboru pierwszą pozycję. */
export type SessionSelection =
  | { kind: "new" }
  | { kind: "session"; id: string }
  | { kind: "task"; id: string }
  | { kind: "proposal"; id: string }
  | undefined;

/**
 * Najpierw propozycje zadań, bo czekają na decyzję, od najnowszej; potem od ostatnio uruchomionej: sesja po starcie,
 * zadanie po starcie swojej ostatniej sesji, a bez sesji po utworzeniu. Propozycja w trakcie zatwierdzania zostaje
 * na liście daemona, a gdy jest już zadaniem (`openProposals`), jest tylko zadaniem.
 */
export function sessionEntries({ sessions, tasks, proposals }: SessionList): SessionEntry[] {
  const started: SessionEntry[] = [
    ...sessions.filter((s) => s.task === null).map((session) => ({ kind: "session" as const, session })),
    ...tasks.map((task) => ({ kind: "task" as const, task, session: latestSession(sessions, task.id) })),
  ];
  const waiting = openProposals({ tasks, proposals }).map((proposal) => ({ kind: "proposal" as const, proposal }));
  return [...waiting, ...started.sort((a, b) => entryTime(b).localeCompare(entryTime(a)))];
}

/** Propozycje, które czekają na decyzję: bez tych, z których w trakcie zatwierdzania powstało już zadanie. */
export function openProposals({ tasks, proposals }: Pick<SessionList, "tasks" | "proposals">): TaskProposal[] {
  return proposals.filter((p) => !tasks.some((t) => t.id === p.id));
}

/** `SessionList.sessions` idzie od najnowszej. */
function latestSession(sessions: readonly Session[], task: string): Session | undefined {
  return sessions.find((s) => s.task === task);
}

function entryTime(entry: SessionEntry): string {
  if (entry.kind === "proposal") return entry.proposal.createdAt;
  if (entry.kind === "session") return entry.session.startedAt;
  return entry.session?.startedAt ?? entry.task.createdAt;
}

/**
 * Pozycja dla wyboru, a bez wyboru albo dla nieznanego pierwsza; sesja zadania (np. z traya albo „Następna czekająca”)
 * wybiera jej zadanie, a zatwierdzona propozycja zadanie z tym samym identyfikatorem.
 */
export function findEntry(entries: readonly SessionEntry[], selection: SessionSelection): SessionEntry | undefined {
  if (selection?.kind === "new") return undefined;
  if (!selection) return entries[0];
  const found = entries.find((entry) =>
    selection.kind === "session" ? entrySession(entry)?.id === selection.id : entry.kind !== "session" && entryId(entry) === selection.id,
  );
  return found ?? entries[0];
}

/** Sesja pozycji: sesja w korzeniu repo albo ostatnia sesja zadania; propozycja jeszcze nie ma sesji, a brak pozycji też. */
export function entrySession(entry: SessionEntry | undefined): Session | undefined {
  return entry?.kind === "proposal" ? undefined : entry?.session;
}

/** Nazwa zadania na liście i w panelu: tytuł z propozycji, a zadanie z formularza nie ma tytułu, więc polecenie. */
export function taskName(task: Task): string {
  return task.title ?? task.prompt;
}

/** Wybór, który wskazuje tę pozycję. */
export function entrySelection(entry: SessionEntry): SessionSelection {
  return { kind: entry.kind, id: entryId(entry) };
}

/** Identyfikator pozycji (klucz Reacta i porównanie z wybraną); propozycja i zadanie z niej mają ten sam. */
export function entryId(entry: SessionEntry): string {
  if (entry.kind === "proposal") return entry.proposal.id;
  return entry.kind === "task" ? entry.task.id : entry.session.id;
}

/**
 * Kto zaproponował zadanie, po angielsku dla UI: sesja Trackwall po repo i tytule okna, póki jest na liście,
 * albo agent spoza Trackwall (agent nadrzędny z tokenem daemona).
 */
export function proposerLabel(proposedBy: ProposedBy, sessions: readonly Session[]): string {
  if (proposedBy.session === null) return "proposed by an agent outside Trackwall";
  const session = sessions.find((s) => s.id === proposedBy.session);
  if (!session) return "proposed by a session that is no longer listed";
  return `proposed by the session in ${session.repo}${session.windowTitle ? ` (${session.windowTitle})` : ""}`;
}
