import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerStartResult } from "@trackwall/protocol";
import { parseCommandLine } from "../src/infra/args.ts";
import { afterExit, DAEMON_LOG, restartDelayMs, supervisorPidFile } from "../src/infra/container-supervisor.ts";
import { readDaemonFile } from "../src/infra/discovery.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { RUNTIMES } from "./support/runtimes.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function runStart(runtime: string[], home: string, ...args: string[]) {
  const proc = Bun.spawn([...runtime, MAIN, "container", "start", "--home", home, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, out, result: ContainerStartResult.parse(JSON.parse(out)) };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = fn();
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error("timeout");
}

function stopEverything(home: string) {
  const file = readDaemonFile(home);
  const supervisor = existsSync(supervisorPidFile(home)) ? Number(readFileSync(supervisorPidFile(home), "utf8")) : undefined;
  for (const pid of [supervisor, file?.pid]) {
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

// Dev containers are Linux; the supervisor's own session and its signals are POSIX, so Windows does not run these.
describe.each(RUNTIMES)("trackwall-container start under %s (ADR-164)", (_name, runtime) => {
  test.skipIf(process.platform === "win32")(
    "starts a supervised daemon on the port, answers the same on a second call, starts the daemon again after a crash, and stops with it",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "trackwall-container-"));
      const port = await freePort();
      try {
        const first = await runStart(runtime, home, "--port", String(port));
        expect(first.code).toBe(0);
        expect(first.out.trim().split("\n")).toHaveLength(1);
        expect(first.result).toMatchObject({ ok: true, status: "running", port });
        const before = await waitFor(() => readDaemonFile(home));

        const second = await runStart(runtime, home, "--port", String(port));
        expect(second.result).toMatchObject({ ok: true, status: "running", port, daemon: { pid: before.pid } });

        process.kill(before.pid, "SIGKILL");
        const after = await waitFor(() => {
          const file = readDaemonFile(home);
          return file && file.pid !== before.pid ? file : undefined;
        });
        expect(after.port).toBe(port);
        expect(after.token).not.toBe(before.token);
        expect(readFileSync(join(home, DAEMON_LOG), "utf8")).toContain("starting it again in 1 s");

        await loopbackRequest(after.port, "/api/daemon/shutdown", { method: "POST", token: after.token });
        await waitFor(() => (existsSync(supervisorPidFile(home)) ? undefined : true));
        expect(readFileSync(join(home, DAEMON_LOG), "utf8")).toContain("the daemon ended with code 0; not starting it again");
      } finally {
        stopEverything(home);
      }
    },
    60_000,
  );

  test.skipIf(process.platform === "win32")(
    "two starts at once leave one supervisor and one daemon, and a PID file of another process does not stop a start",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "trackwall-container-"));
      const port = await freePort();
      // A PID file left from a previous container start, whose PID now belongs to an unrelated process.
      writeFileSync(supervisorPidFile(home), String(process.pid));
      try {
        const [a, b] = await Promise.all([
          runStart(runtime, home, "--port", String(port)),
          runStart(runtime, home, "--port", String(port)),
        ]);
        expect([a.result.ok, b.result.ok]).toEqual([true, true]);
        const daemon = await waitFor(() => readDaemonFile(home));
        expect(await runStart(runtime, home, "--port", String(port))).toMatchObject({
          result: { status: "running", daemon: { pid: daemon.pid } },
        });
        expect(Number(readFileSync(supervisorPidFile(home), "utf8"))).not.toBe(process.pid);
      } finally {
        stopEverything(home);
      }
    },
    60_000,
  );

  test.skipIf(process.platform === "win32")(
    "a state directory the supervisor cannot use ends in start-failed, still as JSON",
    async () => {
      const parent = mkdtempSync(join(tmpdir(), "trackwall-container-"));
      const home = join(parent, "a-file");
      writeFileSync(home, "not a folder");
      const { code, result } = await runStart(runtime, home, "--port", String(await freePort()));
      expect(code).toBe(1);
      expect(result).toMatchObject({ ok: false, error: { code: "start-failed" } });
    },
    30_000,
  );

  test("a wrong call still answers with one JSON object, with the code bad-arguments", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-container-"));
    const { code, result } = await runStart(runtime, home, "--port", "70000");
    expect(code).toBe(2);
    expect(result).toMatchObject({ ok: false, error: { code: "bad-arguments", message: "--port out of range 1-65535" } });
  });
});

describe("the container command's arguments and waits (ADR-164)", () => {
  test("the port defaults to the one the dev container guide forwards", () => {
    expect(parseCommandLine(["container", "start"])).toEqual({ command: "container", action: "start", port: 7700, home: undefined });
    expect(() => parseCommandLine(["container", "stop"])).toThrow('container expects start or update <version>, got "stop"');
  });

  test("the waits between restarts double from 1 s up to a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(restartDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  test("a crash is followed by a restart, a stop or another version ends the supervising, and so does a tenth crash in a row", () => {
    expect(afterExit({ code: 1, ranMs: 500, stopRequested: false }, 0)).toEqual({ kind: "restart", crashes: 1, delayMs: 1000 });
    expect(afterExit({ code: null, ranMs: 500, stopRequested: false }, 3)).toEqual({ kind: "restart", crashes: 4, delayMs: 8000 });
    expect(afterExit({ code: 1, ranMs: 120_000, stopRequested: false }, 7)).toEqual({ kind: "restart", crashes: 1, delayMs: 1000 });
    expect(afterExit({ code: 0, ranMs: 500, stopRequested: false }, 0)).toEqual({ kind: "final", code: 0 });
    expect(afterExit({ code: 3, ranMs: 500, stopRequested: false }, 0)).toEqual({ kind: "final", code: 3 });
    expect(afterExit({ code: null, ranMs: 500, stopRequested: true }, 0)).toMatchObject({
      kind: "stop",
      why: expect.stringContaining("stopped by a signal"),
    });
    expect(afterExit({ code: 1, ranMs: 500, stopRequested: false }, 9)).toMatchObject({
      kind: "stop",
      why: expect.stringContaining("crashed 10 times"),
    });
  });
});
