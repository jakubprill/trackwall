import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conversationEventLog } from "../src/infra/copilot-home.ts";
import { backgroundAgentEventOf } from "../src/modules/agents/copilot-background-agent.ts";
import { CopilotUsageLog } from "../src/modules/agents/copilot-usage-log.ts";

// Lines as Copilot CLI 1.0.109 writes them to a conversation's event log (copilot-session.contract.ts), cut to the fields read.
const started = (toolCallId: string, executionMode: string) =>
  JSON.stringify({ type: "subagent.started", data: { toolCallId, agentName: "explore", executionMode } });
const ended = (type: string, toolCallId: string) => JSON.stringify({ type, data: { toolCallId, agentName: "explore" } });

describe("background agents in Copilot CLI's event log (ADR-254)", () => {
  test("a background agent starts with subagent.started in background mode and ends with subagent.completed or subagent.failed", () => {
    expect(backgroundAgentEventOf(started("call_1_0", "background"))).toEqual({ started: "call_1_0" });
    expect(backgroundAgentEventOf(ended("subagent.completed", "call_1_0"))).toEqual({ ended: "call_1_0" });
    expect(backgroundAgentEventOf(ended("subagent.failed", "call_1_0"))).toEqual({ ended: "call_1_0" });
  });

  test("a subagent in the foreground, other events and broken lines say nothing about background agents", () => {
    expect(backgroundAgentEventOf(started("call_1_0", "sync"))).toBeUndefined();
    expect(backgroundAgentEventOf(JSON.stringify({ type: "subagent.selected", data: { agentName: "explore" } }))).toBeUndefined();
    expect(backgroundAgentEventOf('{"type":"subagent.started","data":')).toBeUndefined();
  });

  test("the log counts the background agents still running, and a restart forgets those of the earlier start", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-background-"));
    const file = conversationEventLog(home, "conv-b");
    mkdirSync(dirname(file), { recursive: true });
    const lines = [started("call_1_0", "background"), started("call_2_0", "background"), ended("subagent.completed", "call_1_0")];
    writeFileSync(file, `${lines.join("\n")}\n`);

    const log = new CopilotUsageLog(home);
    log.update("conv-b");
    expect(log.backgroundAgents()).toBe(1);

    const restarted = new CopilotUsageLog(home);
    restarted.readBeforeStart("conv-b");
    expect(restarted.backgroundAgents()).toBe(0);
  });
});
