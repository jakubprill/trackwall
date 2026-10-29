import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { TaskId, TaskProposal } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../../infra/errors.ts";

/**
 * Task proposals (ADR-39): tasks submitted with the MCP tool `propose_task` that wait for the user's decision in the
 * Sessions view. Rejected ones disappear from the list, but their identifiers stay, so that a session waiting for the
 * proposal gets `proposal_rejected` instead of `not_found`. Since ADR-55 a rejection also keeps the user's reason for
 * that session. A repo removal (ADR-83) keeps the folder it names, fixed when it was proposed: approval moves that folder
 * or none. Since ADR-115 all of it outlives a daemon restart in `agent-queues.json` (`stored`, `restore`), because the
 * sessions that proposed them are resumed (ADR-95); every change is reported to `changed`, which writes the file.
 */

/** This many proposals can wait at once: a session in a loop does not flood the list, and a human would not review more anyway. */
export const MAX_PENDING_PROPOSALS = 20;
/** This many recent rejections the daemon remembers for waiting sessions. */
const REMEMBERED_REJECTIONS = 100;

/**
 * What `agent-queues.json` keeps of the proposals: the waiting ones (newest first), the folder of each waiting repo
 * removal and the remembered rejections (oldest first).
 */
export const StoredProposals = z.object({
  pending: z.array(TaskProposal).max(MAX_PENDING_PROPOSALS),
  removalDirs: z.record(TaskId, z.string().max(4096).refine(isAbsolute, "a repo folder must be a full path")),
  rejected: z.array(z.object({ id: TaskId, reason: z.string().nullable() })).max(REMEMBERED_REJECTIONS),
});
export type StoredProposals = z.infer<typeof StoredProposals>;

export class TaskProposals {
  /** Newest first. */
  #pending: TaskProposal[] = [];
  /**
   * Approved ones whose task is still being created: they stay on the list, so that the panel in the UI does not disappear
   * during approval (with an error and an edited prompt), but nobody approves or rejects them a second time.
   */
  readonly #approving = new Set<string>();
  /** Rejected id to the user's reason (`null` without one), oldest first; the oldest drop out after `REMEMBERED_REJECTIONS`. */
  readonly #rejected = new Map<string, string | null>();
  /** The folder each waiting repo removal names. */
  readonly #removalDirs = new Map<string, string>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  /** The proposals to keep across a restart; one being approved counts as waiting, since its approval ends with the daemon. */
  stored(): StoredProposals {
    return {
      pending: this.list(),
      removalDirs: Object.fromEntries(this.#removalDirs),
      rejected: [...this.#rejected].map(([id, reason]) => ({ id, reason })),
    };
  }

  /**
   * The proposals the previous daemon kept that still wait: not one that became a task while it stopped (`hasTask`), nor
   * a repo removal without its folder, in the file or on the disk (`hasFolder`): an approval that moved the folder while
   * the daemon stopped reached the file no more. The move checks the folder against the repo's folder of now
   * (`removeRepo`), so a path from the file moves nothing else.
   */
  restore(
    { pending, removalDirs, rejected }: StoredProposals,
    { hasTask, hasFolder }: { hasTask: (id: string) => boolean; hasFolder: (dir: string) => boolean },
  ): void {
    this.#pending = pending.filter((p) => {
      if (hasTask(p.id)) return false;
      if (p.kind !== "remove_repo") return true;
      const dir = removalDirs[p.id];
      return dir !== undefined && hasFolder(dir);
    });
    this.#removalDirs.clear();
    for (const p of this.#pending) {
      const dir = removalDirs[p.id];
      if (p.kind === "remove_repo" && dir !== undefined) this.#removalDirs.set(p.id, dir);
    }
    this.#rejected.clear();
    for (const { id, reason } of rejected) this.#rejected.set(id, reason);
  }

  list(): TaskProposal[] {
    return [...this.#pending];
  }

  /** A new proposal; a repo removal (`kind: "remove_repo"`) with the folder it names. */
  add(proposal: Omit<TaskProposal, "id" | "createdAt">, removalDir?: string): TaskProposal {
    if ((proposal.kind === "remove_repo") !== (removalDir !== undefined))
      throw new Error("a repo removal, and only a repo removal, names a folder");
    if (this.#pending.length >= MAX_PENDING_PROPOSALS) {
      throw new DomainError("bad_request", `${MAX_PENDING_PROPOSALS} proposals are already waiting for the user; wait for their decision`);
    }
    const added: TaskProposal = { id: randomUUID(), ...proposal, createdAt: new Date().toISOString() };
    this.#pending = [added, ...this.#pending];
    if (removalDir !== undefined) this.#removalDirs.set(added.id, removalDir);
    this.#changed();
    return added;
  }

  /** A proposal waiting for a decision (not one being approved), or `undefined`. */
  find(id: string): TaskProposal | undefined {
    return this.#approving.has(id) ? undefined : this.#pending.find((p) => p.id === id);
  }

  /** A waiting proposal (`not_found` when it is missing, because the user has already decided). */
  get(id: string): TaskProposal {
    const proposal = this.find(id);
    if (!proposal) throw new DomainError("not_found", `no task proposal ${id} is waiting for a decision`);
    return proposal;
  }

  /** The folder a waiting repo removal names, or `undefined` for a task proposal. */
  removalDir(id: string): string | undefined {
    return this.#removalDirs.get(id);
  }

  /** A proposal approved while its task is being created, or `undefined`. */
  approving(id: string): TaskProposal | undefined {
    return this.#approving.has(id) ? this.#pending.find((p) => p.id === id) : undefined;
  }

  /** Takes a waiting proposal for approval; a second `take` or `reject` is `not_found` while it lasts. */
  take(id: string): TaskProposal {
    const proposal = this.get(id);
    this.#approving.add(id);
    return proposal;
  }

  /**
   * The end of approval: with `restore` the proposal waits again (its task was not created, or its repo not removed),
   * without it it disappears, because it is a task now or its repo is gone.
   */
  release(id: string, restore: boolean): void {
    this.#approving.delete(id);
    if (restore) return;
    this.#pending = this.#pending.filter((p) => p.id !== id);
    this.#removalDirs.delete(id);
    this.#changed();
  }

  reject(id: string, reason: string | null): void {
    this.get(id);
    this.#pending = this.#pending.filter((p) => p.id !== id);
    this.#removalDirs.delete(id);
    this.#rejected.set(id, reason);
    for (const old of this.#rejected.keys()) {
      if (this.#rejected.size <= REMEMBERED_REJECTIONS) break;
      this.#rejected.delete(old);
    }
    this.#changed();
  }

  /** How the user rejected the proposal, or `undefined` when it was not rejected (or long enough ago to be forgotten). */
  rejection(id: string): { reason: string | null } | undefined {
    return this.#rejected.has(id) ? { reason: this.#rejected.get(id) ?? null } : undefined;
  }
}
