import { join } from "node:path";
import { type SandboxSettings, type SandboxState, sandboxesTask, type TaskApprovals } from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { type RunOptions, type RunOutput, runProgram } from "../../infra/run-program.ts";
import { findOnPath, isFile } from "./copilot-command.ts";

/**
 * Copilot CLI's sandbox for tasks (ADR-181, §4.4): with `--sandbox` Copilot CLI runs each shell command under the
 * system's isolation (Seatbelt on macOS, bubblewrap on Linux, a ProcessContainer on Windows), writing only in the
 * working directory, the repo's git directory and the temporary folder. On a computer that cannot run it every command
 * fails, so a task that should be in it is refused before its worktree exists instead of starting without it.
 */

/** The one argument that puts a session in the sandbox. */
export const SANDBOX_ARG = "--sandbox";

/** What macOS runs the sandbox with; always at this path when the system has it. */
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * What Copilot CLI's sandbox runs on Linux, by program and the package that has it: bubblewrap isolates the command,
 * slirp4netns, `ip` and `iptables` give it its own network. Without any of them every command is refused.
 */
export const LINUX_SANDBOX_PROGRAMS = [
  { program: "bwrap", name: "bubblewrap (bwrap)" },
  { program: "slirp4netns", name: "slirp4netns" },
  { program: "ip", name: "ip (iproute2)" },
  { program: "iptables", name: "iptables" },
] as const;

/** Where `ip` and `iptables` live on distributions that leave these folders out of a user's `PATH`. */
const SYSTEM_PROGRAM_FOLDERS = [join("/usr", "sbin"), join("/", "sbin")];

/**
 * Why the sandbox cannot run here, or `null` when it can as far as Copilot CLI's own start check goes: `sandbox-exec`
 * on macOS, the programs of `LINUX_SANDBOX_PROGRAMS` on Linux. Windows decides by its version, which only Copilot CLI
 * checks, and the namespaces bubblewrap needs only show when a command runs; then the command fails and says what is
 * missing.
 */
export function sandboxProblem(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  systemFolders: readonly string[] = SYSTEM_PROGRAM_FOLDERS,
): string | null {
  if (platform === "win32") return null;
  if (platform === "darwin")
    return isFile(MACOS_SANDBOX_EXEC) ? null : `${MACOS_SANDBOX_EXEC}, which Copilot CLI's sandbox runs on, is not there`;
  if (platform !== "linux") return `Copilot CLI's sandbox does not run on ${platform}`;
  const missing = LINUX_SANDBOX_PROGRAMS.filter(
    ({ program }) => findOnPath(program, env) === undefined && !systemFolders.some((dir) => isFile(join(dir, program))),
  ).map(({ name }) => name);
  if (missing.length === 0) return null;
  return `${missing.join(", ")}, which Copilot CLI's sandbox runs on, ${missing.length === 1 ? "is" : "are"} not in PATH`;
}

/**
 * What bubblewrap runs to see whether it can make the sandbox's namespaces here (ADR-219): every namespace with a /proc
 * of its own, as Copilot CLI's sandbox does. Docker's default seccomp profile refuses them in a container, and Ubuntu's
 * AppArmor limit on unprivileged namespaces on some computers; Copilot CLI's own start check does not try them, so
 * without this a task started and then had every command refused.
 */
export const NAMESPACE_PROBE_ARGS = [
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--unshare-all",
  "--die-with-parent",
  "true",
] as const;

/** How long the probe may take; it starts one process in new namespaces, which takes milliseconds. */
const NAMESPACE_PROBE_TIMEOUT_MS = 10_000;

type Run = (command: string, args: readonly string[], opts: RunOptions) => Promise<RunOutput>;

/** The bubblewrap the sessions would run, from their `PATH` or the system folders; `undefined` without one. */
function bubblewrap(env: NodeJS.ProcessEnv, systemFolders: readonly string[]): string | undefined {
  return findOnPath("bwrap", env) ?? systemFolders.map((dir) => join(dir, "bwrap")).find(isFile);
}

/**
 * Why bubblewrap at `bwrap` cannot make the sandbox's namespaces, from the end of what it printed; `null` when it can.
 * Runs only on Linux, and only once the programs of `LINUX_SANDBOX_PROGRAMS` are there.
 */
export async function namespacesProblem(bwrap: string, env: NodeJS.ProcessEnv, run: Run = runProgram): Promise<string | null> {
  try {
    await run(bwrap, NAMESPACE_PROBE_ARGS, { label: "bwrap", env, timeoutMs: NAMESPACE_PROBE_TIMEOUT_MS });
    return null;
  } catch (err) {
    const reason = messageOf(err).trim().split("\n").at(-1) ?? "";
    return `bubblewrap cannot make the sandbox's namespaces here (${reason})`;
  }
}

/** Where the daemon runs, for the sandbox's default and its namespaces (ADR-181, ADR-219). */
export interface SandboxHost {
  /** The daemon runs in a container (`FacadeOptions.inContainer`). */
  inContainer: boolean;
  /** `namespacesProblem` for the bubblewrap at a path, which the caller may keep for the daemon's run. */
  namespaces: (bwrap: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  platform?: NodeJS.Platform;
  systemFolders?: readonly string[];
}

/**
 * Which tasks run in the sandbox without `sandbox` in `workspace.yaml`: on a Linux computer those without approvals;
 * in a Linux container the same once the sandbox can run there (`canRun`, the seccomp profile of the dev container
 * guide, ADR-219), otherwise none, since the container is the isolation there; on macOS and Windows none until someone
 * checks it on a real machine: on macOS git in Seatbelt cannot read `~/.gitconfig` and the terminal stops at Copilot
 * CLI's question about its certificate authority; on Windows the sandbox needs a Windows with BaseContainer.
 */
export function defaultSandboxTasks(inContainer: boolean, platform: NodeJS.Platform, canRun: boolean): SandboxSettings["tasks"] {
  if (platform !== "linux") return "off";
  return !inContainer || canRun ? "auto" : "off";
}

/**
 * The sandbox as a new task gets it: which tasks `settings` (`null` without the key) put in it, and why it cannot run
 * here, also when no task runs in it, so that the doctor can say what a container lacks.
 */
export async function sandboxState(settings: SandboxSettings | null, env: NodeJS.ProcessEnv, host: SandboxHost): Promise<SandboxState> {
  const platform = host.platform ?? process.platform;
  const systemFolders = host.systemFolders ?? SYSTEM_PROGRAM_FOLDERS;
  const programs = sandboxProblem(env, platform, systemFolders);
  const bwrap = platform === "linux" && programs === null ? bubblewrap(env, systemFolders) : undefined;
  const problem = programs ?? (bwrap === undefined ? null : await host.namespaces(bwrap, env));
  if (settings !== null) return { tasks: settings.tasks, problem, chosen: true };
  return { tasks: defaultSandboxTasks(host.inContainer, platform, problem === null), problem, chosen: false };
}

/**
 * Whether a new task with approvals mode `approvals` runs in the sandbox; `bad_request` when it should and the sandbox
 * cannot run here, before its worktree exists, so that no such task runs without it.
 */
export function taskSandbox(state: SandboxState, approvals: TaskApprovals): boolean {
  if (!sandboxesTask(state.tasks, approvals)) return false;
  if (state.problem !== null)
    throw new DomainError(
      "bad_request",
      `this task should run in Copilot CLI's sandbox (sandbox.tasks: ${state.tasks} in workspace.yaml), but ${state.problem}; install it, or set sandbox.tasks to off`,
    );
  return true;
}
