import { promptBoxOnScreen, type TaskStateChange } from "@trackwall/protocol";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import { stateFromHook } from "./copilot-hooks.ts";
import { answersDialog, type SessionKey, stateFromKey } from "./copilot-keys.ts";
import { stateFromOsc, windowTitleFromOsc } from "./copilot-osc.ts";
import { stateFromPromptBox } from "./copilot-prompt-box.ts";
import { CopilotScreen } from "./copilot-screen.ts";
import { FOLDER_TRUST_DIALOG, startDialogOnScreen } from "./copilot-start-dialog.ts";
import { OscParser } from "./osc-parser.ts";
import { type StateSignal, TaskStateTracker, type TaskStateTrackerOptions } from "./task-state-tracker.ts";

/**
 * The first `sessionStart` of a session with a prompt on its way (`--interactive`, or one the daemon typed): Copilot
 * CLI 1.0.103 sends it together with the first prompt (ADR-17, ADR-69), so here it starts work. Without a known prompt
 * it stays waiting for you, since `/resume` or `/clear` as the first command may send it too.
 */
const SESSION_START_WITH_PROMPT: StateSignal = {
  state: "Working",
  source: "hook",
  confidence: "medium",
  reason: "hook sessionStart with a prompt",
};

/**
 * A model call that failed, read from the conversation's event log (ADR-242, ADR-243): Copilot CLI's own record, so
 * `high`. Copilot CLI 1.0.110 sends no hook at all after the `sessionStart` of a starting prompt whose model the account
 * does not offer, so without this the session would stay `Working` while it sits in its empty input box.
 */
const MODEL_CALL_FAILED: StateSignal = {
  state: "Error",
  source: "log",
  confidence: "high",
  reason: "log session.error (model call failed)",
};

/**
 * The main agent's `agentStop` while background agents it started still run (ADR-254): Copilot CLI shows "Waiting for
 * background agents" and starts the agent's next turn itself once they finish, so the work goes on. The hooks tell it
 * (`copilot-subagents.ts`), so `high`.
 */
const WAITING_FOR_BACKGROUND_AGENTS: StateSignal = {
  state: "Working",
  source: "hook",
  confidence: "high",
  reason: "hook agentStop while background agents run",
};

/**
 * The main agent waited for background agents that sent no hook for a while and that the event log no longer names as
 * running (ADR-254): one whose `task` call failed, or one stopped another way; no turn of the main agent follows.
 */
const BACKGROUND_AGENTS_ENDED: StateSignal = {
  state: "Input",
  source: "log",
  confidence: "medium",
  reason: "log no background agent runs",
};

/**
 * Esc on the folder trust dialog ended the session (ADR-300): Copilot CLI 1.0.115 quits with exit code 1 and, since it
 * closes before the first prompt, without the `sessionEnd` hook it sent up to 1.0.114. The user said "No", which is
 * no error.
 */
const FOLDER_TRUST_REFUSED: StateSignal = {
  state: "Done",
  source: "screen",
  confidence: "high",
  reason: "screen folder trust refused",
  endsSession: true,
};

/**
 * A prompt the daemon typed counts as on its way this long (ADR-62): its session is not waiting for you meanwhile, and
 * one not taken by then may be typed again into an empty input box.
 */
export const RETYPE_AFTER_MS = 5000;

/**
 * The interrupted turn message counts only this long after an answer with a key: the same text comes back on the screen
 * when the history is redrawn, e.g. after a resize.
 */
const CANCEL_AFTER_ANSWER_MS = 10_000;

/**
 * While other approval requests still wait after an answer (ADR-66), the message counts only this soon after the key,
 * which it follows at once: later the same text may be output of the approved tool, and it would end waiting for the rest.
 */
const CANCEL_WHILE_WAITING_MS = 2000;

/**
 * How long a `postToolUse` that came while an approval request waits is held back (ADR-66): it may be of a tool called
 * together with the one asking, whose dialog the screen shows a moment later (`approvalOnScreen`), or the request was
 * answered in a way the daemon did not see, and the work goes on.
 */
const HOLD_TOOL_USE_MS = 3000;

/**
 * The state of one Copilot CLI session (§4.4): PTY output, hook records and a human's keys go in, state changes come
 * out. The same object computes the state live and when replaying a recording, so a test on a recording checks what
 * runs in the session. The screen image (`screen`) comes only live: a recording has none, so its replay of a new session
 * has no state until the first hook (ADR-69).
 */
export interface CopilotSessionStateOptions extends TaskStateTrackerOptions {
  /**
   * The session starts with the prompt as its first message (`--interactive`, the session of a new task, ADR-31), so its
   * first `sessionStart` starts work, and its input box on the screen before it is not waiting for you. Without this a
   * task session would be waiting for you for a moment, and `wait_for_session` (ADR-39) would end the wait before the
   * agent starts.
   */
  promptOnStart: boolean;
  /**
   * The path the session's program was started with, whose window title ConPTY on Windows sets first (`windowTitleFromOsc`);
   * `null` when not known, as in the replay of a recording.
   */
  program: string | null;
}

export class CopilotSessionState {
  readonly #osc = new OscParser();
  readonly #screen = new CopilotScreen();
  readonly #tracker: TaskStateTracker;
  readonly #now: () => number;
  readonly #promptOnStart: boolean;
  readonly #program: string | null;
  /** When the daemon typed a prompt before the first hook (`promptTyped`). */
  #promptTypedAt: number | undefined;
  /**
   * Whether the last hook record that changed the state left Copilot CLI in its input box: after the end of a turn and
   * a `sessionStart` without a prompt; `undefined` before one.
   */
  #inPromptBox: boolean | undefined;
  #windowTitle: string | undefined;
  /** The time of the last session key that changed the state (an answer to a request or an interruption). */
  #lastAnswerAt = Number.NEGATIVE_INFINITY;
  /**
   * Approval requests of the current wait in `Approval` not answered yet; it starts with each entry into `Approval`.
   * Copilot CLI 1.0.103 asks for the approvals of tools the agent called at once all together, with a hook each, and
   * then shows their dialogs one at a time (ADR-66), so answering one leaves the session waiting while others remain.
   */
  #approvalsAsked = 0;
  /** A `postToolUse` held back while an approval request waits, and when it came. */
  #heldToolUse: { signal: StateSignal; at: number } | undefined;
  /**
   * What the screen can still tell (`screen`): before the first state a dialog shown before the first hook or the input
   * box, after a key the dialog may already have taken only the box (`keyed`), while a dialog waits nothing new, after
   * its answer another such dialog or the input box, and after the box or the first hook nothing.
   */
  #screenPhase: "start" | "keyed" | "dialog" | "answered" | "done" = "start";
  /** The heading of the dialog shown before the first hook that waits (`dialog`) or was answered last (`answered`). */
  #startDialog: string | undefined;
  /** Esc answered the folder trust dialog, which ends Copilot CLI unless a hook or the input box says otherwise. */
  #folderTrustRefused = false;
  /**
   * The main agent ended its turn while background agents run (ADR-254): until its next hook the removed progress bar
   * (OSC 9;4;0) does not end `Working`.
   */
  #waitingForBackgroundAgents = false;

  constructor(o: CopilotSessionStateOptions) {
    this.#tracker = new TaskStateTracker(o);
    this.#now = o.now;
    this.#promptOnStart = o.promptOnStart;
    this.#program = o.program;
  }

  /** The last window title set by Copilot CLI: what the agent is working on. */
  get windowTitle(): string | undefined {
    return this.#windowTitle;
  }

  /**
   * Every input and the end of the process first check the `Stale` threshold. The replay has no periodic `tick`, so this
   * way it gives the same order of changes as the live session.
   */
  output(data: string): TaskStateChange[] {
    const changes = [this.#tick(), this.#tracker.activity()];
    for (const osc of this.#osc.feed(data)) {
      this.#windowTitle = windowTitleFromOsc(osc, this.#program) ?? this.#windowTitle;
      const signal = this.#waitingForBackgroundAgents ? undefined : stateFromOsc(osc);
      if (signal) changes.push(this.#tracker.signal(signal));
    }
    const cancelled = this.#screen.feed(data);
    // After an answer to one of several approval requests the session is still in `Approval` (ADR-66), which a weaker
    // source could not end; the message right after the key says the key ended the turn.
    const waiting = this.#tracker.current?.state === "Approval";
    const sinceAnswer = this.#now() - this.#lastAnswerAt;
    if (cancelled && waiting && sinceAnswer <= CANCEL_WHILE_WAITING_MS) changes.push(this.#tracker.causedByKey(cancelled));
    else if (cancelled && !waiting && sinceAnswer <= CANCEL_AFTER_ANSWER_MS) changes.push(this.#tracker.signal(cancelled));
    return changes.filter((c) => c !== undefined);
  }

  /**
   * A `postToolUse` while an approval request is not answered is held back for `HOLD_TOOL_USE_MS`: it may be of a tool
   * called together with the one asking (one that needed no approval, or one of several already approved, ADR-66).
   * Only an `Approval` guessed from a notification's text, no request of a known kind, ends with it at once as before.
   * `backgroundAgentsRun`: background agents of the main agent may run as the hook comes (ADR-254); then its `agentStop`
   * does not end its work. Not by default, as in a replayed recording, which keeps no subagents.
   */
  hook(record: CopilotHookRecord, backgroundAgentsRun = false): TaskStateChange[] {
    this.#waitingForBackgroundAgents = record.event === "agentStop" && backgroundAgentsRun;
    return this.#applyHook(record);
  }

  /** Whether the main agent waits for its background agents (ADR-254): since its `agentStop`, until its next hook or a key. */
  get waitingForBackgroundAgents(): boolean {
    return this.#waitingForBackgroundAgents;
  }

  /**
   * A hook of a subagent the main agent started (ADR-254): another conversation's turn inside this session, so it
   * changes no state and keeps the main agent's wait for its background agents, but it is the session's activity,
   * which keeps `Working` from turning `Stale`. Only its tool's `postToolUse` says, as the main agent's would, that the
   * work goes on, such as after an approval the subagent asked for.
   */
  subagentHook(record: CopilotHookRecord): TaskStateChange[] {
    if (record.event === "postToolUse") return this.#applyHook(record);
    return [this.#tick(), this.#tracker.activity()].filter((c) => c !== undefined);
  }

  #applyHook(record: CopilotHookRecord): TaskStateChange[] {
    const waiting = this.#tracker.current?.state === "Approval";
    const keepsWaiting = record.event === "postToolUse" && waiting && this.#approvalsAsked > 0;
    // The first `sessionStart`: no hook has changed the state yet.
    const withPrompt = record.event === "sessionStart" && this.#inPromptBox === undefined && this.#promptOnItsWay();
    const hookSignal = this.#hookSignal(record, withPrompt);
    if (keepsWaiting && hookSignal) this.#heldToolUse = { signal: hookSignal, at: this.#now() };
    else if (hookSignal) this.#heldToolUse = undefined;
    const signal = keepsWaiting ? undefined : hookSignal;
    if (signal) this.#screenPhase = "done";
    if (signal) this.#inPromptBox = !withPrompt && (record.event === "sessionStart" || record.event === "agentStop");
    // Only a request of a known kind is counted; one guessed from the text may be no dialog at all.
    const asked = signal?.confidence === "high" ? 1 : 0;
    if (signal?.state === "Approval") this.#approvalsAsked = (waiting ? this.#approvalsAsked : 0) + asked;
    return this.#signal(signal);
  }

  /** The state a hook record of the main agent says, `hook` having decided the two cases the record alone cannot tell. */
  #hookSignal(record: CopilotHookRecord, withPrompt: boolean): StateSignal | undefined {
    if (withPrompt) return SESSION_START_WITH_PROMPT;
    return this.#waitingForBackgroundAgents ? WAITING_FOR_BACKGROUND_AGENTS : stateFromHook(record);
  }

  /** The main agent's wait for its background agents ended without a turn of its own (ADR-254). */
  backgroundAgentsEnded(): TaskStateChange[] {
    this.#waitingForBackgroundAgents = false;
    return this.#signal(BACKGROUND_AGENTS_ENDED);
  }

  /**
   * The screen shows an approval dialog the user has not answered: a held-back `postToolUse` is of a tool called
   * together with it, and the session keeps waiting for the answer.
   */
  approvalOnScreen(): void {
    this.#heldToolUse = undefined;
  }

  /**
   * Whether Copilot CLI waits in its empty input box, where the daemon may type a prompt for the user (ADR-62). The
   * state alone does not tell, since a question dialog, a guess from the screen and the user's Esc give `Input` too.
   * The hooks must say so (before the first hook: no prompt on its way, ADR-69) and the screen must show the empty box
   * now: Copilot CLI 1.0.103 sends `agentStop` before it draws the box again, and text typed in between is lost
   * (ADR-68); before the first hook, with hooks that do not work, the screen may show an approval by now.
   */
  inPromptBox(lines: () => readonly string[]): boolean {
    const hooksSay = this.#inPromptBox ?? !this.#promptOnItsWay();
    return hooksSay && promptBoxOnScreen(lines()) === "empty";
  }

  /** A new failed model call in the conversation's event log (ADR-243): the turn ended with it. */
  modelCallFailed(): TaskStateChange[] {
    return this.#signal(MODEL_CALL_FAILED);
  }

  /** The daemon typed a prompt into the session (ADR-62); before the first hook its `sessionStart` then starts work. */
  promptTyped(): void {
    if (this.#inPromptBox === undefined) this.#promptTypedAt = this.#now();
  }

  /** Before the first hook: the starting prompt, or one the daemon typed at most `RETYPE_AFTER_MS` ago. */
  #promptOnItsWay(): boolean {
    const typedAt = this.#promptTypedAt;
    return this.#promptOnStart || (typedAt !== undefined && this.#now() - typedAt <= RETYPE_AFTER_MS);
  }

  /**
   * The session's screen image (its visible lines), before the first hook (`#screenPhase`). A dialog Copilot CLI shows
   * before its first hook (folder trust, the sandbox's certificate authority) waits for an answer, also while a prompt is
   * on its way, which Copilot CLI takes only after it (`copilot-start-dialog.ts`); once answered it is not read again, so
   * a dialog not redrawn yet does not ask twice, but the next one, with another heading, waits again. Until the first
   * state, and after such an answer, the input box of a new session is waiting for you (ADR-69): Copilot CLI sends its
   * first hook only with the first prompt, so without this a new session would have no state. Not while a prompt is on
   * its way, so the session does not wait for you while its agent is about to start.
   */
  screen(lines: () => readonly string[]): TaskStateChange[] {
    if (!this.screenSpeaks) return [];
    const shown = lines();
    const readsDialog = this.#screenPhase === "start" || this.#screenPhase === "answered";
    const dialog = readsDialog ? startDialogOnScreen(shown) : undefined;
    if (dialog && dialog.title !== this.#startDialog) {
      // A state from OSC outranks the screen; the dialog then waits unseen, and the screen keeps trying.
      const stale = this.#tick();
      const asked = this.#tracker.signal(dialog.signal);
      if (asked) {
        this.#screenPhase = "dialog";
        this.#startDialog = dialog.title;
      }
      return [stale, asked].filter((c) => c !== undefined);
    }
    // Before the answer the box speaks only for a session with no state at all, as before the dialog was known.
    const noState = this.#screenPhase === "answered" || this.#tracker.current === undefined;
    if (!noState || this.#promptOnItsWay()) return [];
    const box = stateFromPromptBox(shown);
    if (box) this.#screenPhase = "done";
    return this.#signal(box);
  }

  /** Whether the screen can still tell the state (`screen`). */
  get screenSpeaks(): boolean {
    return this.#screenPhase !== "done" && this.#screenPhase !== "dialog";
  }

  #signal(signal: StateSignal | undefined): TaskStateChange[] {
    return [this.#tick(), signal && this.#tracker.signal(signal)].filter((c) => c !== undefined);
  }

  /** A key a human sent to the session terminal (`sessionKey`). */
  key(key: SessionKey): TaskStateChange[] {
    // The `Stale` threshold first: live, the periodic `tick` may already have set it, and the key counts from the state after it.
    const stale = this.#tick();
    const current = this.#tracker.current?.state;
    const signal = stateFromKey(key, current);
    // A key before the screen was read may have answered a dialog: one not redrawn yet must not ask again.
    if (this.#screenPhase === "start") this.#screenPhase = "keyed";
    if (this.#screenPhase === "dialog" && this.#startDialog === FOLDER_TRUST_DIALOG) this.#folderTrustRefused = key === "escape";
    if (!signal) return [stale].filter((c) => c !== undefined);
    // Ctrl+C stops the background agents too ("ctrl+c stop agents"), and no turn of the main agent follows.
    this.#waitingForBackgroundAgents = false;
    this.#lastAnswerAt = this.#now();
    if (this.#screenPhase === "dialog") this.#screenPhase = "answered";
    // An answer to one of several approval requests: the next one's dialog follows, so the session still waits (ADR-66).
    if (current === "Approval" && answersDialog(key) && this.#approvalsAsked > 1) {
      this.#approvalsAsked--;
      return [stale].filter((c) => c !== undefined);
    }
    return [stale, this.#tracker.keyboard(signal)].filter((c) => c !== undefined);
  }

  tick(): TaskStateChange | undefined {
    return this.#tick();
  }

  /** The `Stale` threshold, and a held-back `postToolUse` whose approval dialog the screen has not shown. */
  #tick(): TaskStateChange | undefined {
    const held = this.#heldToolUse;
    if (held === undefined || this.#now() - held.at < HOLD_TOOL_USE_MS) return this.#tracker.tick();
    this.#heldToolUse = undefined;
    return this.#tracker.current?.state === "Approval" ? this.#tracker.signal(held.signal) : this.#tracker.tick();
  }

  exit(code: number): TaskStateChange[] {
    // Nothing came after the refusal (the first hook or the input box would have ended the screen's say).
    const refused = this.#folderTrustRefused && this.#screenPhase === "answered" ? this.#tracker.signal(FOLDER_TRUST_REFUSED) : undefined;
    return [this.#tick(), refused, this.#tracker.exit(code)].filter((c) => c !== undefined);
  }
}
