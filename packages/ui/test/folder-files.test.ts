import { describe, expect, test } from "bun:test";
import { entryAction, entryPath } from "../src/lib/folder-files.ts";
import { formatBytes } from "../src/lib/format.ts";

describe("the Files panel of the Shell tab", () => {
  test("an entry's path joins its folder and name with a slash, and the folder itself is empty", () => {
    expect(entryPath("", "build")).toBe("build");
    expect(entryPath("build/libs", "shop-1.0.jar")).toBe("build/libs/shop-1.0.jar");
  });

  test("a folder opens, a file downloads, and a link or anything else does nothing", () => {
    expect(entryAction({ name: "build", kind: "folder", size: null })).toBe("open");
    expect(entryAction({ name: "app.jar", kind: "file", size: 12 })).toBe("download");
    expect(entryAction({ name: "root", kind: "link", size: null })).toBeNull();
    expect(entryAction({ name: "fifo", kind: "other", size: null })).toBeNull();
  });

  test("a size over a gigabyte is named in GB", () => {
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
  });
});
