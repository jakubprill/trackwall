import { describe, expect, test } from "bun:test";
import { strongComponents } from "../src/modules/cards/strong-components.ts";

describe("strongly connected components", () => {
  test("a cycle is one component, and a component comes after the components it reaches", () => {
    // 0 → 1 ⇄ 2 → 3
    const { of, members } = strongComponents([[1], [2], [1, 3], []]);
    expect(members.map((m) => [...m].sort())).toEqual([[3], [1, 2], [0]]);
    expect(of[1]).toBe(of[2]);
  });

  test("a call chain deeper than the call stack does not overflow it", () => {
    const depth = 200_000;
    const edges = Array.from({ length: depth }, (_, i) => (i + 1 < depth ? [i + 1] : []));
    expect(strongComponents(edges).members).toHaveLength(depth);
  });
});
