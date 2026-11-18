import { describe, expect, test } from "bun:test";
import type { PullResult, RepoStatusOk, RunningMiseTask, Session, SessionList } from "@trackwall/protocol";
import { folderWorkWarning, pullLabel, pullResultLine, upstreamOffer, workInRepoFolder } from "../src/lib/upstream-pull.ts";

const AT = "2026-11-18T10:00:00.000Z";

function status(more: Partial<RepoStatusOk>): RepoStatusOk {
  return { kind: "ok", branch: "develop", head: null, changes: 0, untracked: 0, upstream: null, ...more };
}

describe("what the Upstream tile offers", () => {
  test("a clean branch behind its upstream gets a pull named with the number of commits", () => {
    const offer = upstreamOffer(status({ upstream: { name: "origin/develop", ahead: 0, behind: 320 } }));
    expect(offer).toEqual({ kind: "pull", behind: 320 });
    expect(pullLabel(320)).toBe("Pull 320");
  });

  test("new untracked files do not stop a pull, because a fast-forward leaves them where they are", () => {
    const offer = upstreamOffer(status({ changes: 2, untracked: 2, upstream: { name: "origin/develop", ahead: 0, behind: 3 } }));
    expect(offer).toEqual({ kind: "pull", behind: 3 });
  });

  test("changed tracked files stop the pull and lead to putting them aside or to the Changes tab", () => {
    const offer = upstreamOffer(status({ changes: 4, upstream: { name: "origin/develop", ahead: 0, behind: 320 } }));
    expect(offer).toEqual({
      kind: "blocked",
      message: "4 changed files on develop are in the way.",
      way: "changes",
    });
  });

  test("a branch with commits on both sides is to merge by hand in the Shell tab", () => {
    const offer = upstreamOffer(status({ changes: 1, upstream: { name: "origin/develop", ahead: 2, behind: 320 } }));
    expect(offer).toEqual({
      kind: "blocked",
      message: "develop and origin/develop have diverged (2 local, 320 remote). Merge or rebase by hand.",
      way: "shell",
    });
  });

  test("nothing to pull, no upstream or a detached HEAD offer nothing", () => {
    expect(upstreamOffer(status({ upstream: { name: "origin/develop", ahead: 2, behind: 0 } }))).toEqual({ kind: "none" });
    expect(upstreamOffer(status({ upstream: null }))).toEqual({ kind: "none" });
    expect(upstreamOffer(status({ branch: null, upstream: { name: "origin/develop", ahead: 0, behind: 5 } }))).toEqual({ kind: "none" });
  });
});

describe("the line after a pull", () => {
  const main = { state: "updated", branch: "main", remoteBranch: "origin/main", commits: 12 } as const;

  test("the checked-out branch comes first, then what the default branch gained", () => {
    const result: PullResult = {
      defaultBranch: main,
      checkedOut: { state: "updated", branch: "develop", remoteBranch: "origin/develop", commits: 334 },
      workingTree: null,
      putAside: null,
    };
    expect(pullResultLine(result)).toEqual({ tone: "ok", label: "Pulled 334 commits into develop · main +12" });
  });

  test("with the default branch checked out its outcome is the only part", () => {
    const result: PullResult = { defaultBranch: { ...main, commits: 1 }, checkedOut: null, workingTree: null, putAside: null };
    expect(pullResultLine(result)).toEqual({ tone: "ok", label: "Pulled 1 commit into main" });
  });

  test("a skip found after the fetch is a warning with the daemon's reason", () => {
    const result: PullResult = {
      defaultBranch: { state: "up-to-date", branch: "main", remoteBranch: "origin/main" },
      checkedOut: {
        state: "skipped",
        reason: "diverged",
        message: "develop has diverged from the remote (1 local, 4 remote); merge by hand",
      },
      workingTree: null,
      putAside: null,
    };
    expect(pullResultLine(result)).toEqual({
      tone: "warning",
      label: "Develop has diverged from the remote (1 local, 4 remote); merge by hand",
    });
  });

  test("a default branch that could not move is named, so the pull does not look complete", () => {
    const result: PullResult = {
      defaultBranch: { state: "skipped", reason: "ahead", message: "main has 1 unpushed commit" },
      checkedOut: { state: "up-to-date", branch: "develop", remoteBranch: "origin/develop" },
      workingTree: null,
      putAside: null,
    };
    expect(pullResultLine(result)).toEqual({
      tone: "warning",
      label: "develop is up to date with origin/develop · default branch not synced: main has 1 unpushed commit",
    });
  });
});

describe("what works in the repo folder itself", () => {
  function session(id: string, repo: string, more: Partial<Session> = {}): Session {
    return {
      id,
      repo,
      supervisor: false,
      startedAt: AT,
      run: { kind: "running", runId: id, startedAt: AT, pid: 1 },
      state: { state: "Working", source: "hook", confidence: "exact", at: AT, reason: "hook" },
      windowTitle: "Fix refund rounding",
      needsAttention: false,
      waitingSince: null,
      stuck: null,
      task: null,
      dialog: null,
      environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
      view: "terminal",
      readRequest: null,
      copyRequest: null,
      usage: null,
      model: null,
      modelInUse: null,
      modelError: null,
      tokenBudget: null,
      ...more,
    };
  }
  const running = (repo: string, task: string | null, miseTask: string): RunningMiseTask => ({
    repo,
    task,
    miseTask,
    run: { kind: "running", runId: miseTask, startedAt: AT, pid: 2 },
  });

  test("a running mise task and a session of the repo root count; a task's worktree, an ended session and another repo do not", () => {
    const list = {
      sessions: [
        session("s1", "orders"),
        session("s2", "orders", { task: "t1" }),
        session("s3", "orders", {
          run: { kind: "exited", runId: "s3", startedAt: AT, endedAt: AT, exitCode: 0, signal: null, stoppedByUser: false, lastLines: [] },
        }),
        session("s4", "billing"),
      ],
      tasks: [],
      proposals: [],
    } as unknown as SessionList;
    const work = workInRepoFolder("orders", list, [running("orders", null, "dev"), running("orders", "t1", "test")]);
    expect(work).toEqual(["the mise task dev", 'the session "orders · Fix refund rounding"']);
    expect(folderWorkWarning(work)).toBe(
      'The mise task dev and the session "orders · Fix refund rounding" work in this folder, and pulling changes files under them.',
    );
  });

  test("nothing works in the folder before the session list arrives and no mise task runs", () => {
    expect(workInRepoFolder("orders", undefined, [])).toEqual([]);
  });
});
