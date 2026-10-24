import { describe, expect, test } from "bun:test";
import { takeTokenFromLocation } from "../src/lib/connection.ts";
import { formatUptime } from "../src/views/daemon/DaemonPanel.tsx";

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

describe("token z adresu", () => {
  test("fragment #token= trafia do sessionStorage i znika z paska adresu", () => {
    const env = fakeEnv("#token=abc");
    expect(takeTokenFromLocation(env.location, env.history, env.storage)).toBe("abc");
    expect(env.replaced).toEqual(["/"]);
    const reload = { ...env, location: { hash: "", pathname: "/", search: "" } as Location };
    expect(takeTokenFromLocation(reload.location, reload.history, env.storage)).toBe("abc");
  });

  test("bez fragmentu i bez zapisu nie ma tokenu (tryb vite dev)", () => {
    const env = fakeEnv("");
    expect(takeTokenFromLocation(env.location, env.history, env.storage)).toBeUndefined();
    expect(env.replaced).toEqual([]);
  });
});

describe("formatUptime", () => {
  test("sekundy, minuty, godziny", () => {
    expect(formatUptime(5_000)).toBe("5 s");
    expect(formatUptime(125_000)).toBe("2 min 5 s");
    expect(formatUptime(3_725_000)).toBe("1 h 2 min");
  });
});
