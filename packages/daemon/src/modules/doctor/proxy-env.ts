import { envKey } from "../../infra/env-key.ts";

/**
 * The proxy a Node.js program such as Copilot CLI uses for an address, read from the environment the way Node's
 * `EnvHttpProxyAgent` reads it (§4.15, ADR-166): for HTTPS `https_proxy`, then `HTTPS_PROXY`, then the HTTP proxy, for
 * HTTP only the HTTP proxy (`http_proxy`, `HTTP_PROXY`), unless `no_proxy` or `NO_PROXY` covers the host. The doctor's network check goes the same way, so its answer is the sessions'.
 */

/** The variables of each scheme's proxy, in the order Node's `EnvHttpProxyAgent` reads them: HTTPS falls back to HTTP. */
const PROXY_VARIABLES = {
  "https:": ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"],
  "http:": ["http_proxy", "HTTP_PROXY"],
} as const;

/** The proxy for `<scheme>//<host>:<port>`; `null` when the connection goes directly. */
export function proxyFor(env: NodeJS.ProcessEnv, scheme: keyof typeof PROXY_VARIABLES, host: string, port: number): URL | null {
  const value = first(env, PROXY_VARIABLES[scheme]);
  if (value === undefined) return null;
  if (bypassed(first(env, ["no_proxy", "NO_PROXY"]) ?? "", host, port)) return null;
  // A proxy written without its scheme (`proxy:8080`), as some tools accept, is an HTTP proxy.
  const url = URL.canParse(value) && /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? new URL(value) : new URL(`http://${value}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`the proxy ${shownProxy(url)} is not an HTTP proxy`);
  return url;
}

/** The proxy as it may be shown: its host and port, never the user and password an address can carry. */
export function shownProxy(url: URL): string {
  return `${url.hostname}:${proxyPort(url)}`;
}

export function proxyPort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** The first variable that is set and not empty; on Windows names are case-insensitive, so both spellings are one. */
function first(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[envKey(env, name)]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** `NO_PROXY` entries: `*`, a host (also its subdomains), `.domain` or `*.domain`, each with an optional port. */
function bypassed(noProxy: string, host: string, port: number): boolean {
  const name = host.toLowerCase();
  return noProxy
    .split(/[\s,]+/)
    .filter((entry) => entry !== "")
    .some((entry) => {
      if (entry === "*") return true;
      const [entryHost = "", entryPort] = entry.toLowerCase().split(":");
      if (entryPort !== undefined && Number(entryPort) !== port) return false;
      const domain = entryHost.replace(/^\*?\./, "");
      return name === domain || name.endsWith(`.${domain}`);
    });
}
