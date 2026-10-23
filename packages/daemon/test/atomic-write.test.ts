import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/atomic-write.ts";

describe("writeFileAtomic", () => {
  test("nadpisuje istniejący plik i nie zostawia pliku tymczasowego", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-aw-"));
    const target = join(dir, "workspace.yaml");
    writeFileSync(target, "stara treść");

    writeFileAtomic(target, "nowa treść");

    expect(readFileSync(target, "utf8")).toBe("nowa treść");
    expect(readdirSync(dir)).toEqual(["workspace.yaml"]);
  });

  test("gdy podmiana się nie uda, błąd leci dalej, a plik tymczasowy jest sprzątany", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-aw-"));
    // Katalog w miejscu pliku: rename na niego kończy się błędem na każdym systemie.
    mkdirSync(join(dir, "workspace.yaml"));
    writeFileSync(join(dir, "workspace.yaml", "zawartosc"), "x");

    expect(() => writeFileAtomic(join(dir, "workspace.yaml"), "treść")).toThrow();

    expect(readdirSync(dir)).toEqual(["workspace.yaml"]);
  });
});
