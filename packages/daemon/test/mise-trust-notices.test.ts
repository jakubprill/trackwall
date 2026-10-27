import { describe, expect, test } from "bun:test";
import { MiseTrustNotices } from "../src/modules/agents/mise-trust-notices.ts";

const ROOT_SESSION = "11111111-1111-4111-8111-111111111111";
const TASK_SESSION = "22222222-2222-4222-8222-222222222222";
const OTHER_REPO_SESSION = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const OTHER_TASK = "55555555-5555-4555-8555-555555555555";

describe("notices that the user trusted a mise config a session was refused for", () => {
  test("trusting a task worktree's config tells only the sessions refused in that worktree", () => {
    const notices = new MiseTrustNotices();
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.refused(TASK_SESSION, { repo: "shop", task: TASK });

    expect(notices.trusted({ repo: "shop", task: OTHER_TASK })).toEqual([]);
    expect(notices.trusted({ repo: "shop", task: TASK })).toEqual([TASK_SESSION]);
    expect(notices.waiting(TASK_SESSION)).toBe(true);
    expect(notices.waiting(ROOT_SESSION)).toBe(false);
  });

  test("trusting the repo root's config tells every session refused in the repo, worktrees included, and none of another repo", () => {
    const notices = new MiseTrustNotices();
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.refused(TASK_SESSION, { repo: "shop", task: TASK });
    notices.refused(OTHER_REPO_SESSION, { repo: "warehouse", task: null });

    expect(notices.trusted({ repo: "shop", task: null })).toEqual([ROOT_SESSION, TASK_SESSION]);
    expect(notices.waiting(OTHER_REPO_SESSION)).toBe(false);
  });

  test("a session is told once: a second trust finds nothing until it is refused again", () => {
    const notices = new MiseTrustNotices();
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });

    expect(notices.trusted({ repo: "shop", task: null })).toEqual([ROOT_SESSION]);
    expect(notices.trusted({ repo: "shop", task: null })).toEqual([]);
  });

  test("a session that tries again before the user trusts the config is not told", () => {
    const notices = new MiseTrustNotices();
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.forget(ROOT_SESSION);

    expect(notices.trusted({ repo: "shop", task: null })).toEqual([]);
  });

  test("the notice waits until the end of the turn after a prompt was sent, so a turn that ended without one keeps it", () => {
    const notices = new MiseTrustNotices();
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.trusted({ repo: "shop", task: null });

    // A turn that ended with no prompt sent (one a block started, or with the user's draft in the box) is not the notice's.
    notices.turnEnded(ROOT_SESSION);
    expect(notices.waiting(ROOT_SESSION)).toBe(true);
    notices.promptSent(ROOT_SESSION);
    expect(notices.waiting(ROOT_SESSION)).toBe(true);
    notices.turnEnded(ROOT_SESSION);
    expect(notices.waiting(ROOT_SESSION)).toBe(false);
  });

  test("a prompt sent before the trust does not count as the notice's", () => {
    const notices = new MiseTrustNotices();
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.promptSent(ROOT_SESSION);
    notices.trusted({ repo: "shop", task: null });
    notices.turnEnded(ROOT_SESSION);

    expect(notices.waiting(ROOT_SESSION)).toBe(true);
  });

  test("a session that tries again or closes has no notice waiting", () => {
    const notices = new MiseTrustNotices();
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.trusted({ repo: "shop", task: null });
    notices.forget(ROOT_SESSION);

    expect(notices.waiting(ROOT_SESSION)).toBe(false);
  });
});
