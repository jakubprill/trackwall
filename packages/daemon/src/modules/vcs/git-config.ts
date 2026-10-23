import { git } from "./git.ts";

/**
 * Konfiguracja gita potrzebna synchronizacji i adresowi repo zdalnego (ADR-21): remote, `url.<base>.insteadOf`
 * i `core.sshCommand`, z konfiguracji repo, użytkownika i systemu naraz (`git config -z --list`). Parser to czysta
 * funkcja, testowana bez procesu.
 */

export interface GitConfig {
  /** Remote po nazwie, w kolejności z konfiguracji; pierwszy `url`, gdy remote ma kilka. */
  remotes: ReadonlyMap<string, string>;
  /** Skróty adresów: `url.<base>.insteadOf = <prefix>` jako prefiks → base. */
  insteadOf: ReadonlyMap<string, string>;
  /** `core.sshCommand`, gdy użytkownik go ustawił. */
  sshCommand: string | undefined;
}

export async function readConfig(dir: string): Promise<GitConfig> {
  const { stdout } = await git(dir, ["config", "-z", "--list"]);
  return parseConfig(stdout.toString("utf8"));
}

/** Wynik `git config -z --list`: wpisy `klucz\nwartość` rozdzielone NUL; klucz bez wartości nie ma `\n`. */
export function parseConfig(out: string): GitConfig {
  const remotes = new Map<string, string>();
  const insteadOf = new Map<string, string>();
  let sshCommand: string | undefined;
  for (const entry of out.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    // Git podaje sekcję i nazwę klucza małymi literami, a podsekcję (nazwę remote, adres) bez zmian.
    const remote = /^remote\.(.+)\.url$/s.exec(key)?.[1];
    const base = /^url\.(.+)\.insteadof$/s.exec(key)?.[1];
    if (remote !== undefined && !remotes.has(remote)) remotes.set(remote, value);
    else if (base !== undefined) insteadOf.set(value, base);
    else if (key === "core.sshcommand") sshCommand = value;
  }
  return { remotes, insteadOf, sshCommand };
}

/**
 * `origin`, a bez niego jedyny remote; przy kilku bez `origin` nie zgadujemy, który jest główny. Adres po
 * zastosowaniu `insteadOf` (najdłuższy pasujący prefiks, jak w gicie), czyli ten, z którym git naprawdę się łączy.
 */
export function mainRemote(config: GitConfig): { name: string; url: string } | undefined {
  const origin = config.remotes.get("origin");
  const [only, ...rest] = config.remotes;
  const remote =
    origin !== undefined ? { name: "origin", url: origin } : only && rest.length === 0 ? { name: only[0], url: only[1] } : undefined;
  return remote && { name: remote.name, url: rewrite(remote.url, config.insteadOf) };
}

function rewrite(url: string, insteadOf: ReadonlyMap<string, string>): string {
  let best: [string, string] | undefined;
  for (const [prefix, base] of insteadOf) if (url.startsWith(prefix) && prefix.length > (best?.[0].length ?? -1)) best = [prefix, base];
  return best ? best[1] + url.slice(best[0].length) : url;
}
