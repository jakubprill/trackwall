import { type SandboxSettings, type SandboxState, sandboxesTask, type TaskApprovals } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { findOnPath, isFile } from "./copilot-command.ts";

/**
 * Copilot CLI's sandbox for tasks (ADR-181, §4.4): with `--sandbox` Copilot CLI runs each shell command, and the stdio
 * MCP and language servers it starts, under the system's isolation (Seatbelt on macOS, bubblewrap on Linux, a
 * ProcessContainer on Windows), writing only in the working directory. On a computer that cannot run it every command
 * fails, so a task that should be in it is refused before its worktree exists instead of starting without it.
 */

/** The one argument that puts a session in the sandbox. */
export const SANDBOX_ARG = "--sandbox";

/** What macOS runs the sandbox with; always at this path when the system has it. */
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Why the sandbox cannot run here, or `null` when it can as far as Copilot CLI's own start check goes: `sandbox-exec`
 * on macOS, `bwrap` in the sessions' `PATH` on Linux. Windows decides by its version, which only Copilot CLI checks, and
 * the namespaces bubblewrap needs only show when a command runs; then the command fails and says what is missing.
 */
export function sandboxProblem(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") return null;
  if (platform === "darwin")
    return isFile(MACOS_SANDBOX_EXEC) ? null : `${MACOS_SANDBOX_EXEC}, which Copilot CLI's sandbox runs on, is not there`;
  if (platform === "linux")
    return findOnPath("bwrap", env) === undefined ? "bubblewrap (bwrap), which Copilot CLI's sandbox runs on, is not in PATH" : null;
  return `Copilot CLI's sandbox does not run on ${platform}`;
}

/**
 * Whether a new task with approvals mode `approvals` runs in the sandbox; `bad_request` when it should and the sandbox
 * cannot run here, before its worktree exists, so that no such task runs without it.
 */
export function taskSandbox(
  settings: SandboxSettings,
  approvals: TaskApprovals,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!sandboxesTask(settings.tasks, approvals)) return false;
  const problem = sandboxProblem(env, platform);
  if (problem !== null)
    throw new DomainError(
      "bad_request",
      `this task should run in Copilot CLI's sandbox (sandbox.tasks: ${settings.tasks} in workspace.yaml), but ${problem}; install it, or set sandbox.tasks to off`,
    );
  return true;
}

/** The sandbox as a new task gets it: which tasks the settings put in it, and why it cannot run here. */
export function sandboxState(settings: SandboxSettings, env: NodeJS.ProcessEnv): SandboxState {
  return { tasks: settings.tasks, problem: settings.tasks === "off" ? null : sandboxProblem(env) };
}
