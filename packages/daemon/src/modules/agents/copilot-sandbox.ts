import { join } from "node:path";
import { type SandboxSettings, type SandboxState, sandboxesTask, type TaskApprovals } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
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

/** The sandbox as a new task gets it: which tasks the settings put in it, and why it cannot run here. */
export function sandboxState(settings: SandboxSettings, env: NodeJS.ProcessEnv): SandboxState {
  return { tasks: settings.tasks, problem: settings.tasks === "off" ? null : sandboxProblem(env) };
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
