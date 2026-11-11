import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { conversationEventLog } from "../../src/infra/copilot-home.ts";

/**
 * The receipt Copilot CLI appends to a conversation's event log after a model call (ADR-190), in the shape the contract
 * test sees on the real one; the fakes write it for every turn's model call, with the tokens of the tool definitions
 * it sent and one tool call whose result went back to the model (ADR-199), and the conversation's `workspace.yaml` with
 * its folder and git branch, as Copilot CLI writes them. `nanoAiu` is the call's cost on token billing, which
 * the real Copilot CLI reports only with a GitHub account, so without it the receipt says AI credits are unavailable,
 * as with the contract test's own model (BYOK).
 */
function appendUsageReceipt(o: { copilotHome: string; conversation: string; model: string; nanoAiu?: number }): void {
  const file = conversationEventLog(o.copilotHome, o.conversation);
  mkdirSync(dirname(file), { recursive: true });
  // Copilot CLI goes on with the conversation's sequence after a resume.
  const sequence = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.includes('"session.usage_record"')).length + 1
    : 1;
  const usage = {
    model: o.model,
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

/** The fake's `--model=`, if it got one. */
function requestedModel(): string | undefined {
  return process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length);
}

/**
 * With `FAKE_COPILOT_ACCOUNT_MODELS` (comma-separated, the models an account offers), the first of them when the account
 * lacks the requested model; `undefined` when the account has it or the test names no account.
 */
function offeredInstead(): string | undefined {
  const requested = requestedModel();
  const offered = (process.env.FAKE_COPILOT_ACCOUNT_MODELS ?? "").split(",").filter((id) => id !== "");
  if (offered.length > 0 && (requested === undefined || !offered.includes(requested))) return offered[0] ?? "fake-model";
  return undefined;
}

/**
 * The model the fake falls back to without stopping when the account lacks the requested one, as Copilot CLI did before
 * 1.0.109 (ADR-225), which `FAKE_COPILOT_FALLBACK=1` asks for; `undefined` otherwise.
 */
function fallbackModel(): string | undefined {
  return process.env.FAKE_COPILOT_FALLBACK === "1" ? offeredInstead() : undefined;
}

/**
 * The error of every model call when the account lacks the requested model, as Copilot CLI 1.0.109 and later write it
 * instead of falling back (ADR-242, seen on a Mac with a GitHub account); `undefined` when the call goes through.
 */
function modelRefusal(): string | undefined {
  if (fallbackModel() !== undefined || offeredInstead() === undefined) return undefined;
  return `Execution failed: Model "${requestedModel() ?? "fake-model"}" is not available.`;
}

/** The model a fake's call runs on: the fallback's, or its `--model=`. */
function modelInUse(): string {
  return fallbackModel() ?? requestedModel() ?? "fake-model";
}

/** Copilot CLI's `session.error` of a failed model call, appended to the conversation's event log (ADR-242). */
function appendModelError(o: { copilotHome: string; conversation: string; message: string }): void {
  const file = conversationEventLog(o.copilotHome, o.conversation);
  mkdirSync(dirname(file), { recursive: true });
  const event = {
    type: "session.error",
    data: { errorType: "query", message: o.message },
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    parentId: null,
  };
  appendFileSync(file, `${JSON.stringify(event)}\n`);
}

/**
 * A fake's receipt for one turn of `conversation`, or the turn's failed call on a model the account lacks, in `COPILOT_HOME` when the test set it (so a test never writes into
 * the developer's Copilot CLI home), with the cost from `FAKE_COPILOT_NANO_AIU` when set.
 */
export function recordUsage(conversation: string | undefined): void {
  const copilotHome = process.env.COPILOT_HOME;
  if (copilotHome === undefined || copilotHome === "" || conversation === undefined) return;
  // A call on a model the account lacks fails and writes no receipt (ADR-242).
  const refusal = modelRefusal();
  if (refusal !== undefined) {
    appendModelError({ copilotHome, conversation, message: refusal });
    return;
  }
  const cost = process.env.FAKE_COPILOT_NANO_AIU;
  appendUsageReceipt({ copilotHome, conversation, model: modelInUse(), ...(cost === undefined ? {} : { nanoAiu: Number(cost) }) });
}

/**
 * The model change Copilot CLI writes to the conversation's event log at every start and resume (ADR-225), with the
 * model the fake runs on, or `auto` when the account lacks the requested `--model`, as Copilot CLI 1.0.107 writes it
 * before its first call names the model it picked; in `COPILOT_HOME` when the test set it.
 */
export function recordModelChange(conversation: string | undefined): void {
  const copilotHome = process.env.COPILOT_HOME;
  if (copilotHome === undefined || copilotHome === "" || conversation === undefined) return;
  const file = conversationEventLog(copilotHome, conversation);
  mkdirSync(dirname(file), { recursive: true });
  // Copilot CLI's own word, written out rather than taken from the daemon, so that the fake cannot drift with it.
  const model = requestedModel() !== undefined && fallbackModel() !== undefined ? "auto" : modelInUse();
  const event = {
    type: "session.model_change",
    data: { source: "startup", newModel: model, previousModel: model },
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    parentId: null,
  };
  appendFileSync(file, `${JSON.stringify(event)}\n`);
}
