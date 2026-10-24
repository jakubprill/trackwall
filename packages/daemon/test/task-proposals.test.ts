import { describe, expect, test } from "bun:test";
import { MAX_PENDING_PROPOSALS, TaskProposals } from "../src/modules/agents/task-proposals.ts";

const PROPOSAL = { repo: "sklep", title: "Dodaj test", prompt: "dodaj test logowania", proposedBy: { session: null } };

describe("propozycje zadań", () => {
  test("zatwierdzana propozycja znika z listy od razu, więc drugie zatwierdzenie i odrzucenie to not_found", () => {
    const proposals = new TaskProposals();
    const first = proposals.add(PROPOSAL);
    const second = proposals.add({ ...PROPOSAL, title: "Druga" });
    expect(proposals.list()).toEqual([second, first]);

    expect(proposals.take(first.id)).toEqual(first);
    expect(proposals.list()).toEqual([second]);
    expect(proposals.approving(first.id)).toEqual(first);
    expect(() => proposals.take(first.id)).toThrow(`no task proposal ${first.id} is waiting for a decision`);
    expect(() => proposals.reject(first.id)).toThrow(`no task proposal ${first.id} is waiting for a decision`);

    proposals.release(first.id, false);
    expect(proposals.approving(first.id)).toBeUndefined();
    expect(proposals.list()).toEqual([second]);
    expect(proposals.wasRejected(first.id)).toBe(false);
  });

  test("propozycja, z której nie powstało zadanie, wraca na swoje miejsce na liście", () => {
    const proposals = new TaskProposals();
    const first = proposals.add(PROPOSAL);
    const second = proposals.add({ ...PROPOSAL, title: "Druga" });
    proposals.take(first.id);
    proposals.release(first.id, true);
    expect(proposals.list()).toEqual([second, first]);
    expect(proposals.approving(first.id)).toBeUndefined();
  });

  test("odrzucona propozycja znika z listy, ale daemon pamięta odrzucenie dla sesji, która na nią czeka", () => {
    const proposals = new TaskProposals();
    const proposal = proposals.add(PROPOSAL);
    proposals.reject(proposal.id);
    expect(proposals.list()).toEqual([]);
    expect(proposals.wasRejected(proposal.id)).toBe(true);
    expect(() => proposals.reject(proposal.id)).toThrow(`no task proposal ${proposal.id} is waiting for a decision`);
  });

  test(`najwyżej ${MAX_PENDING_PROPOSALS} propozycji czeka naraz; kolejna to bad_request, a nie dłuższa lista`, () => {
    const proposals = new TaskProposals();
    for (let i = 0; i < MAX_PENDING_PROPOSALS; i++) proposals.add(PROPOSAL);
    expect(() => proposals.add(PROPOSAL)).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(proposals.list()).toHaveLength(MAX_PENDING_PROPOSALS);
  });
});
