/**
 * When a new `refreshKey` of `useRemote` fetches (§5.2, ADR-63): at once when nothing is on its way and the window is
 * visible; otherwise once, after the response or when the window shows. So a key that changes faster than the daemon
 * answers (repo events during a sync) does not cancel every response, and a hidden window does not fetch for nobody.
 */
export class RefreshGate {
  #busy = false;
  #stale = false;
  /** The key the last request was sent with. */
  #sentKey: string | undefined;

  constructor(key: string | undefined) {
    this.#sentKey = key;
  }

  /** A request is sent with this key; it covers every change up to it. */
  sent(key: string | undefined): void {
    this.#busy = true;
    this.#stale = false;
    this.#sentKey = key;
  }

  /** The key changed; `true` when a fetch should start now. */
  keyChanged(key: string | undefined, hidden: boolean): boolean {
    if (key === this.#sentKey) return false;
    if (this.#busy || hidden) {
      this.#stale = true;
      return false;
    }
    return true;
  }

  /** The response came; `true` when the data is already older than the key and a fetch should start now. */
  answered(hidden: boolean): boolean {
    this.#busy = false;
    return this.#stale && !hidden;
  }

  /** The window showed; `true` when a change waited for it. */
  shown(): boolean {
    return this.#stale && !this.#busy;
  }
}
