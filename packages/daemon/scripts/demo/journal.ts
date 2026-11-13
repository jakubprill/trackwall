// A month of ended tasks for the demo's "Models" in Settings › Usage (ADR-231): the task journal's records the shop's
// tasks would have left, on three models with outcomes and costs shaped like a real month: the large model passes
// verification most often and costs the most per task, the small one is cheap per task but fails more, and a few tasks
// asked for a model the account did not offer. The numbers are made up.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EndedTask } from "@trackwall/protocol";
import { TASK_JOURNAL_FILE } from "../../src/modules/task-journal/task-journal.ts";

interface DemoModel {
  model: string;
  tasks: number;
  /** Every how many tasks one passes, fails or is not verified, cycled through. */
  outcomes: readonly ("passed" | "failed" | null)[];
  creditsPerTask: number;
  callsPerTask: number;
  /** Every how many tasks one was started on another model, which the account did not offer; 0 for none. */
  askedForAnotherEvery: number;
}

const MODELS: readonly DemoModel[] = [
  {
    model: "claude-opus-5.5",
    tasks: 9,
    outcomes: ["passed", "passed", "passed", "passed", "failed", "passed", "passed", "passed", null],
    creditsPerTask: 58,
    callsPerTask: 31,
    askedForAnotherEvery: 0,
  },
  {
    model: "gpt-6",
    tasks: 12,
    outcomes: ["passed", "failed", "passed", "passed", null, "passed"],
    creditsPerTask: 24,
    callsPerTask: 26,
    askedForAnotherEvery: 4,
  },
  {
    model: "gpt-6-mini",
    tasks: 8,
    outcomes: ["passed", "failed", "failed", "passed", null],
    creditsPerTask: 6,
    callsPerTask: 34,
    askedForAnotherEvery: 0,
  },
  { model: "claude-haiku-5.5", tasks: 2, outcomes: ["passed", "failed"], creditsPerTask: 4, callsPerTask: 18, askedForAnotherEvery: 0 },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** A model the demo account does not offer, which Copilot CLI quietly replaced (ADR-225). */
const UNOFFERED_MODEL = "gpt-6-pro";

/** Writes the journal into the demo's state directory before the daemon reads it. */
export function writeDemoJournal(home: string, repos: readonly string[], now: Date): void {
  const records: EndedTask[] = [];
  let n = 0;
  for (const m of MODELS) {
    for (let i = 0; i < m.tasks; i++) {
      n++;
      const outcome = m.outcomes[i % m.outcomes.length] ?? null;
      const endedAt = new Date(now.getTime() - ((n * 7) % 28) * DAY_MS - n * 3_600_000).toISOString();
      const askedForAnother = m.askedForAnotherEvery > 0 && i % m.askedForAnotherEvery === 0;
      const credits = m.creditsPerTask * (0.7 + ((n * 13) % 7) / 10);
      records.push({
        task: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        repo: repos[n % repos.length] ?? "orders-api",
        title: null,
        prompt: `Demo task ${n}`,
        branch: `trackwall/demo-${n}`,
        baseBranch: "main",
        base: "0".repeat(40),
        head: null,
        branchKept: false,
        createdAt: new Date(Date.parse(endedAt) - 2 * 3_600_000).toISOString(),
        endedAt,
        proposed: false,
        item: null,
        handoffFrom: null,
        retryOf: null,
        keptInstead: null,
        summary: null,
        commits: [],
        commitsTotal: outcome === null ? 0 : 1 + (n % 3),
        files: [],
        filesTruncated: false,
        verification: outcome === null ? null : { state: outcome, finishedAt: endedAt },
        model: askedForAnother ? UNOFFERED_MODEL : m.model,
        usage: {
          modelCalls: m.callsPerTask,
          inputTokens: m.callsPerTask * 41_000,
          outputTokens: m.callsPerTask * 900,
          aiCredits: Math.round(credits * 100) / 100,
          aiCreditsPartial: false,
          premiumRequests: 0,
        },
        models: [{ model: m.model, modelCalls: m.callsPerTask }],
      });
    }
  }
  records.sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  writeFileSync(join(home, TASK_JOURNAL_FILE), records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}
