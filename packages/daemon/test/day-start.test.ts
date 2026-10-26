import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DayStartRun, mcpTools, type Session, type Task } from "@trackwall/protocol";
import { DomainError } from "../src/infra/errors.ts";
import { dayReport } from "../src/modules/day-start/day-report.ts";
import { DayStart } from "../src/modules/day-start/day-start.ts";
import { DayStartFile } from "../src/modules/day-start/day-start-file.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** Every test runs dozens of git processes, and on Windows in CI one takes up to 100 ms. */
const GIT_HEAVY_MS = 30_000;

const head = (dir: string, ref = "HEAD") => gitIn(dir, "rev-parse", ref).trim();

/**
 * A projects folder with real git repos cloned from local "remote" repos, the real workspace and git, and a fake of the
 * sessions: `tasks` and `sessions` are what `agents` lists, `supervisorRuns` makes it refuse a new supervisor, and
 * `supervisorFails` makes the supervisor's start fail. `home` passed in is the state directory of a restarted daemon.
 */
function setup(
  o: {
    tasks?: Task[];
    sessions?: Session[];
    supervisorRuns?: boolean;
    supervisorFails?: string;
    home?: string;
    workspaceYaml?: string;
  } = {},
) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), "trackwall-day-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const remotes = mkdtempSync(join(tmpdir(), "trackwall-remotes-"));
  const yaml = join(home, "workspace.yaml");
  writeFileSync(yaml, `projectsDir: ${JSON.stringify(projects)}\n${o.workspaceYaml ?? ""}`);
  const workspace = new Workspace({
    file: new WorkspaceFile(yaml),
    vcs: new Vcs(),
    hosting: fakeHosting().hosting,
    openEditor: () => {},
    openFolder: () => {},
  });
  const firstMessages: string[] = [];
  const logged: string[] = [];
  const dayStart = new DayStart({
    workspace,
    vcs: new Vcs(),
    file: new DayStartFile(join(home, "day-start.json"), (msg) => logged.push(msg)),
    log: (msg) => logged.push(msg),
    agents: {
      sessions: () => ({ sessions: o.sessions ?? [], tasks: o.tasks ?? [], proposals: [], messages: [] }),
      assertNoSupervisor: () => {
        if (o.supervisorRuns) throw new DomainError("bad_request", "the supervisor is running; stop it to start your day with a new one");
      },
      startSupervisorWith: async (firstMessage) => {
        if (o.supervisorFails !== undefined) throw new DomainError("agent_unavailable", o.supervisorFails);
        firstMessages.push(firstMessage);
        return session({ repo: null });
      },
    },
  });
  /** A remote repo `name` with one commit and its clone in the projects folder. */
  const cloned = (name: string) => {
    const upstream = makeRepo({ "README.md": `# ${name}\n` }, name, remotes);
    gitIn(projects, "clone", "-q", upstream, name);
    return { upstream, clone: join(projects, name) };
  };
  return { dayStart, workspace, home, projects, firstMessages, logged, cloned };
}

async function finished(dayStart: DayStart): Promise<DayStartRun> {
  for (let i = 0; i < 800; i++) {
    const run = dayStart.run();
    if (run?.finishedAt) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the day start did not finish within the test");
}

/** A day start run to its end, which must have started the supervisor. */
async function startDay(dayStart: DayStart): Promise<DayStartRun> {
  await dayStart.start();
  const run = await finished(dayStart);
  expect(run.error).toBeNull();
  return run;
}

const exitedRun: Session["run"] = {
  kind: "exited",
  runId: "r2",
  startedAt: "2026-10-25T07:00:00.000Z",
  endedAt: "2026-10-25T08:00:00.000Z",
  exitCode: 0,
  signal: null,
  stoppedByUser: true,
  lastLines: [],
};

const SESSION_ID = "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c001";
const TASK_ID = "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c002";

function session(fields: Partial<Session>): Session {
  return {
    id: SESSION_ID,
    repo: "api",
    startedAt: "2026-10-26T07:00:00.000Z",
    run: { kind: "running", runId: "r1", startedAt: "2026-10-26T07:00:00.000Z", pid: 4242 },
    state: null,
    windowTitle: null,
    needsAttention: false,
    task: null,
    dialog: null,
    ...fields,
  };
}

function task(fields: Partial<Task> & Pick<Task, "base">): Task {
  return {
    id: TASK_ID,
    repo: "api",
    prompt: "Add a login test\nwith a second line",
    branch: "trackwall/add-a-login-test-0c002a",
    baseBranch: "main",
    worktree: "/state/worktrees/api/add-a-login-test-0c002a",
    createdAt: "2026-10-25T09:00:00.000Z",
    title: null,
    proposedBy: null,
    summary: null,
    port: 41000,
    included: { files: [], problems: [] },
    ...fields,
  };
}

describe("the day start", () => {
  test(
    "the first day start compares with nothing: up-to-date repos are only counted, and the supervisor's first message asks for the day report",
    async () => {
      const { dayStart, cloned, firstMessages } = setup();
      cloned("api");
      cloned("web");

      const run = await startDay(dayStart);

      expect(run).toMatchObject({ step: "supervisor", error: null, supervisor: SESSION_ID });
      expect(dayStart.report()).toEqual({ startedAt: run.startedAt, since: null, repos: [], quietRepos: 2, tasks: [] });
      expect(firstMessages).toHaveLength(1);
      expect(firstMessages[0]).toStartWith(`Start my day. Trackwall has just synced every repo; call ${mcpTools.getDayReport.name}`);
      expect(firstMessages[0]).toContain("Propose at most 3 tasks");
    },
    GIT_HEAVY_MS,
  );

  test(
    "the next day start lists the commits that came onto a repo's remote default branch since the last one, the newest five, with the total",
    async () => {
      const { dayStart, cloned } = setup();
      const api = cloned("api");
      cloned("web");
      const first = await startDay(dayStart);
      for (let i = 1; i <= 7; i++) commitFiles(api.upstream, { [`change-${i}.txt`]: `${i}` }, `change ${i}`);

      const second = await startDay(dayStart);

      const report = dayStart.report();
      expect(report).toMatchObject({ startedAt: second.startedAt, since: first.startedAt, quietRepos: 1, tasks: [] });
      expect(report?.repos).toEqual([
        {
          repo: "api",
          // A local path as the remote has no remote address (`Repo.remote`).
          remote: null,
          remoteBranch: "origin/main",
          commits: {
            kind: "new",
            total: 7,
            commits: [7, 6, 5, 4, 3].map((i) => ({
              hash: head(api.upstream, `HEAD~${7 - i}`),
              subject: `change ${i}`,
              author: "Test Author",
              date: expect.any(String),
            })),
          },
          sync: {
            state: "updated",
            branch: "main",
            remoteBranch: "origin/main",
            commits: 7,
            workingTree: { branch: "main", changed: 0, untracked: 0 },
          },
        },
      ]);
    },
    GIT_HEAVY_MS,
  );

  test(
    "a force-pushed default branch is rewritten, a repo the sync skipped is listed with its reason, and a new clone is first-seen",
    async () => {
      const { dayStart, cloned } = setup();
      const forced = cloned("forced");
      const dirty = cloned("dirty");
      await startDay(dayStart);
      gitIn(forced.upstream, "commit", "-q", "--amend", "-m", "first commit, reworded");
      commitFiles(dirty.upstream, { "remote.txt": "1" }, "remote change");
      writeFileSync(join(dirty.clone, "README.md"), "# edited locally\n");
      cloned("fresh");

      await startDay(dayStart);

      const repos = dayStart.report()?.repos ?? [];
      expect(repos.map((r) => [r.repo, r.commits?.kind, r.sync?.state])).toEqual([
        ["dirty", "new", "skipped"],
        ["forced", "rewritten", "skipped"],
        ["fresh", "first-seen", "up-to-date"],
      ]);
      expect(repos[0]?.sync).toMatchObject({ reason: "dirty", message: "main is checked out and has uncommitted changes" });
      expect(repos[1]?.commits).toEqual({
        kind: "rewritten",
        commits: [{ hash: head(forced.upstream), subject: "first commit, reworded", author: "Test Author", date: expect.any(String) }],
      });
    },
    GIT_HEAVY_MS,
  );

  test(
    "a repo without a remote is quiet, though the sync skips it every day",
    async () => {
      const { dayStart, projects } = setup();
      makeRepo({ "a.txt": "a" }, "local", projects);
      await startDay(dayStart);
      await startDay(dayStart);

      expect(dayStart.report()).toMatchObject({ repos: [], quietRepos: 1 });
    },
    GIT_HEAVY_MS,
  );

  test(
    "an open task is listed with how many commits its repo's default branch has that its base does not, and its session's state",
    async () => {
      const remotes = mkdtempSync(join(tmpdir(), "trackwall-remotes-"));
      const upstream = makeRepo({ "README.md": "# api\n" }, "api", remotes);
      const base = head(upstream);
      commitFiles(upstream, { "a.txt": "1" }, "one");
      commitFiles(upstream, { "b.txt": "2" }, "two");
      const working = session({
        task: TASK_ID,
        needsAttention: true,
        state: { state: "Input", source: "hook", confidence: "high", at: "2026-10-26T07:01:00.000Z", reason: "hook agentStop" },
      });
      const ended = session({ id: "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c003", task: "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c004" });
      const tasks = [
        task({ base, summary: { text: "Added the test", reportedAt: "2026-10-25T18:00:00.000Z" } }),
        task({ id: "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c004", base: head(upstream), title: "Fix the cart" }),
      ];
      const { dayStart, projects } = setup({ tasks, sessions: [working, { ...ended, run: exitedRun }] });
      gitIn(projects, "clone", "-q", upstream, "api");

      await startDay(dayStart);

      expect(dayStart.report()?.tasks).toEqual([
        {
          task: TASK_ID,
          repo: "api",
          title: "Add a login test",
          branch: "trackwall/add-a-login-test-0c002a",
          sessionState: "Input",
          needsAttention: true,
          summaryAt: "2026-10-25T18:00:00.000Z",
          behind: 2,
        },
        {
          task: "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c004",
          repo: "api",
          title: "Fix the cart",
          branch: "trackwall/add-a-login-test-0c002a",
          sessionState: null,
          needsAttention: false,
          summaryAt: null,
          behind: 0,
        },
      ]);
    },
    GIT_HEAVY_MS,
  );

  test("a running supervisor refuses the day start before anything syncs", async () => {
    const { dayStart, workspace, cloned } = setup({ supervisorRuns: true });
    cloned("api");

    await expect(dayStart.start()).rejects.toThrow("the supervisor is running; stop it to start your day with a new one");
    expect(workspace.syncRun()).toBeNull();
    expect(dayStart.run()).toBeNull();
  });

  test(
    "a second start while one runs returns the running one",
    async () => {
      const { dayStart, cloned, firstMessages } = setup();
      cloned("api");

      const [first, second] = await Promise.all([dayStart.start(), dayStart.start()]);
      expect(second.startedAt).toBe(first.startedAt);
      await finished(dayStart);
      expect(firstMessages).toHaveLength(1);
    },
    GIT_HEAVY_MS,
  );

  test(
    "the user's dayStart prompt from workspace.yaml follows Trackwall's part of the first message, and an invalid one refuses the start",
    async () => {
      const good = setup({ workspaceYaml: "dayStart:\n  prompt: Check my open issues in the tracker.\n" });
      good.cloned("api");
      await startDay(good.dayStart);
      expect(good.firstMessages[0]).toEndWith("each, so I can ask for the ones I want.\n\nCheck my open issues in the tracker.");

      const bad = setup({ workspaceYaml: "dayStart:\n  prompt: ''\n" });
      await expect(bad.dayStart.start()).rejects.toThrow(/dayStart/);
    },
    GIT_HEAVY_MS,
  );

  test(
    "a supervisor that fails to start ends the day start with its error, and the report is saved anyway",
    async () => {
      const { dayStart, cloned } = setup({ supervisorFails: "no Copilot CLI in PATH" });
      cloned("api");

      await dayStart.start();
      const run = await finished(dayStart);

      expect(run).toMatchObject({ step: "supervisor", error: "no Copilot CLI in PATH", supervisor: null });
      expect(dayStart.report()).toMatchObject({ quietRepos: 1 });
    },
    GIT_HEAVY_MS,
  );

  test(
    "the report and what it compared survive a restart, and an unreadable file counts as no day start",
    async () => {
      const before = setup();
      before.cloned("api");
      const first = await startDay(before.dayStart);

      const after = setup({ home: before.home });
      expect(after.dayStart.run()).toBeNull();
      expect(after.dayStart.report()?.startedAt).toBe(first.startedAt);

      writeFileSync(join(before.home, "day-start.json"), "{ not json");
      expect(after.dayStart.report()).toBeNull();
      expect(after.logged).toEqual([`${join(before.home, "day-start.json")}: not JSON; the next day start compares with nothing`]);
    },
    GIT_HEAVY_MS,
  );
});

describe("the day report", () => {
  test("a repo whose branch cannot be read this time keeps the commit from before, so what lands meanwhile is not lost", async () => {
    const api = { id: "api", path: "/projects/api" };
    const vcs = {
      remote: async () => null,
      remoteDefaultBranch: async () => {
        throw new Error("git config: bad config line 3");
      },
      isAncestor: async () => true,
      countBetween: async () => 0,
      commitsBetween: async () => ({ total: 0, commits: [] }),
      newestCommits: async () => [],
    };
    const old = "a".repeat(40);
    const logged: string[] = [];
    const sync = { startedAt: "2026-10-26T07:00:00.000Z", finishedAt: "2026-10-26T07:00:05.000Z", repos: [] };
    const previous = { startedAt: "2026-10-25T07:00:00.000Z", heads: { "/projects/api": old, "/projects/gone": "b".repeat(40) } };

    const { report, heads } = await dayReport(
      vcs,
      { startedAt: sync.startedAt, previous, repos: [api], sync, tasks: [], sessions: [] },
      (msg) => logged.push(msg),
    );

    expect(heads).toEqual({ "/projects/api": old });
    expect(report.repos).toEqual([]);
    expect(logged).toEqual(["day report: api: Error: git config: bad config line 3"]);
  });

  test("a repo whose new commits cannot be read keeps the commit from before, and a directory named like an Object property has no saved commit", async () => {
    const tip = "c".repeat(40);
    const repos = [
      { id: "api", path: "/projects/api" },
      { id: "constructor", path: "constructor" },
    ];
    const vcs = {
      remote: async () => null,
      remoteDefaultBranch: async () => ({ name: "origin/main", commit: tip }),
      isAncestor: async () => true,
      countBetween: async () => 0,
      commitsBetween: async () => {
        throw new Error("git rev-list: timed out after 15000 ms");
      },
      newestCommits: async () => [],
    };
    const old = "a".repeat(40);
    const sync = { startedAt: "2026-10-26T07:00:00.000Z", finishedAt: "2026-10-26T07:00:05.000Z", repos: [] };
    const previous = { startedAt: "2026-10-25T07:00:00.000Z", heads: { "/projects/api": old } };

    const { report, heads } = await dayReport(vcs, { startedAt: sync.startedAt, previous, repos, sync, tasks: [], sessions: [] }, () => {});

    expect(heads).toEqual({ "/projects/api": old, constructor: tip });
    expect(report.repos.map((r) => [r.repo, r.commits?.kind])).toEqual([["constructor", "first-seen"]]);
  });
});
