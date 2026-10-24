import { describe, expect, test } from "bun:test";
import { progressLabel, UpdateCheck } from "../src/lib/updates.ts";

describe("app update", () => {
  test("the download progress shows both sizes and the percentage", () => {
    expect(progressLabel({ downloaded: 12 * 1024 * 1024, total: 40 * 1024 * 1024 })).toBe("12.0 MB of 40.0 MB (30%)");
  });

  test("without the total size the progress shows only what has been downloaded", () => {
    expect(progressLabel({ downloaded: 512, total: null })).toBe("512 B");
  });

  test("the shell's check result says which newer version is available, or null when this one is the latest", () => {
    expect(UpdateCheck.parse({ currentVersion: "0.3.0", available: "0.3.1" })).toEqual({ currentVersion: "0.3.0", available: "0.3.1" });
    expect(UpdateCheck.parse({ currentVersion: "0.3.1", available: null }).available).toBeNull();
  });
});
