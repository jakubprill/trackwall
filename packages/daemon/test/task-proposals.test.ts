import { describe, expect, test } from "bun:test";
import { MAX_PENDING_PROPOSALS, TaskProposals } from "../src/modules/agents/task-proposals.ts";

const PROPOSAL = { repo: "sklep", title: "Dodaj test", prompt: "dodaj test logowania", proposedBy: { session: null } };

describe("propozycje zadań", () => {
  test("nowa propozycja jest na górze listy, a zatwierdzona znika bez śladu odrzucenia", () => {
    const proposals = new TaskProposals();
    const first = proposals.add(PROPOSAL);
    const second = proposals.add({ ...PROPOSAL, title: "Druga" });
    expect(proposals.list()).toEqual([second, first]);

    proposals.approved(first.id);
    expect(proposals.list()).toEqual([second]);
    expect(proposals.wasRejected(first.id)).toBe(false);
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
