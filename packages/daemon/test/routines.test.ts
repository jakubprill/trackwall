import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeRoutineResult, routinesApi } from "@trackwall/protocol";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "r".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let agent: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
  agent = await connectHttpClient(daemon.api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await agent.close();
  await daemon.stop();
}, 30_000);

async function proposeRoutine(args: Record<string, unknown>) {
  const result = await agent.callTool({ name: "propose_routine", arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return ProposeRoutineResult.parse(result.structuredContent).routine;
}

const UPDATE_CLIENT = {
  name: "update-orders-client",
  title: "Update the orders API client",
  repo: "shop",
  prompt: "Run the mise task update-client, compile, and report what changed with report_result.",
};

function routineFile(name: string): string {
  return join(daemon.projects, ".trackwall", "routines", `${name}.md`);
}

describe.skipIf(process.versions.bun === undefined)("routines (ADR-173, real PTY and git, fake Copilot CLI)", () => {
  test("an agent saves a routine as a file; it runs only after the user approves it, and each run is an ordinary task", async () => {
    const proposed = await proposeRoutine(UPDATE_CLIENT);
    expect(proposed).toMatchObject({ ...UPDATE_CLIENT, model: null, approvals: "ask", approved: false });
    expect(readFileSync(routineFile("update-orders-client"), "utf8")).toContain("Run the mise task update-client");

    const seen = { name: proposed.name, digest: proposed.digest };
    await expect(daemon.post(routinesApi.run, seen)).rejects.toThrow("not approved");

    expect(await daemon.post(routinesApi.approve, seen)).toMatchObject({ approved: true });
    const task = await daemon.post(routinesApi.run, seen);
    expect(task).toMatchObject({ repo: "shop", title: "Update the orders API client", approvals: "ask", model: null });

    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    if (session) await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("a routine changed after approval, by an agent or by hand, waits for approval again before it runs", async () => {
    const first = await proposeRoutine({ ...UPDATE_CLIENT, name: "check-docs" });
    await daemon.post(routinesApi.approve, { name: "check-docs", digest: first.digest });

    writeFileSync(routineFile("check-docs"), readFileSync(routineFile("check-docs"), "utf8").replace("compile", "push to main"));
    const { routines } = await daemon.post(routinesApi.list, {});
    const changed = routines.find((r) => r.name === "check-docs");
    expect(changed).toMatchObject({ approved: false, prompt: expect.stringContaining("push to main") });
    // The version the user approved is not the one on disk any more: running it by its old digest is refused.
    await expect(daemon.post(routinesApi.run, { name: "check-docs", digest: first.digest })).rejects.toThrow("changed since you read it");
    if (!changed) throw new Error("the changed routine is missing from the list");
    await expect(daemon.post(routinesApi.run, { name: "check-docs", digest: changed.digest })).rejects.toThrow("not approved");

    const resaved = await proposeRoutine({ ...UPDATE_CLIENT, name: "check-docs" });
    expect(resaved).toMatchObject({ digest: first.digest, approved: true });
  });

  test("an approval names the version the user read, so a file changed in between is not approved unseen", async () => {
    const proposed = await proposeRoutine({ ...UPDATE_CLIENT, name: "swap-before-approval" });
    writeFileSync(
      routineFile("swap-before-approval"),
      readFileSync(routineFile("swap-before-approval"), "utf8").replace("compile", "delete"),
    );
    await expect(daemon.post(routinesApi.approve, { name: proposed.name, digest: proposed.digest })).rejects.toThrow(
      "changed since you read it",
    );
  });

  test("a file that holds no routine is listed as a problem and never runs; a removed routine is gone with its approval", async () => {
    writeFileSync(routineFile("broken"), "no frontmatter here");
    const list = await daemon.post(routinesApi.list, {});
    expect(list.problems).toEqual([{ file: "broken.md", message: expect.stringContaining("frontmatter") }]);

    const proposed = await proposeRoutine({ ...UPDATE_CLIENT, name: "short-lived" });
    await daemon.post(routinesApi.approve, { name: proposed.name, digest: proposed.digest });
    await daemon.post(routinesApi.remove, { name: "short-lived" });
    const after = await daemon.post(routinesApi.list, {});
    expect(after.routines.map((r) => r.name)).not.toContain("short-lived");
    const again = await proposeRoutine({ ...UPDATE_CLIENT, name: "short-lived" });
    expect(again.approved).toBe(false);
  });

  test("an agent cannot save a routine for a repo that is not in the projects folder", async () => {
    await expect(proposeRoutine({ ...UPDATE_CLIENT, name: "elsewhere", repo: "no-such-repo" })).rejects.toThrow("no-such-repo");
  });
});
