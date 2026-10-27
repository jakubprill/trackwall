import type { MiseTarget } from "@trackwall/protocol";

/**
 * Which sessions a mise config without the user's trust refused, and which of them wait to hear that the user trusted
 * it (ADR-92): the user's click on "Trust" in the repo details or "Trust this config" in the task panel reaches the
 * agent that asked for it, so it runs again without the user telling it. Per session, in daemon memory only, like the
 * other things that wait for a session (ADR-62, ADR-68).
 *
 * A session is either refused in a target, or has a trust notice waiting. The notice is in every prompt the daemon
 * sends the session from then on, and counts as delivered once one is sent (typed or as a block, `promptSent`): the
 * end of the turn after that is the end of the turn the prompt started, and drops it.
 */
type Waiting = { kind: "refused"; target: MiseTarget } | { kind: "notice"; sent: boolean };

export class MiseTrustNotices {
  readonly #waiting = new Map<string, Waiting>();

  /** Session `session` runs something that needs a trusted mise config, or closed: what it waited for is over. */
  forget(session: string): void {
    this.#waiting.delete(session);
  }

  /** Session `session` was refused a run in `target` because of its mise config. */
  refused(session: string, target: MiseTarget): void {
    this.#waiting.set(session, { kind: "refused", target });
  }

  /**
   * The user trusted the mise config of `trusted`: the repo root's (`task: null`), which every run in the repo needs,
   * worktrees included, or a task worktree's. Returns the sessions a run there was refused to, which have a notice now.
   */
  trusted(trusted: MiseTarget): string[] {
    const sessions = [...this.#waiting].flatMap(([session, waiting]) =>
      waiting.kind === "refused" && waiting.target.repo === trusted.repo && (trusted.task === null || waiting.target.task === trusted.task)
        ? [session]
        : [],
    );
    for (const session of sessions) this.#waiting.set(session, { kind: "notice", sent: false });
    return sessions;
  }

  /** Whether a notice waits for session `session`. */
  waiting(session: string): boolean {
    return this.#waiting.get(session)?.kind === "notice";
  }

  /** The daemon sent session `session` its prompt, which named the notice if one waited. */
  promptSent(session: string): void {
    if (this.waiting(session)) this.#waiting.set(session, { kind: "notice", sent: true });
  }

  /** A turn of session `session` ended. */
  turnEnded(session: string): void {
    const waiting = this.#waiting.get(session);
    if (waiting?.kind === "notice" && waiting.sent) this.#waiting.delete(session);
  }
}
