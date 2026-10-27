import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logs } from "../src/modules/logs/logs.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";
import { type GroupControl, type GroupPlatform, isAlive, waitUntil } from "../src/platform/process-group.ts";
import { terminalPlatform } from "../src/platform/terminal.ts";
import { RUNTIMES } from "./support/runtimes.ts";

const TREE = join(import.meta.dir, "fixtures", "process-tree.ts");
const HOLDER = join(import.meta.dir, "fixtures", "procs-holder.ts");
const RUNNER = join(import.meta.dir, "fixtures", "procs-runner.ts");
/** The tree ignores a gentle stop, so a short grace period shortens the tests without changing what happens. */
const TEST_GRACE_MS = 300;
const TIMEOUT = 30_000;
const SOURCE = { kind: "mise-task", repo: "web", miseTask: "dev" } as const;

function testLogs(): Logs {
  return new Logs({ dir: mkdtempSync(join(tmpdir(), "trackwall-procs-logs-")), maxFileBytes: 1024 * 1024, log: () => {} });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
  const runtime = new RuntimeFile(join(dir, "runtime.json"));
  const logs: string[] = [];
  const groups = new ProcessGroups({
    logs: testLogs(),
    runtime,
    platform: groupPlatform().then((p) => ({ ...p, graceMs: TEST_GRACE_MS })),
    log: (msg) => logs.push(msg),
  });
  return { dir, runtime, groups, logs };
}

/**
 * A platform on which killing a group fails: the leader ends with an ordinary `kill`, but the group is never empty.
 * That is what a process the system cannot end looks like (e.g. one hung in a driver).
 */
async function stubbornPlatform(): Promise<GroupPlatform> {
  const real = await groupPlatform();
  const stubborn = (control: GroupControl): GroupControl => ({ ...control, isEmpty: () => false });
  return {
    ...real,
    graceMs: TEST_GRACE_MS,
    adopt: (child) => stubborn(real.adopt(child)),
    reattach: async () => stubborn({ askToStop() {}, kill() {}, isEmpty: () => false, release() {} }),
  };
}

function treePids(dir: string, depth: number): number[] {
  return Array.from({ length: depth }, (_, level) => join(dir, `${level}.pid`))
    .filter((f) => existsSync(f))
    .map((f) => Number(readFileSync(f, "utf8")));
}

async function waitForTree(dir: string, depth: number): Promise<number[]> {
  expect(await waitUntil(() => treePids(dir, depth).length === depth, 15_000)).toBe(true);
  return treePids(dir, depth);
}

describe("procs", () => {
  test(
    "a live group counts as working in its directory and every folder above it, not in a sibling with the same prefix",
    async () => {
      const { dir, groups } = setup();
      const repo = join(dir, "shop");
      const sub = join(repo, "service");
      mkdirSync(sub, { recursive: true });
      await groups.start({ owner: "o", command: [process.execPath, TREE, sub, "0", "1"], cwd: sub, env: process.env, logSource: SOURCE });
      await waitForTree(sub, 1);

      expect(groups.liveIn(repo)).toBe(true);
      expect(groups.liveIn(sub)).toBe(true);
      expect(groups.liveIn(join(dir, "shop-2"))).toBe(false);
      expect(groups.liveIn(join(sub, "src"))).toBe(false);

      await groups.stop("o");
      expect(groups.liveIn(repo)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "stop halts the whole group, including grandchildren that ignore a gentle stop, and removes it from runtime.json",
    async () => {
      const { dir, runtime, groups } = setup();
      const started = await groups.start({
        owner: "o",
        command: [process.execPath, TREE, dir, "0", "3"],
        cwd: dir,
        env: process.env,
        logSource: SOURCE,
      });
      const pids = await waitForTree(dir, 3);
      expect(started.kind).toBe("running");
      expect(runtime.read().map((g) => g.pid)).toEqual([pids[0] ?? -1]);

      const stopped = await groups.stop("o");

      expect(stopped).toMatchObject({ kind: "exited", stoppedByUser: true, runId: started.runId });
      expect(pids.filter(isAlive)).toEqual([]);
      expect(runtime.read()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "ended waits for the confirmed end of the group and returns its state, and for an owner without a group returns undefined",
    async () => {
      const { dir, groups } = setup();
      expect(await groups.ended("nobody")).toBeUndefined();
      await groups.start({
        owner: "o",
        command: [process.execPath, TREE, dir, "0", "2", "exit-leader", "4"],
        cwd: dir,
        env: process.env,
        logSource: SOURCE,
      });

      const ended = await groups.ended("o");

      expect(ended).toMatchObject({ kind: "exited", exitCode: 4, stoppedByUser: false });
      expect(treePids(dir, 2).filter(isAlive)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a leader that ends by itself takes the rest of the group, and the state has the exit code and last lines",
    async () => {
      const { dir, groups } = setup();
      await groups.start({
        owner: "o",
        command: [process.execPath, TREE, dir, "0", "3", "exit-leader", "3"],
        cwd: dir,
        env: process.env,
        logSource: SOURCE,
      });
      const pids = await waitForTree(dir, 3);

      expect(await waitUntil(() => groups.state("o")?.kind === "exited", 15_000)).toBe(true);

      expect(groups.state("o")).toMatchObject({
        kind: "exited",
        exitCode: 3,
        stoppedByUser: false,
        lastLines: ["level 0 running", "the leader ends by itself"],
      });
      expect(pids.filter(isAlive)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a second start of the same owner returns the current run instead of a new group",
    async () => {
      const { dir, groups } = setup();
      const spec = { owner: "o", command: [process.execPath, TREE, dir, "0", "1"], cwd: dir, env: process.env, logSource: SOURCE };
      const [first, second] = await Promise.all([groups.start(spec), groups.start(spec)]);
      const third = await groups.start(spec);

      expect(second.runId).toBe(first.runId);
      expect(third.runId).toBe(first.runId);
      await groups.stop("o");
    },
    TIMEOUT,
  );

  test(
    "a stop during the start waits for the group and stops it, and after stopAll a new start is rejected",
    async () => {
      const { dir, groups } = setup();
      const spec = { owner: "o", command: [process.execPath, TREE, dir, "0", "1"], cwd: dir, env: process.env, logSource: SOURCE };
      const started = groups.start(spec);

      const stopped = await groups.stop("o");
      await groups.stopAll();

      expect(stopped).toMatchObject({ kind: "exited", runId: (await started).runId });
      await expect(groups.start(spec)).rejects.toThrow("the daemon is stopping");
    },
    TIMEOUT,
  );

  test("a missing program ends the start with an error naming the program", async () => {
    const { dir, groups } = setup();
    const start = groups.start({
      owner: "o",
      command: ["trackwall-no-such-program"],
      cwd: dir,
      env: process.env,
      logSource: SOURCE,
    });
    await expect(start).rejects.toThrow("program trackwall-no-such-program not found in PATH");
    expect(groups.state("o")).toBeUndefined();
  });

  test("a stop during a start that failed returns no group instead of the start error", async () => {
    const { dir, groups } = setup();
    const start = groups.start({
      owner: "o",
      command: ["trackwall-no-such-program"],
      cwd: dir,
      env: process.env,
      logSource: SOURCE,
    });

    const stopped = await groups.stop("o");

    expect(stopped).toBeUndefined();
    await expect(start).rejects.toThrow("not found in PATH");
  });

  test("the working directory must be the full path of an existing directory", async () => {
    const { dir, groups } = setup();
    const spec = { owner: "o", command: [process.execPath, TREE, dir, "0", "1"], env: process.env, logSource: SOURCE };
    await expect(groups.start({ ...spec, cwd: "relative" })).rejects.toThrow("must be a full path");
    await expect(groups.start({ ...spec, cwd: join(dir, "missing") })).rejects.toThrow("does not exist");
  });

  test(
    "stopAll on daemon exit stops all groups",
    async () => {
      const { dir, groups } = setup();
      const a = mkdtempSync(join(dir, "a-"));
      const b = mkdtempSync(join(dir, "b-"));
      await groups.start({ owner: "a", command: [process.execPath, TREE, a, "0", "2"], cwd: dir, env: process.env, logSource: SOURCE });
      await groups.start({ owner: "b", command: [process.execPath, TREE, b, "0", "2"], cwd: dir, env: process.env, logSource: SOURCE });
      const pids = [...(await waitForTree(a, 2)), ...(await waitForTree(b, 2))];

      await groups.stopAll();

      expect(pids.filter(isAlive)).toEqual([]);
      expect([groups.state("a")?.kind, groups.state("b")?.kind]).toEqual(["exited", "exited"]);
    },
    TIMEOUT,
  );

  test(
    "after a hard kill of the daemon no process of the group survives the next start",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "trackwall-holder-"));
      const holder = spawn(process.execPath, [HOLDER, home], { stdio: "ignore" });
      expect(await waitUntil(() => existsSync(join(home, "ready")), 15_000)).toBe(true);
      const pids = await waitForTree(join(home, "tree"), 3);

      holder.kill("SIGKILL");
      // Windows: the job closed together with the daemon kills the group itself. macOS and Linux: the group lives until
      // the cleanup at start.
      const logs: string[] = [];
      const next = new ProcessGroups({
        logs: testLogs(),
        runtime: new RuntimeFile(join(home, "runtime.json")),
        platform: groupPlatform(),
        log: (m) => logs.push(m),
      });
      await next.sweepOrphans();

      expect(await waitUntil(() => pids.every((p) => !isAlive(p)), 5000)).toBe(true);
      expect(new RuntimeFile(join(home, "runtime.json")).read()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "an orphan whose PID went to another process is not killed",
    async () => {
      const { dir, runtime, groups, logs } = setup();
      const other = spawn(process.execPath, [TREE, dir, "0", "1"], { stdio: "ignore", detached: process.platform !== "win32" });
      const [pid] = await waitForTree(dir, 1);
      if (pid === undefined) throw new Error("missing PID");
      runtime.write([
        {
          runId: "r",
          owner: "old",
          command: ["mise", "run", "dev"],
          cwd: dir,
          startedAt: "2026-01-01T00:00:00Z",
          pid,
          identity: "another start time",
        },
      ]);

      await groups.sweepOrphans();

      expect(isAlive(pid)).toBe(true);
      expect(logs.join("\n")).toContain(`pid ${pid} is alive, but it is unknown whether it is the orphaned`);
      expect(runtime.read()).toEqual([]);
      other.kill("SIGKILL");
    },
    TIMEOUT,
  );
});

describe.each(RUNTIMES)("procs under %s", (_name, runtime) => {
  test(
    "stop halts the whole process group, and its output goes to the last lines and the log file",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-runtime-"));
      const proc = Bun.spawn([...runtime, RUNNER, dir], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, err }).toEqual({ code: 0, err: "" });

      expect(JSON.parse(out)).toMatchObject({ kind: "exited", stoppedByUser: true, lastLines: ["level 0 running"] });
      const logFile = join(dir, "logs", "mise-task", "web", "dev.jsonl");
      expect(readFileSync(logFile, "utf8")).toContain('"msg":"level 0 running"');
      expect(treePids(dir, 3)).toHaveLength(3);
      expect(treePids(dir, 3).filter(isAlive)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("procs, when the leader ends by itself during a stop", () => {
  test(
    "a stop while the rest of the group is being killed waits for it, returns the leader's code and releases the group once",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
      const real = await groupPlatform();
      let releases = 0;
      // The group looks alive for 500 ms after the kill: the stop arrives when the leader is already dead and the killing is in progress.
      // On Windows descendants die together with the leader (the leader's libuv keeps them in its own job), so without this
      // the killing would end before the test manages to stop the group.
      let killedAt: number | undefined;
      const slowKill = (control: GroupControl): GroupControl => ({
        ...control,
        kill: () => {
          killedAt ??= Date.now();
          control.kill();
        },
        isEmpty: () => killedAt !== undefined && Date.now() - killedAt >= 500 && control.isEmpty(),
        release: () => {
          releases += 1;
          control.release();
        },
      });
      const groups = new ProcessGroups({
        logs: testLogs(),
        runtime: new RuntimeFile(join(dir, "runtime.json")),
        platform: Promise.resolve({ ...real, graceMs: TEST_GRACE_MS, adopt: (child) => slowKill(real.adopt(child)) }),
        log: () => {},
      });
      await groups.start({
        owner: "o",
        command: [process.execPath, TREE, dir, "0", "3", "exit-leader", "3"],
        cwd: dir,
        env: process.env,
        logSource: SOURCE,
      });
      const pids = await waitForTree(dir, 3);
      // Without a stop, `stopping` means the daemon noticed the leader's end and is killing the rest of the group.
      expect(await waitUntil(() => groups.state("o")?.kind === "stopping", 15_000)).toBe(true);

      const stopped = await groups.stop("o");

      expect(stopped).toMatchObject({ kind: "exited", exitCode: 3, stoppedByUser: false });
      expect(pids.filter(isAlive)).toEqual([]);
      expect(releases).toBe(1);
    },
    TIMEOUT,
  );
});

describe("procs, when the group cannot be killed", () => {
  test(
    "stop reports stop_unconfirmed, the run stays stopping, and the owner does not get a second group",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
      const runtime = new RuntimeFile(join(dir, "runtime.json"));
      const groups = new ProcessGroups({ logs: testLogs(), runtime, platform: stubbornPlatform(), log: () => {} });
      const spec = { owner: "o", command: [process.execPath, TREE, dir, "0", "1"], cwd: dir, env: process.env, logSource: SOURCE };
      const started = await groups.start(spec);

      await expect(groups.stop("o")).rejects.toMatchObject({ code: "stop_unconfirmed" });

      expect(groups.state("o")?.kind).toBe("stopping");
      expect((await groups.start(spec)).runId).toBe(started.runId);
      expect(runtime.read().map((g) => g.runId)).toEqual([started.runId]);
    },
    TIMEOUT,
  );

  test(
    "an orphan that survived the kill stays in runtime.json also after a new group starts",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
      const runtime = new RuntimeFile(join(dir, "runtime.json"));
      const orphan = {
        runId: "old-run",
        owner: "old",
        command: ["mise", "run", "dev"],
        cwd: dir,
        startedAt: "2026-01-01T00:00:00Z",
        pid: 1,
        identity: null,
      };
      runtime.write([orphan]);
      const groups = new ProcessGroups({ logs: testLogs(), runtime, platform: stubbornPlatform(), log: () => {} });

      await groups.sweepOrphans();
      await groups.start({ owner: "o", command: [process.execPath, TREE, dir, "0", "1"], cwd: dir, env: process.env, logSource: SOURCE });

      expect(runtime.read().map((g) => g.runId)).toContain("old-run");
      // The fake's real `kill` ends the test's tree; the stop reports the missing confirmation anyway.
      await groups.stop("o").catch(() => {});
    },
    TIMEOUT,
  );
});

describe("runtime.json", () => {
  test("an unreadable file is moved aside, not overwritten on the next write", async () => {
    const { dir, runtime, groups, logs } = setup();
    writeFileSync(runtime.path, "{truncated");

    await groups.sweepOrphans();

    const aside = readdirSync(dir).find((f) => f.startsWith("runtime.json.broken-"));
    expect(aside && readFileSync(join(dir, aside), "utf8")).toBe("{truncated");
    expect(runtime.read()).toEqual([]);
    expect(logs.join("\n")).toContain("not JSON");
  });

  test("a missing file means no groups, and a file that does not match the schema is an error with its path", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-runtime-"));
    const runtime = new RuntimeFile(join(dir, "runtime.json"));
    expect(runtime.read()).toEqual([]);

    writeFileSync(runtime.path, JSON.stringify({ groups: [{ pid: "x" }] }));
    expect(() => runtime.read()).toThrow(runtime.path);
  });
});

describe.skipIf(process.versions.bun === undefined)("procs with the leader in a PTY", () => {
  test(
    "the PTY screen gives masked last lines of the state, but does not reach the log",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
      const logsDir = mkdtempSync(join(tmpdir(), "trackwall-procs-logs-"));
      const logs = new Logs({ dir: logsDir, maxFileBytes: 1024 * 1024, log: () => {} });
      const groups = new ProcessGroups({
        logs,
        runtime: new RuntimeFile(join(dir, "runtime.json")),
        platform: groupPlatform(),
        terminals: terminalPlatform(),
        log: () => {},
      });
      await groups.startTerminal({
        owner: "agent:x",
        command: [process.execPath, "-e", "console.log('password: ' + process.env.DB_PASSWORD)"],
        cwd: dir,
        env: { ...process.env, DB_PASSWORD: "secret-password-123" },
        cols: 80,
        rows: 24,
        onData: () => {},
      });

      expect(await waitUntil(() => groups.state("agent:x")?.kind === "exited", 15_000)).toBe(true);

      const state = groups.state("agent:x");
      if (state?.kind !== "exited") throw new Error(`group not ended: ${state?.kind}`);
      expect(state.lastLines).toContain("password: ***");
      expect(state.lastLines.join("\n")).not.toContain("secret-password-123");
      logs.flush();
      expect(readdirSync(logsDir)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "an owner whose terminal group ended starts it again, and one whose group runs does not",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
      const groups = new ProcessGroups({
        logs: testLogs(),
        runtime: new RuntimeFile(join(dir, "runtime.json")),
        platform: groupPlatform(),
        terminals: terminalPlatform(),
        log: () => {},
      });
      const spec = (code: string) => ({
        owner: "agent:x",
        command: [process.execPath, "-e", code],
        cwd: dir,
        env: process.env,
        cols: 80,
        rows: 24,
        onData: () => {},
      });
      await groups.startTerminal(spec("0"));
      expect(await waitUntil(() => groups.state("agent:x")?.kind === "exited", 15_000)).toBe(true);

      const again = await groups.startTerminal(spec("setInterval(() => {}, 1000)"));

      expect(again.run.kind).toBe("running");
      await expect(groups.startTerminal(spec("0"))).rejects.toThrow("owner agent:x already has a group");
      expect((await groups.stop("agent:x"))?.kind).toBe("exited");
    },
    TIMEOUT,
  );

  test("a failed start in a terminal rejects only the call, without an unhandled error in the daemon", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
      const groups = new ProcessGroups({
        logs: testLogs(),
        runtime: new RuntimeFile(join(dir, "runtime.json")),
        platform: groupPlatform(),
        terminals: terminalPlatform(),
        log: () => {},
      });
      const start = groups.startTerminal({
        owner: "agent:x",
        command: [process.execPath, "-e", "0"],
        cwd: join(dir, "missing"),
        env: process.env,
        cols: 80,
        rows: 24,
        onData: () => {},
      });
      await expect(start).rejects.toMatchObject({ reason: "cwd_invalid" });
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
