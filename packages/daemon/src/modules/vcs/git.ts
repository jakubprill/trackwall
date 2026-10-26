import { realpath } from "node:fs/promises";
import { delimiter, dirname, resolve as resolvePath } from "node:path";
import { type RunOptions, type RunOutput, runProgram } from "./run.ts";

/**
 * Runs `git` for the `vcs` module. Arguments always as an array, without a shell; the repo directory through `-C`,
 * so that a missing directory is a git error with a readable message, not an `ENOENT` mistaken for missing git.
 * `repoDir` is always the repo root, and a repo gets onto the list by itself when it lies in the projects folder (ADR-18), so
 * git must not look for a repo above it, and the keys from `NO_REPO_COMMANDS` are turned off; the rest of the repo
 * configuration applies (gaps with the `clean` filter and with programs from the repo configuration during sync in §8).
 */

/**
 * `.git/config` keys with which a repo would make git run a program during daemon commands:
 * `core.fsmonitor` on `status`, `log.showSignature` (with `gpg.program`) on `log`.
 */
const NO_REPO_COMMANDS = ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];

/**
 * On Windows, paths over 260 characters only with `core.longpaths`: task worktrees lie in the state directory (ADR-31), so
 * repo file paths are longer in them than in the projects folder. The key changes nothing outside Windows.
 */
const PLATFORM_CONFIG = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];

/** Ordinary calls finish in a fraction of a second; the limit guards against a hanging git (a lock, a network drive). */
const TIMEOUT_MS = 15_000;

/**
 * Variables with which git picks a repo instead of `-C`. Inherited ones (a daemon started from a git hook or from a shell
 * with `GIT_DIR`) would make every repo on the list show the data of one.
 */
const REPO_SELECTING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

type GitOptions = Pick<RunOptions, "maxBytes" | "stdin" | "okExitCodes"> & {
  /** A longer limit than `TIMEOUT_MS` for commands that fetch data or change the working directory. */
  timeoutMs?: number;
  /**
   * The command may connect to a server (`fetch`, `remote set-head`, `merge` with an LFS filter): an environment without prompts
   * (`networkEnv`); `sshCommand` is `core.sshCommand` from the repo and user configuration.
   */
  network?: GitNetwork;
  /** An index instead of the repo index (`GIT_INDEX_FILE`): task changes counted without touching the index the agent uses. */
  indexFile?: string;
};

/** `core.sshCommand` from the repo and user configuration for a command that connects to a server. */
export type GitNetwork = { sshCommand: string | undefined };

export async function git(repoDir: string, args: readonly string[], opts: GitOptions = {}): Promise<RunOutput> {
  const ceiling = await ceilingFor(repoDir);
  const { maxBytes, stdin, okExitCodes } = opts;
  return runProgram("git", [...NO_REPO_COMMANDS, ...PLATFORM_CONFIG, "-C", repoDir, ...args], {
    maxBytes,
    stdin,
    okExitCodes,
    label: `git ${args[0]}`,
    // Reading state must not take `index.lock`: the daemon asks periodically, and the user commits in the meantime.
    env: {
      ...gitEnv(),
      ...(opts.network && networkEnv(opts.network.sshCommand)),
      ...(opts.indexFile && { GIT_INDEX_FILE: opts.indexFile }),
      GIT_CEILING_DIRECTORIES: ceiling,
      GIT_OPTIONAL_LOCKS: "0",
    },
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
  });
}

/** The full hash of the commit `ref` points to; `undefined` when there is no such commit or git fails. */
export async function revParse(dir: string, ref: string): Promise<string | undefined> {
  return existingCommit(dir, ref).catch(() => undefined);
}

/**
 * The full hash of the commit `ref` points to; `undefined` only when git says there is no such commit (`--verify --quiet`
 * exits with 1). Any other failure (a timeout, a broken repo) throws, where telling it from a missing commit matters.
 */
export async function existingCommit(dir: string, ref: string): Promise<string | undefined> {
  const { stdout } = await git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { okExitCodes: [1] });
  return stdout.toString("utf8").trim() || undefined;
}

/** The full name of the ref the symbolic ref `ref` points to (e.g. `HEAD`); `undefined` when it is not a symbolic ref. */
export async function symbolicRef(dir: string, ref: string): Promise<string | undefined> {
  return git(dir, ["symbolic-ref", "--quiet", ref]).then(
    ({ stdout }) => stdout.toString("utf8").trim() || undefined,
    () => undefined,
  );
}

/**
 * The default branch of `remote` from `refs/remotes/<remote>/HEAD` (set by `git clone`), without asking the server; `undefined`
 * when it is missing or points to a remote branch that no longer exists.
 */
export async function knownDefaultBranch(dir: string, remote: string): Promise<string | undefined> {
  const prefix = `refs/remotes/${remote}/`;
  const ref = await symbolicRef(dir, `${prefix}HEAD`);
  if (!ref?.startsWith(prefix) || (await revParse(dir, ref)) === undefined) return undefined;
  return ref.slice(prefix.length);
}

/**
 * The parent directory of the repo root for `GIT_CEILING_DIRECTORIES`: with an empty or broken `.git`, git does not look for a
 * repo higher up, so it will not show the repo the projects folder lies in (e.g. a home directory under git). Git compares
 * it with the path after resolving links, hence `realpath`. An explicit `--git-dir` would also stop the search, but it turns off
 * the repo owner check (`safe.directory`), so another user's repo from a network drive would get through.
 */
async function ceilingFor(repoDir: string): Promise<string> {
  // git itself reports a missing directory (`-C`), with a readable message.
  const root = await realpath(repoDir).catch(() => resolvePath(repoDir));
  const ceiling = dirname(root);
  // The variable is a list of paths; a path with the separator would fall apart and the protection would silently vanish.
  if (ceiling.includes(delimiter)) throw new Error(`path ${ceiling} contains the character "${delimiter}", which git cannot handle`);
  return ceiling;
}

/**
 * The environment of every program that runs git (`git`, and underneath also `gh repo clone` and `glab repo clone`):
 * without the variables that pick a repo and without waiting for a password, because the daemon has no terminal.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REPO_SELECTING_ENV) delete env[name];
  return env;
}

/**
 * Additions to `gitEnv()` for commands that connect to a server: the daemon has neither a terminal nor a window, so every
 * prompt for a password, token or host key would hang until the time limit in a hidden console. An empty `GIT_ASKPASS` (git
 * then does not ask through a program, including one inherited from the VS Code terminal), Git Credential Manager without
 * windows and ssh in batch mode, unless the user set an ssh program themselves (`GIT_SSH_COMMAND`, `GIT_SSH`,
 * `core.sshCommand`): then theirs stays, because the daemon's `GIT_SSH_COMMAND` would override it.
 */
export function networkEnv(sshCommand: string | undefined, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_ASKPASS: "", GCM_INTERACTIVE: "never" };
  if (!(inherited.GIT_SSH_COMMAND || inherited.GIT_SSH || sshCommand)) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}
