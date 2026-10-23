import { describe, expect, test } from "bun:test";
import { parseDaemonArgs } from "../src/args.ts";

describe("argumenty", () => {
  test("domyślne", () => {
    expect(parseDaemonArgs([])).toMatchObject({ port: 0, ui: false, allowOrigins: [], help: false });
  });

  test("--parent i --allow-origin", () => {
    const a = parseDaemonArgs(["--parent", "123", "--allow-origin", "http://127.0.0.1:5173"]);
    expect(a.parent).toBe(123);
    expect(a.allowOrigins).toEqual(["http://127.0.0.1:5173"]);
  });

  test("--allow-origin spoza loopbacku jest odrzucany", () => {
    expect(() => parseDaemonArgs(["--allow-origin", "https://evil.example"])).toThrow();
    expect(() => parseDaemonArgs(["--allow-origin", "http://127.0.0.1.evil.example:80"])).toThrow();
  });

  test("zły port", () => {
    expect(() => parseDaemonArgs(["--port", "70000"])).toThrow();
    expect(() => parseDaemonArgs(["--port", "1.5"])).toThrow();
    expect(() => parseDaemonArgs(["--nieznana"])).toThrow();
  });
});
