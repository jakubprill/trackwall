import { describe, expect, test } from "bun:test";
import type { CopilotUsage, UsageTool, UsageWork } from "@trackwall/protocol";
import { toolCalls, toolDefinitionShare, toolName, weekRange, workName, workTokens } from "../src/lib/usage-report";

const usage: CopilotUsage = {
  modelCalls: 12,
  inputTokens: 1_200_000,
  outputTokens: 12_000,
  aiCredits: null,
  aiCreditsPartial: false,
  premiumRequests: 3,
};

const work = (w: Partial<UsageWork>): UsageWork => ({
  kind: "task",
  task: null,
  repo: null,
  label: "",
  conversations: 1,
  usage,
  toolDefinitionTokens: 480_000,
  ...w,
});

describe("the weekly usage report as Settings shows it (ADR-196)", () => {
  test("a task by its title, the rest by what they were", () => {
    expect(workName(work({ kind: "task", label: "Fix the cart total" }))).toBe("Fix the cart total");
    expect(workName(work({ kind: "supervisor" }))).toBe("Supervisor");
    expect(workName(work({ kind: "repo", repo: "shop" }))).toBe("Sessions in shop");
    expect(workName(work({ kind: "outside" }))).toBe("Copilot CLI outside the projects folder");
  });

  test("a work's tokens with the share that were tool definitions", () => {
    expect(workTokens(work({}))).toBe("1.2M in · 40% tool definitions · 12k out");
    expect(workTokens(work({ toolDefinitionTokens: 0 }))).toBe("1.2M in · 12k out");
  });

  test("the share of tool definitions in whole percent, none without input", () => {
    expect(toolDefinitionShare(1000, 333)).toBe(33);
    expect(toolDefinitionShare(0, 0)).toBeNull();
  });

  test("an MCP tool with its server, a built-in tool by its own name, and its calls with the failed ones", () => {
    const tool = (t: Partial<UsageTool>): UsageTool => ({
      tool: "get_issue",
      server: "jira",
      calls: 1,
      failures: 0,
      resultTokens: 0,
      ...t,
    });
    expect(toolName(tool({}))).toBe("jira / get_issue");
    expect(toolName(tool({ tool: "view", server: null }))).toBe("view");
    expect(toolCalls(tool({}))).toBe("1 call");
    expect(toolCalls(tool({ calls: 12, failures: 2 }))).toBe("12 calls · 2 failed");
  });

  test("the week's days, the day of its end included, not the day after", () => {
    const from = new Date(2026, 9, 28, 0, 0).toISOString();
    const to = new Date(2026, 10, 4, 0, 0).toISOString();
    expect(weekRange({ from, to }, "en-US")).toBe("Oct 28 – Nov 3");
  });
});
