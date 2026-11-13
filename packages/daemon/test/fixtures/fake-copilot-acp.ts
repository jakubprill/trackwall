/**
 * The fake Copilot CLI's ACP mode (`copilot --acp`, ADR-107), which `fake-copilot-session.ts` runs when it gets `--acp`:
 * JSON-RPC over newline-delimited JSON on stdin and stdout, with the messages Copilot CLI 1.0.105 sends
 * (`contract/acp-session.contract.ts` checks the daemon against the real one). Every prompt is a turn in which the
 * agent runs one shell command: a `tool_call`, its `session/request_permission` (none with `--allow-all-tools`), and
 * the command's result and an answer that repeats the prompt, or its refusal, which ends the turn. Like Copilot CLI it fires
 * the session plugin's `userPromptSubmitted` hook with each prompt, and the answer also repeats the context the hook gave
 * (ADR-148), which Copilot CLI gives the model and nobody sees. The first answer of a session also names the
 * MCP servers, instruction files and arguments it got, so that the tests see them. `session/cancel` ends the turn with
 * `cancelled`. Like Copilot CLI it keeps a conversation per id once it has had a prompt, which `session/load` replays
 * (one from the terminal mode with nothing to replay), and an id without one is error -32002.
 *
 * A prompt that starts with `Edit ` asks to edit `README.md` in its working directory instead of running the command,
 * and its input and result carry the change as `git diff` text, as Copilot CLI's edit tool does in the probe of ADR-107
 * (`test/acp-tool-call.test.ts` has the same shapes); the file stays as it is.
 *
 * A prompt that starts with `/review` is an automatic review (ADR-182): the agent asks to run its shell command, then
 * reads the diff file the prompt names and answers with one issue in the format of Copilot CLI's review agent on the first added line of the diff file the prompt
 * names (`FAKE_COPILOT_REVIEW_FILE` names another one), followed by whether the command was allowed, the arguments it
 * got and the variables `FAKE_COPILOT_SHOW_ENV` names. With `FAKE_COPILOT_REVIEW_WAIT` set the review never ends on its own.
 *
 * A prompt that asks to check a change against the repo's rules (ADR-234) is answered like a model that reads them: in
 * every rule file the prompt lists, read from the folder it names, a line `Never add \`<text>\`` is a rule, and each
 * added line of the diff file that holds `<text>` is a violation in the format the prompt asks for, quoting the rule;
 * without one it answers that it found none. The answer ends with the rule files it read and its arguments.
 *
 * A prompt that asks to explain a change (ADR-249) is answered in the three sections the prompt asks for: the first line
 * of the task's prompt it quotes, and each file the diff file (or `FAKE_COPILOT_REVIEW_FILE`) changes with its count of
 * added lines, then its arguments.
 *
 * Like Copilot CLI over ACP, a review, a check or an explanation asks before it reads a file outside its working directory, whatever
 * `--add-dir` says (`contract/auto-review.contract.ts`): a `read` approval named "Access paths outside trusted
 * directories" with the file's path; refused, it ends the turn without an answer.
 *
 * Like Copilot CLI it answers `session/new` and `session/load` with the agent's modes (Agent, Plan, Autopilot), offers two slash commands
 * at once, switches the mode on `session/set_config_option`, in Plan mode runs no tool and answers with
 * `FAKE_ACP_PLAN` and the prompt's first line, as an agent that writes a plan and changes nothing (ADR-229), and says after each turn how much context it uses
 * (1000 tokens a turn of 128000). It takes images in a prompt, and its answer names each block after the first: an
 * image by its type, a text block by its first line.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isInside } from "../../src/infra/path-inside.ts";
import { recordUsage } from "../support/copilot-usage-receipt.ts";

/** The command of every turn; the tests look for it in the approval and the conversation. */
export const FAKE_ACP_COMMAND = "echo made-by-agent";

/** A rule the fake's check against the repo's rules understands: an added line must not hold the quoted text. */
export const FAKE_RULE = /Never add `([^`]+)`/;

/** The line a prompt that starts with `Edit ` adds to `README.md`, after its first line. */
export const FAKE_ACP_EDIT_LINE = "Edited by the agent.";

/** How the fake's answer in Plan mode starts; the tests look for it in the conversation. */
export const FAKE_ACP_PLAN = "Plan for:";

/** A tool the fake calls, as `tool_call` and `session/request_permission` name it. */
type FakeToolCall = { title: string; kind: string; rawInput: Record<string, string>; locations?: { path: string }[] };

/** The shell command every turn runs, as it is called and what it gives back. */
const SHELL_TOOL: { call: FakeToolCall; result: Record<string, unknown> } = {
  call: { title: "Make a file", kind: "execute", rawInput: { command: FAKE_ACP_COMMAND, description: "Make a file" } },
  result: { content: [toolText("made-by-agent\n")] },
};

/**
 * The tool of a turn, as it is called and what it gives back: the shell command, or the edit of `README.md` for a
 * prompt that starts with `Edit `.
 */
function turnTool(prompt: string): typeof SHELL_TOOL {
  if (!prompt.startsWith("Edit ")) return SHELL_TOOL;
  const path = join(process.cwd(), "README.md");
  const diff = `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n # shop\n+${FAKE_ACP_EDIT_LINE}\n`;
  return {
    call: { title: "Edit file", kind: "edit", rawInput: { fileName: path, diff }, locations: [{ path }] },
    result: { content: [toolText("File edited.")], rawOutput: { content: "File edited.", detailedContent: diff } },
  };
}

const Message = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
});
const PromptParams = z.object({
  sessionId: z.string(),
  prompt: z.array(z.object({ type: z.string(), text: z.string().optional(), mimeType: z.string().optional() })),
});
const SessionParams = z.object({ sessionId: z.string() });
const PermissionAnswer = z.object({
  outcome: z.union([z.object({ outcome: z.literal("selected"), optionId: z.string() }), z.object({ outcome: z.literal("cancelled") })]),
});
const Updates = z.array(z.record(z.string(), z.unknown()));

const MODE_URL = "https://agentclientprotocol.com/protocol/session-modes#";
const PLAN_MODE = `${MODE_URL}plan`;
const MODES = [
  { value: `${MODE_URL}agent`, name: "Agent", description: "Default agent mode for conversational interactions" },
  { value: PLAN_MODE, name: "Plan", description: "Plan mode for creating and executing multi-step plans" },
  { value: `${MODE_URL}autopilot`, name: "Autopilot", description: "Autonomous mode that enables allow-all" },
];
/** The slash commands the fake offers; the tests look for them in the view. */
export const FAKE_ACP_COMMANDS = [
  { name: "compact", description: "Summarize conversation history to reduce context window usage.", input: { hint: "focus instructions" } },
  { name: "review", description: "Run code review agent to analyze changes" },
];
const SetConfigParams = z.object({ sessionId: z.string(), configId: z.string(), value: z.string() });

/** The terminal mode's folder: a conversation of either mode goes on in the other, as in Copilot CLI (an empty file is one from a terminal). */
const conversationsDir = join(tmpdir(), "trackwall-fake-copilot-conversations");
const conversationFile = (id: string) => join(conversationsDir, id);

export interface FakeAcpOptions {
  mcpServers: readonly string[];
  instructionFiles: readonly string[];
  args: readonly string[];
  allowAllTools: boolean;
  /** Fires the session plugin's hooks of an event and returns their outputs (`pluginHooks`). */
  fire: (event: string, payload: Record<string, unknown>) => Record<string, unknown>[];
}

const HookContext = z.object({ additionalContext: z.string() });

export function serveAcp(o: FakeAcpOptions): void {
  let buffer = "";
  let nextRequest = 0;
  const answers = new Map<number | string, (result: unknown) => void>();
  /** The updates of each conversation, which a `session/load` replays. */
  const conversations = new Map<string, Record<string, unknown>[]>();
  const turns = new Map<string, { end: (stopReason: string) => void; cancelled: boolean }>();
  let firstAnswer = true;
  let calls = 0;
  let mode = MODES[0]?.value ?? "";
  let turnsDone = 0;
  const configOptions = () => [
    { type: "select", id: "mode", name: "Mode", category: "mode", currentValue: mode, options: MODES },
    { type: "select", id: "allow_all", name: "Allow All", category: "permissions", currentValue: "off", options: [] },
  ];

  const send = (message: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const update = (sessionId: string, u: Record<string, unknown>) => {
    conversations.get(sessionId)?.push(u);
    send({ method: "session/update", params: { sessionId, update: u } });
  };
  const ask = (method: string, params: unknown) =>
    new Promise<unknown>((resolve) => {
      const id = nextRequest++;
      answers.set(id, resolve);
      send({ id, method, params });
    });

  async function prompt(id: number | string, params: unknown): Promise<void> {
    const { sessionId, prompt: blocks } = PromptParams.parse(params);
    const history = conversations.get(sessionId);
    if (history === undefined) {
      notFound(id, sessionId);
      return;
    }
    const [first, ...attached] = blocks;
    const text = first?.text ?? "";
    // What came with the prompt, as the answer names it: an image by its type, a text block by its first line.
    const attachments = attached
      .map((b) => (b.type === "image" ? `Image: ${b.mimeType ?? "?"}` : `Text: ${(b.text ?? "").split("\n")[0]}`))
      .map((line) => `\n${line}`)
      .join("");
    const context = o
      .fire("userPromptSubmitted", { prompt: text, cwd: process.cwd() })
      .flatMap((output) => {
        const parsed = HookContext.safeParse(output);
        return parsed.success ? [`\n\nPrompt context: ${parsed.data.additionalContext}`] : [];
      })
      .join("");
    let turn = { end: (_: string) => {}, cancelled: false };
    const ended = new Promise<string>((resolve) => {
      turn = { end: resolve, cancelled: false };
    });
    turns.set(sessionId, turn);
    if (history.length === 0) update(sessionId, { sessionUpdate: "session_info_update", title: text.slice(0, 50) });
    history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    writeFileSync(conversationFile(sessionId), JSON.stringify(history));
    if (text.startsWith("/review")) void review(sessionId, text, turn);
    else if (text.startsWith("Check whether a change keeps the written rules")) void rulesCheck(sessionId, text, turn);
    else if (text.startsWith("Explain a change")) void explanation(sessionId, text, turn);
    else if (mode === PLAN_MODE) {
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `${FAKE_ACP_PLAN} ${text.split("\n")[0]}` },
      });
      turn.end("end_turn");
    } else
      void (async () => {
        const toolCallId = `call_${++calls}_0`;
        const tool = turnTool(text);
        update(sessionId, { sessionUpdate: "tool_call", toolCallId, ...tool.call, status: "pending" });
        const allowed = o.allowAllTools || (await permission(sessionId, toolCallId, tool.call));
        if (turn.cancelled) return;
        if (!allowed) {
          // As in Copilot CLI, a refused tool ends the turn without another answer.
          update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            rawOutput: { message: "The user rejected this tool call.", code: "rejected" },
          });
          turn.end("end_turn");
          return;
        }
        update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          ...tool.result,
        });
        const about = firstAnswer
          ? `\n\nMCP: ${o.mcpServers.join(", ")}\nInstructions: ${o.instructionFiles.join(", ")}\n${o.args.map((a) => `Argument: ${a}`).join("\n")}`
          : "";
        firstAnswer = false;
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Thinking about: ${text}${attachments}${context}` },
        });
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: about } });
        // Copilot CLI sends the model's reasoning of a reply after the reply's text (`contract/acp-session.contract.ts`).
        update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `Reasoning about: ${text}` } });
        writeFileSync(conversationFile(sessionId), JSON.stringify(history));
        turn.end("end_turn");
      })();
    const stopReason = await ended;
    recordUsage(sessionId);
    turns.delete(sessionId);
    turnsDone += 1;
    update(sessionId, { sessionUpdate: "usage_update", used: 1000 * turnsDone, size: 128_000 });
    send({ id, result: { stopReason } });
  }

  async function review(sessionId: string, text: string, turn: { end: (stopReason: string) => void; cancelled: boolean }): Promise<void> {
    if (process.env.FAKE_COPILOT_REVIEW_WAIT !== undefined) return;
    const allowed = o.allowAllTools || (await permission(sessionId, `call_${++calls}_0`, SHELL_TOOL.call));
    if (turn.cancelled) return;
    const diffFile = process.env.FAKE_COPILOT_REVIEW_FILE ?? /in the file `([^`]+)`/.exec(text)?.[1] ?? "";
    const diff = await readOutside(sessionId, diffFile);
    if (turn.cancelled) return;
    if (diff === undefined) {
      turn.end("end_turn");
      return;
    }
    const added = firstAddedLine(diff);
    const issue = added
      ? [
          `## Issue: Fake finding in ${added.path}`,
          `**File:** ${join(process.cwd(), added.path)}:${added.line}`,
          "**Severity:** High",
          `**Problem:** The fake reviewer flags line ${added.line}.`,
          "**Evidence:** It always does.",
          "**Suggested fix:** Look at it again.",
        ].join("\n")
      : "No significant issues found in the reviewed changes.";
    const shownEnv = (process.env.FAKE_COPILOT_SHOW_ENV ?? "").split(",").filter((name) => name !== "");
    const about = [
      `Shell: ${allowed ? "allowed" : "refused"}`,
      ...o.args.map((a) => `Argument: ${a}`),
      ...shownEnv.map((name) => `Env ${name}=${process.env[name] ?? ""}`),
    ].join("\n");
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${issue}\n\n${about}` } });
    turn.end("end_turn");
  }

  async function rulesCheck(sessionId: string, text: string, turn: { end: (stopReason: string) => void }): Promise<void> {
    if (process.env.FAKE_COPILOT_REVIEW_WAIT !== undefined) return;
    const ruleFiles = [...text.matchAll(/^- (.+)$/gm)].map((match) => match[1] ?? "");
    const read = await readCheckInputs(sessionId, text, ruleFiles);
    if (read !== undefined) {
      const added = addedLines(read.diff);
      const issues = read.rules.flatMap(([file, content]) => violations(file, content, added));
      const answer = issues.length > 0 ? issues.join("\n\n") : "No rule violations found.";
      const about = [`Rules read: ${ruleFiles.join(", ")}`, ...o.args.map((a) => `Argument: ${a}`)].join("\n");
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${answer}\n\n${about}` } });
    }
    turn.end("end_turn");
  }

  async function explanation(sessionId: string, text: string, turn: { end: (stopReason: string) => void }): Promise<void> {
    if (process.env.FAKE_COPILOT_REVIEW_WAIT !== undefined) return;
    const diff = await readOutside(sessionId, process.env.FAKE_COPILOT_REVIEW_FILE ?? /in the file `([^`]+)`/.exec(text)?.[1] ?? "");
    if (diff !== undefined) {
      const task = /^`{3,}text\n(.*)$/m.exec(text)?.[1] ?? "";
      const counts = new Map<string, number>();
      for (const { path } of addedLines(diff)) counts.set(path, (counts.get(path) ?? 0) + 1);
      const answer = [
        "## Summary",
        `The change does what the task asks: ${task}`,
        "## Changes",
        ...[...counts].map(([path, count]) => `- \`${path}\`: ${count} added ${count === 1 ? "line" : "lines"}.`),
        "## Worth a closer look",
        "Nothing stands out.",
        "",
        ...o.args.map((a) => `Argument: ${a}`),
      ].join("\n");
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
    }
    turn.end("end_turn");
  }

  /** The diff and the rule files a check reads, by the paths its prompt names; `undefined` once a read is refused. */
  async function readCheckInputs(
    sessionId: string,
    text: string,
    ruleFiles: readonly string[],
  ): Promise<{ diff: string; rules: [string, string][] } | undefined> {
    const rulesDir = /copied into the folder `([^`]+)`/.exec(text)?.[1] ?? "";
    const diff = await readOutside(sessionId, /in the file `([^`]+)`/.exec(text)?.[1] ?? "");
    if (diff === undefined) return undefined;
    const rules: [string, string][] = [];
    for (const file of ruleFiles) {
      const content = await readOutside(sessionId, join(rulesDir, ...file.split("/")));
      if (content === undefined) return undefined;
      rules.push([file, content]);
    }
    return { diff, rules };
  }

  /**
   * A file the review reads, `""` for one that is not there; outside the working directory only after an approval, as
   * Copilot CLI asks for it, and `undefined` when that is refused.
   */
  async function readOutside(sessionId: string, path: string): Promise<string | undefined> {
    if (!isInside(process.cwd(), path)) {
      const read = { title: "Access paths outside trusted directories", kind: "read", rawInput: { path }, locations: [{ path }] };
      if (!(await permission(sessionId, `call_${++calls}_0`, read))) return undefined;
    }
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  async function permission(sessionId: string, toolCallId: string, tool: FakeToolCall): Promise<boolean> {
    const answer = PermissionAnswer.parse(
      await ask("session/request_permission", {
        sessionId,
        toolCall: { toolCallId, ...tool, status: "pending" },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
          { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
          { optionId: "reject_once", kind: "reject_once", name: "Deny" },
        ],
      }),
    );
    return answer.outcome.outcome === "selected" && answer.outcome.optionId.startsWith("allow");
  }

  function load(id: number | string, params: unknown): void {
    const { sessionId } = SessionParams.parse(params);
    if (!existsSync(conversationFile(sessionId))) {
      notFound(id, sessionId);
      return;
    }
    const saved = readFileSync(conversationFile(sessionId), "utf8");
    const history = saved === "" ? [] : Updates.parse(JSON.parse(saved));
    conversations.set(sessionId, []);
    for (const u of history) update(sessionId, u);
    // A loaded conversation starts in Agent mode, as the process does (`contract/acp-session.contract.ts`).
    send({ id, result: { configOptions: configOptions() } });
  }

  function cancel(params: unknown): void {
    const { sessionId } = SessionParams.parse(params);
    const turn = turns.get(sessionId);
    if (turn === undefined) return;
    turn.cancelled = true;
    turn.end("cancelled");
  }

  /** Copilot CLI's answer to an id it keeps no conversation of. */
  function notFound(id: number | string, sessionId: string): void {
    send({ id, error: { code: -32002, message: `Session ${sessionId} not found` } });
  }

  /** The requests the fake answers, by method. */
  const requests: Record<string, (id: number | string, params: unknown) => void> = {
    initialize: (id) =>
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          agentInfo: { name: "Copilot" },
        },
      }),
    "session/new": (id) => {
      const sessionId = randomUUID();
      conversations.set(sessionId, []);
      mkdirSync(conversationsDir, { recursive: true });
      send({ id, result: { sessionId, configOptions: configOptions() } });
      send({
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: FAKE_ACP_COMMANDS } },
      });
    },
    "session/set_config_option": (id, params) => {
      const { sessionId, configId, value } = SetConfigParams.parse(params);
      if (configId !== "mode" || !MODES.some((m) => m.value === value)) {
        send({ id, error: { code: -32602, message: `Invalid value for ${configId}` } });
        return;
      }
      mode = value;
      send({
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "config_option_update", configOptions: configOptions() } },
      });
      send({ id, result: { configOptions: configOptions() } });
    },
    "session/load": load,
    "session/prompt": (id, params) => void prompt(id, params),
  };

  function handle({ id, method, params, result }: z.infer<typeof Message>): void {
    if (method === undefined) {
      if (id !== undefined) answers.get(id)?.(result);
    } else if (method === "session/cancel") {
      cancel(params);
    } else if (id !== undefined) {
      const answer = requests[method];
      if (answer) answer(id, params);
      else send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim() !== "") handle(Message.parse(JSON.parse(line)));
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(143));
}

/** The first added line of a unified diff: its file and its number in the new file. */
function firstAddedLine(diff: string): { path: string; line: number } | undefined {
  return addedLines(diff)[0];
}

type AddedLine = { path: string; line: number; text: string };

/** The lines a unified diff adds, with their file and line number in it. */
function addedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  const at = { path: "", line: 0 };
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (text.startsWith("+++ ")) at.path = text.startsWith("+++ b/") ? text.slice("+++ b/".length) : "";
    else if (hunk) at.line = Number(hunk[1]);
    else if (text.startsWith("+") && at.path !== "") added.push({ path: at.path, line: at.line++, text: text.slice(1) });
    else if (!text.startsWith("-") && at.line > 0) at.line++;
  }
  return added;
}

/** The fake's check of `added` against the rules of rule file `file`, each violation in the format the prompt asks for. */
function violations(file: string, rules: string, added: readonly AddedLine[]): string[] {
  return rules.split("\n").flatMap((rule) => {
    const forbidden = FAKE_RULE.exec(rule)?.[1];
    if (forbidden === undefined) return [];
    return added
      .filter((line) => line.text.includes(forbidden))
      .map((line) =>
        [
          `## Issue: ${forbidden} added`,
          `**File:** ${line.path}:${line.line}`,
          "**Severity:** Medium",
          `**Rule:** ${file}: "${rule.trim()}"`,
          `**Problem:** Line ${line.line} adds ${forbidden}.`,
          "**Suggested fix:** Take it out.",
        ].join("\n"),
      );
  });
}

function toolText(text: string) {
  return { type: "content", content: { type: "text", text } };
}
