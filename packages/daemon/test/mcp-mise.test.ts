import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, GetRepoResult, ListRunningMiseTasksResult, LogTail, MiseTaskRunResult, miseApi } from "@trackwall/protocol";
import { z } from "zod";
import { viewer, waitFor } from "./support/agents.ts";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { untilInputBox } from "./support/screen-lines.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "t".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
/** Fake mise config (see `fixtures/fake-mise.ts`): `dev` runs until stopped, `test` exits with code 3. */
const MISE_CONFIG = JSON.stringify({ tasks: [{ name: "dev" }, { name: "test" }], exits: { test: 3 } });
const TIMEOUT = 60_000;
/** The fake's prompt line for the typed notice that the user trusted the mise config (ADR-92). */
const TYPED_TRUST_NOTICE = "Thinking about: The user trusted the mise config that refused your last run_mise_task";
/** The fake's prompt line for the typed review prompt. */
const TYPED_REVIEW = "Thinking about: The user sent a review of your changes in Trackwall";

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** An agent outside Trackwall: only the daemon token, no session token. */
let outside: Client;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "fake-mise.json": MISE_CONFIG }, warehouse: { "fake-mise.json": MISE_CONFIG }, billing: { "mise.toml": "" } },
    miseCommand: FAKE_MISE,
  });
  outside = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(outside);
}, SLOW_TEST_TIMEOUT_MS);

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
      const started = MiseTaskRunResult.parse((await call(outside, "run_mise_task", { repo: "shop", miseTask: "test" })).structuredContent);

      const ended = MiseTaskRunResult.parse(
        (await call(outside, "wait_for_mise_task", { repo: "shop", miseTask: "test", timeoutSeconds: 20 })).structuredContent,
      );
      expect(ended.run).toMatchObject({ kind: "exited", runId: started.run.runId, exitCode: 3, stoppedByUser: false });

      const log = LogTail.parse((await call(outside, "tail", { repo: "shop", miseTask: "test", limit: 10 })).structuredContent);
      expect(log.records.map((r) => [r.runId, r.msg])).toContainEqual([started.run.runId, "[test] $ done"]);
    },
    TIMEOUT,
  );

  test(
    "a running task: the wait ends at the timeout with running, the list shows it and stop_mise_task stops the group",
    async () => {
      const started = MiseTaskRunResult.parse((await call(outside, "run_mise_task", { repo: "shop", miseTask: "dev" })).structuredContent);
      const again = MiseTaskRunResult.parse((await call(outside, "run_mise_task", { repo: "shop", miseTask: "dev" })).structuredContent);
      // The second call does not start a second group; it returns the running one.
      expect(again.run.runId).toBe(started.run.runId);

      const waited = MiseTaskRunResult.parse(
        (await call(outside, "wait_for_mise_task", { repo: "shop", miseTask: "dev", timeoutSeconds: 1 })).structuredContent,
      );
      expect(waited.run).toMatchObject({ kind: "running", runId: started.run.runId });
      const running = ListRunningMiseTasksResult.parse((await call(outside, "list_running_mise_tasks", {})).structuredContent);
      expect(running.miseTasks.map((t) => [t.repo, t.miseTask, t.run.runId])).toEqual([["shop", "dev", started.run.runId]]);

      const stopped = MiseTaskRunResult.parse((await call(outside, "stop_mise_task", { repo: "shop", miseTask: "dev" })).structuredContent);
      expect(stopped.run).toMatchObject({ kind: "exited", runId: started.run.runId, stoppedByUser: true });
      expect(ListRunningMiseTasksResult.parse((await call(outside, "list_running_mise_tasks", {})).structuredContent)).toEqual({
        miseTasks: [],
      });
    },
    TIMEOUT,
  );

  test("get_repo says for each mise task whether the repo's git, a local file or a config outside the repo defines it", async () => {
    const billing = join(daemon.projects, "billing");
    writeFileSync(join(billing, "mise.local.toml"), "");
    // A config above the repo, as the user's global one is.
    const global = join(daemon.projects, ".global-mise.toml");
    writeFileSync(global, "");
    writeFileSync(
      join(billing, "fake-mise.json"),
      JSON.stringify({
        tasks: [
          { name: "build", source: join(billing, "mise.toml") },
          { name: "dev", source: join(billing, "mise.local.toml") },
          { name: "notes", source: global },
        ],
      }),
    );

    const repo = GetRepoResult.parse((await call(outside, "get_repo", { repo: "billing" })).structuredContent);

    expect(repo.miseTasks.kind === "ok" && repo.miseTasks.tasks.map((t) => [t.name, t.origin, t.source])).toEqual([
      ["build", "repo", "mise.toml"],
      ["dev", "local", "mise.local.toml"],
      ["notes", "outside", global],
    ]);
  });

  test("a task not on the mise list is not_found and nothing runs", async () => {
    expect(errorText(await call(outside, "run_mise_task", { repo: "warehouse", miseTask: "deploy" }))).toBe(
      'not_found: repo warehouse has no mise task "deploy"',
    );
    expect(existsSync(join(daemon.projects, "warehouse", "calls.log"))).toBe(false);
  });

  test("waiting for and stopping a task that has not been run is not_found", async () => {
    expect(errorText(await call(outside, "wait_for_mise_task", { repo: "warehouse", miseTask: "dev", timeoutSeconds: 1 }))).toBe(
      'not_found: mise task "dev" in warehouse has not been run',
    );
    expect(errorText(await call(outside, "stop_mise_task", { repo: "warehouse", miseTask: "dev" }))).toBe(
      'not_found: mise task "dev" in warehouse has not been run',
    );
  });

  test("an untrusted mise config runs no task, and there is no tool that would trust it", async () => {
    const config = join(daemon.projects, "warehouse", "fake-mise.json");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(MISE_CONFIG), untrusted: true }));
    try {
      expect(errorText(await call(outside, "run_mise_task", { repo: "warehouse", miseTask: "test" }))).toStartWith(
        "mise_unavailable: mise ERROR Config files in",
      );
      expect(existsSync(join(daemon.projects, "warehouse", "calls.log"))).toBe(false);
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
      const session = await daemon.facade.agents.start("warehouse");
      const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, session.id);
      clients.push(client);

      expect(errorText(await call(client, "run_mise_task", { repo: "shop", miseTask: "test" }))).toBe(
        "bad_request: a session in warehouse can run and stop only mise tasks of warehouse, not of shop",
      );
      expect(errorText(await call(client, "stop_mise_task", { repo: "shop", miseTask: "dev" }))).toStartWith("bad_request:");
      const own = MiseTaskRunResult.parse((await call(client, "run_mise_task", { repo: "warehouse", miseTask: "test" })).structuredContent);
      const ended = MiseTaskRunResult.parse(
        (await call(client, "wait_for_mise_task", { repo: "warehouse", miseTask: "test", timeoutSeconds: 20 })).structuredContent,
      );
      expect(ended.run).toMatchObject({ kind: "exited", runId: own.run.runId, exitCode: 3 });
      // Stopped only after its first state: killing a process in ConPTY while it starts could crash Bun on Windows.
      await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "the first state");
      await daemon.facade.agents.stop(session.id);
    },
    TIMEOUT,
  );

  test(
    "a task session runs mise tasks in its own worktree, reads their log, and cannot run them in another task's worktree",
    async () => {
      const own = await daemon.facade.agents.createTask("warehouse", "run the tests");
      const other = await daemon.facade.agents.createTask("warehouse", "another task");
      const sessions = daemon.facade.agents.sessions().sessions.filter((s) => s.task === own.id || s.task === other.id);
      const session = sessions.find((s) => s.task === own.id);
      if (!session) throw new Error("the task has no session");
      const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, session.id);
      clients.push(client);

      const started = MiseTaskRunResult.parse(
        (await call(client, "run_mise_task", { repo: "warehouse", task: own.id, miseTask: "test" })).structuredContent,
      );
      const ended = MiseTaskRunResult.parse(
        (await call(client, "wait_for_mise_task", { repo: "warehouse", task: own.id, miseTask: "test", timeoutSeconds: 20 }))
          .structuredContent,
      );
      expect(ended.run).toMatchObject({ kind: "exited", runId: started.run.runId, exitCode: 3 });
      expect(readFileSync(join(own.worktree, "calls.log"), "utf8")).toBe("run test\n");
      const log = LogTail.parse(
        (await call(client, "tail", { repo: "warehouse", task: own.id, miseTask: "test", limit: 10 })).structuredContent,
      );
      expect(log.records.map((r) => [r.runId, r.msg])).toEqual([[started.run.runId, "[test] $ done"]]);

      expect(errorText(await call(client, "run_mise_task", { repo: "warehouse", task: other.id, miseTask: "test" }))).toBe(
        `bad_request: a session of task ${own.id} can run and stop only mise tasks of its own worktree, not of that of task ${other.id}`,
      );
      expect(existsSync(join(other.worktree, "calls.log"))).toBe(false);
      // A task named with another repo is refused before any run is looked up, so a session's repo gate holds.
      expect(errorText(await call(outside, "stop_mise_task", { repo: "shop", task: own.id, miseTask: "test" }))).toBe(
        `bad_request: task ${own.id} is in warehouse, not in shop`,
      );

      for (const s of sessions) {
        await waitFor(daemon.facade.agents, s.id, (state) => state.state !== null, "the first state");
        await daemon.facade.agents.stop(s.id);
      }
    },
    TIMEOUT,
  );

  test(
    "a mise config the agent changed in a task worktree runs nothing until the user trusts the config they saw in the UI",
    async () => {
      const task = await daemon.facade.agents.createTask("warehouse", "change the build");
      writeFileSync(join(task.worktree, "mise.toml"), '[tasks.test]\nrun = "anything"\n');

      expect(errorText(await call(outside, "run_mise_task", { repo: "warehouse", task: task.id, miseTask: "test" }))).toBe(
        `mise_unavailable: the mise config in the worktree of task ${task.branch} changed since the user trusted it (mise.toml); ` +
          "only the user can trust it, in the task's panel in Trackwall, and a session in Trackwall refused for it is told when they do",
      );
      expect(existsSync(join(task.worktree, "calls.log"))).toBe(false);

      const seen = await daemon.post(agentsApi.taskMiseConfig, { task: task.id });
      expect(seen.changes).toEqual([{ path: "mise.toml", change: "added", content: '[tasks.test]\nrun = "anything"\n' }]);
      await daemon.post(agentsApi.trustTaskMiseConfig, { task: task.id, digest: seen.digest });
      await call(outside, "run_mise_task", { repo: "warehouse", task: task.id, miseTask: "test" });
      const ended = MiseTaskRunResult.parse(
        (await call(outside, "wait_for_mise_task", { repo: "warehouse", task: task.id, miseTask: "test", timeoutSeconds: 20 }))
          .structuredContent,
      );
      expect(ended.run).toMatchObject({ kind: "exited", exitCode: 3 });
      expect(readFileSync(join(task.worktree, "calls.log"), "utf8")).toBe("run test\n");

      const [session] = daemon.facade.agents.sessions().sessions.filter((s) => s.task === task.id);
      if (!session) throw new Error("the task has no session");
      await waitFor(daemon.facade.agents, session.id, (state) => state.state !== null, "the first state");
      await daemon.facade.agents.stop(session.id);
    },
    TIMEOUT,
  );

  test(
    "a task session refused for the mise config it changed is told when the user trusts it, and runs the mise task then",
    async () => {
      const task = await daemon.facade.agents.createTask("warehouse", "change the build");
      const [session] = daemon.facade.agents.sessions().sessions.filter((s) => s.task === task.id);
      if (!session) throw new Error("the task has no session");
      const window = viewer(daemon.facade.agents, session.id);
      // The fake ends the task prompt's turn after a line and an approval; then the session waits in its empty input box.
      await waitFor(daemon.facade.agents, session.id, () => window.text().includes("--interactive="), "the screen image");
      window.attachment.input("start\r");
      await waitFor(daemon.facade.agents, session.id, (s) => s.state?.state === "Approval", "the task prompt's approval");
      window.attachment.input("1");
      await waitFor(daemon.facade.agents, session.id, (s) => s.state?.reason === "hook agentStop", "the end of the turn");
      await untilInputBox(window, "empty");
      writeFileSync(join(task.worktree, "mise.toml"), '[tasks.test]\nrun = "anything"\n');
      const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, session.id);
      clients.push(client);

      expect(errorText(await call(client, "run_mise_task", { repo: "warehouse", task: task.id, miseTask: "test" }))).toStartWith(
        "mise_unavailable: the mise config in the worktree of task",
      );
      const seen = await daemon.post(agentsApi.taskMiseConfig, { task: task.id });
      await daemon.post(agentsApi.trustTaskMiseConfig, { task: task.id, digest: seen.digest });

      await waitFor(daemon.facade.agents, session.id, () => window.unwrappedText().includes(TYPED_TRUST_NOTICE), "the typed notice");
      // The turn the notice started ends: the notice was delivered, so the next prompt, for a review, no longer carries it.
      await waitFor(daemon.facade.agents, session.id, (s) => s.state?.state === "Approval", "the notice turn's approval");
      window.attachment.input("1");
      await waitFor(daemon.facade.agents, session.id, (s) => s.state?.reason === "hook agentStop", "the end of the notice turn");
      await untilInputBox(window, "empty");
      const review = { path: "mise.toml", side: "new", line: 1, code: "[tasks.test]", text: "Keep it." } as const;
      await daemon.post(agentsApi.sendReview, { task: task.id, comments: [review] });
      await waitFor(daemon.facade.agents, session.id, () => window.unwrappedText().includes(TYPED_REVIEW), "the typed review prompt");
      const afterReview = window.unwrappedText().slice(window.unwrappedText().lastIndexOf(TYPED_REVIEW));
      expect(afterReview).not.toContain("The user trusted the mise config");

      await call(client, "run_mise_task", { repo: "warehouse", task: task.id, miseTask: "test" });
      const ended = MiseTaskRunResult.parse(
        (await call(client, "wait_for_mise_task", { repo: "warehouse", task: task.id, miseTask: "test", timeoutSeconds: 20 }))
          .structuredContent,
      );
      expect(ended.run).toMatchObject({ kind: "exited", exitCode: 3 });

      window.attachment.input("1");
      window.attachment.detach();
      await daemon.facade.agents.stop(session.id);
    },
    TIMEOUT,
  );

  test(
    "trusting the repo root's mise config tells the session it refused, and only that one",
    async () => {
      const config = join(daemon.projects, "shop", "fake-mise.json");
      writeFileSync(config, JSON.stringify({ ...JSON.parse(MISE_CONFIG), untrusted: true }));
      const refused = await daemon.facade.agents.start("shop");
      const bystander = await daemon.facade.agents.start("shop");
      const refusedWindow = viewer(daemon.facade.agents, refused.id);
      const bystanderWindow = viewer(daemon.facade.agents, bystander.id);
      await untilInputBox(refusedWindow, "empty");
      await untilInputBox(bystanderWindow, "empty");
      const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, refused.id);
      clients.push(client);

      expect(errorText(await call(client, "run_mise_task", { repo: "shop", miseTask: "test" }))).toStartWith(
        "mise_unavailable: mise ERROR Config files in",
      );
      await daemon.post(miseApi.trust, { repo: "shop" });

      await waitFor(daemon.facade.agents, refused.id, () => refusedWindow.unwrappedText().includes(TYPED_TRUST_NOTICE), "the typed notice");
      expect(bystanderWindow.unwrappedText()).not.toContain("The user trusted the mise config");

      refusedWindow.attachment.input("1");
      for (const [session, window] of [
        [refused, refusedWindow],
        [bystander, bystanderWindow],
      ] as const) {
        window.attachment.detach();
        await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "the first state");
        await daemon.facade.agents.stop(session.id);
      }
    },
    TIMEOUT,
  );

  test(
    "the supervisor runs and stops no mise tasks or services: it works in no repo and proposes a task instead",
    async () => {
      const supervisor = await daemon.facade.agents.startSupervisor("new", "terminal");
      const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, supervisor.id);
      clients.push(client);

      expect(errorText(await call(client, "run_mise_task", { repo: "warehouse", miseTask: "test" }))).toBe(
        "bad_request: the supervisor works in no repo and runs nothing in one; propose a task in warehouse instead",
      );
      for (const [tool, args] of [
        ["stop_mise_task", { repo: "warehouse", miseTask: "test" }],
        ["start_service", { repo: "warehouse" }],
        ["stop_service", { repo: "warehouse" }],
      ] as const) {
        expect(errorText(await call(client, tool, args))).toBe(
          "bad_request: the supervisor works in no repo and runs nothing in one; propose a task in warehouse instead",
        );
      }
      await waitFor(daemon.facade.agents, supervisor.id, (s) => s.state !== null, "the first state");
      await daemon.facade.agents.stop(supervisor.id);
    },
    TIMEOUT,
  );

  test(
    "a free session runs no mise tasks of a repo either, and is named as a free session in the refusal (ADR-100)",
    async () => {
      const free = await daemon.facade.agents.start(null);
      const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, free.id);
      clients.push(client);

      expect(errorText(await call(client, "run_mise_task", { repo: "warehouse", miseTask: "test" }))).toBe(
        "bad_request: a free session works in no repo and runs nothing in one; propose a task in warehouse instead",
      );
      await waitFor(daemon.facade.agents, free.id, (s) => s.state !== null, "the first state");
      await daemon.facade.agents.stop(free.id);
    },
    TIMEOUT,
  );
});
