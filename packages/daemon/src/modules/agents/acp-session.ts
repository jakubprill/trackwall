import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentApproval,
  ConversationEntry,
  ConversationInfo,
  ConversationServerMessage,
  DialogAnswer,
  MessageAttachment,
  ReadRequest,
  ReadRequestHold,
  RunState,
  Session,
  SessionEnvironment,
  TaskState,
  TaskStateChange,
  WaitingMessage,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { isInside } from "../../infra/path-inside.ts";
import { AcpConnection, AcpError } from "./acp-connection.ts";
import { AcpConversation, type ConversationChange } from "./acp-conversation.ts";
import {
  ACP_PROTOCOL_VERSION,
  ConfigOptionsResult,
  InitializeResult,
  NewSessionResult,
  type PermissionOption,
  type PermissionOutcome,
  PromptResult,
  RequestPermissionParams,
  SessionUpdate,
  SessionUpdateParams,
} from "./acp-messages.ts";
import { attachmentLabel, checkAttachments, promptBlocks } from "./acp-prompt.ts";
import { AcpSessionInfo, AGENT_MODE } from "./acp-session-info.ts";
import { toolCallFiles, toolCallLines, toolCallPatch, workingDirectoryNames } from "./acp-tool-call.ts";
import type { AgentSession } from "./agent-session.ts";
import { type CopilotHookOutput, situationOutput } from "./copilot-hook-output.ts";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import type { CopilotUsageLog } from "./copilot-usage-log.ts";
import { CopyRequestSlot } from "./copy-request.ts";
import type { SessionEvent } from "./live-session.ts";
import { ReadRequestClock } from "./read-request.ts";
import { SessionAttention } from "./session-attention.ts";
import { sessionStuck } from "./session-stuck.ts";
import type { TokenBudget } from "./token-budget.ts";

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

/** The most updates kept before the conversation has an id; Copilot CLI sends one or two. */
const EARLY_UPDATES_MAX = 20;

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
  /**
   * The mode the agent switches to once the session is ready, before the first message (a task's Plan mode, ADR-229);
   * `undefined` leaves the agent's own. A mode the agent does not offer fails the start.
   */
  mode: string | undefined;
  environment: SessionEnvironment;
  /** The model Trackwall started it on (ADR-206); `null` when it passed none. */
  model: string | null;
  run: () => RunState | undefined;
  /** The daemon's prompt for what waits unread for this session (ADR-62, ADR-68); `undefined` when nothing waits. */
  prompt: () => string | undefined;
  /** What the agent gets with every prompt, through the session plugin's hook (the supervisor's situation, ADR-148). */
  situation: () => string | undefined;
  /** The user wrote to the session. */
  onUserText: () => void;
  /** The daemon's prompt, read just before, went to the agent. */
  onPromptSent: () => void;
  onEvent: (event: SessionEvent) => void;
  /** Any turn ended, also one the user drove, which `onEvent` leaves out: the agent may have committed (ADR-144). */
  onTurnOver: () => void;
  /** Any turn started, also one the user drove: where the worktree is then starts a round (ADR-168). */
  onTurnStart: () => void;
  /** What the conversation used (ADR-190), read when a conversation is loaded, in the session's cycle and at its end. */
  usage: CopilotUsageLog;
  /** A task session's token budget (ADR-237), checked after every read of the usage while it runs; `null` for none. */
  tokenBudget: TokenBudget | null;
  log: (msg: string) => void;
}

/** A prompt on its way: who wrote it, so that the end of a turn the user drove is not reported to the proposer. */
/** A prompt to send; the user's carries the id its waiting bubble has until it goes (`WaitingMessage`). */
type Prompt = { text: string; attachments: readonly MessageAttachment[] } & ({ by: "daemon" } | { by: "user"; id: string });

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
  readonly model: string | null;
  readonly #o: AcpSessionOptions;
  /** The session's working directory as given and as resolved (`workingDirectoryNames`), once. */
  readonly #cwdNames: readonly string[];
  readonly #conversation: AcpConversation;
  /** The agent's mode, context use and commands. */
  readonly #info = new AcpSessionInfo();
  /** Updates before `session/new` answered with the conversation's id: Copilot CLI sends its commands first. */
  readonly #early: SessionUpdateParams[] = [];
  #earlyOverflowLogged = false;
  readonly #attention = new SessionAttention();
  readonly #viewers = new Set<ConversationViewer>();
  readonly #decoder = new TextDecoder();
  readonly #connection: AcpConnection;
  #channel: AcpChannel | undefined;
  /** Copilot CLI's id of the conversation, once `session/new` or `session/load` answered. */
  #conversationId: string | undefined;
  #hasConversation: boolean;
  /** The agent takes images in a prompt (`promptCapabilities.image`), as Copilot CLI does. */
  /** Whether the agent takes images, once `initialize` says so. */
  #takesImages: boolean | undefined;
  #last: TaskStateChange | null = null;
  /** The agent's last update or state change, for `SessionStuck` (ADR-151); the start before either. */
  #lastStepAt = Date.now();
  #windowTitle: string | null = null;
  #ready = false;
  /** The approval of a plan is switching the mode (ADR-229): nothing is sent until the approval goes first. */
  #switchingMode = false;
  #turn: Prompt | undefined;
  /** Approvals waiting, oldest first: the session's dialog is the first; parallel tool calls ask one after another. */
  readonly #approvals: PendingApproval[] = [];
  #approvalCount = 0;
  /** The user stopped the turn: an approval asked before it ends is refused at once. */
  #cancelling = false;
  /** Changed entries waiting for the next frame, by id; `reset` when the views get all entries again. */
  readonly #pending = new Map<string, ConversationEntry>();
  #pendingReset = false;
  /** What changed of the agent's mode, context use and commands since the last frame. */
  #pendingInfo: Partial<ConversationInfo> = {};
  #flush: ReturnType<typeof setTimeout> | undefined;
  readonly #queued: Prompt[] = [];
  #waitingIds = 0;
  #promptAsked = false;
  #finished = false;
  readonly #readRequest = new ReadRequestClock();
  readonly copyRequest = new CopyRequestSlot();

  constructor(o: AcpSessionOptions) {
    this.id = o.id;
    this.repo = o.repo;
    this.supervisor = o.supervisor;
    this.task = o.task;
    this.environment = o.environment;
    this.model = o.model;
    this.#o = o;
    this.#cwdNames = workingDirectoryNames(o.cwd);
    this.#conversation = new AcpConversation(this.#cwdNames);
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
    // Before the session is ready, so no message, the first or the user's, reaches the agent in another mode.
    if (this.#o.mode !== undefined) await this.setMode(this.#o.mode);
    this.#ready = true;
    this.#report("Input", "session ready");
    // Before anything the user wrote while the session started: the day start's briefing comes first.
    if (this.#o.firstMessage !== undefined) this.#queued.unshift({ text: this.#o.firstMessage, by: "daemon", attachments: [] });
    this.#next();
  }

  async #handshake(connection: AcpConnection): Promise<void> {
    const agent = InitializeResult.parse(
      await connection.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
    );
    this.#takesImages = agent.agentCapabilities?.promptCapabilities?.image === true;
    if (agent.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw new Error(`Copilot CLI speaks ACP version ${agent.protocolVersion}, not ${ACP_PROTOCOL_VERSION}`);
    const { cwd, load } = this.#o;
    if (load !== undefined && agent.agentCapabilities?.loadSession !== true)
      throw new Error("Copilot CLI cannot load a conversation over ACP");
    if (load === undefined) {
      const created: unknown = await connection.request("session/new", { cwd, mcpServers: [] });
      this.#conversationId = NewSessionResult.parse(created).sessionId;
      this.#infoChanged(this.#info.settings(ConfigOptionsResult.safeParse(created).data?.configOptions));
      for (const params of this.#early.splice(0)) this.#update(params);
    } else {
      // The agent replays the conversation as updates of that id before it answers; no view is attached yet.
      this.#conversation.clear();
      this.#conversationId = load;
      this.#o.usage.readBeforeStart(load);
      const loaded = ConfigOptionsResult.safeParse(await connection.request("session/load", { sessionId: load, cwd, mcpServers: [] }));
      this.#infoChanged(this.#info.settings(loaded.data?.configOptions));
      this.#updateUsage();
    }
  }

  /**
   * The full path of a file the conversation names (`path` relative to the working directory, as a tool call's files
   * are, or absolute), only inside the working directory, by real paths so a link there cannot lead out, and only while
   * it is there: the path comes from the agent (ADR-107).
   */
  fileOf(path: string): string {
    const cwd = this.#o.cwd;
    const file = resolve(cwd, path);
    if (!isInside(cwd, file)) throw new DomainError("bad_request", "the file is outside the session's working directory");
    if (!existsSync(file)) throw new DomainError("not_found", "the file is not there any more");
    if (!statSync(file).isFile()) throw new DomainError("bad_request", "the path is not a file");
    if (!isInside(realpathSync(cwd), realpathSync(file)))
      throw new DomainError("bad_request", "the file leads outside the session's working directory");
    return file;
  }

  /** Copilot CLI's id of the conversation, which a later start loads (ADR-95, ADR-107). */
  get conversation(): string | undefined {
    return this.#conversationId;
  }

  /** Copilot CLI keeps the conversation: it was loaded, or got a prompt. */
  get hasConversation(): boolean {
    return this.#hasConversation;
  }

  /** A message from the user with what they attached: the next prompt, at once when the agent waits, otherwise after its turn. */
  say(text: string, attachments: readonly MessageAttachment[] = []): void {
    if (this.#finished) throw new DomainError("bad_request", "the session has ended");
    checkAttachments(attachments, this.#takesImages);
    if (attachments.length > 0 && this.#queued.some((p) => p.attachments.length > 0))
      throw new DomainError("bad_request", "a message with attachments already waits for the turn to end");
    this.#queued.push(this.#userPrompt(text, attachments));
    this.#next();
    // A message that waits for the turn shows as waiting at once, not only when it goes (which sends its own frame).
    if (this.#queued.length > 0) this.#scheduleFlush();
  }

  /** A prompt the user wrote, under the id its waiting bubble has until it goes. */
  #userPrompt(text: string, attachments: readonly MessageAttachment[]): Prompt {
    this.#attention.typed();
    this.#o.onUserText();
    this.#waitingIds += 1;
    return { text, by: "user", id: `waiting-${this.#waitingIds}`, attachments };
  }

  /** The user's messages waiting for the turn to end, oldest first. */
  #waiting(): WaitingMessage[] {
    return this.#queued.flatMap((p) =>
      p.by === "user" ? [{ id: p.id, text: p.text, attachments: p.attachments.map(attachmentLabel) }] : [],
    );
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

  /**
   * What waits goes as the next prompt (ADR-107), so a hook gives only the supervisor's situation with each prompt
   * (ADR-148), which as part of the prompt would show in a loaded conversation as the user's words.
   */
  hookOutput(record: CopilotHookRecord | undefined): CopilotHookOutput {
    return record?.event === "userPromptSubmitted" ? situationOutput(this.#o.situation()) : {};
  }

  /**
   * Copilot CLI over ACP names no pattern with its "Always allow" (ADR-249), so Trackwall cannot show or remove what it
   * would remember; its own option stays in the dialog.
   */
  alwaysAllow(): void {
    throw new DomainError("bad_request", "Always allow is offered only in a task's terminal");
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

  /**
   * Switches the agent to a mode it offers (Agent, Plan); its answer and the agent's update say the mode it works in now.
   * A mode it does not offer, autopilot among them (`acp-session-info.ts`), is refused.
   */
  async setMode(mode: string): Promise<void> {
    if (this.#finished) throw new DomainError("bad_request", "the session has ended");
    const conversation = this.#conversationId;
    if (conversation === undefined || !this.#info.offers(mode)) throw new DomainError("bad_request", "the agent does not offer this mode");
    let result: unknown;
    try {
      result = await this.#connection.request("session/set_config_option", { sessionId: conversation, configId: "mode", value: mode });
    } catch (err) {
      // Only the code: the message is the agent's own text.
      throw new DomainError("bad_request", `the agent did not switch the mode${err instanceof AcpError ? ` (ACP error ${err.code})` : ""}`);
    }
    this.#infoChanged(this.#info.settings(ConfigOptionsResult.safeParse(result).data?.configOptions));
  }

  /**
   * The user approved the plan the agent wrote in Plan mode (ADR-229): the agent switches to Agent mode and gets
   * `prompt` as the user's message. Refused while a turn runs, since a plan still being written is not the one the user read.
   */
  async approvePlan(prompt: string): Promise<void> {
    if (this.#finished) throw new DomainError("bad_request", "the session has ended");
    if (this.#switchingMode || this.#turn !== undefined || this.#queued.length > 0)
      throw new DomainError("bad_request", "the agent is still working; approve the plan once its turn ends");
    // Held like a start that is not ready: a message written during the switch waits behind the approval, so no turn
    // runs between the modes and the approval is the first thing the agent reads in Agent mode.
    this.#switchingMode = true;
    try {
      await this.setMode(AGENT_MODE);
      this.#queued.unshift(this.#userPrompt(prompt, []));
    } finally {
      this.#switchingMode = false;
      this.#next();
    }
  }

  /** A conversation view: all entries first, then the changed ones; `closed` when the session disappears. */
  attachConversation(viewer: ConversationViewer): ConversationWindow {
    const entries = [...this.#conversation.entries()];
    viewer.send({ type: "entries", reset: true, entries, waiting: this.#waiting(), ...this.#info.get() });
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
    this.#readRequest.observe(this.#o.prompt());
    const run = this.#o.run();
    if (run?.kind !== "exited") {
      if (this.#conversationId !== undefined) this.#o.usage.poll(this.#conversationId, Date.now());
      this.#o.tokenBudget?.check();
      return true;
    }
    this.#finished = true;
    this.#connection.close();
    this.#refuseApprovals();
    this.#updateUsage();
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
      waitingSince: running ? this.#attention.waitingSince(this.#last?.state) : null,
      stuck: running ? sessionStuck(this.#last, this.#lastStepAt, Date.now()) : null,
      task: this.task,
      dialog: running ? (this.#approvals[0]?.dialog ?? null) : null,
      environment: this.environment,
      view: "conversation",
      readRequest: running ? this.#readRequestView() : null,
      copyRequest: running ? this.copyRequest.request : null,
      usage: this.#o.usage.current(),
      model: this.model,
      modelInUse: this.#o.usage.modelInUse(),
      modelError: this.#o.usage.modelError(),
      tokenBudget: this.#o.tokenBudget?.view() ?? null,
    };
  }

  #updateUsage(): void {
    if (this.#conversationId !== undefined) this.#o.usage.update(this.#conversationId);
  }

  /**
   * What keeps the prompt about what waits unread out of the conversation (ADR-159): it goes as the next prompt once
   * the session is ready and the turn under way ends; while the agent's own turn reads it, it counts as sent.
   */
  #readRequestView(): ReadRequest | null {
    const prompt = this.#o.prompt();
    if (prompt === undefined) return null;
    return this.#readRequest.readRequest(prompt, this.#readRequestHold());
  }

  #readRequestHold(): ReadRequestHold {
    if (this.#turn?.by === "daemon") return "sent";
    if (this.#approvals.length > 0) return "dialog";
    return this.#promptAsked ? "pending" : "idle";
  }

  /** The user's Deliver now (ADR-159): only where nothing else sends it (`idle`), so it never goes twice. */
  deliverNow(): void {
    if (this.#readRequestHold() === "idle") this.askToRead();
  }

  dispose(): void {
    clearTimeout(this.#flush);
    for (const viewer of this.#viewers) viewer.closed();
    this.#viewers.clear();
    this.#connection.close();
  }

  /** Sends what waits, when the agent waits: the first message and the user's messages first, then the daemon's prompt. */
  #next(): void {
    if (!this.#ready || this.#switchingMode || this.#finished || this.#turn !== undefined) return;
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
    this.#prompt({ text: prompt, by: "daemon", attachments: [] });
  }

  #prompt(prompt: Prompt): void {
    const conversation = this.#conversationId;
    const connection = this.#connection;
    if (conversation === undefined) throw new Error(`session ${this.id} has no conversation yet`);
    this.#turn = prompt;
    this.#hasConversation = true;
    this.#o.onTurnStart();
    this.#broadcast(this.#conversation.said(prompt.text, prompt.attachments.map(attachmentLabel)));
    this.#report("Working", "prompt sent");
    connection.request("session/prompt", { sessionId: conversation, prompt: promptBlocks(prompt.text, prompt.attachments) }).then(
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
    // The agent may have committed before the turn failed.
    this.#o.onTurnOver();
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
    if (!parsed.success) return;
    if (this.#conversationId === undefined) this.#keepEarly(parsed.data);
    else this.#update(parsed.data);
  }

  /** An update before the conversation has an id waits for it, up to `EARLY_UPDATES_MAX`; the rest go, said once in the log. */
  #keepEarly(params: SessionUpdateParams): void {
    if (this.#early.length < EARLY_UPDATES_MAX) {
      this.#early.push(params);
    } else if (!this.#earlyOverflowLogged) {
      this.#earlyOverflowLogged = true;
      this.#o.log(`session ${this.id}: dropped updates that came before the conversation had an id`);
    }
  }

  #update(params: SessionUpdateParams): void {
    if (params.sessionId !== this.#conversationId) return;
    // Any update of the conversation is a step (ADR-151), also a plan the daemon does not show.
    this.#lastStepAt = Date.now();
    const update = SessionUpdate.safeParse(params.update);
    // A kind the daemon does not show (plans).
    if (!update.success) return;
    if (update.data.sessionUpdate === "session_info_update") this.#windowTitle = update.data.title ?? this.#windowTitle;
    this.#infoChanged(this.#info.apply(update.data));
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
      // The files first: an approval's title names the tool ("Edit file"), not what it changes.
      detail: [...toolCallFiles(toolCall, this.#cwdNames), ...toolCallLines(toolCall)],
      ...approvalPatch(toolCall),
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
    this.#lastStepAt = Date.now();
    this.#last = { state, source, confidence: "exact", at: new Date().toISOString(), reason };
    this.#attention.changed(previous, state, this.#last.at);
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
    this.#scheduleFlush();
  }

  #infoChanged(change: Partial<ConversationInfo> | undefined): void {
    if (change === undefined) return;
    Object.assign(this.#pendingInfo, change);
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
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
    // Copies too: the commands of a frame a view has not read yet must not change under it.
    const info = structuredClone(reset ? this.#info.get() : this.#pendingInfo);
    this.#pending.clear();
    this.#pendingReset = false;
    this.#pendingInfo = {};
    const message: ConversationServerMessage = { type: "entries", reset, entries, waiting: this.#waiting(), ...info };
    for (const viewer of this.#viewers) viewer.send(message);
  }
}

/** An approval's change, as its dialog carries it. */
function approvalPatch(toolCall: RequestPermissionParams["toolCall"]): Pick<AgentApproval, "patch" | "patchCut"> {
  const { patch, cut } = toolCallPatch(toolCall);
  return { patch, patchCut: cut };
}
