import { agentsApi, miseApi, type RunningMiseTask, type Task, type TaskMessage } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { RUNNING_MISE_POLL_MS } from "./run-state.ts";
import { taskName } from "./session-entries.ts";
import { taskNotices } from "./task-notices.ts";
import { useRemote } from "./use-remote.ts";
import { useTaskMergeRequest } from "./use-task-merge-request.ts";
import { useTaskVerification } from "./use-task-verification.ts";

/** An agent changes files within seconds, but a warning need not be instant, and the shared files read git of every task in the repo. */
const WARNING_POLL_MS = 5000;

/**
 * What the sections above a task's terminal show (ADR-91), loaded once for the task panel or a grid tile, together with
 * the notices that sum them up. The sections take their data from here, so the strip, the badge and the sections never
 * disagree. A failed check of the shared files shows no warning, since it may no longer be true; a failed check of the
 * mise config warns only when mise cannot run in the worktree at all (ADR-59).
 */
export function useTaskDetails({
  conn,
  task,
  tasks,
  messages,
  runningLive,
  paused,
}: {
  conn: Connection;
  task: Task;
  /** All tasks on the list, to name the other task of shared files. */
  tasks: readonly Task[];
  /** The messages the task's proposer sent its session (ADR-68), oldest first. */
  messages: readonly TaskMessage[];
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
  /** While the task is being ended, nothing is loaded. */
  paused: boolean;
}) {
  const verification = useTaskVerification(conn, task.id, paused);
  const mergeRequest = useTaskMergeRequest(conn, task.id, paused);
  const loadShared = useCallback(() => post(conn, agentsApi.taskSharedFiles, { task: task.id }), [conn, task.id]);
  const shared = useRemote(paused ? undefined : loadShared, { pollMs: WARNING_POLL_MS });
  const loadMiseConfig = useCallback(() => post(conn, agentsApi.taskMiseConfig, { task: task.id }), [conn, task.id]);
  const miseConfig = useRemote(paused ? undefined : loadMiseConfig, { pollMs: WARNING_POLL_MS });
  const loadRunning = useCallback(() => post(conn, miseApi.running, {}), [conn]);
  const running = useRemote(paused ? undefined : loadRunning, { pollMs: RUNNING_MISE_POLL_MS, live: runningLive });

  const sharedFiles = (shared.error ? [] : (shared.data?.shared ?? [])).flatMap(({ task: other, files }) => {
    const found = tasks.find((t) => t.id === other);
    return found ? [{ files, other: found }] : [];
  });
  // A run the verification section shows with its log and Cancel is left out of the mise tasks, so it is not listed twice.
  const miseRuns = (running.data ?? []).filter((r) => r.task === task.id && r.miseTask !== verification.runningMiseTask);
  const mergeRequestShown = (mergeRequest.state?.push?.commits ?? 0) > 0;
  const notices = taskNotices({
    task,
    messages,
    sharedWith: sharedFiles.map(({ files, other }) => ({ task: other.id, name: taskName(other), files: files.length })),
    miseConfig: miseConfig.errorCode === "mise_unavailable" ? "unavailable" : miseConfig.error ? undefined : miseConfig.data,
    verification: verification.verification,
    mergeRequest: mergeRequestShown,
    miseRuns: miseRuns.map((r) => r.miseTask),
  });
  return {
    verification,
    mergeRequest,
    sharedFiles,
    miseConfig,
    miseRuns,
    notices,
    /** Both warnings have been checked once, so a warning that shows up later is new. */
    warningsChecked: isChecked(shared) && isChecked(miseConfig),
  };
}

function isChecked(remote: { data?: unknown; error?: string }): boolean {
  return remote.data !== undefined || remote.error !== undefined;
}

export type TaskDetails = ReturnType<typeof useTaskDetails>;
