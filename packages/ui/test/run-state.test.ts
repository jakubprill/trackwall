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

describe("stan uruchomienia taska mise w UI", () => {
  test("działający ma ton ok, zatrzymywany warning, a zakończony błędem error z kodem albo sygnałem", () => {
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
      { label: "nie uruchomiony" },
      { tone: "ok", label: "działa" },
      { tone: "warning", label: "zatrzymywanie" },
      { label: "zakończony" },
      { label: "zatrzymany" },
      { tone: "error", label: "błąd, kod 4" },
      { tone: "error", label: "przerwany (SIGKILL)" },
    ]);
    expect(runs.map(isLive)).toEqual([false, true, true, false, false, false, false]);
  });

  test("ostatnie linie widać tylko po błędzie, którego użytkownik sam nie spowodował", () => {
    expect(showsLastLines({ ...exited, exitCode: 4 })).toBe(true);
    expect(showsLastLines({ ...exited, exitCode: 0 })).toBe(false);
    expect(showsLastLines({ ...exited, exitCode: 1, stoppedByUser: true })).toBe(false);
    expect(showsLastLines({ ...exited, exitCode: 4, lastLines: [] })).toBe(false);
  });
});
