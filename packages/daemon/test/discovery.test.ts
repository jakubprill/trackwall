import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonFilePath,
  newToken,
  readDaemonFile,
  removeDaemonFile,
  watchDaemonFile,
  withStartLock,
  writeDaemonFile,
} from "../src/infra/discovery.ts";
import { trackwallHome } from "../src/infra/home.ts";

describe("discovery", () => {
  const file = { pid: 4242, port: 4321, token: newToken(), startedAt: "2026-10-23T00:00:00Z", version: "0.1.0" };

  test("writes and reads daemon.json", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    writeDaemonFile(home, file);
    expect(readDaemonFile(home)).toEqual(file);
    if (process.platform !== "win32") expect(statSync(daemonFilePath(home)).mode & 0o777).toBe(0o600);
  });

  test("a damaged file means no daemon", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    writeFileSync(daemonFilePath(home), "{not json");
    expect(readDaemonFile(home)).toBeUndefined();
  });

  test("removes only its own file", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    writeDaemonFile(home, file);
    removeDaemonFile(home, 1);
    expect(readDaemonFile(home)).toEqual(file);
    removeDaemonFile(home, 4242);
    expect(readDaemonFile(home)).toBeUndefined();
  });

  test("the token has 256 bits", () => {
    expect(Buffer.from(newToken(), "base64url").length).toBe(32);
  });
});

describe("start lock", () => {
  test("critical sections of different processes do not overlap", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-lock-"));
    const worker = join(import.meta.dir, "fixtures", "lock-worker.ts");
    const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", worker, home], { stdout: "ignore", stderr: "inherit" }));
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
    const trace = readFileSync(join(home, "trace"), "utf8").trim().split("\n");
    expect(trace).toHaveLength(8);
    // Every entry is immediately closed by an exit of the same process.
    for (let i = 0; i < trace.length; i += 2) expect(trace[i + 1]).toBe(`-${trace[i]?.slice(1)}`);
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
  }, 20_000);

  test("a lock with our own PID is a previous incarnation of the process (bun --watch)", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-lock-"));
    writeFileSync(join(home, "daemon.lock"), String(process.pid));
    expect(await withStartLock(home, async () => "ok", 1000)).toBe("ok");
  });

  test("a dead process's lock is taken over", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-lock-"));
    const dead = Bun.spawn(["bun", "-e", "0"]);
    await dead.exited;
    writeFileSync(join(home, "daemon.lock"), String(dead.pid));
    expect(await withStartLock(home, async () => "ok", 2000)).toBe("ok");
  });
});

describe("trackwallHome", () => {
  test("an empty variable means no variable", () => {
    const prev = process.env.TRACKWALL_HOME;
    process.env.TRACKWALL_HOME = "";
    try {
      expect(trackwallHome()).toBe(join(homedir(), ".trackwall"));
      const explicit = join(tmpdir(), "trackwall-explicit");
      expect(trackwallHome(explicit)).toBe(explicit);
    } finally {
      if (prev === undefined) delete process.env.TRACKWALL_HOME;
      else process.env.TRACKWALL_HOME = prev;
    }
  });
});

describe("watchDaemonFile", () => {
  const self = { pid: process.pid, port: 1, token: newToken(), startedAt: "x", version: "0.1.0" };

  test("recreates a removed file", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-watch-"));
    const stop = watchDaemonFile(home, self, () => {}, 20);
    await Bun.sleep(80);
    stop();
    expect(readDaemonFile(home)?.pid).toBe(process.pid);
  });

  test("steps aside when the file points to another live daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-watch-"));
    const other = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 5000)"]);
    try {
      writeDaemonFile(home, { ...self, pid: other.pid });
      let by: number | undefined;
      const stop = watchDaemonFile(
        home,
        self,
        (f) => {
          by = f.pid;
        },
        20,
      );
      await Bun.sleep(80);
      stop();
      expect(by).toBe(other.pid);
    } finally {
      other.kill();
    }
  });
});
