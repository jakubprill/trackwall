import { z } from "zod";
import { TaskId } from "./agents.ts";
import type { Endpoint } from "./api.ts";
import { RunState } from "./procs.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `mise` module (§4, ADR-20): mise tasks of the workspace repos and their runs. Every action is
 * `POST /api/mise/<action>`. The client names a mise task from the list; the daemon builds the command (§1.2).
 */

/**
 * A mise task name as `mise tasks ls` returns it (for example `dev`, `build:ui`). The daemon runs only a mise task from the
 * repo's current list anyway; the schema rejects what mise would take for an option or what cannot be shown.
 */
export const MiseTaskName = z
  .string()
  .min(1)
  .max(200)
  .refine((n) => !n.startsWith("-"), "a mise task name cannot start with '-'")
  .refine((n) => [...n].every((c) => c >= " "), "mise task name: no control characters");
export type MiseTaskName = z.infer<typeof MiseTaskName>;

export const MiseTask = z.object({
  name: MiseTaskName,
  description: z.string(),
  /** The last run since the daemon started; `null` when the mise task was not run. */
  run: RunState.nullable(),
});
export type MiseTask = z.infer<typeof MiseTask>;

/**
 * The reason mise did not give the list, and the mise tasks that run anyway (started earlier): without them an error in
 * `mise.toml` during work would take away stopping the server from the UI.
 */
const NoList = { message: z.string(), running: z.array(MiseTask) };

/** The repo's mise tasks, or the reason mise did not list them. */
export const MiseTasks = z.discriminatedUnion("kind", [
  /** A repo without a mise config has an empty list. A mise task that left the config while running stays, so it can be stopped. */
  z.object({ kind: z.literal("ok"), tasks: z.array(MiseTask) }),
  /** There is no `mise` program in the daemon's `PATH`. */
  z.object({ kind: z.literal("not_installed"), ...NoList }),
  /** mise does not read the repo's config until the user trusts it (`mise trust`, the `trust` action). */
  z.object({ kind: z.literal("untrusted"), ...NoList }),
  /** Another mise error, for example `mise.toml` syntax, or a timeout; the message comes from mise. */
  z.object({ kind: z.literal("error"), ...NoList }),
]);
export type MiseTasks = z.infer<typeof MiseTasks>;

/**
 * A running (or stopping) mise task of this daemon run, which the dashboard shows by its repo without asking mise.
 * `task` is the task whose worktree it runs in (ADR-59), `null` in the repo root.
 */
export const RunningMiseTask = z.object({ repo: RepoId, task: TaskId.nullable(), miseTask: MiseTaskName, run: RunState });
export type RunningMiseTask = z.infer<typeof RunningMiseTask>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/mise/${action}`, request, data };
}

/** `task`: a mise task in that task's worktree (ADR-59); the repo root without it. */
const MiseTaskRequest = z.object({ repo: RepoId, task: TaskId.nullable().default(null), miseTask: MiseTaskName }).strict();

export const miseApi = {
  tasks: endpoint("tasks", z.object({ repo: RepoId }).strict(), MiseTasks),
  /** Running mise tasks of all repos, without running mise: cheap to poll often (dashboard, ADR-33). */
  running: endpoint("running", z.object({}).strict(), z.array(RunningMiseTask)),
  /**
   * Starts a mise task in a process group (`mise run <task>` in the repo root, or in the worktree of `task`, ADR-59);
   * a task already running returns its state.
   */
  start: endpoint("start", MiseTaskRequest, RunState),
  /** Returns after confirming that no process of the group is alive; a mise task that already ended returns its state. */
  stop: endpoint("stop", MiseTaskRequest, RunState),
  /** `mise trust` in the repo root: the user's consent to the repo's mise config. Only from the UI, never from MCP (§8). */
  trust: endpoint("trust", z.object({ repo: RepoId }).strict(), MiseTasks),
};
