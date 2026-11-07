import {
  type BoardItem,
  countLabel,
  isSupervisor,
  type Session,
  type SessionList,
  type Task,
  type TaskOutcome,
  type TaskProposal,
  type TrackwallLinkTarget,
} from "@trackwall/protocol";
import { projectOf } from "./board-tree.ts";
import { type Progress, progressBelow, progressLabel } from "./plan-progress.ts";
import { latestSession, proposerName, taskName } from "./session-entries.ts";
import { inTurn, PROPOSAL_STATUS, sessionPlace, sessionStateLabel, sessionTitle } from "./session-state.ts";
import { outcomeMarks } from "./task-outcomes.ts";

/**
 * Flow (ADR-224): every task, session and proposal on one wall, in a row per group of work and a column per state, for a
 * second monitor. A group is what the user already made: a project of Plan, a change across repos, the supervisor's
 * work, a session with the tasks it proposed, and the rest. Nothing here is stored or sent; it is computed from the session list, the board and the task
 * outcomes the UI already holds, like the progress of a project in Plan (ADR-215). No React here, so the rules are
 * tested on their own.
 */

/** The columns left to right: what moves, what waits for the user, what is handed over, what stands, what is at rest. */
export const FLOW_COLUMNS = ["working", "waiting", "review", "stuck", "idle"] as const;
export type FlowColumn = (typeof FLOW_COLUMNS)[number];

export const FLOW_COLUMN_LABELS: Record<FlowColumn, string> = {
  working: "Working",
  waiting: "Waits for you",
  review: "In review",
  stuck: "Stuck",
  idle: "Idle",
};

/** One task, session or proposal on the wall. */
export interface FlowCard {
  key: string;
  column: FlowColumn;
  name: string;
  /** The repo; `null` for the supervisor and a free session. */
  repo: string | null;
  /** What the column does not say: the state's words, a failed check, the merge request. */
  detail: string;
  /** ISO 8601: since when the card is in its column, as far as the UI knows; `null` when it does not. */
  since: string | null;
  /** What a click opens: the task (a proposal has the id of the task it becomes) or the session. */
  target: TrackwallLinkTarget;
}

type FlowGroupKind = "project" | "change" | "supervisor" | "proposer" | "none";

export interface FlowGroup {
  key: string;
  kind: FlowGroupKind;
  name: string;
  /** "Plan project · 4 of 9 done", "Change · 3 repos", "5 cards". */
  summary: string;
  /** How far a project of Plan is; `undefined` for any other group. */
  progress: Progress | undefined;
  cards: FlowCard[];
}

export interface FlowInput {
  list: SessionList;
  /** The board's items; empty until the board arrives, when no task is in a project yet. */
  items: readonly BoardItem[];
  outcomes: ReadonlyMap<string, TaskOutcome>;
}

/**
 * The groups that have a card, in a fixed order (projects, changes, the supervisor, sessions with the tasks they
 * proposed, the rest), so the wall does not jump.
 */
export function flowGroups({ list, items, outcomes }: FlowInput): FlowGroup[] {
  const groups = new Map<string, FlowGroup>();
  const add = (group: Omit<FlowGroup, "cards">, card: FlowCard) => {
    const known = groups.get(group.key) ?? { ...group, cards: [] };
    known.cards.push(card);
    groups.set(group.key, known);
  };
  const { tasks, sessions } = list;
  for (const task of tasks) add(taskGroup(task, list, items), taskCard(task, sessions, outcomes.get(task.id)));
  for (const proposal of list.proposals) add(workGroup(proposal, sessions, items), proposalCard(proposal));
  // A session that proposed work heads the row of that work; the work came first, so the row already has its name.
  for (const session of sessions) {
    if (session.task === null) add(groups.get(proposerKey(session.id)) ?? sessionGroup(session), sessionCard(session));
  }
  return [...groups.values()].map((group) => withSummary(group, items)).sort(byKindThenName);
}

/** How many cards are in each column, for the counts over the wall. */
export function columnCounts(groups: readonly FlowGroup[]): Record<FlowColumn, number> {
  const counts: Record<FlowColumn, number> = { working: 0, waiting: 0, review: 0, stuck: 0, idle: 0 };
  for (const card of groups.flatMap((g) => g.cards)) counts[card.column] += 1;
  return counts;
}

/** The cards of one column of a group, longest in the column first, so the oldest wait is on top. */
export function cardsIn(group: FlowGroup, column: FlowColumn): FlowCard[] {
  return group.cards.filter((c) => c.column === column).sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
}

const SUPERVISOR_GROUP = { key: "supervisor", kind: "supervisor", name: "Supervisor", summary: "", progress: undefined } as const;
const NO_GROUP = { key: "none", kind: "none", name: "No group", summary: "", progress: undefined } as const;

function projectGroup(project: BoardItem): Omit<FlowGroup, "cards"> {
  return { key: `project:${project.id}`, kind: "project", name: project.title, summary: "", progress: undefined };
}

function itemProject(items: readonly BoardItem[], id: string | null): BoardItem | undefined {
  const item = items.find((it) => it.id === id);
  return item && projectOf(items, item);
}

/** A task's group: its project of Plan first, since that is the work the user split, then its change, then its proposer. */
function taskGroup(task: Task, { tasks, sessions }: SessionList, items: readonly BoardItem[]): Omit<FlowGroup, "cards"> {
  if (task.change && !itemProject(items, task.item)) {
    const change = task.change.id;
    const first = tasks.find((t) => t.change?.id === change && t.change.position === 0) ?? task;
    return { key: `change:${change}`, kind: "change", name: taskName(first), summary: "", progress: undefined };
  }
  return workGroup(task, sessions, items);
}

/**
 * The group of a task or a proposal by where it came from: its project of Plan, the supervisor, or the Trackwall
 * session that proposed it (a task's session for all of the task's sessions, ADR-140), as the Sessions list puts it
 * under that session. Work from an agent outside Trackwall or from the user has no group.
 */
function workGroup(
  work: Pick<Task, "item" | "proposedBy">,
  sessions: readonly Session[],
  items: readonly BoardItem[],
): Omit<FlowGroup, "cards"> {
  const project = itemProject(items, work.item);
  if (project) return projectGroup(project);
  const by = work.proposedBy;
  if (by?.supervisor) return SUPERVISOR_GROUP;
  if (!by || by.session === null) return NO_GROUP;
  const proposer = sessions.find((s) => s.id === by.session) ?? (by.task === null ? undefined : latestSession(sessions, by.task));
  const name = proposer ? sessionTitle(proposer) : `Proposed by ${proposerName(by, sessions)}`;
  return { key: proposerKey(by.task ?? by.session), kind: "proposer", name, summary: "", progress: undefined };
}

function proposerKey(id: string): string {
  return `proposer:${id}`;
}

function sessionGroup(session: Session): Omit<FlowGroup, "cards"> {
  return isSupervisor(session) ? SUPERVISOR_GROUP : NO_GROUP;
}

const KIND_ORDER: readonly FlowGroupKind[] = ["project", "change", "supervisor", "proposer", "none"];

function byKindThenName(a: FlowGroup, b: FlowGroup): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name);
}

function withSummary(group: FlowGroup, items: readonly BoardItem[]): FlowGroup {
  if (group.kind === "project") {
    const progress = progressBelow(items, group.key.slice("project:".length));
    const done = progressLabel(progress);
    return { ...group, progress, summary: done ? `Plan project · ${done}` : "Plan project" };
  }
  if (group.kind === "change") {
    const repos = new Set(group.cards.map((c) => c.repo)).size;
    return { ...group, summary: `Change · ${countLabel(repos, { one: "repo", other: "repos" })}` };
  }
  return { ...group, summary: countLabel(group.cards.length, { one: "card", other: "cards" }) };
}

/** Where a session stands, before the task's own marks: `undefined` when the session alone does not place it. */
function sessionColumn(session: Session): { column: FlowColumn; since: string | null } | undefined {
  const at = session.state?.at ?? null;
  if (session.stuck) return { column: "stuck", since: session.stuck.lastStepAt };
  if (sessionStateLabel(session).tone === "error") return { column: "stuck", since: at };
  if (session.needsAttention && session.state?.state !== "Input") return { column: "waiting", since: at };
  if (inTurn(session)) return { column: "working", since: at };
  return undefined;
}

/**
 * A task's column: a stuck or failed session, a dialog or a turn first, since they say what happens now; then work handed
 * over for review (ADR-213); then a finished turn the user has not seen; then a failed check, which waits for someone to
 * act on it; otherwise it is at rest.
 */
function taskCard(task: Task, sessions: readonly Session[], outcome: TaskOutcome | undefined): FlowCard {
  const session = latestSession(sessions, task.id);
  const state = session ? sessionStateLabel(session).label : "no session";
  const failed = outcomeMarks(outcome, false).find((m) => m.tone === "error");
  const base = { key: `task:${task.id}`, name: taskName(task), repo: task.repo, target: { kind: "task", id: task.id } as const };
  const now = session && sessionColumn(session);
  if (now) return { ...base, ...now, detail: state };
  if (task.inReview) return { ...base, column: "review", since: task.summary?.reportedAt ?? null, detail: "handed over" };
  const at = session?.state?.at ?? task.createdAt;
  if (session?.needsAttention) return { ...base, column: "waiting", since: at, detail: state };
  if (failed) return { ...base, column: "stuck", since: at, detail: failed.title };
  return { ...base, column: "idle", since: at, detail: state };
}

function sessionCard(session: Session): FlowCard {
  const { label } = sessionStateLabel(session);
  const now = sessionColumn(session) ?? {
    column: session.needsAttention ? "waiting" : "idle",
    since: session.state?.at ?? session.startedAt,
  };
  return {
    key: `session:${session.id}`,
    // The repo is on the card's second line already.
    name: isSupervisor(session) ? "Supervisor" : (session.windowTitle ?? sessionPlace(session)),
    repo: session.repo,
    detail: label,
    target: { kind: "session", id: session.id },
    ...now,
  };
}

function proposalCard(proposal: TaskProposal): FlowCard {
  return {
    key: `proposal:${proposal.id}`,
    column: "waiting",
    name: proposal.title,
    repo: proposal.repo,
    detail: PROPOSAL_STATUS.label,
    since: proposal.createdAt,
    target: { kind: "task", id: proposal.id },
  };
}
