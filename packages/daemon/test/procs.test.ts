import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputTail } from "../src/modules/procs/output-tail.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";
import { isAlive, waitUntil } from "../src/platform/process-group.ts";

const TREE = join(import.meta.dir, "fixtures", "process-tree.ts");
const HOLDER = join(import.meta.dir, "fixtures", "procs-holder.ts");
/** Drzewo ignoruje łagodny stop, więc krótki czas łaski skraca testy bez zmiany przebiegu. */
const TEST_GRACE_MS = 300;
const TIMEOUT = 30_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-procs-"));
  const runtime = new RuntimeFile(join(dir, "runtime.json"));
  const logs: string[] = [];
  const groups = new ProcessGroups({
    runtime,
    platform: groupPlatform().then((p) => ({ ...p, graceMs: TEST_GRACE_MS })),
    log: (msg) => logs.push(msg),
  });
  return { dir, runtime, groups, logs };
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
      const started = await groups.start({ owner: "o", command: [process.execPath, TREE, dir, "0", "3"], cwd: dir, env: process.env });
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
    "lider, który kończy się sam, zabiera resztę grupy, a stan ma kod wyjścia i ostatnie linie",
    async () => {
      const { dir, groups } = setup();
      await groups.start({ owner: "o", command: [process.execPath, TREE, dir, "0", "3", "exit-leader", "3"], cwd: dir, env: process.env });
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
      const spec = { owner: "o", command: [process.execPath, TREE, dir, "0", "1"], cwd: dir, env: process.env };
      const [first, second] = await Promise.all([groups.start(spec), groups.start(spec)]);
      const third = await groups.start(spec);

      expect(second.runId).toBe(first.runId);
      expect(third.runId).toBe(first.runId);
      await groups.stop("o");
    },
    TIMEOUT,
  );

  test("program, którego nie ma, kończy start błędem z nazwą programu", async () => {
    const { dir, groups } = setup();
    const start = groups.start({ owner: "o", command: ["trackwall-nie-ma-takiego-programu"], cwd: dir, env: process.env });
    await expect(start).rejects.toThrow("nie znaleziono programu trackwall-nie-ma-takiego-programu w PATH");
    expect(groups.state("o")).toBeUndefined();
  });

  test("katalog roboczy musi być pełną ścieżką istniejącego katalogu", async () => {
    const { dir, groups } = setup();
    const spec = { owner: "o", command: [process.execPath, TREE, dir, "0", "1"], env: process.env };
    await expect(groups.start({ ...spec, cwd: "wzgledny" })).rejects.toThrow("pełną ścieżką");
    await expect(groups.start({ ...spec, cwd: join(dir, "nie-ma") })).rejects.toThrow("nie istnieje");
  });

  test(
    "stopAll przy wyjściu daemona zatrzymuje wszystkie grupy",
    async () => {
      const { dir, groups } = setup();
      const a = mkdtempSync(join(dir, "a-"));
      const b = mkdtempSync(join(dir, "b-"));
      await groups.start({ owner: "a", command: [process.execPath, TREE, a, "0", "2"], cwd: dir, env: process.env });
      await groups.start({ owner: "b", command: [process.execPath, TREE, b, "0", "2"], cwd: dir, env: process.env });
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

describe("ostatnie linie wyjścia", () => {
  test("łączy strumienie w kolejności linii, bez kolorów i nadpisanego postępu", () => {
    const tail = new OutputTail();
    tail.push("stdout", Buffer.from("\x1b[32mstart\x1b[0m\npobieranie 10%\rpobieranie 100%\n"));
    tail.push("stderr", Buffer.from("ostrzeż"));
    tail.push("stdout", Buffer.from("gotowe\n"));
    tail.push("stderr", Buffer.from("enie\n\n"));

    expect(tail.snapshot()).toEqual(["start", "pobieranie 100%", "gotowe", "ostrzeżenie"]);
  });

  test("znak UTF-8 rozcięty między kawałkami nie psuje linii", () => {
    const tail = new OutputTail();
    const bytes = Buffer.from("zażółć\n");
    tail.push("stdout", bytes.subarray(0, 3));
    tail.push("stdout", bytes.subarray(3));

    expect(tail.snapshot()).toEqual(["zażółć"]);
  });

  test("trzyma tylko ostatnie 20 linii, z niedokończoną linią na końcu", () => {
    const tail = new OutputTail();
    tail.push("stdout", Buffer.from(`${Array.from({ length: 30 }, (_, i) => `linia ${i}`).join("\n")}`));

    const lines = tail.snapshot();
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("linia 10");
    expect(lines.at(-1)).toBe("linia 29");
  });
});

describe("runtime.json", () => {
  test("brak pliku to brak grup, a plik niezgodny ze schematem jest błędem z jego ścieżką", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-runtime-"));
    const runtime = new RuntimeFile(join(dir, "runtime.json"));
    expect(runtime.read()).toEqual([]);

    writeFileSync(runtime.path, JSON.stringify({ groups: [{ pid: "x" }] }));
    expect(() => runtime.read()).toThrow(runtime.path);
  });
});
