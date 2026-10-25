import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionToolPermissions } from "../src/modules/workspace/tool-permissions.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";

/** `workspace.yaml` with this text. */
function workspaceFile(text: string): WorkspaceFile {
  const path = join(mkdtempSync(join(tmpdir(), "trackwall-permissions-")), "workspace.yaml");
  writeFileSync(path, text);
  return new WorkspaceFile(path);
}

const RULES = `toolPermissions:
  - allow: ["shell(git status)"]
  - repos: ["orders-*"]
    allow: ["shell(mvn:*)", "shell(git status)"]
    deny: ["shell(git push)"]
  - repos: ["*-ui"]
    allow: ["shell(npm test)"]
`;

describe("tool permission rules from workspace.yaml (ADR-66)", () => {
  test("a session gets the patterns of every rule for its repo, without repeats", () => {
    const rules = workspaceFile(RULES).toolPermissionRules();

    expect(sessionToolPermissions(rules, "Orders-API")).toEqual({
      allow: ["shell(git status)", "shell(mvn:*)"],
      deny: ["shell(git push)"],
    });
    expect(sessionToolPermissions(rules, "shop-ui")).toEqual({ allow: ["shell(git status)", "shell(npm test)"], deny: [] });
  });

  test("the supervisor gets only the rules without repos", () => {
    const rules = workspaceFile(RULES).toolPermissionRules();

    expect(sessionToolPermissions(rules, null)).toEqual({ allow: ["shell(git status)"], deny: [] });
  });

  test("no key means no rules", () => {
    expect(workspaceFile("projectsDir:\n").toolPermissionRules()).toEqual([]);
  });

  test("a pattern that is not kind(argument) on one line is a configuration error of the key", () => {
    const file = workspaceFile('toolPermissions:\n  - deny: ["shell(git push)\\n--allow-all"]\n');

    expect(() => file.toolPermissionRules()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("toolPermissions") }),
    );
  });

  test("a misspelt rule key is a configuration error, not a rule that silently allows nothing", () => {
    const file = workspaceFile('toolPermissions:\n  - denny: ["shell(git push)"]\n');

    expect(() => file.toolPermissionRules()).toThrow(expect.objectContaining({ code: "invalid_config" }));
  });
});
