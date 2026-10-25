import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchRun, SyncResult } from "@trackwall/protocol";
import { DomainError } from "../src/infra/errors.ts";
import { Batch } from "../src/modules/batch/batch.ts";
import { Logs } from "../src/modules/logs/logs.ts";
import { Mise } from "../src/modules/mise/mise.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";
import { type GroupPlatform, isAlive, waitUntil } from "../src/platform/process-group.ts";

/** These tests run mise tasks in repo roots only, never in a task worktree (ADR-59). */
const NO_TASKS = {
  trustedTaskWorktree: async () => {
    throw new Error("no task worktree in this test");
  },
};

const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const TIMEOUT = 30_000;

/**
 * Komenda zbiorcza na prawdziwych modułach `mise` i `procs` z atrapą `mise` (opis w `fixtures/fake-mise.ts`).
 * Synchronizacja jest atrapą: `sync` mówi, co zwraca dla repo, a jej przebieg sprawdzają `sync.test.ts` i
 * `workspace.syncRepo`. `dirs` to folder z projektami: identyfikator repo -> katalog, zmienialny w trakcie testu.
 */
function setup(
  repos: Record<string, object>,
  { sync = upToDate, platform = groupPlatform() }: { sync?: (repo: string) => Promise<SyncResult>; platform?: Promise<GroupPlatform> } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-batch-"));
  const dirs = new Map<string, string>();
  for (const [id, config] of Object.entries(repos)) {
    const dir = join(home, id);
    mkdirSync(dir);
    writeFileSync(join(dir, "fake-mise.json"), JSON.stringify(config));
    dirs.set(id, dir);
  }
  const repoPath = async (id: string) => {
    const dir = dirs.get(id);
    if (!dir) throw new DomainError("not_found", `w folderze z projektami nie ma repo "${id}"`);
    return dir;
  };
  const logs = new Logs({ dir: join(home, "logs"), maxFileBytes: 1024 * 1024, log: () => {} });
  const procs = new ProcessGroups({
    logs,
    runtime: new RuntimeFile(join(home, "runtime.json")),
    platform: platform.then((p) => ({ ...p, graceMs: 300 })),
    log: () => {},
  });
  const mise = new Mise({ procs, repos: { repoPath }, tasks: NO_TASKS, command: FAKE_MISE, env: async () => process.env });
  const batch = new Batch({ workspace: { repoPath, syncRepo: sync }, mise, log: () => {} });
  return { batch, mise, procs, logs, home, dirs, dir: (id: string) => dirs.get(id) ?? "" };
}

/** Platforma, na której zabicie grupy się nie potwierdza: procesy giną, ale grupa nigdy nie jest pusta. */
async function stubbornPlatform(): Promise<GroupPlatform> {
  const real = await groupPlatform();
  return { ...real, adopt: (child) => ({ ...real.adopt(child), isEmpty: () => false }) };
}

/** Uruchomienia atrapy mise w repo trwające do zatrzymania (drzewo procesów z `pids`). */
function liveTree(dir: string): number[] {
  const pids = join(dir, "pids");
  return existsSync(pids) ? readdirSync(pids).map((f) => Number(readFileSync(join(pids, f), "utf8"))) : [];
}

async function upToDate(): Promise<SyncResult> {
  return { state: "up-to-date", branch: "main", remoteBranch: "origin/main", workingTree: { branch: "main", changed: 0, untracked: 0 } };
}

async function finished(batch: Batch): Promise<BatchRun> {
  expect(await waitUntil(() => batch.run()?.finishedAt !== null, 20_000)).toBe(true);
  const run = batch.run();
  if (!run) throw new Error("brak komendy zbiorczej");
  return run;
}

function calls(dir: string): string[] {
  const log = join(dir, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

const SETUP = { name: "setup", description: "" };
const BUILD = { name: "build", description: "" };

describe("komenda zbiorcza", () => {
  test(
    "kroki w repo idą po kolei: synchronizacja, mise install, setup i build, niezależnie od kolejności w żądaniu",
    async () => {
      const { batch, dir } = setup(
        { web: { tasks: [SETUP, BUILD], exits: { setup: 0, build: 0 } } },
        {
          sync: async () => ({
            state: "updated",
            branch: "main",
            remoteBranch: "origin/main",
            commits: 2,
            workingTree: { branch: "main", changed: 0, untracked: 0 },
          }),
        },
      );

      const started = await batch.start({ repos: ["web"], steps: ["build", "setup", "tools", "sync"] });
      expect(started.repos[0]?.steps.map((s) => s.step)).toEqual(["sync", "tools", "setup", "build"]);
      const run = await finished(batch);

      expect(calls(dir("web"))).toEqual(["install", "run setup", "run build"]);
      expect(run.repos).toEqual([
        {
          repo: "web",
          path: dir("web"),
          steps: [
            { step: "sync", state: "done", detail: "main +2" },
            { step: "tools", state: "done", detail: null },
            { step: "setup", state: "done", detail: null },
            { step: "build", state: "done", detail: null },
          ],
        },
      ]);
      expect(run.cancelled).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "repo bez taska ma krok pominięty, a pominięta synchronizacja nie zatrzymuje kolejnych kroków",
    async () => {
      const { batch, dir } = setup(
        { web: { tasks: [BUILD], exits: { build: 0 } } },
        {
          sync: async () => ({
            state: "skipped",
            reason: "dirty",
            message: "main is checked out and has uncommitted changes",
            workingTree: { branch: "main", changed: 1, untracked: 0 },
          }),
        },
      );

      await batch.start({ repos: ["web"], steps: ["sync", "setup", "build"] });
      const run = await finished(batch);

      expect(run.repos[0]?.steps).toEqual([
        { step: "sync", state: "skipped", message: "main is checked out and has uncommitted changes" },
        { step: "setup", state: "skipped", message: "the repo has no mise task setup" },
        { step: "build", state: "done", detail: null },
      ]);
      expect(calls(dir("web"))).toEqual(["run build"]);
    },
    TIMEOUT,
  );

  test(
    "błąd kroku kończy repo z kodem wyjścia i ostatnimi liniami, a pozostałe repo idą dalej",
    async () => {
      const { batch, dir } = setup({
        api: { tasks: [SETUP, BUILD], exits: { setup: 3, build: 0 } },
        web: { tasks: [SETUP, BUILD], exits: { setup: 0, build: 0 } },
      });

      await batch.start({ repos: ["api", "web"], steps: ["setup", "build"] });
      const run = await finished(batch);

      expect(run.repos[0]?.steps).toEqual([
        { step: "setup", state: "failed", message: "exited with code 3", lastLines: ["[setup] $ koniec"] },
        { step: "build", state: "skipped", message: "skipped after step setup failed" },
      ]);
      expect(calls(dir("api"))).toEqual(["run setup"]);
      expect(run.repos[1]?.steps.map((s) => s.state)).toEqual(["done", "done"]);
    },
    TIMEOUT,
  );

  test(
    "mise, który nie podaje listy tasków, to błąd kroku z komunikatem mise",
    async () => {
      const { batch } = setup({ web: { tasks: [SETUP], untrusted: true } });

      await batch.start({ repos: ["web"], steps: ["setup"] });
      const run = await finished(batch);

      const [step] = run.repos[0]?.steps ?? [];
      expect(step).toMatchObject({ step: "setup", state: "failed", lastLines: [] });
      expect(step?.state === "failed" && step.message).toContain("are not trusted");
    },
    TIMEOUT,
  );

  test(
    "przerwanie zatrzymuje całą grupę trwającego taska, a kroki, które się nie zaczęły, nie ruszają",
    async () => {
      // `build` bez kodu w `exits` działa do zatrzymania jako drzewo procesów.
      const { batch, dir } = setup({ web: { tasks: [SETUP, BUILD], exits: { setup: 0 } } });

      await batch.start({ repos: ["web"], steps: ["setup", "build"] });
      expect(await waitUntil(() => liveTree(dir("web")).length === 2, 15_000)).toBe(true);
      const tree = liveTree(dir("web"));
      batch.cancel();
      const run = await finished(batch);

      expect(run.cancelled).toBe(true);
      expect(run.repos[0]?.steps).toEqual([
        { step: "setup", state: "done", detail: null },
        { step: "build", state: "cancelled" },
      ]);
      expect(tree.filter(isAlive)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "repo, które czeka na swoją kolej, po przerwaniu nie zaczyna żadnego kroku",
    async () => {
      // Trzy repo zajmują wszystkie miejsca taskiem działającym do zatrzymania, czwarte czeka.
      const repos = { a: { tasks: [BUILD] }, b: { tasks: [BUILD] }, c: { tasks: [BUILD] }, d: { tasks: [BUILD] } };
      const { batch, dir } = setup(repos);

      await batch.start({ repos: ["a", "b", "c", "d"], steps: ["build"] });
      expect(await waitUntil(() => ["a", "b", "c"].every((id) => calls(dir(id)).length === 1), 15_000)).toBe(true);
      batch.cancel();
      const run = await finished(batch);

      expect(run.repos.map((r) => r.steps[0]?.state)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
      expect(calls(dir("d"))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "nieudany mise install pomija zależności i build tego repo, a jego wyjście ma własny log",
    async () => {
      const { batch, logs, dir } = setup({ web: { tasks: [SETUP, BUILD], exits: { setup: 0, build: 0 }, installExit: 1 } });

      await batch.start({ repos: ["web"], steps: ["tools", "setup", "build"] });
      const run = await finished(batch);

      expect(run.repos[0]?.steps).toEqual([
        { step: "tools", state: "failed", message: "exited with code 1", lastLines: ["mise all tools are installed"] },
        { step: "setup", state: "skipped", message: "skipped after step tools failed" },
        { step: "build", state: "skipped", message: "skipped after step tools failed" },
      ]);
      expect(calls(dir("web"))).toEqual(["install"]);
      const installLog = logs.tail({ source: { kind: "mise-install", repo: "web" }, limit: 10 });
      expect(installLog.records.map((r) => [r.stream, r.msg])).toEqual([["stderr", "mise all tools are installed"]]);
    },
    TIMEOUT,
  );

  test(
    "build uruchomiony wcześniej ze szczegółów repo nie startuje drugi raz, a jego stop ze szczegółów repo kończy krok jako przerwany",
    async () => {
      const { batch, mise, procs, dir } = setup({ web: { tasks: [BUILD] } });
      const fromCard = await mise.start({ repo: "web", task: null }, "build");
      // Komenda czeka na koniec grupy przez `procs.ended`; dopiero wtedy wiadomo, że dołączyła do taska ze szczegółów repo.
      const waitsForEnd = procs.ended.bind(procs);
      const joined = new Promise<void>((resolve) => {
        procs.ended = (owner) => {
          resolve();
          return waitsForEnd(owner);
        };
      });

      await batch.start({ repos: ["web"], steps: ["build"] });
      await joined;
      await mise.stop({ repo: "web", task: null }, "build");
      const run = await finished(batch);

      expect(calls(dir("web"))).toEqual(["run build"]);
      expect(run.repos[0]?.steps).toEqual([{ step: "build", state: "cancelled" }]);
      await expect(mise.tasks("web")).resolves.toMatchObject({
        tasks: [{ name: "build", run: { runId: fromCard.runId, kind: "exited" } }],
      });
    },
    TIMEOUT,
  );

  test(
    "dowiązanie do repo z listy idzie po kolei z tym repo, a nie równolegle w tym samym katalogu",
    async () => {
      const { batch, dirs, dir, home } = setup({ web: { tasks: [BUILD] } });
      const link = join(home, "web-link");
      // Junction na Windowsie nie wymaga uprawnień administratora; poza Windowsem typ jest pomijany.
      symlinkSync(dir("web"), link, "junction");
      dirs.set("web-link", link);

      await batch.start({ repos: ["web", "web-link"], steps: ["build"] });
      expect(await waitUntil(() => calls(dir("web")).length === 1, 15_000)).toBe(true);
      // Drugi wpis czekałby na wolne miejsce, gdyby szedł równolegle: miejsc jest trzy, więc start byłby od razu.
      expect(await waitUntil(() => calls(dir("web")).length > 1, 1500)).toBe(false);
      expect(batch.run()?.repos.map((r) => r.steps[0]?.state)).toEqual(["running", "waiting"]);
      batch.cancel();
      await finished(batch);
    },
    TIMEOUT,
  );

  test(
    "krok idzie tylko w katalogu z chwili startu: identyfikator, który przeszedł na inny katalog, to błąd kroku",
    async () => {
      const { batch, dirs, dir, home } = setup(
        { web: { tasks: [BUILD], exits: { build: 0 } }, inny: { tasks: [BUILD], exits: { build: 0 } } },
        {
          sync: async () => {
            dirs.set("web", join(home, "inny"));
            return {
              state: "up-to-date",
              branch: "main",
              remoteBranch: "origin/main",
              workingTree: { branch: "main", changed: 0, untracked: 0 },
            };
          },
        },
      );
      const webDir = dir("web");

      await batch.start({ repos: ["web"], steps: ["sync", "build"] });
      const run = await finished(batch);

      expect(run.repos[0]?.steps[1]).toEqual({
        step: "build",
        state: "failed",
        message: `web now points to a different directory than ${webDir}`,
        lastLines: [],
      });
      expect(calls(join(home, "inny"))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "grupa, której zatrzymania nie da się potwierdzić, kończy krok błędem stop_unconfirmed zamiast trzymać komendę",
    async () => {
      const { batch, dir } = setup({ web: { tasks: [BUILD] } }, { platform: stubbornPlatform() });

      await batch.start({ repos: ["web"], steps: ["build"] });
      expect(await waitUntil(() => liveTree(dir("web")).length === 2, 15_000)).toBe(true);
      batch.cancel();
      const run = await finished(batch);

      const [step] = run.repos[0]?.steps ?? [];
      expect(step).toMatchObject({ step: "build", state: "failed" });
      expect(step?.state === "failed" && step.message).toContain("still running");
    },
    TIMEOUT,
  );

  test(
    "wyjście daemona przerywa komendę, a nowej nie da się już zacząć",
    async () => {
      const { batch } = setup({ web: { tasks: [BUILD] } });

      await batch.start({ repos: ["web"], steps: ["build"] });
      batch.close();
      const run = await finished(batch);

      expect(run.cancelled).toBe(true);
      await expect(batch.start({ repos: ["web"], steps: ["build"] })).rejects.toMatchObject({ code: "bad_request" });
    },
    TIMEOUT,
  );

  test(
    "druga komenda w trakcie pierwszej jest odrzucana, a nieznane repo odrzuca żądanie, zanim cokolwiek ruszy",
    async () => {
      const { batch, dir } = setup({ web: { tasks: [BUILD] } });

      await expect(batch.start({ repos: ["web", "nie-ma"], steps: ["build"] })).rejects.toMatchObject({ code: "not_found" });
      expect(batch.run()).toBeNull();
      expect(calls(dir("web"))).toEqual([]);

      await batch.start({ repos: ["web"], steps: ["build"] });
      await expect(batch.start({ repos: ["web"], steps: ["build"] })).rejects.toMatchObject({ code: "bad_request" });
      batch.cancel();
      await finished(batch);
    },
    TIMEOUT,
  );
});
