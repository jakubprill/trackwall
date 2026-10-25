import { describe, expect, test } from "bun:test";
import type { LogError, LogErrorsQuery, MiseTarget, RunState, TestFailure, TestResults, Verification } from "@trackwall/protocol";
import { DomainError } from "../src/infra/errors.ts";
import { Verifications } from "../src/modules/verification/verifications.ts";
import { waitUntil } from "../src/platform/process-group.ts";

const STARTED_AT = "2026-10-25T10:00:00.000Z";
const ENDED_AT = "2026-10-25T10:00:41.000Z";

function exited(runId: string, exitCode: number | null, { stoppedByUser = false, lastLines = [] as string[] } = {}): RunState {
  return { kind: "exited", runId, startedAt: STARTED_AT, endedAt: ENDED_AT, exitCode, signal: null, stoppedByUser, lastLines };
}

function results(failures: TestFailure[], { tests = 3, reports = 1, earlierReports = 0, unread = 0 } = {}): TestResults {
  const failed = failures.filter((f) => f.kind === "failure").length;
  const errored = failures.length - failed;
  return {
    dir: "/worktree",
    totals: { tests, failures: failed, errors: errored, skipped: 0, timeSeconds: 1.5 },
    reports: Array.from({ length: reports }, (_, i) => ({
      path: `target/surefire-reports/TEST-${i}.xml`,
      modifiedAt: STARTED_AT,
      tests,
      failures: failed,
      errors: errored,
      skipped: 0,
      timeSeconds: 1.5,
    })),
    failures,
    problems: Array.from({ length: unread }, (_, i) => ({
      path: `target/surefire-reports/TEST-big-${i}.xml`,
      message: "larger than 20 MB, not read",
    })),
    earlierReports,
    truncated: false,
  };
}

const CART_SUM: TestFailure = {
  report: "target/surefire-reports/TEST-shop.CartTest.xml",
  suite: "shop.CartTest",
  className: "shop.CartTest",
  name: "sums",
  kind: "failure",
  type: "org.opentest4j.AssertionFailedError",
  message: "expected: <3> but was: <4>",
  lines: [],
  omittedLines: 0,
  timeSeconds: 0.1,
};

function logError(runId: string, seq: number, line: string): LogError {
  const source = { kind: "task-mise-task", repo: "shop", task: "t1", miseTask: "test" } as const;
  return {
    source,
    runId,
    stream: "stdout",
    level: "error",
    exception: null,
    lines: [line],
    omittedLines: 0,
    seq,
    ts: STARTED_AT,
    firstTs: STARTED_AT,
    count: 1,
  };
}

/**
 * The module on fakes of `agents`, `mise`, `test-results` and `logs`: the run ends when the test calls `end`, so the
 * test sees the verification while it runs and after. `mcp-verification.test.ts` runs the real modules.
 */
function setup({
  miseTasks = ["test"],
  reports = results([]),
  logErrors = [] as LogError[],
}: {
  miseTasks?: string[];
  reports?: TestResults | Error;
  logErrors?: LogError[];
} = {}) {
  const tasks = new Map([["t1", { repo: "shop" }]]);
  const calls: string[] = [];
  let runs = 0;
  let current: { run: RunState; finish: (state: RunState) => void; ended: Promise<RunState> } | undefined;
  const readSince: (string | undefined)[] = [];
  const errorRequests: LogErrorsQuery[] = [];
  const verdicts: Verification[] = [];
  const mise = {
    start: async (target: MiseTarget, miseTask: string) => {
      calls.push(`start ${target.repo}/${target.task}/${miseTask}`);
      if (!miseTasks.includes(miseTask)) throw new DomainError("not_found", `the worktree has no mise task "${miseTask}"`);
      if (current?.run.kind === "running") return current.run;
      let finish: (state: RunState) => void = () => {};
      const ended = new Promise<RunState>((resolve) => {
        finish = resolve;
      });
      const run: RunState = { kind: "running", runId: `run-${++runs}`, startedAt: STARTED_AT, pid: 100 };
      current = { run, finish, ended };
      return run;
    },
    ended: async () => current?.ended,
    run: () => current?.run,
    stop: async (target: MiseTarget, miseTask: string) => {
      calls.push(`stop ${target.repo}/${target.task}/${miseTask}`);
      const run = current?.run ?? exited("none", null);
      current?.finish(exited(run.runId, null, { stoppedByUser: true }));
      return exited(run.runId, null, { stoppedByUser: true });
    },
  };
  const verifications = new Verifications({
    tasks: {
      task: (id) => {
        const task = tasks.get(id);
        if (!task) throw new DomainError("not_found", `there is no task ${id}`);
        return task;
      },
      findTask: (id) => tasks.get(id),
    },
    mise,
    testReports: {
      results: async (_target, since) => {
        readSince.push(since);
        if (reports instanceof Error) throw reports;
        return reports;
      },
    },
    logs: {
      errors: (request) => {
        errorRequests.push(request);
        return { errors: logErrors, truncated: false, nextSeq: 0, dropped: false };
      },
    },
    onVerdict: (verification) => verdicts.push(verification),
    log: () => {},
  });
  /** Ends the current run like `procs` does once the group is confirmed empty. */
  const end = async (exitCode: number | null, options: { lastLines?: string[] } = {}) => {
    if (!current) throw new Error("no run to end");
    current.finish(exited(current.run.runId, exitCode, options));
    current.run = exited(current.run.runId, exitCode, options);
    // The verdict is computed after the end, in the background.
    expect(await waitUntil(() => verifications.get("t1")?.state !== "running", 2000)).toBe(true);
  };
  return { verifications, mise, tasks, calls, readSince, errorRequests, verdicts, end };
}

describe("verification of a task", () => {
  test("runs the mise task test in the task's worktree and passes on exit code 0 without failed tests", async () => {
    const { verifications, calls, readSince, end } = setup({ reports: results([], { tests: 12 }) });

    const started = await verifications.start("t1");
    expect(started).toMatchObject({ task: "t1", repo: "shop", miseTask: "test", state: "running", runId: "run-1", finishedAt: null });
    expect(calls).toEqual(["start shop/t1/test"]);

    await end(0);
    expect(verifications.get("t1")).toMatchObject({
      state: "passed",
      startedAt: STARTED_AT,
      finishedAt: ENDED_AT,
      exitCode: 0,
      message: null,
      tests: { totals: { tests: 12, failures: 0 }, reports: 1, earlierReports: 0, truncated: false },
      failures: [],
      errors: [],
      lastLines: [],
    });
    expect(readSince).toEqual([STARTED_AT]);
  });

  test("fails on a non-zero exit code with the first failed tests and this run's log errors in the order they were logged", async () => {
    const logErrors = [
      logError("run-1", 30, "[ERROR] Tests run: 3, Failures: 1"),
      logError("run-0", 20, "an error of an earlier run"),
      logError("run-1", 10, "[ERROR] CartTest.sums:12 expected: <3> but was: <4>"),
    ];
    const { verifications, errorRequests, end } = setup({ reports: results([CART_SUM]), logErrors });
    await verifications.start("t1");

    await end(1, { lastLines: ["BUILD FAILURE"] });
    const verification = verifications.get("t1");
    expect(verification).toMatchObject({
      state: "failed",
      exitCode: 1,
      message: "mise task test exited with code 1",
      lastLines: ["BUILD FAILURE"],
    });
    expect(verification?.failures.map((f) => f.name)).toEqual(["sums"]);
    expect(verification?.errors.map((e) => e.lines[0])).toEqual([
      "[ERROR] CartTest.sums:12 expected: <3> but was: <4>",
      "[ERROR] Tests run: 3, Failures: 1",
    ]);
    expect(errorRequests).toEqual([{ repo: "shop", task: "t1", miseTask: "test", minLevel: "error", limit: 2000 }]);
  });

  test("fails when a report has a failed test although the mise task exited with code 0", async () => {
    const { verifications, end } = setup({ reports: results([CART_SUM, { ...CART_SUM, name: "totals" }]) });
    await verifications.start("t1");

    await end(0);
    expect(verifications.get("t1")).toMatchObject({
      state: "failed",
      message: "2 tests failed in the test reports, although mise task test exited with code 0",
    });
  });

  test("passes without reports, but says the run wrote none and how many earlier reports were left out", async () => {
    const { verifications, end } = setup({ reports: results([], { tests: 0, reports: 0, earlierReports: 4 }) });
    await verifications.start("t1");

    await end(0);
    expect(verifications.get("t1")).toMatchObject({
      state: "passed",
      message: "the run wrote no test reports; 4 from earlier runs were left out (tests up to date?)",
      tests: { reports: 0, earlierReports: 4 },
    });
  });

  test("a second start while one runs returns the running verification and starts nothing", async () => {
    const { verifications, calls, end } = setup();
    const [first, second] = await Promise.all([verifications.start("t1"), verifications.start("t1")]);
    const third = await verifications.start("t1");

    expect([first.runId, second.runId, third.runId]).toEqual(["run-1", "run-1", "run-1"]);
    expect(calls).toEqual(["start shop/t1/test"]);

    await end(0);
    expect((await verifications.start("t1")).runId).toBe("run-2");
  });

  test("cancel stops the run, and the verification ends cancelled without a verdict", async () => {
    const { verifications, calls } = setup();
    await verifications.start("t1");

    const cancelled = await verifications.cancel("t1");
    expect(calls).toEqual(["start shop/t1/test", "stop shop/t1/test"]);
    expect(cancelled).toMatchObject({ state: "cancelled", tests: null, failures: [], errors: [] });
  });

  test("every verdict, a cancel included, goes to the listener once, and a running verification does not", async () => {
    const { verifications, verdicts, end } = setup({ reports: results([], { tests: 3 }) });

    await verifications.start("t1");
    expect(verdicts).toEqual([]);
    await end(0);
    await verifications.start("t1");
    await verifications.cancel("t1");

    expect(verdicts.map((v) => [v.runId, v.state])).toEqual([
      ["run-1", "passed"],
      ["run-2", "cancelled"],
    ]);
  });

  test("a worktree without the mise task test is the caller's error, and no verification is kept", async () => {
    const { verifications } = setup({ miseTasks: ["build"] });

    await expect(verifications.start("t1")).rejects.toThrow('the worktree has no mise task "test"');
    expect(verifications.get("t1")).toBeNull();
  });

  test("verify waits for the verdict, and after its time limit returns the verification still running", async () => {
    const { verifications, end } = setup();

    const waited = await verifications.verify("t1", undefined, 50, new AbortController().signal);
    expect(waited.state).toBe("running");

    const verdict = verifications.verify("t1", undefined, 5000, new AbortController().signal);
    await end(0);
    expect((await verdict).state).toBe("passed");
  });

  test("an ended task has no verification any more", async () => {
    const { verifications, tasks, end } = setup();
    await verifications.start("t1");
    await end(0);

    tasks.delete("t1");
    expect(verifications.get("t1")).toBeNull();
  });

  test("a test the agent already runs in the worktree is joined, and only reports written since that run started count", async () => {
    const { verifications, mise, calls, readSince, end } = setup();
    const agentRun = await mise.start({ repo: "shop", task: "t1" }, "test");

    const verification = await verifications.start("t1");
    expect(verification.runId).toBe(agentRun.runId);
    expect(calls).toEqual(["start shop/t1/test", "start shop/t1/test"]);

    await end(0);
    expect(readSince).toEqual([agentRun.startedAt]);
  });

  test("reports that cannot be read leave the verdict to the exit code, with the reason", async () => {
    const { verifications, end } = setup({ reports: new Error("cannot read /worktree: EACCES") });
    await verifications.start("t1");

    await end(0);
    expect(verifications.get("t1")).toMatchObject({
      state: "passed",
      tests: null,
      message: "test reports not read: cannot read /worktree: EACCES",
    });
  });
  test("a report the run wrote that cannot be read fails the verification even on exit code 0", async () => {
    const { verifications, end } = setup({ reports: results([], { tests: 3, unread: 1 }) });
    await verifications.start("t1");

    await end(0);
    expect(verifications.get("t1")).toMatchObject({
      state: "failed",
      message: "1 test report could not be read, so failed tests may be missing",
      tests: { unreadReports: 1 },
    });
  });

  test("verify with the runId of a running verification returns that one after it finished, and starts nothing", async () => {
    const { verifications, calls, end } = setup();
    const first = await verifications.verify("t1", undefined, 20, new AbortController().signal);
    await end(1);

    const again = await verifications.verify("t1", first.runId, 5000, new AbortController().signal);
    expect(again).toMatchObject({ runId: first.runId, state: "failed" });
    expect(calls).toEqual(["start shop/t1/test"]);
    await expect(verifications.verify("t1", "run-0", 5000, new AbortController().signal)).rejects.toThrow(
      "has no verification of run run-0",
    );
  });
  test("the message names both the failed tests and the reports that could not be read", async () => {
    const { verifications, end } = setup({ reports: results([CART_SUM], { unread: 2 }) });
    await verifications.start("t1");

    await end(0);
    expect(verifications.get("t1")?.message).toBe(
      "1 test failed in the test reports, although mise task test exited with code 0; 2 test reports could not be read, so failed tests may be missing",
    );
  });
});
