import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conversationEventLog } from "../src/infra/copilot-home.ts";
import {
  CopilotUsageLog,
  modelCallsOfLines,
  modelErrorOfLines,
  modelInUseOfLines,
  readConversationUse,
  usageOfLines,
} from "../src/modules/agents/copilot-usage-log.ts";

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

/** A model change as Copilot CLI writes it at a start, a resume or on `/model` (`session.model_change`). */
function modelChange(newModel: string): string {
  const data = { source: "startup", newModel, previousModel: newModel };
  return JSON.stringify({ type: "session.model_change", data, id: "x", timestamp: "2026-11-07T08:00:00Z", parentId: null });
}

describe("the model a conversation runs on, from Copilot CLI's event log (ADR-225)", () => {
  test("the model of the latest own call wins over the model set at the start: Copilot CLI took another one", () => {
    const lines = [
      modelChange("claude-sonnet-5.5"),
      receipt({
        model: "gpt-6-luna",
        inputTokens: 1,
        outputTokens: 1,
        initiator: "user",
        accounting: { sourceSessionId: "c", sequence: 1 },
      }),
    ];

    expect(modelInUseOfLines(lines)).toBe("gpt-6-luna");
  });

  test("a sub-agent's call on a model of its own does not change the conversation's model", () => {
    const lines = [
      receipt({ model: "gpt-6-luna", inputTokens: 1, outputTokens: 1, accounting: { sourceSessionId: "c", sequence: 1 } }),
      receipt({
        model: "small-model",
        inputTokens: 1,
        outputTokens: 1,
        initiator: "sub-agent",
        accounting: { sourceSessionId: "c", sequence: 2 },
      }),
    ];

    expect(modelInUseOfLines(lines)).toBe("gpt-6-luna");
  });

  test("a resume on another model names that model, and the old receipts the resume writes again do not undo it", () => {
    const old = receipt({ model: "gpt-5.5", inputTokens: 1, outputTokens: 1, accounting: { sourceSessionId: "c", sequence: 1 } });
    const lines = [modelChange("gpt-5.5"), old, modelChange("claude-opus-5.5"), old];

    expect(modelInUseOfLines(lines)).toBe("claude-opus-5.5");
  });

  test("a change to auto names no model until a call says which one Copilot CLI picked", () => {
    const call = receipt({ model: "gpt-6-luna", inputTokens: 1, outputTokens: 1, accounting: { sourceSessionId: "c", sequence: 1 } });

    expect(modelInUseOfLines([modelChange("auto")])).toBeNull();
    expect(modelInUseOfLines([modelChange("auto"), call])).toBe("gpt-6-luna");
    expect(modelInUseOfLines([modelChange("gpt-5.5"), modelChange("auto")])).toBeNull();
  });

  test("before a model change or a call the log names no model", () => {
    expect(modelInUseOfLines(['{"type":"session.start","data":{}}', '{"type":"session.model_change","data":{}}'])).toBeNull();
  });
});

describe("the models a conversation's own calls ran on, for the task journal (ADR-228)", () => {
  test("each model counts its own calls, the most used first; sub-agent calls and receipts a resume writes again do not count", () => {
    const call = (model: string, sequence: number, initiator?: string) =>
      receipt({ model, inputTokens: 1, outputTokens: 1, initiator, accounting: { sourceSessionId: "c", sequence } });
    const lines = [
      modelChange("claude-sonnet-5.5"),
      call("gpt-6-luna", 1),
      call("small-model", 2, "sub-agent"),
      modelChange("claude-opus-5.5"),
      call("gpt-6-luna", 1),
      call("claude-opus-5.5", 3),
      call("claude-opus-5.5", 4),
    ];

    expect(modelCallsOfLines(lines)).toEqual([
      { model: "claude-opus-5.5", modelCalls: 2 },
      { model: "gpt-6-luna", modelCalls: 1 },
    ]);
  });

  test("the turn's further calls the agent starts after a tool result count for its model, but only the user's calls are premium requests", () => {
    // As Copilot CLI 1.0.107 writes a task's turns: one call opens each turn, the rest follow tool results.
    const lines = [
      receipt({
        model: "gpt-6-luna",
        inputTokens: 1,
        outputTokens: 1,
        cost: 1,
        initiator: "user",
        accounting: { sourceSessionId: "c", sequence: 1 },
      }),
      receipt({
        model: "gpt-6-luna",
        inputTokens: 1,
        outputTokens: 1,
        cost: 1,
        initiator: "agent",
        accounting: { sourceSessionId: "c", sequence: 2 },
      }),
      receipt({
        model: "gpt-6-luna",
        inputTokens: 1,
        outputTokens: 1,
        cost: 1,
        initiator: "agent",
        accounting: { sourceSessionId: "c", sequence: 3 },
      }),
    ];

    expect(modelCallsOfLines(lines)).toEqual([{ model: "gpt-6-luna", modelCalls: 3 }]);
    expect(usageOfLines(lines)).toMatchObject({ modelCalls: 3, premiumRequests: 1 });
  });

  test("a conversation whose event log is missing used nothing on no model", () => {
    expect(readConversationUse(mkdtempSync(join(tmpdir(), "trackwall-usage-")), "gone")).toEqual({ usage: null, models: [] });
  });
});

/** A failed model call as Copilot CLI 1.0.109 writes it (`session.error`), with the fields the daemon reads and a few more. */
function sessionError(errorType: string, message: string): string {
  return JSON.stringify({
    type: "session.error",
    data: { errorType, message },
    id: "e",
    timestamp: "2026-11-10T21:00:00Z",
    parentId: null,
  });
}

describe("a failed model call, from Copilot CLI's event log (ADR-242)", () => {
  const unavailable = 'Execution failed: Model "gpt-9" is not available.';
  const call = receipt({
    model: "gpt-6-luna",
    inputTokens: 1,
    outputTokens: 1,
    initiator: "user",
    accounting: { sourceSessionId: "c", sequence: 1 },
  });

  test("a start on a model the account does not offer names that model and the error of every prompt", () => {
    const lines = [modelChange("gpt-9"), sessionError("query", unavailable)];

    expect(modelInUseOfLines(lines)).toBe("gpt-9");
    expect(modelErrorOfLines(lines)).toBe(unavailable);
  });

  test("an own call that goes through, or a restart on another model, ends the error", () => {
    expect(modelErrorOfLines([sessionError("query", "429 rate limited"), call])).toBeNull();
    expect(modelErrorOfLines([modelChange("gpt-9"), sessionError("query", unavailable), modelChange("gpt-6-luna")])).toBeNull();
  });

  test("an error that is not a model call's, or without a message, is no model error", () => {
    expect(modelErrorOfLines([sessionError("mcp", "server fs failed to start")])).toBeNull();
    expect(modelErrorOfLines([sessionError("query", "")])).toBeNull();
    expect(modelErrorOfLines([sessionError("query", "  ")])).toBeNull();
    expect(modelErrorOfLines(['{"type":"session.error","data":{}}'])).toBeNull();
  });

  test("a provider's long message is cut to 500 characters", () => {
    expect(modelErrorOfLines([sessionError("query", "x".repeat(2000))])).toBe(`${"x".repeat(500)}…`);
  });

  test("a restart forgets the error of a call before it, and a new failure after it shows again", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-usage-"));
    const file = conversationEventLog(home, "conv-e");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${modelChange("gpt-9")}\n${sessionError("query", unavailable)}\n`);
    const log = new CopilotUsageLog(home);

    log.update("conv-e");
    expect(log.modelError()).toBe(unavailable);
    log.readBeforeStart("conv-e");
    expect(log.modelError()).toBeNull();

    appendFileSync(file, `${sessionError("query", "500 provider down")}\n`);
    log.update("conv-e");
    expect(log.modelError()).toBe("500 provider down");
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
    expect(log.modelInUse()).toBeNull();

    const first = receipt({ inputTokens: 5, outputTokens: 1, accounting: { sourceSessionId: "conv-1", sequence: 1 } });
    const second = receipt({ inputTokens: 7, outputTokens: 2, accounting: { sourceSessionId: "conv-1", sequence: 2 } });
    writeFileSync(file, `${first}\n${second.slice(0, 20)}`);
    log.update("conv-1");
    expect(log.current()).toMatchObject({ modelCalls: 1, inputTokens: 5 });

    appendFileSync(file, `${second.slice(20)}\n`);
    log.update("conv-1");
    expect(log.current()).toMatchObject({ modelCalls: 2, inputTokens: 12 });

    appendFileSync(file, `${modelChange("gpt-6-luna")}\n`);
    log.update("conv-1");
    expect(log.modelInUse()).toBe("gpt-6-luna");

    writeFileSync(file, `${second}\n`);
    log.update("conv-1");
    expect(log.current()).toMatchObject({ modelCalls: 1, inputTokens: 7 });
    expect(log.modelInUse()).toBeNull();
  });

  test("a session going on with a conversation keeps its usage but takes the model in use only from its own start (ADR-225)", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-usage-"));
    const file = conversationEventLog(home, "conv-1");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${modelChange("gpt-5.5")}\n${receipt({ model: "gpt-5.5", inputTokens: 3, outputTokens: 1, accounting: { sourceSessionId: "conv-1", sequence: 1 } })}\n`,
    );
    const log = new CopilotUsageLog(home);

    log.readBeforeStart("conv-1");
    expect(log.current()).toMatchObject({ modelCalls: 1, inputTokens: 3 });
    expect(log.modelInUse()).toBeNull();

    appendFileSync(file, `${modelChange("claude-opus-5.5")}\n`);
    log.update("conv-1");
    expect(log.modelInUse()).toBe("claude-opus-5.5");
  });

  test("the tokens since the session's start leave out what the conversation used before it (ADR-237)", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-copilot-home-"));
    const file = conversationEventLog(home, "conv-1");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${receipt({ inputTokens: 300, outputTokens: 20, accounting: { sourceSessionId: "conv-1", sequence: 1 } })}\n`);
    const log = new CopilotUsageLog(home);

    log.readBeforeStart("conv-1");
    expect(log.tokensSinceStart()).toBe(0);

    appendFileSync(file, `${receipt({ inputTokens: 100, outputTokens: 5, accounting: { sourceSessionId: "conv-1", sequence: 2 } })}\n`);
    log.update("conv-1");
    expect(log.current()).toMatchObject({ inputTokens: 400, outputTokens: 25 });
    expect(log.tokensSinceStart()).toBe(105);
  });

  test("a missing log leaves the usage as it was", () => {
    const log = new CopilotUsageLog(join(tmpdir(), "trackwall-no-such-copilot-home"));

    log.update("conv-1");

    expect(log.current()).toBeNull();
  });
});
