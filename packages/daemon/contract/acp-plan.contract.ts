import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationEntry } from "@trackwall/protocol";
import { z } from "zod";
import { waitFor } from "../test/support/agents.ts";
import { startRealCopilotDaemon } from "./support/real-copilot.ts";
import { type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// What Copilot CLI sends over ACP for the agent's plan (ADR-107): the conversation view would show the plan above the
// conversation (the design gallery's `conversation-review.html`), but Copilot CLI keeps the agent's todos in its
// session's SQL database and sends ACP's `plan` update only empty, with the title of the todo in progress as the
// model's reasoning. The daemon drops `plan`, so this test reads Copilot CLI's output through `acp-tap.ts`. When it
// fails because a plan came with entries, the plan can be built.

const SESSION_MS = 60_000;
setDefaultTimeout(4 * SESSION_MS);

let model: ScriptedModel;
let daemon: Awaited<ReturnType<typeof startRealCopilotDaemon>>;
const tapDir = mkdtempSync(join(tmpdir(), "trackwall-acp-tap-"));
const tapFile = join(tapDir, "acp-output.jsonl");
const tap = fileURLToPath(new URL("./support/acp-tap.ts", import.meta.url));

beforeAll(async () => {
  model = await startScriptedModel();
  daemon = await startRealCopilotDaemon(model, {}, {}, (copilot) => [process.execPath, tap, tapFile, copilot]);
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
      const parsed = Update.safeParse(parseJson(line));
      return parsed.success && parsed.data.params.update.sessionUpdate === kind ? [parsed.data.params.update] : [];
    });
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

test("the agent's todos reach ACP as an empty plan and the title of the todo in progress as a thought, not as plan entries", async () => {
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
  expect(plans.length).toBeGreaterThan(0);
  expect(plans).toEqual(plans.map(() => ({ sessionUpdate: "plan", entries: [] })));
  const thoughts = [...entries.values()].filter((e) => e.kind === "thought").map((e) => e.text);
  expect(thoughts).toContain("Writing the test");
  view.detach();
  await agents.stop(supervisor.id);
});
