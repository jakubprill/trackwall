import { describe, expect, test } from "bun:test";
import type { ChangedEndpoint, ImpactedRepo } from "@trackwall/protocol";
import {
  contractChange,
  endpointsCalledBy,
  handoffPrompt,
  impactEdgeRing,
  impactPoints,
  impactRings,
  impactSummary,
  RING_GAP,
  reachText,
} from "../src/lib/task-impact.ts";

const caller = (repo: string, client: string, line: number) => ({
  repo,
  via: "feign" as const,
  client,
  method: "GET" as const,
  path: "/api/orders/{id}",
  confidence: "exact" as const,
  evidence: { path: `src/${client}.java`, line },
  from: [],
});

const getOrder: ChangedEndpoint = {
  change: "changed",
  app: "orders",
  method: "GET",
  path: "/api/orders/{id}",
  before: { handler: "OrdersController.get", request: null, response: "OrderDto" },
  after: { handler: "OrdersController.get", request: null, response: "OrderDto" },
  dtos: ["OrderLine"],
  callers: [caller("orders-bff", "OrdersClient", 11), caller("legacy-reports", "OrdersReport", 17)],
};

const bff: ImpactedRepo = {
  repo: "orders-bff",
  ring: 1,
  uses: ["orders-api"],
  calls: [{ repo: "orders-api", method: "GET", path: "/api/orders/{id}", handler: "OrdersController.get" }],
  through: null,
  sure: true,
};
const web: ImpactedRepo = { repo: "shop-web", ring: 2, uses: ["orders-bff"], calls: [], through: null, sure: false };

describe("a task's impact", () => {
  test("the summary counts the changed endpoints and the repos reached, keeping the maybe ones apart", () => {
    expect(impactSummary({ endpoints: [], impact: [], truncated: false })).toBe("The task's commits change no endpoint.");
    expect(impactSummary({ endpoints: [getOrder], impact: [], truncated: false })).toBe("1 endpoint changed; no other repo calls them.");
    expect(impactSummary({ endpoints: [getOrder], impact: [bff, web], truncated: true })).toBe(
      "1 endpoint (more not shown) changed, reaching 1 repo and maybe 1 more.",
    );
  });

  test("each repo has its ring, the task's repo 0", () => {
    expect([...impactRings({ repo: "orders-api", impact: [bff, web] })]).toEqual([
      ["orders-api", 0],
      ["orders-bff", 1],
      ["shop-web", 2],
    ]);
  });

  test("a repo of ring 1 is shown only its own calls of the changed endpoints", () => {
    expect(endpointsCalledBy([getOrder], "legacy-reports").map((e) => e.callers.map((c) => c.client))).toEqual([["OrdersReport"]]);
    expect(endpointsCalledBy([getOrder], "shop-web")).toEqual([]);
  });

  test("a hand-off to ring 1 lists what changed and where the repo calls it; one further out asks to check", () => {
    const changed = { repo: "orders-api", endpoints: [getOrder] };
    expect(handoffPrompt(changed, "Add a note to order lines", bff)).toBe(
      [
        "The task “Add a note to order lines” in orders-api changes endpoints that orders-bff calls:",
        "- changed GET /api/orders/{id} (response OrderDto); DTOs changed: OrderLine, called by OrdersClient at src/OrdersClient.java:11",
        "",
        "Update orders-bff to the new contract. Read that task's change with get_changed_endpoints and get_task_changes before you change code.",
      ].join("\n"),
    );
    expect(handoffPrompt(changed, "Add a note to order lines", web)).toBe(
      [
        "shop-web uses orders-bff, which the task “Add a note to order lines” in orders-api may reach through its changed endpoints.",
        "",
        "Check whether the change reaches shop-web, and update it if it does. Read that task's change with get_changed_endpoints and get_task_changes before you change code.",
      ].join("\n"),
    );
  });

  test("a repo of ring 1 that reaches the task's repo only by its address is asked to check, not told of calls it has none of", () => {
    const proxy: ImpactedRepo = { repo: "orders-admin", ring: 1, uses: ["orders-api"], calls: [], through: null, sure: false };
    expect(reachText({ endpoints: [getOrder] }, proxy)).toBe("uses orders-api");
    expect(handoffPrompt({ repo: "orders-api", endpoints: [getOrder] }, "Add a note", proxy).split("\n")[0]).toBe(
      "orders-admin uses orders-api, which the task “Add a note” in orders-api may reach through its changed endpoints.",
    );
  });

  test("a reached repo says what it calls: in ring 1 the changed endpoints, further out the endpoints of the ring inside", () => {
    expect(reachText({ endpoints: [getOrder] }, bff)).toBe("calls GET /api/orders/{id}");
    const gateway = {
      ...bff,
      repo: "api-gateway",
      ring: 2,
      calls: [{ repo: "orders-bff", method: "GET" as const, path: "/shop/{id}", handler: null }],
    };
    expect(reachText({ endpoints: [getOrder] }, gateway)).toBe("calls GET /shop/{id} of orders-bff");
  });

  test("a contract shows its types once when they stay, before ⇒ after when they change, and nothing without a body", () => {
    expect(contractChange(getOrder)).toBe("response OrderDto");
    expect(contractChange({ before: getOrder.before, after: { handler: null, request: "OrderLine", response: "OrderDto" } })).toBe(
      "response OrderDto ⇒ request OrderLine, response OrderDto",
    );
    expect(contractChange({ before: null, after: { handler: null, request: null, response: null } })).toBe("");
  });

  test("an Overview edge is lit when it calls from one ring into the ring inside it", () => {
    const rings = new Map([
      ["orders-api", 0],
      ["orders-bff", 1],
      ["shop-web", 2],
    ]);
    const calls = (from: string, to: string) => ({ from, to, edges: [{ kind: "calls" as const }] as never });
    expect(impactEdgeRing(calls("orders-bff", "orders-api"), rings)).toBe(1);
    expect(impactEdgeRing(calls("shop-web", "orders-bff"), rings)).toBe(2);
    // Skipping a ring, or a repo outside the impact, carries nothing.
    expect(impactEdgeRing(calls("shop-web", "orders-api"), rings)).toBeUndefined();
    expect(impactEdgeRing(calls("payments", "orders-api"), rings)).toBeUndefined();
    expect(impactEdgeRing(calls("orders-bff", "orders-api"), undefined)).toBeUndefined();
  });

  test("the drawing puts the task's repo in the centre, ring 1 from the top, and a further repo next to what it uses", () => {
    const points = impactPoints("orders-api", [bff, { ...bff, repo: "legacy-reports" }, web]);
    const at = (repo: string) => points.find((p) => p.repo === repo);
    expect(at("orders-api")).toEqual({ repo: "orders-api", ring: 0, x: 0, y: 0 });
    // Ring 1 is ordered by name when its repos want the same place: legacy-reports first, at the top.
    expect(at("legacy-reports")?.x).toBeCloseTo(0);
    expect(at("legacy-reports")?.y).toBeCloseTo(-RING_GAP);
    expect(at("orders-bff")?.y).toBeCloseTo(RING_GAP);
    // shop-web uses orders-bff at the bottom, so it sits below it on ring 2.
    expect(at("shop-web")?.x).toBeCloseTo(0);
    expect(at("shop-web")?.y).toBeCloseTo(2 * RING_GAP);
  });
});
