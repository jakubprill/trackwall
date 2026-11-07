import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationEntry } from "@trackwall/protocol";
import { z } from "zod";
import { jsonOf } from "../src/modules/agents/json.ts";
import { waitFor } from "../test/support/agents.ts";
import { startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// What Copilot CLI sends over ACP for the agent's plan (ADR-107): the conversation view would show the plan above the
// conversation (the design gallery's `conversation-review.html`). Up to Copilot CLI 1.0.105 the `plan` update came
// only empty; since 1.0.107 it carries the agent's todos as plan entries, so the plan can be built. The daemon still
// drops `plan`, so this test reads Copilot CLI's output through `acp-tap.ts`.

const SESSION_MS = 60_000;
setDefaultTimeout(4 * SESSION_MS);

let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;
const tapDir = mkdtempSync(join(tmpdir(), "trackwall-acp-tap-"));
const tapFile = join(tapDir, "acp-output.jsonl");

beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model, {}, {}, { acpTap: tapFile });
});

afterEach(async () => {
  const { agents } = daemon.facade;
  for (const session of agents.sessions().sessions) if (session.run.kind === "running") await agents.stop(session.id);
  expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
});

afterAll(async () => {
  await daemon.stop();
  await model.close();
  rmSync(tapDir, { recursive: true, force: true });
});

const Update = z.object({ params: z.object({ update: z.looseObject({ sessionUpdate: z.string() }) }) });

/** The `session/update` notifications of one kind that Copilot CLI sent. */
function updatesOf(kind: string): unknown[] {
  if (!existsSync(tapFile)) return [];
  return readFileSync(tapFile, "utf8")
    .split("\n")
    .flatMap((line) => {
      const parsed = jsonOf(Update).safeParse(line);
      return parsed.success && parsed.data.params.update.sessionUpdate === kind ? [parsed.data.params.update] : [];
    });
}

test("the agent's todos reach ACP as plan entries with their titles and states, and the title of the todo in progress as a thought", async () => {
  const { agents } = daemon.facade;
  const supervisor = await agents.startSupervisor("new", "conversation");
  await waitFor(agents, supervisor.id, (s) => s.state?.state === "Input", "Input", SESSION_MS);
  const entries = new Map<string, ConversationEntry>();
  const view = agents.attachConversation(supervisor.id, {
    send: (message) => {
      if (message.reset) entries.clear();
      for (const entry of message.entries) entries.set(entry.id, entry);
    },
    closed: () => {},
  });
  model.reply(
    {
      tool: "sql",
      arguments: {
        description: "Plan the fix",
        query:
          "INSERT INTO todos (id, title, description, status) VALUES ('reading-code', 'Reading the code', 'Find the total', 'done'), ('writing-test', 'Writing the test', 'A failing test', 'in_progress'), ('fixing-total', 'Fixing the total', 'Apply discounts', 'pending');",
      },
    },
    { text: "Planned." },
  );

  agents.say(supervisor.id, "plan the fix");
  await waitFor(agents, supervisor.id, (s) => s.state?.reason === "stop end_turn", "end of turn", SESSION_MS);

  const plans = updatesOf("plan");
  expect(plans.at(-1)).toEqual({
    sessionUpdate: "plan",
    entries: [
      { content: "Reading the code", priority: "medium", status: "completed" },
      { content: "Writing the test", priority: "medium", status: "in_progress" },
      { content: "Fixing the total", priority: "medium", status: "pending" },
    ],
  });
  // An update can come after the prompt's result (`acp-session.contract.ts`), so the thought is waited for.
  const thoughts = () => [...entries.values()].filter((e) => e.kind === "thought").map((e) => e.text);
  const deadline = Date.now() + 5_000;
  while (!thoughts().includes("Writing the test") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  expect(thoughts()).toContain("Writing the test");
  view.detach();
  await agents.stop(supervisor.id);
});
