import { describe, expect, test } from "bun:test";
import type { RunState } from "@trackwall/protocol";
import { isLive, runStateLabel, showsLastLines } from "../src/lib/run-state.ts";

const base = { runId: "r", startedAt: "2026-10-23T10:00:00Z" };
const exited = {
  ...base,
  kind: "exited" as const,
  endedAt: "2026-10-23T10:01:00Z",
  signal: null,
  stoppedByUser: false,
  lastLines: ["boom"],
};

describe("mise task run state in the UI", () => {
  test("a running one has tone ok, a stopping one warning, and one ended with an error tone error with the code or signal", () => {
    const runs: (RunState | null)[] = [
      null,
      { ...base, kind: "running", pid: 1 },
      { ...base, kind: "stopping", pid: 1 },
      { ...exited, exitCode: 0 },
      { ...exited, exitCode: 1, stoppedByUser: true },
      { ...exited, exitCode: 4 },
      { ...exited, exitCode: null, signal: "SIGKILL" },
    ];
    expect(runs.map(runStateLabel)).toEqual([
      { label: "not started" },
      { tone: "ok", label: "running" },
      { tone: "warning", label: "stopping" },
      { label: "finished" },
      { label: "stopped" },
      { tone: "error", label: "failed, code 4" },
      { tone: "error", label: "killed (SIGKILL)" },
    ]);
    expect(runs.map(isLive)).toEqual([false, true, true, false, false, false, false]);
  });

  test("the last lines are shown only after an error the user did not cause", () => {
    expect(showsLastLines({ ...exited, exitCode: 4 })).toBe(true);
    expect(showsLastLines({ ...exited, exitCode: 0 })).toBe(false);
    expect(showsLastLines({ ...exited, exitCode: 1, stoppedByUser: true })).toBe(false);
    expect(showsLastLines({ ...exited, exitCode: 4, lastLines: [] })).toBe(false);
  });
});
