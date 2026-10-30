import type {
  AgentApproval,
  ConversationEntry,
  ConversationServerMessage,
  DialogAnswer,
  RunState,
  Session,
  SessionEnvironment,
  TaskState,
  TaskStateChange,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { AcpConnection, AcpError } from "./acp-connection.ts";
import { AcpConversation, type ConversationChange, toolCallLines } from "./acp-conversation.ts";
import {
  ACP_PROTOCOL_VERSION,
  InitializeResult,
  NewSessionResult,
  type PermissionOption,
  type PermissionOutcome,
  PromptResult,
  RequestPermissionParams,
  SessionUpdate,
  SessionUpdateParams,
} from "./acp-messages.ts";
import type { AgentSession } from "./agent-session.ts";
import type { CopilotHookOutput } from "./copilot-hook-output.ts";
import type { SessionEvent } from "./live-session.ts";
import { SessionAttention } from "./session-attention.ts";

/**
 * A Copilot CLI session in the conversation view (§4.4, ADR-107): `copilot --acp` on pipes of a `procs` group, with
 * the daemon as the ACP client. The state comes from the protocol itself: a prompt the daemon sent is `Working` until
 * its answer, an approval request is `Approval` until the daemon answers it, and the end of a turn is `Input`. What
 * waits for the session (the user's messages, the daemon's prompt for what is unread) is sent as the next prompt once
 * a turn ends, never typed. The conversation goes to the conversation sockets as entries.
 */

/** How long the handshake may take: a cold Copilot CLI that loads its MCP servers, on a slow computer. */
const HANDSHAKE_MS = 60_000;
/** How often the handshake checks that the process still runs, as the session list does afterwards. */
const HANDSHAKE_CHECK_MS = 200;

/** How long changes of the conversation gather before they go to the views: a streamed answer goes in a few frames, not one per chunk. */
const FLUSH_MS = 50;

/** The question the UI shows over an approval's options, as the terminal's dialog asks it. */
const APPROVAL_QUESTION = "Do you want to allow this?";

/** One conversation socket: its frames and its end. */
export interface ConversationViewer {
  send: (message: ConversationServerMessage) => void;
  closed: () => void;
}

/** One open conversation view in the UI: whether it is in front of the user (ADR-47), and leaving. */
export interface ConversationWindow {
  focus(focused: boolean): void;
  detach(): void;
}

/** The input of the session's process (`procs`' `GroupChannel`). */
export interface AcpChannel {
  write(data: string): void;
}

export interface AcpSessionOptions {
  id: string;
  /** `null` in the projects folder: the supervisor (ADR-58). */
  repo: string | null;
  supervisor: boolean;
  task: string | null;
  /** The working directory Copilot CLI's session gets (`session/new`, `session/load`). */
  cwd: string;
  /** Copilot CLI's id of the conversation to go on with (`session/load`); `undefined` for a new one. */
  load: string | undefined;
  /**
   * The first message, sent as soon as the session is ready (the day start, ADR-70; a task's prompt, ADR-137). The
   * daemon sends it, not the user, as `--interactive` in a terminal, so the end of its turn is reported (ADR-68).
   */
  firstMessage: string | undefined;
  environment: SessionEnvironment;
  run: () => RunState | undefined;
  /** The daemon's prompt for what waits unread for this session (ADR-62, ADR-68); `undefined` when nothing waits. */
  prompt: () => string | undefined;
  /** The user wrote to the session. */
  onUserText: () => void;
  /** The daemon's prompt, read just before, went to the agent. */
  onPromptSent: () => void;
  onEvent: (event: SessionEvent) => void;
  /** Any turn ended, also one the user drove, which `onEvent` leaves out: the agent may have committed (ADR-144). */
  onTurnOver: () => void;
  log: (msg: string) => void;
}

/** A prompt on its way: who wrote it, so that the end of a turn the user drove is not reported to the proposer. */
type Prompt = { text: string; by: "user" | "daemon" };

interface PendingApproval {
  dialog: AgentApproval;
  options: readonly PermissionOption[];
  answer: (outcome: PermissionOutcome) => void;
}

export class AcpSession implements AgentSession {
  readonly sessionView = "conversation";
  readonly id: string;
  readonly repo: string | null;
  readonly supervisor: boolean;
  readonly task: string | null;
  readonly startedAt = new Date().toISOString();
  readonly environment: SessionEnvironment;
  readonly #o: AcpSessionOptions;
  readonly #conversation = new AcpConversation();
  readonly #attention = new SessionAttention();
  readonly #viewers = new Set<ConversationViewer>();
  readonly #decoder = new TextDecoder();
  readonly #connection: AcpConnection;
  #channel: AcpChannel | undefined;
  /** Copilot CLI's id of the conversation, once `session/new` or `session/load` answered. */
  #conversationId: string | undefined;
  #hasConversation: boolean;
  #last: TaskStateChange | null = null;
  #windowTitle: string | null = null;
  #ready = false;
  #turn: Prompt | undefined;
  /** Approvals waiting, oldest first: the session's dialog is the first; parallel tool calls ask one after another. */
  readonly #approvals: PendingApproval[] = [];
  #approvalCount = 0;
  /** The user stopped the turn: an approval asked before it ends is refused at once. */
  #cancelling = false;
  /** Changed entries waiting for the next frame, by id; `reset` when the views get all entries again. */
  readonly #pending = new Map<string, ConversationEntry>();
  #pendingReset = false;
  #flush: ReturnType<typeof setTimeout> | undefined;
  readonly #queued: Prompt[] = [];
  #promptAsked = false;
  #finished = false;

  constructor(o: AcpSessionOptions) {
    this.id = o.id;
    this.repo = o.repo;
    this.supervisor = o.supervisor;
    this.task = o.task;
    this.environment = o.environment;
    this.#o = o;
    this.#hasConversation = o.load !== undefined;
    this.#connection = new AcpConnection({
      write: (line) => this.#channel?.write(line),
      onNotification: (method, params) => this.#notification(method, params),
      onRequest: (method, params) => this.#request(method, params),
      log: (msg) => this.#o.log(`session ${this.id}: ${msg}`),
    });
  }

  /** The process input; it arrives after the group starts, and output can arrive earlier. */
  connect(channel: AcpChannel): void {
    this.#channel = channel;
  }

  /** The process's stdout. */
  output(chunk: Uint8Array): void {
    this.#connection.feed(this.#decoder.decode(chunk, { stream: true }));
  }

  /**
   * The handshake: `initialize`, then `session/load` of the conversation to go on with or `session/new`. The session
   * waits for the user after it, or works on its first message. The handshake fails when the process ends or does not
   * answer within a minute (a Copilot CLI without `--acp`, one that is not signed in); the process is left to the caller.
   */
  async start(): Promise<void> {
    const connection = this.#connection;
    if (this.#channel === undefined) throw new Error(`session ${this.id} has no process yet`);
    const started = Date.now();
    const watch = setInterval(() => {
      if (this.#o.run()?.kind === "exited" || Date.now() - started > HANDSHAKE_MS) connection.close();
    }, HANDSHAKE_CHECK_MS);
    try {
      await this.#handshake(connection);
    } finally {
      clearInterval(watch);
    }
    this.#ready = true;
    this.#report("Input", "session ready");
    // Before anything the user wrote while the session started: the day start's briefing comes first.
    if (this.#o.firstMessage !== undefined) this.#queued.unshift({ text: this.#o.firstMessage, by: "daemon" });
    this.#next();
  }

  async #handshake(connection: AcpConnection): Promise<void> {
    const agent = InitializeResult.parse(
      await connection.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
    );
    if (agent.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw new Error(`Copilot CLI speaks ACP version ${agent.protocolVersion}, not ${ACP_PROTOCOL_VERSION}`);
    const { cwd, load } = this.#o;
    if (load !== undefined && agent.agentCapabilities?.loadSession !== true)
      throw new Error("Copilot CLI cannot load a conversation over ACP");
    if (load === undefined) {
      this.#conversationId = NewSessionResult.parse(await connection.request("session/new", { cwd, mcpServers: [] })).sessionId;
    } else {
      // The agent replays the conversation as updates of that id before it answers; no view is attached yet.
      this.#conversation.clear();
      this.#conversationId = load;
      await connection.request("session/load", { sessionId: load, cwd, mcpServers: [] });
    }
  }

  /** Copilot CLI's id of the conversation, which a later start loads (ADR-95, ADR-107). */
  get conversation(): string | undefined {
    return this.#conversationId;
  }

  /** Copilot CLI keeps the conversation: it was loaded, or got a prompt. */
  get hasConversation(): boolean {
    return this.#hasConversation;
  }

  /** A message from the user: the next prompt, at once when the agent waits, otherwise after its turn. */
  say(text: string): void {
    if (this.#finished) throw new DomainError("bad_request", "the session has ended");
    this.#attention.typed();
    this.#o.onUserText();
    this.#queued.push({ text, by: "user" });
    this.#next();
  }

  /** Stops the turn, as Esc does in the terminal: an approval waiting is refused, and the agent ends its turn. */
  interrupt(): void {
    if (this.#finished) return;
    this.#attention.typed();
    this.#refuseApprovals();
    if (this.#turn === undefined || this.#cancelling) return;
    this.#cancelling = true;
    const conversation = this.#conversationId;
    if (conversation !== undefined) this.#connection.notify("session/cancel", { sessionId: conversation });
  }

  /**
   * Asks the session to read what waits for it (ADR-62, ADR-68): the daemon's prompt goes as the next prompt, at once
   * when the agent waits, otherwise when its turn ends.
   */
  askToRead(): "typed" | "queued" {
    this.#promptAsked = true;
    this.#next();
    return this.#promptAsked ? "queued" : "typed";
  }

  /** Hooks give nothing to a session in the conversation view: what waits goes as the next prompt (ADR-107). */
  hookOutput(): CopilotHookOutput {
    return {};
  }

  /** Answers the approval `id` names with an option's digit, or `stop`, which refuses it and ends the turn. */
  answerDialog(id: string, answer: DialogAnswer): void {
    const approval = this.#approvals[0];
    if (approval?.dialog.id !== id) throw new DomainError("dialog_changed", "the approval was answered or it changed");
    if (answer === "stop") {
      this.interrupt();
      return;
    }
    const option = approval.options[Number(answer) - 1];
    if (option === undefined) throw new DomainError("bad_request", `the approval has no option ${answer}`);
    this.#attention.typed();
    this.#answerFirst({ outcome: "selected", optionId: option.optionId });
  }

  /** A conversation view: all entries first, then the changed ones; `closed` when the session disappears. */
  attachConversation(viewer: ConversationViewer): ConversationWindow {
    viewer.send({ type: "entries", reset: true, entries: [...this.#conversation.entries()] });
    this.#viewers.add(viewer);
    const attention = this.#attention.window();
    return {
      focus: (focused) => attention.focus(focused),
      detach: () => {
        attention.close();
        this.#viewers.delete(viewer);
      },
    };
  }

  /** The end of the process; returns whether the session is alive. */
  tick(): boolean {
    if (this.#finished) return false;
    const run = this.#o.run();
    if (run?.kind !== "exited") return true;
    this.#finished = true;
    this.#connection.close();
    this.#refuseApprovals();
    const failed = !run.stoppedByUser && run.exitCode !== 0;
    this.#report(failed ? "Error" : "Done", `exit ${run.exitCode ?? run.signal ?? "?"}`, "exit");
    this.#o.onEvent({ kind: "exited", exitCode: run.exitCode, stoppedByUser: run.stoppedByUser });
    return false;
  }

  view(): Session | undefined {
    const run = this.#o.run();
    if (!run) return undefined;
    const running = run.kind === "running";
    return {
      id: this.id,
      repo: this.repo,
      supervisor: this.supervisor,
      startedAt: this.startedAt,
      run,
      state: this.#last,
      windowTitle: this.#windowTitle,
      needsAttention: running && this.#attention.waiting(this.#last?.state),
      task: this.task,
      dialog: running ? (this.#approvals[0]?.dialog ?? null) : null,
      environment: this.environment,
      view: "conversation",
    };
  }

  dispose(): void {
    clearTimeout(this.#flush);
    for (const viewer of this.#viewers) viewer.closed();
    this.#viewers.clear();
    this.#connection.close();
  }

  /** Sends what waits, when the agent waits: the first message and the user's messages first, then the daemon's prompt. */
  #next(): void {
    if (!this.#ready || this.#finished || this.#turn !== undefined) return;
    const queued = this.#queued.shift();
    if (queued !== undefined) {
      this.#prompt(queued);
      return;
    }
    if (!this.#promptAsked) return;
    this.#promptAsked = false;
    const prompt = this.#o.prompt();
    if (prompt === undefined) return;
    this.#o.onPromptSent();
    this.#prompt({ text: prompt, by: "daemon" });
  }

  #prompt(prompt: Prompt): void {
    const conversation = this.#conversationId;
    const connection = this.#connection;
    if (conversation === undefined) throw new Error(`session ${this.id} has no conversation yet`);
    this.#turn = prompt;
    this.#hasConversation = true;
    this.#broadcast(this.#conversation.said(prompt.text));
    this.#report("Working", "prompt sent");
    connection.request("session/prompt", { sessionId: conversation, prompt: [{ type: "text", text: prompt.text }] }).then(
      (result) => this.#turnEnded(prompt, PromptResult.safeParse(result).data?.stopReason ?? "unknown"),
      (err: unknown) => this.#turnFailed(err),
    );
  }

  #turnEnded(prompt: Prompt, stopReason: string): void {
    this.#endTurn();
    if (this.#finished) return;
    this.#report("Input", `stop ${stopReason}`);
    this.#o.onTurnOver();
    if (prompt.by === "daemon") this.#o.onEvent({ kind: "turn_ended" });
    this.#next();
  }

  #turnFailed(err: unknown): void {
    this.#endTurn();
    if (this.#finished) return;
    // Only the code: the message is the agent's own text, which may repeat what it read.
    this.#o.log(
      `session ${this.id}: prompt failed: ${err instanceof AcpError ? `ACP error ${err.code}` : err instanceof Error ? err.name : "unknown"}`,
    );
    this.#report("Error", "prompt failed");
    this.#o.onEvent({ kind: "error" });
    // What waits still goes: a failed turn (a model error) does not swallow the next message.
    this.#next();
  }

  /** No approval outlives its turn. */
  #endTurn(): void {
    this.#turn = undefined;
    this.#cancelling = false;
    this.#refuseApprovals();
  }

  #notification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const parsed = SessionUpdateParams.safeParse(params);
    if (!parsed.success || parsed.data.sessionId !== this.#conversationId) return;
    const update = SessionUpdate.safeParse(parsed.data.update);
    // A kind the daemon does not show (available commands, usage, thoughts, plans).
    if (!update.success) return;
    if (update.data.sessionUpdate === "session_info_update") this.#windowTitle = update.data.title ?? this.#windowTitle;
    this.#broadcast(this.#conversation.apply(update.data));
  }

  /** The agent's requests: only approvals, since the daemon offers it no files or terminals of its own. */
  #request(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") return Promise.reject(new Error(`${method} is not offered`));
    const parsed = RequestPermissionParams.safeParse(params);
    if (!parsed.success) return Promise.reject(new Error("an approval request the daemon cannot read"));
    const { sessionId, toolCall, options } = parsed.data;
    if (sessionId !== this.#conversationId) return Promise.reject(new Error("an approval request of another conversation"));
    if (this.#cancelling || this.#turn === undefined) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const dialog: AgentApproval = {
      id: `approval-${++this.#approvalCount}`,
      kind: "approval",
      title: toolCall.title ?? "Approval",
      detail: toolCallLines(toolCall),
      question: APPROVAL_QUESTION,
      options: options.map((o, i) => ({ key: String(i + 1), label: o.name })),
    };
    return new Promise((resolve) => {
      this.#approvals.push({ dialog, options, answer: (outcome) => resolve({ outcome }) });
      this.#report("Approval", "session/request_permission");
    });
  }

  /** Answers the first approval; the turn works on, or the next approval is the dialog. */
  #answerFirst(outcome: PermissionOutcome): void {
    const approval = this.#approvals.shift();
    if (approval === undefined) return;
    approval.answer(outcome);
    if (!this.#finished && this.#turn !== undefined && this.#approvals.length === 0) this.#report("Working", "approval answered");
  }

  #refuseApprovals(): void {
    for (const approval of this.#approvals.splice(0)) approval.answer({ outcome: "cancelled" });
  }

  #report(state: TaskState, reason: string, source: TaskStateChange["source"] = "acp"): void {
    // The views get the conversation up to a state before the state: an Input that reaches the panel, the tray or a
    // notification ahead of the answer's last chunk would show a finished turn without its answer.
    this.#flushNow();
    const previous = this.#last?.state;
    this.#last = { state, source, confidence: "exact", at: new Date().toISOString(), reason };
    this.#attention.changed(previous, state);
  }

  /** Gathers the change for the next frame. */
  #broadcast({ entries, reset }: ConversationChange): void {
    if (entries.length === 0 && !reset) return;
    if (reset) {
      this.#pendingReset = true;
      this.#pending.clear();
    } else {
      for (const entry of entries) this.#pending.set(entry.id, entry);
    }
    this.#flush ??= setTimeout(() => this.#sendPending(), FLUSH_MS);
  }

  #flushNow(): void {
    if (this.#flush === undefined) return;
    clearTimeout(this.#flush);
    this.#sendPending();
  }

  #sendPending(): void {
    this.#flush = undefined;
    const reset = this.#pendingReset;
    // Copies: an entry still growing must not change under a frame a view has not read yet.
    const entries = (reset ? this.#conversation.entries() : [...this.#pending.values()]).map((e) => structuredClone(e));
    this.#pending.clear();
    this.#pendingReset = false;
    const message: ConversationServerMessage = { type: "entries", reset, entries };
    for (const viewer of this.#viewers) viewer.send(message);
  }
}
