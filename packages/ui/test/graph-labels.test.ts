import { describe, expect, test } from "bun:test";
import type { GraphProblem } from "@trackwall/protocol";
import { edgeLabel, problemClient, repoProblems } from "../src/lib/graph-labels.ts";

function problem(repo: string, client: string): GraphProblem {
  return {
    code: "unresolved-call-target",
    repo,
    via: "feign",
    client,
    evidence: { path: "src/main/java/PaymentsClient.java", line: 7 },
    message: "no repo in the list is “payments”",
  };
}

describe("graph labels", () => {
  test("an edge says what it is and where it comes from", () => {
    expect(edgeLabel({ kind: "calls", source: "http" })).toBe("calls · HTTP");
    expect(edgeLabel({ kind: "depends-on", source: "package" })).toBe("depends on · package");
    expect(edgeLabel({ kind: "depends-on", source: "manual" })).toBe("depends on · manual");
  });

  test("a repo's problems are only its own, in the graph's order", () => {
    const graph = { problems: [problem("bff", "PaymentsClient"), problem("web", "Api"), problem("bff", "StockClient")] };
    expect(repoProblems(graph, "bff").map((p) => p.client)).toEqual(["PaymentsClient", "StockClient"]);
  });

  test("the client of a problem is named with its kind", () => {
    expect(problemClient(problem("bff", "PaymentsClient"))).toBe("Feign PaymentsClient");
  });
});
