import { expect, test } from "bun:test";
import { repoHasLabel, sessionHasLabel } from "../src/home-labels.ts";

test("etykietę ma tylko repo, które nie jest czyste", () => {
  expect(repoHasLabel({ id: "orders-bff", layer: 0, state: "changed", count: 4, hasMise: true, runningTask: null })).toBe(true);
  expect(repoHasLabel({ id: "users-api", layer: 0, state: "clean", count: 0, hasMise: true, runningTask: "dev" })).toBe(false);
});

test("sesja ma etykietę tylko wtedy, gdy czeka na Ciebie albo ma błąd", () => {
  expect(sessionHasLabel({ id: "s1", repo: "orders-bff", state: "attention" })).toBe(true);
  expect(sessionHasLabel({ id: "s2", repo: "orders-bff", state: "error" })).toBe(true);
  expect(sessionHasLabel({ id: "s3", repo: "orders-bff", state: "working" })).toBe(false);
  expect(sessionHasLabel({ id: "s4", repo: "orders-bff", state: "done" })).toBe(false);
});
