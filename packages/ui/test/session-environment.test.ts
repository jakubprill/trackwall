import { describe, expect, test } from "bun:test";
import { ENVIRONMENT_CARD_CLOSED, nextEnvironmentCard, sessionEnvironmentLines } from "../src/lib/session-environment.ts";

describe("the environment a session got from mise", () => {
  test("groups the names into secrets the agent's tools get, secrets hidden from them and the other variables", () => {
    expect(
      sessionEnvironmentLines({
        variables: ["GITLAB_TOKEN", "JIRA_TOKEN", "MAVEN_OPTS"],
        secrets: ["GITLAB_TOKEN", "JIRA_TOKEN"],
        agentSecrets: ["JIRA_TOKEN"],
        problem: null,
      }),
    ).toEqual({
      summary: "3 variables from mise",
      badgeLabel: "3 variables from mise",
      count: 3,
      shared: ["JIRA_TOKEN"],
      hidden: ["GITLAB_TOKEN"],
      other: ["MAVEN_OPTS"],
      problem: null,
    });
  });

  test("shows nothing when mise gave the session nothing and nothing went wrong", () => {
    expect(sessionEnvironmentLines({ variables: [], secrets: [], agentSecrets: [], problem: null })).toBeNull();
  });

  test("shows why the session lacks mise's environment even when it got no variable", () => {
    expect(
      sessionEnvironmentLines({ variables: [], secrets: [], agentSecrets: [], problem: "shop: mise.toml is not trusted" }),
    ).toMatchObject({
      summary: "0 variables from mise",
      badgeLabel: "0 variables from mise, some are missing",
      count: 0,
      problem: "shop: mise.toml is not trusted",
    });
  });
});

describe("the environment card on a grid tile", () => {
  test("hovering the badge shows the card and leaving it hides the card again", () => {
    const hovered = nextEnvironmentCard(ENVIRONMENT_CARD_CLOSED, "hover");
    expect(hovered).toEqual({ open: true, pinned: false });
    expect(nextEnvironmentCard(hovered, "leave")).toEqual({ open: false, pinned: false });
  });

  test("a click pins the card, so that leaving it with the mouse keeps it open", () => {
    const pinned = nextEnvironmentCard(nextEnvironmentCard(ENVIRONMENT_CARD_CLOSED, "hover"), "click");
    expect(pinned).toEqual({ open: true, pinned: true });
    expect(nextEnvironmentCard(pinned, "leave")).toEqual({ open: true, pinned: true });
  });

  test("a second click or Escape closes a pinned card", () => {
    const pinned = nextEnvironmentCard(ENVIRONMENT_CARD_CLOSED, "click");
    expect(nextEnvironmentCard(pinned, "click")).toEqual({ open: false, pinned: false });
    expect(nextEnvironmentCard(pinned, "escape")).toEqual({ open: false, pinned: false });
  });
});
