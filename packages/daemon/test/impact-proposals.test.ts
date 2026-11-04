import { describe, expect, test } from "bun:test";
import type { ChangedEndpoint, ChangedEndpoints, ImpactedRepo, Task } from "@trackwall/protocol";
import { type ImpactOffer, ImpactProposals, impactOffers, impactTaskName } from "../src/modules/agents/impact-proposals.ts";

const caller = (repo: string, path: string) => ({
  repo,
  via: "feign" as const,
  client: "OrdersClient",
  method: "GET" as const,
  path,
  confidence: "exact" as const,
  evidence: { path: "src/OrdersClient.java", line: 11 },
  from: [],
});

const endpoint = (change: ChangedEndpoint["change"], path: string, callers: string[]): ChangedEndpoint => ({
  change,
  app: "orders",
  method: "GET",
  path,
  before: null,
  after: null,
  dtos: [],
  callers: callers.map((repo) => caller(repo, path)),
});

const reached = (repo: string, ring: number, sure = true): ImpactedRepo => ({
  repo,
  ring,
  uses: ["orders-api"],
  calls: [{ repo: "orders-api", method: "GET", path: "/api/orders/{id}", handler: null }],
  through: null,
  sure,
});

const changed: ChangedEndpoints = {
  repo: "orders-api",
  base: "a".repeat(40),
  head: "b".repeat(40),
  contractsCompared: true,
  endpoints: [
    endpoint("changed", "/api/orders/{id}", ["orders-bff", "legacy-reports"]),
    endpoint("removed", "/api/orders/{id}/cancel", ["legacy-reports"]),
    endpoint("added", "/api/orders/{id}/close", []),
  ],
  truncated: false,
  problems: [],
  impact: [reached("orders-bff", 1), reached("legacy-reports", 1), reached("admin-web", 1, false), reached("shop-web", 2)],
};

describe("which repos an impact proposal goes to (ADR-198)", () => {
  test("a repo of ring 1 that surely calls a removed or changed endpoint is offered every such endpoint it calls", () => {
    expect(impactOffers(changed, {}).map((o) => [o.repo, o.endpoints])).toEqual([
      ["orders-bff", ["GET /api/orders/{id}"]],
      ["legacy-reports", ["GET /api/orders/{id}", "GET /api/orders/{id}/cancel"]],
    ]);
  });

  test("a repo offered all of them before gets nothing, and one with a newly changed endpoint is offered all again", () => {
    const offered = { "orders-bff": ["GET /api/orders/{id}"], "legacy-reports": ["GET /api/orders/{id}"] };

    expect(impactOffers(changed, offered).map((o) => [o.repo, o.endpoints])).toEqual([
      ["legacy-reports", ["GET /api/orders/{id}", "GET /api/orders/{id}/cancel"]],
    ]);
  });

  test("a proposal names the task by its title, or by the first line of its prompt cut like a title", () => {
    expect(impactTaskName({ title: "Add a note", prompt: "add a note\nto order lines" })).toBe("Add a note");
    expect(impactTaskName({ title: null, prompt: "  add a note\nto order lines" })).toBe("add a note");
    expect(impactTaskName({ title: null, prompt: "x".repeat(200) })).toHaveLength(80);
  });
});

describe("impact proposals at the end of a task's turn (ADR-198)", () => {
  const task = { id: "t1", repo: "orders-api", title: "Add a note", prompt: "add a note" } as Task;

  function proposalsWith(worked: string[], propose: (offer: ImpactOffer) => void = () => {}) {
    const offered: Record<string, string[]> = {};
    const proposed: string[] = [];
    const logged: string[] = [];
    const proposals = new ImpactProposals({
      task: (id) => (id === task.id ? task : undefined),
      offered: () => offered,
      markOffered: (_, repo, endpoints) => {
        offered[repo] = [...endpoints];
      },
      workedRepos: () => new Set(worked),
      impact: async () => changed,
      propose: (session, offer) => {
        propose(offer);
        proposed.push(`${session} ${offer.repo}`);
      },
      log: (message) => logged.push(message),
    });
    return { proposals, offered, proposed, logged };
  }

  test("each repo is proposed once from the session whose turn ended; a later turn with the same commits proposes nothing", async () => {
    const { proposals, proposed, offered } = proposalsWith([]);
    await proposals.turnOver("t1", "s1");
    await proposals.turnOver("t1", "s1");

    expect(proposed).toEqual(["s1 orders-bff", "s1 legacy-reports"]);
    expect(offered).toEqual({
      "orders-bff": ["GET /api/orders/{id}"],
      "legacy-reports": ["GET /api/orders/{id}", "GET /api/orders/{id}/cancel"],
    });
  });

  test("a repo where the task's work already goes on gets no proposal, but counts as offered", async () => {
    const { proposals, proposed, offered } = proposalsWith(["orders-bff"]);
    await proposals.turnOver("t1", "s1");

    expect(proposed).toEqual(["s1 legacy-reports"]);
    expect(Object.keys(offered)).toEqual(["orders-bff", "legacy-reports"]);
  });

  test("a refused proposal (the list is full) stops the check without counting the repo, so the next turn tries again", async () => {
    const { proposals, proposed, offered, logged } = proposalsWith([], () => {
      throw new Error("20 proposals are already waiting for the user; wait for their decision");
    });
    await proposals.turnOver("t1", "s1");

    expect(proposed).toEqual([]);
    expect(offered).toEqual({});
    expect(logged).toEqual([
      "task t1: proposing a task in orders-bff from its impact: 20 proposals are already waiting for the user; wait for their decision",
    ]);
  });

  test("turns that end close together are checked one after another, so a repo is not proposed twice", async () => {
    const { proposals, proposed } = proposalsWith([]);
    await Promise.all([proposals.turnOver("t1", "s1"), proposals.turnOver("t1", "s1")]);

    expect(proposed).toEqual(["s1 orders-bff", "s1 legacy-reports"]);
  });

  test("an ended task proposes nothing", async () => {
    const { proposals, proposed } = proposalsWith([]);
    await proposals.turnOver("gone", "s1");

    expect(proposed).toEqual([]);
  });
});
