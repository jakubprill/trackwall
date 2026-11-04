import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { conversationEventLog } from "../../src/modules/agents/copilot-usage-log.ts";

/**
 * The receipt Copilot CLI appends to a conversation's event log after a model call (ADR-190), in the shape the contract
 * test sees on the real one; the fakes write it for every turn's model call. `nanoAiu` is the call's cost on token billing, which
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
        .filter((line) => line !== "").length + 1
    : 1;
  const usage = {
    model: "fake-model",
    inputTokens: 100,
    outputTokens: 20,
    cost: 1,
    initiator: "user",
    aiCreditsStatus: o.nanoAiu === undefined ? "unavailable" : "complete",
    ...(o.nanoAiu === undefined ? {} : { copilotUsage: { totalNanoAiu: o.nanoAiu, tokenDetails: [] } }),
    accounting: { sourceSessionId: o.conversation, sequence, usageId: `call_${sequence}` },
  };
  const record = {
    type: "session.usage_record",
    data: { usage },
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    parentId: null,
  };
  appendFileSync(file, `${JSON.stringify(record)}\n`);
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
