import type { MiseTarget } from "@trackwall/protocol";

/**
 * Which sessions a mise config without the user's trust refused, and which of them wait to hear that the user trusted
 * it (ADR-92): the user's click on "Trust" in the repo details or "Trust this config" in the task panel reaches the
 * agent that asked for it, so it runs again without the user telling it. Per session, in daemon memory only, like the
 * other things that wait for a session (ADR-62, ADR-68).
 *
 * A notice is asked for (`asking`) while the daemon asks the session to read, and counts as delivered (`asked`) from
 * then on: the end of the session's next turn drops it, since that turn was started by the prompt with the notice or
 * blocked with it (ADR-85), or the user drove it. An end of a turn read while asking is an earlier turn's.
 */
export class MiseTrustNotices {
  readonly #refused = new Map<string, MiseTarget>();
  readonly #notices = new Map<string, "asking" | "asked">();

  /** Session `session` runs something that needs a trusted mise config: what it waited for is over. */
  tried(session: string): void {
    this.#refused.delete(session);
    this.#notices.delete(session);
  }

  /** Session `session` was refused a run in `target` because of its mise config. */
  refused(session: string, target: MiseTarget): void {
    this.#refused.set(session, target);
  }

  /**
   * The user trusted the mise config of `trusted`: the repo root's (`task: null`), which every run in the repo needs,
   * worktrees included, or a task worktree's. Returns the sessions a run there was refused to, whose notices are now
   * asked for; the caller asks each one to read and then calls `asked`.
   */
  trusted(trusted: MiseTarget): string[] {
    const sessions = [...this.#refused]
      .filter(([, target]) => target.repo === trusted.repo && (trusted.task === null || target.task === trusted.task))
      .map(([session]) => session);
    for (const session of sessions) {
      this.#refused.delete(session);
      this.#notices.set(session, "asking");
    }
    return sessions;
  }

  /** The daemon asked session `session` to read its notice. */
  asked(session: string): void {
    if (this.#notices.has(session)) this.#notices.set(session, "asked");
  }

  /** Whether a notice waits for session `session`. */
  waiting(session: string): boolean {
    return this.#notices.has(session);
  }

  /** A turn of session `session` ended. */
  turnEnded(session: string): void {
    if (this.#notices.get(session) === "asked") this.#notices.delete(session);
  }

  closed(session: string): void {
    this.tried(session);
  }
}
