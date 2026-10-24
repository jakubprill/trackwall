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

/** Repo `web` z atrapą konfiguracji mise (`fake-mise.json`, opis w `fixtures/fake-mise.ts`). */
function setup(config: object, command: readonly string[] = FAKE_MISE) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-mise-"));
  const repoDir = join(home, "web");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "fake-mise.json"), JSON.stringify(config));
  const procs = new ProcessGroups({
    logs: new Logs({ dir: join(home, "logs"), maxFileBytes: 1024 * 1024, log: () => {} }),
    runtime: new RuntimeFile(join(home, "runtime.json")),
    platform: groupPlatform().then((p) => ({ ...p, graceMs: 300 })),
    log: () => {},
  });
  const repos = {
    repoPath: async (id: string) => {
      if (id !== "web") throw new DomainError("not_found", `nie ma repo ${id}`);
      return repoDir;
    },
  };
  const mise = new Mise({ procs, repos, command, env: async () => process.env });
  return { mise, repoDir, procs };
}

function writeConfig(repoDir: string, config: object): void {
  writeFileSync(join(repoDir, "fake-mise.json"), JSON.stringify(config));
}

const DEV = { name: "dev", description: "serwer deweloperski" };

describe("mise", () => {
  test("lista tasków pochodzi z mise, bez ukrytych, z opisem i bez uruchomienia", async () => {
    const { mise } = setup({ tasks: [DEV, { name: "build:ui", description: null }, { name: "_wewn", description: "", hide: true }] });

    expect(await mise.tasks("web")).toEqual({
      kind: "ok",
      tasks: [
        { name: "dev", description: "serwer deweloperski", run: null },
        { name: "build:ui", description: "", run: null },
      ],
    });
  });

  test("konfiguracja bez zaufania daje stan untrusted, a trust go zdejmuje", async () => {
    const { mise, repoDir } = setup({ tasks: [DEV], untrusted: true });

    const before = await mise.tasks("web");
    expect(before.kind).toBe("untrusted");
    expect(before.kind !== "ok" && before.message).toContain("are not trusted");
    expect(before.kind !== "ok" && before.message).not.toContain("WARN");

    expect(await mise.trust("web")).toEqual({ kind: "ok", tasks: [{ ...DEV, run: null }] });
    expect(JSON.parse(readFileSync(join(repoDir, "fake-mise.json"), "utf8")).untrusted).toBe(false);
  });

  test("brak programu mise daje stan not_installed, a start kończy się błędem mise_unavailable", async () => {
    const { mise } = setup({ tasks: [DEV] }, ["trackwall-nie-ma-mise"]);

    expect(await mise.tasks("web")).toEqual({
      kind: "not_installed",
      message: "program trackwall-nie-ma-mise not found in PATH",
      running: [],
    });
    await expect(mise.start("web", "dev")).rejects.toMatchObject({ code: "mise_unavailable" });
  });

  test("start taska, którego nie ma na liście, jest odrzucany bez uruchamiania czegokolwiek", async () => {
    const { mise, repoDir } = setup({ tasks: [DEV] });

    await expect(mise.start("web", "deploy")).rejects.toMatchObject({ code: "not_found" });
    expect(existsSync(join(repoDir, "pids"))).toBe(false);
  });

  test(
    "start uruchamia mise run w korzeniu repo, stan trafia na listę, a stop zatrzymuje całą grupę procesów",
    async () => {
      const { mise, repoDir } = setup({ tasks: [DEV] });

      const started = await mise.start("web", "dev");
      const pidFiles = [join(repoDir, "pids", "0.pid"), join(repoDir, "pids", "1.pid")];
      expect(await waitUntil(() => pidFiles.every((f) => existsSync(f)), 15_000)).toBe(true);
      const pids = pidFiles.map((f) => Number(readFileSync(f, "utf8")));
      const listed = await mise.tasks("web");
      expect(listed.kind === "ok" && listed.tasks[0]?.run).toEqual(started);

      const stopped = await mise.stop("web", "dev");

      expect(stopped).toMatchObject({ kind: "exited", stoppedByUser: true, runId: started.runId });
      expect(stopped.kind === "exited" && stopped.lastLines[0]).toBe("[dev] $ process-tree");
      expect(pids.filter(isAlive)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "task usunięty z konfiguracji w trakcie działania zostaje na liście, żeby dało się go zatrzymać",
    async () => {
      const { mise, repoDir } = setup({ tasks: [DEV] });
      await mise.start("web", "dev");
      writeConfig(repoDir, { tasks: [] });

      const listed = await mise.tasks("web");
      expect(listed.kind === "ok" && listed.tasks.map((t) => [t.name, t.run?.kind])).toEqual([["dev", "running"]]);

      await mise.stop("web", "dev");
      expect(await mise.tasks("web")).toEqual({ kind: "ok", tasks: [] });
    },
    TIMEOUT,
  );

  test(
    "gdy mise przestaje podawać listę (np. konfiguracja bez zaufania), działający task nadal jest do zatrzymania",
    async () => {
      const { mise, repoDir } = setup({ tasks: [DEV] });
      await mise.start("web", "dev");
      writeConfig(repoDir, { tasks: [DEV], untrusted: true });

      const listed = await mise.tasks("web");
      expect(listed.kind).toBe("untrusted");
      expect(listed.kind !== "ok" && listed.running.map((t) => [t.name, t.run?.kind])).toEqual([["dev", "running"]]);

      expect((await mise.stop("web", "dev")).kind).toBe("exited");
    },
    TIMEOUT,
  );

  test(
    "działające taski wszystkich repo są na liście bez pytania mise, a zatrzymany z niej znika",
    async () => {
      const { mise, repoDir } = setup({ tasks: [DEV] });
      expect(mise.running()).toEqual([]);
      const started = await mise.start("web", "dev");
      // Konfiguracja, której mise nie czyta: lista działających i tak jest pełna, bo nie pyta mise.
      writeConfig(repoDir, { tasks: [DEV], untrusted: true });

      expect(mise.running()).toEqual([{ repo: "web", miseTask: "dev", run: started }]);

      await mise.stop("web", "dev");
      expect(mise.running()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a cancelled wait for the end of a task returns at once with the running state and does not stop the task",
    async () => {
      const { mise } = setup({ tasks: [DEV] });
      const started = await mise.start("web", "dev");
      const interrupted = new AbortController();

      const waiting = mise.waitForEnd("web", "dev", 30_000, interrupted.signal);
      interrupted.abort();

      expect(await waiting).toEqual(started);
      expect(mise.running().map((t) => t.run.kind)).toEqual(["running"]);
      await mise.stop("web", "dev");
    },
    TIMEOUT,
  );

  test("waiting for a task in a repo that does not exist is not_found", async () => {
    const { mise } = setup({ tasks: [DEV] });
    await expect(mise.waitForEnd("api", "dev", 1000, new AbortController().signal)).rejects.toMatchObject({
      code: "not_found",
      message: "nie ma repo api",
    });
  });

  test("stop taska, który nie był uruchamiany, to not_found", async () => {
    const { mise } = setup({ tasks: [DEV] });
    await expect(mise.stop("web", "dev")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("mise tasks ls --json", () => {
  test("format z prawdziwego mise (2026.10) daje nazwę i opis, resztę pól pomija", () => {
    const stdout = JSON.stringify([
      {
        name: "dev",
        aliases: [],
        description: "Daemon i Vite",
        source: "/repo/mise.toml",
        depends: ["setup"],
        hide: false,
        run: ["pnpm dev"],
      },
    ]);
    expect(parseTaskList({ kind: "exited", code: 0, stdout, stderr: "" })).toEqual({
      kind: "ok",
      tasks: [{ name: "dev", description: "Daemon i Vite" }],
    });
  });

  test("błąd mise inny niż zaufanie to stan error z komunikatem mise", () => {
    const stderr = "mise ERROR error parsing config file: /repo/mise.toml\nmise ERROR expected `=`\n";
    expect(parseTaskList({ kind: "exited", code: 1, stdout: "", stderr })).toEqual({
      kind: "error",
      message: "mise ERROR error parsing config file: /repo/mise.toml\nmise ERROR expected `=`",
    });
  });

  test("wyjście, które nie jest listą tasków, to stan error, a nie wyjątek", () => {
    expect(parseTaskList({ kind: "exited", code: 0, stdout: "nie json", stderr: "" }).kind).toBe("error");
    expect(parseTaskList({ kind: "exited", code: 0, stdout: '{"dev":1}', stderr: "" }).kind).toBe("error");
  });

  test("nazwa, której mise użyłby jako opcji, nie trafia na listę", () => {
    const stdout = JSON.stringify([{ name: "--help" }, { name: "lint" }]);
    expect(parseTaskList({ kind: "exited", code: 0, stdout, stderr: "" })).toEqual({
      kind: "ok",
      tasks: [{ name: "lint", description: "" }],
    });
  });
});
