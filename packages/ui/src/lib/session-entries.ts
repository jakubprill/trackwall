import type { ProposedBy, Session, SessionList, Task, TaskProposal } from "@trackwall/protocol";

/**
 * Pozycje listy w widoku „Sesje” (§4.4, ADR-31): sesja w korzeniu repo albo zadanie z ostatnią sesją, jeśli ma ją
 * w tym działaniu daemona. Zadanie nie zna swojej sesji, to sesja wskazuje zadanie (`Session.task`). Zadanie jest
 * jedną pozycją, choć po wznowieniu ma nową sesję, a bez sesji (po restarcie daemona albo zamknięciu sesji) zostaje
 * na liście do zakończenia. Propozycja zadania (ADR-39) czeka na decyzję użytkownika i nie ma jeszcze ani worktree,
 * ani sesji; zatwierdzona staje się zadaniem z tym samym identyfikatorem.
 *
 * Since ADR-55 the proposals of one main session are one entry: the session usually proposes a plan of several tasks,
 * and the user reviews them together. `proposer` is the session that proposed them, `null` for an agent outside Trackwall.
 */
export type SessionEntry =
  | { kind: "proposals"; proposer: string | null; proposals: readonly TaskProposal[] }
  | { kind: "session"; session: Session }
  | { kind: "task"; task: Task; session: Session | undefined };

/** A session or task: an entry that has started (or had a session), as opposed to proposals. */
export type StartedEntry = Exclude<SessionEntry, { kind: "proposals" }>;

/** Co pokazuje prawa część widoku: formularz nowej sesji, wybraną pozycję, a bez wyboru pierwszą pozycję. */
export type SessionSelection =
  | { kind: "new" }
  | { kind: "session"; id: string }
  | { kind: "task"; id: string }
  | { kind: "proposal"; id: string }
  | undefined;

/**
 * Order on one level of the tree (`sessionRows`).
 * Najpierw propozycje zadań, bo czekają na decyzję, grupami według sesji, która je zgłosiła, od najnowszej grupy;
 * potem od ostatnio uruchomionej: sesja po starcie, zadanie po starcie swojej ostatniej sesji, a bez sesji po
 * utworzeniu. Propozycji, z której jest już zadanie, daemon nie zwraca, więc ten sam identyfikator jest na liście raz.
 */
function sessionEntries({ sessions, tasks, proposals }: SessionList): SessionEntry[] {
  const started: StartedEntry[] = [
    ...sessions.filter((s) => s.task === null).map((session) => ({ kind: "session" as const, session })),
    ...tasks.map((task) => ({ kind: "task" as const, task, session: latestSession(sessions, task.id) })),
  ];
  return [...proposalGroups(proposals), ...started.sort((a, b) => entryTime(b).localeCompare(entryTime(a)))];
}

/**
 * Proposals grouped by the session that proposed them, in the daemon's order (newest first), so a group is where its
 * newest proposal is. Inside a group the oldest comes first: that is the order the main session wrote its plan in.
 */
function proposalGroups(proposals: readonly TaskProposal[]): SessionEntry[] {
  const groups = new Map<string | null, TaskProposal[]>();
  for (const proposal of proposals) groups.set(proposal.proposedBy.session, [proposal, ...(groups.get(proposal.proposedBy.session) ?? [])]);
  return [...groups].map(([proposer, list]) => ({ kind: "proposals" as const, proposer, proposals: list }));
}

/**
 * A row of the Sessions list: an entry, its depth in the tree and the number of entries directly under it. A task or
 * proposal sits under the entry with the session that proposed it (the main session, `proposedBy`), so the work one
 * session delegated stays with it. When that session is no longer listed (closed, or after a daemon restart), the
 * entry is at the top level.
 */
export interface SessionRow {
  entry: SessionEntry;
  depth: number;
  children: number;
}

/**
 * The tree of entries flattened into rows in display order: an entry, then its children right below it, on every level
 * in `sessionEntries` order. A cycle is impossible (a session exists only after its task, and a task only after a
 * proposal from another session), but the data comes from the daemon, so an entry in a cycle goes to the top level
 * instead of looping the list or vanishing from it.
 */
export function sessionRows(list: SessionList): SessionRow[] {
  const entries = sessionEntries(list);
  const ids = new Set(entries.map(entryId));
  // The entry that holds a session: the task for a task's session (also an older one), otherwise the session itself.
  const holder = new Map(list.sessions.map((s) => [s.id, s.task ?? s.id]));
  const children = new Map<string, SessionEntry[]>();
  const roots: SessionEntry[] = [];
  for (const entry of entries) {
    const proposer = entryProposer(entry);
    const parent = proposer === null ? undefined : holder.get(proposer);
    if (parent !== undefined && parent !== entryId(entry) && ids.has(parent))
      children.set(parent, [...(children.get(parent) ?? []), entry]);
    else roots.push(entry);
  }
  const rows: SessionRow[] = [];
  const placed = new Set<string>();
  const place = (entry: SessionEntry, depth: number) => {
    const id = entryId(entry);
    if (placed.has(id)) return;
    placed.add(id);
    const row = { entry, depth, children: 0 };
    rows.push(row);
    for (const child of children.get(id) ?? []) {
      if (placed.has(entryId(child))) continue;
      row.children++;
      place(child, depth + 1);
    }
  };
  // After the roots, all entries once more: entries in a cycle have no root, so they go to the top level.
  for (const entry of [...roots, ...entries]) place(entry, 0);
  return rows;
}

/** The session that proposed a task or proposals; `null` for a session, a task from the form and an agent outside Trackwall. */
function entryProposer(entry: SessionEntry): string | null {
  if (entry.kind === "session") return null;
  if (entry.kind === "proposals") return entry.proposer;
  return entry.task.proposedBy?.session ?? null;
}

/** `SessionList.sessions` idzie od najnowszej. */
function latestSession(sessions: readonly Session[], task: string): Session | undefined {
  return sessions.find((s) => s.task === task);
}

function entryTime(entry: StartedEntry): string {
  if (entry.kind === "session") return entry.session.startedAt;
  return entry.session?.startedAt ?? entry.task.createdAt;
}

/**
 * Pozycja dla wyboru, a bez wyboru albo dla nieznanego pierwsza; sesja zadania (np. z traya albo „Następna czekająca”)
 * wybiera jej zadanie, propozycja grupę, w której czeka, a zatwierdzona propozycja zadanie z tym samym identyfikatorem.
 */
export function findEntry(entries: readonly SessionEntry[], selection: SessionSelection): SessionEntry | undefined {
  if (selection?.kind === "new") return undefined;
  if (!selection) return entries[0];
  const found = entries.find((entry) => {
    if (selection.kind === "session") return entrySession(entry)?.id === selection.id;
    if (entry.kind === "task") return entry.task.id === selection.id;
    return selection.kind === "proposal" && entry.kind === "proposals" && entry.proposals.some((p) => p.id === selection.id);
  });
  return found ?? entries[0];
}

/** Sesja pozycji: sesja w korzeniu repo albo ostatnia sesja zadania; propozycje jeszcze nie mają sesji, a brak pozycji też. */
export function entrySession(entry: SessionEntry | undefined): Session | undefined {
  return entry?.kind === "proposals" ? undefined : entry?.session;
}

/** An entry that waits for you: proposals wait for a decision, a session or task when its session needs attention. */
function entryWaits(entry: SessionEntry): boolean {
  return entry.kind === "proposals" || entrySession(entry)?.needsAttention === true;
}

/**
 * Następna pozycja, która czeka na Ciebie (propozycje i sesje, ADR-55), po bieżącej, w kolejności listy i w kółko;
 * `undefined`, gdy żadna nie czeka. Bieżąca pozycja jest wybierana dopiero wtedy, gdy czeka tylko ona.
 */
export function nextWaiting(entries: readonly SessionEntry[], current: SessionEntry | undefined): SessionEntry | undefined {
  const at = current ? entries.findIndex((e) => entryId(e) === entryId(current)) : -1;
  const waiting = entries.filter(entryWaits);
  return waiting.find((e) => entries.indexOf(e) > at) ?? waiting[0];
}

/** Nazwa zadania na liście i w panelu: tytuł z propozycji, a zadanie z formularza nie ma tytułu, więc polecenie. */
export function taskName(task: Task): string {
  return task.title ?? task.prompt;
}

/** Wybór, który wskazuje tę pozycję; grupę propozycji wskazuje jej pierwsza propozycja. */
export function entrySelection(entry: SessionEntry): SessionSelection {
  if (entry.kind === "proposals") {
    const [first] = entry.proposals;
    if (!first) throw new Error("a group of task proposals is never empty");
    return { kind: "proposal", id: first.id };
  }
  return { kind: entry.kind, id: entryId(entry) };
}

/** Identyfikator pozycji (klucz Reacta i porównanie z wybraną); grupa propozycji ma go po sesji, która je zgłosiła. */
export function entryId(entry: SessionEntry): string {
  if (entry.kind === "proposals") return `proposals:${entry.proposer ?? "outside"}`;
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
