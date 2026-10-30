import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphEdge, RepoCardResult, RepoGraph } from "@trackwall/protocol";
import { DomainError } from "../src/infra/errors.ts";
import { Logs } from "../src/modules/logs/logs.ts";
import { Mise } from "../src/modules/mise/mise.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { probePort } from "../src/modules/services/port-probe.ts";
import { Services } from "../src/modules/services/services.ts";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";

const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const TIMEOUT = 60_000;
const SECRET = "s3cr3t-token-value";

/** A task's worktree with its own fake mise config, and the task port `agents` gave it (ADR-61). */
interface FakeTask {
  repo: string;
  port: number;
  config: object;
}

/**
 * Repos with a fake mise config each (`fixtures/fake-mise.ts`, `servers` runs `fixtures/fake-service.ts`), and task
 * worktrees by task id, each in its own directory.
 */
function setup(
  repos: Record<string, object>,
  opts: { edges?: GraphEdge[]; cardPorts?: Record<string, number>; tasks?: Record<string, FakeTask> } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-services-"));
  for (const [id, config] of Object.entries(repos)) {
    mkdirSync(join(home, id));
    writeFileSync(join(home, id, "fake-mise.json"), JSON.stringify(config));
  }
  const tasks = opts.tasks ?? {};
  for (const [id, task] of Object.entries(tasks)) {
    mkdirSync(join(home, "worktrees", id), { recursive: true });
    writeFileSync(join(home, "worktrees", id, "fake-mise.json"), JSON.stringify(task.config));
  }
  const taskOf = (id: string) => {
    const task = tasks[id];
    if (!task) throw new DomainError("not_found", `no task ${id}`);
    return task;
  };
  const worktrees = {
    trustedTaskWorktree: async (id: string, repo: string) => {
      if (taskOf(id).repo !== repo) throw new DomainError("bad_request", `task ${id} is not in ${repo}`);
      return { worktree: join(home, "worktrees", id), port: taskOf(id).port };
    },
  };
  const logs = new Logs({ dir: join(home, "logs"), maxFileBytes: 1024 * 1024, log: () => {} });
  const procs = new ProcessGroups({
    logs,
    runtime: new RuntimeFile(join(home, "runtime.json")),
    platform: groupPlatform().then((p) => ({ ...p, graceMs: 300 })),
    log: () => {},
  });
  const repoPath = async (id: string) => {
    if (!(id in repos)) throw new DomainError("not_found", `no repo ${id}`);
    return join(home, id);
  };
  const env = async () => ({ ...process.env, FAKE_API_TOKEN: SECRET });
  const mise = new Mise({
    procs,
    repos: { repoPath, projectsDir: async () => home, sessionProfile: () => null },
    tasks: worktrees,
    vcs: new Vcs(systemTempFolder),
    command: FAKE_MISE,
    env,
    onTrusted: () => {},
  });
  const graph = {
    graph: async () => ({ nodes: [], edges: opts.edges ?? [], problems: [], configProblems: [], configFile: "" }) as RepoGraph,
  };
  const cards = {
    card: async (repo: string) => {
      const port = opts.cardPorts?.[repo];
      const provides = port ? [{ kind: "app", name: repo, port, module: "", evidence: { file: "application.yml", line: 1 } }] : [];
      return { repo, card: { provides }, tags: [] } as unknown as RepoCardResult;
    },
  };
  const taskPort = (repo: string, id: string) => {
    if (taskOf(id).repo !== repo) throw new DomainError("bad_request", `task ${id} is in ${taskOf(id).repo}, not in ${repo}`);
    return taskOf(id).port;
  };
  const services = new Services({
    mise,
    logs,
    graph,
    cards,
    taskPort,
    env,
    log: () => {},
    intervalMs: 100,
    startupMs: 1500,
    settleMs: 300,
    releaseMs: 5000,
  });
  cleanups.push(() => procs.stopAll());
  return { services, procs, mise, tasks };
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function http(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    kind: "calls",
    source: "http",
    key: `${to}-app`,
    confidence: "high",
    evidence: [{ repo: from, path: "a.yml", line: 1, detail: "calls" }],
  };
}

const DEV = { tasks: [{ name: "dev" }] };

/**
 * A build daemon like Gradle's, in the test process and so outside every process group: for each client (the fake
 * service in `dev`) it runs an app on `appPort` and closes it `lingerMs` after the client's connection closes, or when
 * the test calls `close` (`lingerMs: null`).
 */
async function buildDaemon(appPort: number, lingerMs: number | null) {
  const apps = new Set<Server>();
  const clients = new Set<Socket>();
  const closeApp = (app: Server) => {
    apps.delete(app);
    app.close();
    app.closeAllConnections();
  };
  const daemon = createTcpServer((client) => {
    clients.add(client);
    const app = createServer((_, res) => res.end("app"));
    apps.add(app);
    app.listen(appPort, "127.0.0.1", () => client.write(String(appPort)));
    client.on("error", () => {});
    client.on("close", () => {
      clients.delete(client);
      if (lingerMs !== null) setTimeout(() => closeApp(app), lingerMs);
    });
  });
  await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const close = () => {
    for (const app of apps) closeApp(app);
  };
  cleanups.push(async () => {
    close();
    for (const client of clients) client.destroy();
    await new Promise((resolve) => daemon.close(resolve));
  });
  return { port: (daemon.address() as AddressInfo).port, close };
}

describe("services (real process groups, fake mise and fake service)", () => {
  test(
    "start brings the dependency up first, each is healthy on the port from its log, the root last",
    async () => {
      const { services } = setup(
        { web: { ...DEV, servers: { dev: {} } }, api: { ...DEV, servers: { dev: { delayMs: 400 } } }, docs: { tasks: [] } },
        { edges: [http("web", "api"), http("web", "docs")] },
      );

      const slice = await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 20_000 });

      expect(slice.settled).toBe(true);
      expect(slice.members.map((m) => [m.repo, m.outcome, m.service?.state ?? null, m.problem])).toEqual([
        ["api", "started", "healthy", null],
        ["docs", "skipped", null, 'docs has no mise task "dev", which runs its service'],
        ["web", "started", "healthy", null],
      ]);
      expect(slice.members[0]?.calledBy).toEqual([{ repo: "web", key: "api-app" }]);
      const [api, , web] = slice.members.map((m) => m.service);
      expect(api?.portSource).toBe("log");
      // The root starts only after its dependency has settled.
      expect(Date.parse(web?.run.startedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(api?.since ?? ""));
      expect((await services.list()).map((s) => [s.repo, s.state])).toEqual([
        ["api", "healthy"],
        ["web", "healthy"],
      ]);
    },
    TIMEOUT,
  );

  test(
    "a second start does not start a running service again, it reports it as running",
    async () => {
      const { services } = setup({ web: { ...DEV, servers: { dev: {} } } });
      const first = await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      const second = await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      expect(second.members[0]?.outcome).toBe("running");
      expect(second.members[0]?.service?.run.runId).toBe(first.members[0]?.service?.run.runId ?? "");
    },
    TIMEOUT,
  );

  test(
    "a service that exits by itself is crashed, with the errors from its log",
    async () => {
      const { services } = setup({ web: { ...DEV, servers: { dev: { crash: true } } } });

      const slice = await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      const [member] = slice.members;
      expect(member?.service).toMatchObject({ state: "crashed", reason: "the process exited with code 1" });
      expect(member?.errors[0]?.exception).toBe("java.lang.IllegalStateException: Failed to load the database driver");
    },
    TIMEOUT,
  );

  test(
    "a service whose port never answers is unhealthy after the startup limit",
    async () => {
      const { services } = setup({ web: { ...DEV, servers: { dev: { quiet: true, delayMs: 60_000 } } } });

      const slice = await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      expect(slice.members[0]?.service).toMatchObject({
        state: "unhealthy",
        reason: "no port in the log or on the card within 2 s of the start",
      });
    },
    TIMEOUT,
  );

  test(
    "a port from the card that is already taken by another process skips the start",
    async () => {
      const other: Server = createServer((_, res) => res.end("other"));
      await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise((resolve) => other.close(resolve)));
      const { port } = other.address() as AddressInfo;
      const { services } = setup({ web: { ...DEV, servers: { dev: {} } } }, { cardPorts: { web: port } });

      const slice = await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      expect(slice.members[0]).toMatchObject({
        outcome: "skipped",
        problem: `port ${port} (server.port on the card) is already in use by a program Trackwall did not start`,
      });
    },
    TIMEOUT,
  );

  test("a repo without the mise task dev is not_found before anything starts", async () => {
    const { services } = setup({ web: { tasks: [{ name: "build" }] } });

    await expect(services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 0 })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await services.list()).toEqual([]);
  });

  test(
    "call returns the response with the secret masked, and errors the service logged during the call",
    async () => {
      const { services } = setup({ web: { ...DEV, servers: { dev: {} } } });
      await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      const ok = await services.call({
        repo: "web",
        task: null,
        method: "POST",
        path: "/api/orders?x=1",
        headers: {},
        body: '{"n":1}',
        timeoutMs: 5000,
      });
      expect(ok.response?.status).toBe(200);
      expect(JSON.parse(ok.response?.body ?? "")).toMatchObject({ method: "POST", path: "/api/orders?x=1", body: '{"n":1}', token: "***" });
      expect(ok.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/orders\?x=1$/);
      expect(ok.errors).toEqual([]);

      const boom = await services.call({ repo: "web", task: null, method: "GET", path: "/boom", headers: {}, body: null, timeoutMs: 5000 });
      expect(boom.response?.status).toBe(500);
      expect(boom.errors.map((e) => e.exception)).toEqual(["java.lang.NullPointerException: order is null"]);
    },
    TIMEOUT,
  );

  test("call to a service that has not been started is service_unavailable", async () => {
    const { services } = setup({ web: DEV });

    await expect(
      services.call({ repo: "web", task: null, method: "GET", path: "/", headers: {}, body: null, timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      code: "service_unavailable",
      message: "the service of web has not been started",
    });
  });

  test(
    "stop with dependencies stops the dependencies the start started, not the ones that were already running",
    async () => {
      const server = { ...DEV, servers: { dev: {} } };
      const { services } = setup({ web: server, api: server, auth: server }, { edges: [http("web", "api"), http("web", "auth")] });
      await services.start({ repo: "auth", task: null, lease: false, dependencies: false, waitMs: 20_000 });
      await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 20_000 });

      const stopped = await services.stop({ repo: "web", task: null, dependencies: true });

      expect(stopped.map((s) => [s.repo, s.state])).toEqual([
        ["web", "stopped"],
        ["api", "stopped"],
      ]);
      expect((await services.list()).find((s) => s.repo === "auth")?.state).toBe("healthy");
    },
    TIMEOUT,
  );

  test(
    "a stop waits for the port of an app a build daemon runs outside the process group to close before it reports stopped",
    async () => {
      const port = await freePort();
      const daemon = await buildDaemon(port, 1500);
      const { services } = setup({ web: { ...DEV, servers: { dev: { buildDaemon: daemon.port } } } }, { cardPorts: { web: port } });
      const started = await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });
      expect(started.members[0]?.service).toMatchObject({ state: "healthy", port });

      const stopped = await services.stop({ repo: "web", task: null, dependencies: false });

      expect(stopped.map((s) => [s.repo, s.state, s.reason])).toEqual([["web", "stopped", null]]);
      expect(await probePort(port)).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a stop whose port still answers after the wait reports the service stopping with why, and a stop after the port closed reports it stopped",
    async () => {
      const port = await freePort();
      const daemon = await buildDaemon(port, null);
      const { services } = setup({ web: { ...DEV, servers: { dev: { buildDaemon: daemon.port } } } }, { cardPorts: { web: port } });
      await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      const stopped = await services.stop({ repo: "web", task: null, dependencies: false });

      expect(stopped.map((s) => [s.state, s.reason])).toEqual([
        [
          "stopping",
          `the process group has ended, but port ${port} still answers: a process outside the service's process group holds it, for example an app Gradle's daemon runs`,
        ],
      ]);
      expect(stopped[0]?.run.kind).toBe("exited");
      const restart = await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });
      expect(restart.members[0]).toMatchObject({
        outcome: "skipped",
        problem: `port ${port} (server.port on the card) still answers after the stop of the service of web`,
      });

      daemon.close();
      const stoppedAgain = await services.stop({ repo: "web", task: null, dependencies: false });
      expect(stoppedAgain.map((s) => [s.repo, s.state, s.reason])).toEqual([["web", "stopped", null]]);
      expect((await services.list()).map((s) => [s.repo, s.state])).toEqual([["web", "stopped"]]);
    },
    TIMEOUT,
  );

  test(
    "stop with dependencies after the root crashed stops the dependency its start started and reports only that one",
    async () => {
      const { services } = setup(
        { web: { ...DEV, servers: { dev: { crash: true } } }, api: { ...DEV, servers: { dev: {} } } },
        { edges: [http("web", "api")] },
      );
      const slice = await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 20_000 });
      expect(slice.members.map((m) => [m.repo, m.service?.state])).toEqual([
        ["api", "healthy"],
        ["web", "crashed"],
      ]);

      const stopped = await services.stop({ repo: "web", task: null, dependencies: true });

      expect(stopped.map((s) => [s.repo, s.state])).toEqual([["api", "stopped"]]);
    },
    TIMEOUT,
  );

  test(
    "stop with dependencies after a start without them also stops the dependencies the earlier start started",
    async () => {
      const server = { ...DEV, servers: { dev: {} } };
      const { services } = setup({ web: server, api: server }, { edges: [http("web", "api")] });
      await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 20_000 });
      await services.stop({ repo: "web", task: null, dependencies: false });
      await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      const stopped = await services.stop({ repo: "web", task: null, dependencies: true });

      expect(stopped.map((s) => [s.repo, s.state])).toEqual([
        ["web", "stopped"],
        ["api", "stopped"],
      ]);
    },
    TIMEOUT,
  );

  test(
    "a start with the other dependencies value while a start is in progress is bad_request",
    async () => {
      const { services } = setup(
        { web: { ...DEV, servers: { dev: {} } }, api: { ...DEV, servers: { dev: { delayMs: 1000 } } } },
        { edges: [http("web", "api")] },
      );
      await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 100 });

      await expect(services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 100 })).rejects.toThrow(
        "a start of web with dependencies is in progress: wait for it or stop it first",
      );
    },
    TIMEOUT,
  );

  test(
    "a stop of one slice leaves a dependency that another slice still starting needs",
    async () => {
      const { services } = setup(
        {
          web: { ...DEV, servers: { dev: {} } },
          shop: { ...DEV, servers: { dev: {} } },
          api: { ...DEV, servers: { dev: { delayMs: 1000 } } },
        },
        { edges: [http("web", "api"), http("shop", "api")] },
      );
      await services.start({ repo: "shop", task: null, lease: false, dependencies: true, waitMs: 100 });
      await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 100 });

      const stopped = await services.stop({ repo: "web", task: null, dependencies: true });

      expect(stopped).toEqual([]);
      const shop = await services.start({ repo: "shop", task: null, lease: false, dependencies: true, waitMs: 20_000 });
      expect(shop.members.map((m) => [m.repo, m.service?.state])).toEqual([
        ["api", "healthy"],
        ["shop", "healthy"],
      ]);
    },
    TIMEOUT,
  );

  test(
    "a dev started from the mise tasks tab is adopted: the list shows it ready on the port from its log",
    async () => {
      const { services, mise } = setup({ web: { ...DEV, servers: { dev: {} } } });
      await mise.start({ repo: "web", task: null }, "dev");

      await waitFor(async () => (await services.list())[0]?.state === "healthy");

      expect((await services.list()).map((s) => [s.repo, s.state, s.portSource])).toEqual([["web", "healthy", "log"]]);
    },
    TIMEOUT,
  );

  test(
    "a stop while the dependencies start cancels the start: the root never starts and the started dependency stops",
    async () => {
      const { services, mise } = setup(
        { web: { ...DEV, servers: { dev: {} } }, api: { ...DEV, servers: { dev: { delayMs: 1000 } } } },
        { edges: [http("web", "api")] },
      );
      const first = await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 300 });
      expect(first.members.map((m) => [m.repo, m.outcome])).toEqual([
        ["api", "started"],
        ["web", "pending"],
      ]);

      const stopped = await services.stop({ repo: "web", task: null, dependencies: true });

      expect(stopped.map((s) => [s.repo, s.state])).toEqual([["api", "stopped"]]);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(mise.run({ repo: "web", task: null }, "dev")).toBeUndefined();
      // A new start after the stop makes a new slice instead of reusing the cancelled one.
      const again = await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 20_000 });
      expect(again.members.map((m) => [m.repo, m.service?.state])).toEqual([
        ["api", "healthy"],
        ["web", "healthy"],
      ]);
    },
    TIMEOUT,
  );

  test(
    "call returns the errors a downstream service logged while it handled the call",
    async () => {
      const { services } = setup(
        { web: { ...DEV, servers: { dev: {} } }, api: { ...DEV, servers: { dev: {} } } },
        { edges: [http("web", "api")] },
      );
      const slice = await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 20_000 });
      const apiPort = slice.members.find((m) => m.repo === "api")?.service?.port;

      const result = await services.call({
        repo: "web",
        task: null,
        method: "GET",
        path: `/forward/${apiPort}/boom`,
        headers: {},
        body: null,
        timeoutMs: 5000,
      });

      expect(result.response?.status).toBe(502);
      expect(result.errors.map((e) => [e.source, e.exception])).toEqual([
        [{ kind: "mise-task", repo: "api", miseTask: "dev" }, "java.lang.NullPointerException: order is null"],
      ]);
    },
    TIMEOUT,
  );
});

describe("services from a task worktree (ADR-61)", () => {
  const TASK = "0b7c1a52-3f0e-4c1e-9a43-5d2f8e6b1c07";
  const TASK_DEV = { ...DEV, servers: { dev: {} } };
  const OTHER = "5d1e9f30-7a2b-4c6d-8e1f-2a3b4c5d6e7f";

  test(
    "a task's service runs from its worktree on the task port, next to the same service from the repo root",
    async () => {
      const port = await freePort();
      const { services } = setup({ web: { ...DEV, servers: { dev: {} } } }, { tasks: { [TASK]: { repo: "web", port, config: TASK_DEV } } });
      await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      const slice = await services.start({ repo: "web", task: TASK, lease: false, dependencies: false, waitMs: 20_000 });

      expect(slice).toMatchObject({ repo: "web", task: TASK, settled: true });
      expect(slice.members[0]?.service).toMatchObject({ repo: "web", task: TASK, state: "healthy", port, portSource: "log" });
      expect((await services.list()).map((s) => [s.repo, s.task, s.state])).toEqual([
        ["web", null, "healthy"],
        ["web", TASK, "healthy"],
      ]);
      const get = { method: "GET", path: "/", headers: {}, body: null, timeoutMs: 5000 } as const;
      const fromTask = await services.call({ repo: "web", task: TASK, ...get });
      const fromRoot = await services.call({ repo: "web", task: null, ...get });
      expect(fromTask.url).toBe(`http://127.0.0.1:${port}/`);
      expect(JSON.parse(fromTask.response?.body ?? "")).toMatchObject({
        cwd: expect.stringMatching(/worktrees.0b7c1a52/),
        port: String(port),
      });
      const root = JSON.parse(fromRoot.response?.body ?? "");
      expect(root.cwd).toMatch(/web$/);
      expect(root.port).not.toBe(String(port));

      await services.stop({ repo: "web", task: TASK, dependencies: false });
      expect((await services.list()).map((s) => [s.task, s.state])).toEqual([
        [null, "healthy"],
        [TASK, "stopped"],
      ]);
    },
    TIMEOUT,
  );

  test(
    "a task's service with dependencies starts them from their repo roots and itself from the worktree",
    async () => {
      const port = await freePort();
      const { services } = setup(
        { web: { ...DEV, servers: { dev: {} } }, api: { ...DEV, servers: { dev: {} } } },
        { edges: [http("web", "api")], tasks: { [TASK]: { repo: "web", port, config: TASK_DEV } } },
      );

      const slice = await services.start({ repo: "web", task: TASK, lease: false, dependencies: true, waitMs: 20_000 });

      expect(slice.members.map((m) => [m.repo, m.task, m.outcome, m.service?.state ?? null])).toEqual([
        ["api", null, "started", "healthy"],
        ["web", TASK, "started", "healthy"],
      ]);
      const stopped = await services.stop({ repo: "web", task: TASK, dependencies: true });
      expect(stopped.map((s) => [s.repo, s.task, s.state])).toEqual([
        ["web", TASK, "stopped"],
        ["api", null, "stopped"],
      ]);
    },
    TIMEOUT,
  );

  test(
    "a task port another program already listens on skips the task's service with the reason",
    async () => {
      const other: Server = createServer((_, res) => res.end("other"));
      await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise((resolve) => other.close(resolve)));
      const { port } = other.address() as AddressInfo;
      const { services } = setup({ web: { ...DEV, servers: { dev: {} } } }, { tasks: { [TASK]: { repo: "web", port, config: TASK_DEV } } });

      const slice = await services.start({ repo: "web", task: TASK, lease: false, dependencies: false, waitMs: 20_000 });

      expect(slice.members[0]).toMatchObject({
        outcome: "skipped",
        problem: `port ${port} (the task port) is already in use by a program Trackwall did not start`,
      });
    },
    TIMEOUT,
  );

  test("a task that is not in the repo is refused before anything starts", async () => {
    const { services } = setup({ web: DEV, api: DEV }, { tasks: { [TASK]: { repo: "api", port: 41000, config: TASK_DEV } } });

    const start = services.start({ repo: "web", task: TASK, lease: false, dependencies: false, waitMs: 1000 });

    await expect(start).rejects.toMatchObject({ code: "bad_request", message: `task ${TASK} is in api, not in web` });
    expect(await services.list()).toEqual([]);
  });

  test(
    "a task's service on a lease takes the root's port, and the root's service starts again once it stops",
    async () => {
      const rootPort = await freePort();
      const { services } = setup(
        { web: { ...DEV, servers: { dev: { port: rootPort } } } },
        { cardPorts: { web: rootPort }, tasks: { [TASK]: { repo: "web", port: await freePort(), config: TASK_DEV } } },
      );
      const before = await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      const slice = await services.start({ repo: "web", task: TASK, lease: true, dependencies: false, waitMs: 20_000 });

      expect(slice.members[0]?.service).toMatchObject({ repo: "web", task: TASK, lease: true, state: "healthy", port: rootPort });
      expect((await services.list()).map((s) => [s.task, s.lease, s.state])).toEqual([
        [null, false, "stopped"],
        [TASK, true, "healthy"],
      ]);
      const reached = await services.call({ repo: "web", task: TASK, method: "GET", path: "/", headers: {}, body: null, timeoutMs: 5000 });
      expect(reached.url).toBe(`http://127.0.0.1:${rootPort}/`);
      expect(JSON.parse(reached.response?.body ?? "")).toMatchObject({ cwd: expect.stringMatching(/worktrees.0b7c1a52/) });

      await services.stop({ repo: "web", task: TASK, dependencies: false });
      await waitFor(async () => (await services.list()).some((s) => s.task === null && s.state === "healthy"));
      const root = (await services.list()).find((s) => s.task === null);
      expect(root).toMatchObject({ port: rootPort, lease: false });
      expect(root?.run.runId).not.toBe(before.members[0]?.service?.run.runId ?? "");
    },
    TIMEOUT,
  );

  test(
    "while a task holds the lease, the root's service is refused and a slice that calls the repo takes the task's service",
    async () => {
      const apiPort = await freePort();
      const { services } = setup(
        { web: { ...DEV, servers: { dev: {} } }, api: { ...DEV, servers: { dev: {} } } },
        {
          edges: [http("web", "api")],
          cardPorts: { api: apiPort },
          tasks: { [TASK]: { repo: "api", port: await freePort(), config: TASK_DEV } },
        },
      );
      await services.start({ repo: "api", task: TASK, lease: true, dependencies: false, waitMs: 20_000 });

      const root = services.start({ repo: "api", task: null, lease: false, dependencies: false, waitMs: 0 });
      await expect(root).rejects.toMatchObject({
        code: "bad_request",
        message: `port ${apiPort} of api is leased to the service of task ${TASK}: stop that service, which gives the port back`,
      });
      const slice = await services.start({ repo: "web", task: null, lease: false, dependencies: true, waitMs: 20_000 });

      expect(slice.members.map((m) => [m.repo, m.task, m.outcome, m.problem, m.service?.port ?? null])).toEqual([
        ["api", TASK, "running", null, apiPort],
        ["web", null, "started", null, expect.any(Number)],
      ]);
      // The root's service did not run before the lease, so it does not start when the lease ends.
      await services.stop({ repo: "api", task: TASK, dependencies: false });
      expect((await services.list()).filter((s) => s.repo === "api").map((s) => [s.task, s.state])).toEqual([[TASK, "stopped"]]);
      await services.start({ repo: "api", task: null, lease: false, dependencies: false, waitMs: 20_000 });
    },
    TIMEOUT,
  );

  test(
    "a crash of the task's service on the lease gives the port back, and the root's service starts again",
    async () => {
      const rootPort = await freePort();
      const { services } = setup(
        { web: { ...DEV, servers: { dev: { port: rootPort } } } },
        {
          cardPorts: { web: rootPort },
          tasks: { [TASK]: { repo: "web", port: await freePort(), config: { ...DEV, servers: { dev: { crash: true } } } } },
        },
      );
      await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });

      const slice = await services.start({ repo: "web", task: TASK, lease: true, dependencies: false, waitMs: 20_000 });

      expect(slice.members[0]?.service).toMatchObject({ task: TASK, lease: true, state: "crashed" });
      await waitFor(async () => (await services.list()).some((s) => s.task === null && s.state === "healthy"));
      const again = await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 0 });
      expect(again.members[0]?.outcome).toBe("running");
    },
    TIMEOUT,
  );

  test(
    "a lease is refused, with the root's service left running, while the task's service runs on the task port or another task holds the port",
    async () => {
      const rootPort = await freePort();
      const { services } = setup(
        { web: { ...DEV, servers: { dev: { port: rootPort } } } },
        {
          cardPorts: { web: rootPort },
          tasks: {
            [TASK]: { repo: "web", port: await freePort(), config: TASK_DEV },
            [OTHER]: { repo: "web", port: await freePort(), config: TASK_DEV },
          },
        },
      );
      await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });
      await services.start({ repo: "web", task: TASK, lease: false, dependencies: false, waitMs: 20_000 });

      const onTaskPort = services.start({ repo: "web", task: TASK, lease: true, dependencies: false, waitMs: 0 });
      await expect(onTaskPort).rejects.toMatchObject({
        code: "bad_request",
        message: `the service of task ${TASK} in web runs or starts on the task port: stop it first, then start it on the port of web`,
      });
      expect((await services.list()).find((s) => s.task === null)?.state).toBe("healthy");

      await services.stop({ repo: "web", task: TASK, dependencies: false });
      await services.start({ repo: "web", task: TASK, lease: true, dependencies: false, waitMs: 20_000 });
      const other = services.start({ repo: "web", task: OTHER, lease: true, dependencies: false, waitMs: 0 });
      await expect(other).rejects.toMatchObject({
        code: "bad_request",
        message: `port ${rootPort} of web is leased to the service of task ${TASK}: stop that service, which gives the port back`,
      });
    },
    TIMEOUT,
  );

  test(
    "a lease is refused while the root's service is starting, and the start goes on",
    async () => {
      const rootPort = await freePort();
      const { services } = setup(
        { web: { ...DEV, servers: { dev: { port: rootPort, delayMs: 1500 } } } },
        { cardPorts: { web: rootPort }, tasks: { [TASK]: { repo: "web", port: await freePort(), config: TASK_DEV } } },
      );
      await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 0 });

      const lease = services.start({ repo: "web", task: TASK, lease: true, dependencies: false, waitMs: 0 });

      await expect(lease).rejects.toMatchObject({
        code: "bad_request",
        message: "a start of web is in progress: wait for it or stop it first",
      });
      await waitFor(async () => (await services.list()).some((s) => s.task === null && s.state === "healthy"));
    },
    TIMEOUT,
  );

  test(
    "a slice that needs the repo while the task's service waits for its own dependencies joins that start, and the lease goes on",
    async () => {
      const webPort = await freePort();
      const { services } = setup(
        {
          api: { ...DEV, servers: { dev: { delayMs: 1500 } } },
          web: { ...DEV, servers: { dev: { port: webPort } } },
          front: { ...DEV, servers: { dev: {} } },
        },
        {
          edges: [http("web", "api"), http("front", "web")],
          cardPorts: { web: webPort },
          tasks: { [TASK]: { repo: "web", port: await freePort(), config: TASK_DEV } },
        },
      );
      await services.start({ repo: "web", task: null, lease: false, dependencies: false, waitMs: 20_000 });
      const leased = services.start({ repo: "web", task: TASK, lease: true, dependencies: true, waitMs: 20_000 });
      await waitFor(async () => (await services.list()).some((s) => s.repo === "api" && s.state === "starting"));

      const front = await services.start({ repo: "front", task: null, lease: false, dependencies: true, waitMs: 20_000 });

      expect(front.members.map((m) => [m.repo, m.task, m.outcome, m.problem])).toEqual([
        ["api", null, "running", null],
        ["web", TASK, "started", null],
        ["front", null, "started", null],
      ]);
      const slice = await leased;
      expect(slice.members.at(-1)?.service).toMatchObject({ task: TASK, lease: true, state: "healthy", port: webPort });
    },
    TIMEOUT,
  );

  test("a lease is refused for a repo without a single known port, and for a repo root", async () => {
    const { services } = setup({ web: DEV }, { tasks: { [TASK]: { repo: "web", port: 41000, config: TASK_DEV } } });

    const lease = services.start({ repo: "web", task: TASK, lease: true, dependencies: false, waitMs: 0 });

    await expect(lease).rejects.toMatchObject({
      code: "bad_request",
      message: "web has no single port a task's service could take: no server.port on its card and its service is not running",
    });
    const fromRoot = services.start({ repo: "web", task: null, lease: true, dependencies: false, waitMs: 0 });
    await expect(fromRoot).rejects.toMatchObject({
      code: "bad_request",
      message: "only a task's service can take the repo's port: give the task",
    });
    expect(await services.list()).toEqual([]);
  });

  test(
    "the list keeps a running service of an ended task and forgets it once it has stopped",
    async () => {
      const port = await freePort();
      const { services, tasks } = setup({ web: DEV }, { tasks: { [TASK]: { repo: "web", port, config: TASK_DEV } } });
      await services.start({ repo: "web", task: TASK, lease: false, dependencies: false, waitMs: 20_000 });

      delete tasks[TASK];

      expect((await services.list()).map((s) => [s.task, s.state])).toEqual([[TASK, "healthy"]]);
      await services.stop({ repo: "web", task: TASK, dependencies: false });
      expect(await services.list()).toEqual([]);
    },
    TIMEOUT,
  );
});

/** A port nothing listens on right now, as `agents` hands out a task port. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > until) throw new Error("condition not met within 20 s");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
