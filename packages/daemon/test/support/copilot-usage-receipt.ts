import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { conversationEventLog } from "../../src/infra/copilot-home.ts";

/**
 * The receipt Copilot CLI appends to a conversation's event log after a model call (ADR-190), in the shape the contract
 * test sees on the real one; the fakes write it for every turn's model call, with the tokens of the tool definitions
 * it sent and one tool call whose result went back to the model (ADR-196), and the conversation's `workspace.yaml` with
 * its folder and git branch, as Copilot CLI writes them. `nanoAiu` is the call's cost on token billing, which
 * the real Copilot CLI reports only with a GitHub account, so without it the receipt says AI credits are unavailable,
 * as with the contract test's own model (BYOK).
 */
function appendUsageReceipt(o: { copilotHome: string; conversation: string; nanoAiu?: number }): void {
  const file = conversationEventLog(o.copilotHome, o.conversation);
  mkdirSync(dirname(file), { recursive: true });
  // Copilot CLI goes on with the conversation's sequence after a resume.
  const sequence = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.includes('"session.usage_record"')).length + 1
    : 1;
  const usage = {
    model: "fake-model",
    inputTokens: 100,
    outputTokens: 20,
    cost: 1,
    initiator: "user",
    toolTokenCount: 60,
    aiCreditsStatus: o.nanoAiu === undefined ? "unavailable" : "complete",
    ...(o.nanoAiu === undefined ? {} : { copilotUsage: { totalNanoAiu: o.nanoAiu, tokenDetails: [] } }),
    accounting: { sourceSessionId: o.conversation, sequence, usageId: `call_${sequence}` },
  };
  const record = { type: "session.usage_record", data: { usage } };
  const call = `call_${sequence}_0`;
  const start = { type: "tool.execution_start", data: { toolCallId: call, toolName: "view", arguments: { path: "." } } };
  const complete = {
    type: "tool.execution_complete",
    data: { toolCallId: call, success: true, result: { content: "README.md" }, toolTelemetry: { metrics: { result_token_count: 4 } } },
  };
  const lines = [record, start, complete].map((event) => ({
    ...event,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    parentId: null,
  }));
  appendFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  writeWorkspaceFile(dirname(file));
}

/** Copilot CLI's `workspace.yaml` of a conversation: the folder it runs in and that folder's git branch. */
function writeWorkspaceFile(conversationDir: string): void {
  const file = join(conversationDir, "workspace.yaml");
  if (existsSync(file)) return;
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(file, `cwd: ${JSON.stringify(process.cwd())}\n${branch === "" ? "" : `branch: ${branch}\n`}`);
}

/**
 * A fake's receipt for one turn of `conversation`, in `COPILOT_HOME` when the test set it (so a test never writes into
 * the developer's Copilot CLI home), with the cost from `FAKE_COPILOT_NANO_AIU` when set.
 */
export function recordUsage(conversation: string | undefined): void {
  const copilotHome = process.env.COPILOT_HOME;
  if (copilotHome === undefined || copilotHome === "" || conversation === undefined) return;
  const cost = process.env.FAKE_COPILOT_NANO_AIU;
  appendUsageReceipt({ copilotHome, conversation, ...(cost === undefined ? {} : { nanoAiu: Number(cost) }) });
}
