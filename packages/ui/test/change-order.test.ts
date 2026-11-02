import { describe, expect, test } from "bun:test";
import type { EdgeConfidence, GraphEdge, KnowledgeListEntry } from "@trackwall/protocol";
import { orderHints, orderRelations } from "../src/lib/change-order.ts";

const edge = (from: string, to: string, kind: GraphEdge["kind"], confidence: EdgeConfidence = "high"): GraphEdge => ({
  from,
  to,
  kind,
  source: kind === "calls" ? "http" : "package",
  key: to,
  confidence,
  evidence: [{ repo: from, file: "pom.xml", line: 12, text: `uses ${to}` }],
});

const relation = (name: string, repos: string[], approved = true, kind: KnowledgeListEntry["kind"] = "relation"): KnowledgeListEntry => ({
  name,
  kind,
  repos,
  text: "orders-api reads the payments queue: deploy payments first.",
  evidence: "",
  writtenBy: { kind: "user" },
  updatedAt: "2026-11-02T09:00:00Z",
  digest: "a".repeat(64),
  approved,
});

describe("the connection graph's hints on a change's merge order", () => {
  test("a repo placed before a repo it uses gets a hint that the used one is usually merged first", () => {
    expect(
      orderHints(
        ["orders-api", "payments", "shop-web"],
        [edge("orders-api", "payments", "calls"), edge("shop-web", "orders-api", "calls")],
      ),
    ).toEqual([{ user: "orders-api", used: "payments", text: "orders-api calls payments, so payments is usually merged first." }]);
  });

  test("a package dependency reads as one", () => {
    expect(orderHints(["shop-web", "ui-kit"], [edge("shop-web", "ui-kit", "depends-on")])).toEqual([
      { user: "shop-web", used: "ui-kit", text: "shop-web depends on ui-kit, so ui-kit is usually merged first." },
    ]);
  });

  test("an order that follows the graph, a cycle, a weak guess and a repo outside the change give no hint", () => {
    expect(orderHints(["payments", "orders-api"], [edge("orders-api", "payments", "calls")])).toEqual([]);
    expect(
      orderHints(["orders-api", "payments"], [edge("orders-api", "payments", "calls"), edge("payments", "orders-api", "calls")]),
    ).toEqual([]);
    expect(orderHints(["orders-api", "payments"], [edge("orders-api", "payments", "calls", "low")])).toEqual([]);
    expect(orderHints(["orders-api", "shop-web"], [edge("orders-api", "payments", "calls")])).toEqual([]);
  });
});

describe("the workspace knowledge about a change's merge order", () => {
  test("is the approved relations about at least two of the change's repos", () => {
    const deployOrder = relation("payments-queue", ["orders-api", "payments", "billing"]);

    expect(
      orderRelations(
        ["payments", "orders-api"],
        [
          deployOrder,
          relation("one-repo", ["payments", "billing"]),
          relation("unapproved", ["payments", "orders-api"], false),
          relation("a-pitfall", ["payments", "orders-api"], true, "pitfall"),
        ],
      ),
    ).toEqual([deployOrder]);
  });
});
