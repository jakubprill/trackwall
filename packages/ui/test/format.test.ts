import { describe, expect, test } from "bun:test";
import { breadcrumbs, changesLabel, formatBytes, formatUptime, relativeTime, twoDigits, workingTreeLabel } from "../src/lib/format.ts";

describe("format", () => {
  const now = new Date("2026-10-23T12:00:00Z");

  test("relative time in English, older dates as a date", () => {
    expect(relativeTime("2026-10-23T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-23T11:15:00Z", now)).toBe("45 min ago");
    expect(relativeTime("2026-10-23T09:00:00+00:00", now)).toBe("3 h ago");
    expect(relativeTime("2026-10-22T10:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-10-18T12:00:00Z", now)).toBe("5 days ago");
    expect(relativeTime("2026-03-10T12:00:00", now)).toBe("Mar 10, 2026");
  });

  test("number of changes with an English plural, a clean repo without a label", () => {
    expect([0, 1, 2, 5, 12, 22, 25].map(changesLabel)).toEqual([
      undefined,
      "1 change",
      "2 changes",
      "5 changes",
      "12 changes",
      "22 changes",
      "25 changes",
    ]);
  });

  test("working directory: changed and new files separately, a clean repo without a label", () => {
    expect([workingTreeLabel(0, 0), workingTreeLabel(3, 0), workingTreeLabel(0, 1), workingTreeLabel(2, 5)]).toEqual([
      undefined,
      "3 changed",
      "1 new",
      "2 changed, 5 new",
    ]);
  });

  test("path breadcrumbs in a repo start from the root", () => {
    expect(breadcrumbs("")).toEqual([{ name: "/", path: "" }]);
    expect(breadcrumbs("src/lib")).toEqual([
      { name: "/", path: "" },
      { name: "src", path: "src" },
      { name: "lib", path: "src/lib" },
    ]);
  });

  test("daemon uptime in seconds, minutes and hours", () => {
    expect(formatUptime(5_000)).toBe("5 s");
    expect(formatUptime(125_000)).toBe("2 min 5 s");
    expect(formatUptime(3_725_000)).toBe("1 h 2 min");
  });

  test("file size in B, KB and MB", () => {
    expect([512, 2048, 3 * 1024 * 1024].map(formatBytes)).toEqual(["512 B", "2.0 KB", "3.0 MB"]);
  });

  test("a number in a list has at least two digits", () => {
    expect([1, 12, 120].map(twoDigits)).toEqual(["01", "12", "120"]);
  });
});
