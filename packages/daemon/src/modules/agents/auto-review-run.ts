import type { RunState } from "@trackwall/protocol";
import { AcpConnection } from "./acp-connection.ts";
import {
  ACP_PROTOCOL_VERSION,
  contentText,
  InitializeResult,
  NewSessionResult,
  type PermissionOutcome,
  PromptResult,
  RequestPermissionParams,
  SessionUpdate,
  SessionUpdateParams,
} from "./acp-messages.ts";

/**
 * One automatic review (ADR-182): Copilot CLI over ACP in the task's worktree, with only the tools that read
 * (`REVIEWER_TOOLS`), no MCP server and every approval refused, sent `/review` once; its answer is the text of that one
 * turn. The run is not a session: nobody sees or steers it, so it is not on the session list and gets no session token,
 * plugin or instructions. It ends when the turn does, when the process ends, or at `REVIEW_LIMIT_MS`; the caller stops
 * the process group either way.
 */

/**
 * The only tools the reviewer's model gets (`--available-tools`): reading files and searching them, and the `task` tool
 * through which `/review` starts Copilot CLI's review agent, which gets the same ones. No shell, no file changes, no web
 * and no MCP server's tools, which the list leaves out too.
 */
export const REVIEWER_TOOLS = ["view", "grep", "glob", "task", "read_agent", "list_agents"] as const;

/**
 * Copilot CLI's arguments of a review, besides the session's mise arguments: only `REVIEWER_TOOLS`, the denials as a
 * second fence should a later Copilot CLI give a tool under another name, no built-in MCP servers, no questions to
 * the user nobody would see, and no access to the system's temporary folder; `reviewDir` (the diff) is the only folder
 * besides the worktree it may read.
 */
export function reviewerArgs(reviewDir: string): string[] {
  return [
    "--acp",
    `--available-tools=${REVIEWER_TOOLS.join(",")}`,
    "--deny-tool=shell",
    "--deny-tool=write",
    "--deny-tool=url",
    "--disable-builtin-mcps",
    "--no-ask-user",
    "--disallow-temp-dir",
    `--add-dir=${reviewDir}`,
  ];
}

/** How long a review may take: Copilot CLI's review agent reads a large change for minutes. */
const REVIEW_LIMIT_MS = 15 * 60_000;
/** How often the run checks that the process still runs. */
const PROCESS_CHECK_MS = 200;
/** Text past this is not kept while the turn runs: the review keeps `AUTO_REVIEW_TEXT_MAX`, the parser reads a little more. */
const ANSWER_MAX_CHARS = 100_000;

/** What a run needs from `procs`. */
export interface ReviewRunProcs {
  startChannel(spec: {
    owner: string;
    command: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    secrets: readonly string[];
    onStdout: (chunk: Buffer) => void;
  }): Promise<{ run: RunState; channel: { write(data: string): void } }>;
  state(owner: string): RunState | undefined;
}

export interface ReviewRun {
  /** The process group's owner in `procs`, which the caller stops. */
  owner: string;
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  secrets: readonly string[];
  /** The text of the one prompt: `/review` with the daemon's instructions. */
  prompt: string;
  /** Overrides `REVIEW_LIMIT_MS` (tests). */
  limitMs?: number;
}

/** What a review's turn gave: the answer, and the titles of the approvals the daemon refused, in order. */
export interface ReviewOutcome {
  answer: string;
  refused: string[];
}

/** Starts the reviewer, sends the prompt and returns what its turn gave; throws when the turn does not end normally. */
export async function runReview(run: ReviewRun, procs: ReviewRunProcs, log: (msg: string) => void): Promise<ReviewOutcome> {
  const decoder = new TextDecoder();
  let conversation: string | undefined;
  const answer = new ReviewAnswer();
  const refused: string[] = [];
  let channel: { write(data: string): void } | undefined;
  const connection = new AcpConnection({
    write: (line) => channel?.write(line),
    onNotification: (method, params) => {
      const update = method === "session/update" ? updateOf(params, conversation) : undefined;
      if (update !== undefined) answer.add(update);
    },
    onRequest: async (method, params) => {
      const { title, outcome } = refusal(method, params);
      refused.push(title);
      log(`automatic review: refused the reviewer's request "${title}"`);
      return { outcome };
    },
    log,
  });
  ({ channel } = await procs.startChannel({
    owner: run.owner,
    command: run.command,
    cwd: run.cwd,
    env: run.env,
    secrets: run.secrets,
    onStdout: (chunk) => connection.feed(decoder.decode(chunk, { stream: true })),
  }));
  const started = Date.now();
  const limitMs = run.limitMs ?? REVIEW_LIMIT_MS;
  const watch = setInterval(() => {
    if (procs.state(run.owner)?.kind === "exited" || Date.now() - started > limitMs) connection.close();
  }, PROCESS_CHECK_MS);
  try {
    const agent = InitializeResult.parse(
      await connection.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
    );
    if (agent.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw new Error(`Copilot CLI speaks ACP version ${agent.protocolVersion}, not ${ACP_PROTOCOL_VERSION}`);
    conversation = NewSessionResult.parse(await connection.request("session/new", { cwd: run.cwd, mcpServers: [] })).sessionId;
    const result = PromptResult.parse(
      await connection.request("session/prompt", { sessionId: conversation, prompt: [{ type: "text", text: run.prompt }] }),
    );
    if (result.stopReason !== "end_turn") throw new Error(`the reviewer's turn ended with ${result.stopReason}`);
    return { answer: answer.text(), refused };
  } catch (err) {
    if (Date.now() - started > limitMs) throw new Error(`the review took longer than ${Math.round(limitMs / 60_000)} minutes`);
    throw err;
  } finally {
    clearInterval(watch);
    connection.close();
  }
}

/** An update of the review's conversation the daemon reads; `undefined` for anything else. */
function updateOf(params: unknown, conversation: string | undefined): SessionUpdate | undefined {
  const parsed = SessionUpdateParams.safeParse(params);
  if (!parsed.success || parsed.data.sessionId !== conversation) return undefined;
  const update = SessionUpdate.safeParse(parsed.data.update);
  return update.success ? update.data : undefined;
}

/** A notice of Copilot CLI itself in the conversation (`Info: Disabled tools: …`), a whole chunk of one line. */
const NOTICE = /^(Info|Warning|Error): [^\n]*$/;

/**
 * The reviewer's answer from the turn's updates. Copilot CLI streams the text of the review agent too, as chunks of the
 * same conversation while the `task` tool call that runs it is open, and then the model repeats it: only text while no
 * tool call is open counts, so an issue is read once. A tool call opens with `tool_call` and closes with an update that
 * says it completed or failed; should one never close, the answer is all the text, so a review never ends empty.
 */
export class ReviewAnswer {
  readonly #outside = new Paragraphs();
  readonly #all = new Paragraphs();
  readonly #open = new Set<string>();
  #chars = 0;

  add(update: SessionUpdate): void {
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const ended = update.status === "completed" || update.status === "failed";
      if (ended) this.#open.delete(update.toolCallId);
      else if (update.sessionUpdate === "tool_call") this.#open.add(update.toolCallId);
      this.#outside.breakParagraph();
      this.#all.breakParagraph();
      return;
    }
    const text = update.sessionUpdate === "agent_message_chunk" ? contentText(update.content) : undefined;
    if (text === undefined || this.#chars > ANSWER_MAX_CHARS) return;
    this.#chars += text.length;
    this.#all.add(text);
    if (this.#open.size === 0) this.#outside.add(text);
  }

  text(): string {
    const outside = this.#outside.text();
    return outside.trim() === "" ? this.#all.text() : outside;
  }
}

/**
 * Chunks carry no message boundaries, so a tool call or a notice of Copilot CLI starts a new paragraph, and a heading
 * is never glued to the text before it.
 */
class Paragraphs {
  readonly #paragraphs: string[] = [];
  #newParagraph = true;

  breakParagraph(): void {
    this.#newParagraph = true;
  }

  add(text: string): void {
    const notice = NOTICE.test(text);
    if (this.#newParagraph || notice) this.#paragraphs.push(text);
    else this.#paragraphs[this.#paragraphs.length - 1] += text;
    this.#newParagraph = notice;
  }

  text(): string {
    return this.#paragraphs.join("\n\n");
  }
}

/**
 * Every approval the reviewer asks for is refused (a file outside the worktree and the diff's folder, a tool a later
 * Copilot CLI asks about): nobody watches the run to decide. Any other request is not offered.
 */
function refusal(method: string, params: unknown): { title: string; outcome: PermissionOutcome } {
  if (method !== "session/request_permission") throw new Error(`${method} is not offered`);
  const parsed = RequestPermissionParams.safeParse(params);
  const reject = parsed.success ? parsed.data.options.find((option) => option.kind.startsWith("reject")) : undefined;
  return {
    title: parsed.success ? (parsed.data.toolCall.title ?? "a tool") : "an approval it could not read",
    outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" },
  };
}
