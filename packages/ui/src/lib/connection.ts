import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * How the UI knows where the daemon is (§5.2):
 * - the Tauri window: the `daemon_connection` command (the token never goes into a URL),
 * - a page served by the daemon (`trackwall-daemon --ui`): the token in the `#token=` fragment, moved to localStorage, so a
 *   bookmark and a new tab of the same address need no token until the daemon restarts with a new one (ADR-161),
 * - `vite dev`: relative `/api`, the Vite proxy adds the token.
 */
export interface Connection {
  baseUrl: string;
  token?: string;
}

const TOKEN_KEY = "trackwall.token";

/** Where a browser page keeps its token: shared by every tab of the origin, until the daemon refuses it (ADR-161). */
export const tokenStorage = (): Storage => window.localStorage;

export async function resolveConnection(): Promise<Connection> {
  if (isTauri()) return invoke<Connection>("daemon_connection");
  return { baseUrl: "", token: takeTokenFromLocation(window.location, window.history, tokenStorage()) };
}

/** Restarts the daemon after an error. Only in the Tauri window; in a browser the daemon is started by hand. */
export async function retryConnection(): Promise<Connection | undefined> {
  return isTauri() ? invoke<Connection>("retry_daemon") : undefined;
}

export function takeTokenFromLocation(location: Location, history: History, storage: Storage): string | undefined {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) {
    saveToken(storage, fromHash);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return fromHash;
  }
  return storage.getItem(TOKEN_KEY) ?? undefined;
}

/** The daemon token's characters: base64url, the same rule as the desktop app's remote daemon address (ADR-130). */
const TOKEN_CHARACTERS = /^[A-Za-z0-9_-]+$/;

/**
 * The token from a daemon page address the user pasted (`http://127.0.0.1:<port>/#token=…`, what `trackwall-daemon
 * address` prints). Only the token is kept: the page goes on talking to the daemon that served it.
 */
export function tokenFromAddress(address: string): string {
  const hash = address.trim().split("#")[1];
  const token = hash === undefined ? null : new URLSearchParams(hash).get("token");
  if (!token) throw new Error("The address has no token: paste the whole address, with #token= and what follows it.");
  if (!TOKEN_CHARACTERS.test(token)) throw new Error("The token in the address has characters a daemon token never has.");
  return token;
}

/** Keeps a token the daemon accepted for the next visit of this page. */
export function saveToken(storage: Storage, token: string): void {
  storage.setItem(TOKEN_KEY, token);
}

/** Forgets a token the daemon no longer accepts (it restarted), so no later visit sends it. */
export function forgetToken(storage: Storage): void {
  storage.removeItem(TOKEN_KEY);
}
