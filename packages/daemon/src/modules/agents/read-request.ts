import type { ReadRequest, ReadRequestHold } from "@trackwall/protocol";

/**
 * What waits unread for a session's agent, as the session list shows it (ADR-159): the daemon's prompt, since when it
 * has waited and what holds it back. Each session view (`LiveSession`, `AcpSession`) knows its own reasons; this keeps
 * the clock of "since" and the shape, so both say it the same way.
 */
export class ReadRequestClock {
  #since: number | undefined;

  /** Notes what waits now (`undefined`: nothing); called every read cycle, so a break of one cycle restarts the clock. */
  observe(prompt: string | undefined, now = Date.now()): void {
    this.#since = prompt === undefined ? undefined : (this.#since ?? now);
  }

  /** The read request for the session list; `null` when nothing waits or the session no longer runs. */
  readRequest(prompt: string | undefined, waitsFor: ReadRequestHold, running: boolean): ReadRequest | null {
    if (!running || prompt === undefined) return null;
    const since = this.#since ?? Date.now();
    return { prompt, since: new Date(since).toISOString(), waitsFor };
  }
}
