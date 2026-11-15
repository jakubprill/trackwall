import { invoke, isTauri } from "@tauri-apps/api/core";
import { HEALTH_PATH, Health, PAGE_CODE_EXCHANGE_PATH, PageCodeExchange } from "@trackwall/protocol";
import { z } from "zod";
import { call } from "./api.ts";

/**
 * How the UI knows where the daemon is (§5.2):
 * - the Tauri window: the `daemon_connection` command (the token never goes into a URL),
 * - a page served by the daemon (`trackwall-daemon --ui`, `trackwall-daemon address`): a one-time code in the `#code=`
 *   fragment, traded for the token, which goes to localStorage with the daemon's start, so a bookmark and a new tab of
 *   the same address need no token while that start runs, and the browser's history holds only a dead code (ADR-161),
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
  // Without a token there is nothing to guard and no need for the daemon yet: `vite dev` may start before it.
  if (!hasCredential(window.location, tokenStorage())) return { baseUrl: "" };
  const instance = await daemonInstance();
  return { baseUrl: "", token: await takeTokenFromLocation(window.location, window.history, tokenStorage(), instance, exchangePageCode) };
}

/** The token for a one-time page code, from the daemon that served this page; rejects with why when the code is spent. */
export async function exchangePageCode(code: string): Promise<string> {
  return (await call({ baseUrl: "", token: code }, PAGE_CODE_EXCHANGE_PATH, PageCodeExchange, { method: "POST" })).token;
}

/** Restarts the daemon after an error. Only in the Tauri window; in a browser the daemon is started by hand. */
export async function retryConnection(): Promise<Connection | undefined> {
  return isTauri() ? invoke<Connection>("retry_daemon") : undefined;
}

/** `Health` of the daemon that served this page: the same version, so with `instance`. */
const PageDaemonHealth = Health.required({ instance: true });

/** The start of the daemon that answers this page's address, from the public `/api/health`, before any token is sent. */
export async function daemonInstance(): Promise<string> {
  return (await call({ baseUrl: "" }, HEALTH_PATH, PageDaemonHealth)).instance;
}

function hasCredential(location: Location, storage: Storage): boolean {
  return credentialOf(location.hash.slice(1)) !== undefined || storage.getItem(TOKEN_KEY) !== null;
}

/**
 * What a page address carries in its fragment: a one-time code (`#code=`, what the daemon prints and opens since
 * ADR-161's addendum) or the token itself (`#token=`, what older daemons printed).
 */
export type PageCredential = { code: string } | { token: string };

function credentialOf(fragment: string): PageCredential | undefined {
  const params = new URLSearchParams(fragment);
  const code = params.get("code");
  if (code) return { code };
  const token = params.get("token");
  return token ? { token } : undefined;
}

/**
 * The token of a browser page: from the address's fragment, saved with the daemon start it came from, or the one saved for
 * this very start. The fragment leaves the address bar first, so a code the daemon refuses does not stay there either; a
 * spent code, as reopening the address from the history gives, falls back to the saved token. A token saved for another
 * start (the daemon restarted, or another program now answers on the address) is forgotten without being sent anywhere.
 */
export async function takeTokenFromLocation(
  location: Location,
  history: History,
  storage: Storage,
  instance: string,
  exchange: (code: string) => Promise<string>,
): Promise<string | undefined> {
  const given = credentialOf(location.hash.slice(1));
  if (given) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    const token = "code" in given ? await exchange(given.code).catch(() => undefined) : given.token;
    if (token) {
      saveToken(storage, token, instance);
      return token;
    }
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
 * The characters of a daemon token and a page code: base64url, the same rule as `is_token` for the desktop app's remote
 * daemon address in `apps/desktop/src-tauri/src/remote_daemon.rs` (ADR-130).
 */
const TOKEN_CHARACTERS = /^[A-Za-z0-9_-]+$/;
const NO_TOKEN = "The address has no code: paste the whole address, with #code= and what follows it.";

/**
 * The code or token from a page address the user pasted (`http://127.0.0.1:<port>/#code=…`, what `trackwall-daemon
 * address` prints). Only that is kept: the page goes on talking to the daemon that served it.
 */
export function credentialFromAddress(address: string): PageCredential {
  const given = credentialOf(fragmentOf(address.trim()));
  if (!given) throw new Error(NO_TOKEN);
  if (!TOKEN_CHARACTERS.test("code" in given ? given.code : given.token))
    throw new Error("The code in the address has characters Trackwall never gives out.");
  return given;
}

/** The fragment of an address without `#`, empty when the text is no address (`URL.parse` is too new for some browsers). */
function fragmentOf(address: string): string {
  try {
    return new URL(address).hash.slice(1);
  } catch {
    return "";
  }
}

/** Keeps a token the daemon accepted for the next visit of this page, while the same start of the daemon runs. */
export function saveToken(storage: Storage, token: string, instance: string): void {
  storage.setItem(TOKEN_KEY, JSON.stringify({ token, instance }));
}

/** Forgets a token the daemon no longer accepts, so no later visit sends it. */
export function forgetToken(storage: Storage): void {
  storage.removeItem(TOKEN_KEY);
}
