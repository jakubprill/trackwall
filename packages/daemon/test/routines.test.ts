import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeRoutineResult, routinesApi } from "@trackwall/protocol";
import { Routines } from "../src/modules/routines/routines.ts";
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

  // A link needs administrator rights or developer mode on Windows; the read refuses links on every system the same way.
  test.skipIf(process.platform === "win32")(
    "a link in place of a routine file is a problem and never runs, whatever it points to",
    async () => {
      const target = join(daemon.projects, "outside.md");
      writeFileSync(target, readFileSync(routineFile("update-orders-client"), "utf8"));
      symlinkSync(target, routineFile("linked"));
      const list = await daemon.post(routinesApi.list, {});
      expect(list.routines.map((r) => r.name)).not.toContain("linked");
      expect(list.problems).toContainEqual({ file: "linked.md", message: expect.stringContaining("not a regular file") });
    },
  );

  test("a prompt with characters the user cannot see is refused before anything is written", async () => {
    await expect(proposeRoutine({ ...UPDATE_CLIENT, name: "hidden", prompt: "Compile.\u{E0049}\u{E0067}" })).rejects.toThrow(
      "invisible characters",
    );
    const list = await daemon.post(routinesApi.list, {});
    expect(list.routines.map((r) => r.name)).not.toContain("hidden");
  });

  test("unreadable approvals are moved aside, and every routine waits for approval again", async () => {
    const proposed = await proposeRoutine({ ...UPDATE_CLIENT, name: "approvals-lost" });
    await daemon.post(routinesApi.approve, { name: proposed.name, digest: proposed.digest });
    writeFileSync(join(daemon.home, "routine-approvals.json"), "{ not json");
    const { routines } = await daemon.post(routinesApi.list, {});
    expect(routines.filter((r) => r.approved)).toEqual([]);
  });

  test("an agent cannot save a routine for a repo that is not in the projects folder", async () => {
    await expect(proposeRoutine({ ...UPDATE_CLIENT, name: "elsewhere", repo: "no-such-repo" })).rejects.toThrow("no-such-repo");
  });
});

describe("the routine limit (ADR-173)", () => {
  test("an agent saving routines in a loop is refused at the limit, but may still replace one it saved", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-routines-"));
    const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
    const routines = new Routines({
      projectsDir: async () => projects,
      approvalsFile: join(home, "routine-approvals.json"),
      log: () => {},
    });
    const routine = { title: "T", repo: "shop", model: null, approvals: "ask" as const, prompt: "p" };
    for (let i = 0; i < 100; i++) await routines.save({ ...routine, name: `r${i}` });
    await expect(routines.save({ ...routine, name: "one-more" })).rejects.toThrow("100 routines");
    expect(await routines.save({ ...routine, name: "r7", prompt: "changed" })).toMatchObject({ name: "r7", approved: false });
  });
});
