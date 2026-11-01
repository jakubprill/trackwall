import { type TaskOutcome, taskOutcomesApi } from "@trackwall/protocol";
import { useMemo } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { DaemonEvents } from "./daemon-events.ts";
import { useRemote } from "./use-remote.ts";

/** Task outcomes come live from the events WebSocket; polled only while it is not connected, and a pipeline takes minutes. */
const TASK_OUTCOMES_POLL_MS = 10_000;

/** What every task's work came to (ADR-154): the list, and the same by task for the rows. */
export function useTaskOutcomes(conn: Connection | undefined, events: DaemonEvents | undefined) {
  const load = useMemo(() => conn && (() => post(conn, taskOutcomesApi.list, {})), [conn]);
  const live = useMemo(() => events?.feed("task-outcomes.changed"), [events]);
  const remote = useRemote(load, { pollMs: TASK_OUTCOMES_POLL_MS, live });
  const list = remote.data;
  const byTask = useMemo(() => new Map((list ?? []).map((o): [string, TaskOutcome] => [o.task, o])), [list]);
  return { list, byTask };
}
