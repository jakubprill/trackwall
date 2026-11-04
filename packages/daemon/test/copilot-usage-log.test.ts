import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conversationEventLog } from "../src/infra/copilot-home.ts";
import { CopilotUsageLog, usageOfLines } from "../src/modules/agents/copilot-usage-log.ts";

/** A receipt line as Copilot CLI writes it (`session.usage_record`), with only the fields the daemon reads. */
function receipt(usage: Record<string, unknown>): string {
  return JSON.stringify({ type: "session.usage_record", data: { usage }, id: "x", timestamp: "2026-11-04T08:00:00Z", parentId: null });
}

describe("what a conversation used, from Copilot CLI's receipts (ADR-190)", () => {
  test("token billing: nano AI units add up to AI credits, 10⁹ to a credit", () => {
    const lines = [
      receipt({
        inputTokens: 1000,
        outputTokens: 50,
        cost: 1,
        aiCreditsStatus: "complete",
        copilotUsage: { totalNanoAiu: 1_500_000_000 },
        accounting: { sourceSessionId: "c", sequence: 1 },
      }),
      receipt({
        inputTokens: 2000,
        outputTokens: 70,
        cost: 1,
        initiator: "sub-agent",
        aiCreditsStatus: "complete",
        copilotUsage: { totalNanoAiu: 250_000_000 },
        accounting: { sourceSessionId: "c", sequence: 2 },
      }),
    ];

    expect(usageOfLines(lines)).toEqual({
      modelCalls: 2,
      inputTokens: 3000,
      outputTokens: 120,
      aiCredits: 1.75,
      aiCreditsPartial: false,
      premiumRequests: 1,
    });
  });

  test("a model of your own provider reports no AI credits, only tokens, and no premium requests", () => {
    const lines = [receipt({ inputTokens: 1, outputTokens: 1, cost: 0, initiator: "user", aiCreditsStatus: "unavailable", isByok: true })];

    expect(usageOfLines(lines)).toEqual({
      modelCalls: 1,
      inputTokens: 1,
      outputTokens: 1,
      aiCredits: null,
      aiCreditsPartial: false,
      premiumRequests: 0,
    });
  });

  test("credits from some calls only are a lower bound", () => {
    const lines = [
      receipt({ inputTokens: 1, outputTokens: 1, aiCreditsStatus: "complete", copilotUsage: { totalNanoAiu: 1e9 } }),
      receipt({ inputTokens: 1, outputTokens: 1, aiCreditsStatus: "unavailable" }),
    ];

    expect(usageOfLines(lines)).toMatchObject({ aiCredits: 1, aiCreditsPartial: true });
  });

  test("a receipt written again with the same accounting identity counts once; other events and broken lines are ignored", () => {
    const once = receipt({ inputTokens: 10, outputTokens: 1, cost: 1, accounting: { sourceSessionId: "c", sequence: 7 } });
    const lines = [once, once, '{"type":"assistant.turn_end","data":{}}', '{"type":"session.usage_record"', "not json"];

    expect(usageOfLines(lines)).toMatchObject({ modelCalls: 1, inputTokens: 10, premiumRequests: 1 });
  });

  test("no receipt yet is no usage", () => {
    expect(usageOfLines(['{"type":"session.start","data":{}}'])).toBeNull();
  });
});

describe("the usage log of a session", () => {
  test("reads only what was appended since the last update, keeps a line cut at the end for the next one, and starts over when the log got shorter", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-usage-"));
    const file = conversationEventLog(home, "conv-1");
    mkdirSync(dirname(file), { recursive: true });
    const log = new CopilotUsageLog(home);

    log.update("conv-1");
    expect(log.current()).toBeNull();

    const first = receipt({ inputTokens: 5, outputTokens: 1, accounting: { sourceSessionId: "conv-1", sequence: 1 } });
    const second = receipt({ inputTokens: 7, outputTokens: 2, accounting: { sourceSessionId: "conv-1", sequence: 2 } });
    writeFileSync(file, `${first}\n${second.slice(0, 20)}`);
    log.update("conv-1");
    expect(log.current()).toMatchObject({ modelCalls: 1, inputTokens: 5 });

    appendFileSync(file, `${second.slice(20)}\n`);
    log.update("conv-1");
    expect(log.current()).toMatchObject({ modelCalls: 2, inputTokens: 12 });

    writeFileSync(file, `${second}\n`);
    log.update("conv-1");
    expect(log.current()).toMatchObject({ modelCalls: 1, inputTokens: 7 });
  });

  test("a missing log leaves the usage as it was", () => {
    const log = new CopilotUsageLog(join(tmpdir(), "trackwall-no-such-copilot-home"));

    log.update("conv-1");

    expect(log.current()).toBeNull();
  });
});
