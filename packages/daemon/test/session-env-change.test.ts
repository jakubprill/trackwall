import { describe, expect, test } from "bun:test";
import { sessionMiseLaunch } from "../src/modules/agents/session-env.ts";
import { SessionEnvironments } from "../src/modules/agents/session-env-change.ts";

/** What mise gives a place, and the launch a session there gets with `agentSecrets`. */
function place(vars: Record<string, string>, secretNames: string[], agentSecrets: string[]) {
  const mise = { vars, secretNames, secretValues: secretNames.map((name) => vars[name] ?? ""), problem: null };
  return [mise, sessionMiseLaunch(mise, {}, agentSecrets)] as const;
}

describe("a running session's environment against the one mise gives now (ADR-119)", () => {
  test("the same variables with the same values are no change", () => {
    const environments = new SessionEnvironments();
    environments.remember("s1", ...place({ MAVEN_OPTS: "-Xmx2g", GITLAB_TOKEN: "glpat-1" }, ["GITLAB_TOKEN"], []));

    expect(environments.changeSince("s1", ...place({ GITLAB_TOKEN: "glpat-1", MAVEN_OPTS: "-Xmx2g" }, ["GITLAB_TOKEN"], []))).toBeNull();
  });

  test("a new token in mise.toml and a name added to agentSecrets are named, a removed variable too", () => {
    const environments = new SessionEnvironments();
    environments.remember("s1", ...place({ MAVEN_OPTS: "-Xmx2g", OLD_FLAG: "1", GITLAB_TOKEN: "glpat-1" }, ["GITLAB_TOKEN"], []));

    expect(
      environments.changeSince(
        "s1",
        ...place({ MAVEN_OPTS: "-Xmx2g", JIRA_TOKEN: "jira-1", GITLAB_TOKEN: "glpat-1" }, ["JIRA_TOKEN", "GITLAB_TOKEN"], ["GITLAB_TOKEN"]),
      ),
    ).toEqual({ added: ["JIRA_TOKEN"], removed: ["OLD_FLAG"], changed: [], shared: ["GITLAB_TOKEN"], unshared: [] });
  });

  test("a value that changed is named without the value, and a secret taken out of agentSecrets is unshared", () => {
    const environments = new SessionEnvironments();
    environments.remember(
      "s1",
      ...place({ GITLAB_TOKEN: "glpat-1", JIRA_TOKEN: "jira-1" }, ["GITLAB_TOKEN", "JIRA_TOKEN"], ["JIRA_TOKEN"]),
    );

    const change = environments.changeSince(
      "s1",
      ...place({ GITLAB_TOKEN: "glpat-2", JIRA_TOKEN: "jira-1" }, ["GITLAB_TOKEN", "JIRA_TOKEN"], []),
    );
    expect(change).toEqual({ added: [], removed: [], changed: ["GITLAB_TOKEN"], shared: [], unshared: ["JIRA_TOKEN"] });
    expect(JSON.stringify(change)).not.toContain("glpat");
  });

  test("a variable mise now redacts is no longer for the agent's tools, though its name and value stay", () => {
    const environments = new SessionEnvironments();
    environments.remember("s1", ...place({ DEPLOY_HOOK: "https://hooks.example/1" }, [], []));

    expect(environments.changeSince("s1", ...place({ DEPLOY_HOOK: "https://hooks.example/1" }, ["DEPLOY_HOOK"], []))).toEqual({
      added: [],
      removed: [],
      changed: [],
      shared: [],
      unshared: ["DEPLOY_HOOK"],
    });
  });

  test("a new secret already in agentSecrets is named as new and as for the agent's tools", () => {
    const environments = new SessionEnvironments();
    environments.remember("s1", ...place({ MAVEN_OPTS: "-Xmx2g" }, [], ["JIRA_TOKEN"]));

    expect(
      environments.changeSince("s1", ...place({ MAVEN_OPTS: "-Xmx2g", JIRA_TOKEN: "jira-1" }, ["JIRA_TOKEN"], ["JIRA_TOKEN"])),
    ).toEqual({
      added: ["JIRA_TOKEN"],
      removed: [],
      changed: [],
      shared: ["JIRA_TOKEN"],
      unshared: [],
    });
  });

  test("a session it forgot, or never knew, has no change", () => {
    const environments = new SessionEnvironments();
    environments.remember("s1", ...place({ A: "1" }, [], []));
    environments.forget("s1");

    expect(environments.changeSince("s1", ...place({ B: "2" }, [], []))).toBeNull();
    expect(environments.changeSince("s2", ...place({ B: "2" }, [], []))).toBeNull();
  });
});
