import { describe, expect, test } from "bun:test";
import type { AutoReview, Session, Task } from "@trackwall/protocol";
import { fileDiffs } from "../src/lib/diff-lines";
import {
  attemptModel,
  changeTotals,
  comparedAttempt,
  comparedFiles,
  fileChangeLabel,
  reviewLabel,
  secondAttemptModel,
  startTwoAttempts,
} from "../src/lib/task-comparison";

function task(id: string, createdAt: string, more: Partial<Task> = {}): Task {
  return {
    id,
    repo: "shop",
    prompt: "Fix the cart sum",
    branch: `trackwall/fix-the-cart-sum-${id}`,
    baseBranch: "main",
    base: "a".repeat(40),
    worktree: `/home/me/.trackwall/worktrees/shop/fix-the-cart-sum-${id}`,
    createdAt,
    title: null,
    proposedBy: null,
    model: null,
    approvals: "ask",
    plan: null,
    javaNavigation: false,
    sandbox: false,
    item: null,
    view: "terminal",
    summary: null,
    inReview: false,
    port: 41000,
    included: { files: [], problems: [] },
    change: null,
    retryOf: null,
    ...more,
  };
}

function session(model: string | null, modelInUse: string | null): Session {
  return {
    id: "s1",
    repo: "shop",
    supervisor: false,
    startedAt: "2026-11-13T10:00:00Z",
    run: { kind: "running", runId: "s1", startedAt: "2026-11-13T10:00:00Z", pid: 1 },
    state: null,
    windowTitle: null,
    needsAttention: false,
    waitingSince: null,
    stuck: null,
    task: "first",
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
    readRequest: null,
    copyRequest: null,
    usage: null,
    model,
    modelInUse,
    modelError: null,
    tokenBudget: null,
  };
}

function review(state: AutoReview["state"], severities: AutoReview["findings"][number]["severity"][] = []): AutoReview {
  return {
    task: "first",
    repo: "shop",
    kind: "code",
    state,
    trigger: "user",
    startedAt: "2026-11-13T10:00:00Z",
    finishedAt: state === "running" ? null : "2026-11-13T10:01:00Z",
    diffHash: "b".repeat(64),
    diffTruncated: false,
    findings: severities.map((severity, i) => ({
      title: `finding ${i}`,
      severity,
      path: "src/Cart.java",
      line: 10,
      text: "The sum skips the last item; start the loop at 0.",
    })),
    text: "",
    message: null,
    ruleFiles: [],
  };
}

describe("two attempts at one task side by side", () => {
  const first = task("first", "2026-11-13T10:00:00Z", { model: "gpt-5-mini" });
  const retry = task("retry", "2026-11-13T10:05:00Z", { model: "claude-opus-5.5", retryOf: "first" });
  const again = task("again", "2026-11-13T10:09:00Z", { model: "gpt-5-mini", retryOf: "first" });
  const unrelated = task("other", "2026-11-13T10:10:00Z");

  test("the tab compares a task with the newest other attempt at it, or with the one the user picked", () => {
    const tasks = [first, retry, again, unrelated];

    expect(comparedAttempt(first, tasks, null)?.id).toBe("again");
    expect(comparedAttempt(first, tasks, "retry")?.id).toBe("retry");
    expect(comparedAttempt(retry, tasks, null)?.id).toBe("again");
    // A picked attempt the user has ended since falls back to the newest one left.
    expect(comparedAttempt(first, [first, retry], "again")?.id).toBe("retry");
    expect(comparedAttempt(unrelated, tasks, null)).toBeUndefined();
  });

  test("an attempt names the model it asked for, and the one Copilot CLI runs it on when that differs", () => {
    expect(attemptModel(retry, session("claude-opus-5.5", "claude-opus-5.5"))).toEqual({ asked: "claude-opus-5.5", runsOn: null });
    expect(attemptModel(retry, session("claude-opus-5.5", "gpt-5-mini"))).toEqual({ asked: "claude-opus-5.5", runsOn: "gpt-5-mini" });
    expect(attemptModel(unrelated, undefined)).toEqual({ asked: "Copilot CLI default", runsOn: null });
  });

  test("the file list has every file either attempt changed once, with what each side did to it", () => {
    const left = [
      { path: "src/Cart.java", change: "modified" as const, additions: 3, deletions: 1 },
      { path: "src/CartTest.java", change: "added" as const, additions: 20, deletions: 0 },
    ];
    const right = [
      { path: "src/Cart.java", change: "modified" as const, additions: 5, deletions: 2 },
      { path: "logo.png", change: "added" as const, additions: null, deletions: null },
    ];

    const files = comparedFiles(left, right);

    expect(files.map((f) => [f.path, fileChangeLabel(f.left), fileChangeLabel(f.right)])).toEqual([
      ["logo.png", "–", "binary"],
      ["src/Cart.java", "+3 −1", "+5 −2"],
      ["src/CartTest.java", "added +20 −0", "–"],
    ]);
    expect(changeTotals(left)).toBe("2 files · +23 −1");
    expect(changeTotals([])).toBe("no changes");
  });

  test("the review of an attempt is said in a few words, its worst findings first", () => {
    expect(reviewLabel(null)).toBe("not run");
    expect(reviewLabel(review("running"))).toBe("running");
    expect(reviewLabel(review("done"))).toBe("no findings");
    expect(reviewLabel(review("done", ["low", "high", "high"]))).toBe("3 findings · 2 high");
    expect(reviewLabel(review("done", [null]))).toBe("1 finding");
    expect(reviewLabel(review("failed"))).toBe("failed");
  });

  test("a task's diff splits into the part of each file, by the path its header names", () => {
    const patch = [
      "diff --git a/src/Cart.java b/src/Cart.java",
      "--- a/src/Cart.java",
      "+++ b/src/Cart.java",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "Binary files /dev/null and b/logo.png differ",
      "",
    ].join("\n");

    const parts = fileDiffs(patch);

    expect([...parts.keys()]).toEqual(["src/Cart.java", "old.txt", "logo.png"]);
    expect(parts.get("src/Cart.java")).toBe(
      "diff --git a/src/Cart.java b/src/Cart.java\n--- a/src/Cart.java\n+++ b/src/Cart.java\n@@ -1 +1 @@\n-a\n+b\n",
    );
    expect(parts.get("logo.png")).toEndWith("Binary files /dev/null and b/logo.png differ\n");
  });

  test("a second attempt with an empty model field runs on the task's own model, and text that is no model id holds the start", () => {
    expect(secondAttemptModel("", "gpt-5-mini")).toBe("gpt-5-mini");
    expect(secondAttemptModel("  ", null)).toBeNull();
    expect(secondAttemptModel("claude-opus-5.5", "gpt-5-mini")).toBe("claude-opus-5.5");
    expect(secondAttemptModel("not a model", "gpt-5-mini")).toBeUndefined();
  });

  test("a new task starts first and its second attempt right after it, from the task the start returned", async () => {
    const calls: string[] = [];
    const result = await startTwoAttempts(
      async () => {
        calls.push("create");
        return first;
      },
      async (t) => {
        calls.push(`retry ${t.id}`);
        return retry;
      },
    );

    expect(calls).toEqual(["create", "retry first"]);
    expect(result).toEqual({ task: first, secondProblem: null });
  });

  test("a second attempt that does not start leaves the task running and says why", async () => {
    const result = await startTwoAttempts(
      async () => first,
      async () => {
        throw new Error("retry-task: a part of a change cannot be retried on its own");
      },
    );

    expect(result).toEqual({
      task: first,
      secondProblem: "The task started, but its second attempt did not: retry-task: a part of a change cannot be retried on its own",
    });
  });
});
