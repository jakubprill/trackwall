import { stat } from "node:fs/promises";
import {
  type DoctorCheck,
  DoctorCheckId,
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
 * `auth status`; it changes nothing, and its report is not kept. A check that throws becomes a failed check, never a
 * failed report.
 */

/** Every program a check runs gets this long: enough for a cold `gh auth status` over a VPN, short enough to wait for. */
const CHECK_TIMEOUT_MS = 15_000;
/** A program's error in a summary: its first line, cut. */
const MAX_MESSAGE_CHARS = 200;

export interface DoctorDeps {
  /** The environment sessions and mise tasks start with (`userEnv`). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** Runs a program without a shell; the error says why it failed. */
  run: (command: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;
  /** `git --version` of the git the daemon runs (`vcs`). */
  gitVersion: (timeoutMs: number) => Promise<string>;
  /** Resolves when `gh` or `glab` is signed in to the repo host (`vcs`); the error says why not. */
  signedIn: (host: RepoHost, timeoutMs: number) => Promise<void>;
  /** Copilot CLI found as sessions find it (`agents`), so the doctor's answer is the sessions' answer. */
  resolveCopilot: (env: NodeJS.ProcessEnv) => { program: string; args: string[] } | { missing: string; message: string };
  /** The `mise` program with arguments before the command. */
  mise: readonly string[];
  /** `null` while the projects folder is not set; throws when the workspace settings cannot be read. */
  projectsDir: () => Promise<string | null>;
  repoHosts: () => RepoHost[];
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
      git: () => this.git(),
      "copilot-cli": (ctx) => this.copilotCli(ctx),
      "copilot-trusted-folder": (ctx) => this.copilotTrustedFolder(ctx),
      mise: (ctx) => this.mise(ctx),
      "github-cli": () => this.hostCli("github"),
      "gitlab-cli": () => this.hostCli("gitlab"),
    };
  }

  async run(): Promise<DoctorReport> {
    const ctx: CheckContext = { env: await this.deps.env(), projectsDir: await settle(this.deps.projectsDir()) };
    const outcomes = await Promise.all(
      DoctorCheckId.options.map(async (id) => {
        const outcome = await settle(this.checks[id](ctx));
        if (!outcome.ok) return { id, ...fail(outcome.message, "The message says what failed; Trackwall's own errors are below.") };
        return outcome.value && { id, ...outcome.value };
      }),
    );
    return { checks: outcomes.filter((c) => c !== null), checkedAt: this.deps.now().toISOString() };
  }

  private async projectsFolder({ projectsDir }: CheckContext): Promise<Outcome> {
    if (!projectsDir.ok)
      return fail(
        `The workspace settings could not be read: ${projectsDir.message}`,
        'Correct the file named under "Projects folder" above.',
      );
    const dir = projectsDir.value;
    if (dir === null) return fail("No projects folder is set.", 'Choose the folder with your repos in "Projects folder" above.');
    const isDir = await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) return fail(`The projects folder ${dir} does not exist.`, "Create it, or choose another folder above.");
    return ok(dir);
  }

  private async git(): Promise<Outcome> {
    const version = await settle(this.deps.gitVersion(CHECK_TIMEOUT_MS));
    if (!version.ok) return fail(`git: ${version.message}`, "Install Git (git-scm.com) and restart Trackwall.");
    return ok(`git ${versionIn(version.value) ?? firstLine(version.value)}`);
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
