import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphEdge, RepoCardResult, RepoGraph } from "@trackwall/protocol";
import { DomainError } from "../src/infra/errors.ts";
import { Logs } from "../src/modules/logs/logs.ts";
import { Mise } from "../src/modules/mise/mise.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { Services } from "../src/modules/services/services.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";

/** These tests run mise tasks in repo roots only, never in a task worktree (ADR-59). */
const NO_TASKS = {
  taskCheckout: async () => {
    throw new Error("no task worktree in this test");
  },
};

const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const TIMEOUT = 60_000;
const SECRET = "s3cr3t-token-value";

/** Repos with a fake mise config each (`fixtures/fake-mise.ts`, `servers` runs `fixtures/fake-service.ts`). */
function setup(repos: Record<string, object>, opts: { edges?: GraphEdge[]; cardPorts?: Record<string, number> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-services-"));
  for (const [id, config] of Object.entries(repos)) {
    mkdirSync(join(home, id));
    writeFileSync(join(home, id, "fake-mise.json"), JSON.stringify(config));
  }
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
  const mise = new Mise({ procs, repos: { repoPath }, tasks: NO_TASKS, command: FAKE_MISE, env });
  const graph = { graph: async () => ({ nodes: [], edges: opts.edges ?? [], configProblems: [], configFile: "" }) as RepoGraph };
  const cards = {
    card: async (repo: string) => {
      const port = opts.cardPorts?.[repo];
      const provides = port ? [{ kind: "app", name: repo, port, module: "", evidence: { file: "application.yml", line: 1 } }] : [];
      return { repo, card: { provides }, tags: [] } as unknown as RepoCardResult;
    },
  };
  const services = new Services({ mise, logs, graph, cards, env, intervalMs: 100, startupMs: 1500, settleMs: 300 });
  cleanups.push(() => procs.stopAll());
  return { services, procs, mise };
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function http(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    kind: "http",
    key: `${to}-app`,
    confidence: "high",
    evidence: [{ repo: from, path: "a.yml", line: 1, detail: "calls" }],
  };
}

const DEV = { tasks: [{ name: "dev" }] };

describe("services (real process groups, fake mise and fake service)", () => {
  test(
    "start brings the dependency up first, each is healthy on the port from its log, the root last",
    async () => {
      const { services } = setup(
        { web: { ...DEV, servers: { dev: {} } }, api: { ...DEV, servers: { dev: { delayMs: 400 } } }, docs: { tasks: [] } },
        { edges: [http("web", "api"), http("web", "docs")] },
      );

      const slice = await services.start({ repo: "web", dependencies: true, waitMs: 20_000 });

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
      const first = await services.start({ repo: "web", dependencies: false, waitMs: 20_000 });

      const second = await services.start({ repo: "web", dependencies: false, waitMs: 20_000 });

      expect(second.members[0]?.outcome).toBe("running");
      expect(second.members[0]?.service?.run.runId).toBe(first.members[0]?.service?.run.runId ?? "");
    },
    TIMEOUT,
  );

  test(
    "a service that exits by itself is crashed, with the errors from its log",
    async () => {
      const { services } = setup({ web: { ...DEV, servers: { dev: { crash: true } } } });

      const slice = await services.start({ repo: "web", dependencies: false, waitMs: 20_000 });

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

      const slice = await services.start({ repo: "web", dependencies: false, waitMs: 20_000 });

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

      const slice = await services.start({ repo: "web", dependencies: false, waitMs: 20_000 });

      expect(slice.members[0]).toMatchObject({
        outcome: "skipped",
        problem: `port ${port} (server.port on the card) is already in use by a program Trackwall did not start`,
      });
    },
    TIMEOUT,
  );

  test("a repo without the mise task dev is not_found before anything starts", async () => {
    const { services } = setup({ web: { tasks: [{ name: "build" }] } });

    await expect(services.start({ repo: "web", dependencies: true, waitMs: 0 })).rejects.toMatchObject({ code: "not_found" });
    expect(await services.list()).toEqual([]);
  });

  test(
    "call returns the response with the secret masked, and errors the service logged during the call",
    async () => {
      const { services } = setup({ web: { ...DEV, servers: { dev: {} } } });
      await services.start({ repo: "web", dependencies: false, waitMs: 20_000 });

      const ok = await services.call({
        repo: "web",
        method: "POST",
        path: "/api/orders?x=1",
        headers: {},
        body: '{"n":1}',
        timeoutMs: 5000,
      });
      expect(ok.response?.status).toBe(200);
      expect(JSON.parse(ok.response?.body ?? "")).toEqual({ method: "POST", path: "/api/orders?x=1", body: '{"n":1}', token: "***" });
      expect(ok.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/orders\?x=1$/);
      expect(ok.errors).toEqual([]);

      const boom = await services.call({ repo: "web", method: "GET", path: "/boom", headers: {}, body: null, timeoutMs: 5000 });
      expect(boom.response?.status).toBe(500);
      expect(boom.errors.map((e) => e.exception)).toEqual(["java.lang.NullPointerException: order is null"]);
    },
    TIMEOUT,
  );

  test("call to a service that has not been started is service_unavailable", async () => {
    const { services } = setup({ web: DEV });

    await expect(services.call({ repo: "web", method: "GET", path: "/", headers: {}, body: null, timeoutMs: 1000 })).rejects.toMatchObject({
      code: "service_unavailable",
      message: "the service of web has not been started",
    });
  });

  test(
    "stop with dependencies stops the dependencies the start started, not the ones that were already running",
    async () => {
      const server = { ...DEV, servers: { dev: {} } };
      const { services } = setup({ web: server, api: server, auth: server }, { edges: [http("web", "api"), http("web", "auth")] });
      await services.start({ repo: "auth", dependencies: false, waitMs: 20_000 });
      await services.start({ repo: "web", dependencies: true, waitMs: 20_000 });

      const stopped = await services.stop({ repo: "web", dependencies: true });

      expect(stopped.map((s) => [s.repo, s.state])).toEqual([
        ["web", "stopped"],
        ["api", "stopped"],
      ]);
      expect((await services.list()).find((s) => s.repo === "auth")?.state).toBe("healthy");
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
      const slice = await services.start({ repo: "web", dependencies: true, waitMs: 20_000 });
      expect(slice.members.map((m) => [m.repo, m.service?.state])).toEqual([
        ["api", "healthy"],
        ["web", "crashed"],
      ]);

      const stopped = await services.stop({ repo: "web", dependencies: true });

      expect(stopped.map((s) => [s.repo, s.state])).toEqual([["api", "stopped"]]);
    },
    TIMEOUT,
  );

  test(
    "stop with dependencies after a start without them also stops the dependencies the earlier start started",
    async () => {
      const server = { ...DEV, servers: { dev: {} } };
      const { services } = setup({ web: server, api: server }, { edges: [http("web", "api")] });
      await services.start({ repo: "web", dependencies: true, waitMs: 20_000 });
      await services.stop({ repo: "web", dependencies: false });
      await services.start({ repo: "web", dependencies: false, waitMs: 20_000 });

      const stopped = await services.stop({ repo: "web", dependencies: true });

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
      await services.start({ repo: "web", dependencies: true, waitMs: 100 });

      await expect(services.start({ repo: "web", dependencies: false, waitMs: 100 })).rejects.toThrow(
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
      await services.start({ repo: "shop", dependencies: true, waitMs: 100 });
      await services.start({ repo: "web", dependencies: true, waitMs: 100 });

      const stopped = await services.stop({ repo: "web", dependencies: true });

      expect(stopped).toEqual([]);
      const shop = await services.start({ repo: "shop", dependencies: true, waitMs: 20_000 });
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
      const first = await services.start({ repo: "web", dependencies: true, waitMs: 300 });
      expect(first.members.map((m) => [m.repo, m.outcome])).toEqual([
        ["api", "started"],
        ["web", "pending"],
      ]);

      const stopped = await services.stop({ repo: "web", dependencies: true });

      expect(stopped.map((s) => [s.repo, s.state])).toEqual([["api", "stopped"]]);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(mise.run({ repo: "web", task: null }, "dev")).toBeUndefined();
      // A new start after the stop makes a new slice instead of reusing the cancelled one.
      const again = await services.start({ repo: "web", dependencies: true, waitMs: 20_000 });
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
      const slice = await services.start({ repo: "web", dependencies: true, waitMs: 20_000 });
      const apiPort = slice.members.find((m) => m.repo === "api")?.service?.port;

      const result = await services.call({
        repo: "web",
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

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > until) throw new Error("condition not met within 20 s");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
