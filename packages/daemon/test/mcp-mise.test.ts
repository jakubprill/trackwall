import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { ListRunningMiseTasksResult, LogTail, MiseTaskRunResult } from "@trackwall/protocol";
import { z } from "zod";
import { SESSION_TOKEN_HEADER } from "../src/mcp/endpoint.ts";
import { waitFor } from "./support/agents.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "t".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
/** Fake mise config (see `fixtures/fake-mise.ts`): `dev` runs until stopped, `test` exits with code 3. */
const MISE_CONFIG = JSON.stringify({ tasks: [{ name: "dev" }, { name: "test" }], exits: { test: 3 } });
const TIMEOUT = 60_000;

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** An agent outside Trackwall: only the daemon token, no session token. */
let outside: Client;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { sklep: { "fake-mise.json": MISE_CONFIG }, magazyn: { "fake-mise.json": MISE_CONFIG } },
    miseCommand: FAKE_MISE,
  });
  outside = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(outside);
});

// A limit instead of none: a cleanup that hangs on Windows should fail this file, not take an hour of the job.
afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

/** The tool error text (`<code>: <message>`); a result without an error fails the test. */
function errorText(result: Awaited<ReturnType<typeof call>>): string {
  expect(result.isError).toBe(true);
  const [first] = z.array(z.object({ text: z.string() })).parse(result.content);
  return first?.text ?? "";
}

describe("mise tasks over MCP (real process groups, fake mise)", () => {
  test(
    "run_mise_task runs a listed task, wait_for_mise_task returns its exit code and tail the output of that run",
    async () => {
      const started = MiseTaskRunResult.parse(
        (await call(outside, "run_mise_task", { repo: "sklep", miseTask: "test" })).structuredContent,
      );

      const ended = MiseTaskRunResult.parse(
        (await call(outside, "wait_for_mise_task", { repo: "sklep", miseTask: "test", timeoutSeconds: 20 })).structuredContent,
      );
      expect(ended.run).toMatchObject({ kind: "exited", runId: started.run.runId, exitCode: 3, stoppedByUser: false });

      const log = LogTail.parse((await call(outside, "tail", { repo: "sklep", miseTask: "test", limit: 10 })).structuredContent);
      expect(log.records.map((r) => [r.runId, r.msg])).toContainEqual([started.run.runId, "[test] $ koniec"]);
    },
    TIMEOUT,
  );

  test(
    "a running task: the wait ends at the timeout with running, the list shows it and stop_mise_task stops the group",
    async () => {
      const started = MiseTaskRunResult.parse((await call(outside, "run_mise_task", { repo: "sklep", miseTask: "dev" })).structuredContent);
      const again = MiseTaskRunResult.parse((await call(outside, "run_mise_task", { repo: "sklep", miseTask: "dev" })).structuredContent);
      // The second call does not start a second group; it returns the running one.
      expect(again.run.runId).toBe(started.run.runId);

      const waited = MiseTaskRunResult.parse(
        (await call(outside, "wait_for_mise_task", { repo: "sklep", miseTask: "dev", timeoutSeconds: 1 })).structuredContent,
      );
      expect(waited.run).toMatchObject({ kind: "running", runId: started.run.runId });
      const running = ListRunningMiseTasksResult.parse((await call(outside, "list_running_mise_tasks", {})).structuredContent);
      expect(running.miseTasks.map((t) => [t.repo, t.miseTask, t.run.runId])).toEqual([["sklep", "dev", started.run.runId]]);

      const stopped = MiseTaskRunResult.parse(
        (await call(outside, "stop_mise_task", { repo: "sklep", miseTask: "dev" })).structuredContent,
      );
      expect(stopped.run).toMatchObject({ kind: "exited", runId: started.run.runId, stoppedByUser: true });
      expect(ListRunningMiseTasksResult.parse((await call(outside, "list_running_mise_tasks", {})).structuredContent)).toEqual({
        miseTasks: [],
      });
    },
    TIMEOUT,
  );

  test("a task not on the mise list is not_found and nothing runs", async () => {
    expect(errorText(await call(outside, "run_mise_task", { repo: "magazyn", miseTask: "deploy" }))).toBe(
      'not_found: repo magazyn has no mise task "deploy"',
    );
    expect(existsSync(join(daemon.projects, "magazyn", "calls.log"))).toBe(false);
  });

  test("waiting for and stopping a task that has not been run is not_found", async () => {
    expect(errorText(await call(outside, "wait_for_mise_task", { repo: "magazyn", miseTask: "dev", timeoutSeconds: 1 }))).toBe(
      'not_found: mise task "dev" in magazyn has not been run',
    );
    expect(errorText(await call(outside, "stop_mise_task", { repo: "magazyn", miseTask: "dev" }))).toBe(
      'not_found: mise task "dev" in magazyn has not been run',
    );
  });

  test("an untrusted mise config runs no task, and there is no tool that would trust it", async () => {
    const config = join(daemon.projects, "magazyn", "fake-mise.json");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(MISE_CONFIG), untrusted: true }));
    try {
      expect(errorText(await call(outside, "run_mise_task", { repo: "magazyn", miseTask: "test" }))).toStartWith(
        "mise_unavailable: mise ERROR Config files in",
      );
      expect(existsSync(join(daemon.projects, "magazyn", "calls.log"))).toBe(false);
      const { tools } = await outside.listTools();
      expect(tools.map((t) => t.name).filter((name) => name.includes("trust"))).toEqual([]);
    } finally {
      writeFileSync(config, MISE_CONFIG);
    }
  });
});

describe.skipIf(process.versions.bun === undefined)("mise tasks from a Trackwall session (real PTY, fake Copilot CLI)", () => {
  test(
    "a session runs and stops mise tasks only of its own repo",
    async () => {
      const session = await daemon.facade.agents.start("magazyn");
      const token = readFileSync(join(daemon.home, "sessions", session.id, "session-token"), "utf8");
      const client = await connectHttpClient(daemon.api.port, TOKEN, undefined, { [SESSION_TOKEN_HEADER]: token });
      clients.push(client);

      expect(errorText(await call(client, "run_mise_task", { repo: "sklep", miseTask: "test" }))).toBe(
        "bad_request: a session in magazyn can run and stop only mise tasks of magazyn, not of sklep",
      );
      expect(errorText(await call(client, "stop_mise_task", { repo: "sklep", miseTask: "dev" }))).toStartWith("bad_request:");
      const own = MiseTaskRunResult.parse((await call(client, "run_mise_task", { repo: "magazyn", miseTask: "test" })).structuredContent);
      const ended = MiseTaskRunResult.parse(
        (await call(client, "wait_for_mise_task", { repo: "magazyn", miseTask: "test", timeoutSeconds: 20 })).structuredContent,
      );
      expect(ended.run).toMatchObject({ kind: "exited", runId: own.run.runId, exitCode: 3 });
      // Stopped only after its sessionStart: killing a process in ConPTY while it starts could crash Bun on Windows.
      await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "sessionStart");
      await daemon.facade.agents.stop(session.id);
    },
    TIMEOUT,
  );
});
