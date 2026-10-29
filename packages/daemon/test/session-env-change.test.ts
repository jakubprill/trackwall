import { describe, expect, test } from "bun:test";
import { sessionMiseLaunch } from "../src/modules/agents/session-env.ts";
import { environmentChange, environmentSnapshot, newDigestKey } from "../src/modules/agents/session-env-change.ts";

const KEY = newDigestKey();

function snapshot(vars: Record<string, string>, secretNames: string[], agentSecrets: string[]) {
  const mise = { vars, secretNames, secretValues: secretNames.map((name) => vars[name] ?? ""), problem: null };
  return environmentSnapshot(mise, sessionMiseLaunch(mise, {}, agentSecrets), KEY);
}

describe("a running session's environment against the one mise gives now (ADR-119)", () => {
  test("the same variables with the same values are no change", () => {
    const started = snapshot({ MAVEN_OPTS: "-Xmx2g", GITLAB_TOKEN: "glpat-1" }, ["GITLAB_TOKEN"], []);
    const now = snapshot({ GITLAB_TOKEN: "glpat-1", MAVEN_OPTS: "-Xmx2g" }, ["GITLAB_TOKEN"], []);

    expect(environmentChange(started, now)).toBeNull();
  });

  test("a new token in mise.toml and a name added to agentSecrets are named, a removed variable too", () => {
    const started = snapshot({ MAVEN_OPTS: "-Xmx2g", OLD_FLAG: "1" }, [], []);
    const now = snapshot({ MAVEN_OPTS: "-Xmx2g", JIRA_TOKEN: "jira-1" }, ["JIRA_TOKEN"], ["JIRA_TOKEN"]);

    expect(environmentChange(started, now)).toEqual({
      added: ["JIRA_TOKEN"],
      removed: ["OLD_FLAG"],
      changed: [],
      shared: ["JIRA_TOKEN"],
      unshared: [],
    });
  });

  test("a value that changed is named without the value, and a secret taken out of agentSecrets is unshared", () => {
    const started = snapshot({ GITLAB_TOKEN: "glpat-1", JIRA_TOKEN: "jira-1" }, ["GITLAB_TOKEN", "JIRA_TOKEN"], ["JIRA_TOKEN"]);
    const now = snapshot({ GITLAB_TOKEN: "glpat-2", JIRA_TOKEN: "jira-1" }, ["GITLAB_TOKEN", "JIRA_TOKEN"], []);

    const change = environmentChange(started, now);
    expect(change).toEqual({ added: [], removed: [], changed: ["GITLAB_TOKEN"], shared: [], unshared: ["JIRA_TOKEN"] });
    expect(JSON.stringify(change)).not.toContain("glpat");
  });

  test("the digests the daemon keeps do not hold the values", () => {
    const { digests } = snapshot({ GITLAB_TOKEN: "glpat-secret-value" }, ["GITLAB_TOKEN"], []);

    expect([...digests.values()].join()).not.toContain("glpat-secret-value");
  });
});
