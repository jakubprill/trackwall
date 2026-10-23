import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonInfoResult } from "@pitwall/protocol";
import { readDaemonFile } from "../src/discovery.ts";
import { loopbackRequest } from "../src/loopback.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = fn();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error("timeout");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("proces daemona", () => {
  test("start, drugi start z tą samą wersją kończy się 0, shutdown sprząta daemon.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-e2e-"));
    const env = { ...process.env, PITWALL_HOME: home };
    const daemon = Bun.spawn(["bun", MAIN], { env, stdout: "ignore", stderr: "pipe" });
    try {
      const file = await waitFor(() => readDaemonFile(home));
      expect(file.pid).toBe(daemon.pid);

      const second = Bun.spawn(["bun", MAIN], { env, stdout: "ignore", stderr: "pipe" });
      expect(await second.exited).toBe(0);
      expect(await new Response(second.stderr).text()).toContain("już działa");

      const info = DaemonInfoResult.parse(JSON.parse((await loopbackRequest(file.port, "/api/daemon/info", { token: file.token })).body));
      expect(info.ok && info.data.launchedBy).toBe("manual");

      await loopbackRequest(file.port, "/api/daemon/shutdown", { method: "POST", token: file.token });
      expect(await daemon.exited).toBe(0);
      expect(readDaemonFile(home)).toBeUndefined();
    } finally {
      daemon.kill();
    }
  }, 20_000);

  test("równoczesne starty zostawiają dokładnie jeden daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-race-"));
    const env = { ...process.env, PITWALL_HOME: home };
    const procs = Array.from({ length: 5 }, () => Bun.spawn(["bun", MAIN], { env, stdout: "ignore", stderr: "ignore" }));
    try {
      const file = await waitFor(() => readDaemonFile(home));
      // Przegrani kończą się sami kodem 0; zwycięzca działa dalej.
      const losers = procs.filter((p) => p.pid !== file.pid);
      expect(await Promise.all(losers.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
      expect(procs.filter((p) => isAlive(p.pid)).map((p) => p.pid)).toEqual([file.pid]);
    } finally {
      for (const p of procs) p.kill();
    }
  }, 30_000);

  test("pusty PITWALL_HOME znaczy domyślny katalog, nie błąd", async () => {
    const p = Bun.spawn(["bun", MAIN, "--version"], { env: { ...process.env, PITWALL_HOME: "" }, stdout: "pipe" });
    expect(await p.exited).toBe(0);
  });

  test("zły argument kończy się kodem 2", async () => {
    const p = Bun.spawn(["bun", MAIN, "--port", "abc"], { stdout: "ignore", stderr: "pipe" });
    expect(await p.exited).toBe(2);
  });
});
