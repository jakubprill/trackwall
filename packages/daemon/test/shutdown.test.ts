import { expect, test } from "bun:test";
import { shutdownOnce } from "../src/infra/shutdown.ts";

test("a second stop request waits for the first stop and keeps its exit code", async () => {
  const stops: string[] = [];
  const exits: number[] = [];
  const shutdown = shutdownOnce(
    async (reason) => {
      stops.push(reason);
    },
    (code) => exits.push(code),
  );

  await Promise.all([shutdown("the scene did not come up", 1), shutdown("SIGINT")]);

  expect(stops).toEqual(["the scene did not come up"]);
  expect(exits).toEqual([1]);
});

test("a stop that fails still ends the process, with exit code 1", async () => {
  const exits: number[] = [];
  const shutdown = shutdownOnce(
    () => Promise.reject(new Error("the port did not close")),
    (code) => exits.push(code),
  );

  await shutdown("SIGINT");

  expect(exits).toEqual([1]);
});
