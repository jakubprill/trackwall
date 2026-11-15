import { describe, expect, test } from "bun:test";
import { credentialFromAddress, forgetToken, takeTokenFromLocation } from "../src/lib/connection.ts";

function fakeEnv(hash: string) {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as unknown as Storage;
  const replaced: string[] = [];
  const history = { replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url) } as unknown as History;
  const location = { hash, pathname: "/", search: "" } as Location;
  return { storage, history, location, replaced };
}

const NO_FRAGMENT = { hash: "", pathname: "/", search: "" } as Location;

/** A daemon that trades `open` once for `token`, as `POST /api/page-code/exchange` does. */
function daemonWithCode(open: string, token: string) {
  const spent = new Set<string>();
  const asked: string[] = [];
  const exchange = async (code: string) => {
    asked.push(code);
    if (code !== open || spent.has(code)) throw new Error("The address's one-time code was used already");
    spent.add(code);
    return token;
  };
  return { exchange, asked };
}

const NO_DAEMON = async (): Promise<string> => {
  throw new Error("no code expected");
};

describe("token from the address", () => {
  test("a #code= fragment is traded for the token, which goes into storage and serves a later visit, and the code leaves the address bar", async () => {
    const env = fakeEnv("#code=once");
    const daemon = daemonWithCode("once", "abc");
    expect(await takeTokenFromLocation(env.location, env.history, env.storage, "start-1", daemon.exchange)).toBe("abc");
    expect(daemon.asked).toEqual(["once"]);
    expect(env.replaced).toEqual(["/"]);
    expect(await takeTokenFromLocation(NO_FRAGMENT, env.history, env.storage, "start-1", daemon.exchange)).toBe("abc");
    expect(daemon.asked).toEqual(["once"]);
  });

  test("a spent code, as reopening the address from the history gives, leaves the address bar and falls back to the saved token", async () => {
    const env = fakeEnv("#code=once");
    const daemon = daemonWithCode("once", "abc");
    await takeTokenFromLocation(env.location, env.history, env.storage, "start-1", daemon.exchange);
    expect(await takeTokenFromLocation(env.location, env.history, env.storage, "start-1", daemon.exchange)).toBe("abc");
    const fresh = fakeEnv("#code=once");
    expect(await takeTokenFromLocation(fresh.location, fresh.history, fresh.storage, "start-1", daemon.exchange)).toBeUndefined();
    expect(fresh.replaced).toEqual(["/"]);
  });

  test("a #token= fragment, as older daemons printed it, is taken as it is", async () => {
    const env = fakeEnv("#token=abc");
    expect(await takeTokenFromLocation(env.location, env.history, env.storage, "start-1", NO_DAEMON)).toBe("abc");
    expect(env.replaced).toEqual(["/"]);
  });

  test("without a fragment and without a stored token there is no token (vite dev mode)", async () => {
    const env = fakeEnv("");
    expect(await takeTokenFromLocation(env.location, env.history, env.storage, "start-1", NO_DAEMON)).toBeUndefined();
    expect(env.replaced).toEqual([]);
  });

  test("a token saved for another start of the daemon is forgotten instead of sent to whatever answers now", async () => {
    const env = fakeEnv("#token=abc");
    await takeTokenFromLocation(env.location, env.history, env.storage, "start-1", NO_DAEMON);
    expect(await takeTokenFromLocation(NO_FRAGMENT, env.history, env.storage, "start-2", NO_DAEMON)).toBeUndefined();
    expect(await takeTokenFromLocation(NO_FRAGMENT, env.history, env.storage, "start-1", NO_DAEMON)).toBeUndefined();
  });
});

describe("code from a pasted address", () => {
  test("the code comes from the #code= fragment of the address the daemon prints, and a token from an older #token=", () => {
    expect(credentialFromAddress("http://127.0.0.1:7700/#code=Ab-_9")).toEqual({ code: "Ab-_9" });
    expect(credentialFromAddress("  http://localhost:7700/#token=xyz\n")).toEqual({ token: "xyz" });
  });

  test("an address without a code is refused with what to paste", () => {
    expect(() => credentialFromAddress("http://127.0.0.1:7700/")).toThrow("paste the whole address");
    expect(() => credentialFromAddress("http://127.0.0.1:7700/#code=")).toThrow("paste the whole address");
    expect(() => credentialFromAddress("not an address #code=abc")).toThrow("paste the whole address");
  });

  test("a code or token with characters outside base64url is refused", () => {
    expect(() => credentialFromAddress("http://127.0.0.1:7700/#code=a%20b")).toThrow("characters Trackwall never gives out");
    expect(() => credentialFromAddress("http://127.0.0.1:7700/#token=a<b")).toThrow("characters Trackwall never gives out");
  });

  test("a forgotten token does not come back on the next visit", async () => {
    const env = fakeEnv("#token=old");
    await takeTokenFromLocation(env.location, env.history, env.storage, "start-1", NO_DAEMON);
    forgetToken(env.storage);
    expect(await takeTokenFromLocation(NO_FRAGMENT, env.history, env.storage, "start-1", NO_DAEMON)).toBeUndefined();
  });
});
