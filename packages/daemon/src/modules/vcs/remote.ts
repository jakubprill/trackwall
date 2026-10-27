/**
 * The remote repo address (ADR-21): a repo identifier independent of the directory name and the clone protocol. A pure function,
 * tested without a process.
 */

const NETWORK_SCHEMES = new Set(["ssh:", "git:", "http:", "https:", "git+ssh:", "ssh+git:"]);

/**
 * The remote repo address as `host/path`: without the scheme, the user (with a password or token, if someone put them
 * in the URL), the port and the `.git` suffix, with the host in lower case. `git@host:group/repo.git` and
 * `https://host/group/repo` give the same. A local path, `file://` and `transport::` give `undefined`: they say
 * nothing about the hosting.
 */
export function remoteAddress(url: string): string | undefined {
  const trimmed = url.trim();
  // `transport::address` (e.g. `ext::<command>`) is a command with arguments, sometimes with a password, not a hosting address.
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(trimmed)) return undefined;
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
 * The scp syntax (`[user@]host:path`): git recognises it by a colon before the first `/`. A one-letter
 * "host" is a Windows drive letter (`C:\repo`), i.e. a local path.
 */
function fromScp(url: string): { host: string; path: string } | undefined {
  const m = /^(?:[^@/]+@)?([^:/]+):(.+)$/s.exec(url);
  const [, host = "", path = ""] = m ?? [];
  return host.length < 2 ? undefined : { host, path };
}

/**
 * An HTTPS or SSH (also scp-style) address as `host/path`, so both spellings of one repo match and a token in a URL never
 * reaches a message; `undefined` for anything else: a local path, `file://`, `git://`, `http://`, `ext::`. Trackwall
 * pushes only to such an address (ADR-77, ADR-86): a local path or a transport would run a program the repo it reaches
 * configures, whose hooks `core.hooksPath` on this side does not turn off.
 */
export function networkAddress(url: string): string | undefined {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "https" && scheme !== "ssh") return undefined;
  return remoteAddress(url);
}
