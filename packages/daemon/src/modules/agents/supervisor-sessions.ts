import { randomUUID } from "node:crypto";
import { isSupervisor, type Session, type SessionView, type SupervisorConversation } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import type { LastSupervisor, LastSupervisorFile } from "./last-supervisor.ts";
import type { ListedSessions } from "./listed-sessions.ts";
import { type SessionLaunch, sessionLaunch } from "./resumable-sessions.ts";
import type { SessionPlace } from "./session-launcher.ts";

/**
 * The supervisor (§4.4, ADR-58): the one session in the projects folder above the sessions of all repos. At most one
 * runs at a time, and two requests at once share one start. A new one replaces the ended ones, which are closed once
 * it has started, so a failed start keeps the last screen; the work they delegated stays, marked as the supervisor's
 * (`ProposedBy.supervisor`). The newest one's conversation can go on under its id (ADR-96). What the supervisor may do
 * as a session (its role, its tools, its proposals) is the same as for any other session and lives elsewhere.
 */

export interface SupervisorSessionsDeps {
  sessions: Pick<ListedSessions, "views" | "has">;
  lastSupervisor: LastSupervisorFile;
  /** The projects folder the supervisor runs in; `bad_request` while it is not set. */
  projectsDir: () => Promise<string>;
  /** A start of either view in `place`, which joins the list. */
  launch: (spec: SessionLaunch, place: SessionPlace) => Promise<Session>;
  /** Closes an ended session, as the user's Close does. */
  close: (id: string) => void;
}

export class SupervisorSessions {
  readonly #deps: SupervisorSessionsDeps;
  /** The start under way, so that two requests at once start one supervisor, not two. */
  #starting: Promise<Session> | undefined;

  constructor(deps: SupervisorSessionsDeps) {
    this.#deps = deps;
  }

  /**
   * The running supervisor, or a new one. With `last` it goes on with the newest supervisor's conversation under its id
   * (ADR-96); that start closes the ended supervisor first, since an id is listed once, so when it fails the last
   * screen is gone. `view` is a terminal or the conversation view (ADR-107); the last conversation goes on in either.
   */
  async start(conversation: SupervisorConversation, view: SessionView): Promise<Session> {
    if (this.#starting) return this.#starting;
    const running = this.#running();
    if (running) return running;
    const last = conversation === "last" ? this.resumable() : undefined;
    return last === undefined ? this.#startNew(null, view) : this.#startAs(sessionLaunch(view, last));
  }

  /**
   * A new supervisor with `firstMessage` as its first message (`--interactive`), so it works from the start: the day start
   * (ADR-70). While a supervisor starts or runs, `bad_request`: the user stops it first, so no conversation ends without them.
   */
  async startWith(firstMessage: string, view: SessionView): Promise<Session> {
    this.assertNone();
    return this.#startNew(firstMessage, view);
  }

  /** The supervisor the previous daemon left running starts again (ADR-95), unless one already starts or runs. */
  async resume(spec: SessionLaunch): Promise<Session> {
    if (this.#starting || this.#running()) throw new Error("a supervisor already runs");
    return this.#startAs(spec);
  }

  /** `bad_request` while a supervisor starts or runs (ADR-70). */
  assertNone(): void {
    if (this.#starting || this.#running())
      throw new DomainError("bad_request", "the supervisor is running; stop it to start your day with a new one");
  }

  /** The newest supervisor while Copilot CLI keeps its conversation, which a start with `last` goes on with (ADR-96). */
  resumable(): LastSupervisor | undefined {
    const last = this.#deps.lastSupervisor.read();
    return last?.hasConversation ? last : undefined;
  }

  #running(): Session | undefined {
    return this.#deps.sessions.views().find((s) => isSupervisor(s) && s.run.kind !== "exited");
  }

  /**
   * `firstMessage` is the first message (`--interactive`) of the new supervisor; `null` for none. In a terminal its id
   * is also Copilot CLI's session id, so a restart can resume it (ADR-95); in the conversation view Copilot CLI picks
   * the conversation's id (ADR-107).
   */
  #startNew(firstMessage: string | null, view: SessionView): Promise<Session> {
    const id = randomUUID();
    if (view === "conversation") return this.#startAs({ view, id, load: undefined, firstMessage: firstMessage ?? undefined });
    const args = [`--session-id=${id}`, ...(firstMessage === null ? [] : [`--interactive=${firstMessage}`])];
    const started = firstMessage !== null;
    return this.#startAs({ view, id, args, promptOnStart: started, hasConversation: started, conversation: id });
  }

  #startAs(spec: SessionLaunch): Promise<Session> {
    this.#starting = this.#replace(spec).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #replace(spec: SessionLaunch): Promise<Session> {
    const { sessions } = this.#deps;
    const ended = sessions.views().filter(isSupervisor);
    const cwd = await this.#deps.projectsDir();
    // The ended supervisor whose conversation this one goes on with under its id gives up its place before the start.
    if (sessions.has(spec.id)) this.#deps.close(spec.id);
    const started = await this.#deps.launch(spec, { repo: null, supervisor: true, cwd, task: null });
    // One of them may have been dismissed during the start; the start has still succeeded.
    for (const old of ended) if (old.id !== spec.id && sessions.has(old.id)) this.#deps.close(old.id);
    return started;
  }
}
