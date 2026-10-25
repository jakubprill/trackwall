import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * How the UI knows where the daemon is (§5.2):
 * - the Tauri window: the `daemon_connection` command (the token never goes into a URL),
 * - a page served by the daemon (`trackwall-daemon --ui`): the token in the `#token=` fragment, moved to sessionStorage,
 * - `vite dev`: relative `/api`, the Vite proxy adds the token.
 */
export interface Connection {
  baseUrl: string;
  token?: string;
}

const TOKEN_KEY = "trackwall.token";

export async function resolveConnection(): Promise<Connection> {
  if (isTauri()) return invoke<Connection>("daemon_connection");
  return { baseUrl: "", token: takeTokenFromLocation(window.location, window.history, window.sessionStorage) };
}

/** Restarts the daemon after an error. Only in the Tauri window; in a browser the daemon is started by hand. */
export async function retryConnection(): Promise<Connection | undefined> {
  return isTauri() ? invoke<Connection>("retry_daemon") : undefined;
}

export function takeTokenFromLocation(location: Location, history: History, storage: Storage): string | undefined {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) {
    storage.setItem(TOKEN_KEY, fromHash);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return fromHash;
  }
  return storage.getItem(TOKEN_KEY) ?? undefined;
}
