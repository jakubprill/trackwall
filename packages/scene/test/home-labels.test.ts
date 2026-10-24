import { expect, test } from "bun:test";
import { repoLabel, sessionLabel } from "../src/home-labels.ts";

test("etykietę ma tylko repo, które nie jest czyste, i to samą nazwą", () => {
  expect(repoLabel({ id: "orders-bff", layer: 0, state: "changed", count: 4, hasMise: true, runningTask: null })).toBe("orders-bff");
  expect(repoLabel({ id: "users-api", layer: 0, state: "clean", count: 0, hasMise: true, runningTask: "dev" })).toBeNull();
});

test("sesja ma etykietę jednym słowem tylko wtedy, gdy trzeba działać", () => {
  expect(sessionLabel({ id: "s1", repo: "orders-bff", state: "attention" })).toBe("Needs you");
  expect(sessionLabel({ id: "s2", repo: "orders-bff", state: "error" })).toBe("Error");
  expect(sessionLabel({ id: "s3", repo: "orders-bff", state: "working" })).toBeNull();
  expect(sessionLabel({ id: "s4", repo: "orders-bff", state: "done" })).toBeNull();
});
