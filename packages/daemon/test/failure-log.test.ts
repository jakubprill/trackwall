import { expect, test } from "bun:test";
import { failureLog } from "../src/infra/failure-log.ts";

test("a failure that repeats on every tick is logged once, another message again, and the same one again after a success", async () => {
  const lines: string[] = [];
  const report = failureLog("server check", (line) => lines.push(line));
  const jobs = [
    () => Promise.reject(new Error("the projects folder is missing")),
    () => Promise.reject(new Error("the projects folder is missing")),
    () => Promise.reject(new Error("workspace.yaml cannot be read")),
    () => Promise.resolve(),
    () => Promise.reject(new Error("workspace.yaml cannot be read")),
  ];
  for (const job of jobs) {
    report(job());
    // The next tick comes after the job settled, as from a timer.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(lines).toEqual([
    "server check: the projects folder is missing",
    "server check: workspace.yaml cannot be read",
    "server check: workspace.yaml cannot be read",
  ]);
});
