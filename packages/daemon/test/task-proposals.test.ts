import { describe, expect, test } from "bun:test";
import { MAX_PENDING_PROPOSALS, TaskProposals } from "../src/modules/agents/task-proposals.ts";

const PROPOSAL = {
  kind: "task" as const,
  repo: "shop",
  title: "Add a test",
  prompt: "add a login test",
  model: null,
  proposedBy: { session: null, supervisor: false },
};

describe("task proposals", () => {
  test("a proposal being approved stays on the list, but a second approval and a rejection are not_found", () => {
    const proposals = new TaskProposals();
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
    const proposals = new TaskProposals();
    const first = proposals.add(PROPOSAL);
    const second = proposals.add({ ...PROPOSAL, title: "Second" });
    proposals.take(first.id);
    proposals.release(first.id, true);
    expect(proposals.list()).toEqual([second, first]);
    expect(proposals.approving(first.id)).toBeUndefined();
    expect(proposals.take(first.id)).toEqual(first);
  });

  test("a rejected proposal disappears from the list, but the daemon remembers the rejection for the session waiting for it", () => {
    const proposals = new TaskProposals();
    const proposal = proposals.add(PROPOSAL);
    proposals.reject(proposal.id, null);
    expect(proposals.list()).toEqual([]);
    expect(proposals.rejection(proposal.id)).toEqual({ reason: null });
    expect(() => proposals.reject(proposal.id, null)).toThrow(`no task proposal ${proposal.id} is waiting for a decision`);
  });

  test("a rejection keeps the user's reason for the session that waits on the proposal", () => {
    const proposals = new TaskProposals();
    const proposal = proposals.add(PROPOSAL);
    proposals.reject(proposal.id, "Do it in billing instead");
    expect(proposals.rejection(proposal.id)).toEqual({ reason: "Do it in billing instead" });
  });

  test(`at most ${MAX_PENDING_PROPOSALS} proposals wait at once; the next one is bad_request, not a longer list`, () => {
    const proposals = new TaskProposals();
    for (let i = 0; i < MAX_PENDING_PROPOSALS; i++) proposals.add(PROPOSAL);
    expect(() => proposals.add(PROPOSAL)).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(proposals.list()).toHaveLength(MAX_PENDING_PROPOSALS);
  });
});
