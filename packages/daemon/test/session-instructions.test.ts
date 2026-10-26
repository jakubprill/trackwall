import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_INSTRUCTIONS } from "@trackwall/protocol";
import { withInstructionsDir, writeSessionInstructions } from "../src/modules/agents/session-instructions.ts";

describe("Copilot CLI session instructions (ADR-46)", () => {
  test("a task session's file applies to the whole session and carries its role and the MCP instruction", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "trackwall-instructions-"));
    const dir = writeSessionInstructions(sessionDir, "0.3.0", { repo: "shop", task: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" });
    expect(dir).toBe(join(sessionDir, "instructions"));
    const text = readFileSync(join(sessionDir, "instructions", "trackwall.instructions.md"), "utf8");
    expect(text.startsWith('---\napplyTo: "**"\n---\n# Working in Trackwall\n')).toBe(true);
    expect(text).toContain("You run the task `1b4e28ba-2fa1-11d2-883f-0016d3cca427` in the repo `shop`");
    expect(text).toContain(
      "Do not switch branches, push, merge or open merge requests unless the task asks for it: the user pushes the branch and opens its merge request from Trackwall.",
    );
    expect(text).toContain("Your result becomes the description of the task's merge request");
    expect(text).toContain(
      "Build and test your changes with run_mise_task and task `1b4e28ba-2fa1-11d2-883f-0016d3cca427`: it runs the repo's mise tasks in this worktree",
    );
    expect(text).toContain(
      "Before you report that you are done, call verify_task with repo `shop` and task `1b4e28ba-2fa1-11d2-883f-0016d3cca427`",
    );
    expect(text).toContain("If the repo has no mise task test, do not add one");
    expect(text).toContain("When Trackwall asks you to call get_messages, the session that proposed your task has written to you");
    expect(text).toContain(MCP_INSTRUCTIONS);
  });

  test("every session learns which Trackwall version started it and where the user sees it", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "trackwall-instructions-"));
    writeSessionInstructions(sessionDir, "0.3.0", { repo: "shop", task: null });
    const text = readFileSync(join(sessionDir, "instructions", "trackwall.instructions.md"), "utf8");
    expect(text).toContain("Trackwall 0.3.0 started this Copilot CLI session");
    expect(text).toContain("The user sees this session in Trackwall's Sessions view");
  });

  test("a session in the repo root is a main session and does not get the task rules", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "trackwall-instructions-"));
    writeSessionInstructions(sessionDir, "0.3.0", { repo: "shop", task: null });
    const text = readFileSync(join(sessionDir, "instructions", "trackwall.instructions.md"), "utf8");
    expect(text).toContain("You are a main session in the root of the repo `shop`");
    expect(text).not.toContain("Work only in this worktree");
  });

  test("the supervisor in the projects folder coordinates through proposals and does not get the task rules", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "trackwall-instructions-"));
    writeSessionInstructions(sessionDir, "0.3.0", { repo: null, task: null });
    const text = readFileSync(join(sessionDir, "instructions", "trackwall.instructions.md"), "utf8");
    expect(text).toContain("The user sees this session in the supervisor panel on the right of every Trackwall view");
    expect(text).toContain("You are the supervisor: the one session above all others, in the projects folder");
    expect(text).toContain("You coordinate, you do not change code: hand each piece of work to an agent with propose_task");
    expect(text).toContain("Do not poll the work you delegated: end your turn");
    expect(text).toContain("Steer your tasks with send_message");
    expect(text).toContain("When the user starts their day in Trackwall, your first message asks for a briefing: read get_day_report once");
    expect(text).toContain(
      "a repo's remote (from list_repos) is its project path there, and a task's branch is the source branch of its merge request",
    );
    expect(text).not.toContain("main session in the root");
    expect(text).not.toContain("Work only in this worktree");
    expect(text).toContain(MCP_INSTRUCTIONS);
  });

  test("a session directory with a comma in its path gets no file, because the variable splits on commas", () => {
    const sessionDir = join(mkdtempSync(join(tmpdir(), "trackwall-instructions-")), "a,b");
    expect(writeSessionInstructions(sessionDir, "0.3.0", { repo: "shop", task: null })).toBeNull();
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("the session's directory goes after the user's own instruction directories, and the rest of the environment stays", () => {
    expect(withInstructionsDir({ PATH: "/bin", COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/mine" }, "/session")).toEqual({
      PATH: "/bin",
      COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/mine,/session",
    });
    expect(withInstructionsDir({}, "/session")).toEqual({ COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/session" });
  });

  test.if(process.platform === "win32")("on Windows the user's spelling of the variable is extended, not duplicated", () => {
    expect(withInstructionsDir({ Copilot_Custom_Instructions_Dirs: "C:\\mine" }, "C:\\session")).toEqual({
      Copilot_Custom_Instructions_Dirs: "C:\\mine,C:\\session",
    });
  });
});
