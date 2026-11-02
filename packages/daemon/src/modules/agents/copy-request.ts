import { randomUUID } from "node:crypto";
import type { CopyRequest } from "@trackwall/protocol";

/**
 * A session's copy request (ADR-180): the latest text its agent asked to put on the user's clipboard, kept until the
 * user copies or dismisses it in the session's panel. One per session: a newer request replaces one not taken yet, so
 * the panel never offers text the agent has since corrected.
 */
export class CopyRequestSlot {
  #request: CopyRequest | null = null;

  get request(): CopyRequest | null {
    return this.#request;
  }

  ask(text: string, now = new Date()): CopyRequest {
    this.#request = { id: randomUUID(), text, at: now.toISOString() };
    return this.#request;
  }

  /** The user took request `id`; a newer one stays. */
  clear(id: string): void {
    if (this.#request?.id === id) this.#request = null;
  }
}
