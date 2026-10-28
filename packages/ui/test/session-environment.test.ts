import { describe, expect, test } from "bun:test";
import { sessionEnvironmentLines } from "../src/lib/session-environment.ts";

describe("the environment a session got from mise", () => {
  test("names the variables, the secrets hidden from the agent's tools and those agentSecrets lets through", () => {
    expect(
      sessionEnvironmentLines({
        variables: ["GITLAB_TOKEN", "JIRA_TOKEN", "MAVEN_OPTS"],
        secrets: ["GITLAB_TOKEN", "JIRA_TOKEN"],
        agentSecrets: ["JIRA_TOKEN"],
        problem: null,
      }),
    ).toEqual({
      summary: "3 variables from mise",
      names: "GITLAB_TOKEN\nJIRA_TOKEN\nMAVEN_OPTS",
      hidden: ["GITLAB_TOKEN"],
      shared: ["JIRA_TOKEN"],
      problem: null,
    });
  });

  test("shows nothing when mise gave the session nothing and nothing went wrong", () => {
    expect(sessionEnvironmentLines({ variables: [], secrets: [], agentSecrets: [], problem: null })).toBeNull();
  });

  test("shows why the session lacks mise's environment even when it got no variable", () => {
    expect(
      sessionEnvironmentLines({ variables: [], secrets: [], agentSecrets: [], problem: "shop: mise.toml is not trusted" }),
    ).toMatchObject({ summary: "0 variables from mise", problem: "shop: mise.toml is not trusted" });
  });
});
