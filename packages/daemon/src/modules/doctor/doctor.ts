import { realpath, stat } from "node:fs/promises";
import {
  countLabel,
  type DoctorCheck,
  DoctorCheckId,
  type DoctorReport,
  HOST_CLI,
  type JavaNavigationState,
  type RepoHost,
  type RepoHostKind,
  type SandboxState,
  TESTED_COPILOT_CLI_VERSION,
  type UnpushedWork,
  unpushedSummary,
  unpushedTotal,
  type WorkspaceKeysRead,
  workspaceKeysSummary,
} from "@trackwall/protocol";
import { trustedFolderOf, trustedFolders } from "./copilot-trust.ts";
import { type DiskSpace, gigabytes, LOW_DISK_BYTES, VERY_LOW_DISK_BYTES } from "./disk-space.ts";
import { folderStorage } from "./folder-storage.ts";
import { modelProviderOutcome, type ProfileEnvironment } from "./model-provider-check.ts";
import { networkOutcome, sessionCertificates } from "./network-check.ts";
import type { TlsProbe } from "./tls-probe.ts";
import { compareVersions, versionIn } from "./version.ts";

/**
 * The doctor (§4.15, ADR-101): checks of what Trackwall needs on this computer, each with what to do when it fails, for the
 * person setting Trackwall up or wondering why a part of it does not work. It only reads and runs `--version` and
 * `auth status` and opens a TLS connection to GitHub and Copilot without sending anything but a proxy's login (ADR-166); it changes nothing, and its report is not kept. A check that throws becomes a failed check, never a
 * failed report.
 */

/** Every program a check runs gets this long: enough for a cold `gh auth status` over a VPN, short enough to wait for. */
const CHECK_TIMEOUT_MS = 15_000;
/** What to do about work that lives only in the container's volume (ADR-162). */
const UNPUSHED_FIX =
  'Push it, or back up the Docker volume with the repos ("Back up the repos" in the dev container guide): removing the volume or resetting Docker deletes it. Home lists the repos.';
/** What to do about a disk that is filling up, anywhere. */
const DISK_FIX =
  "Free some space: remove tasks you no longer need, and clear build caches such as ~/.m2/repository and ~/.gradle/caches, which download again.";
/** And in a container, whose disk is the disk of Docker's virtual machine. */
const CONTAINER_DISK_FIX =
  " The container's disk is the disk of Docker's virtual machine: on your computer, `docker system prune` (without `--volumes`, which would delete the repos) removes old images and containers, and the settings of Docker Desktop or Rancher Desktop can make that disk bigger.";
/** What to do about a repo git could not read in that check. */
const READ_FIX = "Run git status in that repo in a terminal of the container to see why.";
/** A program's error in a summary: its first line, cut. */
const MAX_MESSAGE_CHARS = 200;

export interface DoctorDeps {
  /** The environment sessions and mise tasks start with (`userEnv`). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** Runs a program without a shell; the error says why it failed. */
  run: (command: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;
  /** `git --version` of the git the daemon runs and which program that is (`vcs`). */
  gitVersion: (timeoutMs: number) => Promise<{
    output: string;
    program: string;
    /** `fallback`: the Git program from Settings did not answer, and git from `PATH` runs instead (ADR-112). */
    source: "path" | "chosen" | "fallback";
    chosen: string | null;
  }>;
  /** Resolves when `gh` or `glab` is signed in to the repo host (`vcs`); the error says why not. */
  signedIn: (host: RepoHost, timeoutMs: number) => Promise<void>;
  /** Copilot CLI found as sessions find it (`agents`), so the doctor's answer is the sessions' answer. */
  resolveCopilot: (env: NodeJS.ProcessEnv) => { program: string; args: string[] } | { missing: string; message: string };
  /** The `mise` program with arguments before the command. */
  mise: readonly string[];
  /** `null` while the projects folder is not set; throws when the workspace settings cannot be read. */
  projectsDir: () => Promise<string | null>;
  repoHosts: () => RepoHost[];
  /** The work in the projects folder on no remote, read only in a container (`workspace`, ADR-162). */
  unpushedWork: () => Promise<UnpushedWork>;
  /** Free space of the file system a folder is on (`diskSpace`, a fake in tests). */
  diskSpace: (folder: string) => Promise<DiskSpace>;
  /** The home folder, where build caches such as `~/.m2` live. */
  homeDir: string;
  /** Trackwall runs in a container, whose disk is Docker's (ADR-162). */
  inContainer: boolean;
  /** `/proc/self/mountinfo` on Linux, `null` elsewhere: where the projects folder's files live. */
  mountTable: () => Promise<string | null>;
  /** The full path of `workspace.yaml`. */
  workspaceFile: string;
  /** Each key of `workspace.yaml` (ADR-108); throws when the file as a whole cannot be read. */
  workspaceKeys: () => WorkspaceKeysRead;
  /** Which tasks run in Copilot CLI's sandbox and why it cannot run here (`agents`, ADR-181). */
  sandbox: () => Promise<SandboxState>;
  /** Whether tasks can get Java navigation (`agents`); `null` while `javaNavigation` is not in `workspace.yaml`. */
  javaNavigation: () => JavaNavigationState;
  /** Opens a TLS connection as a session's Node.js would (`probeTls`, a fake in tests); the network check's only way out. */
  probeTls: TlsProbe;
  /** System certificate bundles the network check may name in its fix (`SYSTEM_CA_FILES`). */
  systemCaFiles: readonly string[];
  /**
   * What a session in the projects folder starts with under the session profile (`mise`, ADR-179): the provider's address
   * and the proxy settings, never mise's other secrets; `null` without a profile.
   */
  profileEnvironment: () => Promise<ProfileEnvironment | null>;
  /** Opens and closes a connection as a session's Node.js would reach the host (`probeConnection`, a fake in tests). */
  probeConnection: TlsProbe;
  now: () => Date;
}

type Settled<T> = { ok: true; value: T } | { ok: false; message: string };

interface CheckContext {
  env: NodeJS.ProcessEnv;
  projectsDir: Settled<string | null>;
}

/** A check's result without its id; `null` when the check does not apply here. */
type Outcome = Omit<DoctorCheck, "id"> | null;

export class Doctor {
  private readonly deps: DoctorDeps;
  /** One check per id; the report keeps `DoctorCheckId`'s order. */
  private readonly checks: Record<DoctorCheckId, (ctx: CheckContext) => Promise<Outcome>>;

  constructor(deps: DoctorDeps) {
    this.deps = deps;
    this.checks = {
      "projects-folder": (ctx) => this.projectsFolder(ctx),
      "projects-folder-storage": (ctx) => this.projectsFolderStorage(ctx),
      "disk-space": (ctx) => this.diskSpace(ctx),
      "unpushed-work": (ctx) => this.unpushedWork(ctx),
      "workspace-file": () => this.workspaceFile(),
      git: () => this.git(),
      "copilot-cli": (ctx) => this.copilotCli(ctx),
      "copilot-trusted-folder": (ctx) => this.copilotTrustedFolder(ctx),
      "copilot-sandbox": () => this.copilotSandbox(),
      network: ({ env }) => networkOutcome(env, { probe: this.deps.probeTls, systemCaFiles: this.deps.systemCaFiles }),
      "model-provider": () => this.modelProvider(),
      mise: (ctx) => this.mise(ctx),
      "java-navigation": async () => this.javaNavigation(),
      "github-cli": () => this.hostCli("github"),
      "gitlab-cli": () => this.hostCli("gitlab"),
    };
  }

  private async modelProvider(): Promise<Outcome> {
    const read = await this.deps.profileEnvironment();
    if (read === null) return null;
    const { ca } = await sessionCertificates(read.env, this.deps.systemCaFiles);
    return modelProviderOutcome(read, { probe: this.deps.probeConnection, ca });
  }

  async run(): Promise<DoctorReport> {
    const ctx: CheckContext = { env: await this.deps.env(), projectsDir: await settle(this.deps.projectsDir()) };
    const outcomes = await Promise.all(
      DoctorCheckId.options.map(async (id) => {
        const outcome = await settle(this.checks[id](ctx));
        if (!outcome.ok) return { id, ...fail(outcome.message, "The check could not run; the message says why.") };
        return outcome.value && { id, ...outcome.value };
      }),
    );
    return { checks: outcomes.filter((c) => c !== null), checkedAt: this.deps.now().toISOString() };
  }

  private async projectsFolder({ projectsDir }: CheckContext): Promise<Outcome> {
    if (!projectsDir.ok)
      return fail(`The workspace settings could not be read: ${projectsDir.message}`, 'Correct the file named in "Settings > Workspace".');
    const dir = projectsDir.value;
    if (dir === null) return fail("No projects folder is set.", 'Choose the folder with your repos in "Settings > Workspace".');
    const isDir = await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) return fail(`The projects folder ${dir} does not exist.`, 'Create it, or choose another folder in "Settings > Workspace".');
    return ok(dir);
  }

  /**
   * Only in a container, where removing the Docker volume takes the work with it; elsewhere the repos are on the user's
   * disk. Without a projects folder there is nothing to read, and the projects folder check says so.
   */
  private async unpushedWork({ projectsDir }: CheckContext): Promise<Outcome> {
    if (!projectsDir.ok || projectsDir.value === null) return null;
    const work = await this.deps.unpushedWork();
    if (!work.inContainer) return null;
    const unknown = work.unreadable.length > 0 ? ` Git could not read ${work.unreadable.map((u) => u.repo).join(", ")}.` : "";
    if (work.repos.length === 0)
      return unknown === "" ? ok("Everything in the projects folder is pushed.") : warn(unknown.trim(), READ_FIX);
    const repos = countLabel(work.repos.length, { one: "repo", other: "repos" });
    return warn(`Only in this container: ${unpushedSummary(unpushedTotal(work.repos))} in ${repos}.${unknown}`, UNPUSHED_FIX);
  }

  /** Only a projects folder on a folder of the user's computer mounted into Linux is worth a row: it works, slowly. */
  private async projectsFolderStorage({ projectsDir }: CheckContext): Promise<Outcome> {
    if (!projectsDir.ok || projectsDir.value === null) return null;
    // A link such as `~/code` to `/mnt/c/...` on WSL is exactly the slow case; a folder that does not exist is the other check's.
    const dir = await realpath(projectsDir.value).catch(() => null);
    const table = dir === null ? null : await this.deps.mountTable();
    const storage = table === null || dir === null ? null : folderStorage(table, dir);
    if (!storage?.sharedFromHost) return null;
    return warn(
      `The projects folder is a folder of your computer mounted into Linux (${storage.fsType} at ${storage.mountPoint}), so git and builds there are slow.`,
      'Clone the repos into the Linux file system instead, for example a Docker volume or a folder in your Linux home, and choose that folder in "Settings > Workspace".',
    );
  }

  /**
   * The least free space of the disks of the projects folder and the home folder; a folder that cannot be read is left
   * out (a missing projects folder is the other check's). Two folders with the same free and total space are taken
   * to be on one disk and named together.
   */
  private async diskSpace({ projectsDir }: CheckContext): Promise<Outcome> {
    const folders = [
      { name: "the projects folder", path: projectsDir.ok ? projectsDir.value : null },
      { name: "your home folder", path: this.deps.homeDir },
    ];
    const read = await Promise.all(
      folders.map(async ({ name, path }) => ({ name, space: path === null ? null : await this.deps.diskSpace(path).catch(() => null) })),
    );
    const disks = new Map<string, { names: string[]; free: number }>();
    for (const { name, space } of read) {
      if (space === null) continue;
      const key = `${space.free}/${space.total}`;
      const disk = disks.get(key) ?? { names: [], free: space.free };
      disk.names.push(name);
      disks.set(key, disk);
    }
    const lowest = [...disks.values()].sort((a, b) => a.free - b.free)[0];
    if (lowest === undefined) return null;
    const where = lowest.names.join(" and ");
    const fix = this.deps.inContainer ? DISK_FIX + CONTAINER_DISK_FIX : DISK_FIX;
    if (lowest.free < VERY_LOW_DISK_BYTES) return fail(`Only ${gigabytes(lowest.free)} free on the disk of ${where}.`, fix);
    if (lowest.free < LOW_DISK_BYTES) return warn(`Only ${gigabytes(lowest.free)} free on the disk of ${where}.`, fix);
    return ok(`${gigabytes(lowest.free)} free on the disk of ${where}.`);
  }

  /**
   * Every key of `workspace.yaml` reads and is Trackwall's (ADR-108): a key typed wrong by hand quietly leaves its
   * setting at the default, so the doctor names it with its line. Without the file there is nothing to check.
   */
  private async workspaceFile(): Promise<Outcome> {
    const path = this.deps.workspaceFile;
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (!exists) return null;
    const fix = `Correct it in ${path}; "Settings > Files" shows every key with its value and what is wrong.`;
    const keys = await settle(Promise.resolve().then(() => this.deps.workspaceKeys()));
    if (!keys.ok) return fail(keys.message, fix);
    const summary = workspaceKeysSummary(keys.value);
    if (summary.state === "broken") return fail(`workspace.yaml: ${summary.text}.`, fix);
    if (summary.state === "unknown") return warn(`workspace.yaml: ${summary.text}.`, fix);
    return ok(`workspace.yaml: ${summary.text}.`);
  }

  private async git(): Promise<Outcome> {
    const version = await settle(this.deps.gitVersion(CHECK_TIMEOUT_MS));
    if (!version.ok) return fail(`git: ${version.message}`, "Install Git (git-scm.com) and restart Trackwall.");
    const { output, program, source, chosen } = version.value;
    const git = `git ${versionIn(output) ?? firstLine(output)}`;
    if (source === "fallback")
      return warn(`${git} from PATH: the Git program ${chosen} did not answer.`, "Fix or clear the Git program in Settings > Workspace.");
    // Only a chosen program is named: Git for Windows from `PATH` resolves to its real binary too (ADR-79), which says nothing new.
    return ok(source === "chosen" ? `${git} at ${program}` : git);
  }

  private async copilotCli({ env }: CheckContext): Promise<Outcome> {
    const copilot = this.deps.resolveCopilot(env);
    if ("missing" in copilot)
      return fail(`${copilot.message}.`, "Install GitHub Copilot CLI, sign in by running `copilot` once, and restart Trackwall.");
    const version = await settle(this.version([copilot.program, ...copilot.args], env));
    if (!version.ok) return fail(`Copilot CLI: ${version.message}`, "Run `copilot --version` in a terminal to see what is wrong.");
    return copilotVersionOutcome(versionIn(version.value));
  }

  private async copilotTrustedFolder({ env, projectsDir }: CheckContext): Promise<Outcome> {
    if (!projectsDir.ok || projectsDir.value === null) return null;
    const dir = projectsDir.value;
    const trust = await trustedFolders(env);
    const fix = `Add ${dir} to "trustedFolders" in ${trust.file}, so Copilot CLI stops asking for every repo and task.`;
    if (trust.kind === "unreadable") return warn(`Copilot CLI's ${trust.file} could not be read: ${trust.message}.`, fix);
    const folder = trust.kind === "read" ? trustedFolderOf(dir, trust.folders) : null;
    if (folder === null) return warn("Copilot CLI does not trust the projects folder; it asks before working in each repo.", fix);
    return ok(`Copilot CLI trusts ${folder}.`);
  }

  private async mise({ env }: CheckContext): Promise<Outcome> {
    const version = await settle(this.version(this.deps.mise, env));
    if (!version.ok)
      return warn(
        `mise: ${version.message}`,
        "Install mise (mise.jdx.dev) and restart Trackwall; repo tasks, services and task verification need it.",
      );
    return ok(`mise ${versionIn(version.value) ?? firstLine(version.value)}`);
  }

  /** Only where some task runs in the sandbox (`sandbox.tasks` not `off`, the default in a container). */
  private async copilotSandbox(): Promise<Outcome> {
    const { tasks, problem } = await this.deps.sandbox();
    if (tasks === "off") return null;
    if (problem === null)
      return ok(
        tasks === "all"
          ? "Every task runs its commands in Copilot CLI's sandbox."
          : "Tasks without approvals run their commands in Copilot CLI's sandbox.",
      );
    return fail(
      `Copilot CLI's sandbox cannot run here: ${problem}, so Trackwall refuses to start ${tasks === "all" ? "any task" : "tasks without approvals"}.`,
      "Install it (on Linux the bubblewrap package, with slirp4netns, iproute2 and iptables), or set sandbox.tasks to off in workspace.yaml.",
    );
  }

  /** Only for someone who set Java navigation up: a path that went missing greys it out on the New session form. */
  private javaNavigation(): Outcome {
    const state = this.deps.javaNavigation();
    if (state === null) return null;
    if (state.problem === null) return ok("Tasks can get Java navigation.");
    return fail(
      `Java navigation cannot start: ${state.problem}.`,
      'Install it again in "Settings > Agents", or correct javaNavigation in workspace.yaml.',
    );
  }

  /** Whether `gh` or `glab` is signed in to every repo host of its kind; every host that is not is named at once. */
  private async hostCli(kind: RepoHostKind): Promise<Outcome> {
    const hosts = this.deps.repoHosts().filter((h) => h.kind === kind);
    if (hosts.length === 0) return null;
    const cli = HOST_CLI[kind];
    const results = await Promise.all(
      hosts.map(async (h) => ({ host: h.host, signedIn: await settle(this.deps.signedIn(h, CHECK_TIMEOUT_MS)) })),
    );
    const failed = results.flatMap((r) => (r.signedIn.ok ? [] : [{ host: r.host, message: r.signedIn.message }]));
    if (failed.length === 0) return ok(`${cli} is signed in to ${hosts.map((h) => h.host).join(", ")}.`);
    return fail(
      `${cli} is not signed in to ${failed.map((f) => `${f.host}: ${f.message}`).join("; ")}`,
      `Run ${failed.map((f) => `\`${cli} auth login --hostname ${f.host}\``).join(", then ")} in a terminal.`,
    );
  }

  private version(command: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
    const [program, ...args] = command;
    if (program === undefined) throw new Error("the program to check is empty");
    return this.deps.run(program, [...args, "--version"], { env, timeoutMs: CHECK_TIMEOUT_MS });
  }
}

/** Older than the tested version may lack what the daemon relies on; newer is what users get first, so only noted. */
export function copilotVersionOutcome(version: string | null): NonNullable<Outcome> {
  const tested = TESTED_COPILOT_CLI_VERSION;
  if (version === null) return warn("Copilot CLI did not say its version.", `Trackwall is tested with Copilot CLI ${tested}.`);
  const diff = compareVersions(version, tested);
  if (diff < 0)
    return warn(
      `Copilot CLI ${version} is older than ${tested}, the version Trackwall is tested with.`,
      "Update Copilot CLI the way you installed it (npm, Homebrew or WinGet).",
    );
  return ok(diff === 0 ? `Copilot CLI ${version}` : `Copilot CLI ${version} (Trackwall is tested with ${tested})`);
}

/** A call's value or its error's first line, so that one failed program never fails the report. */
async function settle<T>(call: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await call };
  } catch (err) {
    return { ok: false, message: firstLine(err instanceof Error ? err.message : String(err)) };
  }
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > MAX_MESSAGE_CHARS ? `${line.slice(0, MAX_MESSAGE_CHARS - 1)}…` : line;
}

function ok(summary: string): NonNullable<Outcome> {
  return { status: "ok", summary, fix: null };
}

function warn(summary: string, fix: string): NonNullable<Outcome> {
  return { status: "warn", summary, fix };
}

function fail(summary: string, fix: string): NonNullable<Outcome> {
  return { status: "fail", summary, fix };
}
