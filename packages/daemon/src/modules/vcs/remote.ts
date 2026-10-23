/**
 * Remote repo w gicie (ADR-21): który remote jest „tym” zdalnym repo i jego adres jako identyfikator niezależny
 * od nazwy katalogu i protokołu. Czyste funkcje na wyjściu `git config -z --list`, testowane bez procesu.
 */

/** Ustawienia gita potrzebne do synchronizacji, z konfiguracji repo, użytkownika i systemu naraz. */
export interface GitConfig {
  /** Remote po nazwie, w kolejności z konfiguracji; pierwszy `url`, gdy remote ma kilka. */
  remotes: ReadonlyMap<string, string>;
  /** `core.sshCommand`, gdy użytkownik go ustawił. */
  sshCommand: string | undefined;
}

/** Wynik `git config -z --list`: wpisy `klucz\nwartość` rozdzielone NUL; klucz bez wartości nie ma `\n`. */
export function parseConfig(out: string): GitConfig {
  const remotes = new Map<string, string>();
  let sshCommand: string | undefined;
  for (const entry of out.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    // Git podaje sekcję i nazwę klucza małymi literami, a podsekcję (nazwę remote) bez zmian.
    const remote = /^remote\.(.+)\.url$/s.exec(key)?.[1];
    if (remote !== undefined && !remotes.has(remote)) remotes.set(remote, value);
    else if (key === "core.sshcommand") sshCommand = value;
  }
  return { remotes, sshCommand };
}

/** `origin`, a bez niego jedyny remote; przy kilku bez `origin` nie zgadujemy, który jest główny. */
export function mainRemote(config: GitConfig): { name: string; url: string } | undefined {
  const origin = config.remotes.get("origin");
  if (origin !== undefined) return { name: "origin", url: origin };
  const [only, ...rest] = config.remotes;
  return only && rest.length === 0 ? { name: only[0], url: only[1] } : undefined;
}

const NETWORK_SCHEMES = new Set(["ssh:", "git:", "http:", "https:", "git+ssh:", "ssh+git:"]);

/**
 * Adres repo zdalnego jako `host/ścieżka`: bez schematu, użytkownika (z hasłem albo tokenem, jeśli ktoś je wpisał
 * w URL), portu i końcówki `.git`, z hostem małymi literami. `git@host:grupa/repo.git` i
 * `https://host/grupa/repo` dają to samo. Ścieżka lokalna i `file://` dają `undefined`: nie mówią nic o hostingu.
 */
export function remoteAddress(url: string): string | undefined {
  const trimmed = url.trim();
  const target = trimmed.includes("://") ? fromUrl(trimmed) : fromScp(trimmed);
  if (!target) return undefined;
  const path = target.path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return target.host === "" || path === "" ? undefined : `${target.host.toLowerCase()}/${path}`;
}

function fromUrl(url: string): { host: string; path: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!NETWORK_SCHEMES.has(parsed.protocol)) return undefined;
  try {
    return { host: parsed.hostname, path: decodeURIComponent(parsed.pathname) };
  } catch {
    return { host: parsed.hostname, path: parsed.pathname };
  }
}

/**
 * Składnia scp (`[użytkownik@]host:ścieżka`): git rozpoznaje ją po dwukropku przed pierwszym `/`. Jednoliterowy
 * „host” to litera dysku Windowsa (`C:\repo`), czyli ścieżka lokalna.
 */
function fromScp(url: string): { host: string; path: string } | undefined {
  const m = /^(?:[^@/]+@)?([^:/]+):(.+)$/s.exec(url);
  if (!m || (m[1] ?? "").length < 2) return undefined;
  return { host: m[1] ?? "", path: m[2] ?? "" };
}
