import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EndedTask } from "@trackwall/protocol";
import { waitUntil } from "../src/platform/process-group.ts";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

// Two attempts at one task compared side by side (ADR-252): started together from the New session form, compared in the
// task's Compare tab, one kept and the other ended, which the task journal records.

const trackwall = useTrackwall();

describe("two attempts at one task compared side by side", () => {
  test("a task started with a second attempt compares both in its Compare tab, and keeping one ends the other", async () => {
    const { daemon } = trackwall();
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill("Sum the cart");
    await page.getByRole("button", { name: "Model for the agent: Copilot CLI default" }).click();
    await page.getByRole("textbox", { name: "Model for the agent" }).fill("gpt-5-mini");
    await page.getByRole("button", { name: "Second attempt" }).click();
    await page.getByRole("textbox", { name: "Model for the second attempt" }).fill("claude-opus-5.5");
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, "Argument: --model=gpt-5-mini");
    // The form asks for the second attempt only once the first task exists, so its worktree may still be in the making
    // when the first terminal shows (on a slow Windows runner it was).
    await waitUntil(() => daemon.facade.agents.sessions().tasks.length === 2, 15_000);

    const tasks = daemon.facade.agents.sessions().tasks;
    const first = tasks.find((t) => t.retryOf === null);
    const second = tasks.find((t) => t.retryOf !== null);
    if (!first || !second) throw new Error("the task did not start with its second attempt");
    expect(second).toMatchObject({ model: "claude-opus-5.5", retryOf: first.id, base: first.base, prompt: "Sum the cart" });
    // Each agent's work as it leaves it in its worktree: the same file, solved differently.
    for (const [task, body] of [
      [first, "export const sum = (xs: number[]) => xs.reduce((a, b) => a + b);\n"],
      [second, "export function sum(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n"],
    ] as const) {
      mkdirSync(join(task.worktree, "src"), { recursive: true });
      writeFileSync(join(task.worktree, "src", "cart.ts"), body);
    }

    await page.getByRole("tab", { name: "Compare" }).click();
    const mine = page.getByRole("region", { name: "This task: gpt-5-mini" });
    const other = page.getByRole("region", { name: "Other attempt: claude-opus-5.5" });
    await mine.getByText("1 file · +1 −0").waitFor();
    await other.getByText("1 file · +3 −0").waitFor();
    await page.getByRole("button", { name: "src/cart.ts" }).click();
    const diffs = page.getByRole("region", { name: "Both diffs of src/cart.ts" });
    await diffs.getByText("+export const sum").waitFor();
    await diffs.getByText("+export function sum").waitFor();

    // Keeping the other attempt ends this one: its session stops first, then its worktree goes.
    await other.getByRole("button", { name: "Keep this one" }).click();
    const ending = page.getByRole("alertdialog", { name: "End the other attempt" });
    await ending.getByRole("button", { name: "Stop" }).click();
    await ending.getByRole("button", { name: "Remove branch and worktree" }).click();
    await ending.getByRole("button", { name: "Remove anyway" }).click();

    // The panel goes on with the kept attempt, and the journal says which one the user kept.
    await waitForTerminal(page, "Argument: --model=claude-opus-5.5");
    expect(daemon.facade.agents.sessions().tasks.map((t) => t.id)).toEqual([second.id]);
    const journal = join(daemon.home, "task-journal.jsonl");
    expect(await waitUntil(() => existsSync(journal) && readFileSync(journal, "utf8").includes(first.id), 5000)).toBe(true);
    const record = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => EndedTask.parse(JSON.parse(line)))
      .find((r) => r.task === first.id);
    expect(record).toMatchObject({ keptInstead: second.id, model: "gpt-5-mini" });
  }, 90_000);
});
