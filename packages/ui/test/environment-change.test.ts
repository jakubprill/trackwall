import { describe, expect, test } from "bun:test";
import { environmentChangeParts } from "../src/lib/environment-change.ts";

describe("a running session whose environment from mise changed (ADR-119)", () => {
  test("names each kind of change with its variables", () => {
    expect(
      environmentChangeParts({
        added: ["JIRA_TOKEN", "DEV_FLAG"],
        removed: ["OLD_FLAG"],
        changed: ["GITLAB_TOKEN"],
        shared: ["JIRA_TOKEN"],
        unshared: ["DEPLOY_KEY"],
      }),
    ).toEqual([
      "new: JIRA_TOKEN, DEV_FLAG",
      "changed: GITLAB_TOKEN",
      "removed: OLD_FLAG",
      "now for the agent's tools: JIRA_TOKEN",
      "no longer for the agent's tools: DEPLOY_KEY",
    ]);
  });

  test("leaves out the kinds without a change", () => {
    expect(environmentChangeParts({ added: [], removed: [], changed: ["GITLAB_TOKEN"], shared: [], unshared: [] })).toEqual([
      "changed: GITLAB_TOKEN",
    ]);
  });
});
