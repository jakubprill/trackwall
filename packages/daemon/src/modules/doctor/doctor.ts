import { stat } from "node:fs/promises";
import {
  type DoctorCheck,
  type DoctorCheckId,
  type DoctorReport,
  HOST_CLI,
  type RepoHost,
  type RepoHostKind,
  TESTED_COPILOT_CLI_VERSION,
} from "@trackwall/protocol";
import { trustedFolderOf, trustedFolders } from "./copilot-trust.ts";
import { compareVersions, versionIn } from "./version.ts";

/**
 * The doctor (§4.15, ADR-101): checks of what Trackwall needs on this computer, each with what to do when it fails, for the
 * person setting Trackwall up or wondering why a part of it does not work. It only reads and runs `--version` and
 * `auth status`; it changes nothing, and its report is not kept.
 */

/** Long enough for a cold `gh auth status` over a VPN, short enough that one hung program does not hold the report. */
const CHECK_TIMEOUT_MS = 15_000;
/** A program's error in a summary: its first line, cut. */
const MAX_ERROR_CHARS = 200;

/** A program and the arguments before the check's own (`["git"]`, a fake run by Bun in tests). */
type Command = readonly string[];

type RunResult = { ok: true; stdout: string } | { ok: false; message: string };

export interface DoctorDeps {
  /** The environment sessions and mise tasks start with (`userEnv`). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** Runs a program without a shell, with a time limit; the error says why it failed. */
  run: (command: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;
  /** `git --version` of the git the daemon runs (`vcs`). */
  gitVersion: () => Promise<string>;
  /** Resolves when `gh` or `glab` is signed in to the repo host (`vcs`); the error says why not. */
  signedIn: (host: RepoHost) => Promise<void>;
  copilot: Command;
  /** The Copilot CLI program as sessions find it (`findCopilot`), so the doctor finds the same one or none. */
  findCopilot: (program: string, env: NodeJS.ProcessEnv) => string | undefined;
  mise: Command;
  /** `null` while the projects folder is not set. */
  projectsDir: () => Promise<string | null>;
  repoHosts: () => RepoHost[];
  now: () => Date;
}

const HOST_CHECK: Record<RepoHostKind, DoctorCheckId> = { github: "github-cli", gitlab: "gitlab-cli" };

export class Doctor {
  private readonly deps: DoctorDeps;

  constructor(deps: DoctorDeps) {
    this.deps = deps;
  }

  async run(): Promise<DoctorReport> {
    const env = await this.deps.env();
    const projectsDir = await this.deps.projectsDir();
    const checks = await Promise.all([
      this.projectsFolder(projectsDir),
      this.git(),
      this.copilotCli(env),
      this.copilotTrustedFolder(env, projectsDir),
      this.mise(env),
      this.hostCli("github"),
      this.hostCli("gitlab"),
    ]);
    return { checks: checks.filter((c) => c !== null), checkedAt: this.deps.now().toISOString() };
  }

  private async projectsFolder(dir: string | null): Promise<DoctorCheck> {
    const id = "projects-folder";
    if (dir === null) return fail(id, "No projects folder is set.", 'Choose the folder with your repos in "Projects folder" above.');
    const isDir = await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) return fail(id, `The projects folder ${dir} does not exist.`, "Create it, or choose another folder above.");
    return ok(id, dir);
  }

  private async git(): Promise<DoctorCheck> {
    const result = await settle(this.deps.gitVersion());
    if (!result.ok) return fail("git", `git: ${firstLine(result.message)}`, "Install Git (git-scm.com) and restart Trackwall.");
    return ok("git", `git ${versionIn(result.stdout) ?? firstLine(result.stdout)}`);
  }

  private async copilotCli(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
    const id = "copilot-cli";
    const [name = "copilot", ...prefix] = this.deps.copilot;
    const program = this.deps.findCopilot(name, env);
    if (!program)
      return fail(
        id,
        `Copilot CLI (${name}) not found in PATH.`,
        "Install GitHub Copilot CLI, sign in with `copilot` once, and restart Trackwall.",
      );
    const result = await this.version([program, ...prefix], env);
    if (!result.ok) return fail(id, `Copilot CLI: ${result.message}`, "Run `copilot --version` in a terminal to see what is wrong.");
    return copilotVersionCheck(versionIn(result.stdout));
  }

  private async copilotTrustedFolder(env: NodeJS.ProcessEnv, projectsDir: string | null): Promise<DoctorCheck | null> {
    if (projectsDir === null) return null;
    const id = "copilot-trusted-folder";
    const trust = await trustedFolders(env);
    const fix = `Add ${projectsDir} to "trustedFolders" in ${trust.file}, so Copilot CLI stops asking for every repo and task.`;
    if (trust.kind === "unreadable") return warn(id, `Copilot CLI's ${trust.file} could not be read: ${trust.message}.`, fix);
    const folder = trust.kind === "read" ? trustedFolderOf(projectsDir, trust.folders) : null;
    if (folder === null) return warn(id, "Copilot CLI does not trust the projects folder; it asks before working in each repo.", fix);
    return ok(id, `Copilot CLI trusts ${folder}.`);
  }

  private async mise(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
    const result = await this.version(this.deps.mise, env);
    if (!result.ok)
      return warn(
        "mise",
        `mise: ${result.message}`,
        "Install mise (mise.jdx.dev) and restart Trackwall; repo tasks, services and task verification need it.",
      );
    return ok("mise", `mise ${versionIn(result.stdout) ?? firstLine(result.stdout)}`);
  }

  /** Whether `gh` or `glab` is signed in to every repo host of its kind; no check without such a host. */
  private async hostCli(kind: RepoHostKind): Promise<DoctorCheck | null> {
    const hosts = this.deps.repoHosts().filter((h) => h.kind === kind);
    if (hosts.length === 0) return null;
    const id = HOST_CHECK[kind];
    const cli = HOST_CLI[kind];
    const results = await Promise.all(hosts.map(async (h) => ({ host: h.host, result: await settle(this.deps.signedIn(h)) })));
    for (const { host, result } of results) {
      if (!result.ok)
        return fail(
          id,
          `${cli} is not signed in to ${host}: ${firstLine(result.message)}`,
          `Run \`${cli} auth login --hostname ${host}\` in a terminal.`,
        );
    }
    return ok(id, `${cli} is signed in to ${hosts.map((h) => h.host).join(", ")}.`);
  }

  private version(command: Command, env: NodeJS.ProcessEnv): Promise<RunResult> {
    const [program = "", ...prefix] = command;
    return settle(this.deps.run(program, [...prefix, "--version"], { env, timeoutMs: CHECK_TIMEOUT_MS }));
  }
}

/** A call's result or its error's message, so that one failed check never fails the report. */
async function settle(call: Promise<unknown>): Promise<RunResult> {
  try {
    const out = await call;
    return { ok: true, stdout: typeof out === "string" ? out : "" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Older than the tested version may lack what the daemon relies on; newer is what users get first, so only noted. */
export function copilotVersionCheck(version: string | null): DoctorCheck {
  const id = "copilot-cli";
  const tested = TESTED_COPILOT_CLI_VERSION;
  if (version === null) return warn(id, "Copilot CLI did not say its version.", `Trackwall is tested with Copilot CLI ${tested}.`);
  const diff = compareVersions(version, tested);
  if (diff < 0)
    return warn(
      id,
      `Copilot CLI ${version} is older than ${tested}, the version Trackwall is tested with.`,
      "Update Copilot CLI the way you installed it (npm, Homebrew or WinGet).",
    );
  return ok(id, diff === 0 ? `Copilot CLI ${version}` : `Copilot CLI ${version} (Trackwall is tested with ${tested})`);
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…` : line;
}

function ok(id: DoctorCheckId, summary: string): DoctorCheck {
  return { id, status: "ok", summary, fix: null };
}

function warn(id: DoctorCheckId, summary: string, fix: string): DoctorCheck {
  return { id, status: "warn", summary, fix };
}

function fail(id: DoctorCheckId, summary: string, fix: string): DoctorCheck {
  return { id, status: "fail", summary, fix };
}
