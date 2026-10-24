import { describe, expect, test } from "bun:test";
import type { BatchRun, BatchStepResult } from "@trackwall/protocol";
import { batchProgress, batchRunLabel, stepLabel, stepMessage } from "../src/lib/batch-state.ts";

describe("komenda zbiorcza w UI", () => {
  test("krok ma krótki tekst: trwający ostrzega, gotowy pokazuje wynik synchronizacji, nieudany to błąd", () => {
    const steps: BatchStepResult[] = [
      { step: "sync", state: "waiting" },
      { step: "sync", state: "running" },
      { step: "sync", state: "done", detail: "main +2" },
      { step: "build", state: "done", detail: null },
      { step: "setup", state: "skipped", message: "repo nie ma taska mise setup" },
      { step: "build", state: "failed", message: "exited with code 1", lastLines: [] },
      { step: "tools", state: "cancelled" },
    ];
    expect(steps.map(stepLabel)).toEqual([
      { label: "waiting" },
      { tone: "warning", label: "running…" },
      { tone: "ok", label: "main +2" },
      { tone: "ok", label: "done" },
      { label: "skipped" },
      { tone: "error", label: "failed" },
      { label: "cancelled" },
    ]);
    expect(steps.map(stepMessage)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      "repo nie ma taska mise setup",
      "exited with code 1",
      undefined,
    ]);
  });

  test("postęp liczy repo, w których żaden krok nie czeka ani nie trwa, i osobno repo z błędem", () => {
    const repo = { repo: "api", path: "/projekty/api" };
    const run: BatchRun = {
      startedAt: "2026-10-23T10:00:00Z",
      finishedAt: null,
      cancelled: false,
      repos: [
        {
          ...repo,
          steps: [
            { step: "sync", state: "done", detail: "main aktualna" },
            { step: "build", state: "running" },
          ],
        },
        {
          ...repo,
          steps: [
            { step: "sync", state: "waiting" },
            { step: "build", state: "waiting" },
          ],
        },
        {
          ...repo,
          steps: [
            { step: "sync", state: "done", detail: null },
            { step: "build", state: "done", detail: null },
          ],
        },
        {
          ...repo,
          steps: [
            { step: "sync", state: "failed", message: "Permission denied (publickey).", lastLines: [] },
            { step: "build", state: "skipped", message: "skipped after step sync failed" },
          ],
        },
      ],
    };
    expect(batchProgress(run)).toEqual({ done: 2, total: 4, failed: 1 });
  });

  test("nagłówek wyników mówi, czy komenda trwa, czy się skończyła, i czy ją przerwano", () => {
    const run = { startedAt: "2026-10-23T10:00:00Z", repos: [] };
    const now = new Date("2026-10-23T10:00:30Z");
    expect(batchRunLabel({ ...run, finishedAt: null, cancelled: false }, now)).toBe("Running");
    expect(batchRunLabel({ ...run, finishedAt: null, cancelled: true }, now)).toBe("Cancelling");
    expect(batchRunLabel({ ...run, finishedAt: "2026-10-23T10:00:20Z", cancelled: false }, now)).toBe("Finished just now");
    expect(batchRunLabel({ ...run, finishedAt: "2026-10-23T10:00:20Z", cancelled: true }, now)).toBe("Cancelled just now");
  });
});
