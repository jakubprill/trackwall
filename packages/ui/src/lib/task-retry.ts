import type { Task, Verification } from "@trackwall/protocol";

/**
 * A failed task retried on a stronger model (ADR-232): when the Verification section offers it, and on which model in
 * one click.
 */

/** The retry is offered once the task's last verification failed: a red verdict is what says the attempt did not work. */
export function offersRetry(verification: Pick<Verification, "state"> | null): boolean {
  return verification?.state === "failed";
}

/**
 * The model of the one-click retry: the retry model from Settings, unless the task already runs on it, when a retry
 * would only repeat the attempt; `null` when there is none, and the user types one.
 */
export function oneClickRetryModel(task: Pick<Task, "model">, retryModel: string | null): string | null {
  return retryModel !== null && retryModel !== task.model ? retryModel : null;
}
