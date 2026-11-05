import { z } from "zod";
import { TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { RunState } from "./procs.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `mise` module (§4, ADR-20): mise tasks of the workspace repos and their runs. Every action is
 * `POST /api/mise/<action>`. The client names a mise task from the list; the daemon builds the command (§1.2).
 */

/**
 * A mise config file name: `mise.toml`, `.mise.toml`, `mise.local.toml`, `mise.dev.toml`, `.mise.dev.local.toml`…, without
 * regard to case, as mise finds them on the case-insensitive file systems of Windows and macOS.
 */
export const MISE_CONFIG_NAME = /^\.?mise(\.[^/\\]+)?\.toml$/i;

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

/**
 * Where a mise task runs: the repo root (`task: null`) or the worktree of a task of that repo (ADR-59); a service runs
 * as its mise task `dev` in the same places (ADR-61).
 */
export const MiseTarget = z.object({ repo: RepoId, task: TaskId.nullable() });
export type MiseTarget = z.infer<typeof MiseTarget>;

/** One key per target: a task's prefix differs from a repo's, so no repo id gives the key of a task's worktree. */
export function miseTargetKey({ repo, task }: MiseTarget): string {
  return task === null ? `repo:${repo}` : `task:${task}:${repo}`;
}

/**
 * Where a mise task is defined (ADR-110): `repo` in a file the repo's git tracks, `local` in a file of the repo git does
 * not track (`mise.local.toml`, a `mise.toml` kept out of git, a file mise task nobody committed), `outside` in a mise
 * config outside the repo (the user's global config, a parent folder's), `convention` in the convention tasks file Trackwall
 * wrote into the projects folder (ADR-157).
 */
export const MiseTaskOrigin = z.enum(["repo", "local", "outside", "convention"]);
export type MiseTaskOrigin = z.infer<typeof MiseTaskOrigin>;

export const MiseTask = z.object({
  name: MiseTaskName,
  description: z.string(),
  /**
   * The file that defines the mise task, as mise reports it: relative to the repo root with `/` when it is in the repo,
   * otherwise its full path; `null` when unknown (a mise task that left the config while it ran, a mise that does not say).
   */
  source: z.string().nullable(),
  /** Where `source` is; `null` when it is unknown. */
  origin: MiseTaskOrigin.nullable(),
  /**
   * The mise task's usage spec (its `usage` field or `#USAGE` lines) as mise gives it, which declares the arguments a run
   * may pass (ADR-158); `null` when the mise task declares none, and then a run takes no arguments.
   */
  usage: z.string().nullable(),
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

/**
 * One argument of a mise task run (ADR-158), such as a test filter: `mise run <task> <argument>…`, for a mise task that
 * declares its arguments in a usage spec. The characters are those of class, method, file and module names and test
 * patterns, and nothing a shell or `cmd.exe` treats specially (no space, quote, `$`, `%`, `&`, `|`, `;`, `<`, `>`, `^`,
 * `!`, parentheses or backslash), so a value a task's script quotes stays one word. Unquoted it does not: `sh` expands a `*`
 * to file names and `cmd.exe` splits a batch file's arguments at `,` and `=`, which a script that uses the value unquoted
 * takes on itself; the convention tasks quote it (ADR-157).
 * No leading `-`, so mise never takes it for an option, and no `:`, so never for its `:::` task separator.
 */
export const MiseRunArgument = z
  .string()
  .regex(
    /^[A-Za-z0-9_.,/=#*@+][A-Za-z0-9_.,/=#*@+-]{0,199}$/,
    "a mise task argument is 1 to 200 letters, digits or _ . , / = # * @ + -, and does not start with -",
  );

/** At most 8 arguments of one run (ADR-158). */
export const MiseRunArguments = z.array(MiseRunArgument).max(8);
export type MiseRunArguments = z.infer<typeof MiseRunArguments>;

/** The build files the convention tasks look for in a repo root, in the order they try them (ADR-157, ADR-208). */
export const CONVENTION_BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts", "package.json"] as const;

/**
 * The convention tasks file (ADR-157): mise tasks `setup`, `build` and `test` for Maven, Gradle and npm projects that
 * Trackwall writes into the projects folder, where mise reads it for every repo below; a repo's own mise task of the same
 * name wins. `absent`: no file; `current`: the file is the one this Trackwall writes; `changed`: the file differs (the
 * user edited it, or an older Trackwall wrote it), and Trackwall leaves it as it is.
 */
export const ConventionTasksState = z.object({
  state: z.enum(["absent", "current", "changed"]),
  /** The file's full path. */
  path: z.string(),
});
export type ConventionTasksState = z.infer<typeof ConventionTasksState>;

/**
 * What mise says about a repo root's own config files beyond listing their tasks (`mise fmt --check` and `mise tasks
 * validate`): the files its formatter would change, and the problems it finds in them, errors first. An older mise without
 * one of these commands has nothing to say about it, so an empty check does not prove a config clean.
 */
export const MiseConfigProblem = z.object({
  severity: z.enum(["error", "warning"]),
  /** One line from mise: `test: Dependency 'nope' not found`, `mise.toml:4:2: unknown field taskz (did you mean tasks?)`. */
  message: z.string(),
});
export type MiseConfigProblem = z.infer<typeof MiseConfigProblem>;

export const MiseConfigCheck = z.object({
  /** Config files in the repo root that `mise fmt` would rewrite, relative to it (`mise.toml`, `.config/mise.toml`). */
  unformatted: z.array(z.string()),
  problems: z.array(MiseConfigProblem),
});
export type MiseConfigCheck = z.infer<typeof MiseConfigCheck>;

const endpoint = apiEndpoints("mise");

/** `task`: a mise task in that task's worktree (ADR-59); the repo root without it. */
const MiseTaskRequest = z.object({ repo: RepoId, task: TaskId.nullable().default(null), miseTask: MiseTaskName }).strict();

export const miseApi = {
  tasks: endpoint("tasks", z.object({ repo: RepoId }).strict(), MiseTasks),
  /** Running mise tasks of all repos, without running mise: cheap to poll often (dashboard, ADR-33). */
  running: endpoint("running", z.object({}).strict(), z.array(RunningMiseTask)),
  /**
   * Starts a mise task in a process group (`mise run <task>` in the repo root, or in the worktree of `task`, ADR-59);
   * a task already running returns its state. `arguments` go after the mise task's name, only for a mise task with a
   * usage spec (ADR-158).
   */
  start: endpoint("start", MiseTaskRequest.extend({ arguments: MiseRunArguments.default([]) }).strict(), RunState),
  /** Returns after confirming that no process of the group is alive; a mise task that already ended returns its state. */
  stop: endpoint("stop", MiseTaskRequest, RunState),
  /** `mise trust` in the repo root: the user's consent to the repo's mise config. Only from the UI, never from MCP (§8). */
  trust: endpoint("trust", z.object({ repo: RepoId }).strict(), MiseTasks),
  /** The state of the convention tasks file in the projects folder (ADR-157). */
  conventionTasks: endpoint("convention-tasks", z.object({}).strict(), ConventionTasksState),
  /**
   * Writes the convention tasks file when it is absent and trusts it (`mise trust <file>`): the user's consent. Only from
   * the UI, never from MCP. A file that is already there is left as it is (`bad_request` when it differs).
   */
  writeConventionTasks: endpoint("write-convention-tasks", z.object({}).strict(), ConventionTasksState),
  /**
   * `mise fmt` in the repo root: rewrites its mise config files in mise's own format, which leaves a change for git to see,
   * and returns the check after it. The user's click is the consent; only from the UI, never from MCP.
   */
  format: endpoint("format", z.object({ repo: RepoId }).strict(), MiseConfigCheck),
};
