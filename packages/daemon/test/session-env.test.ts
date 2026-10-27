import { describe, expect, test } from "bun:test";
import { hiddenSecrets, secretEnvVarsArgs, sessionEnvironment, withMiseVars } from "../src/modules/agents/session-env.ts";

describe("a session's environment from mise (ADR-93)", () => {
  test("mise's variables go over the user's, and the user's other variables stay", () => {
    expect(withMiseVars({ HOME: "/home/someone", GITLAB_TOKEN: "old" }, { GITLAB_TOKEN: "new", MAVEN_OPTS: "-Xmx2g" })).toEqual({
      HOME: "/home/someone",
      GITLAB_TOKEN: "new",
      MAVEN_OPTS: "-Xmx2g",
    });
  });

  test.skipIf(process.platform !== "win32")("on Windows mise's PATH replaces the user's Path instead of standing next to it", () => {
    expect(withMiseVars({ Path: "C:\\Windows" }, { PATH: "C:\\mise\\installs\\java\\bin;C:\\Windows" })).toEqual({
      Path: "C:\\mise\\installs\\java\\bin;C:\\Windows",
    });
  });

  test("Copilot CLI hides mise's secrets from the session's tools, except those in agentSecrets, sorted and only names it can list", () => {
    const mise = {
      vars: { JIRA_TOKEN: "j", GITLAB_TOKEN: "g", "ODD,NAME": "v" },
      secretNames: ["JIRA_TOKEN", "GITLAB_TOKEN", "ODD,NAME"],
      problem: null,
    };
    const hidden = hiddenSecrets(mise, ["JIRA_TOKEN"]);

    expect(hidden).toEqual(["GITLAB_TOKEN"]);
    expect(secretEnvVarsArgs(hidden)).toEqual(["--secret-env-vars=GITLAB_TOKEN"]);
    expect(secretEnvVarsArgs([])).toEqual([]);
  });

  test("the session shows the names of mise's variables, its secrets and those its tools get, never their values", () => {
    const environment = sessionEnvironment(
      {
        vars: { MAVEN_OPTS: "-Xmx2g", GITLAB_TOKEN: "glpat-value", JIRA_TOKEN: "jira-value" },
        secretNames: ["JIRA_TOKEN", "GITLAB_TOKEN"],
        problem: null,
      },
      ["GITLAB_TOKEN"],
    );

    expect(environment).toEqual({
      variables: ["GITLAB_TOKEN", "JIRA_TOKEN", "MAVEN_OPTS"],
      secrets: ["GITLAB_TOKEN", "JIRA_TOKEN"],
      agentSecrets: ["JIRA_TOKEN"],
      problem: null,
    });
    expect(JSON.stringify(environment)).not.toContain("glpat-value");
  });
});
