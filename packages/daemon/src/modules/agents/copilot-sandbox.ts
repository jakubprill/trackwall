import { readFileSync } from "node:fs";
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

/** A program of the sandbox as the sessions would find it: in their `PATH`, else in a system folder; `undefined` without it. */
function sandboxProgram(program: string, env: NodeJS.ProcessEnv, systemFolders: readonly string[]): string | undefined {
  return findOnPath(program, env) ?? systemFolders.map((dir) => join(dir, program)).find(isFile);
}

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
  const missing = LINUX_SANDBOX_PROGRAMS.filter(({ program }) => sandboxProgram(program, env, systemFolders) === undefined).map(
    ({ name }) => name,
  );
  if (missing.length === 0) return null;
  return `${missing.join(", ")}, which Copilot CLI's sandbox runs on, ${missing.length === 1 ? "is" : "are"} not in PATH`;
}

/**
 * What bubblewrap runs to see whether it can make the sandbox's namespaces here (ADR-219): a command in every namespace
 * with a /proc of its own, which Docker's default seccomp profile refuses in a container, and Ubuntu's AppArmor limit
 * on unprivileged namespaces on some computers. It does not try the sandbox's network (slirp4netns), which fails later,
 * when a command runs. Copilot CLI's own start check tries none of this, so without it a task started and then had every
 * command refused.
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

/**
 * Why bubblewrap at `bwrap` cannot make the sandbox's namespaces, from the last line it printed; `null` when it can.
 * Runs only on Linux, and only once the programs of `LINUX_SANDBOX_PROGRAMS` are there.
 */
export async function namespacesProblem(bwrap: string, env: NodeJS.ProcessEnv, run: Run = runProgram): Promise<string | null> {
  try {
    await run(bwrap, NAMESPACE_PROBE_ARGS, { label: "bwrap", env, timeoutMs: NAMESPACE_PROBE_TIMEOUT_MS });
    return null;
  } catch (err) {
    const reason = messageOf(err).trim().split("\n").at(-1) || "bwrap exited with an error";
    return `bubblewrap cannot make the sandbox's namespaces here (${reason})`;
  }
}

/**
 * `namespacesProblem` that keeps a bubblewrap's success for the daemon's run, since it holds until the container or
 * the computer changes, which restarts the daemon; a failure is tried again at the next question, so one slow probe
 * does not refuse tasks until a restart.
 */
export function keptNamespaceProbes(probe: typeof namespacesProblem = namespacesProblem): SandboxHost["namespaces"] {
  const working = new Set<string>();
  return async (bwrap, env) => {
    if (working.has(bwrap)) return null;
    const problem = await probe(bwrap, env);
    if (problem === null) working.add(bwrap);
    return problem;
  };
}

/** What the kernel says of the daemon's own process: its user, and whether it and its children can gain privileges. */
export interface ProcessPrivileges {
  uid: number;
  /** `NoNewPrivs` in `/proc/self/status`: no program it starts gains privileges, so `sudo` and setuid programs fail. */
  noNewPrivileges: boolean;
}

/** `ProcessPrivileges` of this process from `/proc/self/status` on Linux. */
export function ownPrivileges(status: string = readFileSync(join("/proc", "self", "status"), "utf8")): ProcessPrivileges {
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  if (uid === undefined) throw new Error("no Uid line in /proc/self/status");
  return { uid: Number(uid), noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status) };
}

/**
 * Why a container where bubblewrap can make its namespaces is not safe for the sandbox (ADR-219): there it runs with
 * `systempaths=unconfined`, so `/proc/sys` is writable, and a process that is or becomes root in the container (`sudo`
 * of the dev container's user) could write `/proc/sys/kernel/core_pattern` and run a program as root on Docker's
 * virtual machine, outside the container. `no-new-privileges` keeps everything in the container from becoming root.
 */
export function containerPrivilegesProblem(privileges: ProcessPrivileges): string | null {
  if (privileges.uid === 0)
    return "Trackwall runs as root in this container, which could leave it through the /proc/sys the sandbox's setup opens";
  if (!privileges.noNewPrivileges)
    return "this container lets its processes become root (sudo), which could leave it through the /proc/sys the sandbox's setup opens; start it with --security-opt no-new-privileges";
  return null;
}

/** Where the daemon runs, for the sandbox's default and whether it can run (ADR-181, ADR-219). */
export interface SandboxHost {
  /** The daemon runs in a container (`FacadeOptions.inContainer`). */
  inContainer: boolean;
  platform: NodeJS.Platform;
  /** `SYSTEM_PROGRAM_FOLDERS` in the daemon. */
  systemFolders: readonly string[];
  /** `namespacesProblem` for the bubblewrap at a path (`keptNamespaceProbes` in the daemon). */
  namespaces: (bwrap: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** `ownPrivileges` in the daemon, read only in a container. */
  privileges: () => ProcessPrivileges;
}

/** The sandbox's host as the daemon is: this system, its folders, the kept probes and this process. */
export function daemonSandboxHost(inContainer: boolean): SandboxHost {
  return {
    inContainer,
    platform: process.platform,
    systemFolders: SYSTEM_PROGRAM_FOLDERS,
    namespaces: keptNamespaceProbes(),
    privileges: () => ownPrivileges(),
  };
}

/**
 * Which tasks run in the sandbox without `sandbox` in `workspace.yaml`: on a Linux computer those without approvals;
 * in a Linux container the same once the sandbox can run there safely (`canRun`, the dev container guide, ADR-219),
 * otherwise none, since the container is the isolation there; on macOS and Windows none until someone checks it on a
 * real machine: on macOS git in Seatbelt cannot read `~/.gitconfig` and the terminal stops at Copilot CLI's question
 * about its certificate authority; on Windows the sandbox needs a Windows with BaseContainer.
 */
export function defaultSandboxTasks(inContainer: boolean, platform: NodeJS.Platform, canRun: boolean): SandboxSettings["tasks"] {
  if (platform !== "linux") return "off";
  return !inContainer || canRun ? "auto" : "off";
}

/** Why the sandbox cannot run here: its programs, then on Linux its namespaces, then in a container its privileges. */
async function hostProblem(env: NodeJS.ProcessEnv, host: SandboxHost): Promise<string | null> {
  const programs = sandboxProblem(env, host.platform, host.systemFolders);
  if (programs !== null || host.platform !== "linux") return programs;
  const bwrap = sandboxProgram("bwrap", env, host.systemFolders);
  if (bwrap === undefined) throw new Error("bwrap passed the check of the sandbox's programs but is not there");
  const namespaces = await host.namespaces(bwrap, env);
  if (namespaces !== null || !host.inContainer) return namespaces;
  return containerPrivilegesProblem(host.privileges());
}

/**
 * The sandbox as a new task gets it: which tasks `settings` (`null` without the key) put in it, and why it cannot run
 * here, also when no task runs in it by default, so that the doctor can say what a container lacks. With the user's own
 * `off` nothing is checked.
 */
export async function sandboxState(settings: SandboxSettings | null, env: NodeJS.ProcessEnv, host: SandboxHost): Promise<SandboxState> {
  if (settings?.tasks === "off") return { tasks: "off", problem: null, chosen: true };
  const problem = await hostProblem(env, host);
  if (settings !== null) return { tasks: settings.tasks, problem, chosen: true };
  return { tasks: defaultSandboxTasks(host.inContainer, host.platform, problem === null), problem, chosen: false };
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
      `this task should run in Copilot CLI's sandbox (sandbox.tasks: ${state.tasks} in workspace.yaml), but ${state.problem}; install it, or choose "No task" in Settings › Agents › Sandbox`,
    );
  return true;
}
