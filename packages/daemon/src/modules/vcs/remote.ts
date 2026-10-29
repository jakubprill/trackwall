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

/**
 * A URL counts only when the WHATWG parser and the program git connects through agree on its host and path; otherwise
 * `undefined`, since an address that looks like one host to the check but reaches another would let a push go elsewhere
 * (ADR-77). The parser ends an `https` host at `\`, decodes `%68` and full-width letters and resolves `..`, while git
 * hands curl the text as written; for `ssh://` git decodes the whole URL before it takes the host (`evil.example%2F@`
 * makes `evil.example` the host), so `asWritten` keeps only the text all of them read alike.
 */
function fromUrl(url: string): { host: string; path: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!NETWORK_SCHEMES.has(parsed.protocol)) return undefined;
  const written = asWritten(url, parsed.protocol);
  const path = decoded(parsed.pathname);
  if (!written || path === undefined || written.host.toLowerCase() !== parsed.hostname.toLowerCase()) return undefined;
  return decoded(written.path) === path ? { host: parsed.hostname, path } : undefined;
}

/**
 * The host and path of a URL as its text reads: the authority runs to the first `/`, the host follows its `@` and
 * precedes the port. `undefined` for an authority the programs split differently: with `\`, `?` or `#`, with more than
 * one `@` (curl splits on the first, ssh on the last), or with `%` in an `ssh` URL, which git decodes.
 */
function asWritten(url: string, protocol: string): { host: string; path: string } | undefined {
  const afterScheme = url.slice(url.indexOf("://") + 3);
  const slash = afterScheme.indexOf("/");
  const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  if (/[\\?#]/.test(authority) || authority.split("@").length > 2) return undefined;
  if (protocol !== "https:" && protocol !== "http:" && authority.includes("%")) return undefined;
  const hostAndPort = authority.slice(authority.indexOf("@") + 1);
  const host = hostAndPort.startsWith("[") ? hostAndPort.slice(0, hostAndPort.indexOf("]") + 1) : hostAndPort.replace(/:\d*$/, "");
  return { host, path: slash === -1 ? "" : afterScheme.slice(slash) };
}

function decoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/**
 * The scp syntax (`[user@]host:path`): git recognises it by a colon before the first `/`, takes everything before that
 * first colon as `[user@]host`, and ssh takes the host after the last `@` in it; this split mirrors theirs, so
 * `evil.example:x@github.com:me/x` is a path on `evil.example`, where git connects. A one-letter "host" is a Windows
 * drive letter (`C:\repo`), i.e. a local path. A bracketed host (`[::1]:repo`) has rules of its own in git and gives
 * `undefined`, as does a host starting with `-`, which git refuses.
 */
function fromScp(url: string): { host: string; path: string } | undefined {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon === -1 || (slash !== -1 && slash < colon)) return undefined;
  const userAndHost = url.slice(0, colon);
  const host = userAndHost.slice(userAndHost.lastIndexOf("@") + 1);
  if (host.length < 2 || /[[\]]/.test(userAndHost) || host.startsWith("-")) return undefined;
  return { host, path: url.slice(colon + 1) };
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
