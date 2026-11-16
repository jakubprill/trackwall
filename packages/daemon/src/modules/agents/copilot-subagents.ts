import type { CopilotHookRecord } from "./copilot-hook-record.ts";

/**
 * The subagents of a Copilot CLI session, from its hook records (ADR-254, §4.4). Copilot CLI sends the hooks of the
 * subagents its `task` tool starts to the same session plugin, under their own `sessionId`, with their own
 * `userPromptSubmitted` and `agentStop`, but never a `sessionStart`; the main agent's `sessionStart` names its
 * conversation, also the new one after `/clear`. Approval requests and notifications come under the main agent's id.
 *
 * A subagent in the foreground runs inside the `task` tool: its first hook comes before the tool's `postToolUse`. One in
 * the background (`mode: "background"`) comes back from the tool at once: the tool's `postToolUse` comes first and the
 * agent's first hook later, often after the main agent's `agentStop`, while Copilot CLI shows "Waiting for background
 * agents" and starts the main agent's next turn itself once they finish. So a `postToolUse` of `task` with no new
 * subagent before it counts a background agent on its way, until a new subagent's first hook comes. Records are given
 * in order, once each; before a `sessionStart`, or without a `sessionId`, a record is the main agent's.
 */

/** Copilot CLI's tool that starts a subagent. */
const TASK_TOOL = "task";

export class CopilotSubagents {
  #conversation: string | undefined;
  /** Subagents seen so far, by their `sessionId`. */
  readonly #known = new Set<string>();
  /** Subagents in the middle of a turn. */
  readonly #inTurn = new Set<string>();
  /** New subagents whose `task` tool has not answered yet: foreground ones. */
  #inTool = 0;
  /** `task` calls that answered before their subagent's first hook: background agents on their way. */
  #onTheirWay = 0;

  /** The main agent's conversation as its last `sessionStart` named it; `undefined` before one. */
  get conversation(): string | undefined {
    return this.#conversation;
  }

  /** Whether a background agent may still run: one on its way, or a subagent in a turn. */
  get backgroundAgentsRun(): boolean {
    return this.#onTheirWay > 0 || this.#inTurn.size > 0;
  }

  /** Reads the next hook record; true when it is a subagent's. */
  read(record: CopilotHookRecord): boolean {
    const id = record.payload.sessionId;
    if (record.event === "sessionStart") {
      this.#conversation = id ?? this.#conversation;
      return false;
    }
    if (id === undefined || this.#conversation === undefined || id === this.#conversation) {
      this.#mainAgentRead(record);
      return false;
    }
    this.#subagentRead(id, record);
    return true;
  }

  /** Ctrl+C: Copilot CLI stops every agent ("ctrl+c stop agents"), and no turn of the main agent follows. */
  stopped(): void {
    this.#inTurn.clear();
    this.#inTool = 0;
    this.#onTheirWay = 0;
  }

  #mainAgentRead(record: CopilotHookRecord): void {
    if (record.event === "userPromptSubmitted") this.#inTool = 0;
    if (record.event !== "postToolUse" || record.payload.toolName !== TASK_TOOL) return;
    if (this.#inTool > 0) this.#inTool--;
    else this.#onTheirWay++;
  }

  #subagentRead(id: string, record: CopilotHookRecord): void {
    if (!this.#known.has(id)) {
      this.#known.add(id);
      if (this.#onTheirWay > 0) this.#onTheirWay--;
      else this.#inTool++;
    }
    if (record.event === "agentStop" || record.event === "sessionEnd") this.#inTurn.delete(id);
    else this.#inTurn.add(id);
  }
}
