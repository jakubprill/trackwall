import { expect, test } from "bun:test";
import { repoHasLabel, sessionHasLabel } from "../src/home-labels.ts";

test("only a repo that is not clean has a label", () => {
  expect(repoHasLabel({ id: "orders-bff", layer: 0, state: "changed", count: 4, runningTask: null })).toBe(true);
  expect(repoHasLabel({ id: "users-api", layer: 0, state: "clean", count: 0, runningTask: "dev" })).toBe(false);
});

test("a session has a label only when it is waiting for you or has an error", () => {
  expect(sessionHasLabel({ id: "s1", repo: "orders-bff", state: "attention" })).toBe(true);
  expect(sessionHasLabel({ id: "s2", repo: "orders-bff", state: "error" })).toBe(true);
  expect(sessionHasLabel({ id: "s3", repo: "orders-bff", state: "working" })).toBe(false);
  expect(sessionHasLabel({ id: "s4", repo: "orders-bff", state: "done" })).toBe(false);
});
