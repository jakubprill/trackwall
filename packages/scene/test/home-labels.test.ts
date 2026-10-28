import { expect, test } from "bun:test";
import { repoLabelTone, sessionHasLabel } from "../src/home-labels.ts";

test("a repo that is not clean has a full label in both modes", () => {
  expect(repoLabelTone({ id: "orders-bff", layer: 0, state: "changed", count: 4, runningTask: null }, "needs-you")).toBe("full");
  expect(repoLabelTone({ id: "orders-bff", layer: 0, state: "behind", count: 1, runningTask: null }, "all")).toBe("full");
});

test("a clean repo with a running mise task has a full label only when every repo is named, as it is not in the Needs you queue", () => {
  const running = { id: "users-api", layer: 0, state: "clean", count: 0, runningTask: "dev" } as const;
  expect(repoLabelTone(running, "all")).toBe("full");
  expect(repoLabelTone(running, "needs-you")).toBeNull();
});

test("a clean repo with nothing running has a quiet label only when every repo is named", () => {
  const quiet = { id: "users-api", layer: 0, state: "clean", count: 0, runningTask: null } as const;
  expect(repoLabelTone(quiet, "all")).toBe("quiet");
  expect(repoLabelTone(quiet, "needs-you")).toBeNull();
});

test("a repo whose status has not come yet is not in the Needs you labels, and is named quietly when every repo is", () => {
  const loading = { id: "users-api", layer: 0, state: "loading", count: 0, runningTask: null } as const;
  expect(repoLabelTone(loading, "needs-you")).toBeNull();
  expect(repoLabelTone(loading, "all")).toBe("quiet");
});

test("a session has a label only when it is waiting for you or has an error", () => {
  expect(sessionHasLabel({ id: "s1", repo: "orders-bff", state: "attention" })).toBe(true);
  expect(sessionHasLabel({ id: "s2", repo: "orders-bff", state: "error" })).toBe(true);
  expect(sessionHasLabel({ id: "s3", repo: "orders-bff", state: "working" })).toBe(false);
  expect(sessionHasLabel({ id: "s4", repo: "orders-bff", state: "done" })).toBe(false);
});
