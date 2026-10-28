import { z } from "zod";

/**
 * Task state (§4.4, §6): what a task session is doing now and how that is known. The UI shows the state together with
 * the source and confidence, so a weaker signal can be shown as "probably".
 */

export const TaskState = z.enum(["Working", "Input", "Approval", "Plan", "Done", "Error", "Stale"]);
export type TaskState = z.infer<typeof TaskState>;

/**
 * `hook`: an agent CLI hook; `osc`: a terminal sequence; `screen`: a screen pattern; `keyboard`: a key the person
 * answered with in the session terminal; `timeout`: no signal for longer than the threshold; `exit`: the end of the
 * session process, observed by the daemon; `acp`: the Agent Client Protocol of a session in the conversation view
 * (ADR-107), where the daemon itself sends the prompt and answers the approvals.
 */
export const TaskStateSource = z.enum(["hook", "osc", "screen", "keyboard", "timeout", "exit", "acp"]);
export type TaskStateSource = z.infer<typeof TaskStateSource>;

/** Confidence (glossary in `CONTEXT.md`); the same scale as for graph edges. */
export const Confidence = z.enum(["exact", "high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const TaskStateChange = z.object({
  state: TaskState,
  source: TaskStateSource,
  confidence: Confidence,
  /** The time of the change, ISO 8601. */
  at: z.iso.datetime(),
  /** Briefly, what the state follows from, for example `hook agentStop` or `osc 9;4;0`. */
  reason: z.string(),
});
export type TaskStateChange = z.infer<typeof TaskStateChange>;
