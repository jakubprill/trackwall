import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegularFile, readRegularFile } from "../src/infra/regular-file.ts";

describe("a regular file opened under a limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-regular-file-"));
  writeFileSync(join(dir, "small.txt"), "hello");

  test("opens with its size, and the caller reads and closes it", async () => {
    const opened = await openRegularFile(join(dir, "small.txt"), 1024);
    if (!opened) throw new Error("the file was not opened");
    try {
      expect(opened.size).toBe(5);
      expect((await opened.handle.readFile()).toString("utf8")).toBe("hello");
    } finally {
      await opened.handle.close();
    }
  });

  test("a file over the limit, a folder or nothing at all is not opened", async () => {
    await expect(openRegularFile(join(dir, "small.txt"), 4)).rejects.toThrow("is larger than 0 KB");
    await expect(openRegularFile(dir, 1024)).rejects.toThrow("is not a regular file");
    expect(await openRegularFile(join(dir, "none.txt"), 1024)).toBeUndefined();
  });

  test("a limit of a megabyte or more is named in MB", async () => {
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(2 * 1024 ** 2 + 1));
    await expect(openRegularFile(join(dir, "big.bin"), 2 * 1024 ** 2)).rejects.toThrow("is larger than 2 MB");
    expect((await readRegularFile(join(dir, "small.txt"), 1024))?.toString("utf8")).toBe("hello");
  });
});
