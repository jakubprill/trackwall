import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "l".repeat(43);
const daemons: Awaited<ReturnType<typeof startSessionApi>>[] = [];

// A limit instead of the default none: a hung cleanup on Windows is to be an error of this file, not an hour of the job.
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
}, 30_000);

async function startDaemon(restartOf?: { home: string; projects: string }) {
  const daemon = await startSessionApi(TOKEN, { repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"], restartOf });
  daemons.push(daemon);
  return daemon;
}

async function stopDaemon(daemon: Awaited<ReturnType<typeof startSessionApi>>) {
  daemons.splice(daemons.indexOf(daemon), 1);
  await daemon.stop();
}

/** A log file of a task's worktree, as its mise task would leave it. */
function taskLog(home: string, task: string): string {
  const dir = join(home, "logs", "task-mise-task", task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "test.jsonl"), "{}\n");
  return dir;
}

describe.skipIf(process.versions.bun === undefined)("task logs across a daemon restart (real PTY and git, fake Copilot CLI)", () => {
  test("the next daemon removes the logs of tasks it does not know and keeps those of its tasks", async () => {
    const before = await startDaemon();
    const task = await before.facade.agents.createTask("shop", "check the logs");
    await stopDaemon(before);
    const kept = taskLog(before.home, task.id);
    const left = taskLog(before.home, "ended-task");

    await startDaemon({ home: before.home, projects: before.projects });

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(left)).toBe(false);
  });

  test("with an unreadable task list the next daemon keeps every task's logs, since the list may come back", async () => {
    const before = await startDaemon();
    await stopDaemon(before);
    writeFileSync(join(before.home, "tasks.json"), "not json");
    const left = taskLog(before.home, "maybe-a-task");

    await startDaemon({ home: before.home, projects: before.projects });

    expect(existsSync(left)).toBe(true);
  });
});
