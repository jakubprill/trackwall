/**
 * The fake Copilot CLI's ACP mode (`copilot --acp`, ADR-107), which `fake-copilot-session.ts` runs when it gets `--acp`:
 * JSON-RPC over newline-delimited JSON on stdin and stdout, with the messages Copilot CLI 1.0.105 sends
 * (`contract/acp-session.contract.ts` checks the daemon against the real one). Every prompt is a turn in which the
 * agent runs one shell command: a `tool_call`, its `session/request_permission` (none with `--allow-all-tools`), and
 * the command's result and an answer that repeats the prompt, or its refusal, which ends the turn. The first answer of a session also names the
 * MCP servers, instruction files and arguments it got, so that the tests see them. `session/cancel` ends the turn with
 * `cancelled`. Like Copilot CLI it keeps a conversation per id once it has had a prompt, which `session/load` replays
 * (one from the terminal mode with nothing to replay), and an id without one is error -32002.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** The command of every turn; the tests look for it in the approval and the conversation. */
export const FAKE_ACP_COMMAND = "echo made-by-agent";

const Message = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
});
const PromptParams = z.object({ sessionId: z.string(), prompt: z.array(z.object({ type: z.string(), text: z.string().optional() })) });
const SessionParams = z.object({ sessionId: z.string() });
const PermissionAnswer = z.object({
  outcome: z.union([z.object({ outcome: z.literal("selected"), optionId: z.string() }), z.object({ outcome: z.literal("cancelled") })]),
});
const Updates = z.array(z.record(z.string(), z.unknown()));

/** The terminal mode's folder: a conversation of either mode goes on in the other, as in Copilot CLI (an empty file is one from a terminal). */
const conversationsDir = join(tmpdir(), "trackwall-fake-copilot-conversations");
const conversationFile = (id: string) => join(conversationsDir, id);

export interface FakeAcpOptions {
  mcpServers: readonly string[];
  instructionFiles: readonly string[];
  args: readonly string[];
  allowAllTools: boolean;
}

export function serveAcp(o: FakeAcpOptions): void {
  let buffer = "";
  let nextRequest = 0;
  const answers = new Map<number | string, (result: unknown) => void>();
  /** The updates of each conversation, which a `session/load` replays. */
  const conversations = new Map<string, Record<string, unknown>[]>();
  const turns = new Map<string, { end: (stopReason: string) => void; cancelled: boolean }>();
  let firstAnswer = true;
  let calls = 0;

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
    const text = blocks.map((b) => b.text ?? "").join("");
    let turn = { end: (_: string) => {}, cancelled: false };
    const ended = new Promise<string>((resolve) => {
      turn = { end: resolve, cancelled: false };
    });
    turns.set(sessionId, turn);
    if (history.length === 0) update(sessionId, { sessionUpdate: "session_info_update", title: text.slice(0, 50) });
    history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    writeFileSync(conversationFile(sessionId), JSON.stringify(history));
    void (async () => {
      const toolCallId = `call_${++calls}_0`;
      const rawInput = { command: FAKE_ACP_COMMAND, description: "Make a file" };
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Make a file", kind: "execute", status: "pending", rawInput });
      const allowed = o.allowAllTools || (await permission(sessionId, toolCallId));
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
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [toolText("made-by-agent\n")] });
      const about = firstAnswer
        ? `\n\nMCP: ${o.mcpServers.join(", ")}\nInstructions: ${o.instructionFiles.join(", ")}\n${o.args.map((a) => `Argument: ${a}`).join("\n")}`
        : "";
      firstAnswer = false;
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Thinking about: ${text}` } });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: about } });
      writeFileSync(conversationFile(sessionId), JSON.stringify(history));
      turn.end("end_turn");
    })();
    const stopReason = await ended;
    turns.delete(sessionId);
    send({ id, result: { stopReason } });
  }

  async function permission(sessionId: string, toolCallId: string): Promise<boolean> {
    const answer = PermissionAnswer.parse(
      await ask("session/request_permission", {
        sessionId,
        toolCall: { toolCallId, title: "Make a file", kind: "execute", status: "pending", rawInput: { command: FAKE_ACP_COMMAND } },
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
    send({ id, result: {} });
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
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Copilot" } } }),
    "session/new": (id) => {
      const sessionId = randomUUID();
      conversations.set(sessionId, []);
      mkdirSync(conversationsDir, { recursive: true });
      send({ id, result: { sessionId } });
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

function toolText(text: string) {
  return { type: "content", content: { type: "text", text } };
}
