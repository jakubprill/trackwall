import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

  test.skipIf(process.platform === "win32")("a link planted where the old temporary file went is not written through", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-aw-"));
    const outside = join(mkdtempSync(join(tmpdir(), "trackwall-aw-outside-")), ".bashrc");
    writeFileSync(outside, "the user's own\n");
    const target = join(dir, "item.md");
    symlinkSync(outside, `${target}.${process.pid}.tmp`);

    writeFileAtomic(target, "the item\n");

    expect(readFileSync(target, "utf8")).toBe("the item\n");
    expect(readFileSync(outside, "utf8")).toBe("the user's own\n");
  });
});
