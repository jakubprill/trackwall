import { describe, expect, test } from "bun:test";
import { sandboxChoice, sandboxNote, sandboxNow, sandboxSettingsOf } from "../src/lib/sandbox.ts";

describe("what the New session form says about Copilot CLI's sandbox (ADR-181)", () => {
  test("a task without approvals under auto runs in it, and one that asks does not", () => {
    expect(sandboxNote({ tasks: "auto", problem: null, chosen: true }, "auto")).toEqual({ kind: "on" });
    expect(sandboxNote({ tasks: "auto", problem: null, chosen: true }, "ask")).toBeNull();
  });

  test("under all every task runs in it, and under off none", () => {
    expect(sandboxNote({ tasks: "all", problem: null, chosen: true }, "ask")).toEqual({ kind: "on" });
    expect(sandboxNote({ tasks: "off", problem: null, chosen: true }, "auto")).toBeNull();
  });

  test("a task that should run in it where it cannot run is said to be unavailable with the reason, before the start is refused", () => {
    expect(sandboxNote({ tasks: "auto", problem: "bubblewrap (bwrap) is not in PATH", chosen: true }, "auto")).toEqual({
      kind: "unavailable",
      problem: "bubblewrap (bwrap) is not in PATH",
    });
  });

  test("nothing is said before the daemon answered", () => {
    expect(sandboxNote(undefined, "auto")).toBeNull();
  });
});

describe("the sandbox choice in Settings › Agents (ADR-240)", () => {
  test("no key in workspace.yaml is Trackwall's default, and saving the default removes the key", () => {
    expect(sandboxChoice(null)).toBe("default");
    expect(sandboxSettingsOf("default")).toBeNull();
  });

  test("a key is its own choice, saved as the key", () => {
    expect(sandboxChoice({ tasks: "all" })).toBe("all");
    expect(sandboxSettingsOf("off")).toEqual({ tasks: "off" });
  });

  test("the line under the choice says which tasks run in the sandbox, and when that is the default here", () => {
    expect(sandboxNow({ tasks: "auto", problem: null, chosen: false })).toEqual({
      text: "Tasks you start without approvals run their commands in the sandbox, Trackwall's default here.",
      problem: null,
    });
    expect(sandboxNow({ tasks: "all", problem: null, chosen: true }).text).toBe("Every task you start runs its commands in the sandbox.");
  });

  test("where the sandbox cannot run, tasks that should run in it are refused, and with none in it the reason is only shown", () => {
    expect(sandboxNow({ tasks: "all", problem: "bubblewrap (bwrap) is not in PATH", chosen: true })).toEqual({
      text: "Every task you start runs its commands in the sandbox.",
      problem: {
        text: 'The sandbox cannot run on this computer: bubblewrap (bwrap) is not in PATH. Trackwall refuses to start these tasks until you install what it needs or choose "No task".',
        refused: true,
      },
    });
    expect(sandboxNow({ tasks: "off", problem: "no namespaces here", chosen: false })).toEqual({
      text: "No task you start runs its commands in the sandbox, Trackwall's default here.",
      problem: { text: "The sandbox cannot run on this computer: no namespaces here.", refused: false },
    });
  });
});
