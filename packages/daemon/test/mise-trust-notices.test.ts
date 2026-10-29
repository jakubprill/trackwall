import { describe, expect, test } from "bun:test";
import { MiseTrustNotices } from "../src/modules/agents/mise-trust-notices.ts";

const TASK = "44444444-4444-4444-8444-444444444444";
const OTHER_TASK = "55555555-5555-4555-8555-555555555555";
const ROOT_SESSION = { session: "11111111-1111-4111-8111-111111111111" };
/** A task's session waits through its task. */
const TASK_SESSION = { task: TASK };
const OTHER_REPO_SESSION = { session: "33333333-3333-4333-8333-333333333333" };

describe("notices that the user trusted a mise config a session was refused for", () => {
  test("trusting a task worktree's config tells only the sessions refused in that worktree", () => {
    const notices = new MiseTrustNotices(() => {});
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.refused(TASK_SESSION, { repo: "shop", task: TASK });

    expect(notices.trusted({ repo: "shop", task: OTHER_TASK })).toEqual([]);
    expect(notices.trusted({ repo: "shop", task: TASK })).toEqual([TASK_SESSION]);
    expect(notices.waiting(TASK_SESSION)).toBe(true);
    expect(notices.waiting(ROOT_SESSION)).toBe(false);
  });

  test("trusting the repo root's config tells every session refused in the repo, worktrees included, and none of another repo", () => {
    const notices = new MiseTrustNotices(() => {});
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.refused(TASK_SESSION, { repo: "shop", task: TASK });
    notices.refused(OTHER_REPO_SESSION, { repo: "warehouse", task: null });

    expect(notices.trusted({ repo: "shop", task: null })).toEqual([ROOT_SESSION, TASK_SESSION]);
    expect(notices.waiting(OTHER_REPO_SESSION)).toBe(false);
  });

  test("a session is told once: a second trust finds nothing until it is refused again", () => {
    const notices = new MiseTrustNotices(() => {});
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });

    expect(notices.trusted({ repo: "shop", task: null })).toEqual([ROOT_SESSION]);
    expect(notices.trusted({ repo: "shop", task: null })).toEqual([]);
  });

  test("a session that tries again before the user trusts the config is not told", () => {
    const notices = new MiseTrustNotices(() => {});
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.forget(ROOT_SESSION);

    expect(notices.trusted({ repo: "shop", task: null })).toEqual([]);
  });

  test("the notice waits until the end of the turn after a prompt was sent, so a turn that ended without one keeps it", () => {
    const notices = new MiseTrustNotices(() => {});
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
    const notices = new MiseTrustNotices(() => {});
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.promptSent(ROOT_SESSION);
    notices.trusted({ repo: "shop", task: null });
    notices.turnEnded(ROOT_SESSION);

    expect(notices.waiting(ROOT_SESSION)).toBe(true);
  });

  test("a session that tries again or closes has no notice waiting", () => {
    const notices = new MiseTrustNotices(() => {});
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.trusted({ repo: "shop", task: null });
    notices.forget(ROOT_SESSION);

    expect(notices.waiting(ROOT_SESSION)).toBe(false);
  });

  test("the refusals and notices come back after a restart for the tasks and the sessions resumed under their id (ADR-115)", () => {
    const before = new MiseTrustNotices(() => {});
    before.refused(ROOT_SESSION, { repo: "shop", task: null });
    before.refused(TASK_SESSION, { repo: "shop", task: TASK });
    before.refused(OTHER_REPO_SESSION, { repo: "warehouse", task: null });
    before.refused({ task: OTHER_TASK }, { repo: "shop", task: OTHER_TASK });
    before.trusted({ repo: "shop", task: TASK });
    // The notice went out in a prompt of the session the stop ended; the resumed one is to be told again.
    before.promptSent(TASK_SESSION);

    const after = new MiseTrustNotices(() => {});
    after.restore(before.stored(), {
      hasTask: (task) => task === TASK,
      hasSession: (session) => session === ROOT_SESSION.session,
    });

    expect(after.waiting(TASK_SESSION)).toBe(true);
    after.turnEnded(TASK_SESSION);
    expect(after.waiting(TASK_SESSION)).toBe(true);
    expect(after.trusted({ repo: "shop", task: null })).toEqual([ROOT_SESSION]);
    expect(after.trusted({ repo: "warehouse", task: null })).toEqual([]);
    expect(after.trusted({ repo: "shop", task: OTHER_TASK })).toEqual([]);
  });

  test("every change of what waits is reported, a prompt sent is not", () => {
    let changes = 0;
    const notices = new MiseTrustNotices(() => changes++);
    notices.refused(ROOT_SESSION, { repo: "shop", task: null });
    notices.trusted({ repo: "shop", task: null });
    notices.trusted({ repo: "shop", task: null });
    expect(changes).toBe(2);

    notices.promptSent(ROOT_SESSION);
    expect(changes).toBe(2);
    notices.turnEnded(ROOT_SESSION);
    notices.forget(ROOT_SESSION);
    expect(changes).toBe(3);
  });
});
