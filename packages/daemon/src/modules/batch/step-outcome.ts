import type { BatchStepState, RunState, SyncResult } from "@trackwall/protocol";

/** The outcome of a batch command step (§4.8) from a sync result or from the end of a `mise` run. */

/** A skipped sync does not stop the repo: the next steps work on what is there locally. */
export function syncOutcome(result: SyncResult): BatchStepState {
  switch (result.state) {
    case "updated":
      return { state: "done", detail: `${result.branch} +${result.commits}` };
    case "up-to-date":
      return { state: "done", detail: `${result.branch} up to date` };
    case "skipped":
      return { state: "skipped", message: result.message };
  }
}

/** A stop from the UI, a command cancellation and a daemon exit give `stoppedByUser`, so it is a cancellation, not an error. */
export function runOutcome(run: RunState): BatchStepState {
  if (run.kind !== "exited") throw new Error(`run ${run.runId} is still going (${run.kind})`);
  if (run.stoppedByUser) return { state: "cancelled" };
  if (run.exitCode === 0) return { state: "done", detail: null };
  const message = run.exitCode === null ? `ended by signal ${run.signal}` : `exited with code ${run.exitCode}`;
  return { state: "failed", message, lastLines: run.lastLines };
}
