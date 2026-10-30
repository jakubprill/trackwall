import { describe, expect, test } from "bun:test";
import { measureExploration, sharedToolName, shellCommandReads, spread, toolKind } from "../scripts/exploration/measure.ts";

describe("a shell command that only reads", () => {
  test("is a command whose every program reads", () => {
    expect(shellCommandReads("rg -n 'PriceController' src | head -20")).toBe(true);
    expect(shellCommandReads("cd src && ls -la; git log --oneline -5")).toBe(true);
    expect(shellCommandReads("Get-ChildItem -Recurse | Select-String Price")).toBe(true);
  });

  test("is not a command that builds, writes or runs anything else", () => {
    expect(shellCommandReads("mvn -q test")).toBe(false);
    expect(shellCommandReads("cat a.txt && rm a.txt")).toBe(false);
    expect(shellCommandReads("git commit -m wip")).toBe(false);
    expect(shellCommandReads("")).toBe(false);
    expect(shellCommandReads("ls\nrm -rf src")).toBe(false);
    expect(shellCommandReads("find . -name '*.tmp' -delete")).toBe(false);
    expect(shellCommandReads("find . -name '*.tmp' -exec rm {} ;")).toBe(false);
    expect(shellCommandReads("git branch -D old")).toBe(false);
  });
});

describe("the kind of a tool call", () => {
  test("follows the tool name, and a shell call its command", () => {
    expect(toolKind("view", {}, undefined)).toBe("read");
    expect(toolKind("lsp", {}, undefined)).toBe("read");
    expect(toolKind("apply_patch", {}, undefined)).toBe("edit");
    expect(toolKind("trackwall-find_endpoint", {}, undefined)).toBe("trackwall");
    expect(toolKind("task", {}, undefined)).toBe("subagent");
    expect(toolKind("report_intent", {}, undefined)).toBe("meta");
    expect(toolKind("bash", { command: "grep -rn price src" }, { hasWriteFileRedirection: false })).toBe("read");
    expect(toolKind("bash", { command: "./gradlew test" }, { hasWriteFileRedirection: false })).toBe("other");
  });

  test("is an edit for a shell command that writes a file through a redirection", () => {
    expect(toolKind("bash", { command: "cat > Price.java" }, { hasWriteFileRedirection: true })).toBe("edit");
  });
});

const event = (type: string, timestamp: string, data: unknown = {}) => JSON.stringify({ type, timestamp, data });

describe("the look around of a session", () => {
  test("counts from the first prompt up to the first edit", () => {
    const lines = [
      event("session.start", "2026-10-30T10:00:00.000Z"),
      event("user.message", "2026-10-30T10:00:05.000Z", { content: "change the price format" }),
      event("assistant.turn_start", "2026-10-30T10:00:06.000Z"),
      event("session.usage_record", "2026-10-30T10:00:08.000Z", { usage: { inputTokens: 12000 } }),
      event("tool.execution_start", "2026-10-30T10:00:09.000Z", { toolName: "report_intent", arguments: {} }),
      event("tool.execution_start", "2026-10-30T10:00:09.000Z", { toolName: "grep", arguments: { pattern: "price" } }),
      event("tool.execution_start", "2026-10-30T10:00:10.000Z", { toolName: "view", arguments: { path: "Price.java" } }),
      event("assistant.turn_start", "2026-10-30T10:00:20.000Z"),
      event("session.usage_record", "2026-10-30T10:00:25.000Z", { usage: { inputTokens: 15000 } }),
      event("tool.execution_start", "2026-10-30T10:00:26.000Z", { toolName: "trackwall-who_calls", arguments: {} }),
      event("tool.execution_start", "2026-10-30T10:01:35.000Z", { toolName: "edit", arguments: {} }),
      event("tool.execution_start", "2026-10-30T10:01:40.000Z", { toolName: "view", arguments: {} }),
    ];

    expect(measureExploration(lines)).toEqual({
      startedAt: "2026-10-30T10:00:05.000Z",
      edited: true,
      calls: { read: 2, trackwall: 1, subagent: 0, other: 0 },
      tools: { grep: 1, view: 1, "trackwall-who_calls": 1 },
      turns: 2,
      inputTokens: 27000,
      seconds: 90,
    });
  });

  test("covers the whole session when it never edits, and skips lines of another shape", () => {
    const lines = [
      event("user.message", "2026-10-30T10:00:00.000Z"),
      "not json",
      JSON.stringify({ type: "tool.execution_start" }),
      event("tool.execution_start", "2026-10-30T10:00:30.000Z", { toolName: "glob", arguments: {} }),
      "",
    ];

    expect(measureExploration(lines)).toMatchObject({ edited: false, calls: { read: 1 }, seconds: 30 });
  });

  test("is nothing for a session that never got a prompt", () => {
    expect(measureExploration([event("session.start", "2026-10-30T10:00:00.000Z")])).toBeUndefined();
  });
});

describe("the name a tool is shown with", () => {
  test("hides the server of another MCP tool and keeps built-in and Trackwall tools", () => {
    expect(sharedToolName("view")).toBe("view");
    expect(sharedToolName("apply_patch")).toBe("apply_patch");
    expect(sharedToolName("trackwall-who_calls")).toBe("trackwall-who_calls");
    expect(sharedToolName("acme-tracker-get_issue")).toBe("other MCP");
  });
});

describe("the spread of the numbers", () => {
  test("is the median, the 75th percentile and the largest", () => {
    expect(spread([9, 1, 4, 2, 30, 6, 3, 12])).toEqual({ median: 6, p75: 12, max: 30 });
    expect(spread([])).toEqual({ median: 0, p75: 0, max: 0 });
  });
});
