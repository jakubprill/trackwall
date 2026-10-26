import {
  countLabel,
  isSupervisor,
  type ProposedBy,
  type Session,
  type SessionList,
  type Task,
  type TaskProposal,
} from "@trackwall/protocol";

/**
 * Entries of the list in the "Sessions" view (§4.4, ADR-31): a session in a repo root, or a task with its last session if
 * it has one in this daemon run. A task does not know its session; the session points to the task (`Session.task`). A task
 * is one entry, although after resuming it has a new session, and without a session (after a daemon restart or after the
 * session was closed) it stays on the list until it is ended. A task proposal (ADR-39) waits for the user's decision and
 * has neither a worktree nor a session yet; once approved it becomes a task with the same id.
 *
 * Since ADR-55 the proposals of one main session are one entry: the session usually proposes a plan of several tasks,
 * and the user reviews them together. `proposer` is the session that proposed them, `null` for an agent outside Trackwall.
 */
export type SessionEntry =
  | ProposalsEntry
  | { kind: "session"; session: Session }
  | { kind: "task"; task: Task; session: Session | undefined };

/** The waiting task proposals of one proposer; never empty, since a group exists only for a proposal. */
export interface ProposalsEntry {
  kind: "proposals";
  proposer: string | null;
  proposals: readonly [TaskProposal, ...TaskProposal[]];
}

/** A session or task: an entry that has started (or had a session), as opposed to proposals. */
export type StartedEntry = Exclude<SessionEntry, ProposalsEntry>;

/**
 * What the right side of the view shows: the new session form, the selected entry, and without a selection the first
 * entry. A single proposal (from the tray, a notification or a link) selects its group and opens there; `proposals`
 * selects a group by its proposer, which stays selected while its proposals turn into tasks one by one.
 */
export type SessionSelection =
  | { kind: "new" }
  | { kind: "session"; id: string }
  | { kind: "task"; id: string }
  | { kind: "proposal"; id: string }
  | { kind: "proposals"; proposer: string | null }
  | undefined;

/**
 * Order on one level of the tree (`sessionRows`).
 * Task proposals first, since they wait for a decision, grouped by the session that proposed them, newest group
 * first; then most recently started: a session by its start, a task by the start of its latest session, and without
 * one by its creation. The daemon does not return a proposal that is already a task, so an id is on the list once.
 */
function sessionEntries({ sessions, tasks, proposals }: SessionList): SessionEntry[] {
  const started: StartedEntry[] = [
    // The supervisor is not an entry: it has its own panel, and its work sits under its heading (ADR-58).
    ...sessions.filter((s) => s.task === null && !isSupervisor(s)).map((session) => ({ kind: "session" as const, session })),
    ...tasks.map((task) => ({ kind: "task" as const, task, session: latestSession(sessions, task.id) })),
  ];
  return [...proposalGroups(proposals), ...started.sort((a, b) => entryTime(b).localeCompare(entryTime(a)))];
}

/**
 * Proposals grouped by the session that proposed them, in the daemon's order (newest first), so a group is where its
 * newest proposal is. Inside a group the oldest comes first: that is the order the main session wrote its plan in.
 */
function proposalGroups(proposals: readonly TaskProposal[]): ProposalsEntry[] {
  const groups = new Map<string | null, ProposalsEntry>();
  for (const proposal of proposals) {
    const proposer = proposal.proposedBy.session;
    const group = groups.get(proposer);
    groups.set(proposer, { kind: "proposals", proposer, proposals: group ? [proposal, ...group.proposals] : [proposal] });
  }
  return [...groups.values()];
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
  /** The row is the supervisor's work (ADR-58), directly or under work it delegated: it sits under the supervisor heading. */
  supervised: boolean;
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
  const place = (entry: SessionEntry, depth: number, supervised: boolean) => {
    const id = entryId(entry);
    if (placed.has(id)) return;
    placed.add(id);
    const row = { entry, depth, children: 0, supervised };
    rows.push(row);
    for (const child of children.get(id) ?? []) {
      if (placed.has(entryId(child))) continue;
      // The "main" badge counts work, so a group counts each of its proposals.
      row.children += workCount(child);
      place(child, depth + 1, supervised);
    }
  };
  // The supervisor's work first, one level under its heading, also when the supervisor session that delegated it is
  // gone (ADR-58); then the other roots. After them all entries once more: entries in a cycle have no root, so they go
  // to the top level.
  for (const entry of roots.filter(fromSupervisor)) place(entry, 1, true);
  for (const entry of [...roots, ...entries]) place(entry, 0, false);
  return rows;
}

/** How much work an entry is for a count: a group counts each of its proposals. */
export function workCount(entry: SessionEntry): number {
  return entry.kind === "proposals" ? entry.proposals.length : 1;
}

/** The supervisor delegated this task or these proposals (ADR-58). */
function fromSupervisor(entry: SessionEntry): boolean {
  if (entry.kind === "session") return false;
  if (entry.kind === "proposals") return entry.proposals[0].proposedBy.supervisor;
  return entry.task.proposedBy?.supervisor === true;
}

/** The session that proposed a task or proposals; `null` for a session, a task from the form and an agent outside Trackwall. */
function entryProposer(entry: SessionEntry): string | null {
  if (entry.kind === "session") return null;
  if (entry.kind === "proposals") return entry.proposer;
  return entry.task.proposedBy?.session ?? null;
}

/** `SessionList.sessions` goes from the newest. */
function latestSession(sessions: readonly Session[], task: string): Session | undefined {
  return sessions.find((s) => s.task === task);
}

function entryTime(entry: StartedEntry): string {
  if (entry.kind === "session") return entry.session.startedAt;
  return entry.session?.startedAt ?? entry.task.createdAt;
}

/**
 * The entry for a selection, and the first entry without one or for an unknown one (a group that is gone first falls
 * back to its newest task, `startedFrom`). A task session (from the tray or
 * "Next waiting") selects its task; a proposal selects the group it waits in, and once approved the task with its id,
 * and a task id finds a proposal too, since a `trackwall://task/` link may point at one.
 */
export function findEntry(entries: readonly SessionEntry[], selection: SessionSelection): SessionEntry | undefined {
  if (selection?.kind === "new") return undefined;
  if (!selection) return entries[0];
  const found = entries.find((entry) => selects(selection, entry));
  if (found) return found;
  return (selection.kind === "proposals" ? startedFrom(entries, selection.proposer) : undefined) ?? entries[0];
}

/**
 * What to select after the session of `closed` was closed: a session in a repo root leaves the list with it
 * (`selectionAfterRemoval`), while a task stays listed, so its selection is kept.
 */
export function selectionAfterClose(
  entries: readonly SessionEntry[],
  selected: SessionSelection,
  closed: SessionEntry,
): SessionSelection | "keep" {
  return closed.kind === "session" ? selectionAfterRemoval(entries, selected, closed) : "keep";
}

/**
 * What to select after `removed` left the list (a closed session in a repo root, an ended task): `"keep"` unless it is
 * the selected entry. Then its neighbour in `entries`, the list that still holds `removed`: the next entry or the
 * previous one after the last, so the selection stays where the user was (also on the same grid page); `undefined`
 * (the first entry) when nothing else is left. `selected` is the raw selection, not the entry `findEntry` falls back
 * to once a refreshed list no longer has `removed`.
 */
export function selectionAfterRemoval(
  entries: readonly SessionEntry[],
  selected: SessionSelection,
  removed: SessionEntry,
): SessionSelection | "keep" {
  if (selected === undefined || selected.kind === "new" || !selects(selected, removed)) return "keep";
  const at = entries.findIndex((entry) => entryId(entry) === entryId(removed));
  const neighbour = at === -1 ? undefined : (entries[at + 1] ?? entries[at - 1]);
  return neighbour ? entrySelection(neighbour) : undefined;
}

/**
 * A group whose last proposal has just become a task is gone from the list before the start ends; its newest task from
 * the same proposer stands in for it, instead of an unrelated entry, until the decision selects where to go next (in a
 * batch that may be an earlier task). `undefined` when there is none.
 */
function startedFrom(entries: readonly SessionEntry[], proposer: string | null): SessionEntry | undefined {
  return entries.find((e) => e.kind === "task" && e.task.proposedBy !== null && e.task.proposedBy.session === proposer);
}

function selects(selection: Exclude<SessionSelection, undefined | { kind: "new" }>, entry: SessionEntry): boolean {
  if (selection.kind === "session") return entrySession(entry)?.id === selection.id;
  if (selection.kind === "proposals") return entry.kind === "proposals" && entry.proposer === selection.proposer;
  if (entry.kind === "task") return entry.task.id === selection.id;
  return entry.kind === "proposals" && entry.proposals.some((p) => p.id === selection.id);
}

/** The proposal a selection points at, to open first in its group; `undefined` for any other selection. */
export function selectedProposal(selection: SessionSelection): string | undefined {
  return selection?.kind === "proposal" || selection?.kind === "task" ? selection.id : undefined;
}

/** The session of an entry: a session in a repo root or a task's latest session; proposals have none yet. */
export function entrySession(entry: SessionEntry | undefined): Session | undefined {
  return entry?.kind === "proposals" ? undefined : entry?.session;
}

/** An entry that waits for you: proposals wait for a decision, a session or task when its session needs attention. */
function entryWaits(entry: SessionEntry): boolean {
  return entry.kind === "proposals" || entrySession(entry)?.needsAttention === true;
}

/**
 * The next entry that waits for you (proposals and sessions, ADR-55) after the current one, in list order and round;
 * `undefined` when none waits. The current entry is chosen only when it is the only one waiting.
 */
export function nextWaiting(entries: readonly SessionEntry[], current: SessionEntry | undefined): SessionEntry | undefined {
  const at = current ? entries.findIndex((e) => entryId(e) === entryId(current)) : -1;
  const waiting = entries.filter(entryWaits);
  return waiting.find((e) => entries.indexOf(e) > at) ?? waiting[0];
}

/** What "Next waiting" and Alt+J open: an entry of the list, or the supervisor, which has its panel instead (ADR-58). */
export type WaitingTarget = SessionEntry | typeof SUPERVISOR_TARGET;
export const SUPERVISOR_TARGET = { kind: "supervisor" } as const;

/**
 * The next thing waiting for you: the entry after the current one (`nextWaiting`, which goes round the list), and the
 * supervisor only when nothing on the list waits but the supervisor session itself does. Its panel is in view and has
 * its own bell, so the shortcut does not stop there while the list still holds work.
 */
export function nextWaitingTarget(
  entries: readonly SessionEntry[],
  current: SessionEntry | undefined,
  supervisorWaits: boolean,
): WaitingTarget | undefined {
  return nextWaiting(entries, current) ?? (supervisorWaits ? SUPERVISOR_TARGET : undefined);
}

/**
 * Alt+J (ADR-48): what to open, after the selected entry, and whether the shortcut takes the key. In Sessions it
 * always does, so that the key never reaches a terminal; elsewhere only when something is waiting, so that ⌥J still
 * types in a text field.
 */
export function nextWaitingShortcut(
  entries: readonly SessionEntry[],
  selected: SessionEntry | undefined,
  inSessionsView: boolean,
  supervisorWaits: boolean,
): { open: WaitingTarget | undefined; taken: boolean } {
  const open = nextWaitingTarget(entries, selected, supervisorWaits);
  return { open, taken: open !== undefined || inSessionsView };
}

/** A task's name in the list and in the panel: the title from the proposal; a task from the form has no title, so its prompt. */
export function taskName(task: Task): string {
  return task.title ?? task.prompt;
}

/** The selection that points at this entry; a group of proposals by its proposer. */
export function entrySelection(entry: SessionEntry): SessionSelection {
  if (entry.kind === "proposals") return { kind: "proposals", proposer: entry.proposer };
  return { kind: entry.kind, id: entryId(entry) };
}

/** The id of an entry (React key and comparison with the selected one); a group of proposals has it by its proposer. */
export function entryId(entry: SessionEntry): string {
  // `null`, an agent outside Trackwall, gets a word no session id is.
  if (entry.kind === "proposals") return `proposals:${entry.proposer ?? "outside"}`;
  return entry.kind === "task" ? entry.task.id : entry.session.id;
}

/** A proposal's name wherever it is listed: its repo and title. */
export function proposalName(proposal: TaskProposal): string {
  return `${proposal.repo} · ${proposal.title}`;
}

/** What a single proposal asks for, as its heading: a task, or removing a repo from the projects folder (ADR-83). */
export function proposalKindLabel(proposal: TaskProposal): string {
  return proposal.kind === "remove_repo" ? "Repo removal" : "Task proposal";
}

/** The name of a group of proposals (ADR-55): the proposal's name for one, a count for more. */
export function proposalsName(proposals: ProposalsEntry["proposals"]): string {
  return proposals.length === 1
    ? proposalName(proposals[0])
    : countLabel(proposals.length, { one: "task proposal", other: "task proposals" });
}

/**
 * Who proposed the task, in English for the UI: a Trackwall session by its repo and window title while it is on the
 * list, or an agent outside Trackwall (a supervising agent with the daemon token).
 */
export function proposerLabel(proposedBy: ProposedBy, sessions: readonly Session[]): string {
  return `proposed by ${proposerName(proposedBy, sessions)}`;
}

/** Who a proposal or a task message (ADR-68) came from, as the end of "proposed by …" or "from …". */
export function proposerName(proposedBy: ProposedBy, sessions: readonly Session[]): string {
  if (proposedBy.supervisor) return "the supervisor";
  if (proposedBy.session === null) return "an agent outside Trackwall";
  const session = sessions.find((s) => s.id === proposedBy.session);
  if (!session) return "a session that is no longer listed";
  return `the session in ${session.repo}${session.windowTitle ? ` (${session.windowTitle})` : ""}`;
}
