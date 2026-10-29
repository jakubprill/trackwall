import { git } from "./git.ts";

/**
 * The git configuration that sync and the remote repo address need (ADR-21): remotes, `url.<base>.insteadOf`
 * and `core.sshCommand`, from the repo, user and system configuration at once (`git config -z --list`). The parser is a pure
 * function, tested without a process.
 */

export interface GitConfig {
  /** Remotes by name, in configuration order, with every `url` as written: git pushes to each, and fetches from the first. */
  remotes: ReadonlyMap<string, readonly string[]>;
  /** Address shortcuts: `url.<base>.insteadOf = <prefix>` as prefix → base. */
  insteadOf: ReadonlyMap<string, string>;
  /** `core.sshCommand`, when the user set it. */
  sshCommand: string | undefined;
}

export async function readConfig(dir: string): Promise<GitConfig> {
  const { stdout } = await git(dir, ["config", "-z", "--list"]);
  return parseConfig(stdout.toString("utf8"));
}

/** The result of `git config -z --list`: `key\nvalue` entries separated by NUL; a key without a value has no `\n`. */
export function parseConfig(out: string): GitConfig {
  const remotes = new Map<string, string[]>();
  const insteadOf = new Map<string, string>();
  let sshCommand: string | undefined;
  for (const entry of out.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    // Git gives the section and key name in lower case, and the subsection (a remote name, an address) unchanged.
    const remote = /^remote\.(.+)\.url$/s.exec(key)?.[1];
    const base = /^url\.(.+)\.insteadof$/s.exec(key)?.[1];
    if (remote !== undefined) remotes.set(remote, [...(remotes.get(remote) ?? []), value]);
    else if (base !== undefined) insteadOf.set(value, base);
    else if (key === "core.sshcommand") sshCommand = value;
  }
  return { remotes, insteadOf, sshCommand };
}

/**
 * `origin`, and without it the only remote; with several and no `origin` we do not guess which one is the main one. The address after
 * applying `insteadOf` (the longest matching prefix, as in git), i.e. the one git really connects to.
 */
export function mainRemote(config: GitConfig): { name: string; url: string } | undefined {
  const origin = config.remotes.get("origin")?.[0];
  if (origin !== undefined) return { name: "origin", url: rewrite(origin, config.insteadOf) };
  const [only] = config.remotes;
  const onlyUrl = only?.[1][0];
  if (only && onlyUrl !== undefined && config.remotes.size === 1) return { name: only[0], url: rewrite(onlyUrl, config.insteadOf) };
  return undefined;
}

function rewrite(url: string, insteadOf: ReadonlyMap<string, string>): string {
  let best: [string, string] | undefined;
  for (const [prefix, base] of insteadOf) if (url.startsWith(prefix) && prefix.length > (best?.[0].length ?? -1)) best = [prefix, base];
  return best ? best[1] + url.slice(best[0].length) : url;
}
