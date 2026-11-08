import { describe, expect, test } from "bun:test";
import { sharedFilesFootnote, sharedFilesHeadline } from "../src/lib/shared-files.ts";

describe("shared files warning", () => {
  test("names the conflicting files and counts the shared files that merge cleanly", () => {
    expect(sharedFilesHeadline({ files: 3, conflicts: 1 }, "the task “Discount apples”")).toBe(
      "1 conflicting file with the task “Discount apples”; 2 other shared files merge cleanly",
    );
    expect(sharedFilesHeadline({ files: 2, conflicts: 2 }, "the task “Discount apples”")).toBe(
      "2 conflicting files with the task “Discount apples”",
    );
  });

  test("without a conflict, or without a trial merge, only counts the shared files", () => {
    expect(sharedFilesHeadline({ files: 1, conflicts: 0 }, "the task “Limes”")).toBe("1 file is also changed by the task “Limes”");
    expect(sharedFilesHeadline({ files: 2, conflicts: null }, "the task “Limes”")).toBe("2 files are also changed by the task “Limes”");
  });

  test("the note says a clean merge only when git tried every merge and none conflicts", () => {
    expect(sharedFilesFootnote([{ files: 1, conflicts: 0 }])).toBe(
      "What both tasks committed so far merges cleanly. Work they have not committed yet may still conflict.",
    );
    expect(
      sharedFilesFootnote([
        { files: 1, conflicts: 0 },
        { files: 1, conflicts: null },
      ]),
    ).toBe("Both tasks change these files. The one merged second may get a conflict.");
    expect(
      sharedFilesFootnote([
        { files: 1, conflicts: null },
        { files: 2, conflicts: 1 },
      ]),
    ).toBe(
      "Merging what both tasks committed so far conflicts in the conflicting files. The task merged second will have to resolve them.",
    );
  });
});
