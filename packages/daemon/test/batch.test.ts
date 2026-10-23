import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchRun, SyncResult } from "@trackwall/protocol";
import { DomainError } from "../src/errors.ts";
import { Batch } from "../src/modules/batch/batch.ts";
import { Mise } from "../src/modules/mise/mise.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";
import { isAlive, waitUntil } from "../src/platform/process-group.ts";

const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const TIMEOUT = 30_000;

/**
 * Komenda zbiorcza na prawdziwych modułach `mise` i `procs` z atrapą `mise` (opis w `fixtures/fake-mise.ts`).
 * Synchronizacja jest atrapą: `sync` mówi, co zwraca dla repo, a jej przebieg sprawdza `sync.test.ts`.
 */
function setup(repos: Record<string, object>, sync: (repo: string) => Promise<SyncResult> = upToDate) {
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
  const procs = new ProcessGroups({
    runtime: new RuntimeFile(join(home, "runtime.json")),
    platform: groupPlatform().then((p) => ({ ...p, graceMs: 300 })),
    log: () => {},
  });
  const mise = new Mise({ procs, repos: { repoPath }, command: FAKE_MISE, env: async () => process.env });
  const batch = new Batch({ workspace: { repoPath, syncRepo: sync }, mise });
  return { batch, dir: (id: string) => dirs.get(id) ?? "" };
}

async function upToDate(): Promise<SyncResult> {
  return { state: "up-to-date", branch: "main" };
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
      const { batch, dir } = setup({ web: { tasks: [SETUP, BUILD], exits: { setup: 0, build: 0 } } }, async () => ({
        state: "updated",
        branch: "main",
        commits: 2,
      }));

      const started = await batch.start({ repos: ["web"], steps: ["build", "setup", "tools", "sync"] });
      expect(started.steps).toEqual(["sync", "tools", "setup", "build"]);
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
      const { batch, dir } = setup({ web: { tasks: [BUILD], exits: { build: 0 } } }, async () => ({
        state: "skipped",
        reason: "dirty",
        message: "w gałęzi main są niezacommitowane zmiany",
      }));

      await batch.start({ repos: ["web"], steps: ["sync", "setup", "build"] });
      const run = await finished(batch);

      expect(run.repos[0]?.steps).toEqual([
        { step: "sync", state: "skipped", message: "w gałęzi main są niezacommitowane zmiany" },
        { step: "setup", state: "skipped", message: "repo nie ma taska mise setup" },
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
        { step: "setup", state: "failed", message: "zakończony kodem 3", lastLines: ["[setup] $ koniec"] },
        { step: "build", state: "skipped", message: "pominięty po błędzie kroku setup" },
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
      const pids = join(dir("web"), "pids");

      await batch.start({ repos: ["web"], steps: ["setup", "build"] });
      expect(await waitUntil(() => existsSync(pids) && readdirSync(pids).length === 2, 15_000)).toBe(true);
      const tree = readdirSync(pids).map((f) => Number(readFileSync(join(pids, f), "utf8")));
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
