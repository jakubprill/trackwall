import { describe, expect, test } from "bun:test";
import {
  ENVIRONMENT_CARD_CLOSED,
  EnvironmentCard,
  type EnvironmentCardState,
  HOVER_CLOSE_MS,
  HOVER_OPEN_MS,
  sessionEnvironmentLines,
} from "../src/lib/session-environment.ts";

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

/** Timers the test runs by hand: `run(ms)` fires every pending timer due within `ms` of now. */
function handTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  let next = 0;
  return {
    timers: {
      set: (run: () => void, ms: number) => {
        next += 1;
        pending.set(next, { at: now + ms, run });
        return next;
      },
      clear: (id: number) => void pending.delete(id),
    },
    run(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.run();
      }
    },
  };
}

function card() {
  const clock = handTimers();
  const states: EnvironmentCardState[] = [];
  const environmentCard = new EnvironmentCard((state) => states.push(state), clock.timers);
  return { environmentCard, clock, last: () => states.at(-1) ?? ENVIRONMENT_CARD_CLOSED };
}

describe("the environment card on a grid tile", () => {
  test("passing the mouse over the badge does not show the card", () => {
    const { environmentCard, clock, last } = card();
    environmentCard.enter();
    clock.run(100);
    environmentCard.leave();
    clock.run(1000);
    expect(last()).toEqual({ open: false, pinned: false });
  });

  test("resting the mouse on the badge shows the card, and leaving it hides the card after a moment", () => {
    const { environmentCard, clock, last } = card();
    environmentCard.enter();
    clock.run(HOVER_OPEN_MS);
    expect(last()).toEqual({ open: true, pinned: false });
    environmentCard.leave();
    clock.run(HOVER_CLOSE_MS);
    expect(last()).toEqual({ open: false, pinned: false });
  });

  test("moving the mouse from the badge onto the card keeps the card open", () => {
    const { environmentCard, clock, last } = card();
    environmentCard.enter();
    clock.run(HOVER_OPEN_MS);
    environmentCard.leave();
    clock.run(50);
    environmentCard.enter();
    clock.run(1000);
    expect(last()).toEqual({ open: true, pinned: false });
  });

  test("a click pins the card at once, so that leaving it with the mouse keeps it open", () => {
    const { environmentCard, clock, last } = card();
    environmentCard.enter();
    environmentCard.click();
    expect(last()).toEqual({ open: true, pinned: true });
    environmentCard.leave();
    clock.run(1000);
    expect(last()).toEqual({ open: true, pinned: true });
  });

  test("a second click or Escape closes a pinned card", () => {
    const { environmentCard, last } = card();
    environmentCard.click();
    environmentCard.click();
    expect(last()).toEqual({ open: false, pinned: false });
    environmentCard.click();
    environmentCard.close();
    expect(last()).toEqual({ open: false, pinned: false });
  });
});
