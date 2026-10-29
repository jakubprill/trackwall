import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeFolder } from "./support/remove-folder.ts";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rm failed`), { code });
}

describe("removing a test's folder", () => {
  test("a folder goes away with everything in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-remove-"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "file.txt"), "x");

    removeFolder(dir);

    expect(existsSync(dir)).toBe(false);
  });

  test("a file still held for a moment, as a binary that just exited on Windows, is retried until it is free", () => {
    const failures = ["EBUSY", "EPERM", "ENOTEMPTY"];
    const attempts: string[] = [];

    removeFolder("C:\\temp\\probe", (path) => {
      attempts.push(path);
      const code = failures.shift();
      if (code !== undefined) throw errno(code);
    });

    expect(attempts).toEqual(["C:\\temp\\probe", "C:\\temp\\probe", "C:\\temp\\probe", "C:\\temp\\probe"]);
  });

  test("any other error is thrown at once", () => {
    let attempts = 0;

    expect(() =>
      removeFolder("C:\\temp\\probe", () => {
        attempts++;
        throw errno("EACCES");
      }),
    ).toThrow("EACCES");
    expect(attempts).toBe(1);
  });

  test("a folder still held after the last of ten attempts is thrown", () => {
    let attempts = 0;

    expect(() =>
      removeFolder("C:\\temp\\probe", () => {
        attempts++;
        throw errno("EBUSY");
      }),
    ).toThrow("EBUSY");
    expect(attempts).toBe(10);
  });
});
