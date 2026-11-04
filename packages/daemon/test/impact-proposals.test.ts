import { describe, expect, test } from "bun:test";
import { type ChangedEndpoint, type ChangedEndpoints, type ImpactedRepo, MAX_CHANGED_ENDPOINTS, type Task } from "@trackwall/protocol";
import { ImpactProposals, impactOffers, offeredAfter } from "../src/modules/agents/impact-proposals.ts";
import { MAX_PENDING_PROPOSALS, TaskProposals } from "../src/modules/agents/task-proposals.ts";

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

  test("what a repo was offered keeps the newest offer whole when it outgrows the limit, so that offer is not made again", () => {
    const old = Array.from({ length: MAX_CHANGED_ENDPOINTS }, (_, i) => `GET /old/${i}`);
    const offer = ["GET /api/orders/{id}", "GET /old/3"];
    const after = offeredAfter(old, offer);

    expect(after).toHaveLength(MAX_CHANGED_ENDPOINTS);
    expect(after.slice(0, 2)).toEqual(offer);
    expect(impactOffers(changed, { "orders-bff": after }).map((o) => o.repo)).toEqual(["legacy-reports"]);
  });
});

describe("impact proposals at the end of a task's turn (ADR-198)", () => {
  const task = { id: "t1", repo: "orders-api", title: "Add a note", prompt: "add a note", proposedBy: null } as Task;

  function setup({ worked = [] as Task[], markFails = false } = {}) {
    const offered: Record<string, string[]> = {};
    const logged: string[] = [];
    const proposals = new TaskProposals(() => {});
    const impact = new ImpactProposals({
      tasks: {
        find: (id) => (id === task.id ? task : undefined),
        list: () => [task, ...worked],
        handoff: () => null,
        change: () => null,
        impactProposed: () => offered,
        markImpactProposed: (_, repo, endpoints) => {
          if (markFails) throw new Error("EBUSY: tasks.json is locked");
          offered[repo] = [...endpoints];
        },
      },
      proposals,
      impact: async () => changed,
      log: (message) => logged.push(message),
    });
    const proposed = () => proposals.list().map((p) => `${p.proposedBy.session} ${p.repo} ${p.fromImpact}`);
    return { impact, proposals, proposed, offered, logged };
  }

  test("each repo is proposed once from the session whose turn ended; a later turn with the same commits proposes nothing", async () => {
    const { impact, proposed, offered } = setup();
    await impact.turnOver("t1", "s1");
    await impact.turnOver("t1", "s1");

    expect(proposed()).toEqual(["s1 legacy-reports true", "s1 orders-bff true"]);
    expect(offered).toEqual({
      "orders-bff": ["GET /api/orders/{id}"],
      "legacy-reports": ["GET /api/orders/{id}", "GET /api/orders/{id}/cancel"],
    });
  });

  test("a repo with a task the task proposed gets no proposal, but counts as offered", async () => {
    const subtask = { ...task, id: "t2", repo: "orders-bff", proposedBy: { session: "s1", supervisor: false, task: "t1" } };
    const { impact, proposed, offered } = setup({ worked: [subtask] });
    await impact.turnOver("t1", "s1");

    expect(proposed()).toEqual(["s1 legacy-reports true"]);
    expect(Object.keys(offered)).toEqual(["orders-bff", "legacy-reports"]);
  });

  test("a failed check is logged and the next turn checks again, never leaving an error behind", async () => {
    const { impact, logged } = setup({ markFails: true });
    await impact.turnOver("t1", "s1");
    await impact.turnOver("t1", "s1");

    expect(logged).toEqual([
      "task t1: proposing tasks from its impact: EBUSY: tasks.json is locked",
      "task t1: proposing tasks from its impact: EBUSY: tasks.json is locked",
    ]);
  });

  test("turns that end close together are checked one after another, so a repo is not proposed twice", async () => {
    const { impact, proposed } = setup();
    await Promise.all([impact.turnOver("t1", "s1"), impact.turnOver("t1", "s1")]);

    expect(proposed()).toHaveLength(2);
  });

  test("work started otherwise in a repo withdraws only that task's impact proposal there", async () => {
    const { impact, proposals, proposed } = setup();
    await impact.turnOver("t1", "s1");
    proposals.add({
      kind: "task",
      repo: "orders-bff",
      title: "Update to the API change in payments",
      prompt: "follow the new contract",
      model: null,
      approvals: "ask",
      item: null,
      parts: null,
      fromImpact: true,
      proposedBy: { session: "s9", supervisor: false, task: "t9" },
    });

    impact.replacedBy("t1", ["orders-bff"]);

    expect(proposed()).toEqual(["s9 orders-bff true", "s1 legacy-reports true"]);
  });

  test("a full list of proposals stops the check without counting the repo, so a later turn offers it once there is room", async () => {
    const { impact, proposals, proposed, offered, logged } = setup();
    const fillers = Array.from({ length: MAX_PENDING_PROPOSALS }, (_, i) =>
      proposals.add({
        kind: "task",
        repo: "payments",
        title: `Fill ${i}`,
        prompt: "fill",
        model: null,
        approvals: "ask",
        item: null,
        parts: null,
        proposedBy: { session: null, supervisor: false, task: null },
      }),
    );

    await impact.turnOver("t1", "s1");
    expect(offered).toEqual({});
    expect(logged).toEqual([
      `task t1: proposing tasks from its impact: ${MAX_PENDING_PROPOSALS} proposals are already waiting for the user; wait for their decision`,
    ]);

    proposals.reject(fillers[0]?.id ?? "", null);
    await impact.turnOver("t1", "s1");
    // One free place: orders-bff gets it, and legacy-reports waits for the next one.
    expect(proposed().filter((p) => p.endsWith(" true"))).toEqual(["s1 orders-bff true"]);
    expect(Object.keys(offered)).toEqual(["orders-bff"]);
  });

  test("an ended task proposes nothing", async () => {
    const { impact, proposed } = setup();
    await impact.turnOver("gone", "s1");

    expect(proposed()).toEqual([]);
  });
});
