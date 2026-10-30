import type { MiseTarget } from "@trackwall/protocol";

/**
 * Leases of repo ports (§4.3, ADR-132): a task's service runs on the port of its repo root's service, so whatever calls
 * the repo (another service, a dev server's proxy, the browser through a forwarded port) reaches the task's changes
 * without being told about the task port. One lease per repo, since the root has one port. This is only the record;
 * `Services` stops and starts the services around it.
 */

export interface Lease {
  /** The task's service that holds the port. */
  holder: MiseTarget & { task: string };
  port: number;
  /** The run of the holder on the port; `null` until it has started. */
  runId: string | null;
  /** The root's service ran when the lease began: it starts again once the lease ends. */
  restoreRoot: boolean;
  /** Resolves once the root's service has stopped and the port is free for the holder. */
  ready: Promise<void>;
}

export class Leases {
  private readonly byRepo = new Map<string, Lease>();

  /** The lease on the port of `repo`, if any. */
  of(repo: string): Lease | undefined {
    return this.byRepo.get(repo);
  }

  /** The lease `target` holds; `undefined` for a repo root or a task without one. */
  heldBy(target: MiseTarget): Lease | undefined {
    const lease = this.byRepo.get(target.repo);
    return lease && lease.holder.task === target.task ? lease : undefined;
  }

  add(lease: Lease): void {
    this.byRepo.set(lease.holder.repo, lease);
  }

  /** Ends `lease`; `false` when it had already ended (another end came first). */
  remove(lease: Lease): boolean {
    if (this.byRepo.get(lease.holder.repo) !== lease) return false;
    this.byRepo.delete(lease.holder.repo);
    return true;
  }
}
