import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@trackwall/protocol";
import { folderSize, lastActivity } from "../src/modules/agents/task-worktrees.ts";

const NOW = new Date("2026-11-04T12:00:00.000Z");

function session(startedAt: string, endedAt: string | null): Session {
  const run = endedAt === null ? { kind: "running" } : { kind: "exited", endedAt };
  // Only the fields the activity reads; the rest of a session does not matter here.
  return { startedAt, run } as unknown as Session;
}

describe("the last activity of a task (ADR-210)", () => {
  test("is the newest of its start, its report, its last commit and its sessions' starts and ends", () => {
    const task = { createdAt: "2026-10-20T08:00:00.000Z", summary: null };

    expect(lastActivity(task, [], null, NOW)).toBe("2026-10-20T08:00:00.000Z");
    expect(lastActivity(task, [], "2026-10-21T09:00:00.000Z", NOW)).toBe("2026-10-21T09:00:00.000Z");
    expect(lastActivity(task, [session("2026-10-22T08:00:00.000Z", "2026-10-23T10:00:00.000Z")], "2026-10-21T09:00:00.000Z", NOW)).toBe(
      "2026-10-23T10:00:00.000Z",
    );
  });

  test("a session that runs makes the task active now", () => {
    const task = { createdAt: "2026-10-20T08:00:00.000Z", summary: null };

    expect(lastActivity(task, [session("2026-10-22T08:00:00.000Z", null)], null, NOW)).toBe(NOW.toISOString());
  });

  test("a task without a readable moment is an error, not a made-up date", () => {
    expect(() => lastActivity({ createdAt: "not a date", summary: null }, [], null, NOW)).toThrow(
      "task created at not a date has no readable moment of activity",
    );
  });
});

describe("the size of a worktree (ADR-210)", () => {
  test("counts every file below it, ignored ones too, without following a link out of it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-size-"));
    const outside = mkdtempSync(join(tmpdir(), "trackwall-size-outside-"));
    writeFileSync(join(outside, "big.bin"), Buffer.alloc(10_000));
    mkdirSync(join(dir, "target", "classes"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "x".repeat(100));
    writeFileSync(join(dir, "target", "classes", "App.class"), Buffer.alloc(900));
    symlinkSync(outside, join(dir, "linked"), "junction");

    expect(await folderSize(dir)).toEqual({ bytes: 1000, complete: true });
  });

  test("stops at its limit of entries and says the count is a lower bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-size-"));
    for (let i = 0; i < 100; i++) writeFileSync(join(dir, `f${i}.txt`), "x");

    const size = await folderSize(dir, { maxEntries: 10 });

    expect(size.complete).toBe(false);
    expect(size.bytes).toBeLessThan(100);
  });

  test("stops when told to, as when the task is being ended, and says the count is a lower bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-size-"));
    writeFileSync(join(dir, "README.md"), "x".repeat(100));

    expect(await folderSize(dir, { stop: () => true })).toEqual({ bytes: 0, complete: false });
  });

  test("refuses a worktree that is a link instead of a folder, so the count never walks outside it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "trackwall-size-outside-"));
    const parent = mkdtempSync(join(tmpdir(), "trackwall-size-"));
    const worktree = join(parent, "worktree");
    symlinkSync(outside, worktree, "junction");

    await expect(folderSize(worktree)).rejects.toThrow(`${worktree} is not a folder`);
  });
});
