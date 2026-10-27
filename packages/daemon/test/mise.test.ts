import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../src/infra/errors.ts";
import { Logs } from "../src/modules/logs/logs.ts";
import { Mise, parseTaskList } from "../src/modules/mise/mise.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";
import { isAlive, waitUntil } from "../src/platform/process-group.ts";

const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const TIMEOUT = 30_000;

/** The one task of the repo `web` in these tests, with its worktree next to the repo. */
const TASK = "0b7c1a52-3f0e-4c1e-9a43-5d2f8e6b1c07";
const TASK_PORT = 41007;

/**
 * Repo `web` with a fake mise config (`fake-mise.json`, described in `fixtures/fake-mise.ts`), and the worktree of task
 * `TASK` with the same config, which mise does not trust by itself: only through the trusted path of a run (ADR-59).
 */
function setup(config: object, command: readonly string[] = FAKE_MISE) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-mise-"));
  const repoDir = join(home, "web");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "fake-mise.json"), JSON.stringify(config));
  const worktree = join(home, "worktrees", "web", "task");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "fake-mise.json"), JSON.stringify({ ...config, untrusted: true }));
  let refusal: DomainError | null = null;
  const tasks = {
    trustedTaskWorktree: async (id: string, repo: string) => {
      if (id !== TASK || repo !== "web") throw new DomainError("bad_request", `no task ${id} in ${repo}`);
      if (refusal) throw refusal;
      return { worktree, port: TASK_PORT };
    },
  };
  /** The `agents` module refuses the worktree, as it does when its mise config changed since the user trusted it. */
  const refuseWorktree = (error: DomainError) => {
    refusal = error;
  };
  const logs = new Logs({ dir: join(home, "logs"), maxFileBytes: 1024 * 1024, log: () => {} });
  const procs = new ProcessGroups({
    logs,
    runtime: new RuntimeFile(join(home, "runtime.json")),
    platform: groupPlatform().then((p) => ({ ...p, graceMs: 300 })),
    log: () => {},
  });
  let present = true;
  const repos = {
    repoPath: async (id: string) => {
      if (id !== "web" || !present) throw new DomainError("not_found", `no repo ${id}`);
      return repoDir;
    },
  };
  /** The repo leaves the projects folder (renamed, deleted, another folder chosen in settings). */
  const removeRepo = () => {
    present = false;
  };
  const mise = new Mise({ procs, repos, tasks, command, env: async () => process.env, onTrusted: () => {} });
  return { mise, repoDir, worktree, procs, logs, removeRepo, refuseWorktree };
}

function writeConfig(repoDir: string, config: object): void {
  writeFileSync(join(repoDir, "fake-mise.json"), JSON.stringify(config));
}

const DEV = { name: "dev", description: "development server" };

describe("mise", () => {
  test("the list of mise tasks comes from mise, without hidden ones, with a description and without a run", async () => {
    const { mise } = setup({ tasks: [DEV, { name: "build:ui", description: null }, { name: "_internal", description: "", hide: true }] });

    expect(await mise.tasks("web")).toEqual({
      kind: "ok",
      tasks: [
        { name: "dev", description: "development server", run: null },
        { name: "build:ui", description: "", run: null },
      ],
    });
  });

  test("an untrusted config gives the state untrusted, and trust clears it", async () => {
    const { mise, repoDir } = setup({ tasks: [DEV], untrusted: true });

    const before = await mise.tasks("web");
    expect(before.kind).toBe("untrusted");
    expect(before.kind !== "ok" && before.message).toContain("are not trusted");
    expect(before.kind !== "ok" && before.message).not.toContain("WARN");

    expect(await mise.trust("web")).toEqual({ kind: "ok", tasks: [{ ...DEV, run: null }] });
    expect(JSON.parse(readFileSync(join(repoDir, "fake-mise.json"), "utf8")).untrusted).toBe(false);
  });

  test("a missing mise program gives the state not_installed, and start ends with the error mise_unavailable", async () => {
    const { mise } = setup({ tasks: [DEV] }, ["trackwall-no-such-mise"]);

    expect(await mise.tasks("web")).toEqual({
      kind: "not_installed",
      message: "program trackwall-no-such-mise not found in PATH",
      running: [],
    });
    await expect(mise.start({ repo: "web", task: null }, "dev")).rejects.toMatchObject({ code: "mise_unavailable" });
  });

  test("starting a mise task that is not on the list is rejected without running anything", async () => {
    const { mise, repoDir } = setup({ tasks: [DEV] });

    await expect(mise.start({ repo: "web", task: null }, "deploy")).rejects.toMatchObject({ code: "not_found" });
    expect(existsSync(join(repoDir, "pids"))).toBe(false);
  });

  test(
    "start runs mise run in the repo root, the state goes onto the list, and stop halts the whole process group",
    async () => {
      const { mise, repoDir } = setup({ tasks: [DEV] });

      const started = await mise.start({ repo: "web", task: null }, "dev");
      const pidFiles = [join(repoDir, "pids", "0.pid"), join(repoDir, "pids", "1.pid")];
      expect(await waitUntil(() => pidFiles.every((f) => existsSync(f)), 15_000)).toBe(true);
      const pids = pidFiles.map((f) => Number(readFileSync(f, "utf8")));
      const listed = await mise.tasks("web");
      expect(listed.kind === "ok" && listed.tasks[0]?.run).toEqual(started);

      const stopped = await mise.stop({ repo: "web", task: null }, "dev");

      expect(stopped).toMatchObject({ kind: "exited", stoppedByUser: true, runId: started.runId });
      expect(stopped.kind === "exited" && stopped.lastLines[0]).toBe("[dev] $ process-tree");
      expect(pids.filter(isAlive)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a mise task removed from the config while running stays on the list, so that it can be stopped",
    async () => {
      const { mise, repoDir } = setup({ tasks: [DEV] });
      await mise.start({ repo: "web", task: null }, "dev");
      writeConfig(repoDir, { tasks: [] });

      const listed = await mise.tasks("web");
      expect(listed.kind === "ok" && listed.tasks.map((t) => [t.name, t.run?.kind])).toEqual([["dev", "running"]]);

      await mise.stop({ repo: "web", task: null }, "dev");
      expect(await mise.tasks("web")).toEqual({ kind: "ok", tasks: [] });
    },
    TIMEOUT,
  );

  test(
    "when mise stops giving the list (e.g. an untrusted config), a running mise task can still be stopped",
    async () => {
      const { mise, repoDir } = setup({ tasks: [DEV] });
      await mise.start({ repo: "web", task: null }, "dev");
      writeConfig(repoDir, { tasks: [DEV], untrusted: true });

      const listed = await mise.tasks("web");
      expect(listed.kind).toBe("untrusted");
      expect(listed.kind !== "ok" && listed.running.map((t) => [t.name, t.run?.kind])).toEqual([["dev", "running"]]);

      expect((await mise.stop({ repo: "web", task: null }, "dev")).kind).toBe("exited");
    },
    TIMEOUT,
  );

  test(
    "running mise tasks of all repos are on the list without asking mise, and a stopped one disappears from it",
    async () => {
      const { mise, repoDir } = setup({ tasks: [DEV] });
      expect(mise.running()).toEqual([]);
      const started = await mise.start({ repo: "web", task: null }, "dev");
      // A config mise does not read: the list of running ones is complete anyway, because it does not ask mise.
      writeConfig(repoDir, { tasks: [DEV], untrusted: true });

      expect(mise.running()).toEqual([{ repo: "web", task: null, miseTask: "dev", run: started }]);

      await mise.stop({ repo: "web", task: null }, "dev");
      expect(mise.running()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a cancelled wait for the end of a task returns at once with the running state and does not stop the task",
    async () => {
      const { mise } = setup({ tasks: [DEV] });
      const started = await mise.start({ repo: "web", task: null }, "dev");
      const interrupted = new AbortController();

      const waiting = mise.waitForEnd({ repo: "web", task: null }, "dev", 30_000, interrupted.signal);
      interrupted.abort();

      expect(await waiting).toEqual(started);
      expect(mise.running().map((t) => t.run.kind)).toEqual(["running"]);
      await mise.stop({ repo: "web", task: null }, "dev");
    },
    TIMEOUT,
  );

  test(
    "a running task of a repo that left the projects folder can still be waited for and stopped",
    async () => {
      const { mise, removeRepo } = setup({ tasks: [DEV] });
      const started = await mise.start({ repo: "web", task: null }, "dev");
      removeRepo();

      expect(await mise.waitForEnd({ repo: "web", task: null }, "dev", 1, new AbortController().signal)).toEqual(started);
      expect(await mise.stop({ repo: "web", task: null }, "dev")).toMatchObject({
        kind: "exited",
        runId: started.runId,
        stoppedByUser: true,
      });
    },
    TIMEOUT,
  );

  test("waiting for a task in a repo that does not exist is not_found", async () => {
    const { mise } = setup({ tasks: [DEV] });
    await expect(mise.waitForEnd({ repo: "api", task: null }, "dev", 1000, new AbortController().signal)).rejects.toMatchObject({
      code: "not_found",
      message: "no repo api",
    });
  });

  test("stopping a mise task that has not been run is not_found", async () => {
    const { mise } = setup({ tasks: [DEV] });
    await expect(mise.stop({ repo: "web", task: null }, "dev")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("mise tasks in a task worktree (ADR-59)", () => {
  test(
    "a task's mise task runs in its worktree, mise trusts the worktree for that run, and its log is a source of its own",
    async () => {
      const { mise, repoDir, worktree, logs } = setup({ tasks: [{ name: "test" }], exits: { test: 3 } });

      const started = await mise.start({ repo: "web", task: TASK }, "test");
      const ended = await mise.waitForEnd({ repo: "web", task: TASK }, "test", 20_000, new AbortController().signal);

      expect(ended).toMatchObject({ kind: "exited", runId: started.runId, exitCode: 3 });
      expect(readFileSync(join(worktree, "calls.log"), "utf8")).toBe("run test\n");
      expect(existsSync(join(repoDir, "calls.log"))).toBe(false);
      const log = logs.tail({ source: { kind: "task-mise-task", repo: "web", task: TASK, miseTask: "test" }, limit: 10 });
      expect(log.records.map((r) => r.msg)).toEqual(["[test] $ done"]);
      expect(logs.tail({ source: { kind: "mise-task", repo: "web", miseTask: "test" }, limit: 10 }).records).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "the same mise task in the repo root and in a task worktree are two runs, and the list of running tasks names the task",
    async () => {
      const { mise } = setup({ tasks: [DEV] });
      try {
        const inRoot = await mise.start({ repo: "web", task: null }, "dev");
        const inTask = await mise.start({ repo: "web", task: TASK }, "dev");

        expect(inTask.runId).not.toBe(inRoot.runId);
        expect(mise.running().map(({ repo, task, miseTask, run }) => ({ repo, task, miseTask, runId: run.runId }))).toEqual([
          { repo: "web", task: null, miseTask: "dev", runId: inRoot.runId },
          { repo: "web", task: TASK, miseTask: "dev", runId: inTask.runId },
        ]);
        // The root's list of mise tasks shows only the root's run.
        expect(await mise.tasks("web")).toMatchObject({ kind: "ok", tasks: [{ name: "dev", run: { runId: inRoot.runId } }] });
      } finally {
        await mise.stop({ repo: "web", task: TASK }, "dev");
        await mise.stop({ repo: "web", task: null }, "dev");
      }
    },
    TIMEOUT,
  );

  test("a worktree the agents module refuses (its mise config changed since the user trusted it) runs nothing", async () => {
    const { mise, worktree, refuseWorktree } = setup({ tasks: [{ name: "test" }], exits: { test: 0 } });
    refuseWorktree(new DomainError("mise_unavailable", "the mise config in the worktree of task trackwall/fix changed"));

    await expect(mise.start({ repo: "web", task: TASK }, "test")).rejects.toMatchObject({
      code: "mise_unavailable",
      message: "the mise config in the worktree of task trackwall/fix changed",
    });
    expect(existsSync(join(worktree, "calls.log"))).toBe(false);
  });

  test(
    "a task's run is found only through the repo of its task, so naming another repo neither stops nor waits for it",
    async () => {
      const { mise } = setup({ tasks: [DEV] });
      try {
        const started = await mise.start({ repo: "web", task: TASK }, "dev");

        await expect(mise.stop({ repo: "api", task: TASK }, "dev")).rejects.toMatchObject({ code: "not_found" });
        expect(mise.run({ repo: "web", task: TASK }, "dev")).toMatchObject({ kind: "running", runId: started.runId });
      } finally {
        await mise.stop({ repo: "web", task: TASK }, "dev");
      }
    },
    TIMEOUT,
  );

  test("a repo root whose mise config is not trusted runs nothing in its task worktrees either", async () => {
    const { mise, worktree } = setup({ tasks: [{ name: "test" }], exits: { test: 0 }, untrusted: true });

    await expect(mise.start({ repo: "web", task: TASK }, "test")).rejects.toMatchObject({ code: "mise_unavailable" });
    expect(existsSync(join(worktree, "calls.log"))).toBe(false);
  });

  test("a task named with an unknown repo is not_found, and so is stopping a task's mise task that has not run", async () => {
    const { mise } = setup({ tasks: [DEV] });

    await expect(mise.start({ repo: "api", task: TASK }, "dev")).rejects.toMatchObject({ code: "not_found", message: "no repo api" });
    await expect(mise.stop({ repo: "web", task: TASK }, "dev")).rejects.toMatchObject({
      code: "not_found",
      message: `mise task "dev" in the worktree of task ${TASK} in web has not been run`,
    });
  });
});

describe("mise tasks ls --json", () => {
  test("the format from a real mise (2026.10) gives the name and description, and skips the other fields", () => {
    const stdout = JSON.stringify([
      {
        name: "dev",
        aliases: [],
        description: "Daemon and Vite",
        source: "/repo/mise.toml",
        depends: ["setup"],
        hide: false,
        run: ["pnpm dev"],
      },
    ]);
    expect(parseTaskList({ kind: "exited", code: 0, stdout, stderr: "" })).toEqual({
      kind: "ok",
      tasks: [{ name: "dev", description: "Daemon and Vite" }],
    });
  });

  test("a mise error other than trust is the state error with the mise message", () => {
    const stderr = "mise ERROR error parsing config file: /repo/mise.toml\nmise ERROR expected `=`\n";
    expect(parseTaskList({ kind: "exited", code: 1, stdout: "", stderr })).toEqual({
      kind: "error",
      message: "mise ERROR error parsing config file: /repo/mise.toml\nmise ERROR expected `=`",
    });
  });

  test("output that is not a list of mise tasks is the state error, not an exception", () => {
    expect(parseTaskList({ kind: "exited", code: 0, stdout: "not json", stderr: "" }).kind).toBe("error");
    expect(parseTaskList({ kind: "exited", code: 0, stdout: '{"dev":1}', stderr: "" }).kind).toBe("error");
  });

  test("a name mise would use as an option does not get onto the list", () => {
    const stdout = JSON.stringify([{ name: "--help" }, { name: "lint" }]);
    expect(parseTaskList({ kind: "exited", code: 0, stdout, stderr: "" })).toEqual({
      kind: "ok",
      tasks: [{ name: "lint", description: "" }],
    });
  });
});
