import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `batch` module (§4.8, ADR-27): the batch command, that is the same steps on many repos at once, with the
 * result of every step in every repo. The client picks repos by identifier and steps from the list; the daemon builds the
 * commands (§1.2). Kept only in the daemon's memory, like sync.
 */

/**
 * A step of the batch command, in the order it runs in a repo: sync (ADR-21), tools from the repo's mise config
 * (`mise install`), dependencies (the mise task `setup`) and build (the mise task `build`).
 */
export const BatchStep = z.enum(["sync", "tools", "setup", "build"]);
export type BatchStep = z.infer<typeof BatchStep>;

/** The order of steps in a repo, whatever the order in the request: build after dependencies, dependencies after tools. */
export const BATCH_STEPS: readonly BatchStep[] = BatchStep.options;

export const BatchStepState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("waiting") }),
  z.object({ state: z.literal("running") }),
  /** `detail`: the sync result (branch and number of new commits); `null` for mise steps. */
  z.object({ state: z.literal("done"), detail: z.string().nullable() }),
  /**
   * The step had nothing to do or could not run: sync skipped with a reason (the repo carries on anyway), a repo without
   * the mise task, or an earlier step of this repo ended with an error.
   */
  z.object({ state: z.literal("skipped"), message: z.string() }),
  /** `lastLines`: the end of the process output when the step was a process; a git or mise message has only `message`. */
  z.object({ state: z.literal("failed"), message: z.string(), lastLines: z.array(z.string()) }),
  /** Cancelled by the user (cancelling the command, stopping the mise task in the repo details, or the daemon exiting). */
  z.object({ state: z.literal("cancelled") }),
]);
export type BatchStepState = z.infer<typeof BatchStepState>;

export const BatchStepResult = z.intersection(z.object({ step: BatchStep }), BatchStepState);
export type BatchStepResult = z.infer<typeof BatchStepResult>;

export const BatchRepo = z.object({
  /** The repo identifier at start (ADR-18: it can change together with the directory name). */
  repo: RepoId,
  path: z.string(),
  /** The chosen steps in the order of `BATCH_STEPS`. */
  steps: z.array(BatchStepResult),
});
export type BatchRepo = z.infer<typeof BatchRepo>;

export const BatchRun = z.object({
  /** ISO 8601. */
  startedAt: z.string(),
  /** ISO 8601; `null` while some repo is waiting or running. */
  finishedAt: z.string().nullable(),
  /** The user cancelled the command: steps that had not started before the cancel are `cancelled`. */
  cancelled: z.boolean(),
  /** The chosen repos in the order of the request. */
  repos: z.array(BatchRepo),
});
export type BatchRun = z.infer<typeof BatchRun>;

function unique<T>(items: readonly T[]): boolean {
  return new Set(items).size === items.length;
}

export const BatchRequest = z
  .object({
    /** Repos the command covers; the client makes the choice (by hand, later by tags). */
    repos: z.array(RepoId).min(1, "choose at least one repo").refine(unique, "a repo appears twice in the list"),
    steps: z.array(BatchStep).min(1, "choose at least one step").refine(unique, "a step appears twice in the list"),
  })
  .strict();
export type BatchRequest = z.infer<typeof BatchRequest>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/batch/${action}`, request, data };
}

export const batchApi = {
  /** Starts the batch command in the background and returns it at once; while another runs, `bad_request`. Progress through `run`. */
  start: endpoint("start", BatchRequest, BatchRun),
  /** The last batch command since the daemon started; `null` when there was none. */
  run: endpoint("run", z.object({}).strict(), BatchRun.nullable()),
  /**
   * Cancels a running command: repos that are waiting and steps that have not started will not start, and running mise
   * tasks are stopped like a stop from the repo details. A running sync step cannot be cancelled; it finishes on its own.
   */
  cancel: endpoint("cancel", z.object({}).strict(), BatchRun.nullable()),
};
