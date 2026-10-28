import { describe, expect, test } from "bun:test";
import { Slots } from "../src/modules/vcs/slots.ts";
import { WaitingCalls } from "../src/modules/vcs/waiting-calls.ts";

/** A job that runs until the test lets it finish. */
function heldJob() {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { job: () => done, finish };
}

describe("WaitingCalls", () => {
  test("a call identical to one still waiting for a slot gets that call's answer and starts no job of its own", async () => {
    const slots = new Slots(1);
    const blocker = heldJob();
    const busy = slots.run(blocker.job);
    const calls = new WaitingCalls<string>(slots);
    let jobs = 0;
    const status = () => {
      jobs++;
      return Promise.resolve(`status ${jobs}`);
    };

    const first = calls.run("orders\0status", status);
    const second = calls.run("orders\0status", status);
    blocker.finish();
    await busy;

    expect(await Promise.all([first, second])).toEqual(["status 1", "status 1"]);
    expect(jobs).toBe(1);
  });

  test("a call identical to one that has already started runs again, so its answer begins after it asked", async () => {
    const calls = new WaitingCalls<string>(new Slots(2));
    const running = heldJob();
    let jobs = 0;
    const first = calls.run("orders\0status", async () => {
      jobs++;
      await running.job();
      return "before the commit";
    });
    const second = calls.run("orders\0status", async () => {
      jobs++;
      return "after the commit";
    });
    running.finish();

    expect(await Promise.all([first, second])).toEqual(["before the commit", "after the commit"]);
    expect(jobs).toBe(2);
  });

  test("calls with different keys waiting for a slot each run their own job", async () => {
    const slots = new Slots(1);
    const blocker = heldJob();
    const busy = slots.run(blocker.job);
    const calls = new WaitingCalls<string>(slots);

    const orders = calls.run("orders\0status", () => Promise.resolve("orders"));
    const payments = calls.run("payments\0status", () => Promise.resolve("payments"));
    blocker.finish();
    await busy;

    expect(await Promise.all([orders, payments])).toEqual(["orders", "payments"]);
  });

  test("after a joined call fails, the next identical call runs a job of its own", async () => {
    const slots = new Slots(1);
    const blocker = heldJob();
    const busy = slots.run(blocker.job);
    const calls = new WaitingCalls<string>(slots);

    const failed = calls.run("orders\0status", () => Promise.reject(new Error("index.lock")));
    blocker.finish();
    await busy;
    await expect(failed).rejects.toThrow("index.lock");

    expect(await calls.run("orders\0status", () => Promise.resolve("clean"))).toBe("clean");
  });
});
