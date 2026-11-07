import { describe, expect, test } from "bun:test";
import { EventLogReader } from "../src/modules/usage-report/event-log.ts";

/** An event log line as Copilot CLI writes it, with only the fields the report reads. */
const event = (type: string, timestamp: string, data: unknown) => JSON.stringify({ type, data, id: "x", timestamp, parentId: null });

describe("what the weekly usage report takes from a conversation's event log (ADR-199)", () => {
  test("a model call's receipt with its time, tokens and the tokens of the tool definitions it sent", () => {
    const reader = new EventLogReader();
    reader.line(
      event("session.usage_record", "2026-11-04T08:00:00.000Z", {
        usage: {
          inputTokens: 40_000,
          outputTokens: 300,
          cost: 1,
          toolTokenCount: 30_000,
          accounting: { sourceSessionId: "c", sequence: 1 },
        },
      }),
    );

    expect(reader.digest().receipts).toEqual([
      {
        key: "c:1",
        at: "2026-11-04T08:00:00.000Z",
        inputTokens: 40_000,
        outputTokens: 300,
        toolDefinitionTokens: 30_000,
        nanoAiu: undefined,
        creditsMissing: true,
        premiumRequests: 1,
        ownModel: undefined,
      },
    ]);
  });

  test("a tool call with its server and the tokens of its result, from its start and its end", () => {
    const reader = new EventLogReader();
    reader.line(
      event("tool.execution_start", "2026-11-04T08:00:01.000Z", {
        toolCallId: "call_1_0",
        toolName: "trackwall-list_repos",
        arguments: {},
        mcpServerName: "trackwall",
        mcpToolName: "list_repos",
      }),
    );
    reader.line(event("tool.execution_start", "2026-11-04T08:00:01.100Z", { toolCallId: "call_1_1", toolName: "view", arguments: {} }));
    reader.line(
      event("tool.execution_complete", "2026-11-04T08:00:02.000Z", {
        toolCallId: "call_1_0",
        success: true,
        result: { content: "{}" },
        toolTelemetry: { metrics: { result_token_count: 137 } },
      }),
    );
    reader.line(
      event("tool.execution_complete", "2026-11-04T08:00:02.000Z", {
        toolCallId: "call_1_1",
        success: false,
        error: { message: "no such file" },
        toolTelemetry: { metrics: {} },
      }),
    );

    expect(reader.digest().toolCalls).toEqual([
      { at: "2026-11-04T08:00:01.000Z", tool: "list_repos", server: "trackwall", failed: false, resultTokens: 137 },
      { at: "2026-11-04T08:00:01.100Z", tool: "view", server: null, failed: true, resultTokens: 0 },
    ]);
  });

  test("a call still running counts without a result, and lines of another shape are skipped", () => {
    const reader = new EventLogReader();
    reader.line(event("tool.execution_start", "2026-11-04T08:00:01.000Z", { toolCallId: "call_1_0", toolName: "bash", arguments: {} }));
    reader.line('{"type":"tool.execution_start","data":');
    reader.line(event("tool.execution_complete", "2026-11-04T08:00:02.000Z", { toolCallId: "never-started", success: true }));
    reader.line(event("assistant.message", "2026-11-04T08:00:02.000Z", { content: "session.usage_record" }));

    expect(reader.digest()).toEqual({
      receipts: [],
      toolCalls: [{ at: "2026-11-04T08:00:01.000Z", tool: "bash", server: null, failed: false, resultTokens: 0 }],
    });
  });
});
