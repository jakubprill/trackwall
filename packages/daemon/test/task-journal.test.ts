import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EndedTask, TaskHistoryQuery } from "@trackwall/protocol";
import { TaskJournal } from "../src/modules/task-journal/task-journal.ts";

function journalFile(): string {
  return join(mkdtempSync(join(tmpdir(), "trackwall-journal-")), "task-journal.jsonl");
}

/** An ended task of `repo`; the fields a test does not name are those of a task the user typed and ended without commits. */
function ended(n: number, repo: string, prompt: string, endedAt: string, more: Partial<EndedTask> = {}): EndedTask {
  return {
    task: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    repo,
    title: null,
    prompt,
    branch: `trackwall/task-${n}`,
    baseBranch: "main",
    base: "a".repeat(40),
    head: null,
    branchKept: false,
    createdAt: endedAt,
    endedAt,
    proposed: false,
    item: null,
    handoffFrom: null,
    retryOf: null,
    keptInstead: null,
    summary: null,
    commits: [],
    commitsTotal: null,
    files: [],
    filesTruncated: false,
    verification: null,
    model: null,
    usage: null,
    models: [],
    ...more,
  };
}

const ALL: TaskHistoryQuery = { text: "", repos: [], limit: 10 };

describe("task journal", async () => {
  test("before the first ended task the journal is empty", async () => {
    const journal = new TaskJournal({ file: journalFile(), log: () => {}, maxRecords: 100, masker: async () => (t) => t });

    expect(journal.search(ALL)).toEqual({ tasks: [], truncated: false });
  });

  test("words match in any case across prompt, summary, commit subjects and files, and must all appear", async () => {
    const journal = new TaskJournal({ file: journalFile(), log: () => {}, maxRecords: 100, masker: async () => (t) => t });
    await journal.record(ended(1, "payments", "Retry the charge", "2026-10-01T10:00:00Z", { summary: "Uses the BFF client" }));
    await journal.record(
      ended(2, "web", "Show the price", "2026-10-02T10:00:00Z", {
        commits: [{ hash: "b".repeat(40), subject: "Format the amount" }],
        files: ["src/PriceLabel.tsx"],
      }),
    );
    const prompts = (text: string) => journal.search({ ...ALL, text }).tasks.map((t) => t.prompt);

    expect(prompts("bff retry")).toEqual(["Retry the charge"]);
    expect(prompts("AMOUNT pricelabel")).toEqual(["Show the price"]);
    expect(prompts("retry price")).toEqual([]);
    expect(prompts("")).toEqual(["Show the price", "Retry the charge"]);
  });

  test("repos, since and limit narrow the result, and a cut result says so", async () => {
    const journal = new TaskJournal({ file: journalFile(), log: () => {}, maxRecords: 100, masker: async () => (t) => t });
    await journal.record(ended(1, "payments", "first", "2026-10-01T10:00:00Z"));
    await journal.record(ended(2, "web", "second", "2026-10-15T10:00:00Z"));
    await journal.record(ended(3, "payments", "third", "2026-10-20T10:00:00Z"));
    const prompts = (query: Partial<TaskHistoryQuery>) => journal.search({ ...ALL, ...query }).tasks.map((t) => t.prompt);

    expect(prompts({ repos: ["payments"] })).toEqual(["third", "first"]);
    expect(prompts({ since: "2026-10-15" })).toEqual(["third", "second"]);
    expect(journal.search({ ...ALL, limit: 1 })).toMatchObject({ tasks: [{ prompt: "third" }], truncated: true });
  });

  test("a line that does not parse is skipped, not fatal", async () => {
    const file = journalFile();
    const journal = new TaskJournal({ file, log: () => {}, maxRecords: 100, masker: async () => (t) => t });
    await journal.record(ended(1, "web", "kept", "2026-10-01T10:00:00Z"));
    appendFileSync(file, '{"task": "cut in the mid\n');

    await journal.record(ended(2, "web", "after the bad line", "2026-10-02T10:00:00Z"));

    expect(journal.search(ALL).tasks.map((t) => t.prompt)).toEqual(["after the bad line", "kept"]);
  });

  test("a record written before the journal kept the model and the usage reads with neither (ADR-228)", async () => {
    const file = journalFile();
    const journal = new TaskJournal({ file, log: () => {}, maxRecords: 100, masker: async () => (t) => t });
    const { model, usage, models, ...older } = ended(1, "web", "written by an older version", "2026-10-01T10:00:00Z");
    appendFileSync(file, `${JSON.stringify(older)}\n`);

    expect(journal.search(ALL).tasks).toMatchObject([{ prompt: "written by an older version", model: null, usage: null, models: [] }]);
  });

  test("past its size and a tenth more the journal drops the oldest records", async () => {
    const file = journalFile();
    const journal = new TaskJournal({ file, log: () => {}, maxRecords: 10, masker: async () => (t) => t });
    for (let n = 1; n <= 11; n++) await journal.record(ended(n, "web", `task ${n}`, `2026-10-${String(n).padStart(2, "0")}T10:00:00Z`));
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(11);

    await journal.record(ended(12, "web", "task 12", "2026-10-12T10:00:00Z"));

    const prompts = journal.search({ ...ALL, limit: 50 }).tasks.map((t) => t.prompt);
    expect(prompts).toHaveLength(10);
    expect(prompts[0]).toBe("task 12");
    expect(prompts.at(-1)).toBe("task 3");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(10);
  });

  test("secrets in the prompt, the summary and commit subjects are masked before they are written", async () => {
    const file = journalFile();
    const journal = new TaskJournal({ file, log: () => {}, maxRecords: 100, masker: async () => (t) => t.replaceAll("s3cret", "***") });

    await journal.record(
      ended(1, "web", "use token s3cret", "2026-10-01T10:00:00Z", {
        summary: "set s3cret in the env",
        commits: [{ hash: "b".repeat(40), subject: "Add s3cret" }],
      }),
    );

    expect(readFileSync(file, "utf8")).not.toContain("s3cret");
    expect(journal.search(ALL).tasks[0]).toMatchObject({ prompt: "use token ***", summary: "set *** in the env" });
  });

  test("a journal that cannot be written logs the failure instead of failing the end of the task", async () => {
    const logged: string[] = [];
    const journal = new TaskJournal({
      file: join(journalFile(), "not-a-dir", "x.jsonl"),
      log: (m) => logged.push(m),
      maxRecords: 100,
      masker: async () => (t) => t,
    });

    await journal.record(ended(1, "web", "lost", "2026-10-01T10:00:00Z"));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("writing ended task 00000000-0000-4000-8000-000000000001 to the task journal");
  });
});
