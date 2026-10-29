import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../src/infra/errors.ts";
import { Logs } from "../src/modules/logs/logs.ts";
import { Mise, parseTaskList } from "../src/modules/mise/mise.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";
import { isAlive, waitUntil } from "../src/platform/process-group.ts";
import { commitFiles, gitIn } from "./support/git-repo.ts";
import { removeFolder } from "./support/remove-folder.ts";

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
  writeFileSync(join(home, "fake-mise.json"), JSON.stringify({ tasks: [] }));
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
    // The projects folder holds the repo and the worktree; its own mise config has no tasks (ADR-93).
    projectsDir: async () => home,
  };
  /** The repo leaves the projects folder (renamed, deleted, another folder chosen in settings). */
  const removeRepo = () => {
    present = false;
  };
  const mise = new Mise({
    procs,
    repos,
    tasks,
    vcs: new Vcs(systemTempFolder),
    command,
    env: async () => process.env,
    onTrusted: () => {},
  });
  return { mise, home, repoDir, worktree, procs, logs, removeRepo, refuseWorktree };
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
        { name: "dev", description: "development server", source: null, origin: null, run: null },
        { name: "build:ui", description: "", source: null, origin: null, run: null },
      ],
    });
  });

  test("each mise task says whether a file git tracks, a file git does not track or a config outside the repo defines it", async () => {
    const { mise, home, repoDir } = setup({ tasks: [] });
    gitIn(repoDir, "init", "-q", "-b", "main");
    commitFiles(repoDir, { "mise.toml": '[tasks.build]\nrun = "make"\n' }, "add mise.toml");
    writeFileSync(join(repoDir, "mise.local.toml"), '[tasks.dev]\nrun = "make dev"\n');
    mkdirSync(join(repoDir, "mise-tasks"));
    writeFileSync(join(repoDir, "mise-tasks", "lint"), "#!/bin/sh\n");
    writeFileSync(join(home, "global.toml"), '[tasks.notes]\nrun = "true"\n');
    // mise reports each source as a full path, as in the format test below.
    writeConfig(repoDir, {
      tasks: [
        { name: "build", source: join(repoDir, "mise.toml") },
        { name: "dev", source: join(repoDir, "mise.local.toml") },
        { name: "lint", source: join(repoDir, "mise-tasks", "lint") },
        { name: "notes", source: join(home, "global.toml") },
      ],
    });

    const listed = await mise.tasks("web");

    expect(listed.kind === "ok" && listed.tasks.map((t) => [t.name, t.origin, t.source])).toEqual([
      ["build", "repo", "mise.toml"],
      ["dev", "local", "mise.local.toml"],
      ["lint", "local", "mise-tasks/lint"],
      ["notes", "outside", join(home, "global.toml")],
    ]);
  });

  test("a mise.toml kept out of git defines local mise tasks; without git, or for a file that is gone, the origin is unknown", async () => {
    const { mise, home, repoDir } = setup({ tasks: [] });
    writeFileSync(join(repoDir, "mise.toml"), '[tasks.build]\nrun = "make"\n');
    writeFileSync(join(home, "global.toml"), '[tasks.notes]\nrun = "true"\n');
    writeConfig(repoDir, {
      tasks: [
        { name: "build", source: join(repoDir, "mise.toml") },
        { name: "notes", source: join(home, "global.toml") },
        { name: "gone", source: join(repoDir, "removed.toml") },
      ],
    });
    const origins = async () => {
      const listed = await mise.tasks("web");
      return listed.kind === "ok" ? listed.tasks.map((t) => [t.name, t.origin]) : [];
    };

    expect(await origins()).toEqual([
      ["build", null],
      ["notes", "outside"],
      ["gone", null],
    ]);
    gitIn(repoDir, "init", "-q", "-b", "main");
    expect(await origins()).toEqual([
      ["build", "local"],
      ["notes", "outside"],
      ["gone", null],
    ]);
  });

  test("an untrusted config gives the state untrusted, and trust clears it", async () => {
    const { mise, repoDir } = setup({ tasks: [DEV], untrusted: true });

    const before = await mise.tasks("web");
    expect(before.kind).toBe("untrusted");
    expect(before.kind !== "ok" && before.message).toContain("are not trusted");
    expect(before.kind !== "ok" && before.message).not.toContain("WARN");

    expect(await mise.trust("web")).toEqual({ kind: "ok", tasks: [{ ...DEV, source: null, origin: null, run: null }] });
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

describe("the environment mise sets (ADR-93)", () => {
  test(
    "a mise task's log masks the secrets mise adds from its [env], also one whose name does not say it is a secret",
    async () => {
      const { mise, logs } = setup({
        tasks: [{ name: "deploy" }],
        exits: { deploy: 0 },
        prints: { deploy: ["calling with jira-key-from-age and glpat-1234567890", "MAVEN_OPTS is -Xmx2g-plenty"] },
        env: { JIRA_KEY: "jira-key-from-age", GITLAB_TOKEN: "glpat-1234567890", MAVEN_OPTS: "-Xmx2g-plenty" },
        redacted: ["JIRA_KEY"],
      });

      await mise.start({ repo: "web", task: null }, "deploy");
      const ended = await mise.waitForEnd({ repo: "web", task: null }, "deploy", 20_000, new AbortController().signal);

      const log = logs.tail({ source: { kind: "mise-task", repo: "web", miseTask: "deploy" }, limit: 10 });
      expect(log.records.map((r) => r.msg)).toEqual(["calling with *** and ***", "MAVEN_OPTS is -Xmx2g-plenty", "[deploy] $ done"]);
      expect(ended.kind === "exited" && ended.lastLines).toEqual([
        "calling with *** and ***",
        "MAVEN_OPTS is -Xmx2g-plenty",
        "[deploy] $ done",
      ]);
    },
    TIMEOUT,
  );

  test(
    "a mise task's log still masks the secret-like names from mise's [env] when mise cannot say what it redacts",
    async () => {
      const { mise, logs } = setup({
        tasks: [{ name: "deploy" }],
        exits: { deploy: 0 },
        prints: { deploy: ["calling with glpat-1234567890"] },
        env: { GITLAB_TOKEN: "glpat-1234567890" },
        redactedError: "unexpected argument '--redacted' found",
      });

      await mise.start({ repo: "web", task: null }, "deploy");
      await mise.waitForEnd({ repo: "web", task: null }, "deploy", 20_000, new AbortController().signal);

      const log = logs.tail({ source: { kind: "mise-task", repo: "web", miseTask: "deploy" }, limit: 10 });
      expect(log.records.map((r) => r.msg)).toEqual(["calling with ***", "[deploy] $ done"]);
    },
    TIMEOUT,
  );

  test("a session in a repo root gets the repo's variables, with the redacted ones and those named like secrets as its secrets", async () => {
    const { mise } = setup({ tasks: [], env: { JIRA_KEY: "k", GITLAB_TOKEN: "t", MAVEN_OPTS: "-Xmx2g" }, redacted: ["JIRA_KEY"] });

    expect(await mise.sessionEnv({ repo: "web", task: null })).toEqual({
      vars: { JIRA_KEY: "k", GITLAB_TOKEN: "t", MAVEN_OPTS: "-Xmx2g" },
      secretNames: ["JIRA_KEY", "GITLAB_TOKEN"],
      secretValues: ["k", "t"],
      problem: null,
    });
  });

  test("a session in the projects folder gets its variables, and a missing age key there is the session's problem", async () => {
    const { mise, home } = setup({ tasks: [] });
    writeFileSync(join(home, "fake-mise.json"), JSON.stringify({ tasks: [], env: { GITLAB_TOKEN: "t" } }));
    expect(await mise.sessionEnv({ repo: null, task: null })).toEqual({
      vars: { GITLAB_TOKEN: "t" },
      secretNames: ["GITLAB_TOKEN"],
      secretValues: ["t"],
      problem: null,
    });

    writeFileSync(
      join(home, "fake-mise.json"),
      JSON.stringify({ tasks: [], envError: "[experimental] No age identities found for decryption" }),
    );
    expect(await mise.sessionEnv({ repo: null, task: null })).toEqual({
      vars: {},
      secretNames: [],
      secretValues: [],
      problem:
        "the projects folder: mise ERROR [experimental] No age identities found for decryption\nThe session has no environment from mise.",
    });
  });

  test("a task's session gets its worktree's variables while its mise config is trusted, and the repo root's after a change", async () => {
    const { mise, worktree, refuseWorktree } = setup({ tasks: [], env: { GITLAB_TOKEN: "root" } });
    writeFileSync(join(worktree, "fake-mise.json"), JSON.stringify({ tasks: [], untrusted: true, env: { GITLAB_TOKEN: "worktree" } }));

    expect(await mise.sessionEnv({ repo: "web", task: TASK })).toMatchObject({ vars: { GITLAB_TOKEN: "worktree" }, problem: null });

    refuseWorktree(new DomainError("mise_unavailable", "the mise config in the worktree of task t changed (mise.toml)"));
    expect(await mise.sessionEnv({ repo: "web", task: TASK })).toEqual({
      vars: { GITLAB_TOKEN: "root" },
      secretNames: ["GITLAB_TOKEN"],
      secretValues: ["root"],
      problem:
        "the task's worktree: the mise config in the worktree of task t changed (mise.toml)\nThe session has the environment of the root of web.",
    });
  });

  test("when mise cannot say which variables it redacts, the session does not take the environment from that place", async () => {
    const { mise, home } = setup({ tasks: [], env: { JIRA_KEY: "decrypted" }, redactedError: "unexpected argument '--redacted' found" });
    writeFileSync(join(home, "fake-mise.json"), JSON.stringify({ tasks: [], env: { SHOP_REGION: "eu" } }));

    expect(await mise.sessionEnv({ repo: "web", task: null })).toEqual({
      vars: { SHOP_REGION: "eu" },
      secretNames: [],
      secretValues: [],
      problem:
        "the root of web: mise ERROR unexpected argument '--redacted' found\nThe session has the environment of the projects folder.",
    });
  });

  test("a task's session never trusts its worktree's mise config while the repo root's is not trusted", async () => {
    const { mise, home } = setup({ tasks: [], untrusted: true, env: { GITLAB_TOKEN: "root" } });
    writeFileSync(join(home, "fake-mise.json"), JSON.stringify({ tasks: [], env: { SHOP_REGION: "eu" } }));

    const env = await mise.sessionEnv({ repo: "web", task: TASK });
    expect(env.vars).toEqual({ SHOP_REGION: "eu" });
    expect(env.problem).toStartWith("the root of web: mise ERROR Config files in");
    expect(env.problem).toEndWith("The session has the environment of the projects folder.");
  });

  test("a repo folder that is gone is the session's problem, not a missing mise", async () => {
    const { mise, home } = setup({ tasks: [] });
    writeFileSync(join(home, "fake-mise.json"), JSON.stringify({ tasks: [], env: { SHOP_REGION: "eu" } }));
    removeFolder(join(home, "web"));

    const env = await mise.sessionEnv({ repo: "web", task: null });
    expect(env.vars).toEqual({ SHOP_REGION: "eu" });
    expect(env.problem).toBe(
      `the root of web: ${join(home, "web")} does not exist\nThe session has the environment of the projects folder.`,
    );
  });

  test("without a mise program a session gets nothing and no problem", async () => {
    const { mise } = setup({ tasks: [] }, ["trackwall-no-such-mise"]);

    expect(await mise.sessionEnv({ repo: "web", task: null })).toEqual({ vars: {}, secretNames: [], secretValues: [], problem: null });
    expect(await mise.sessionEnv({ repo: null, task: null })).toEqual({ vars: {}, secretNames: [], secretValues: [], problem: null });
  });
});

describe("mise tasks ls --json", () => {
  test("the format from a real mise (2026.10) gives the name, description and source file, and skips the other fields", () => {
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
      tasks: [{ name: "dev", description: "Daemon and Vite", source: "/repo/mise.toml" }],
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
      tasks: [{ name: "lint", description: "", source: null }],
    });
  });
});
