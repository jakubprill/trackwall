import { expect, test } from "bun:test";
import { repoKind } from "../src/repo-kind.ts";

test("with four layers or more: entry, gateway, backends, libraries", () => {
  expect([0, 1, 2, 3].map((layer) => repoKind(layer, 4))).toEqual(["entry", "gateway", "backend", "library"]);
  expect([0, 1, 2, 3, 4].map((layer) => repoKind(layer, 5))).toEqual(["entry", "gateway", "backend", "backend", "library"]);
});

test("with three layers the second is backends, not a gateway", () => {
  expect([0, 1, 2].map((layer) => repoKind(layer, 3))).toEqual(["entry", "backend", "library"]);
});

test("with two layers there are only entries and libraries", () => {
  expect([0, 1].map((layer) => repoKind(layer, 2))).toEqual(["entry", "library"]);
});

test("one layer and repos without connections are backends", () => {
  expect(repoKind(0, 1)).toBe("backend");
  expect(repoKind(null, 4)).toBe("backend");
});
