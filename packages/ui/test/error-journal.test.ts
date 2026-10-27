import { describe, expect, test } from "bun:test";
import type { TrackwallError } from "@trackwall/protocol";
import { errorJournalEntry } from "../src/lib/error-journal.ts";
import { UiErrorGate, uiErrorReport } from "../src/lib/ui-error-report.ts";

const ERROR: TrackwallError = {
  fingerprint: "a3f9c2e1b0d4",
  source: "daemon",
  area: "api:/api/workspace/sync",
  kind: "TypeError",
  message: "Cannot read properties of undefined (reading 'branch')",
  frames: ["packages/daemon/src/a.ts:1", "packages/daemon/src/b.ts:2", "packages/daemon/src/c.ts:3", "packages/daemon/src/d.ts:4"],
  count: 3,
  firstSeen: "2026-10-27T08:00:00Z",
  lastSeen: "2026-10-27T09:55:00Z",
  version: "0.5.5",
};

describe("error journal entry", () => {
  test("names the part of Trackwall and the area, counts, says when and shows the top three frames", () => {
    expect(errorJournalEntry(ERROR, new Date("2026-10-27T10:00:00Z"))).toEqual({
      title: "Daemon · /api/workspace/sync",
      detail: "TypeError · 3 times · last 5 min ago · 0.5.5",
      message: "Cannot read properties of undefined (reading 'branch')",
      frames: ["packages/daemon/src/a.ts:1", "packages/daemon/src/b.ts:2", "packages/daemon/src/c.ts:3"],
    });
  });

  test("an error seen once from the desktop app", () => {
    const entry = errorJournalEntry({ ...ERROR, source: "shell", area: "shell:badge", count: 1 }, new Date("2026-10-27T10:00:00Z"));
    expect(entry.title).toBe("Desktop app · badge");
    expect(entry.detail).toBe("TypeError · 1 time · last 5 min ago · 0.5.5");
  });
});

describe("UI error report", () => {
  test("an Error goes with its name, message and stack; anything else thrown gets a message of its own", () => {
    const err = new RangeError("too far");
    expect(uiErrorReport(err, "window")).toEqual({ page: "window", name: "RangeError", message: "too far", stack: err.stack ?? "" });
    expect(uiErrorReport("plain text", "tray-panel")).toMatchObject({ page: "tray-panel", name: "Error", message: "plain text" });
    expect(uiErrorReport({ code: 1 }, "window").message).toBe("a value that is not an Error was thrown");
  });

  test("a message longer than the daemon takes is cut to its limit", () => {
    expect(uiErrorReport(new Error("x".repeat(10_000)), "window").message).toHaveLength(4000);
  });

  test("the same error goes once a minute, and at most twenty a minute in all", () => {
    const gate = new UiErrorGate();
    const report = uiErrorReport(new Error("loop"), "window");
    expect(gate.allow(report, 0)).toBe(true);
    expect(gate.allow(report, 30_000)).toBe(false);
    expect(gate.allow(report, 60_000)).toBe(true);
    const others = Array.from({ length: 25 }, (_, i) => gate.allow({ ...report, message: `other ${i}` }, 61_000));
    expect(others.filter(Boolean)).toHaveLength(19);
  });
});
