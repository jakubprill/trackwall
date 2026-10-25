import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/infra/atomic-write.ts";

describe("writeFileAtomic", () => {
  test("overwrites an existing file and leaves no temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-aw-"));
    const target = join(dir, "workspace.yaml");
    writeFileSync(target, "old content");

    writeFileAtomic(target, "new content");

    expect(readFileSync(target, "utf8")).toBe("new content");
    expect(readdirSync(dir)).toEqual(["workspace.yaml"]);
  });

  test("when the swap fails, the error propagates and the temporary file is cleaned up", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-aw-"));
    // A directory in place of the file: rename onto it fails on every system.
    mkdirSync(join(dir, "workspace.yaml"));
    writeFileSync(join(dir, "workspace.yaml", "content"), "x");

    expect(() => writeFileAtomic(join(dir, "workspace.yaml"), "content")).toThrow();

    expect(readdirSync(dir)).toEqual(["workspace.yaml"]);
  });
});
