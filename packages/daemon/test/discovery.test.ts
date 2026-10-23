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
} from "../src/discovery.ts";
import { pitwallHome } from "../src/home.ts";

describe("discovery", () => {
  const file = { pid: 4242, port: 4321, token: newToken(), startedAt: "2026-10-23T00:00:00Z", version: "0.1.0" };

  test("zapis i odczyt daemon.json", () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-home-"));
    writeDaemonFile(home, file);
    expect(readDaemonFile(home)).toEqual(file);
    if (process.platform !== "win32") expect(statSync(daemonFilePath(home)).mode & 0o777).toBe(0o600);
  });

  test("uszkodzony plik to brak daemona", () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-home-"));
    writeFileSync(daemonFilePath(home), "{nie json");
    expect(readDaemonFile(home)).toBeUndefined();
  });

  test("usunięcie tylko własnego pliku", () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-home-"));
    writeDaemonFile(home, file);
    removeDaemonFile(home, 1);
    expect(readDaemonFile(home)).toEqual(file);
    removeDaemonFile(home, 4242);
    expect(readDaemonFile(home)).toBeUndefined();
  });

  test("token ma 256 bitów", () => {
    expect(Buffer.from(newToken(), "base64url").length).toBe(32);
  });
});

describe("blokada startu", () => {
  test("sekcje krytyczne różnych procesów nie nakładają się", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-lock-"));
    const worker = join(import.meta.dir, "fixtures", "lock-worker.ts");
    const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", worker, home], { stdout: "ignore", stderr: "inherit" }));
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
    const trace = readFileSync(join(home, "trace"), "utf8").trim().split("\n");
    expect(trace).toHaveLength(8);
    // Każde wejście jest od razu zamknięte wyjściem tego samego procesu.
    for (let i = 0; i < trace.length; i += 2) expect(trace[i + 1]).toBe(`-${trace[i]?.slice(1)}`);
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
  }, 20_000);

  test("blokada z własnym PID-em to poprzednie wcielenie procesu (bun --watch)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-lock-"));
    writeFileSync(join(home, "daemon.lock"), String(process.pid));
    expect(await withStartLock(home, async () => "ok", 1000)).toBe("ok");
  });

  test("blokada martwego procesu jest przejmowana", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-lock-"));
    const dead = Bun.spawn(["bun", "-e", "0"]);
    await dead.exited;
    writeFileSync(join(home, "daemon.lock"), String(dead.pid));
    expect(await withStartLock(home, async () => "ok", 2000)).toBe("ok");
  });
});

describe("pitwallHome", () => {
  test("pusta zmienna to brak zmiennej", () => {
    const prev = process.env.PITWALL_HOME;
    process.env.PITWALL_HOME = "";
    try {
      expect(pitwallHome()).toBe(join(homedir(), ".pitwall"));
      expect(pitwallHome("/x")).toBe("/x");
    } finally {
      if (prev === undefined) delete process.env.PITWALL_HOME;
      else process.env.PITWALL_HOME = prev;
    }
  });
});

describe("watchDaemonFile", () => {
  const self = { pid: process.pid, port: 1, token: newToken(), startedAt: "x", version: "0.1.0" };

  test("odtwarza usunięty plik", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-watch-"));
    const stop = watchDaemonFile(home, self, () => {}, 20);
    await Bun.sleep(80);
    stop();
    expect(readDaemonFile(home)?.pid).toBe(process.pid);
  });

  test("ustępuje, gdy plik wskazuje innego żywego daemona", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-watch-"));
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
