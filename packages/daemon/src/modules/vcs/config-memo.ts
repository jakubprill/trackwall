import { homedir } from "node:os";
import { join } from "node:path";
import type { GitConfig } from "./git-config.ts";
import { gitDirs, optionalKey, statIfExists } from "./git-dir.ts";

/**
 * A repo's git configuration (`git config --list`) remembered until one of the files it usually comes from changes (ADR-79):
 * the repo's `config` and `config.worktree`, and the user's `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`. The repo list,
 * the tags and the graph read every repo's remote address at every refresh, and without this each read is a `git` process.
 * A change only in the system configuration or in a file pulled in by `include.path` shows after the next change of those
 * files or a daemon restart; remote addresses live in the repo's own `config`, so that is the accepted gap.
 */
export class ConfigMemo {
  readonly #configs = new Map<string, { key: string; config: Promise<GitConfig> }>();

  /** One entry per repo directory ever read; git rewrites `config` by renaming a new file over it, so its identity changes too. */
  async get(dir: string, read: () => Promise<GitConfig>): Promise<GitConfig> {
    // A file not readable this time: git reads the configuration, and nothing is remembered.
    const key = await configKey(dir).catch(() => undefined);
    if (key === undefined) return read();
    const known = this.#configs.get(dir);
    if (known?.key === key) return known.config;
    const config = read();
    this.#configs.set(dir, { key, config });
    config.catch(() => {
      if (this.#configs.get(dir)?.config === config) this.#configs.delete(dir);
    });
    return config;
  }
}

/** Times, sizes and identities of the configuration files; `undefined` outside a readable repo, where git has to answer. */
async function configKey(dir: string): Promise<string | undefined> {
  const dirs = await gitDirs(dir).catch(() => null);
  if (!dirs) return undefined;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const files = [
    join(dirs.commonDir, "config"),
    join(dirs.gitDir, "config.worktree"),
    join(homedir(), ".gitconfig"),
    join(xdg, "git", "config"),
  ];
  const keys = await Promise.all(files.map((file) => statIfExists(file).then(optionalKey)));
  return keys.join("\n");
}
