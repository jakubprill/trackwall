import type { Session, SessionId, SessionList, TaskProposal, TaskState } from "@trackwall/protocol";
import { STATE_LABELS, sessionPlace, waitingInTab } from "./session-state.ts";
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

/** "(3) Trackwall": the tab shows the count in front, where a narrow tab still shows it. */
export function tabTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting}) ${APP_TITLE}` : APP_TITLE;
}

/** What one browser notification says, what clicking it opens, and the tag under which a newer one replaces it. */
export interface BrowserNotice {
  title: string;
  body: string;
  /** The browser shows one notification per tag, so a second tab of Trackwall or a later wait of the same session replaces it. */
  tag: string;
  target: Extract<Jump, { kind: "session" | "task" | "proposal" }>;
}

const TAG_PREFIX = "trackwall:";

/** What a session waits for, in the words of the session states, as the shell's `session_notice` says it. */
const WAITS_FOR: Partial<Record<TaskState, string>> = { Approval: STATE_LABELS.Approval, Plan: STATE_LABELS.Plan };

/** "Session in orders-api: Copilot CLI is asking for approval", as the shell's notification says it. */
export function sessionNotice(session: Session): BrowserNotice {
  const state = session.state?.state;
  return {
    title: session.repo === null ? sessionPlace(session) : `Session in ${session.repo}`,
    body: `Copilot CLI is ${(state && WAITS_FOR[state]) ?? STATE_LABELS.Input}`,
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

interface Burst {
  tag: string;
  proposals: TaskProposal[];
  lastAt: number;
}

/** What the tab shows after a list: its title and the notifications to show now, none while the tab is in front. */
interface TabUpdate {
  title: string;
  notices: BrowserNotice[];
}

/**
 * The tab's side of the session list, one list after another, like the shell's `watch` loop. At the first list nothing
 * is new, like a session already waiting when the page opened: the title shows it, a notification would only repeat
 * what the page shows on load.
 */
export class TabAttention {
  #states: ReadonlyMap<SessionId, TaskState | null> | undefined;
  /** Proposal and task ids: a proposal being approved is a task, and after a failed start it comes back as a proposal with the same id, which is not new. */
  #known: ReadonlySet<string> = new Set();
  #burst: Burst | undefined;

  next(list: SessionList, now: number, inFront: boolean): TabUpdate {
    const sessions = this.#newlyWaiting(list);
    const proposals = this.#states ? list.proposals.filter((p) => !this.#known.has(p.id)) : [];
    this.#states = new Map(list.sessions.filter((s) => s.run.kind === "running").map((s) => [s.id, s.state?.state ?? null]));
    this.#known = new Set([...list.proposals.map((p) => p.id), ...list.tasks.map((t) => t.id)]);
    const title = tabTitle(waitingInTab(list));
    // The user looking at the tab sees the count and the session; a notification on top would only be noise, and a
    // later one of the same plan does not name the proposals seen here.
    if (inFront) {
      this.#burst = undefined;
      return { title, notices: [] };
    }
    const burst = this.#addToBurst(proposals, list.proposals, now);
    return { title, notices: [...sessions.map(sessionNotice), ...(burst ? [burst] : [])] };
  }

  /** Sessions that just finished working and wait: `Working` or `Stale` before. */
  #newlyWaiting(list: SessionList): Session[] {
    const before = this.#states;
    if (!before) return [];
    return list.sessions.filter((s) => s.needsAttention && (before.get(s.id) === "Working" || before.get(s.id) === "Stale"));
  }

  #addToBurst(fresh: readonly TaskProposal[], waiting: readonly TaskProposal[], now: number): BrowserNotice | undefined {
    const [first] = fresh;
    if (!first) return undefined;
    const last = this.#burst && now - this.#burst.lastAt <= BURST_MS ? this.#burst : undefined;
    // A proposal decided since it came does not wait any more, so the notice no longer names it; the plan keeps its tag.
    const kept = last ? last.proposals.filter((p) => waiting.some((w) => w.id === p.id)) : [];
    const burst = { tag: last?.tag ?? `${TAG_PREFIX}proposals:${first.id}`, proposals: [...kept, ...fresh], lastAt: now };
    this.#burst = burst;
    return proposalsNotice(burst);
  }
}

/** Clicking opens the first proposal, among the rest of its session's proposals in the Sessions view. */
function proposalsNotice({ tag, proposals }: Burst): BrowserNotice | undefined {
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
