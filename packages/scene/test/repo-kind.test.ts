import { expect, test } from "bun:test";
import { repoKind } from "../src/repo-kind.ts";

test("przy czterech warstwach i więcej: wejście, brama, serwisy, biblioteki", () => {
  expect([0, 1, 2, 3].map((layer) => repoKind(layer, 4))).toEqual(["entry", "gateway", "service", "library"]);
  expect([0, 1, 2, 3, 4].map((layer) => repoKind(layer, 5))).toEqual(["entry", "gateway", "service", "service", "library"]);
});

test("przy trzech warstwach druga to serwisy, nie brama", () => {
  expect([0, 1, 2].map((layer) => repoKind(layer, 3))).toEqual(["entry", "service", "library"]);
});

test("przy dwóch warstwach są tylko wejścia i biblioteki", () => {
  expect([0, 1].map((layer) => repoKind(layer, 2))).toEqual(["entry", "library"]);
});

test("jedna warstwa i repo bez połączeń to serwisy", () => {
  expect(repoKind(0, 1)).toBe("service");
  expect(repoKind(null, 4)).toBe("service");
});
