/**
 * Numbering of one view's data (`useRemote`): an HTTP request gets its number when sent, a snapshot from the events
 * WebSocket when it arrives (ADR-36), from one counter. Only data with a number not lower than the one shown reaches the
 * screen, so a response to a request sent before a snapshot does not take the view back to an older state.
 */
export class LoadOrder {
  #issued = 0;
  #shown = 0;

  /** The number for a request that is just going out, or a snapshot that just arrived. */
  next(): number {
    return ++this.#issued;
  }

  /** How many numbers have been issued so far (`sentLoads`). */
  issued(): number {
    return this.#issued;
  }

  /** Data with this number goes on screen when it is not older than what is shown; then it is what is shown. */
  show(loadNumber: number): boolean {
    if (this.isOutdated(loadNumber)) return false;
    this.#shown = loadNumber;
    return true;
  }

  /** Data or an error older than the shown data no longer says anything about it. */
  isOutdated(loadNumber: number): boolean {
    return loadNumber < this.#shown;
  }
}
