import { describe, expect, test } from "bun:test";
import { takeTokenFromLocation } from "../src/lib/connection.ts";

function fakeEnv(hash: string) {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  } as unknown as Storage;
  const replaced: string[] = [];
  const history = { replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url) } as unknown as History;
  const location = { hash, pathname: "/", search: "" } as Location;
  return { storage, history, location, replaced };
}

describe("token from the address", () => {
  test("the #token= fragment goes into sessionStorage and disappears from the address bar", () => {
    const env = fakeEnv("#token=abc");
    expect(takeTokenFromLocation(env.location, env.history, env.storage)).toBe("abc");
    expect(env.replaced).toEqual(["/"]);
    const reload = { ...env, location: { hash: "", pathname: "/", search: "" } as Location };
    expect(takeTokenFromLocation(reload.location, reload.history, env.storage)).toBe("abc");
  });

  test("without a fragment and without a stored token there is no token (vite dev mode)", () => {
    const env = fakeEnv("");
    expect(takeTokenFromLocation(env.location, env.history, env.storage)).toBeUndefined();
    expect(env.replaced).toEqual([]);
  });
});
