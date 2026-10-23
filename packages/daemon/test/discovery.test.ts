import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonFilePath, newToken, readDaemonFile, removeDaemonFile, writeDaemonFile } from "../src/discovery.ts";

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
