import { rmSync } from "node:fs";
import { isSupervisor, type RunState, type Session } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import type { AgentSession } from "./agent-session.ts";
import { LAST_SUPERVISOR_FILE, type LastSupervisor, type LastSupervisorFile } from "./last-supervisor.ts";
import type { ResumableSession, ResumableSessions } from "./resumable-sessions.ts";
import type { SessionMiseEnv, SessionMiseLaunch } from "./session-env.ts";
import { SessionEnvironments } from "./session-env-change.ts";
import { type StartedSession, sessionDir, sessionOwner } from "./session-launcher.ts";
import type { SessionTokens } from "./session-tokens.ts";

/**
 * The sessions the daemon lists (§4.4, ADR-26), newest last: a started session joins, and leaves when the user closes it
 * or a restart starts it again. The list owns what lasts as long as a session is listed: the 200 ms tick that reads its
 * hook records and the end of its process, the environment it started with (ADR-119), its session token and its
 * directory. At every tick it writes the running sessions for the next daemon to resume (ADR-95) and the newest
 * supervisor a start with `last` goes on with (ADR-96). Everything a session means for tasks, proposals and messages is
 * `Agents`'s.
 */

/** How often sessions read hook records and check for the end of the process. */
const TICK_MS = 200;

export interface ListedSessionsDeps {
  /** The state of a session's process group in `procs`. */
  state: (owner: string) => RunState | undefined;
  home: string;
  tokens: SessionTokens;
  resumable: ResumableSessions;
  lastSupervisor: LastSupervisorFile;
  log: (msg: string) => void;
}

export class ListedSessions {
  readonly #deps: ListedSessionsDeps;
  readonly #sessions = new Map<string, AgentSession>();
  /** The environment each listed session started with, to tell when mise would give it another one (ADR-119). */
  readonly #environments = new SessionEnvironments();
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: ListedSessionsDeps) {
    this.#deps = deps;
  }

  /** A started session joins the list; the tick runs while any session is listed. */
  add({ session, miseEnv, mise }: StartedSession): void {
    this.#sessions.set(session.id, session);
    this.#environments.remember(session.id, miseEnv, mise);
    this.#timer ??= setInterval(() => this.#tick(), TICK_MS);
    this.#timer.unref();
  }

  /** The session leaves the list with its token and files; `Agents` decides what else of it goes. */
  remove(session: AgentSession): void {
    this.#sessions.delete(session.id);
    this.#environments.forget(session.id);
    this.#deps.tokens.revoke(session.id);
    session.dispose();
    try {
      rmSync(sessionDir(this.#deps.home, session.id), { recursive: true, force: true });
    } catch (err) {
      this.#deps.log(`removing session files ${session.id}: ${String(err)}`);
    }
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  /** A listed session, or `undefined`; `get` is the one that refuses an unknown id. */
  find(id: string): AgentSession | undefined {
    return this.#sessions.get(id);
  }

  /** A listed session; `not_found` when it does not exist or the user closed it. */
  get(id: string): AgentSession {
    const session = this.#sessions.get(id);
    if (!session) throw new DomainError("not_found", `no session ${id}`);
    return session;
  }

  /** Sessions as the API shows them, newest first. */
  views(): Session[] {
    return this.#all()
      .flatMap((s) => this.#fresh(s) ?? [])
      .reverse();
  }

  /**
   * Sessions as the last cycle left them, newest first, without a cycle of their own: for a reader that comes every
   * cycle anyway, such as the `/ws` events, where a cycle of its own would read every session twice as often.
   */
  viewsAsOfLastCycle(): Session[] {
    return this.#all()
      .flatMap((s) => s.view() ?? [])
      .reverse();
  }

  view(session: AgentSession): Session {
    const view = this.#fresh(session);
    if (!view) throw new Error(`session ${session.id} has no process group`);
    return view;
  }

  /** The state after the hooks already written, as the view reads it. */
  isRunning(session: AgentSession): boolean {
    return this.#fresh(session)?.run.kind === "running";
  }

  /** The oldest running session `match` picks. */
  runningWhere(match: (session: AgentSession) => boolean): AgentSession | undefined {
    return this.#all().find((s) => match(s) && this.isRunning(s));
  }

  /** The task's newest session while it runs. */
  runningOfTask(task: string): AgentSession | undefined {
    return this.#all()
      .reverse()
      .find((s) => s.task === task && this.isRunning(s));
  }

  /** How the environment mise would give the session now differs from the one it started with (ADR-119). */
  environmentChange(id: string, miseEnv: SessionMiseEnv, mise: SessionMiseLaunch) {
    return this.#environments.changeSince(id, miseEnv, mise);
  }

  /**
   * Daemon exit, before `procs.stopAll`: the sessions it stops are written for the next daemon to resume (ADR-95), and
   * the file is no longer followed, so their end does not empty it.
   */
  keepRunningForResume(): void {
    // The list of this moment, not of the last tick: a session stopped or started since then counts as it is now.
    this.#followLive(this.#all().filter((s) => this.#deps.state(sessionOwner(s.id))?.kind === "running"));
    this.#followLastSupervisor();
    this.#deps.resumable.stopFollowing();
  }

  /** Daemon exit: `procs.stopAll` stops the processes, here only the observing ends. */
  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Listed sessions, oldest first. */
  #all(): AgentSession[] {
    return [...this.#sessions.values()];
  }

  /** The session's state after reading new hook records and the end of the process. */
  #fresh(session: AgentSession): Session | undefined {
    session.tick();
    return session.view();
  }

  #tick(): void {
    const live: AgentSession[] = [];
    for (const session of this.#sessions.values()) {
      try {
        if (session.tick()) live.push(session);
      } catch (err) {
        live.push(session);
        this.#deps.log(`session ${session.id}: ${String(err)}`);
      }
    }
    this.#followLive(live);
    this.#followLastSupervisor();
    if (live.length === 0) this.close();
  }

  /** The list of running sessions a restart resumes (ADR-95); a failed write is retried at the next tick. */
  #followLive(live: readonly AgentSession[]): void {
    this.#deps.resumable.follow(live.map(resumableOf));
  }

  /** The newest listed supervisor, which a start with `last` goes on with (ADR-96); a failed write is retried at the next tick. */
  #followLastSupervisor(): void {
    const newest = this.#all().findLast(isSupervisor);
    if (newest === undefined) return;
    const last: LastSupervisor = { session: newest.id, ...resumedAs(newest) };
    try {
      this.#deps.lastSupervisor.follow(last);
    } catch (err) {
      this.#deps.log(`writing ${LAST_SUPERVISOR_FILE}: ${String(err)}`);
    }
  }
}

/** The session as a restart or the next daemon starts it again (ADR-95, ADR-119). */
export function resumableOf(session: AgentSession): ResumableSession {
  const { id, repo, supervisor, task, sessionView: view } = session;
  return { session: id, repo, supervisor, task, view, ...resumedAs(session) };
}

/** How a restart or a start with `last` goes on with the session's conversation (ADR-95, ADR-96, ADR-107). */
function resumedAs(session: AgentSession): { hasConversation: boolean; conversation?: string } {
  const { hasConversation, conversation } = session;
  return conversation === undefined || conversation === session.id ? { hasConversation } : { hasConversation, conversation };
}
