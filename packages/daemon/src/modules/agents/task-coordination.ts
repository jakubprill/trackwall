import {
  isSupervisor,
  mcpTools,
  type ProposedBy,
  type SendMessageResult,
  type Session,
  type Task,
  type TaskMessage,
  type TaskUpdate,
  type Verification,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { TaskMessages } from "./task-messages.ts";
import { proposerOf, SUPERVISOR, TaskUpdates, TurnWatch } from "./task-updates.ts";

/**
 * Coordination between a task's proposer and the task's session (ADR-68): messages down (`send_message`, read with
 * `get_messages`), updates up (`get_updates`), and when to ask either session to read them. Only the proposer of a task
 * (`proposedBy`; for the supervisor's work, any supervisor) sends it messages, and at most `TASK_MESSAGES_WITHOUT_USER`
 * until the user takes part again, so two agents do not keep each other busy without them. Part of the `agents`
 * module; it holds no sessions itself, `agents.ts` hands them in.
 */

/** A running session as coordination needs it: who it is, and asking it to read what waits (`LiveSession.askToRead`). */
export interface CoordinatedSession {
  id: string;
  task: string | null;
  askToRead(): "typed" | "queued";
}

/** What coordination needs from the rest of `agents`. */
export interface CoordinationDeps {
  task(id: string): Task;
  findTask(id: string): Task | undefined;
  /** A listed session (`not_found` otherwise). */
  session(id: string): Session;
  /** The newest session of a task, while it runs. */
  runningOfTask(task: string): CoordinatedSession | undefined;
  /** The running supervisor (ADR-58). */
  runningSupervisor(): CoordinatedSession | undefined;
  /** A running session by its id. */
  running(id: string): CoordinatedSession | undefined;
  log: (msg: string) => void;
}

export class TaskCoordination {
  readonly #deps: CoordinationDeps;
  readonly #messages = new TaskMessages();
  readonly #updates = new TaskUpdates();
  /** The state of every task session whose proposer hears about it, by session id. */
  readonly #turns = new Map<string, TurnWatch>();
  /** When the user last put text into a session (by session id: milliseconds since the epoch, and the session's task). */
  readonly #userTextAt = new Map<string, { at: number; task: string | null }>();
  /** When the user last sent a task a review (task id → milliseconds since the epoch). */
  readonly #reviewedAt = new Map<string, number>();

  constructor(deps: CoordinationDeps) {
    this.#deps = deps;
  }

  /**
   * A message from session `caller` (`null`: an agent outside Trackwall) to the session of task `id`, which the caller
   * must have proposed; the task's running session is asked to read it, now or after its turn, and without one, the
   * session the user resumes is asked.
   */
  send(caller: string | null, id: string, text: string): SendMessageResult {
    const task = this.#deps.task(id);
    const from = this.#sender(caller);
    if (task.proposedBy === null)
      throw new DomainError("bad_request", `the user started task ${id}, so no session sends it messages; tell the user instead`);
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
    return this.#updates.take(this.#proposerKey(caller));
  }

  /** How many messages and updates wait unread for a session (a task session and, as a proposer, any session). */
  unread(session: { id: string; task: string | null; supervisor: boolean }): { messages: number; updates: number } {
    const proposer = session.supervisor ? SUPERVISOR : session.id;
    return { messages: session.task === null ? 0 : this.#messages.unread(session.task), updates: this.#updates.unread(proposer) };
  }

  /** Every kept message of the tasks on the list, for the Sessions view. */
  messages(): TaskMessage[] {
    return this.#messages.list();
  }

  /** A task session's fresh view, every session cycle: an ended turn, an error or the end goes to the task's proposer. */
  watch(view: Session): void {
    const task = view.task === null ? undefined : this.#deps.findTask(view.task);
    if (!task || proposerOf(task.proposedBy) === null) return;
    const change = this.#turnsOf(view.id).next(view);
    if (change) this.#notify(task.proposedBy, { ...change, task: task.id, session: view.id, at: new Date().toISOString() });
  }

  /** Session `report_result`: the summary goes to the task's proposer. */
  resultReported(task: Task, session: string): void {
    const summary = task.summary;
    if (!summary) return;
    this.#notify(task.proposedBy, { kind: "result_reported", task: task.id, session, summary: summary.text, at: summary.reportedAt });
  }

  /** A verification with a verdict goes to the task's proposer; one still running or of an ended task does not. */
  verified(verification: Verification): void {
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

  /** The user put text into a session: it counts as taking part, and the session's turn as one the user drives. */
  userTyped(session: { id: string; task: string | null }): void {
    this.#userTextAt.set(session.id, { at: Date.now(), task: session.task });
    if (session.task !== null) this.#turnsOf(session.id).userTyped();
  }

  /** The user sent task `task` a review: it counts as taking part. */
  reviewed(task: string): void {
    this.#reviewedAt.set(task, Date.now());
  }

  /** A closed session: its watch, its typing and the updates for it (unless it is the supervisor's) go. */
  sessionClosed(id: string, supervisor: boolean): void {
    this.#turns.delete(id);
    this.#userTextAt.delete(id);
    if (!supervisor) this.#updates.forget(id);
  }

  /** An ended task: its messages go. */
  taskEnded(id: string): void {
    this.#messages.drop(id);
    this.#reviewedAt.delete(id);
  }

  #turnsOf(session: string): TurnWatch {
    let turns = this.#turns.get(session);
    if (!turns) {
      turns = new TurnWatch();
      this.#turns.set(session, turns);
    }
    return turns;
  }

  #sender(caller: string | null): ProposedBy {
    return { session: caller, supervisor: caller !== null && isSupervisor(this.#deps.session(caller)) };
  }

  #proposerKey(caller: string): string {
    return isSupervisor(this.#deps.session(caller)) ? SUPERVISOR : caller;
  }

  /**
   * When the user last took part in task `task`'s exchange with `caller`: text in the caller's session or in a session
   * of the task, or a review of the task; 0 when never.
   */
  #userTookPartAt(caller: string | null, task: string): number {
    const typedInTask = [...this.#userTextAt.values()].filter((typed) => typed.task === task).map((typed) => typed.at);
    const typedInCaller = caller === null ? 0 : (this.#userTextAt.get(caller)?.at ?? 0);
    return Math.max(0, typedInCaller, this.#reviewedAt.get(task) ?? 0, ...typedInTask);
  }

  /** Queues an update for the proposer, and asks its running session to read it. */
  #notify(proposedBy: ProposedBy | null, update: TaskUpdate): void {
    const proposer = proposerOf(proposedBy);
    if (proposer === null) return;
    this.#updates.add(proposer, update);
    const running = proposer === SUPERVISOR ? this.#deps.runningSupervisor() : this.#deps.running(proposer);
    running?.askToRead();
  }
}
