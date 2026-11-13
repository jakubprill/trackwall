import { describe, expect, test } from "bun:test";
import { alwaysAllowPattern, approvalWithin } from "../src/modules/agents/copilot-always-allow.ts";

// The labels are Copilot CLI 1.0.109's, seen on the real binary for each command in a contract run (ADR-249).
const RUN = "Do you want to run this command?";
const dialog = (question: string, second?: string) => ({
  question,
  options: [{ key: "1", label: "Yes" }, ...(second === undefined ? [] : [{ key: "2", label: second }])],
});

describe("the pattern Always allow takes from Copilot CLI's don't ask again option (ADR-249)", () => {
  test("one shell command becomes shell(command), with its subcommand or flag as Copilot CLI names it", () => {
    expect(alwaysAllowPattern(dialog(RUN, "Yes, and don't ask again for `npm test` in this repo (/projects/shop)"))).toBe(
      "shell(npm test)",
    );
    expect(alwaysAllowPattern(dialog(RUN, "Yes, and don't ask again for `mvn -q` in this repo (/projects/shop)"))).toBe("shell(mvn -q)");
  });

  test("an MCP tool becomes server(tool)", () => {
    const label = 'Yes, and don\'t ask again for tool "verify_task" from "trackwall" in this repo (/projects/shop)';
    expect(alwaysAllowPattern(dialog("Do you want to use this tool?", label))).toBe("trackwall(verify_task)");
  });

  test("two commands joined with and, a refused command, file operations and a path offer nothing", () => {
    expect(alwaysAllowPattern(dialog(RUN, "Yes, and don't ask again for `npm test` and `git push` in this repo (/p)"))).toBeNull();
    expect(alwaysAllowPattern(dialog(RUN, "Yes, and don't ask again for `git push` in this repo (/p)"))).toBeNull();
    expect(alwaysAllowPattern(dialog(RUN, "Yes, and don't ask again for `rm` in this repo (/p)"))).toBeNull();
    expect(alwaysAllowPattern(dialog(RUN, "Yes, and don't ask again for `bash` in this repo (/p)"))).toBeNull();
    expect(
      alwaysAllowPattern(dialog("Do you want to create /p/a.txt?", "Yes, and don't ask again for file operations when in this repo (/p)")),
    ).toBeNull();
    expect(alwaysAllowPattern(dialog("Do you want to allow this?", "Yes, and remember this path for this session"))).toBeNull();
  });

  test("a command without the option, such as a redirection or a PowerShell command on Windows, offers nothing", () => {
    expect(alwaysAllowPattern(dialog(RUN))).toBeNull();
  });
});

describe("whether a running task answers an approval of an always-allowed tool itself (ADR-249)", () => {
  test("only when the command shown is that one plain command with its arguments", () => {
    expect(approvalWithin({ detail: ["npm test -- --watch"] }, "shell(npm test)")).toBe(true);
    expect(approvalWithin({ detail: ["npm test"] }, "shell(npm test)")).toBe(true);
    expect(approvalWithin({ detail: ["npm testing"] }, "shell(npm test)")).toBe(false);
    expect(approvalWithin({ detail: ["npm test; cat ~/.aws/credentials"] }, "shell(npm test)")).toBe(false);
    expect(approvalWithin({ detail: ["npm test && git push"] }, "shell(npm test)")).toBe(false);
  });

  test("an MCP tool is the pattern itself, whatever its arguments", () => {
    expect(approvalWithin({ detail: ["{", '  "task": "abc"', "}"] }, "trackwall(verify_task)")).toBe(true);
  });
});
