import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerStartResult } from "@trackwall/protocol";
import { parseCommandLine } from "../src/infra/args.ts";
import { DAEMON_LOG, restartDelayMs, supervisorPidFile } from "../src/infra/container-supervisor.ts";
import { readDaemonFile } from "../src/infra/discovery.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function containerStart(home: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", MAIN, "container", "start", "--home", home, ...args], { stdout: "pipe", stderr: "pipe" });
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

describe("trackwall-container start (ADR-164)", () => {
  // Dev containers are Linux; the supervisor's own session and its signals are POSIX, so Windows does not run it.
  test.skipIf(process.platform === "win32")(
    "starts a supervised daemon on the port, answers the same on a second call, starts the daemon again after a crash, and stops with it",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "trackwall-container-"));
      const port = await freePort();
      try {
        const first = await containerStart(home, "--port", String(port));
        expect(first.code).toBe(0);
        expect(first.out.trim().split("\n")).toHaveLength(1);
        expect(first.result).toMatchObject({ ok: true, status: "running", port });
        const before = await waitFor(() => readDaemonFile(home));

        const second = await containerStart(home, "--port", String(port));
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

  test("a wrong call still answers with one JSON object, with the code bad-arguments", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-container-"));
    const { code, result } = await containerStart(home, "--port", "70000");
    expect(code).toBe(2);
    expect(result).toMatchObject({ ok: false, error: { code: "bad-arguments", message: "--port out of range 1-65535" } });
  });

  test("the port defaults to the one the dev container guide forwards", () => {
    expect(parseCommandLine(["container", "start"])).toEqual({ command: "container", action: "start", port: 7700, home: undefined });
    expect(() => parseCommandLine(["container", "stop"])).toThrow('container expects start, got "stop"');
  });

  test("the waits between restarts double from 1 s up to a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(restartDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });
});
