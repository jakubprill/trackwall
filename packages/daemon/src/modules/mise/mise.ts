import { delimiter } from "node:path";
import {
  type LogSource,
  type MiseTask,
  MiseTaskName,
  type MiseTasks,
  miseTaskLogSource,
  type RunningMiseTask,
  type RunState,
  TASK_PORT_ENV,
} from "@trackwall/protocol";
import { z } from "zod";
import { envKey } from "../../infra/env-key.ts";
import { DomainError, SpawnFailure } from "../../infra/errors.ts";
import { type MiseCliResult, runMiseCli } from "./mise-cli.ts";

/**
 * The `mise` module (§4, ADR-20): the mise tasks of workspace repos and their runs. The list comes from `mise tasks ls --json`
 * on every query, so a change to `mise.toml` shows at once. A run is `mise run <task>` in the repo root,
 * in a process group of the `procs` module; the daemon runs only a mise task that is on the current list (§1.2). For the batch
 * command (ADR-27) also `mise install` and runs awaited to the end. A task's mise tasks run in its worktree
 * (ADR-59) only while the repo root's config is trusted and the worktree has the mise config the user trusted; mise
 * gets the worktree as a trusted path for that one run, never through `mise trust`, which would trust the path for good.
 * A run in a task worktree also gets the task port in `TASK_PORT_ENV` (ADR-61), so a server it starts does not take the
 * port of the same server running from the repo root or another task.
 */

/** What `mise` needs from `procs`; wired in the facade. */
interface MiseProcs {
  start(spec: { owner: string; command: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; logSource: LogSource }): Promise<RunState>;
  state(owner: string): RunState | undefined;
  ended(owner: string): Promise<RunState | undefined>;
  stop(owner: string): Promise<RunState | undefined>;
}

/** What `mise` needs from `workspace`: the repo root by identifier (`not_found` when there is no such repo). */
interface MiseRepos {
  repoPath(id: string): Promise<string>;
}

/**
 * What `mise` needs from `agents`: the worktree of a task of the repo, refused while its mise config is not the one the
 * user trusted (ADR-59), and the task port (ADR-61).
 */
interface MiseTaskWorktrees {
  trustedTaskWorktree(task: string, repo: string): Promise<{ worktree: string; port: number }>;
}

export interface MiseDeps {
  procs: MiseProcs;
  repos: MiseRepos;
  tasks: MiseTaskWorktrees;
  /** The `mise` program with any arguments before the command; `["mise"]` in the daemon, a fake in tests. */
  command: readonly string[];
  /** The environment of the user's processes (`PATH` from the login shell on macOS). */
  env: () => Promise<NodeJS.ProcessEnv>;
}

/** The `mise tasks ls --json` fields we use; the rest (dependencies, sources, `run`) stays in mise. */
const ListedTask = z.object({ name: z.string(), description: z.string().nullish(), hide: z.boolean().optional() });
const ListedTasks = z.array(ListedTask);

/** A mise task from `mise tasks ls`, still without a run state. */
type ListedMiseTask = Omit<MiseTask, "run">;
type TaskList = { kind: Exclude<MiseTasks["kind"], "ok">; message: string } | { kind: "ok"; tasks: ListedMiseTask[] };

/** A fragment of mise's message about an untrusted config (`Config files in … are not trusted`). */
const UNTRUSTED = /not trusted/i;
/** mise setting with directories whose configs it trusts, separated like `PATH` (`list_by_os_path_separator`). */
const TRUSTED_PATHS_ENV = "MISE_TRUSTED_CONFIG_PATHS";

/** Where a mise task runs: the repo root (`task: null`) or the worktree of a task of that repo (ADR-59). */
export interface MiseTarget {
  repo: string;
  task: string | null;
}

/** The directory and environment of a run. */
interface RunPlace {
  dir: string;
  env: NodeJS.ProcessEnv;
}

export class Mise {
  private readonly deps: MiseDeps;
  /**
   * mise tasks started in this daemon run, per target (`targetKey`): the list shows them even after they left the
   * config, and `running` reports them without asking mise.
   */
  private readonly started = new Map<string, MiseTarget & { names: Set<string> }>();

  constructor(deps: MiseDeps) {
    this.deps = deps;
  }

  /** The mise tasks of a repo root with their runs there. */
  async tasks(repo: string): Promise<MiseTasks> {
    const root: MiseTarget = { repo, task: null };
    const dir = await this.deps.repos.repoPath(repo);
    const listed = await this.list(dir, await this.deps.env());
    if (listed.kind !== "ok") return { ...listed, running: this.liveOutside(root, []) };
    const tasks: MiseTask[] = listed.tasks.map((t) => ({ ...t, run: this.deps.procs.state(owner(root, t.name)) ?? null }));
    return { kind: "ok", tasks: [...tasks, ...this.liveOutside(root, tasks)] };
  }

  /** Running mise tasks of all repo roots and task worktrees started in this daemon run; state from `procs`, without asking mise. */
  running(): RunningMiseTask[] {
    return [...this.started.values()].flatMap((target) =>
      this.liveRuns(target).map(({ name, run }) => ({ repo: target.repo, task: target.task, miseTask: name, run })),
    );
  }

  /**
   * Running mise tasks of the repo that are not on the list: removed from the config while running, or shown when mise did not
   * give a list. Without this they could not be stopped from the UI.
   */
  private liveOutside(target: MiseTarget, listed: readonly ListedMiseTask[]): MiseTask[] {
    return this.liveRuns(target)
      .filter(({ name }) => !listed.some((t) => t.name === name))
      .map(({ name, run }) => ({ name, description: "", run }));
  }

  /** mise tasks the daemon started in `target` whose group has not ended yet (also while stopping). */
  private liveRuns(target: MiseTarget): { name: string; run: RunState }[] {
    return [...(this.started.get(targetKey(target))?.names ?? [])].flatMap((name) => {
      const run = this.deps.procs.state(owner(target, name));
      return run && run.kind !== "exited" ? [{ name, run }] : [];
    });
  }

  async start(target: MiseTarget, miseTask: string): Promise<RunState> {
    const place = await this.place(target);
    if (!(await this.hasTask(place, miseTask))) throw new DomainError("not_found", `${where(target)} has no mise task "${miseTask}"`);
    const run = await this.launch(
      owner(target, miseTask),
      place,
      ["run", miseTask],
      target.repo,
      miseTaskLogSource(target.repo, target.task, miseTask),
    );
    this.remember(target, miseTask);
    return run;
  }

  /**
   * The batch command (§4.8): a mise task from the current list started and awaited to the confirmed end of the group; `null`
   * when the repo has no such mise task. A mise task that is already running (e.g. from the repo details) does not start
   * a second time: the result is its end. `signal` stops the group like a stop from the repo details.
   */
  async runToEnd(repo: string, miseTask: string, signal: AbortSignal): Promise<RunState | null> {
    const root: MiseTarget = { repo, task: null };
    const place = await this.place(root);
    if (!(await this.hasTask(place, miseTask))) return null;
    this.remember(root, miseTask);
    return this.runGroupToEnd(owner(root, miseTask), place, ["run", miseTask], repo, miseTaskLogSource(repo, null, miseTask), signal);
  }

  /**
   * `mise install` in the repo root, awaited to the end: tools (JDK, Node…) in the versions from the repo's mise config.
   * In a process group like a mise task, because installing takes minutes and cancelling the batch command must stop it.
   */
  async installTools(repo: string, signal: AbortSignal): Promise<RunState> {
    const place = await this.place({ repo, task: null });
    return this.runGroupToEnd(installOwner(repo), place, ["install"], repo, { kind: "mise-install", repo }, signal);
  }

  /**
   * The task's current run once the system has confirmed its end, or after `timeoutMs` (then still `running` or
   * `stopping`), for an agent waiting for the result (`wait_for_mise_task`, ADR-41). `signal` (the client cancelled
   * the call) ends the wait but does not stop the task.
   */
  async waitForEnd(target: MiseTarget, miseTask: string, timeoutMs: number, signal: AbortSignal): Promise<RunState> {
    const groupOwner = owner(target, miseTask);
    // `ended` first waits for a start in progress (e.g. the Run button clicked at the same moment), so the wait sees
    // the new run instead of the previous one or none; an ended group resolves at once, an absent one as `undefined`.
    const giveUp = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let stopWaiting = () => {};
    const gaveUp = new Promise<"gave_up">((resolve) => {
      stopWaiting = () => resolve("gave_up");
    });
    giveUp.addEventListener("abort", stopWaiting, { once: true });
    if (giveUp.aborted) stopWaiting();
    try {
      const end = await Promise.race([this.deps.procs.ended(groupOwner), gaveUp]);
      const run = end === "gave_up" ? this.deps.procs.state(groupOwner) : end;
      if (!run) throw await this.notRun(target, miseTask);
      return run;
    } finally {
      giveUp.removeEventListener("abort", stopWaiting);
    }
  }

  /** The current (or last) run of a task in this daemon run, from `procs` without asking mise; `undefined` when it has not run. */
  run(target: MiseTarget, miseTask: string): RunState | undefined {
    return this.deps.procs.state(owner(target, miseTask));
  }

  async stop(target: MiseTarget, miseTask: string): Promise<RunState> {
    const stopped = await this.deps.procs.stop(owner(target, miseTask));
    if (!stopped) throw await this.notRun(target, miseTask);
    return stopped;
  }

  /**
   * `not_found` for a task without a run: about the repo when it is not in the projects folder (a typo in the id),
   * otherwise about the task. Checked only after the run lookup, so a task of a repo that was renamed or removed
   * while it ran can still be stopped and waited for.
   */
  private async notRun(target: MiseTarget, miseTask: string): Promise<DomainError> {
    await this.deps.repos.repoPath(target.repo);
    const place = target.task === null ? target.repo : where(target);
    return new DomainError("not_found", `mise task "${miseTask}" in ${place} has not been run`);
  }

  /** `mise trust` without a path trusts the config in the repo root, not in parent directories. */
  async trust(repo: string): Promise<MiseTasks> {
    // The repo root only: a task worktree is trusted by its mise config instead (ADR-59, `agents`).
    const dir = await this.deps.repos.repoPath(repo);
    const result = await runMiseCli(this.deps.command, ["trust"], dir, await this.deps.env());
    if (result.kind !== "exited") throw new DomainError("mise_unavailable", result.message);
    if (result.code !== 0) throw new DomainError("mise_unavailable", failure(result.stderr, result.code));
    return this.tasks(repo);
  }

  /**
   * Where a run of `target` happens. A task worktree (ADR-59) needs the repo root's config trusted, since the user
   * trusted the worktree's first config by trusting the root's, and the worktree's mise config as the user trusted it;
   * then mise gets the worktree as a trusted path in this run's environment only, and the task port (ADR-61). The
   * worktree is checked last, as close to the run as the listing of its tasks allows (§8).
   */
  private async place(target: MiseTarget): Promise<RunPlace> {
    const root = await this.deps.repos.repoPath(target.repo);
    const env = await this.deps.env();
    if (target.task === null) return { dir: root, env };
    const listed = await this.list(root, env);
    if (listed.kind !== "ok") throw new DomainError("mise_unavailable", `${target.repo}: ${listed.message}`);
    const { worktree, port } = await this.deps.tasks.trustedTaskWorktree(target.task, target.repo);
    return { dir: worktree, env: withTaskPort(trustingPath(env, worktree), port) };
  }

  private async hasTask(place: RunPlace, miseTask: string): Promise<boolean> {
    const listed = await this.list(place.dir, place.env);
    if (listed.kind !== "ok") throw new DomainError("mise_unavailable", listed.message);
    return listed.tasks.some((t) => t.name === miseTask);
  }

  /** A mise task started in this daemon run: the list shows it so it can be stopped, even when it vanishes from the config. */
  private remember(target: MiseTarget, miseTask: string): void {
    const key = targetKey(target);
    const started = this.started.get(key) ?? { ...target, names: new Set<string>() };
    started.names.add(miseTask);
    this.started.set(key, started);
  }

  private async launch(
    groupOwner: string,
    place: RunPlace,
    args: readonly string[],
    repo: string,
    logSource: LogSource,
  ): Promise<RunState> {
    try {
      return await this.deps.procs.start({
        owner: groupOwner,
        command: [...this.deps.command, ...args],
        cwd: place.dir,
        env: place.env,
        logSource,
      });
    } catch (err) {
      if (!(err instanceof SpawnFailure)) throw err;
      throw new DomainError(err.reason === "cwd_invalid" ? "repo_unavailable" : "mise_unavailable", `${repo}: ${err.message}`);
    }
  }

  /**
   * Start (or joining this owner's running group) and the end of the group once the system confirms it.
   * `signal` stops the group; when the group survives the kill, the result is `stop_unconfirmed`, not endless
   * waiting, so cancelling always ends the wait. The group then stays `stopping` in the repo details, where the stop can be retried.
   */
  private async runGroupToEnd(
    groupOwner: string,
    place: RunPlace,
    args: readonly string[],
    repo: string,
    logSource: LogSource,
    signal: AbortSignal,
  ): Promise<RunState> {
    signal.throwIfAborted();
    await this.launch(groupOwner, place, args, repo, logSource);
    let stop = () => {};
    const stopFailed = new Promise<never>((_, reject) => {
      stop = () => void this.deps.procs.stop(groupOwner).catch(reject);
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const end = await Promise.race([this.deps.procs.ended(groupOwner), stopFailed]);
      if (!end) throw new Error(`group ${groupOwner} disappeared before it ended`);
      return end;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  private async list(dir: string, env: NodeJS.ProcessEnv): Promise<TaskList> {
    return parseTaskList(await runMiseCli(this.deps.command, ["tasks", "ls", "--json"], dir, env));
  }
}

/** The result of `mise tasks ls --json` as a list of mise tasks or the reason there is none. */
export function parseTaskList(result: MiseCliResult): TaskList {
  if (result.kind === "not_started") return { kind: "not_installed", message: result.message };
  if (result.kind === "failed") return { kind: "error", message: result.message };
  if (result.code !== 0) {
    const message = failure(result.stderr, result.code);
    return UNTRUSTED.test(message) ? { kind: "untrusted", message } : { kind: "error", message };
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return { kind: "error", message: "mise tasks ls --json returned something that is not JSON" };
  }
  const parsed = ListedTasks.safeParse(json);
  if (!parsed.success) return { kind: "error", message: `unexpected mise tasks ls --json format: ${z.prettifyError(parsed.error)}` };
  const tasks = parsed.data
    .filter((t) => !t.hide && MiseTaskName.safeParse(t.name).success)
    .map((t) => ({ name: t.name, description: t.description ?? "" }));
  return { kind: "ok", tasks };
}

/**
 * The group owner in `procs`, only built, never parsed back. A task's prefix differs from a repo's, so no repo id and
 * mise task name (which may contain `:`) can give the key of a task's run, and the key holds the repo, so a run is
 * found only through the repo its task is in (a session's repo gate, ADR-41).
 */
function owner(target: MiseTarget, miseTask: string): string {
  return target.task === null ? `mise:${target.repo}:${miseTask}` : `task-mise:${target.task}:${target.repo}:${miseTask}`;
}

function targetKey(target: MiseTarget): string {
  return target.task === null ? `repo:${target.repo}` : `task:${target.task}:${target.repo}`;
}

/** The target in a message: the repo, or the task worktree in it. */
function where({ repo, task }: MiseTarget): string {
  return task === null ? `repo ${repo}` : `the worktree of task ${task} in ${repo}`;
}

/** The environment with `dir` added to the paths mise trusts without `mise trust`, after the user's own. */
function trustingPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = envKey(env, TRUSTED_PATHS_ENV);
  const own = env[key];
  return { ...env, [key]: own ? `${own}${delimiter}${dir}` : dir };
}

/** The environment with every `TASK_PORT_ENV` variable set to the task port, replacing the user's own value. */
function withTaskPort(env: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  const ported = { ...env };
  for (const name of TASK_PORT_ENV) ported[envKey(ported, name)] = String(port);
  return ported;
}

/** The owner of a repo's `mise install` group; a different prefix than mise tasks, because a mise task may be called `install`. */
function installOwner(repo: string): string {
  return `mise-install:${repo}`;
}

/** A mise error message without warnings that are not the cause (e.g. a failed check for a new version). */
function failure(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^mise WARN/.test(l));
  return lines.join("\n") || `mise exited with code ${code}`;
}
