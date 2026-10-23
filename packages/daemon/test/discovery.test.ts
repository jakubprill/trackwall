import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { daemonFilePath, newToken, readDaemonFile, removeDaemonFile, withStartLock, writeDaemonFile } from "../src/discovery.ts";
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
  test("sekcje krytyczne nie nakładają się", async () => {
    const home = mkdtempSync(join(tmpdir(), "pitwall-lock-"));
    let inside = 0;
    let maxInside = 0;
    const work = () =>
      withStartLock(home, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await Bun.sleep(20);
        inside--;
      });
    await Promise.all([work(), work(), work()]);
    expect(maxInside).toBe(1);
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
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
