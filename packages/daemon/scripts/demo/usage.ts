// A week of Copilot CLI conversations for the demo's "Copilot usage" (ADR-196): the event logs and `workspace.yaml`
// Copilot CLI would have left in its home for the demo's tasks, its repo sessions, the supervisor and one folder
// outside the projects folder, with model calls and tool calls spread over the last six days. The numbers are made
// up but shaped like a real week: tool definitions are a large part of every call, and a few tools add most results.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { conversationEventLog } from "../../src/infra/copilot-home.ts";

/** A conversation to write: where it ran, how many model calls it made and which tools it called how often. */
interface DemoConversation {
  cwd: string;
  branch: string | null;
  daysAgo: number;
  modelCalls: number;
  /** Input tokens of the first call; each later call reads what came before, so it grows. */
  firstInput: number;
  tools: Record<string, number>;
}

/** Tokens of the tool definitions every call sends, about as many as Trackwall's tools and Copilot CLI's own take. */
const TOOL_DEFINITION_TOKENS = 23_500;

/** The result tokens of one call of each tool, as a typical answer of it. */
const RESULT_TOKENS: Record<string, number> = {
  "trackwall-search_code": 3200,
  "trackwall-get_repo": 900,
  "trackwall-find_endpoint": 650,
  "trackwall-who_calls": 480,
  "trackwall-get_task_changes": 2600,
  "trackwall-run_mise_task": 1400,
  "trackwall-list_repos": 1100,
  "tracker-get_issue": 1800,
  view: 1500,
  grep: 700,
  bash: 900,
  edit: 60,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function lines(id: string, c: DemoConversation, now: number): string[] {
  const out: string[] = [];
  const start = now - c.daysAgo * DAY_MS;
  const toolCalls = Object.entries(c.tools).flatMap(([tool, times]) => Array.from({ length: times }, () => tool));
  for (let call = 0; call < c.modelCalls; call++) {
    const at = new Date(start + call * 40_000).toISOString();
    const inputTokens = c.firstInput + call * 1500;
    const outputTokens = 400 + ((call * 137) % 900);
    // A model of about $3 per million tokens in and $15 out; a credit is a cent.
    const nanoAiu = Math.round(((inputTokens * 3 + outputTokens * 15) / 1e6) * 100 * 1e9);
    const usage = {
      inputTokens,
      outputTokens,
      cost: 1,
      initiator: call === 0 ? "user" : "agent",
      toolTokenCount: TOOL_DEFINITION_TOKENS,
      aiCreditsStatus: "complete",
      copilotUsage: { totalNanoAiu: nanoAiu },
      accounting: { sourceSessionId: id, sequence: call + 1 },
    };
    out.push(JSON.stringify({ type: "session.usage_record", data: { usage }, timestamp: at }));
    const tool = toolCalls[call];
    if (tool === undefined) continue;
    // An MCP tool is `<server>-<tool>` to the model; a built-in one has no dash.
    const dash = tool.indexOf("-");
    const toolCallId = `call_${call}`;
    const mcp = dash < 0 ? {} : { mcpServerName: tool.slice(0, dash), mcpToolName: tool.slice(dash + 1) };
    const started = { toolCallId, toolName: tool, ...mcp };
    const failed = tool === "trackwall-run_mise_task" && call % 2 === 0;
    const metrics = failed ? {} : { result_token_count: RESULT_TOKENS[tool] ?? 500 };
    out.push(JSON.stringify({ type: "tool.execution_start", data: started, timestamp: at }));
    out.push(
      JSON.stringify({
        type: "tool.execution_complete",
        data: { toolCallId, success: !failed, toolTelemetry: { metrics } },
        timestamp: at,
      }),
    );
  }
  return out;
}

/** Writes the conversations into `copilotHome`, each in its own folder as Copilot CLI keeps them. */
export function writeDemoUsage(copilotHome: string, conversations: readonly DemoConversation[]): void {
  const now = Date.now();
  conversations.forEach((c, i) => {
    const id = `demo-conversation-${i + 1}`;
    const log = conversationEventLog(copilotHome, id);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, `${lines(id, c, now).join("\n")}\n`);
    const branch = c.branch === null ? "" : `branch: ${c.branch}\n`;
    writeFileSync(join(dirname(log), "workspace.yaml"), `cwd: ${JSON.stringify(c.cwd)}\n${branch}`);
  });
}

/** The demo's week: its tasks, the supervisor, sessions in a few repos, and one Copilot CLI outside the projects folder. */
export function demoWeek(o: {
  projectsDir: string;
  outside: string;
  tasks: readonly { worktree: string; branch: string }[];
}): DemoConversation[] {
  const repo = (name: string) => join(o.projectsDir, name);
  const taskShapes: Omit<DemoConversation, "cwd" | "branch">[] = [
    {
      daysAgo: 1,
      modelCalls: 34,
      firstInput: 31_000,
      tools: { "trackwall-search_code": 9, view: 12, edit: 6, "trackwall-run_mise_task": 4 },
    },
    { daysAgo: 2, modelCalls: 22, firstInput: 29_000, tools: { "trackwall-get_task_changes": 3, view: 8, grep: 5, edit: 4 } },
    { daysAgo: 3, modelCalls: 15, firstInput: 28_000, tools: { "tracker-get_issue": 2, "trackwall-find_endpoint": 3, view: 6, edit: 3 } },
    { daysAgo: 4, modelCalls: 9, firstInput: 27_500, tools: { "trackwall-who_calls": 2, view: 4, bash: 2 } },
  ];
  return [
    ...o.tasks.map((t, i): DemoConversation => {
      const shape = taskShapes[i % taskShapes.length];
      if (shape === undefined) throw new Error("no shape for a demo task");
      return { cwd: t.worktree, branch: t.branch, ...shape };
    }),
    {
      cwd: o.projectsDir,
      branch: null,
      daysAgo: 1,
      modelCalls: 18,
      firstInput: 30_000,
      tools: { "trackwall-list_repos": 3, "tracker-get_issue": 4, "trackwall-search_code": 3, "trackwall-get_repo": 5 },
    },
    {
      cwd: repo("payments"),
      branch: "main",
      daysAgo: 2,
      modelCalls: 6,
      firstInput: 26_000,
      tools: { "trackwall-who_calls": 2, "trackwall-find_endpoint": 2 },
    },
    {
      cwd: repo("orders-api"),
      branch: "main",
      daysAgo: 5,
      modelCalls: 11,
      firstInput: 26_500,
      tools: { view: 5, grep: 3, "trackwall-search_code": 2 },
    },
    { cwd: o.outside, branch: "main", daysAgo: 6, modelCalls: 4, firstInput: 24_000, tools: { view: 2, bash: 1 } },
  ];
}
