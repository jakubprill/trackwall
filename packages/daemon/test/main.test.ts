import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonInfoResult } from "@trackwall/protocol";
import { readDaemonFile } from "../src/infra/discovery.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { RUNTIMES } from "./support/runtimes.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

/** Czeka na wartość; gdy podany proces skończy się wcześniej, kończy test od razu z jego kodem wyjścia. */
async function waitFor<T>(fn: () => T | undefined, proc?: { exitCode: number | null }, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (proc?.exitCode != null) throw new Error(`proces zakończył się kodem ${proc.exitCode}, zanim pojawiła się wartość`);
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

describe.each(RUNTIMES)("proces daemona pod %s", (name, runtime) => {
  test("start, drugi start z tą samą wersją kończy się 0, shutdown sprząta daemon.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-e2e-"));
    const env = { ...process.env, TRACKWALL_HOME: home };
    const daemon = Bun.spawn([...runtime, MAIN], { env, stdout: "ignore", stderr: "pipe" });
    try {
      const file = await waitFor(() => readDaemonFile(home), daemon);
      expect(file.pid).toBe(daemon.pid);

      const second = Bun.spawn([...runtime, MAIN], { env, stdout: "ignore", stderr: "pipe" });
      expect(await second.exited).toBe(0);
      expect(await new Response(second.stderr).text()).toContain("is already running");

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
    const home = mkdtempSync(join(tmpdir(), "trackwall-race-"));
    const env = { ...process.env, TRACKWALL_HOME: home };
    const procs = Array.from({ length: 5 }, () => Bun.spawn([...runtime, MAIN], { env, stdout: "ignore", stderr: "ignore" }));
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

  test("pusty TRACKWALL_HOME znaczy domyślny katalog ~/.trackwall, nie błąd", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "trackwall-userhome-"));
    // os.homedir(): HOME na Unixie, USERPROFILE na Windowsie.
    const env = { ...process.env, TRACKWALL_HOME: "", HOME: fakeHome, USERPROFILE: fakeHome };
    const daemon = Bun.spawn([...runtime, MAIN], { env, stdout: "ignore", stderr: "ignore" });
    try {
      const file = await waitFor(() => readDaemonFile(join(fakeHome, ".trackwall")), daemon);
      expect(file.pid).toBe(daemon.pid);
      await loopbackRequest(file.port, "/api/daemon/shutdown", { method: "POST", token: file.token });
      expect(await daemon.exited).toBe(0);
    } finally {
      daemon.kill();
    }
  }, 20_000);

  test("strona UI z --ui-dir jest serwowana, a info podaje runtime, pod którym działa daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-ui-"));
    const ui = mkdtempSync(join(tmpdir(), "trackwall-ui-dir-"));
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>trackwall-test</title>");
    const daemon = Bun.spawn([...runtime, MAIN, "--ui-dir", ui], {
      env: { ...process.env, TRACKWALL_HOME: home },
      stdout: "ignore",
      stderr: "inherit",
    });
    try {
      const file = await waitFor(() => readDaemonFile(home), daemon);
      const info = DaemonInfoResult.parse(JSON.parse((await loopbackRequest(file.port, "/api/daemon/info", { token: file.token })).body));
      expect(info.ok && info.data.runtime.name).toBe(name);
      expect((await loopbackRequest(file.port, "/")).body).toContain("<title>trackwall-test</title>");
      await loopbackRequest(file.port, "/api/daemon/shutdown", { method: "POST", token: file.token });
      expect(await daemon.exited).toBe(0);
    } finally {
      daemon.kill();
    }
  }, 20_000);

  test("zły argument kończy się kodem 2", async () => {
    const p = Bun.spawn([...runtime, MAIN, "--port", "abc"], { stdout: "ignore", stderr: "pipe" });
    expect(await p.exited).toBe(2);
  });
});
