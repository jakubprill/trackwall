import { describe, expect, test } from "bun:test";
import { MAX_PENDING_PROPOSALS, TaskProposals } from "../src/modules/agents/task-proposals.ts";

const PROPOSAL = {
  kind: "task" as const,
  repo: "shop",
  title: "Add a test",
  prompt: "add a login test",
  model: null,
  approvals: "ask" as const,
  item: null,
  proposedBy: { session: null, supervisor: false },
};

describe("task proposals", () => {
  test("a proposal being approved stays on the list, but a second approval and a rejection are not_found", () => {
    const proposals = new TaskProposals(() => {});
    const first = proposals.add(PROPOSAL);
    const second = proposals.add({ ...PROPOSAL, title: "Second" });
    expect(proposals.list()).toEqual([second, first]);

    expect(proposals.take(first.id)).toEqual(first);
    expect(proposals.list()).toEqual([second, first]);
    expect(proposals.approving(first.id)).toEqual(first);
    expect(() => proposals.take(first.id)).toThrow(`no task proposal ${first.id} is waiting for a decision`);
    expect(() => proposals.reject(first.id, null)).toThrow(`no task proposal ${first.id} is waiting for a decision`);

    proposals.release(first.id, false);
    expect(proposals.approving(first.id)).toBeUndefined();
    expect(proposals.list()).toEqual([second]);
    expect(proposals.rejection(first.id)).toBeUndefined();
  });

  test("a proposal that did not become a task waits for a decision again", () => {
    const proposals = new TaskProposals(() => {});
    const first = proposals.add(PROPOSAL);
    const second = proposals.add({ ...PROPOSAL, title: "Second" });
    proposals.take(first.id);
    proposals.release(first.id, true);
    expect(proposals.list()).toEqual([second, first]);
    expect(proposals.approving(first.id)).toBeUndefined();
    expect(proposals.take(first.id)).toEqual(first);
  });

  test("a rejected proposal disappears from the list, but the daemon remembers the rejection for the session waiting for it", () => {
    const proposals = new TaskProposals(() => {});
    const proposal = proposals.add(PROPOSAL);
    proposals.reject(proposal.id, null);
    expect(proposals.list()).toEqual([]);
    expect(proposals.rejection(proposal.id)).toEqual({ reason: null });
    expect(() => proposals.reject(proposal.id, null)).toThrow(`no task proposal ${proposal.id} is waiting for a decision`);
  });

  test("a rejection keeps the user's reason for the session that waits on the proposal", () => {
    const proposals = new TaskProposals(() => {});
    const proposal = proposals.add(PROPOSAL);
    proposals.reject(proposal.id, "Do it in billing instead");
    expect(proposals.rejection(proposal.id)).toEqual({ reason: "Do it in billing instead" });
  });

  test(`at most ${MAX_PENDING_PROPOSALS} proposals wait at once; the next one is bad_request, not a longer list`, () => {
    const proposals = new TaskProposals(() => {});
    for (let i = 0; i < MAX_PENDING_PROPOSALS; i++) proposals.add(PROPOSAL);
    expect(() => proposals.add(PROPOSAL)).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(proposals.list()).toHaveLength(MAX_PENDING_PROPOSALS);
  });

  test("the waiting proposals and the rejections come back in the next daemon, but not one that became a task meanwhile (ADR-115)", () => {
    const before = new TaskProposals(() => {});
    const waiting = before.add(PROPOSAL);
    const approved = before.add({ ...PROPOSAL, title: "Approved" });
    const rejected = before.add({ ...PROPOSAL, title: "Rejected" });
    before.reject(rejected.id, "Not now");
    // The daemon stopped while the task of `approved` was being created, and the task is there.
    before.take(approved.id);

    const after = new TaskProposals(() => {});
    after.restore(before.stored(), { hasTask: (id) => id === approved.id, hasFolder: () => true });

    expect(after.list()).toEqual([waiting]);
    expect(after.take(waiting.id)).toEqual(waiting);
    expect(after.rejection(rejected.id)).toEqual({ reason: "Not now" });
  });

  test("a repo removal keeps its folder across the restart until it is decided, and one without its folder in the file is dropped", () => {
    const removal = { ...PROPOSAL, kind: "remove_repo" as const, title: "Remove shop" };
    const before = new TaskProposals(() => {});
    const kept = before.add(removal, "/projects/shop");
    const rejected = before.add(removal, "/projects/web");
    before.reject(rejected.id, null);
    expect(before.stored().removalDirs).toEqual({ [kept.id]: "/projects/shop" });

    const after = new TaskProposals(() => {});
    after.restore(before.stored(), { hasTask: () => false, hasFolder: () => true });
    expect(after.removalDir(kept.id)).toBe("/projects/shop");

    const planted = new TaskProposals(() => {});
    planted.restore({ ...before.stored(), removalDirs: {} }, { hasTask: () => false, hasFolder: () => true });
    expect(planted.list()).toEqual([]);
  });

  test("a repo removal whose folder is gone after the restart is dropped: its approval moved it while the daemon stopped", () => {
    const removal = { ...PROPOSAL, kind: "remove_repo" as const, title: "Remove shop" };
    const before = new TaskProposals(() => {});
    const moved = before.add(removal, "/projects/shop");
    const waiting = before.add({ ...removal, title: "Remove web" }, "/projects/web");

    const after = new TaskProposals(() => {});
    after.restore(before.stored(), { hasTask: () => false, hasFolder: (dir) => dir === "/projects/web" });

    expect(after.list()).toEqual([waiting]);
    expect(after.removalDir(moved.id)).toBeUndefined();
  });

  test("every change of what waits is reported, taking a proposal for approval is not", () => {
    let changes = 0;
    const proposals = new TaskProposals(() => changes++);
    const first = proposals.add(PROPOSAL);
    const second = proposals.add(PROPOSAL);
    expect(changes).toBe(2);

    proposals.take(first.id);
    proposals.release(first.id, true);
    expect(changes).toBe(2);
    proposals.take(first.id);
    proposals.release(first.id, false);
    proposals.reject(second.id, null);
    expect(changes).toBe(4);
  });
});
