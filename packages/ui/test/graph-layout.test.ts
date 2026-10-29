import { describe, expect, test } from "bun:test";
import type { GraphEdge } from "@trackwall/protocol";
import { edgePairs, layoutGraph, NODE_WIDTH, neighbourhood } from "../src/lib/graph-layout.ts";

function edge(from: string, to: string, key = `${from}->${to}`, source: GraphEdge["source"] = "package"): GraphEdge {
  const kind = source === "package" ? "depends-on" : "calls";
  return { from, to, kind, source, key, confidence: "exact", evidence: [{ repo: from, path: "pom.xml", line: 1, detail: key }] };
}

function columns(layout: ReturnType<typeof layoutGraph>): string[][] {
  const result: string[][] = [];
  for (const box of [...layout.boxes.values()].sort((a, b) => a.y - b.y)) result[box.column] = [...(result[box.column] ?? []), box.repo];
  return result;
}

describe("layoutGraph", () => {
  test("the column is the longest path from a repo nobody uses: frontend, BFF, API, library", () => {
    const layout = layoutGraph(
      ["web", "bff", "api", "lib"],
      [edge("web", "bff"), edge("bff", "api"), edge("api", "lib"), edge("bff", "lib")],
    );
    expect(columns(layout)).toEqual([["web"], ["bff"], ["api"], ["lib"]]);
    expect(layout.boxes.get("lib")?.x).toBe(3 * (layout.boxes.get("bff")?.x ?? 0));
    expect(layout.width).toBe(4 * NODE_WIDTH + 3 * (layout.boxes.get("bff")?.x ?? 0) - 3 * NODE_WIDTH);
  });

  test("a repo without edges takes no column and goes to isolated in list order", () => {
    const layout = layoutGraph(["z-alone", "a", "b", "a-alone"], [edge("a", "b")]);
    expect(layout.isolated).toEqual(["z-alone", "a-alone"]);
    expect(columns(layout)).toEqual([["a"], ["b"]]);
  });

  test("a cycle does not loop the layout: every repo in the cycle gets a column", () => {
    const layout = layoutGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    expect(columns(layout)).toEqual([["a"], ["b"], ["c"]]);
    expect(layout.pairs).toHaveLength(3);
  });

  test("an empty graph has zero size", () => {
    expect(layoutGraph([], [])).toMatchObject({ width: 0, height: 0, isolated: [], pairs: [] });
  });

  test("a column is ordered by neighbours so that lines do not cross", () => {
    // a1 uses b2, a2 uses b1: by name b1 and b2 would stand opposite to their clients.
    const layout = layoutGraph(["a1", "a2", "b1", "b2"], [edge("a1", "b2"), edge("a2", "b1")]);
    expect(columns(layout)).toEqual([
      ["a1", "a2"],
      ["b2", "b1"],
    ]);
  });
});

describe("edgePairs and neighbourhood", () => {
  test("the edges of one repo pair are one line", () => {
    const pairs = edgePairs([edge("a", "b", "x"), edge("a", "b", "description", "manual"), edge("b", "c")]);
    expect(pairs.map((p) => [p.from, p.to, p.edges.map((e) => e.key)])).toEqual([
      ["a", "b", ["x", "description"]],
      ["b", "c", ["b->c"]],
    ]);
  });

  test("the neighbourhood is the repos connected in either direction and the repo itself", () => {
    const pairs = edgePairs([edge("a", "b"), edge("c", "a"), edge("b", "d")]);
    expect([...neighbourhood("a", pairs)].sort()).toEqual(["a", "b", "c"]);
  });
});
