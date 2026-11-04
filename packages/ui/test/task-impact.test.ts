import { describe, expect, test } from "bun:test";
import type { ChangedEndpoint, ChangedType, ImpactedRepo } from "@trackwall/protocol";
import { impactEdgeRing, impactPoints, impactProposalNote, impactRings, impactSummary, RING_GAP } from "../src/lib/task-impact.ts";

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
    expect(impactSummary({ endpoints: [], types: [], impact: [], truncated: false })).toBe("The task's commits change no endpoint.");
    expect(impactSummary({ endpoints: [getOrder], types: [], impact: [], truncated: false })).toBe(
      "1 endpoint changed; no other repo calls them.",
    );
    expect(impactSummary({ endpoints: [getOrder], types: [], impact: [bff, web], truncated: true })).toBe(
      "1 endpoint (more not shown) changed, reaching 1 repo and maybe 1 more.",
    );
  });

  test("the summary counts changed public library types next to endpoints (ADR-201)", () => {
    const money: ChangedType = {
      change: "removed",
      package: "com.example.money",
      type: "com.example.money.Money",
      declaration: false,
      members: [],
      evidence: { path: "src/main/java/com/example/money/Money.java", line: 3 },
      users: [],
    };
    expect(impactSummary({ endpoints: [], types: [money], impact: [], truncated: false })).toBe(
      "1 public type changed; no other repo uses them.",
    );
    expect(impactSummary({ endpoints: [getOrder], types: [money, money], impact: [bff], truncated: false })).toBe(
      "1 endpoint and 2 public types changed, reaching 1 repo.",
    );
  });

  test("each repo has its ring, the task's repo 0", () => {
    expect([...impactRings({ repo: "orders-api", impact: [bff, web] })]).toEqual([
      ["orders-api", 0],
      ["orders-bff", 1],
      ["shop-web", 2],
    ]);
  });

  test("a proposal Trackwall made from the impact says so under its title; an agent's proposal says nothing (ADR-198)", () => {
    expect(impactProposalNote({ repo: "legacy-reports", fromImpact: true })).toBe(
      "Proposed by Trackwall: legacy-reports uses endpoints or public types this task's commits changed",
    );
    expect(impactProposalNote({ repo: "legacy-reports", fromImpact: false })).toBeNull();
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
