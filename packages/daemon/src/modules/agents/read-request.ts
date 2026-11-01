import type { ReadRequest, ReadRequestHold } from "@trackwall/protocol";

/**
 * The clock of a session's read request (ADR-159): since when something has waited unread for its agent without a
 * break. Each session view (`LiveSession`, `AcpSession`) knows what holds its own prompt back; this keeps the time and
 * the shape, so both say it the same way.
 */
export class ReadRequestClock {
  #since: number | undefined;

  /** Notes what waits now (`undefined`: nothing); called every read cycle, so a break of one cycle restarts the clock. */
  observe(prompt: string | undefined, now = Date.now()): void {
    this.#since = prompt === undefined ? undefined : (this.#since ?? now);
  }

  /** The read request for the session panel, observing `prompt` first, so a prompt seen between read cycles keeps its time. */
  readRequest(prompt: string, waitsFor: ReadRequestHold, now = Date.now()): ReadRequest {
    this.observe(prompt, now);
    return { prompt, since: new Date(this.#since ?? now).toISOString(), waitsFor };
  }
}
