import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiResult, CardWarmupProgress, DaemonInfoResult, ErrorJournal } from "@trackwall/protocol";
import { readDaemonFile } from "../src/infra/discovery.ts";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { makeRepo } from "./support/git-repo.ts";
import { RUNTIMES } from "./support/runtimes.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

/** Waits for a value; when the given process ends first, ends the test at once with its exit code. */
async function waitFor<T>(fn: () => T | undefined, proc?: { exitCode: number | null }, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (proc?.exitCode != null) throw new Error(`the process exited with code ${proc.exitCode} before the value appeared`);
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

describe.each(RUNTIMES)("daemon process under %s", (name, runtime) => {
  test("start, a second start with the same version exits with 0, shutdown cleans up daemon.json", async () => {
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

  test("simultaneous starts leave exactly one daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-race-"));
    const env = { ...process.env, TRACKWALL_HOME: home };
    const procs = Array.from({ length: 5 }, () => Bun.spawn([...runtime, MAIN], { env, stdout: "ignore", stderr: "pipe" }));
    try {
      const file = await waitFor(() => readDaemonFile(home));
      // The losers exit by themselves with code 0; the winner keeps running. A loser's stderr says why it did not.
      const losers = procs.filter((p) => p.pid !== file.pid);
      const ended = await Promise.all(losers.map(async (p) => ({ code: await p.exited, stderr: await new Response(p.stderr).text() })));
      expect(ended.filter((loser) => loser.code !== 0)).toEqual([]);
      expect(procs.filter((p) => isAlive(p.pid)).map((p) => p.pid)).toEqual([file.pid]);
    } finally {
      for (const p of procs) p.kill();
    }
  }, 30_000);

  test("an empty TRACKWALL_HOME means the default directory ~/.trackwall, not an error", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "trackwall-userhome-"));
    // os.homedir(): HOME on Unix, USERPROFILE on Windows.
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

  test("the UI page from --ui-dir is served, and info gives the runtime the daemon runs under", async () => {
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

  test("after the start the daemon computes the cards of the repos in the projects folder by itself", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-warmup-"));
    const projects = mkdtempSync(join(tmpdir(), "trackwall-warmup-projects-"));
    makeRepo({ "package.json": JSON.stringify({ name: "web", private: true }) }, "web", projects);
    writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projects)}\n`);
    const daemon = Bun.spawn([...runtime, MAIN], { env: { ...process.env, TRACKWALL_HOME: home }, stdout: "ignore", stderr: "inherit" });
    try {
      const file = await waitFor(() => readDaemonFile(home), daemon);
      const warmup = async () => {
        const res = await loopbackRequest(file.port, "/api/cards/warmup", { method: "POST", token: file.token });
        const result = apiResult(CardWarmupProgress).parse(JSON.parse(res.body));
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      };
      let progress = await warmup();
      for (const until = Date.now() + 10_000; Date.now() < until && (progress.running || progress.done === 0); ) {
        await Bun.sleep(50);
        progress = await warmup();
      }
      expect(progress).toEqual({ running: false, done: 1, total: 1 });
      await loopbackRequest(file.port, "/api/daemon/shutdown", { method: "POST", token: file.token });
      expect(await daemon.exited).toBe(0);
    } finally {
      daemon.kill();
    }
  }, 20_000);

  test("a start that fails exits with 1 and leaves its error in the error journal", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-failed-start-"));
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    try {
      const port = (taken.address() as AddressInfo).port;
      const env = { ...process.env, TRACKWALL_HOME: home };
      const daemon = Bun.spawn([...runtime, MAIN, "--port", String(port)], { env, stdout: "ignore", stderr: "pipe" });
      expect(await daemon.exited).toBe(1);
      const journal = ErrorJournal.parse(JSON.parse(readFileSync(join(home, "logs", "errors.json"), "utf8")));
      expect(journal.errors.map((e) => [e.source, e.area, e.count])).toEqual([["daemon", "startup", 1]]);
      expect(journal.errors[0]?.message).toMatch(/EADDRINUSE|in use/);
      expect(journal.errors[0]?.message).not.toContain(home);
    } finally {
      taken.close();
    }
  }, 20_000);

  test("a bad argument exits with code 2", async () => {
    const p = Bun.spawn([...runtime, MAIN, "--port", "abc"], { stdout: "ignore", stderr: "pipe" });
    expect(await p.exited).toBe(2);
  });
});
