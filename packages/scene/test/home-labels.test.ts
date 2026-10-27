import { expect, test } from "bun:test";
import { repoLabelTone, sessionHasLabel } from "../src/home-labels.ts";

test("a repo where something is going on has a full label in both modes", () => {
  expect(repoLabelTone({ id: "orders-bff", layer: 0, state: "changed", count: 4, runningTask: null }, "needs-you")).toBe("full");
  expect(repoLabelTone({ id: "orders-bff", layer: 0, state: "behind", count: 1, runningTask: null }, "all")).toBe("full");
  expect(repoLabelTone({ id: "users-api", layer: 0, state: "clean", count: 0, runningTask: "dev" }, "needs-you")).toBe("full");
});

test("a clean repo with nothing running has a quiet label only when every repo is named", () => {
  const quiet = { id: "users-api", layer: 0, state: "clean", count: 0, runningTask: null } as const;
  expect(repoLabelTone(quiet, "all")).toBe("quiet");
  expect(repoLabelTone(quiet, "needs-you")).toBeNull();
});

test("a session has a label only when it is waiting for you or has an error", () => {
  expect(sessionHasLabel({ id: "s1", repo: "orders-bff", state: "attention" })).toBe(true);
  expect(sessionHasLabel({ id: "s2", repo: "orders-bff", state: "error" })).toBe(true);
  expect(sessionHasLabel({ id: "s3", repo: "orders-bff", state: "working" })).toBe(false);
  expect(sessionHasLabel({ id: "s4", repo: "orders-bff", state: "done" })).toBe(false);
});
