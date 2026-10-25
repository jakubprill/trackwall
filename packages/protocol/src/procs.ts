import { z } from "zod";

/**
 * The part of the `procs` module contract (§4.1) visible to clients: the state of one run, that is of a process group
 * with one leader. The state is observed: `exited` only once the daemon has checked that no process of the group is alive.
 */

/** The last output lines (stdout and stderr in arrival order) shown for an ended run. */
export const RUN_TAIL_LINES = 20;

const RunBase = z.object({
  runId: z.string(),
  /** ISO 8601. */
  startedAt: z.string(),
});

export const RunState = z.discriminatedUnion("kind", [
  RunBase.extend({ kind: z.literal("running"), pid: z.number().int().positive() }),
  /** The daemon is stopping the group: a graceful stop, after a grace period the whole group is killed. */
  RunBase.extend({ kind: z.literal("stopping"), pid: z.number().int().positive() }),
  RunBase.extend({
    kind: z.literal("exited"),
    endedAt: z.string(),
    /** The leader's exit code; `null` when a signal ended it. */
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    /** Ended by the user (a stop from the UI or the daemon exiting), not on its own. */
    stoppedByUser: z.boolean(),
    lastLines: z.array(z.string()).max(RUN_TAIL_LINES),
  }),
]);
export type RunState = z.infer<typeof RunState>;
