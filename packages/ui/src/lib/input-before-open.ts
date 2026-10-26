/** Enough for whatever a user types or pastes in the moment before a terminal connects; more is dropped, not queued. */
export const MAX_HELD_INPUT = 4096;

/**
 * Keys typed into a session terminal before its first connection to the PTY opens (§5.2). A terminal just mounted
 * (after switching to a session or to its Terminal tab) takes keys at once, but its socket opens a moment later, so
 * these keys wait and go to the session in order when it opens. Only the first attempt: when it fails, or for keys
 * typed while a lost connection comes back, the keys are dropped, because the screen they answer may have changed by
 * the time a connection opens. Once a key is dropped, the ones after it are dropped too, so the session never gets
 * an Enter for text that did not reach it.
 */
export class InputBeforeOpen {
  #held: string[] | undefined = [];
  #length = 0;
  #dropped = false;

  /** What to do with keys the terminal took: send them now, or they are held, or dropped. */
  take(data: string): "send" | "held" | "dropped" {
    if (this.#held === undefined) return "send";
    if (this.#dropped || this.#length + data.length > MAX_HELD_INPUT) {
      this.#dropped = true;
      return "dropped";
    }
    this.#held.push(data);
    this.#length += data.length;
    return "held";
  }

  /** The first connection opened: the held keys in the order they were typed, and whether some were dropped. */
  open(): { keys: string[]; dropped: boolean } {
    const opened = { keys: this.#held ?? [], dropped: this.#dropped };
    this.#end();
    return opened;
  }

  /** The first connection attempt failed: the held keys are dropped; true when there were any. */
  fail(): boolean {
    const lost = (this.#held?.length ?? 0) > 0 || this.#dropped;
    this.#end();
    return lost;
  }

  #end(): void {
    this.#held = undefined;
    this.#dropped = false;
  }
}
