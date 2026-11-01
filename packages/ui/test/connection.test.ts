import { describe, expect, test } from "bun:test";
import { forgetToken, takeTokenFromLocation, tokenFromAddress } from "../src/lib/connection.ts";

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

describe("token from the address", () => {
  test("the #token= fragment goes into storage, disappears from the address bar and serves a later visit without it", () => {
    const env = fakeEnv("#token=abc");
    expect(takeTokenFromLocation(env.location, env.history, env.storage, "start-1")).toBe("abc");
    expect(env.replaced).toEqual(["/"]);
    const reload = { ...env, location: { hash: "", pathname: "/", search: "" } as Location };
    expect(takeTokenFromLocation(reload.location, reload.history, env.storage, "start-1")).toBe("abc");
  });

  test("without a fragment and without a stored token there is no token (vite dev mode)", () => {
    const env = fakeEnv("");
    expect(takeTokenFromLocation(env.location, env.history, env.storage, "start-1")).toBeUndefined();
    expect(env.replaced).toEqual([]);
  });

  test("a token saved for another start of the daemon is forgotten instead of sent to whatever answers now", () => {
    const env = fakeEnv("#token=abc");
    takeTokenFromLocation(env.location, env.history, env.storage, "start-1");
    const reload = { hash: "", pathname: "/", search: "" } as Location;
    expect(takeTokenFromLocation(reload, env.history, env.storage, "start-2")).toBeUndefined();
    expect(takeTokenFromLocation(reload, env.history, env.storage, "start-1")).toBeUndefined();
  });
});

describe("token from a pasted address", () => {
  test("the token comes from the #token= fragment of the address the daemon prints", () => {
    expect(tokenFromAddress("http://127.0.0.1:7700/#token=Ab-_9")).toBe("Ab-_9");
    expect(tokenFromAddress("  http://localhost:7700/#token=xyz\n")).toBe("xyz");
  });

  test("an address without a token is refused with what to paste", () => {
    expect(() => tokenFromAddress("http://127.0.0.1:7700/")).toThrow("paste the whole address");
    expect(() => tokenFromAddress("http://127.0.0.1:7700/#token=")).toThrow("paste the whole address");
    expect(() => tokenFromAddress("not an address #token=abc")).toThrow("paste the whole address");
  });

  test("a token with characters outside base64url is refused", () => {
    expect(() => tokenFromAddress("http://127.0.0.1:7700/#token=a%20b")).toThrow("characters a daemon token never has");
    expect(() => tokenFromAddress("http://127.0.0.1:7700/#token=a<b")).toThrow("characters a daemon token never has");
  });

  test("a forgotten token does not come back on the next visit", () => {
    const env = fakeEnv("#token=old");
    takeTokenFromLocation(env.location, env.history, env.storage, "start-1");
    forgetToken(env.storage);
    const reload = { hash: "", pathname: "/", search: "" } as Location;
    expect(takeTokenFromLocation(reload, env.history, env.storage, "start-1")).toBeUndefined();
  });
});
