import { homedir, hostname, userInfo } from "node:os";
import { delimiter } from "node:path";
import { type KnownValue, STATE_DIR_LABEL } from "./anonymize.ts";

/**
 * The values anonymization replaces by name (ADR-94). What the computer knows about itself is read at once, so an error
 * that ends the daemon is anonymized too; what the workspace knows (the projects folder, repos, repo hosts) is read when the
 * journal is, and kept for the next error.
 */

/** Variables that name the computer, its domain or its user on Windows and macOS. */
const HOST_VARIABLES = ["COMPUTERNAME", "USERDOMAIN", "USERDNSDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "LOGONSERVER", "HOSTNAME"];
const USER_VARIABLES = ["USERNAME", "USER", "LOGNAME"];
/** Shorter variable values (`1`, `true`, `dev`) are ordinary words; longer ones may be anything, a path or a token. */
const MIN_ENV_VALUE_CHARS = 8;

/** The computer's own values; `stateDir` is Trackwall's state directory, the only path whose rest is kept. */
export function systemValues(stateDir: string, env: NodeJS.ProcessEnv): KnownValue[] {
  const values: KnownValue[] = [{ value: stateDir, label: STATE_DIR_LABEL }];
  values.push({ value: safely(homedir), label: "<home>" });
  // Names as whole words: a user `jan` must not take `jan` out of `january`; inside a path the path patterns take them.
  values.push({ value: safely(() => userInfo().username), label: "<user>", wholeWord: true });
  const host = safely(hostname);
  values.push({ value: host, label: "<host>", wholeWord: true }, { value: host.split(".")[0] ?? "", label: "<host>", wholeWord: true });
  for (const name of HOST_VARIABLES) values.push({ value: (env[name] ?? "").replace(/^\\\\/, ""), label: "<host>", wholeWord: true });
  for (const name of USER_VARIABLES) values.push({ value: env[name] ?? "", label: "<user>", wholeWord: true });
  for (const value of Object.values(env)) {
    if (value === undefined) continue;
    // `PATH` and its kind are lists: each entry may appear in a message on its own.
    for (const part of [value, ...value.split(delimiter)]) {
      if (part.length >= MIN_ENV_VALUE_CHARS) values.push({ value: part, label: "<env>" });
    }
  }
  return values.filter((v) => v.value !== "");
}

/** What the journal needs from `workspace`; wired in the facade. */
export interface ErrorJournalWorkspace {
  repoEntries(): Promise<{ id: string; path: string }[]>;
  projectsDir(): Promise<string>;
  worktreesDir(): Promise<string>;
  repoHosts(): { host: string }[];
}

/** The workspace's values; a part the workspace cannot give (no projects folder yet) is left out. */
export async function workspaceValues(workspace: ErrorJournalWorkspace): Promise<KnownValue[]> {
  const values: KnownValue[] = [];
  const projects = await workspace.projectsDir().catch(() => null);
  if (projects) values.push({ value: projects, label: "<projects>" });
  const worktrees = await workspace.worktreesDir().catch(() => null);
  if (worktrees) values.push({ value: worktrees, label: "<worktrees>" });
  for (const repo of await workspace.repoEntries().catch(() => [])) {
    values.push({ value: repo.path, label: "<repo>" }, { value: repo.id, label: "<repo>", wholeWord: true });
  }
  const hosts = (() => {
    try {
      return workspace.repoHosts();
    } catch {
      return [];
    }
  })();
  for (const host of hosts) values.push({ value: host.host, label: "<host>" });
  return values;
}

/** The first value given for a spelling wins, so the more specific label goes first. */
export function uniqueValues(values: readonly KnownValue[]): KnownValue[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = v.value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safely(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}
