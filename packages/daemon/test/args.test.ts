import { describe, expect, test } from "bun:test";
import { containerProxyPort, parseCommandLine, parseDaemonArgs } from "../src/infra/args.ts";

describe("arguments", () => {
  test("defaults", () => {
    expect(parseDaemonArgs([])).toMatchObject({ port: 0, proxyPort: null, ui: false, allowOrigins: [], help: false });
  });

  test("--proxy-port runs the service proxy on that port; 0 and out of range are refused", () => {
    expect(parseDaemonArgs(["--proxy-port", "7701"]).proxyPort).toBe(7701);
    expect(() => parseDaemonArgs(["--proxy-port", "0"])).toThrow();
    expect(() => parseDaemonArgs(["--proxy-port", "70000"])).toThrow();
  });

  test("in a dev container the service proxy takes the port after the daemon's, and none after the last port", () => {
    expect(containerProxyPort(7700)).toBe(7701);
    expect(containerProxyPort(65535)).toBeNull();
  });

  test("--parent and --allow-origin", () => {
    const a = parseDaemonArgs(["--parent", "123", "--allow-origin", "http://127.0.0.1:5173"]);
    expect(a.parent).toBe(123);
    expect(a.allowOrigins).toEqual(["http://127.0.0.1:5173"]);
  });

  test("--allow-origin outside loopback is rejected", () => {
    expect(() => parseDaemonArgs(["--allow-origin", "https://evil.example"])).toThrow();
    expect(() => parseDaemonArgs(["--allow-origin", "http://127.0.0.1.evil.example:80"])).toThrow();
  });

  test("a bad port", () => {
    expect(() => parseDaemonArgs(["--port", "70000"])).toThrow();
    expect(() => parseDaemonArgs(["--port", "1.5"])).toThrow();
    expect(() => parseDaemonArgs(["--unknown"])).toThrow();
  });

  test("mcp-stdio as the first argument starts the bridge with an optional --home, without daemon options", () => {
    expect(parseCommandLine(["mcp-stdio"])).toEqual({ command: "mcp-stdio", home: undefined });
    expect(parseCommandLine(["mcp-stdio", "--home", "/state"])).toEqual({ command: "mcp-stdio", home: "/state" });
    expect(() => parseCommandLine(["mcp-stdio", "--session-token-file", "/state/sessions/s1/session-token"])).toThrow();
    expect(() => parseCommandLine(["mcp-stdio", "--port", "1"])).toThrow();
    expect(parseCommandLine(["--port", "7"])).toMatchObject({ command: "daemon", args: { port: 7 } });
  });

  test("address as the first argument prints the page address, with an optional --home and no daemon options", () => {
    expect(parseCommandLine(["address"])).toEqual({ command: "address", home: undefined });
    expect(parseCommandLine(["address", "--home", "/state"])).toEqual({ command: "address", home: "/state" });
    expect(() => parseCommandLine(["address", "--port", "7700"])).toThrow();
  });
});
