import { expect, test } from "bun:test";
import { repoKind } from "../src/repo-kind.ts";

test("przy czterech warstwach i więcej: wejście, brama, backendy, biblioteki", () => {
  expect([0, 1, 2, 3].map((layer) => repoKind(layer, 4))).toEqual(["entry", "gateway", "backend", "library"]);
  expect([0, 1, 2, 3, 4].map((layer) => repoKind(layer, 5))).toEqual(["entry", "gateway", "backend", "backend", "library"]);
});

test("przy trzech warstwach druga to backendy, nie brama", () => {
  expect([0, 1, 2].map((layer) => repoKind(layer, 3))).toEqual(["entry", "backend", "library"]);
});

test("przy dwóch warstwach są tylko wejścia i biblioteki", () => {
  expect([0, 1].map((layer) => repoKind(layer, 2))).toEqual(["entry", "library"]);
});

test("jedna warstwa i repo bez połączeń to backendy", () => {
  expect(repoKind(0, 1)).toBe("backend");
  expect(repoKind(null, 4)).toBe("backend");
});
