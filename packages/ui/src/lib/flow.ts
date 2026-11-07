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
  /** ISO 8601: since when the card is in its column, as far as the UI knows (at least since the work is there). */
  since: string;
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

/** A group as the cards find it: what it is, before its cards are counted. */
interface GroupHead {
  key: string;
  kind: FlowGroupKind;
  name: string;
  /** The project of Plan the row is; only for a project's row. */
  project?: string;
  /** A change's row takes the name of its part earliest in the merge order: that part's position. */
  position?: number;
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
  const groups = new Map<string, { head: GroupHead; cards: FlowCard[] }>();
  const add = (head: GroupHead, card: FlowCard) => {
    const known = groups.get(head.key) ?? { head, cards: [] };
    if ((head.position ?? 0) < (known.head.position ?? 0)) known.head = head;
    known.cards.push(card);
    groups.set(head.key, known);
  };
  const { tasks, sessions } = list;
  for (const task of tasks) add(taskGroup(task, sessions, items), taskCard(task, sessions, outcomes.get(task.id)));
  for (const proposal of list.proposals) add(workGroup(proposal, sessions, items), proposalCard(proposal));
  // A session that proposed work heads the row of that work; the work came first, so the row already has its name.
  for (const session of sessions) {
    if (session.task === null) add(groups.get(proposerKey(session.id))?.head ?? sessionGroup(session), sessionCard(session));
  }
  return [...groups.values()].map(({ head, cards }) => finished(head, cards, items)).sort(byKindThenName);
}

/** How many cards are in each column, for the counts over the wall. */
export function columnCounts(groups: readonly FlowGroup[]): Record<FlowColumn, number> {
  const counts: Record<FlowColumn, number> = { working: 0, waiting: 0, review: 0, stuck: 0, idle: 0 };
  for (const card of groups.flatMap((g) => g.cards)) counts[card.column] += 1;
  return counts;
}

/** The cards of one column of a group, longest in the column first, so the oldest wait is on top. */
export function cardsIn(group: FlowGroup, column: FlowColumn): FlowCard[] {
  return group.cards.filter((c) => c.column === column).sort((a, b) => a.since.localeCompare(b.since));
}

const SUPERVISOR_GROUP: GroupHead = { key: "supervisor", kind: "supervisor", name: "Supervisor" };
const NO_GROUP: GroupHead = { key: "none", kind: "none", name: "No group" };

function projectGroup(project: BoardItem): GroupHead {
  return { key: `project:${project.id}`, kind: "project", name: project.title, project: project.id };
}

function itemProject(items: readonly BoardItem[], id: string | null): BoardItem | undefined {
  const item = items.find((it) => it.id === id);
  return item && projectOf(items, item);
}

/** A task's group: its project of Plan first, since that is the work the user split, then its change, then its proposer. */
function taskGroup(task: Task, sessions: readonly Session[], items: readonly BoardItem[]): GroupHead {
  if (task.change && !itemProject(items, task.item)) {
    return { key: `change:${task.change.id}`, kind: "change", name: taskName(task), position: task.change.position };
  }
  return workGroup(task, sessions, items);
}

/**
 * The group of a task or a proposal by where it came from: its project of Plan, the supervisor, or the Trackwall
 * session that proposed it (a task's session for all of the task's sessions, ADR-140), as the Sessions list puts it
 * under that session. Work from an agent outside Trackwall or from the user has no group.
 */
function workGroup(work: Pick<Task, "item" | "proposedBy">, sessions: readonly Session[], items: readonly BoardItem[]): GroupHead {
  const project = itemProject(items, work.item);
  if (project) return projectGroup(project);
  const by = work.proposedBy;
  if (by?.supervisor) return SUPERVISOR_GROUP;
  if (!by || by.session === null) return NO_GROUP;
  const proposer = sessions.find((s) => s.id === by.session) ?? (by.task === null ? undefined : latestSession(sessions, by.task));
  const name = proposer ? sessionTitle(proposer) : `Proposed by ${proposerName(by, sessions)}`;
  return { key: proposerKey(by.task ?? by.session), kind: "proposer", name };
}

function proposerKey(id: string): string {
  return `proposer:${id}`;
}

function sessionGroup(session: Session): GroupHead {
  return isSupervisor(session) ? SUPERVISOR_GROUP : NO_GROUP;
}

const KIND_ORDER: readonly FlowGroupKind[] = ["project", "change", "supervisor", "proposer", "none"];

function byKindThenName(a: FlowGroup, b: FlowGroup): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name);
}

function finished({ key, kind, name, project }: GroupHead, cards: FlowCard[], items: readonly BoardItem[]): FlowGroup {
  const group = { key, kind, name, cards, progress: undefined };
  if (project !== undefined) {
    const progress = progressBelow(items, project);
    const done = progressLabel(progress);
    return { ...group, progress, summary: done ? `Plan project · ${done}` : "Plan project" };
  }
  if (kind === "change") {
    const repos = new Set(cards.map((c) => c.repo)).size;
    return { ...group, summary: `Change · ${countLabel(repos, { one: "repo", other: "repos" })}` };
  }
  return { ...group, summary: countLabel(cards.length, { one: "card", other: "cards" }) };
}

/** What the column of a task or a session depends on besides its session. */
interface WorkFacts {
  /** The agent handed the work over (ADR-213), and when, as far as the UI knows. */
  review: { reportedAt: string | undefined } | undefined;
  /** A failed verification or pipeline, in words. */
  failed: string | undefined;
  /** Since when the work is there at all: a task's creation, a session's start. */
  since: string;
}

/**
 * The one order of the columns (ADR-224): a stuck or failed session, a dialog or a turn first, since they say what happens
 * now; then work handed over for review (ADR-213); then a finished turn the user has not seen; then a failed check,
 * which waits for someone to act on it; otherwise it is at rest.
 */
function columnOf(session: Session | undefined, work: WorkFacts): Pick<FlowCard, "column" | "since" | "detail"> {
  const detail = session ? sessionStateLabel(session).label : "no session";
  const at = session?.state?.at ?? work.since;
  if (session?.stuck) return { column: "stuck", since: session.stuck.lastStepAt, detail };
  if (session && sessionStateLabel(session).tone === "error") return { column: "stuck", since: at, detail };
  if (session?.needsAttention && session.state?.state !== "Input") return { column: "waiting", since: at, detail };
  if (session && inTurn(session)) return { column: "working", since: at, detail };
  if (work.review) return { column: "review", since: work.review.reportedAt ?? at, detail: "handed over" };
  if (session?.needsAttention) return { column: "waiting", since: at, detail };
  if (work.failed) return { column: "stuck", since: at, detail: work.failed };
  return { column: "idle", since: at, detail };
}

function taskCard(task: Task, sessions: readonly Session[], outcome: TaskOutcome | undefined): FlowCard {
  const facts: WorkFacts = {
    review: task.inReview ? { reportedAt: task.summary?.reportedAt } : undefined,
    failed: outcomeMarks(outcome, false).find((m) => m.tone === "error")?.title,
    since: task.createdAt,
  };
  return {
    key: `task:${task.id}`,
    name: taskName(task),
    repo: task.repo,
    target: { kind: "task", id: task.id },
    ...columnOf(latestSession(sessions, task.id), facts),
  };
}

function sessionCard(session: Session): FlowCard {
  return {
    key: `session:${session.id}`,
    // The repo is on the card's second line already.
    name: isSupervisor(session) ? "Supervisor" : (session.windowTitle ?? sessionPlace(session)),
    repo: session.repo,
    target: { kind: "session", id: session.id },
    ...columnOf(session, { review: undefined, failed: undefined, since: session.startedAt }),
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
