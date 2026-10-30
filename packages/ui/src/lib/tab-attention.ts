import type { Session, SessionId, SessionList, TaskProposal, TaskState } from "@trackwall/protocol";
import { STATE_LABELS, sessionPlace } from "./session-state.ts";
import type { Jump } from "./use-jump-request.ts";

/**
 * What a Trackwall page in a browser tab does in place of the desktop shell's tray (ADR-146): the number of sessions
 * and task proposals waiting for you in the tab's title, and a browser notification when a session starts waiting or
 * new proposals arrive while the tab is not in front. The rules are the shell's (`attention.rs`, `notification.rs`):
 * the same moments, the same count and the same words, so the browser and the desktop app tell the same story.
 * Described in §2 of docs/architecture.md.
 */

/** The page's title without anything waiting (`<title>` in `index.html`). */
const APP_TITLE = "Trackwall";

/** Running sessions waiting for you, the supervisor among them, and proposals: the count on the shell's app icon (`badge.rs`). */
export function waitingInTab(list: SessionList | undefined): number {
  if (!list) return 0;
  return list.sessions.filter((s) => s.run.kind === "running" && s.needsAttention).length + list.proposals.length;
}

/** "(3) Trackwall": the tab shows the count in front, where a narrow tab still shows it. */
export function tabTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting}) ${APP_TITLE}` : APP_TITLE;
}

/** The states of the running sessions and the ids of proposals and tasks at one list, to compare the next list with. */
export interface AttentionSnapshot {
  states: ReadonlyMap<SessionId, TaskState | null>;
  /** A proposal being approved is already a task, and after a failed start it comes back as a proposal with the same id, which is not new. */
  known: ReadonlySet<string>;
}

export function attentionSnapshot(list: SessionList): AttentionSnapshot {
  const running = list.sessions.filter((s) => s.run.kind === "running");
  return {
    states: new Map(running.map((s) => [s.id, s.state?.state ?? null])),
    known: new Set([...list.proposals.map((p) => p.id), ...list.tasks.map((t) => t.id)]),
  };
}

/** What deserves a notification since the previous list. */
export interface AttentionNews {
  sessions: Session[];
  proposals: TaskProposal[];
}

/**
 * Sessions that just finished working and wait (`Working` or `Stale` before), and proposals that were neither a
 * proposal nor a task before. At the first list (`undefined`) nothing is new, like a session already waiting when the
 * page opened: the title shows it, a notification would only repeat what the page shows on load.
 */
export function attentionNews(previous: AttentionSnapshot | undefined, list: SessionList): AttentionNews {
  if (!previous) return { sessions: [], proposals: [] };
  const wasWorking = (s: Session) => {
    const before = previous.states.get(s.id);
    return before === "Working" || before === "Stale";
  };
  return {
    sessions: list.sessions.filter((s) => s.run.kind === "running" && s.needsAttention && wasWorking(s)),
    proposals: list.proposals.filter((p) => !previous.known.has(p.id)),
  };
}

/** What one browser notification says, what clicking it opens, and the tag under which a newer one replaces it. */
export interface TabNotice {
  title: string;
  body: string;
  /** The browser shows one notification per tag, so a second tab of Trackwall or a later wait of the same session replaces it. */
  tag: string;
  target: Extract<Jump, { kind: "session" | "proposal" }>;
}

const TAG_PREFIX = "trackwall:";

function sessionBody(state: TaskState | undefined): string {
  if (state === "Approval" || state === "Plan") return `Copilot CLI is ${STATE_LABELS[state]}`;
  return `Copilot CLI is ${STATE_LABELS.Input}`;
}

/** "Session in orders-api: Copilot CLI is asking for approval", as the shell's notification says it. */
export function sessionNotice(session: Session): TabNotice {
  return {
    title: session.repo === null ? sessionPlace(session) : `Session in ${session.repo}`,
    body: sessionBody(session.state?.state),
    tag: `${TAG_PREFIX}session:${session.id}`,
    target: { kind: "session", id: session.id },
  };
}

/**
 * A main session proposes a plan of several tasks with a few seconds between proposals, and one notification for the
 * plan says more than one per task (ADR-55), so the proposals of one plan are a burst: those that come within
 * `BURST_MS` of the previous one join it, and its notification is shown again under the same tag with all of them,
 * replacing the last one quietly. The shell waits for the plan to end instead, but a page in a background tab gets its
 * timers late (a browser runs them once a minute in a tab hidden for long), so the page does not wait.
 */
export const BURST_MS = 30_000;

export class ProposalBurst {
  #burst: TaskProposal[] = [];
  #lastAt = Number.NEGATIVE_INFINITY;
  /** The tag of the burst's notification, from its first proposal, kept when that one is decided. */
  #tag = "";

  /** Takes the new proposals of a list and returns the notice of their burst, or `undefined` when none is new. */
  add(proposals: readonly TaskProposal[], waiting: readonly TaskProposal[], now: number): TabNotice | undefined {
    if (proposals.length === 0) return undefined;
    const continues = now - this.#lastAt <= BURST_MS;
    // A proposal decided since it came does not wait any more, so the notice no longer names it.
    const kept = continues ? this.#burst.filter((p) => waiting.some((w) => w.id === p.id)) : [];
    if (!continues) this.#tag = `${TAG_PREFIX}proposals:${proposals[0]?.id}`;
    this.#burst = [...kept, ...proposals];
    this.#lastAt = now;
    return proposalsNotice(this.#burst, this.#tag);
  }
}

/** Clicking opens the first proposal, among the rest of its session's proposals in the Sessions view. */
function proposalsNotice(proposals: readonly TaskProposal[], tag: string): TabNotice | undefined {
  const [first] = proposals;
  if (!first) return undefined;
  const one = proposals.length === 1;
  return {
    title: one ? `Task proposal for ${first.repo}` : `${proposals.length} task proposals`,
    body: one ? first.title : proposals.map((p) => `${p.repo}: ${p.title}`).join("\n"),
    tag,
    target: { kind: "proposal", id: first.id },
  };
}
