import { TASK_UPDATES_KEPT, TaskUpdate } from "@trackwall/protocol";
import { z } from "zod";
import { ProposerKey } from "./proposer.ts";

/**
 * Task updates (ADR-68): what happened to delegated work, queued per proposer key (`proposer.ts`) until the proposer
 * reads them with `get_updates`. An agent outside Trackwall has no input box to be woken in and gets none. At most
 * `TASK_UPDATES_KEPT` unread per proposer, the oldest dropping out. Since ADR-115 they outlive a daemon restart in
 * `agent-queues.json` (`stored`, `restore`), for the supervisor and the sessions the next daemon resumes under the same
 * id; every change is reported to `changed`, which writes the file.
 */

/** What `agent-queues.json` keeps of the updates: the unread ones of each proposer key, and how many dropped out before them. */
export const StoredUpdates = z.array(
  z.object({
    proposer: ProposerKey,
    updates: z.array(TaskUpdate).max(TASK_UPDATES_KEPT),
    dropped: z.number().int().nonnegative(),
  }),
);
export type StoredUpdates = z.infer<typeof StoredUpdates>;

export class TaskUpdates {
  readonly #unread = new Map<string, TaskUpdate[]>();
  readonly #dropped = new Map<string, number>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  stored(): StoredUpdates {
    return [...this.#unread].map(([proposer, updates]) => ({ proposer, updates, dropped: this.#dropped.get(proposer) ?? 0 }));
  }

  /** The updates the previous daemon kept, of the proposers that are still there (`hasProposer`). */
  restore(stored: StoredUpdates, hasProposer: (proposer: string) => boolean): void {
    this.#unread.clear();
    this.#dropped.clear();
    for (const { proposer, updates, dropped } of stored) {
      if (!hasProposer(proposer)) continue;
      this.#unread.set(proposer, updates);
      if (dropped > 0) this.#dropped.set(proposer, dropped);
    }
  }

  add(proposer: string, update: TaskUpdate): void {
    const unread = [...(this.#unread.get(proposer) ?? []), update];
    const over = unread.length - TASK_UPDATES_KEPT;
    if (over > 0) this.#dropped.set(proposer, (this.#dropped.get(proposer) ?? 0) + over);
    this.#unread.set(proposer, unread.slice(Math.max(0, over)));
    this.#changed();
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
    const had = this.#unread.delete(proposer);
    this.#dropped.delete(proposer);
    if (had) this.#changed();
  }
}
