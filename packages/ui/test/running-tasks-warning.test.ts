import { describe, expect, test } from "bun:test";
import type { RunningTasksWarningState, Session } from "@trackwall/protocol";
import { tasksStarting } from "../src/lib/new-session.ts";
import {
  computerDefaultLabel,
  parseRunningTasksWarning,
  runningTaskCount,
  runningTasksWarningNote,
} from "../src/lib/running-tasks-warning.ts";

// The warning before a start when too many tasks would run at once (ADR-244).

type Listed = Pick<Session, "task" | "run">;
const RUN_BASE = { runId: "r1", startedAt: "2026-11-13T10:00:00.000Z" };
const running = (task: string | null): Listed => ({ task, run: { ...RUN_BASE, kind: "running", pid: 100 } });
const stopping = (task: string): Listed => ({ task, run: { ...RUN_BASE, kind: "stopping", pid: 100 } });
const exited = (task: string): Listed => ({
  task,
  run: {
    ...RUN_BASE,
    kind: "exited",
    endedAt: "2026-11-13T10:05:00.000Z",
    exitCode: 0,
    signal: null,
    stoppedByUser: true,
    lastLines: [],
  },
});

const WARN_ABOVE_3: RunningTasksWarningState = { above: 3, computerDefault: 4, processors: 8, memoryGiB: 15.6 };

describe("counting running tasks", () => {
  test("a task counts while its session runs or is still stopping, not once it exited, and a session without a task never", () => {
    expect(runningTaskCount([running("t1"), stopping("t2"), exited("t3"), running(null)])).toBe(2);
  });

  test("a task with an exited session and a new running one counts once", () => {
    expect(runningTaskCount([exited("t1"), running("t1")])).toBe(1);
  });
});

describe("the warning under the start options", () => {
  test("three running tasks and a fourth to start, with the computer set to warn above 3, warn", () => {
    expect(runningTasksWarningNote([running("t1"), running("t2"), running("t3")], WARN_ABOVE_3, 1)).toBe(
      "3 tasks already run; this one makes 4, more than the 3 this computer is set to warn above. " +
        "Tasks share its processors and memory, so their builds, tests and your editor may slow down. " +
        "You can still start; Settings › Agents changes the number.",
    );
  });

  test("two running tasks and a third to start stay at the number, so nothing is said", () => {
    expect(runningTasksWarningNote([running("t1"), running("t2")], WARN_ABOVE_3, 1)).toBeNull();
  });

  test("starting several at once counts them all: one running and three ticked proposals make 4", () => {
    expect(runningTasksWarningNote([running("t1")], WARN_ABOVE_3, 3)).toContain("1 task already runs; these 3 make 4");
  });

  test("a change across more repos than the number warns even with nothing running", () => {
    expect(runningTasksWarningNote([], WARN_ABOVE_3, 4)).toContain("No task is running yet; these 4 make 4");
  });

  test("nothing is said for a session, which starts no task, or before the daemon gave the number", () => {
    const four = [running("t1"), running("t2"), running("t3"), running("t4")];
    expect(runningTasksWarningNote(four, WARN_ABOVE_3, 0)).toBeNull();
    expect(runningTasksWarningNote(four, undefined, 1)).toBeNull();
  });
});

describe("how many tasks the New session form starts", () => {
  test("a task starts one, also before its prompt is typed; a session none; a change one per repo", () => {
    expect(tasksStarting({ kind: "task", repo: "shop", prompt: "fix it" })).toBe(1);
    expect(tasksStarting({ kind: "needs-prompt" })).toBe(1);
    expect(tasksStarting({ kind: "session", repo: "shop", prompt: undefined })).toBe(0);
    expect(tasksStarting({ kind: "needs-repo" })).toBe(0);
    expect(
      tasksStarting({
        kind: "change",
        title: "Rename the order id",
        prompt: "rename it",
        parts: [
          { repo: "shop", note: "" },
          { repo: "billing", note: "" },
        ],
      }),
    ).toBe(2);
  });
});

describe("the number in Settings › Agents", () => {
  test("a whole number from 1 to 100 is taken", () => {
    expect(parseRunningTasksWarning(" 6 ")).toEqual({ above: 6 });
    expect(parseRunningTasksWarning("100")).toEqual({ above: 100 });
  });

  test("anything else is refused with what to type", () => {
    const problem = { problem: "Type a whole number of tasks from 1 to 100, such as 4." };
    expect(parseRunningTasksWarning("0")).toEqual(problem);
    expect(parseRunningTasksWarning("101")).toEqual(problem);
    expect(parseRunningTasksWarning("2.5")).toEqual(problem);
    expect(parseRunningTasksWarning("many")).toEqual(problem);
    expect(parseRunningTasksWarning("")).toEqual(problem);
  });

  test("the default is named with the computer it was computed for", () => {
    expect(computerDefaultLabel(WARN_ABOVE_3)).toBe("4 on this computer (8 processors, 15.6 GiB of memory)");
  });
});
