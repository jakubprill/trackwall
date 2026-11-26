import { type TaskTestRef, taskTestsApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { deliveryMessage } from "./review-drafts.ts";
import { useAction } from "./use-action.ts";
import { useRemote } from "./use-remote.ts";

/** How often the reports are read again while the "Tests" tab is open: the agent's own runs write them too. */
const SHOWN_POLL_MS = 10_000;
/** The same while another tab is open, for the tab's red count. */
const HIDDEN_POLL_MS = 60_000;

/**
 * The tests of a task's worktree for its "Tests" tab (ADR-304), held by the task panel so the tab's red count and the
 * tab share one reading. Read again when a verification ends (`verdict`), on "Refresh", and every few seconds while the
 * tab is open; not while the task is being ended, when its worktree goes away.
 */
export function useTaskTests(
  conn: Connection,
  task: string,
  { shown, paused, verdict }: { shown: boolean; paused: boolean; verdict: string },
) {
  const load = useCallback(() => post(conn, taskTestsApi.get, { task }), [conn, task]);
  const remote = useRemote(paused ? undefined : load, { pollMs: shown ? SHOWN_POLL_MS : HIDDEN_POLL_MS, refreshKey: verdict });
  const [sent, setSent] = useState<string>();
  const fix = useAction(
    (test: TaskTestRef | null) => post(conn, taskTestsApi.fixTests, { task, test }),
    ({ delivery }) => setSent(deliveryMessage(delivery, "the failed tests")),
  );
  return {
    tests: remote.data,
    reload: remote.reload,
    fix: fix.run,
    fixing: fix.pending,
    sent,
    error: fix.error ?? remote.error,
  };
}

export type TaskTestsState = ReturnType<typeof useTaskTests>;
