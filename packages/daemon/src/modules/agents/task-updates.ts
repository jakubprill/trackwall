import { TASK_UPDATES_KEPT, type TaskUpdate } from "@trackwall/protocol";

/**
 * Task updates (ADR-68): what happened to delegated work, queued per proposer key (`proposer.ts`) until the proposer
 * reads them with `get_updates`. An agent outside Trackwall has no input box to be woken in and gets none. Only in
 * daemon memory: at most `TASK_UPDATES_KEPT` unread per proposer, the oldest dropping out.
 */

export class TaskUpdates {
  readonly #unread = new Map<string, TaskUpdate[]>();
  readonly #dropped = new Map<string, number>();

  add(proposer: string, update: TaskUpdate): void {
    const unread = [...(this.#unread.get(proposer) ?? []), update];
    const over = unread.length - TASK_UPDATES_KEPT;
    if (over > 0) this.#dropped.set(proposer, (this.#dropped.get(proposer) ?? 0) + over);
    this.#unread.set(proposer, unread.slice(Math.max(0, over)));
  }

  unread(proposer: string): number {
    return this.#unread.get(proposer)?.length ?? 0;
  }

  /** The unread updates and how many dropped out before them, which from now on count as read. */
  take(proposer: string): { updates: TaskUpdate[]; dropped: number } {
    const result = { updates: this.#unread.get(proposer) ?? [], dropped: this.#dropped.get(proposer) ?? 0 };
    this.forget(proposer);
    return result;
  }

  /** A closed session hears nothing more. */
  forget(proposer: string): void {
    this.#unread.delete(proposer);
    this.#dropped.delete(proposer);
  }
}
