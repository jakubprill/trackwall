import { describe, expect, test } from "bun:test";
import type { GraphEdge } from "@trackwall/protocol";
import { edgePairs, layoutGraph, NODE_WIDTH, neighbourhood } from "../src/lib/graph-layout.ts";

function edge(from: string, to: string, key = `${from}->${to}`, kind: GraphEdge["kind"] = "package"): GraphEdge {
  return { from, to, kind, key, confidence: "exact", evidence: [{ repo: from, path: "pom.xml", line: 1, detail: key }] };
}

function columns(layout: ReturnType<typeof layoutGraph>): string[][] {
  const result: string[][] = [];
  for (const box of [...layout.boxes.values()].sort((a, b) => a.y - b.y)) result[box.column] = [...(result[box.column] ?? []), box.repo];
  return result;
}

describe("layoutGraph", () => {
  test("kolumna to najdłuższa ścieżka od repo, którego nikt nie używa: frontend, BFF, API, biblioteka", () => {
    const layout = layoutGraph(
      ["web", "bff", "api", "lib"],
      [edge("web", "bff"), edge("bff", "api"), edge("api", "lib"), edge("bff", "lib")],
    );
    expect(columns(layout)).toEqual([["web"], ["bff"], ["api"], ["lib"]]);
    expect(layout.boxes.get("lib")?.x).toBe(3 * (layout.boxes.get("bff")?.x ?? 0));
    expect(layout.width).toBe(4 * NODE_WIDTH + 3 * (layout.boxes.get("bff")?.x ?? 0) - 3 * NODE_WIDTH);
  });

  test("repo bez krawędzi nie zajmuje kolumny, tylko trafia do isolated w kolejności listy", () => {
    const layout = layoutGraph(["z-samotne", "a", "b", "a-samotne"], [edge("a", "b")]);
    expect(layout.isolated).toEqual(["z-samotne", "a-samotne"]);
    expect(columns(layout)).toEqual([["a"], ["b"]]);
  });

  test("cykl nie zapętla układu: każde repo cyklu dostaje kolumnę", () => {
    const layout = layoutGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    expect(columns(layout)).toEqual([["a"], ["b"], ["c"]]);
    expect(layout.pairs).toHaveLength(3);
  });

  test("pusty graf ma zerowy rozmiar", () => {
    expect(layoutGraph([], [])).toMatchObject({ width: 0, height: 0, isolated: [], pairs: [] });
  });

  test("kolumna jest porządkowana według sąsiadów, żeby linie się nie krzyżowały", () => {
    // a1 używa b2, a2 używa b1: po nazwie b1 i b2 stałyby odwrotnie niż ich klienci.
    const layout = layoutGraph(["a1", "a2", "b1", "b2"], [edge("a1", "b2"), edge("a2", "b1")]);
    expect(columns(layout)).toEqual([
      ["a1", "a2"],
      ["b2", "b1"],
    ]);
  });
});

describe("edgePairs i neighbourhood", () => {
  test("krawędzie jednej pary repo są jedną linią z listą rodzajów", () => {
    const pairs = edgePairs([edge("a", "b", "x"), edge("a", "b", "opis", "manual"), edge("b", "c")]);
    expect(pairs.map((p) => [p.from, p.to, p.edges.length, p.kinds])).toEqual([
      ["a", "b", 2, ["package", "manual"]],
      ["b", "c", 1, ["package"]],
    ]);
  });

  test("sąsiedztwo to repo połączone w obie strony i ono samo", () => {
    const pairs = edgePairs([edge("a", "b"), edge("c", "a"), edge("b", "d")]);
    expect([...neighbourhood("a", pairs)].sort()).toEqual(["a", "b", "c"]);
  });
});
