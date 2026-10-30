import { describe, expect, test } from "bun:test";
import { sessionMiseLaunch, withMiseVars } from "../src/modules/agents/session-env.ts";

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

  test.skipIf(process.platform !== "win32")("on Windows Copilot CLI hides a secret under the user's spelling of its name", () => {
    const launch = sessionMiseLaunch(
      { vars: { GITLAB_TOKEN: "glpat-value" }, secretNames: ["GITLAB_TOKEN"], secretValues: ["glpat-value"], profile: null, problem: null },
      { Gitlab_Token: "old" },
      [],
    );

    expect(launch.env).toEqual({ Gitlab_Token: "glpat-value" });
    expect(launch.args).toEqual(["--secret-env-vars=Gitlab_Token"]);
  });

  test("Copilot CLI hides mise's secrets from the session's tools, except those in agentSecrets, sorted", () => {
    const launch = sessionMiseLaunch(
      {
        vars: { MAVEN_OPTS: "-Xmx2g", JIRA_TOKEN: "jira-value", GITLAB_TOKEN: "glpat-value", DEPLOY_KEY: "deploy-value" },
        secretNames: ["JIRA_TOKEN", "GITLAB_TOKEN", "DEPLOY_KEY"],
        secretValues: ["jira-value", "glpat-value", "deploy-value"],
        profile: null,
        problem: null,
      },
      { HOME: "/home/someone" },
      ["JIRA_TOKEN"],
    );

    expect(launch.args).toEqual(["--secret-env-vars=DEPLOY_KEY,GITLAB_TOKEN"]);
    expect(launch.env).toEqual({
      HOME: "/home/someone",
      MAVEN_OPTS: "-Xmx2g",
      JIRA_TOKEN: "jira-value",
      GITLAB_TOKEN: "glpat-value",
      DEPLOY_KEY: "deploy-value",
    });
    expect(launch.secretValues).toEqual(["jira-value", "glpat-value", "deploy-value"]);
  });

  test("the session shows the names of mise's variables, its secrets and those its tools get, never their values", () => {
    const { environment } = sessionMiseLaunch(
      {
        vars: { MAVEN_OPTS: "-Xmx2g", GITLAB_TOKEN: "glpat-value", JIRA_TOKEN: "jira-value" },
        secretNames: ["JIRA_TOKEN", "GITLAB_TOKEN"],
        secretValues: ["jira-value", "glpat-value"],
        profile: null,
        problem: null,
      },
      {},
      ["JIRA_TOKEN"],
    );

    expect(environment).toEqual({
      variables: ["GITLAB_TOKEN", "JIRA_TOKEN", "MAVEN_OPTS"],
      secrets: ["GITLAB_TOKEN", "JIRA_TOKEN"],
      agentSecrets: ["JIRA_TOKEN"],
      profile: null,
      problem: null,
    });
    expect(JSON.stringify(environment)).not.toContain("glpat-value");
  });

  test("a secret Copilot CLI's list cannot name is left out of the session, and the session says so", () => {
    const launch = sessionMiseLaunch(
      {
        vars: { "ODD,NAME": "odd-value", REGION: "eu" },
        secretNames: ["ODD,NAME"],
        secretValues: ["odd-value"],
        profile: null,
        problem: null,
      },
      {},
      [],
    );

    expect(launch.env).toEqual({ REGION: "eu" });
    expect(launch.args).toEqual([]);
    expect(launch.environment.problem).toBe("ODD,NAME from mise is left out: Copilot CLI cannot hide a variable with that name");
  });

  test("mise's age key in the user's environment is hidden from the session's tools unless agentSecrets names it", () => {
    const mise = { vars: {}, secretNames: [], secretValues: [], profile: null, problem: null };

    expect(sessionMiseLaunch(mise, { MISE_AGE_KEY: "AGE-SECRET-KEY-1" }, []).args).toEqual(["--secret-env-vars=MISE_AGE_KEY"]);
    expect(sessionMiseLaunch(mise, { MISE_AGE_KEY: "AGE-SECRET-KEY-1" }, ["MISE_AGE_KEY"]).args).toEqual([]);
    expect(sessionMiseLaunch(mise, {}, []).args).toEqual([]);
  });
});
