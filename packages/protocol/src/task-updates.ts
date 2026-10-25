import { z } from "zod";
import { SessionId, TaskId, TaskSummaryText } from "./agents.ts";
import { VerificationState } from "./verification.ts";

/**
 * Task updates (ADR-68): what the daemon saw happen to work a session delegated, for that session (the task's
 * proposer) to read with the MCP tool `get_updates`. The daemon types a fixed prompt naming the tool into the proposer's
 * input box when an update arrives, so a supervisor or main session reacts to a finished task, a red verification or a
 * rejection instead of polling with `wait_for_session`. Kept only in daemon memory, per proposer.
 */

/** Unread updates kept per proposer; older ones drop out and are counted in `dropped`. */
export const TASK_UPDATES_KEPT = 50;

/** What every update says: the task (or proposal) it is about, the task's session and when the daemon saw it. */
const UpdateBase = z.object({
  task: TaskId,
  /** The task's session it concerns; `null` when none does (a rejected proposal, a verdict while no session of the task runs). */
  session: SessionId.nullable(),
  /** ISO 8601. */
  at: z.string(),
});

/**
 * `turn_ended`: the task's session finished a turn it worked on and waits for input (done, or asking something; its
 * summary and `get_session` say which); `error`: the session reported an error; `exited`: its process ended;
 * `result_reported`: it called `report_result`; `verified`: a verification of the task has a verdict;
 * `proposal_rejected`: the user rejected the proposal, with their reason when they gave one. A turn the user drove by
 * typing into the task's session gives no `turn_ended`: the user is handling it.
 */
export const TaskUpdate = z.discriminatedUnion("kind", [
  UpdateBase.extend({ kind: z.literal("turn_ended") }),
  UpdateBase.extend({ kind: z.literal("error") }),
  UpdateBase.extend({ kind: z.literal("exited"), exitCode: z.number().int().nullable(), stoppedByUser: z.boolean() }),
  UpdateBase.extend({ kind: z.literal("result_reported"), summary: TaskSummaryText }),
  UpdateBase.extend({
    kind: z.literal("verified"),
    state: VerificationState.exclude(["running"]),
    /** Why it failed, or a note on a pass; `get_session` has the failed tests and errors. */
    message: z.string().nullable(),
  }),
  UpdateBase.extend({ kind: z.literal("proposal_rejected"), reason: z.string().nullable() }),
]);
export type TaskUpdate = z.infer<typeof TaskUpdate>;
