import { expect, test } from "bun:test";
import { repoKind } from "../src/repo-kind.ts";

test("rodzaj modelu repo wynika z warstwy: wejście, bramka, środek, biblioteki", () => {
  expect([0, 1, 2, 3].map((layer) => repoKind(layer, 4))).toEqual(["terminal", "gateway", "rack", "crate"]);
  expect([0, 1, 2].map((layer) => repoKind(layer, 3))).toEqual(["terminal", "rack", "crate"]);
  expect([0, 1].map((layer) => repoKind(layer, 2))).toEqual(["terminal", "crate"]);
  expect(repoKind(0, 1)).toBe("rack");
});
