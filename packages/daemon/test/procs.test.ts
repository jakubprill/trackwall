import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
/** Drzewo ignoruje łagodny stop, więc krótki czas łaski skraca testy bez zmiany przebiegu. */
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
 * Platforma, na której zabicie grupy się nie udaje: lider kończy się zwykłym `kill`, ale grupa nigdy nie jest pusta.
 * Tak wygląda proces, którego system nie umie zakończyć (np. zawieszony w sterowniku).
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
    "stop zatrzymuje całą grupę, także wnuki ignorujące łagodny stop, i usuwa ją z runtime.json",
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
    "ended czeka na potwierdzony koniec grupy i zwraca jej stan, a dla właściciela bez grupy zwraca undefined",
    async () => {
      const { dir, groups } = setup();
      expect(await groups.ended("nikt")).toBeUndefined();
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
    "lider, który kończy się sam, zabiera resztę grupy, a stan ma kod wyjścia i ostatnie linie",
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
        lastLines: ["poziom 0 działa", "lider kończy się sam"],
      });
      expect(pids.filter(isAlive)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "drugi start tego samego właściciela zwraca działające uruchomienie zamiast nowej grupy",
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
    "stop w trakcie startu czeka na grupę i ją zatrzymuje, a po stopAll nowy start jest odrzucany",
    async () => {
      const { dir, groups } = setup();
      const spec = { owner: "o", command: [process.execPath, TREE, dir, "0", "1"], cwd: dir, env: process.env, logSource: SOURCE };
      const started = groups.start(spec);

      const stopped = await groups.stop("o");
      await groups.stopAll();

      expect(stopped).toMatchObject({ kind: "exited", runId: (await started).runId });
      await expect(groups.start(spec)).rejects.toThrow("daemon się zatrzymuje");
    },
    TIMEOUT,
  );

  test("program, którego nie ma, kończy start błędem z nazwą programu", async () => {
    const { dir, groups } = setup();
    const start = groups.start({
      owner: "o",
      command: ["trackwall-nie-ma-takiego-programu"],
      cwd: dir,
      env: process.env,
      logSource: SOURCE,
    });
    await expect(start).rejects.toThrow("nie znaleziono programu trackwall-nie-ma-takiego-programu w PATH");
    expect(groups.state("o")).toBeUndefined();
  });

  test("stop w trakcie startu, który się nie udał, zwraca brak grupy zamiast błędu startu", async () => {
    const { dir, groups } = setup();
    const start = groups.start({
      owner: "o",
      command: ["trackwall-nie-ma-takiego-programu"],
      cwd: dir,
      env: process.env,
      logSource: SOURCE,
    });

    const stopped = await groups.stop("o");

    expect(stopped).toBeUndefined();
    await expect(start).rejects.toThrow("nie znaleziono programu");
  });

  test("katalog roboczy musi być pełną ścieżką istniejącego katalogu", async () => {
    const { dir, groups } = setup();
    const spec = { owner: "o", command: [process.execPath, TREE, dir, "0", "1"], env: process.env, logSource: SOURCE };
    await expect(groups.start({ ...spec, cwd: "wzgledny" })).rejects.toThrow("pełną ścieżką");
    await expect(groups.start({ ...spec, cwd: join(dir, "nie-ma") })).rejects.toThrow("nie istnieje");
  });

  test(
    "stopAll przy wyjściu daemona zatrzymuje wszystkie grupy",
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
    "po twardym zabiciu daemona żaden proces grupy nie przeżywa następnego startu",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "trackwall-holder-"));
      const holder = spawn(process.execPath, [HOLDER, home], { stdio: "ignore" });
      expect(await waitUntil(() => existsSync(join(home, "ready")), 15_000)).toBe(true);
      const pids = await waitForTree(join(home, "tree"), 3);

      holder.kill("SIGKILL");
      // Windows: job zamknięty razem z daemonem zabija grupę sam. macOS i Linux: grupa żyje do sprzątania przy starcie.
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
    "sierota, której PID dostał inny proces, nie jest zabijana",
    async () => {
      const { dir, runtime, groups, logs } = setup();
      const other = spawn(process.execPath, [TREE, dir, "0", "1"], { stdio: "ignore", detached: process.platform !== "win32" });
      const [pid] = await waitForTree(dir, 1);
      if (pid === undefined) throw new Error("brak PID-u");
      runtime.write([
        {
          runId: "r",
          owner: "stary",
          command: ["mise", "run", "dev"],
          cwd: dir,
          startedAt: "2026-01-01T00:00:00Z",
          pid,
          identity: "inny czas startu",
        },
      ]);

      await groups.sweepOrphans();

      expect(isAlive(pid)).toBe(true);
      expect(logs.join("\n")).toContain(`pid ${pid} żyje, ale nie wiadomo, czy to sierota`);
      expect(runtime.read()).toEqual([]);
      other.kill("SIGKILL");
    },
    TIMEOUT,
  );
});

describe.each(RUNTIMES)("procs pod %s", (_name, runtime) => {
  test(
    "stop zatrzymuje całą grupę procesów, a jej wyjście trafia do ostatnich linii i pliku logu",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-runtime-"));
      const proc = Bun.spawn([...runtime, RUNNER, dir], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, err }).toEqual({ code: 0, err: "" });

      expect(JSON.parse(out)).toMatchObject({ kind: "exited", stoppedByUser: true, lastLines: ["poziom 0 działa"] });
      const logFile = join(dir, "logs", "mise-task", "web", "dev.jsonl");
      expect(readFileSync(logFile, "utf8")).toContain('"msg":"poziom 0 działa"');
      expect(treePids(dir, 3)).toHaveLength(3);
      expect(treePids(dir, 3).filter(isAlive)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("procs, gdy lider kończy się sam w trakcie stopu", () => {
  test(
    "stop w czasie dobijania reszty grupy czeka na nie, zwraca kod lidera i zwalnia grupę raz",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
      const real = await groupPlatform();
      let releases = 0;
      // Grupa wygląda na żywą jeszcze 500 ms po zabiciu: stop przychodzi, gdy lider już nie żyje, a dobijanie trwa.
      // Na Windowsie potomkowie giną razem z liderem (libuv lidera trzyma ich we własnym jobie), więc bez tego
      // dobijanie kończyłoby się, zanim test zdąży zatrzymać grupę.
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
      // Bez stopu `stopping` znaczy, że daemon zauważył koniec lidera i dobija resztę grupy.
      expect(await waitUntil(() => groups.state("o")?.kind === "stopping", 15_000)).toBe(true);

      const stopped = await groups.stop("o");

      expect(stopped).toMatchObject({ kind: "exited", exitCode: 3, stoppedByUser: false });
      expect(pids.filter(isAlive)).toEqual([]);
      expect(releases).toBe(1);
    },
    TIMEOUT,
  );
});

describe("procs, gdy grupy nie da się zabić", () => {
  test(
    "stop zgłasza stop_unconfirmed, uruchomienie zostaje stopping, a właściciel nie dostaje drugiej grupy",
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
    "sierota, która przeżyła zabicie, zostaje w runtime.json także po starcie nowej grupy",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
      const runtime = new RuntimeFile(join(dir, "runtime.json"));
      const orphan = {
        runId: "stara",
        owner: "stary",
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

      expect(runtime.read().map((g) => g.runId)).toContain("stara");
      // Prawdziwe `kill` atrapy kończy drzewo testu; stop i tak zgłosi brak potwierdzenia.
      await groups.stop("o").catch(() => {});
    },
    TIMEOUT,
  );
});

describe("runtime.json", () => {
  test("nieczytelny plik jest odkładany obok, a nie nadpisywany przy następnym zapisie", async () => {
    const { dir, runtime, groups, logs } = setup();
    writeFileSync(runtime.path, "{ucięty");

    await groups.sweepOrphans();

    const aside = readdirSync(dir).find((f) => f.startsWith("runtime.json.broken-"));
    expect(aside && readFileSync(join(dir, aside), "utf8")).toBe("{ucięty");
    expect(runtime.read()).toEqual([]);
    expect(logs.join("\n")).toContain("to nie jest JSON");
  });

  test("brak pliku to brak grup, a plik niezgodny ze schematem jest błędem z jego ścieżką", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-runtime-"));
    const runtime = new RuntimeFile(join(dir, "runtime.json"));
    expect(runtime.read()).toEqual([]);

    writeFileSync(runtime.path, JSON.stringify({ groups: [{ pid: "x" }] }));
    expect(() => runtime.read()).toThrow(runtime.path);
  });
});

describe.skipIf(process.versions.bun === undefined)("procs z liderem w PTY", () => {
  test(
    "ekran PTY daje zamaskowane ostatnie linie stanu, ale nie trafia do logu",
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
        command: [process.execPath, "-e", "console.log('hasło: ' + process.env.DB_PASSWORD)"],
        cwd: dir,
        env: { ...process.env, DB_PASSWORD: "tajne-haslo-123" },
        cols: 80,
        rows: 24,
        onData: () => {},
      });

      expect(await waitUntil(() => groups.state("agent:x")?.kind === "exited", 15_000)).toBe(true);

      const state = groups.state("agent:x");
      if (state?.kind !== "exited") throw new Error(`grupa nie zakończona: ${state?.kind}`);
      expect(state.lastLines).toContain("hasło: ***");
      expect(state.lastLines.join("\n")).not.toContain("tajne-haslo-123");
      logs.flush();
      expect(readdirSync(logsDir)).toEqual([]);
    },
    TIMEOUT,
  );

  test("nieudany start w terminalu odrzuca tylko wywołanie, bez nieobsłużonego błędu w daemonie", async () => {
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
        cwd: join(dir, "nie-ma"),
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
