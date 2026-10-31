import {
  mcpTools,
  type ProposedBy,
  type SendMessageResult,
  type Session,
  SessionId,
  type Task,
  TaskId,
  type TaskMessage,
  type TaskUpdate,
  type Verification,
} from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../../infra/errors.ts";
import type { SessionEvent } from "./live-session.ts";
import { proposerExists, proposerKeyOf, proposerKind, proposerOf, taskProposerKey } from "./proposer.ts";
import { StoredMessages, TaskMessages } from "./task-messages.ts";
import { StoredUpdates, TaskUpdates } from "./task-updates.ts";

/**
 * Coordination between a task's proposer and the task's session (ADR-68): messages down (`send_message`, read with
 * `get_messages`), updates up (`get_updates`), and when to ask either session to read them. Only the proposer of a task
 * (`proposedBy`; for the supervisor's work, any supervisor) sends it messages, and at most `TASK_MESSAGES_WITHOUT_USER`
 * until the user takes part again, so two agents do not keep each other busy without them. Part of the `agents`
 * module; it holds no sessions itself, `agents.ts` hands them in. All of it outlives a daemon restart in
 * `agent-queues.json` (ADR-115, `stored`, `restore`).
 */

/** What `agent-queues.json` keeps of the coordination: the messages, the updates, and when the user last took part (milliseconds since the epoch). */
const EpochMs = z.number().int().nonnegative();
export const StoredCoordination = z.object({
  messages: StoredMessages,
  updates: StoredUpdates,
  userInTask: z.record(TaskId, EpochMs),
  userInSession: z.record(SessionId, EpochMs),
});
export type StoredCoordination = z.infer<typeof StoredCoordination>;

/** What of the previous daemon's coordination is still there after its restart. */
export interface Restored {
  hasTask(task: string): boolean;
  /** A session the next daemon resumes under the same id. */
  hasSession(session: string): boolean;
}

/** A running session as coordination needs it: who it is, and asking it to read what waits (`LiveSession.askToRead`). */
export interface CoordinatedSession {
  id: string;
  askToRead(): "typed" | "queued";
}

/** What coordination needs from the rest of `agents`. */
export interface CoordinationDeps {
  /** A task (`not_found` for an unknown or ended one). */
  task(id: string): Task;
  /** A task, or `undefined` for an unknown or ended one. */
  findTask(id: string): Task | undefined;
  /** A listed session as a proposer (`not_found` otherwise). */
  proposedBy(session: string): ProposedBy;
  /** The proposer key of a listed session's own work (`proposerKeyOf`; `not_found` otherwise). */
  proposerKey(session: string): string;
  /** The newest session of a task, while it runs. */
  runningOfTask(task: string): CoordinatedSession | undefined;
  /** The running session behind a proposer key: the session itself, for a task its running session, for `SUPERVISOR` the running supervisor. */
  runningProposer(proposer: string): CoordinatedSession | undefined;
  /** Whether anyone is behind a proposer key: always for `SUPERVISOR`, for a task until it ends, for a session while it is on the list. */
  hasProposer(proposer: string): boolean;
  /**
   * A message, an update or a review's time came, or a message or an update was read: what `stored` gives changed. Not
   * called for the user's typing, which is too frequent; its time reaches the file with the next change.
   */
  changed: () => void;
  log: (msg: string) => void;
}

export class TaskCoordination {
  readonly #deps: CoordinationDeps;
  readonly #messages: TaskMessages;
  readonly #updates: TaskUpdates;
  /** When the user last took part in a task: text in one of its sessions or a review (milliseconds since the epoch). */
  readonly #userInTask = new Map<string, number>();
  /** When the user last put text into a session (session id → milliseconds since the epoch). */
  readonly #userInSession = new Map<string, number>();

  constructor(deps: CoordinationDeps) {
    this.#deps = deps;
    this.#messages = new TaskMessages(deps.changed);
    this.#updates = new TaskUpdates(deps.changed);
  }

  stored(): StoredCoordination {
    return {
      messages: this.#messages.stored(),
      updates: this.#updates.stored(),
      userInTask: Object.fromEntries(this.#userInTask),
      userInSession: Object.fromEntries(this.#userInSession),
    };
  }

  /**
   * What the previous daemon kept, of the tasks still there, and of the supervisor, the tasks' sessions and the sessions
   * resumed under the same id.
   */
  restore(stored: StoredCoordination, { hasTask, hasSession }: Restored): void {
    this.#messages.restore(stored.messages, hasTask);
    this.#updates.restore(stored.updates, (proposer) => proposerExists(proposer, { hasTask, hasSession }));
    this.#userInTask.clear();
    for (const [task, at] of Object.entries(stored.userInTask)) if (hasTask(task)) this.#userInTask.set(task, at);
    this.#userInSession.clear();
    for (const [session, at] of Object.entries(stored.userInSession)) if (hasSession(session)) this.#userInSession.set(session, at);
  }

  /**
   * A message from session `caller` (`null`: an agent outside Trackwall) to the session of task `id`, which the caller
   * must have proposed; the task's running session is asked to read it, now or after its turn, and without one, the
   * session the user resumes is asked.
   */
  send(caller: string | null, id: string, text: string): SendMessageResult {
    const task = this.#deps.task(id);
    if (task.proposedBy === null)
      throw new DomainError(
        "bad_request",
        `the user started task ${id}, so no session sends it messages; tell the user instead, or ask them to hand it to the supervisor in its task panel`,
      );
    // An agent outside Trackwall is not told apart from another one, so it is never a task's proposer here.
    if (caller === null)
      throw new DomainError(
        "bad_request",
        `an agent outside Trackwall sends no messages; follow its tasks with ${mcpTools.waitForSession.name}`,
      );
    const from = this.#deps.proposedBy(caller);
    if (proposerOf(task.proposedBy) !== proposerOf(from))
      throw new DomainError("bad_request", `task ${id} was proposed by another session; only its proposer sends it messages`);
    const message = this.#messages.add(id, from, text, this.#userTookPartAt(caller, id));
    this.#deps.log(`message ${message.id} to task ${id} (${text.length} characters)`);
    const running = this.#deps.runningOfTask(id);
    return { message, delivery: running ? running.askToRead() : "on_resume" };
  }

  /** The unread messages of task `task`, which now count as read (`get_messages`). */
  takeMessages(task: string): TaskMessage[] {
    return this.#messages.take(task);
  }

  /** The unread updates of session `caller`'s delegated work, which now count as read (`get_updates`). */
  takeUpdates(caller: string | null): { updates: TaskUpdate[]; dropped: number } {
    if (caller === null)
      throw new DomainError(
        "bad_request",
        `an agent outside Trackwall gets no updates; follow its tasks with ${mcpTools.waitForSession.name}`,
      );
    return this.#updates.take(this.#deps.proposerKey(caller));
  }

  /** How many messages wait unread for a session's task, and updates for its own delegated work. */
  unread(session: Pick<Session, "id" | "supervisor" | "task">): { messages: number; updates: number } {
    const messages = session.task === null ? 0 : this.#messages.unread(session.task);
    return { messages, updates: this.#updates.unread(proposerKeyOf(session)) };
  }

  /** Every kept message of the tasks on the list, for the Sessions view. */
  messages(): TaskMessage[] {
    return this.#messages.list();
  }

  /** What a task session's agent did goes to the task's proposer. */
  sessionEvent(session: { id: string; task: string | null }, event: SessionEvent): void {
    const task = session.task === null ? undefined : this.#deps.findTask(session.task);
    if (task) this.#notify(task.proposedBy, { ...event, task: task.id, session: session.id, at: new Date().toISOString() });
  }

  /** Session `report_result`: the summary goes to the task's proposer. */
  resultReported(task: Task, session: string): void {
    const summary = task.summary;
    if (!summary) return;
    this.#notify(task.proposedBy, { kind: "result_reported", task: task.id, session, summary: summary.text, at: summary.reportedAt });
  }

  /** A verification with a verdict goes to the task's proposer; one still running or of an ended task does not. */
  verificationFinished(verification: Verification): void {
    const task = this.#deps.findTask(verification.task);
    if (!task || verification.state === "running") return;
    const { state, message } = verification;
    const session = this.#deps.runningOfTask(task.id)?.id ?? null;
    this.#notify(task.proposedBy, { kind: "verified", state, message, task: task.id, session, at: new Date().toISOString() });
  }

  /** The user rejected a proposal: the reason goes to its proposer. */
  proposalRejected(proposal: { id: string; proposedBy: ProposedBy }, reason: string | null): void {
    this.#notify(proposal.proposedBy, {
      kind: "proposal_rejected",
      task: proposal.id,
      session: null,
      reason,
      at: new Date().toISOString(),
    });
  }

  repoRemoved(proposal: { id: string; repo: string; proposedBy: ProposedBy }, movedTo: string): void {
    this.#notify(proposal.proposedBy, {
      kind: "repo_removed",
      task: proposal.id,
      session: null,
      repo: proposal.repo,
      movedTo,
      at: new Date().toISOString(),
    });
  }

  /** The user handed task `task` to the supervisor (ADR-155): the supervisor hears it at once, as its first update on it. */
  taskHanded(task: Task): void {
    const session = this.#deps.runningOfTask(task.id)?.id ?? null;
    this.#notify(task.proposedBy, { kind: "handed_over", task: task.id, session, at: new Date().toISOString() });
  }

  /** The user put text into a session: it counts as taking part in the session's exchanges and its task's. */
  userTyped(session: { id: string; task: string | null }): void {
    const now = Date.now();
    this.#userInSession.set(session.id, now);
    if (session.task !== null) this.#userInTask.set(session.task, now);
  }

  /** The user sent task `task` a review: it counts as taking part. */
  reviewed(task: string): void {
    this.#userInTask.set(task, Date.now());
    this.#deps.changed();
  }

  /**
   * A closed session: its typing and the updates for it go, except the supervisor's, which wait for the next supervisor,
   * and a task session's, which wait for the task's next session until the task ends (ADR-140).
   */
  sessionClosed(session: Pick<Session, "id" | "supervisor" | "task">): void {
    this.#userInSession.delete(session.id);
    if (proposerKind(proposerKeyOf(session)).kind === "session") this.#updates.forget(session.id);
  }

  /** An ended task: its messages and the updates on the work its sessions proposed go. */
  taskEnded(id: string): void {
    this.#messages.drop(id);
    this.#updates.forget(taskProposerKey(id));
    this.#userInTask.delete(id);
  }

  /** When the user last took part in task `task`'s exchange with session `caller`: in either, or 0 when never. */
  #userTookPartAt(caller: string, task: string): number {
    return Math.max(this.#userInSession.get(caller) ?? 0, this.#userInTask.get(task) ?? 0);
  }

  /** Queues an update for a proposer still on the list, and asks its running session to read it. */
  #notify(proposedBy: ProposedBy | null, update: TaskUpdate): void {
    const proposer = proposerOf(proposedBy);
    if (proposer === null || !this.#deps.hasProposer(proposer)) return;
    this.#updates.add(proposer, update);
    this.#deps.runningProposer(proposer)?.askToRead();
  }
}
