import { describe, expect, test } from "bun:test";
import type { Repo, RepoStatus, RepoStatusOk, ServerCheckState, UnpushedWork } from "@trackwall/protocol";
import {
  allReposRows,
  allReposSummary,
  fetchedLine,
  foldedLine,
  needsLook,
  newOnServerSince,
  serverCheckLine,
  splitRows,
} from "../src/lib/all-repos.ts";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const FOUR_MIN_AGO = "2026-11-22T11:56:00.000Z";
const TWO_DAYS_AGO = "2026-11-20T11:00:00.000Z";

function ok(more: Partial<RepoStatusOk>): RepoStatusOk {
  return { kind: "ok", branch: "main", head: null, changes: 0, untracked: 0, upstream: null, fetchedAt: FOUR_MIN_AGO, ...more };
}

function repo(id: string, status: RepoStatus): Repo {
  return { id, path: `/projects/${id}`, remote: `gitlab.example.com/shop/${id}`, status };
}

const tracking = (behind: number, ahead = 0) => ({ name: "origin/main", ahead, behind });

/** The server check's round that ended four minutes ago, having found `newCommits` then (ADR-295). */
function checked(newCommits: string[], unreached: string[] = []): ServerCheckState {
  return {
    on: true,
    last: { endedAt: FOUR_MIN_AGO, newCommits: newCommits.map((repo) => ({ repo, checkedAt: FOUR_MIN_AGO })), unreached },
  };
}

const PULL_TITLE = "Fetch, then fast-forward main to origin/main; the default branch is synced as in Sync all";
/** No repo whose server has commits it has not fetched, as before the server check's first round. */
const NOTHING_NEW: ReadonlyMap<string, string> = new Map();

describe("the rows of All repos", () => {
  test("a clean repo with nothing to pull folds into the line under the table; commits to pull, uncommitted files, a diverged branch or a repo git cannot read stand in it", () => {
    const rows = allReposRows(
      [
        repo("auth", ok({ upstream: tracking(0) })),
        repo("catalog", ok({ upstream: tracking(15) })),
        repo("orders-api", ok({ changes: 3, untracked: 1, upstream: tracking(0) })),
        repo("pricing", ok({ upstream: tracking(3, 2) })),
        repo("billing", { kind: "unavailable", message: "not a git repository" }),
        repo("search", ok({ upstream: null })),
      ],
      undefined,
      NOTHING_NEW,
      NOW,
    );
    expect(rows.filter(needsLook).map((r) => r.repo)).toEqual(["catalog", "orders-api", "pricing", "billing"]);
    const { shown, folded } = splitRows(rows, new Set());
    expect(shown.map((r) => r.repo)).toEqual(["catalog", "orders-api", "pricing", "billing"]);
    expect(foldedLine(folded, shown.length)).toBe("2 more repos: clean, nothing to pull");
  });

  test("each row says what its branch lacks from the server and what is uncommitted, in the words of the repo list", () => {
    const rows = allReposRows(
      [
        repo("catalog", ok({ upstream: tracking(15) })),
        repo("orders-api", ok({ changes: 3, untracked: 1, upstream: tracking(0) })),
        repo("pricing", ok({ branch: null, upstream: tracking(3, 2) })),
      ],
      undefined,
      NOTHING_NEW,
      NOW,
    );
    expect(rows.map((r) => (r.kind === "ok" ? [r.repo, r.branch, r.changes, r.server] : r.repo))).toEqual([
      ["catalog", "main", null, "15 to pull"],
      ["orders-api", "main", "2 changed, 1 new", null],
      ["pricing", "detached HEAD", null, "diverged"],
    ]);
  });

  test("each row offers the step that already exists: the pull, the Changes tab for changed files in its way, the Shell for a diverged branch, and the repo itself when git cannot read it", () => {
    const rows = allReposRows(
      [
        repo("catalog", ok({ upstream: tracking(15) })),
        repo("shop-web", ok({ changes: 2, untracked: 2, upstream: tracking(4) })),
        repo("orders-api", ok({ changes: 1, upstream: tracking(4) })),
        repo("pricing", ok({ upstream: tracking(3, 2) })),
        repo("notes", ok({ changes: 1, upstream: tracking(0) })),
        repo("auth", ok({ upstream: tracking(0) })),
        repo("billing", { kind: "unavailable", message: "not a git repository" }),
        repo("search", { kind: "loading" }),
      ],
      undefined,
      NOTHING_NEW,
      NOW,
    );
    expect(rows.map((r) => [r.repo, r.action])).toEqual([
      [
        "catalog",
        { kind: "pull", behind: 15, title: "Fetch, then fast-forward main to origin/main; the default branch is synced as in Sync all" },
      ],
      // New files do not stop a fast-forward, as in the Upstream tile.
      [
        "shop-web",
        { kind: "pull", behind: 4, title: "Fetch, then fast-forward main to origin/main; the default branch is synced as in Sync all" },
      ],
      ["orders-api", { kind: "open", tab: "changes" }],
      ["pricing", { kind: "open", tab: "shell" }],
      ["notes", { kind: "open", tab: "changes" }],
      ["auth", null],
      ["billing", { kind: "open", tab: null }],
      // Nothing to offer before git has read it.
      ["search", null],
    ]);
  });

  test("the server cell's tooltip says what the branch is compared with and as of which fetch, also for a clone that never fetched", () => {
    const rows = allReposRows(
      [
        repo("catalog", ok({ upstream: tracking(15) })),
        repo("pricing", ok({ upstream: tracking(3, 2), fetchedAt: TWO_DAYS_AGO })),
        repo("auth", ok({ upstream: tracking(0), fetchedAt: null })),
        repo("search", ok({ upstream: null })),
        repo("spike", ok({ branch: null, upstream: null })),
      ],
      undefined,
      NOTHING_NEW,
      NOW,
    );
    expect(rows.map((r) => (r.kind === "ok" ? r.serverTitle : undefined))).toEqual([
      "Compared with origin/main, fetched 4 min ago",
      "Compared with origin/main (2 local, 3 remote), fetched 2 days ago",
      "Compared with origin/main, not fetched since it was cloned",
      "main tracks no remote branch",
      "A detached HEAD tracks no branch",
    ]);
  });

  test("in a container, work on no remote stands in the table: commits and stashes lead to the Shell, other work to the repo, and a repo git cannot read says so", () => {
    const unpushed: UnpushedWork = {
      inContainer: true,
      repos: [
        { repo: "shipping", commits: 1, branches: ["main"], noRemote: false, stashes: 0, changes: 0, changedWorktrees: 0 },
        { repo: "pricing", commits: 0, branches: [], noRemote: false, stashes: 0, changes: 2, changedWorktrees: 1 },
      ],
      unreadable: [{ repo: "legacy", message: "fatal: bad object HEAD" }],
    };
    const rows = allReposRows(
      [repo("shipping", ok({ upstream: tracking(0) })), repo("pricing", ok({ upstream: tracking(0) })), repo("legacy", ok({}))],
      unpushed,
      NOTHING_NEW,
      NOW,
    );
    expect(rows.map((r) => [r.repo, r.onlyHere?.label, r.onlyHere?.detail, r.action])).toEqual([
      ["shipping", "1 commit", "Branches: main", { kind: "open", tab: "shell" }],
      ["pricing", "2 changed files", undefined, { kind: "open", tab: null }],
      ["legacy", "git cannot read it", "fatal: bad object HEAD", { kind: "open", tab: null }],
    ]);
    expect(rows.every(needsLook)).toBe(true);
  });

  test("a row that needed a look earlier in this visit stays after it turns clean, so a pull shows as the row turning clean", () => {
    const before = allReposRows([repo("catalog", ok({ upstream: tracking(15) })), repo("auth", ok({}))], undefined, NOTHING_NEW, NOW);
    const kept = new Set(before.filter(needsLook).map((r) => r.repo));
    const after = allReposRows([repo("catalog", ok({ upstream: tracking(0) })), repo("auth", ok({}))], undefined, NOTHING_NEW, NOW);
    const { shown, folded } = splitRows(after, kept);
    expect(shown.map((r) => [r.repo, r.kind === "ok" && r.server])).toEqual([["catalog", null]]);
    expect(foldedLine(folded, shown.length)).toBe("1 more repo: clean, nothing to pull");
  });
});

describe("new commits the server check found without a fetch (ADR-295)", () => {
  test("a repo whose server has commits it has not fetched reads “new on the server” and offers the pull, until it fetches", () => {
    const repos = [
      repo("catalog", ok({ upstream: tracking(0), fetchedAt: TWO_DAYS_AGO })),
      repo("search", ok({ upstream: tracking(0), fetchedAt: null })),
      // The last fetch already counts commits to pull: the number stays, and the pull brings the newer ones too.
      repo("payments", ok({ upstream: tracking(2), fetchedAt: TWO_DAYS_AGO })),
      // A changed file in its way, as for commits to pull.
      repo("orders-api", ok({ changes: 1, upstream: tracking(0), fetchedAt: TWO_DAYS_AGO })),
      // Fetched two minutes after the check asked: the fetch brought what the server had then.
      repo("auth", ok({ upstream: tracking(0), fetchedAt: "2026-11-22T11:58:00.000Z" })),
    ];
    const newOnServer = newOnServerSince(repos, checked(["catalog", "search", "payments", "orders-api", "auth"]));
    expect([...newOnServer.keys()]).toEqual(["catalog", "search", "payments", "orders-api"]);
    const rows = allReposRows(repos, undefined, newOnServer, NOW);
    expect(rows.map((r) => [r.repo, r.kind === "ok" && r.server, r.action])).toEqual([
      ["catalog", "new on the server", { kind: "pull", behind: null, title: PULL_TITLE }],
      ["search", "new on the server", { kind: "pull", behind: null, title: PULL_TITLE }],
      ["payments", "2 to pull", { kind: "pull", behind: 2, title: PULL_TITLE }],
      ["orders-api", "new on the server", { kind: "open", tab: "changes" }],
      ["auth", null, null],
    ]);
    expect(rows.map((r) => r.kind === "ok" && r.serverTitle)[0]).toBe(
      "Compared with origin/main, fetched 2 days ago; the server had newer commits 4 min ago",
    );
    expect(allReposSummary(rows).label).toBe("4 to pull · 1 changed");
  });

  test("without a round of the check, or with it off, no repo is new on the server, nor one git has not read yet", () => {
    const repos = [repo("catalog", ok({ upstream: tracking(0), fetchedAt: TWO_DAYS_AGO })), repo("search", { kind: "loading" })];
    for (const serverCheck of [undefined, { on: false, last: null }, { on: true, last: null }])
      expect(newOnServerSince(repos, serverCheck).size).toBe(0);
    expect([...newOnServerSince(repos, checked(["search"])).keys()]).toEqual([]);
  });

  test("the header says when the servers were asked, or calmly which did not answer and when, and nothing while the check has no round", () => {
    expect(serverCheckLine(checked([]), NOW)).toEqual({ text: "Checked the servers for new commits 4 min ago." });
    expect(serverCheckLine(checked([], ["shop"]), NOW)?.text).toMatch(/^Could not reach the server of shop at \d\d:\d\d\.$/);
    expect(serverCheckLine(checked([], ["shop", "billing"]), NOW)).toEqual({
      text: expect.stringMatching(/^Could not reach the server of 2 repos at \d\d:\d\d\.$/),
      title: "shop, billing\nSettings > Diagnostics says why git could not reach them.",
    });
    expect([
      serverCheckLine(undefined, NOW),
      serverCheckLine({ on: false, last: null }, NOW),
      serverCheckLine({ on: true, last: null }, NOW),
    ]).toEqual([null, null, null]);
  });
});

describe("the line under the table", () => {
  test("it counts the repos folded into it, says whether git still reads some, and is not there when none is folded", () => {
    const rows = allReposRows(
      [repo("auth", ok({})), repo("search", { kind: "loading" }), repo("billing", { kind: "loading" })],
      undefined,
      NOTHING_NEW,
      NOW,
    );
    expect(foldedLine(rows, 0)).toBe("3 repos: clean, nothing to pull (2 still loading)");
    expect(foldedLine(rows.slice(1), 0)).toBe("2 repos: git is still reading them");
    expect(foldedLine(rows.slice(0, 1), 4)).toBe("1 more repo: clean, nothing to pull");
    expect(foldedLine([], 4)).toBeNull();
  });
});

describe("the entry of All repos in the repo list", () => {
  test("it counts the repos by what they need, in one line with each count in the tooltip", () => {
    const rows = allReposRows(
      [
        repo("catalog", ok({ upstream: tracking(15) })),
        repo("payments", ok({ upstream: tracking(2) })),
        repo("orders-api", ok({ changes: 2, upstream: tracking(1) })),
        repo("shipping", ok({})),
        repo("billing", { kind: "unavailable", message: "not a git repository" }),
        repo("auth", ok({})),
      ],
      {
        inContainer: true,
        repos: [{ repo: "shipping", commits: 1, branches: ["main"], noRemote: false, stashes: 0, changes: 0, changedWorktrees: 0 }],
        unreadable: [],
      },
      NOTHING_NEW,
      NOW,
    );
    expect(allReposSummary(rows)).toEqual({
      tone: "warning",
      label: "3 to pull · 1 changed · 1 only here · 1 unavailable",
      title:
        "Repos with commits to pull: 3\nRepos with uncommitted files: 1\nRepos with work only in this container: 1\nRepos git cannot read: 1",
    });
  });

  test("clean repos read “all clean”, and while git reads them the entry claims nothing", () => {
    const clean = allReposRows([repo("auth", ok({}))], undefined, NOTHING_NEW, NOW);
    const loading = allReposRows([repo("auth", ok({})), repo("search", { kind: "loading" })], undefined, NOTHING_NEW, NOW);
    expect([allReposSummary(clean), allReposSummary(loading)]).toEqual([{ tone: "ok", label: "all clean" }, { label: "loading" }]);
  });
});

describe("when the repos last fetched", () => {
  test("the header gives one time, or the oldest and the newest fetch, since the commits to pull are counted as of each", () => {
    const one = allReposRows([repo("catalog", ok({})), repo("auth", ok({ fetchedAt: null }))], undefined, NOTHING_NEW, NOW);
    const two = allReposRows([repo("catalog", ok({})), repo("pricing", ok({ fetchedAt: TWO_DAYS_AGO }))], undefined, NOTHING_NEW, NOW);
    expect(fetchedLine(one, NOW)).toBe("Fetched from the server 4 min ago.");
    expect(fetchedLine(two, NOW)).toBe("Fetched from the server between 2 days ago and 4 min ago.");
  });

  test("nothing is said while no repo has fetched or git still reads them", () => {
    const rows = allReposRows([repo("auth", ok({ fetchedAt: null })), repo("search", { kind: "loading" })], undefined, NOTHING_NEW, NOW);
    expect(fetchedLine(rows, NOW)).toBeNull();
  });
});
