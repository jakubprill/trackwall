import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Skąd UI wie, gdzie jest daemon (§5.2):
 * - okno Tauri: komenda `daemon_connection` (token nigdy nie trafia do URL),
 * - strona z daemona (`trackwall-daemon --ui`): token we fragmencie `#token=`, przeniesiony do sessionStorage,
 * - `vite dev`: względne `/api`, token dokłada proxy Vite.
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

/** Ponowny start daemona po błędzie. Tylko w oknie Tauri; w przeglądarce daemon uruchamia się ręcznie. */
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
