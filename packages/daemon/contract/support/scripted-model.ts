/**
 * A stand-in for the model behind the real Copilot CLI in the contract tests (ADR-67): an OpenAI-compatible
 * chat-completions endpoint on 127.0.0.1 that Copilot CLI reaches in BYOK mode (`COPILOT_PROVIDER_BASE_URL`). Each
 * request takes the next reply the test queued, so the agent's turn is known in advance; every request is kept, so
 * the test sees what Copilot CLI sent the model (the prompt, the instructions, the tools, the tool results).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { jsonOf } from "../../src/modules/agents/json.ts";

/** The model's answer to one request: text that ends the turn, or a call of one tool. */
type ModelReply = { text: string } | { tool: string; arguments: Record<string, unknown> };

const Content = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() })), z.null()]);
const Message = z.object({
  role: z.string(),
  content: Content.optional(),
});
const Request = z.object({
  messages: z.array(Message),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).default([]),
  stream: z.boolean().optional(),
});

/** One request Copilot CLI sent the model, with the texts the tests ask about. */
export interface ModelRequest {
  /** The system prompt (with the custom instructions in it). */
  system: string;
  /** The text of the last message from the user. */
  lastUserText: string;
  /** The tool results since the last assistant message, in order. */
  toolResults: string[];
  /** The tool names the model may call. */
  tools: string[];
}

function text(content: z.infer<typeof Content> | undefined): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => part.text ?? "").join("");
}

function summarize(request: z.infer<typeof Request>): ModelRequest {
  const { messages } = request;
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  return {
    system: messages
      .filter((m) => m.role === "system")
      .map((m) => text(m.content))
      .join("\n"),
    lastUserText: text(messages.findLast((m) => m.role === "user")?.content),
    toolResults: messages
      .slice(lastAssistant + 1)
      .filter((m) => m.role === "tool")
      .map((m) => text(m.content)),
    tools: request.tools.map((t) => t.function.name),
  };
}

type QueuedReply = ModelReply | ((request: ModelRequest) => ModelReply);

/** The chat-completions answer as a stream of chunks, which is what Copilot CLI asks for. */
function answer(res: ServerResponse, reply: ModelReply, callId: string): void {
  const { delta, finish } =
    "text" in reply
      ? { delta: { role: "assistant", content: reply.text }, finish: "stop" }
      : {
          delta: {
            role: "assistant",
            tool_calls: [
              { index: 0, id: callId, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.arguments) } },
            ],
          },
          finish: "tool_calls",
        };
  const base = { id: callId, object: "chat.completion.chunk", created: 0, model: SCRIPTED_MODEL };
  const chunks = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`);
}

/** The model name Copilot CLI sends (`COPILOT_MODEL`); outside its catalog, so it uses default token limits. */
export const SCRIPTED_MODEL = "trackwall-scripted-model";

export async function startScriptedModel() {
  const queue: QueuedReply[] = [];
  const requests: ModelRequest[] = [];
  /** What went wrong with a request: none queued for it, or one the stand-in does not understand. */
  const problems: string[] = [];

  /** A request the test did not plan for: the test fails on `problems`, and Copilot CLI shows a model error. */
  function refuse(res: ServerResponse, problem: string): void {
    problems.push(problem);
    // `answer` threw after writing the headers: the stream can only be cut short.
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `scripted model: ${problem}` } }));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return refuse(res, `${req.method} ${req.url}`);
    const parsed = jsonOf(Request).safeParse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed.success) return refuse(res, `a request it cannot read: ${parsed.error.message}`);
    if (parsed.data.stream !== true) return refuse(res, "a request without streaming");
    const request = summarize(parsed.data);
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) return refuse(res, `no reply queued for the request after "${request.lastUserText.slice(-80)}"`);
    answer(res, typeof next === "function" ? next(request) : next, `call_${requests.length}`);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => refuse(res, String(err)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    /** The base URL for `COPILOT_PROVIDER_BASE_URL`. */
    url: `http://127.0.0.1:${port}/v1`,
    /** Queues the replies to the next requests, in order; a function picks the reply from the request. */
    reply(...replies: QueuedReply[]) {
      queue.push(...replies);
    },
    requests: () => [...requests],
    /**
     * What a test leaves behind, and clears it for the next test of the same model: refused requests and replies
     * queued but never asked for.
     */
    takeLeftovers: () => ({ problems: problems.splice(0), unusedReplies: queue.splice(0).length }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type ScriptedModel = Awaited<ReturnType<typeof startScriptedModel>>;
