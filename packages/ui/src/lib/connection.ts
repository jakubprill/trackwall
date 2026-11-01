import { invoke, isTauri } from "@tauri-apps/api/core";
import { HEALTH_PATH, Health } from "@trackwall/protocol";
import { z } from "zod";
import { call } from "./api.ts";

/**
 * How the UI knows where the daemon is (§5.2):
 * - the Tauri window: the `daemon_connection` command (the token never goes into a URL),
 * - a page served by the daemon (`trackwall-daemon --ui`): the token in the `#token=` fragment, moved to localStorage with
 *   the daemon's start, so a bookmark and a new tab of the same address need no token while that start runs (ADR-161),
 * - `vite dev`: relative `/api`, the Vite proxy adds the token.
 */
export interface Connection {
  baseUrl: string;
  token?: string;
}

const TOKEN_KEY = "trackwall.token";

/** Where a browser page keeps its token: shared by every tab of the origin, until the daemon refuses it (ADR-161). */
export const tokenStorage = (): Storage => window.localStorage;

/** A saved token with the start of the daemon that accepted it (`Health.instance`): only that start gets it again. */
const SavedToken = z.object({ token: z.string(), instance: z.string() });

export async function resolveConnection(): Promise<Connection> {
  if (isTauri()) return invoke<Connection>("daemon_connection");
  const instance = await daemonInstance();
  return { baseUrl: "", token: takeTokenFromLocation(window.location, window.history, tokenStorage(), instance) };
}

/** Restarts the daemon after an error. Only in the Tauri window; in a browser the daemon is started by hand. */
export async function retryConnection(): Promise<Connection | undefined> {
  return isTauri() ? invoke<Connection>("retry_daemon") : undefined;
}

/** The start of the daemon that answers this page's address, from the public `/api/health`, before any token is sent. */
export async function daemonInstance(): Promise<string> {
  return (await call({ baseUrl: "" }, HEALTH_PATH, Health)).instance;
}

/**
 * The token of a browser page: from the `#token=` fragment, saved with the daemon start it came from and removed from the
 * address bar, or the one saved for this very start. A token saved for another start (the daemon restarted, or another
 * program now answers on the address) is forgotten without being sent anywhere.
 */
export function takeTokenFromLocation(location: Location, history: History, storage: Storage, instance: string): string | undefined {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) {
    saveToken(storage, fromHash, instance);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return fromHash;
  }
  const saved = savedToken(storage);
  if (saved?.instance === instance) return saved.token;
  forgetToken(storage);
  return undefined;
}

function savedToken(storage: Storage): z.infer<typeof SavedToken> | undefined {
  const text = storage.getItem(TOKEN_KEY);
  if (text === null) return undefined;
  try {
    const parsed = SavedToken.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The daemon token's characters: base64url, the same rule as `token_is_safe` for the desktop app's remote daemon
 * address in `apps/desktop/src-tauri/src/remote_daemon.rs` (ADR-130).
 */
const TOKEN_CHARACTERS = /^[A-Za-z0-9_-]+$/;
const NO_TOKEN = "The address has no token: paste the whole address, with #token= and what follows it.";

/**
 * The token from a page address the user pasted (`http://127.0.0.1:<port>/#token=…`, what `trackwall-daemon address`
 * prints). Only the token is kept: the page goes on talking to the daemon that served it.
 */
export function tokenFromAddress(address: string): string {
  const url = URL.parse(address.trim());
  const token = url && new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error(NO_TOKEN);
  if (!TOKEN_CHARACTERS.test(token)) throw new Error("The token in the address has characters a daemon token never has.");
  return token;
}

/** Keeps a token the daemon accepted for the next visit of this page, while the same start of the daemon runs. */
export function saveToken(storage: Storage, token: string, instance: string): void {
  storage.setItem(TOKEN_KEY, JSON.stringify({ token, instance }));
}

/** Forgets a token the daemon no longer accepts, so no later visit sends it. */
export function forgetToken(storage: Storage): void {
  storage.removeItem(TOKEN_KEY);
}
