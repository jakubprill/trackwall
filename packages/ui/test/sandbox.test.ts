import { describe, expect, test } from "bun:test";
import { sandboxNote } from "../src/lib/sandbox.ts";

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
