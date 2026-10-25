import { describe, expect, test } from "bun:test";
import { MAX_PENDING_PROPOSALS, TaskProposals } from "../src/modules/agents/task-proposals.ts";

const PROPOSAL = { repo: "sklep", title: "Dodaj test", prompt: "dodaj test logowania", proposedBy: { session: null, supervisor: false } };

describe("propozycje zadań", () => {
  test("zatwierdzana propozycja zostaje na liście, ale drugie zatwierdzenie i odrzucenie to not_found", () => {
    const proposals = new TaskProposals();
    const first = proposals.add(PROPOSAL);
    const second = proposals.add({ ...PROPOSAL, title: "Druga" });
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

  test("propozycja, z której nie powstało zadanie, znów czeka na decyzję", () => {
    const proposals = new TaskProposals();
    const first = proposals.add(PROPOSAL);
    const second = proposals.add({ ...PROPOSAL, title: "Druga" });
    proposals.take(first.id);
    proposals.release(first.id, true);
    expect(proposals.list()).toEqual([second, first]);
    expect(proposals.approving(first.id)).toBeUndefined();
    expect(proposals.take(first.id)).toEqual(first);
  });

  test("odrzucona propozycja znika z listy, ale daemon pamięta odrzucenie dla sesji, która na nią czeka", () => {
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

  test(`najwyżej ${MAX_PENDING_PROPOSALS} propozycji czeka naraz; kolejna to bad_request, a nie dłuższa lista`, () => {
    const proposals = new TaskProposals();
    for (let i = 0; i < MAX_PENDING_PROPOSALS; i++) proposals.add(PROPOSAL);
    expect(() => proposals.add(PROPOSAL)).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(proposals.list()).toHaveLength(MAX_PENDING_PROPOSALS);
  });
});
