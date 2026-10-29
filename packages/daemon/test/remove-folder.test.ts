import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeFolder, removeIfPresent } from "../src/infra/remove-folder.ts";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rm failed`), { code });
}

describe("removing a folder", () => {
  test("a folder goes away with everything in it, and one that is not there is an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-remove-"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "file.txt"), "x");

    await removeFolder(dir);

    expect(existsSync(dir)).toBe(false);
    await expect(removeFolder(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a folder that may already be gone is removed if present, without an error when it is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-remove-"));

    await removeFolder(dir, removeIfPresent);
    await removeFolder(dir, removeIfPresent);

    expect(existsSync(dir)).toBe(false);
  });

  test("a file still held for a moment, as on Windows after git or a binary exits, is retried until it is free", async () => {
    const failures = ["EBUSY", "EPERM", "ENOTEMPTY"];
    const attempts: string[] = [];

    await removeFolder("C:\\worktrees\\shop-fix", async (path) => {
      attempts.push(path);
      const code = failures.shift();
      if (code !== undefined) throw errno(code);
    });

    expect(attempts).toEqual(["C:\\worktrees\\shop-fix", "C:\\worktrees\\shop-fix", "C:\\worktrees\\shop-fix", "C:\\worktrees\\shop-fix"]);
  });

  test("any other error is thrown at once", async () => {
    let attempts = 0;

    await expect(
      removeFolder("C:\\worktrees\\shop-fix", async () => {
        attempts++;
        throw errno("EACCES");
      }),
    ).rejects.toThrow("EACCES");
    expect(attempts).toBe(1);
  });

  test("a folder still held after the last of ten attempts is thrown", async () => {
    let attempts = 0;

    await expect(
      removeFolder("C:\\worktrees\\shop-fix", async () => {
        attempts++;
        throw errno("EBUSY");
      }),
    ).rejects.toThrow("EBUSY");
    expect(attempts).toBe(10);
  });
});
