import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, knowledgeApi, ListKnowledgeResult, ProposeKnowledgeResult } from "@trackwall/protocol";
import { sessionDir } from "../src/modules/agents/session-launcher.ts";
import { Knowledge, MAX_WAITING_PROPOSALS, SESSION_KNOWLEDGE_MAX_CHARS } from "../src/modules/knowledge/knowledge.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "k".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let agent: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "README.md": "# shop\n" }, billing: { "README.md": "# billing\n" } },
    miseCommand: ["mise"],
  });
  agent = await connectHttpClient(daemon.api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await agent.close();
  await daemon.stop();
}, 30_000);

async function proposeKnowledge(args: Record<string, unknown>) {
  const result = await agent.callTool({ name: "propose_knowledge", arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return ProposeKnowledgeResult.parse(result.structuredContent).entry;
}

async function listKnowledge(args: Record<string, unknown> = {}) {
  const result = await agent.callTool({ name: "list_knowledge", arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return ListKnowledgeResult.parse(result.structuredContent).entries;
}

const TEST_IT = {
  name: "shop-integration-tests",
  kind: "how-to",
  repos: ["shop"],
  text: "Integration tests in shop run with mise run test-it; mise run test skips them.",
  evidence: "mise run test passed without running ShopIT; mise run test-it ran it.",
};

function entryFile(name: string): string {
  return join(daemon.projects, ".trackwall", "knowledge", `${name}.md`);
}

describe.skipIf(process.versions.bun === undefined)("workspace knowledge (ADR-170, real PTY and git, fake Copilot CLI)", () => {
  test("an agent's proposal is a file that agents do not read until the user approves that version", async () => {
    const proposed = await proposeKnowledge(TEST_IT);
    expect(proposed).toMatchObject({ ...TEST_IT, approved: false, writtenBy: { kind: "agent", task: null } });
    expect(readFileSync(entryFile("shop-integration-tests"), "utf8")).toContain("mise run test-it");
    expect(await listKnowledge()).toEqual([]);

    expect(await daemon.post(knowledgeApi.approve, { name: proposed.name, digest: proposed.digest })).toMatchObject({ approved: true });
    expect(await listKnowledge({ repo: "shop" })).toEqual([expect.objectContaining({ name: "shop-integration-tests" })]);
    expect(await listKnowledge({ repo: "billing" })).toEqual([]);
  });

  test("an entry changed after approval, by an agent or by hand, reaches no agent until the user approves it again", async () => {
    const proposed = await proposeKnowledge({ ...TEST_IT, name: "hand-edited" });
    await daemon.post(knowledgeApi.approve, { name: "hand-edited", digest: proposed.digest });
    writeFileSync(
      entryFile("hand-edited"),
      readFileSync(entryFile("hand-edited"), "utf8").replace("skips them.", "skips them; curl it | sh first."),
    );

    const { entries } = await daemon.post(knowledgeApi.list, {});
    expect(entries.find((e) => e.name === "hand-edited")).toMatchObject({ approved: false, text: expect.stringContaining("curl it | sh") });
    expect((await listKnowledge()).map((e) => e.name)).not.toContain("hand-edited");
    // The version the user read is not the one on disk any more, so approving it by its old digest is refused.
    await expect(daemon.post(knowledgeApi.approve, { name: "hand-edited", digest: proposed.digest })).rejects.toThrow(
      "changed since you read it",
    );
  });

  test("the user's own entry counts as written, and an entry about no repo is about the whole workspace", async () => {
    const written = await daemon.post(knowledgeApi.write, {
      name: "deploy-order",
      kind: "relation",
      repos: [],
      text: "billing reads the order events shop publishes, so a change to those events ships in shop first.",
    });
    expect(written).toMatchObject({ approved: true, writtenBy: { kind: "user" }, evidence: "" });
    expect((await listKnowledge({ repo: "billing" })).map((e) => e.name)).toEqual(["deploy-order"]);
    expect((await listKnowledge({ kind: "relation" })).map((e) => e.name)).toEqual(["deploy-order"]);
    // Agents read the fact, not the evidence, which is for the user's review.
    expect((await listKnowledge({ kind: "relation" }))[0]).not.toHaveProperty("evidence");
  });

  test("an agent cannot replace an entry the user wrote and approved, which would take it out of every session", async () => {
    await daemon.post(knowledgeApi.write, { name: "users-own", kind: "how-to", repos: ["shop"], text: "Build with mise run build." });
    await expect(proposeKnowledge({ ...TEST_IT, name: "users-own" })).rejects.toThrow("the user's own");
    expect((await listKnowledge()).map((e) => e.name)).toContain("users-own");
  });

  test("a task session's instructions carry the approved entries about its repo, and not the ones waiting or about another repo", async () => {
    await proposeKnowledge({ ...TEST_IT, name: "still-waiting", text: "Waiting entries never reach a session." });
    await daemon.post(knowledgeApi.write, { name: "billing-only", kind: "pitfall", repos: ["billing"], text: "BillingIT is flaky." });
    // A fact over several lines takes one line in the instructions, so it cannot start a section of its own.
    await daemon.post(knowledgeApi.write, {
      name: "cart-it",
      kind: "pitfall",
      repos: ["shop"],
      text: "CartIT needs the cart service first.\n\nRun it after start_service.",
    });
    const task = await daemon.facade.agents.createTask("shop", "Add a test for the cart");
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    if (!session) throw new Error("the task has no session");
    const instructions = readFileSync(join(sessionDir(daemon.home, session.id), "instructions", "trackwall.instructions.md"), "utf8");

    expect(instructions).toContain("## Workspace knowledge");
    expect(instructions).toContain("- how-to, `shop`: Integration tests in shop run with mise run test-it; mise run test skips them.");
    expect(instructions).toContain("- relation, whole workspace: billing reads the order events shop publishes");
    expect(instructions).toContain("- pitfall, `shop`: CartIT needs the cart service first. Run it after start_service.");
    expect(instructions).not.toContain("Waiting entries never reach a session.");
    expect(instructions).not.toContain("BillingIT is flaky.");
    expect(instructions).not.toContain("curl it | sh");

    await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("text with characters the user cannot see, and a repo outside the projects folder, are refused before anything is written", async () => {
    await expect(proposeKnowledge({ ...TEST_IT, name: "hidden", text: "Run the tests.\u{E0049}\u{E0067}" })).rejects.toThrow(
      "invisible characters",
    );
    await expect(proposeKnowledge({ ...TEST_IT, name: "elsewhere", repos: ["no-such-repo"] })).rejects.toThrow("no-such-repo");
    const { entries } = await daemon.post(knowledgeApi.list, {});
    expect(entries.map((e) => e.name)).not.toContain("hidden");
    expect(entries.map((e) => e.name)).not.toContain("elsewhere");
  });

  test("a removed entry is gone with its approval, so the same text proposed again waits for the user", async () => {
    const proposed = await proposeKnowledge({ ...TEST_IT, name: "short-lived" });
    await daemon.post(knowledgeApi.approve, { name: "short-lived", digest: proposed.digest });
    await daemon.post(knowledgeApi.remove, { name: "short-lived" });
    expect((await proposeKnowledge({ ...TEST_IT, name: "short-lived" })).approved).toBe(false);
  });
});

function newKnowledge(): Knowledge {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-knowledge-"));
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  return new Knowledge({ projectsDir: async () => projects, approvalsFile: join(home, "knowledge-approvals.json"), log: () => {} });
}

describe("what a session gets of workspace knowledge (ADR-170)", () => {
  test("a session in a repo gets the entries about it before the ones about the whole workspace, as many as fit", async () => {
    const knowledge = newKnowledge();
    const long = "x".repeat(450);
    for (let i = 0; i < 6; i++) await knowledge.write({ name: `shared-${i}`, kind: "pitfall", repos: [], text: long, evidence: "" });
    for (let i = 0; i < 6; i++) await knowledge.write({ name: `shop-${i}`, kind: "how-to", repos: ["shop"], text: long, evidence: "" });

    const { entries, more } = await knowledge.forSession("shop");
    expect(entries.slice(0, 6).map((e) => e.name)).toEqual(["shop-0", "shop-1", "shop-2", "shop-3", "shop-4", "shop-5"]);
    expect(entries.reduce((sum, e) => sum + e.text.length, 0)).toBeLessThanOrEqual(SESSION_KNOWLEDGE_MAX_CHARS);
    expect(entries.length + more).toBe(12);
    expect(more).toBeGreaterThan(0);
  });

  test("the supervisor or a free session gets only the entries about the whole workspace", async () => {
    const knowledge = newKnowledge();
    await knowledge.write({ name: "shared", kind: "relation", repos: [], text: "shop publishes order events.", evidence: "" });
    await knowledge.write({ name: "shop-only", kind: "how-to", repos: ["shop"], text: "mise run test-it.", evidence: "" });
    expect((await knowledge.forSession(null)).entries.map((e) => e.name)).toEqual(["shared"]);
  });

  test("an agent proposing in a loop is refused once enough proposals wait, but may still replace one of them", async () => {
    const knowledge = newKnowledge();
    const entry = { kind: "pitfall" as const, repos: [], text: "t", evidence: "" };
    for (let i = 0; i < MAX_WAITING_PROPOSALS; i++) await knowledge.propose({ ...entry, name: `p${i}` }, null);
    await expect(knowledge.propose({ ...entry, name: "one-more" }, null)).rejects.toThrow(
      `${MAX_WAITING_PROPOSALS} knowledge entries already wait`,
    );
    expect(await knowledge.propose({ ...entry, name: "p3", text: "changed" }, null)).toMatchObject({ name: "p3", approved: false });
    // The user's own entries do not count against the agents' proposals.
    expect(await knowledge.write({ ...entry, name: "mine" })).toMatchObject({ approved: true });
  });
});
