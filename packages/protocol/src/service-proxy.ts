import { TaskId } from "./agents.ts";
import type { MiseTarget } from "./mise.ts";
import { RepoId } from "./workspace.ts";

/**
 * Addresses of the service proxy (§5.6, ADR-189): a listener of the daemon on its own port that passes a browser's
 * request to the running service a name in `Host` stands for, so a service in a dev container opens on the user's
 * computer through one forwarded port. `<repo>.localhost:<port>` is the service of a repo root (while a task holds its
 * port on a lease, that task's), `<task>.<repo>.localhost:<port>` the service of a task's worktree. Browsers resolve
 * every name under `localhost` to the loopback address themselves, so nothing needs a hosts file or DNS.
 */

const PROXY_DOMAIN = ".localhost";

/** The address that opens `target` through the proxy on `proxyPort`. */
export function serviceProxyAddress(proxyPort: number, { repo, task }: MiseTarget): string {
  return `http://${task === null ? "" : `${task}.`}${repo}${PROXY_DOMAIN}:${proxyPort}/`;
}

/**
 * The service a request's `Host` names, or `null` when the host is not a name under `localhost` on `proxyPort`: an
 * address such as `127.0.0.1:<port>`, another port, or another domain (a page that rebinds its own name to 127.0.0.1)
 * reaches no service. A repo id may hold dots, so a first label that is a task id, followed by a repo id, names a task.
 */
export function serviceProxyTarget(host: string | undefined, proxyPort: number): MiseTarget | null {
  const suffix = `${PROXY_DOMAIN}:${proxyPort}`;
  const lower = host?.toLowerCase();
  if (!lower?.endsWith(suffix)) return null;
  const name = lower.slice(0, -suffix.length);
  const dot = name.indexOf(".");
  if (dot > 0) {
    const task = TaskId.safeParse(name.slice(0, dot));
    const repo = RepoId.safeParse(name.slice(dot + 1));
    if (task.success && repo.success) return { repo: repo.data, task: task.data };
  }
  const repo = RepoId.safeParse(name);
  return repo.success ? { repo: repo.data, task: null } : null;
}

/** The origins of pages served through the proxy on `proxyPort`: a WebSocket from one of them may go to another service. */
export function isServiceProxyOrigin(origin: string, proxyPort: number): boolean {
  if (!origin.startsWith("http://")) return false;
  return serviceProxyTarget(origin.slice("http://".length), proxyPort) !== null;
}
